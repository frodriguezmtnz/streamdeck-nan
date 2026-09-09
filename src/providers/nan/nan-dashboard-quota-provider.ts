import { getNanDashboardJson, NAN_DASHBOARD_QUOTA_URL as quotaUrl, type NanDashboardHttpClock, type NanDashboardHttpErrorKind } from "./nan-dashboard-http.js";

export const NAN_DASHBOARD_QUOTA_URL = quotaUrl;

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface NanDashboardQuotaClock extends NanDashboardHttpClock {}

export interface NanDashboardModelQuota {
  readonly model: string;
  readonly tokensUsed: number;
  readonly cap: number;
  readonly percentage: number;
  readonly resetAt: string | null;
  readonly windowHours: number | null;
}

export interface NanDashboardUncappedModelQuota {
  readonly model: string;
  readonly tokensUsed: number;
  readonly resetAt: string | null;
  readonly windowHours: number | null;
}

export interface NanDashboardQuota {
  readonly eligibility: "unknown";
  readonly models: readonly NanDashboardModelQuota[];
  /** Full raw API data for cap=0 entries; no cap or percentage is inferred. */
  readonly uncappedModels: readonly NanDashboardUncappedModelQuota[];
}

export type NanDashboardQuotaErrorKind = NanDashboardHttpErrorKind;

export class NanDashboardQuotaError extends Error {
  readonly kind: NanDashboardQuotaErrorKind;

  constructor(kind: NanDashboardQuotaErrorKind) {
    super(kind === "auth-rejected"
      ? "NaN dashboard session rejected"
      : kind === "schema" ? "NaN dashboard quota response invalid" : "NaN dashboard unavailable");
    this.kind = kind;
  }
}

export class NanDashboardQuotaClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: NanDashboardQuotaClock;

  constructor(fetcher: typeof fetch = fetch, clock: NanDashboardQuotaClock = { setTimeout, clearTimeout }) {
    this.fetcher = fetcher;
    this.clock = clock;
  }

  async getQuota(cookieHeader: string): Promise<NanDashboardQuota> {
    const value = await getNanDashboardJson({
      resource: "quota",
      cookieHeader,
      fetcher: this.fetcher,
      clock: this.clock,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      createError: (kind) => new NanDashboardQuotaError(kind),
      isExpectedError: (error): error is NanDashboardQuotaError => error instanceof NanDashboardQuotaError,
    });
    return parseNanDashboardQuota(value);
  }
}

export function parseNanDashboardQuota(value: unknown): NanDashboardQuota {
  if (!isRecord(value) || !isDateOnly(value.periodStart) || !Array.isArray(value.models)) {
    throw new NanDashboardQuotaError("schema");
  }
  const names = new Set<string>();
  const models: NanDashboardModelQuota[] = [];
  const uncappedModels: NanDashboardUncappedModelQuota[] = [];
  for (const entry of value.models) {
    if (!isRecord(entry) || !isModelName(entry.model) || !isCounter(entry.cap) || !isCounter(entry.tokensUsed)) {
      throw new NanDashboardQuotaError("schema");
    }
    if (names.has(entry.model)) throw new NanDashboardQuotaError("schema");
    names.add(entry.model);
    const resetAt = optionalDate(entry.periodEnd);
    const windowHours = optionalWindow(entry.windowHours);
    if (entry.cap === 0) {
      uncappedModels.push({ model: entry.model, tokensUsed: entry.tokensUsed, resetAt, windowHours });
      continue;
    }
    models.push({
      model: entry.model,
      cap: entry.cap,
      tokensUsed: entry.tokensUsed,
      percentage: entry.tokensUsed / entry.cap * 100,
      resetAt,
      windowHours,
    });
  }
  return { eligibility: "unknown", models, uncappedModels };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !isIsoTimestamp(value)) throw new NanDashboardQuotaError("schema");
  return value;
}

function optionalWindow(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new NanDashboardQuotaError("schema");
  return value;
}

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && calendarDate(value) !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && calendarDate(value) !== null && !Number.isNaN(new Date(value).valueOf());
}

function calendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}
