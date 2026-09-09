import { NAN_DASHBOARD_METRICS_URL, NanDashboardMetricsClient, NanDashboardMetricsError, type NanDashboardMetricsSnapshot } from "./nan-dashboard-metrics-provider.js";
import { NAN_DASHBOARD_QUOTA_URL, NanDashboardQuotaClient, NanDashboardQuotaError, type NanDashboardQuota } from "./nan-dashboard-quota-provider.js";
import { NanKeychainClient } from "./nan-keychain-client.js";

const VERSION = 1;
const SCOPE = "nan-dashboard-session";
const MAX_BYTES = 4 * 1024;
const MAX_COOKIES = 32;
const quotaUrl = new URL(NAN_DASHBOARD_QUOTA_URL);
const metricsUrl = new URL(NAN_DASHBOARD_METRICS_URL);

export interface BrowserCookieRecord {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  /** ISO-8601 expiry timestamp, or null for an explicit imported session cookie. */
  readonly expiresAt: string | null;
}

interface SessionKeychain {
  getSessionCache(): Promise<string | null>;
  putSessionCache(secret: string): Promise<void>;
  deleteSessionCache(): Promise<void>;
}
interface QuotaClient { getQuota(cookieHeader: string): Promise<NanDashboardQuota>; }
interface MetricsClient { getMetrics(cookieHeader: string): Promise<NanDashboardMetricsSnapshot>; }
type StoredSession = { readonly version: 1; readonly scope: "nan-dashboard-session"; readonly cookies: readonly BrowserCookieRecord[] };
export type NanDashboardSessionResult =
  | { readonly state: "ready"; readonly quota: NanDashboardQuota }
  | { readonly state: "needs-import" }
  | { readonly state: "transient" }
  | { readonly state: "schema-invalid" }
  | { readonly state: "keychain-unavailable" }
  | { readonly state: "eviction-failed" };
export type NanDashboardMetricsState = "unavailable" | "transient" | "schema-invalid";
type NanDashboardUnavailable = Exclude<NanDashboardSessionResult, { readonly state: "ready" }>;
export type NanDashboardSnapshotResult = NanDashboardUnavailable
  | { readonly state: "ready"; readonly quota: NanDashboardQuota; readonly metrics?: NanDashboardMetricsSnapshot; readonly metricsError?: NanDashboardMetricsState };

/** A shared instance serializes cache writes and auth-driven eviction. */
export class NanDashboardSessionStore {
  private pending = Promise.resolve();
  private readonly keychain: SessionKeychain;
  private readonly quota: QuotaClient;
  private readonly metrics: MetricsClient;
  private readonly now: () => Date;

  constructor(
    keychain: SessionKeychain = new NanKeychainClient(),
    quota: QuotaClient = new NanDashboardQuotaClient(),
    now: () => Date = () => new Date(),
    metrics: MetricsClient = new NanDashboardMetricsClient(),
  ) {
    this.keychain = keychain;
    this.quota = quota;
    this.metrics = metrics;
    this.now = now;
  }

  /** Validates a canonical explicit candidate before persisting it to Keychain. */
  validateAndStore(cookies: readonly BrowserCookieRecord[]): Promise<NanDashboardSessionResult> {
    return this.serial(async () => {
      let candidate: CanonicalSession;
      try { candidate = canonicalSession(cookies, this.now()); } catch { return { state: "needs-import" }; }
      const secret = JSON.stringify({ version: VERSION, scope: SCOPE, cookies: candidate.cookies } satisfies StoredSession);
      if (Buffer.byteLength(secret, "utf8") > MAX_BYTES) return { state: "needs-import" };
      try {
        const quota = await this.quota.getQuota(candidate.quotaHeader);
        try { await this.keychain.putSessionCache(secret); } catch { return { state: "keychain-unavailable" }; }
        return { state: "ready", quota };
      } catch (error) {
        if (error instanceof NanDashboardQuotaError && error.kind === "transport") return { state: "transient" };
        if (error instanceof NanDashboardQuotaError && error.kind === "schema") return { state: "schema-invalid" };
        return { state: "needs-import" };
      }
    });
  }

  /** Reads only the cache and never invokes browser acquisition. */
  getCachedQuota(): Promise<NanDashboardSessionResult> {
    return this.serial(async () => {
      const candidate = await this.readCachedSession();
      if ("state" in candidate) return candidate;
      try { return { state: "ready", quota: await this.quota.getQuota(candidate.quotaHeader) }; }
      catch (error) { return this.quotaFailure(error); }
    });
  }

  /** Reads quota and metrics once from the same cached session without credential acquisition. */
  getCachedDashboard(): Promise<NanDashboardSnapshotResult> {
    return this.serial(async () => {
      const candidate = await this.readCachedSession();
      if ("state" in candidate) return candidate;
      let quota: NanDashboardQuota;
      try { quota = await this.quota.getQuota(candidate.quotaHeader); }
      catch (error) { return this.quotaFailure(error); }
      // A cache created before metrics-only cookies existed remains usable for quota.
      if (!candidate.metricsHeader) return { state: "ready", quota, metricsError: "unavailable" };
      try { return { state: "ready", quota, metrics: await this.metrics.getMetrics(candidate.metricsHeader) }; }
      catch (error) { return { state: "ready", quota, metricsError: metricsFailure(error) }; }
    });
  }

  private async readCachedSession(): Promise<CanonicalSession | NanDashboardUnavailable> {
    let encoded: string | null;
    try { encoded = await this.keychain.getSessionCache(); } catch { return { state: "keychain-unavailable" }; }
    if (!encoded) return { state: "needs-import" };
    try { return canonicalSession(decodeSession(encoded), this.now()); } catch { return this.evict(); }
  }

  private quotaFailure(error: unknown): Promise<NanDashboardUnavailable> | NanDashboardUnavailable {
    if (error instanceof NanDashboardQuotaError && error.kind === "auth-rejected") return this.evict();
    if (error instanceof NanDashboardQuotaError && error.kind === "schema") return { state: "schema-invalid" };
    return { state: "transient" };
  }
  private async evict(): Promise<NanDashboardUnavailable> {
    try { await this.keychain.deleteSessionCache(); return { state: "needs-import" }; } catch { return { state: "eviction-failed" }; }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(operation);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }
}

type CanonicalSession = { readonly cookies: readonly BrowserCookieRecord[]; readonly quotaHeader: string; readonly metricsHeader: string };
export function buildNanDashboardCookieHeader(cookies: readonly BrowserCookieRecord[], now: Date): string { return canonicalSession(cookies, now).quotaHeader; }
export function buildNanDashboardMetricsCookieHeader(cookies: readonly BrowserCookieRecord[], now: Date): string {
  const canonical = canonicalCookies(cookies, now);
  const header = buildHeader(canonical, metricsUrl);
  if (!header) throw new Error("invalid session");
  return header;
}
function canonicalSession(records: readonly BrowserCookieRecord[], now: Date): CanonicalSession {
  const cookies = canonicalCookies(records, now).filter((cookie) => matchesTarget(cookie, quotaUrl) || matchesTarget(cookie, metricsUrl));
  const quotaHeader = buildHeader(cookies, quotaUrl);
  if (!quotaHeader) throw new Error("invalid session");
  return { cookies, quotaHeader, metricsHeader: buildHeader(cookies, metricsUrl) };
}
function canonicalCookies(records: readonly BrowserCookieRecord[], now: Date): readonly BrowserCookieRecord[] {
  if (!Number.isFinite(now.valueOf()) || records.length === 0 || records.length > MAX_COOKIES) throw new Error("invalid session");
  const identities = new Set<string>();
  return records.flatMap((record): BrowserCookieRecord[] => {
    const cookie = canonicalCookie(record);
    const identity = `${cookie.name}\n${cookie.domain}\n${cookie.path}\n${cookie.hostOnly}`;
    if (identities.has(identity)) throw new Error("ambiguous session");
    identities.add(identity);
    return isExpired(cookie, now) ? [] : [cookie];
  }).sort((a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name));
}
function buildHeader(cookies: readonly BrowserCookieRecord[], target: URL): string {
  const header = cookies.filter((cookie) => matchesTarget(cookie, target)).map(({ name, value }) => `${name}=${value}`).join("; ");
  if (Buffer.byteLength(header, "utf8") > MAX_BYTES) throw new Error("invalid session");
  return header;
}
function decodeSession(encoded: string): readonly BrowserCookieRecord[] {
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw new Error("invalid session");
  const value = JSON.parse(encoded) as unknown;
  if (!isRecord(value) || value.version !== VERSION || value.scope !== SCOPE || !Array.isArray(value.cookies)) throw new Error("invalid session");
  return value.cookies as BrowserCookieRecord[];
}
function canonicalCookie(value: unknown): BrowserCookieRecord {
  if (!isRecord(value) || !isToken(value.name) || typeof value.value !== "string" || !isCookieValue(value.value)
    || typeof value.domain !== "string" || typeof value.hostOnly !== "boolean" || typeof value.path !== "string"
    || !value.path.startsWith("/") || value.secure !== true || !validExpiry(value.expiresAt)) throw new Error("invalid session");
  const domain = value.domain.toLowerCase();
  const normalized = value.hostOnly ? domain : domain.replace(/^\./, "");
  if (!normalized || containsControl(normalized)) throw new Error("invalid session");
  return { name: value.name, value: value.value, domain: normalized, hostOnly: value.hostOnly, path: value.path, secure: true, expiresAt: value.expiresAt };
}
function matchesTarget(cookie: BrowserCookieRecord, target: URL): boolean {
  return matchesHost(cookie, target) && matchesPath(cookie.path, target.pathname);
}
function matchesHost(cookie: BrowserCookieRecord, target: URL): boolean {
  return cookie.hostOnly ? cookie.domain === target.hostname : cookie.domain === "nan.builders" || cookie.domain === target.hostname;
}
function matchesPath(path: string, target: string): boolean { return target.startsWith(path) && (path.endsWith("/") || target.length === path.length || target[path.length] === "/"); }
function isExpired(cookie: BrowserCookieRecord, now: Date): boolean { return cookie.expiresAt !== null && new Date(cookie.expiresAt).valueOf() <= now.valueOf(); }
function metricsFailure(error: unknown): NanDashboardMetricsState {
  if (error instanceof NanDashboardMetricsError && error.kind === "schema") return "schema-invalid";
  return error instanceof NanDashboardMetricsError && error.kind === "transport" ? "transient" : "unavailable";
}
function validExpiry(value: unknown): value is string | null { return value === null || typeof value === "string" && isValidIso(value); }
function isValidIso(value: string): boolean { const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value); if (!m || Number.isNaN(new Date(value).valueOf())) return false; const [y, mo, d] = m.slice(1).map(Number), date = new Date(Date.UTC(y, mo - 1, d)); return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d; }
function isToken(value: unknown): value is string { return typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value); }
function isCookieValue(value: string): boolean { return /^[!#$%&'()*+\-./0-9:<=>?@A-Z\[\]^_`a-z{|}~]*$/.test(value); }
function containsControl(value: string): boolean { return /[\u0000-\u001f\u007f-\u009f]/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
