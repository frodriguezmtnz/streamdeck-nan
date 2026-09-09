import assert from "node:assert/strict";
import test from "node:test";
import { buildNanDashboardCookieHeader, NanDashboardSessionStore, type BrowserCookieRecord } from "../src/providers/nan/nan-dashboard-session-store.ts";
import { NanDashboardQuotaError } from "../src/providers/nan/nan-dashboard-quota-provider.ts";
import { NanDashboardMetricsError, type NanDashboardMetricsSnapshot } from "../src/providers/nan/nan-dashboard-metrics-provider.ts";

const now = () => new Date("2026-09-20T00:00:00Z");
const session: BrowserCookieRecord[] = [{ name: "session", value: "opaque", domain: "cloud-api.nan.builders", hostOnly: true, path: "/", secure: true, expiresAt: null }];

test("builds a deterministic quota-only cookie header with scope and expiry boundaries", () => {
  assert.equal(buildNanDashboardCookieHeader([...session,
    { name: "api", value: "two", domain: ".nan.builders", hostOnly: false, path: "/api", secure: true, expiresAt: "2026-10-01T00:00:00Z" },
    { name: "wrong", value: "x", domain: "dashboard.nan.builders", hostOnly: true, path: "/", secure: true, expiresAt: null },
  ], now()), "api=two; session=opaque");
  for (const invalid of [
    { ...session[0], domain: "evilnan.builders", hostOnly: false }, { ...session[0], path: "/api/use" },
    { ...session[0], secure: false }, { ...session[0], expiresAt: "2026-09-01T00:00:00Z" },
    { ...session[0], name: "bad;name" }, { ...session[0], value: "bad\nvalue" },
  ]) assert.throws(() => buildNanDashboardCookieHeader([invalid], now()));
});

test("validates imports before storing and cached reads never invoke an importer", async () => {
  let secret: string | null = null, quotaCalls = 0;
  const store = new NanDashboardSessionStore({ getSessionCache: async () => secret, putSessionCache: async (value) => { secret = value; }, deleteSessionCache: async () => { secret = null; } }, { getQuota: async () => { quotaCalls += 1; return { models: [], uncappedModels: [], eligibility: "unknown" }; } }, now);
  assert.deepEqual(await store.getCachedQuota(), { state: "needs-import" });
  assert.equal(quotaCalls, 0);
  assert.deepEqual(await store.validateAndStore(session), { state: "ready", quota: { models: [], uncappedModels: [], eligibility: "unknown" } });
  assert.equal(quotaCalls, 1);
  assert.equal((await store.getCachedQuota()).state, "ready");
});

test("canonicalizes candidates before validation and never stores caller mutations", async () => {
  let stored = "";
  let resolveQuota!: () => void;
  const candidate = [...session, { name: "expired", value: "old", domain: "cloud-api.nan.builders", hostOnly: true, path: "/", secure: true, expiresAt: "2026-01-01T00:00:00Z" }];
  const store = new NanDashboardSessionStore({ getSessionCache: async () => null, putSessionCache: async (value) => { stored = value; }, deleteSessionCache: async () => undefined }, { getQuota: async (header) => {
    assert.equal(header, "session=opaque");
    await new Promise<void>((resolve) => { resolveQuota = resolve; });
    return { models: [], uncappedModels: [], eligibility: "unknown" };
  } }, now);
  const pending = store.validateAndStore(candidate);
  await new Promise((resolve) => setImmediate(resolve));
  candidate[0].value = "mutated";
  resolveQuota();
  await pending;
  assert.deepEqual(JSON.parse(stored).cookies, [{ ...session[0], value: "opaque" }]);
  let calls = 0;
  const oversized = new NanDashboardSessionStore({ getSessionCache: async () => null, putSessionCache: async () => undefined, deleteSessionCache: async () => undefined }, { getQuota: async () => { calls += 1; return { models: [], uncappedModels: [], eligibility: "unknown" }; } }, now);
  assert.deepEqual(await oversized.validateAndStore(Array.from({ length: 32 }, (_, index) => ({ ...session[0], name: `s${index}`, value: "x".repeat(200) }))), { state: "needs-import" });
  assert.equal(calls, 0);
});

test("put failures and quota schema errors remain distinguishable", async () => {
  const keychain = { getSessionCache: async () => JSON.stringify({ version: 1, scope: "nan-dashboard-session", cookies: session }), putSessionCache: async () => { throw new Error("unavailable"); }, deleteSessionCache: async () => undefined };
  const schema = { getQuota: async () => { throw new NanDashboardQuotaError("schema"); } };
  const store = new NanDashboardSessionStore(keychain, schema, now);
  assert.deepEqual(await store.validateAndStore(session), { state: "schema-invalid" });
  assert.deepEqual(await store.getCachedQuota(), { state: "schema-invalid" });
});

test("invalid cache evicts safely and reports failed eviction distinctly", async () => {
  const invalid = new NanDashboardSessionStore({ getSessionCache: async () => "{}", putSessionCache: async () => undefined, deleteSessionCache: async () => undefined }, { getQuota: async () => { throw new Error("must not fetch"); } }, now);
  assert.deepEqual(await invalid.getCachedQuota(), { state: "needs-import" });
  const failed = new NanDashboardSessionStore({ getSessionCache: async () => "{}", putSessionCache: async () => undefined, deleteSessionCache: async () => { throw new Error("no"); } }, { getQuota: async () => { throw new Error("must not fetch"); } }, now);
  assert.deepEqual(await failed.getCachedQuota(), { state: "eviction-failed" });
});

test("auth rejection evicts only when deletion succeeds while transient failures preserve cache", async () => {
  const encoded = JSON.stringify({ version: 1, scope: "nan-dashboard-session", cookies: session });
  let deleted = 0;
  const keychain = { getSessionCache: async () => encoded, putSessionCache: async () => undefined, deleteSessionCache: async () => { deleted += 1; } };
  const auth = new NanDashboardSessionStore(keychain, { getQuota: async () => { throw new NanDashboardQuotaError("auth-rejected"); } }, now);
  assert.deepEqual(await auth.getCachedQuota(), { state: "needs-import" });
  assert.equal(deleted, 1);
  const transient = new NanDashboardSessionStore(keychain, { getQuota: async () => { throw new NanDashboardQuotaError("transport"); } }, now);
  assert.deepEqual(await transient.getCachedQuota(), { state: "transient" });
  assert.equal(deleted, 1);
});

test("builds a separate metrics-scoped header and preserves quota when metrics fail", async () => {
  const scopedSession: BrowserCookieRecord = { name: "session", value: "opaque", domain: "cloud-api.nan.builders", hostOnly: true, path: "/", secure: true, expiresAt: null };
  const encoded = JSON.stringify({ version: 1, scope: "nan-dashboard-session", cookies: [
    scopedSession,
    { name: "quota-only", value: "q", domain: "cloud-api.nan.builders", hostOnly: true, path: "/api/usage", secure: true, expiresAt: null },
    { name: "metrics-only", value: "m", domain: "cloud-api.nan.builders", hostOnly: true, path: "/api/metrics", secure: true, expiresAt: null },
  ] });
  const snapshot: NanDashboardMetricsSnapshot = { last24h: { totalTokens: 0, byModel: [] }, last30d: { totalTokens: 0, byModel: [] }, monthToDate: { totalTokens: 9, byModel: [{ model: "qwen3.6", inputTokens: 4, outputTokens: 5, totalTokens: 9 }] }, allTime: { totalTokens: 0, byModel: [] } };
  let quotaHeader = "", metricsHeader = "";
  const store = new NanDashboardSessionStore(
    { getSessionCache: async () => encoded, putSessionCache: async () => undefined, deleteSessionCache: async () => { throw new Error("metrics failure must not evict"); } },
    { getQuota: async (header) => { quotaHeader = header; return { models: [], uncappedModels: [], eligibility: "unknown" as const }; } },
    now,
    { getMetrics: async (header) => { metricsHeader = header; return snapshot; } },
  );
  const ready = await store.getCachedDashboard();
  assert.equal(ready.state, "ready");
  assert.equal(quotaHeader, "quota-only=q; session=opaque");
  assert.equal(metricsHeader, "metrics-only=m; session=opaque");

  const failed = new NanDashboardSessionStore(
    { getSessionCache: async () => encoded, putSessionCache: async () => undefined, deleteSessionCache: async () => { throw new Error("must not evict"); } },
    { getQuota: async () => ({ models: [], uncappedModels: [], eligibility: "unknown" as const }) },
    now,
    { getMetrics: async () => { throw new NanDashboardMetricsError("auth-rejected"); } },
  );
  assert.deepEqual(await failed.getCachedDashboard(), { state: "ready", quota: { models: [], uncappedModels: [], eligibility: "unknown" }, metricsError: "unavailable" });
});
