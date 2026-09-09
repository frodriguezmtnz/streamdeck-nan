import { getNanDashboardJson, NAN_DASHBOARD_METRICS_URL as metricsUrl, type NanDashboardHttpClock, type NanDashboardHttpErrorKind } from "./nan-dashboard-http.js";

export const NAN_DASHBOARD_METRICS_URL = metricsUrl;

const MAX_RESPONSE_BYTES = 256 * 1024;

export type NanDashboardMetricsErrorKind = NanDashboardHttpErrorKind;

export class NanDashboardMetricsError extends Error {
  readonly kind: NanDashboardMetricsErrorKind;

  constructor(kind: NanDashboardMetricsErrorKind) {
    super(kind === "auth-rejected"
      ? "NaN dashboard session rejected"
      : kind === "schema" ? "NaN dashboard metrics response invalid" : "NaN dashboard unavailable");
    this.kind = kind;
  }
}

export interface NanDashboardMetricsClock extends NanDashboardHttpClock {}

export interface NanDashboardModelMetrics {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface NanDashboardMetricsWindow {
  /** Server-reported aggregate; it need not equal the sum of model rows. */
  readonly totalTokens: number;
  readonly byModel: readonly NanDashboardModelMetrics[];
}

export interface NanDashboardAllTimeMetricsWindow extends NanDashboardMetricsWindow {
  /** Present only when the all-time aggregate carries its own cache timestamp. */
  readonly cachedAt?: string;
}

export interface NanDashboardMetricsSnapshot {
  readonly last24h: NanDashboardMetricsWindow;
  readonly last30d: NanDashboardMetricsWindow;
  readonly monthToDate: NanDashboardMetricsWindow;
  readonly allTime: NanDashboardAllTimeMetricsWindow;
}

export class NanDashboardMetricsClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: NanDashboardMetricsClock;

  /**
   * This client neither acquires nor persists credentials. Callers must rebuild a
   * Cookie header scoped to /api/metrics/usage; quota-path cookies are not reusable.
   */
  constructor(fetcher: typeof fetch = fetch, clock: NanDashboardMetricsClock = { setTimeout, clearTimeout }) {
    this.fetcher = fetcher;
    this.clock = clock;
  }

  async getMetrics(cookieHeader: string): Promise<NanDashboardMetricsSnapshot> {
    const value = await getNanDashboardJson({
      resource: "metrics",
      cookieHeader,
      fetcher: this.fetcher,
      clock: this.clock,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      createError: (kind) => new NanDashboardMetricsError(kind),
      isExpectedError: (error): error is NanDashboardMetricsError => error instanceof NanDashboardMetricsError,
    });
    return parseNanDashboardMetrics(value);
  }
}

export function parseNanDashboardMetrics(value: unknown): NanDashboardMetricsSnapshot {
  if (!isRecord(value)) throw new NanDashboardMetricsError("schema");
  const last24h = parseWindow(value.last24h);
  const last30d = parseWindow(value.last30d);
  const monthToDate = parseWindow(value.monthToDate);
  const allTime = parseAllTimeWindow(value.allTime);
  return Object.freeze({ last24h, last30d, monthToDate, allTime });
}

function parseAllTimeWindow(value: unknown): NanDashboardAllTimeMetricsWindow {
  if (!isRecord(value)) throw new NanDashboardMetricsError("schema");
  const window = parseWindow(value, true);
  if (value.cachedAt === undefined) return window;
  if (typeof value.cachedAt !== "string" || !isIsoTimestamp(value.cachedAt)) throw new NanDashboardMetricsError("schema");
  return Object.freeze({ ...window, cachedAt: value.cachedAt });
}

function parseWindow(value: unknown, allowCachedAt = false): NanDashboardMetricsWindow {
  if (!isRecord(value) || !isCounter(value.totalTokens) || !Array.isArray(value.byModel) || (!allowCachedAt && value.cachedAt !== undefined)) {
    throw new NanDashboardMetricsError("schema");
  }
  const names = new Set<string>();
  const byModel: NanDashboardModelMetrics[] = [];
  for (const entry of value.byModel) {
    if (!isRecord(entry) || !isModelName(entry.model) || !isCounter(entry.inputTokens) || !isCounter(entry.outputTokens)) {
      throw new NanDashboardMetricsError("schema");
    }
    if (names.has(entry.model) || entry.inputTokens > Number.MAX_SAFE_INTEGER - entry.outputTokens) {
      throw new NanDashboardMetricsError("schema");
    }
    names.add(entry.model);
    byModel.push(Object.freeze({
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.inputTokens + entry.outputTokens,
    }));
  }
  return Object.freeze({ totalTokens: value.totalTokens, byModel: Object.freeze(byModel) });
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
