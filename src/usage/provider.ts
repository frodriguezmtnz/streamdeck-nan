export const usageWindowNames = ["session", "week"] as const;

export type UsageWindowName = (typeof usageWindowNames)[number];

export interface UsageWindow {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: string;
}

export interface UsageSnapshot {
  readonly windows: Readonly<Partial<Record<UsageWindowName, UsageWindow>>>;
  readonly observedAt: number;
}

export type UsageErrorCode =
  | "authentication"
  | "executable-not-found"
  | "unsupported-platform"
  | "timeout"
  | "invalid-response"
  | "unavailable"
  | "stopped";

export const MAX_PROVIDER_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const safeErrorMessages: Record<UsageErrorCode, string> = {
  authentication: "Authentication is unavailable.",
  "executable-not-found": "The required command is unavailable.",
  "unsupported-platform": "This integration is not supported on this operating system.",
  timeout: "The usage request timed out.",
  "invalid-response": "The usage response is invalid.",
  unavailable: "Usage is unavailable.",
  stopped: "The usage provider is stopped.",
};

export class UsageProviderError extends Error {
  readonly code: UsageErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: UsageErrorCode, options: { readonly retryAfterMs?: number } = {}) {
    super(safeErrorMessages[code]);
    this.name = "UsageProviderError";
    this.code = code;
    if (Number.isFinite(options.retryAfterMs) && options.retryAfterMs! >= 0) {
      this.retryAfterMs = Math.min(options.retryAfterMs!, MAX_PROVIDER_RETRY_AFTER_MS);
    }
  }
}

export type UsageProviderResult =
  | { readonly ok: true; readonly usage: UsageSnapshot }
  | { readonly ok: false; readonly error: UsageProviderError };

export interface UsageProvider {
  readonly id: string;
  getUsage(): Promise<UsageProviderResult>;
  recoverAfterWake?(): void;
}

export function sanitizeUsageError(
  error: unknown,
  fallback: UsageErrorCode = "unavailable",
): UsageProviderError {
  return error instanceof UsageProviderError
    ? error
    : new UsageProviderError(fallback);
}

export function normalizeUsageSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value) || !Number.isFinite(value.observedAt) || !isRecord(value.windows)) {
    return undefined;
  }

  const windows: Partial<Record<UsageWindowName, UsageWindow>> = {};
  for (const name of usageWindowNames) {
    const window = value.windows[name];
    if (window === undefined) continue;
    if (!isUsageWindow(window)) return undefined;
    windows[name] = {
      usedPercent: window.usedPercent,
      ...(window.windowMinutes === undefined
        ? {}
        : { windowMinutes: window.windowMinutes }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    };
  }

  if (Object.keys(windows).length === 0) return undefined;
  return { windows, observedAt: value.observedAt as number };
}

function isUsageWindow(value: unknown): value is UsageWindow {
  return (
    isRecord(value) &&
    Number.isFinite(value.usedPercent) &&
    (value.windowMinutes === undefined || Number.isFinite(value.windowMinutes)) &&
    (value.resetsAt === undefined || typeof value.resetsAt === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
