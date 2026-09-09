import {
  normalizeUsageSnapshot,
  sanitizeUsageError,
  MAX_PROVIDER_RETRY_AFTER_MS,
  UsageProviderError,
  type UsageProvider,
  type UsageSnapshot,
} from "./provider.js";
import type { ProviderStatusReporter } from "./provider-status-reporter.js";

export type CoordinatedUsageResult =
  | {
      readonly ok: true;
      readonly usage: UsageSnapshot;
      readonly stale: boolean;
      readonly error?: UsageProviderError;
    }
  | { readonly ok: false; readonly error: UsageProviderError };

export interface UsageRequestOptions {
  readonly force?: boolean;
}

export interface UsageCoordinatorOptions {
  readonly cacheTtlMs?: number;
  readonly failureCooldownMs?: number;
  readonly forcedRefreshThrottleMs?: number;
  readonly now?: () => number;
  readonly statusReporter?: ProviderStatusReporter;
}

interface CachedUsage {
  readonly usage: UsageSnapshot;
  readonly cachedAt: number;
}

export class UsageProviderCoordinator {
  private readonly provider: UsageProvider;
  private readonly cacheTtlMs: number;
  private readonly failureCooldownMs: number;
  private readonly forcedRefreshThrottleMs: number;
  private readonly now: () => number;
  private readonly statusReporter?: ProviderStatusReporter;
  private cache?: CachedUsage;
  private inFlight?: Promise<CoordinatedUsageResult>;
  private nextRequestId = 0;
  private committedRequestId = 0;
  private settledRequestId = 0;
  private latestSettledError?: UsageProviderError;
  private failureCooldownUntil = 0;

  constructor(
    provider: UsageProvider,
    options: UsageCoordinatorOptions = {},
  ) {
    this.provider = provider;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    this.failureCooldownMs = Math.max(0, options.failureCooldownMs ?? 0);
    this.forcedRefreshThrottleMs = Math.max(0, options.forcedRefreshThrottleMs ?? 0);
    this.now = options.now ?? Date.now;
    this.statusReporter = options.statusReporter;
  }

  get providerId(): string {
    return this.provider.id;
  }

  recoverAfterWake(): void {
    this.provider.recoverAfterWake?.();
    this.inFlight = undefined;
    this.nextRequestId += 1;
    this.settledRequestId = this.nextRequestId;
    this.latestSettledError = undefined;
    this.failureCooldownUntil = 0;
    if (this.cache) this.cache = { usage: this.cache.usage, cachedAt: Number.NEGATIVE_INFINITY };
  }

  getUsage(options: UsageRequestOptions = {}): Promise<CoordinatedUsageResult> {
    if (this.latestSettledError && this.now() < this.failureCooldownUntil) {
      return Promise.resolve(this.cache
        ? { ok: true, usage: this.cache.usage, stale: true, error: this.latestSettledError }
        : { ok: false, error: this.latestSettledError });
    }
    if (this.inFlight) return this.inFlight;
    if (
      options.force &&
      this.cache &&
      this.now() - this.cache.cachedAt < this.forcedRefreshThrottleMs
    ) {
      return Promise.resolve({ ok: true, usage: this.cache.usage, stale: false });
    }
    if (!options.force) {
      const cached = this.currentCache();
      if (cached) return Promise.resolve({ ok: true, usage: cached, stale: false });
    }

    const request = this.requestUsage(++this.nextRequestId);
    this.inFlight = request;
    void request.finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    return request;
  }

  private currentCache(): UsageSnapshot | undefined {
    if (
      !this.cache ||
      this.cacheTtlMs === 0 ||
      this.now() - this.cache.cachedAt >= this.cacheTtlMs
    ) {
      return undefined;
    }
    return this.cache.usage;
  }

  private async requestUsage(requestId: number): Promise<CoordinatedUsageResult> {
    try {
      const result = await this.provider.getUsage();
      if (!result.ok) return this.failure(result.error, requestId);

      const usage = normalizeUsageSnapshot(result.usage);
      if (!usage) {
        return this.failure(new UsageProviderError("invalid-response"), requestId);
      }

      if (requestId === this.nextRequestId) {
        this.cache = { usage, cachedAt: this.now() };
        this.committedRequestId = requestId;
        this.settledRequestId = requestId;
        this.latestSettledError = undefined;
        this.failureCooldownUntil = 0;
        this.statusReporter?.success(this.provider.id);
        return { ok: true, usage, stale: false };
      }
      if (this.cache) {
        return {
          ok: true,
          usage: this.cache.usage,
          stale: this.latestSettledError !== undefined,
          ...(this.latestSettledError ? { error: this.latestSettledError } : {}),
        };
      }
      return this.latestSettledError
        ? { ok: false, error: this.latestSettledError }
        : { ok: true, usage, stale: true };
    } catch (error) {
      return this.failure(sanitizeUsageError(error), requestId);
    }
  }

  private failure(error: unknown, requestId: number): CoordinatedUsageResult {
    const sanitized = sanitizeUsageError(error);
    if (requestId < this.settledRequestId) {
      if (this.cache) {
        return {
          ok: true,
          usage: this.cache.usage,
          stale: this.latestSettledError !== undefined,
          ...(this.latestSettledError ? { error: this.latestSettledError } : {}),
        };
      }
      return this.latestSettledError
        ? { ok: false, error: this.latestSettledError }
        : { ok: false, error: sanitized };
    }
    if (requestId > this.settledRequestId) {
      this.settledRequestId = requestId;
      this.latestSettledError = sanitized;
      this.failureCooldownUntil = this.now() + Math.max(
        this.failureCooldownMs,
        Math.min(sanitized.retryAfterMs ?? 0, MAX_PROVIDER_RETRY_AFTER_MS),
      );
      this.statusReporter?.failure(this.provider.id, sanitized.code);
    }
    if (this.cache && requestId < this.committedRequestId) {
      return { ok: true, usage: this.cache.usage, stale: false };
    }
    return this.cache
      ? { ok: true, usage: this.cache.usage, stale: true, error: sanitized }
      : { ok: false, error: sanitized };
  }
}
