import assert from "node:assert/strict";
import test from "node:test";
import { NanDashboardController } from "../src/actions/nan-dashboard-controller.ts";
import type { BrowserCookieRecord, NanDashboardSessionResult, NanDashboardSnapshotResult } from "../src/providers/nan/nan-dashboard-session-store.ts";
import type { NanDashboardMetricsSnapshot } from "../src/providers/nan/nan-dashboard-metrics-provider.ts";
import type { NanDashboardQuota } from "../src/providers/nan/nan-dashboard-quota-provider.ts";

const quota: NanDashboardQuota = {
  eligibility: "unknown",
  models: [{ model: "capped", tokensUsed: 120, cap: 100, percentage: 120, resetAt: "2026-08-01T00:00:00Z", windowHours: null }],
  uncappedModels: [{ model: "uncapped", tokensUsed: 42, resetAt: null, windowHours: null }],
};
const cookie: BrowserCookieRecord = { name: "session", value: "fixture", domain: "nan.builders", hostOnly: false, path: "/", secure: true, expiresAt: null };

class FakeSessions {
  reads = 0;
  writes: readonly BrowserCookieRecord[][] = [];
  result: NanDashboardSessionResult = { state: "needs-import" };
  dashboardResult?: NanDashboardSnapshotResult;
  writeResults: NanDashboardSessionResult[] = [];
  async getCachedDashboard(): Promise<NanDashboardSnapshotResult> { this.reads += 1; return this.dashboardResult ?? this.result; }
  async validateAndStore(cookies: readonly BrowserCookieRecord[]): Promise<NanDashboardSessionResult> {
    this.writes = [...this.writes, cookies];
    return this.writeResults.shift() ?? this.result;
  }
}
class FakeImporter {
  calls = 0;
  candidates: readonly { profileId: string; store: "Network" | "Cookies"; cookies: readonly BrowserCookieRecord[] }[] = [];
  async importCandidates() { this.calls += 1; return this.candidates; }
}
function createController(sessions = new FakeSessions(), importer = new FakeImporter()) {
  return { controller: new NanDashboardController(sessions, importer), sessions, importer };
}

test("undefined and literal legacy route directly to dashboard without importing or reading a legacy provider", async () => {
  const { controller, sessions, importer } = createController();
  sessions.result = { state: "ready", quota };

  assert.equal((await controller.getUsage({})).source, "dashboard");
  assert.equal((await controller.getUsage({ source: "legacy" })).quota, quota);
  assert.equal(controller.getCachedUsage({ source: "legacy" }).source, "dashboard");
  assert.equal(sessions.reads, 2);
  assert.equal(importer.calls, 0);
});

test("unknown source is inert and is never coerced into a dashboard cache read", async () => {
  const { controller, sessions, importer } = createController();
  for (const source of ["other", "LEGACY", null, 0, {}]) {
    assert.deepEqual(await controller.getUsage({ source }), { source: "dashboard", stale: false, error: "invalid-source" });
    assert.deepEqual(controller.getCachedUsage({ source }), { source: "dashboard", stale: false, error: "invalid-source" });
  }
  assert.equal(sessions.reads, 0);
  assert.equal(importer.calls, 0);
});

test("explicit import validates isolated candidates sequentially and is the only importer path", async () => {
  const { controller, sessions, importer } = createController();
  importer.candidates = [
    { profileId: "Default", store: "Network", cookies: [cookie] },
    { profileId: "Profile 1", store: "Cookies", cookies: [{ ...cookie, value: "other" }] },
  ];
  sessions.writeResults = [{ state: "needs-import" }, { state: "ready", quota }];
  assert.equal((await controller.getUsage({ source: "dashboard" })).error, "needs-import");
  assert.equal(importer.calls, 0);
  const accepted = await controller.importChromeSession();
  assert.equal(accepted.state, "ready");
  assert.equal(sessions.writes.length, 2);
  assert.equal(importer.calls, 1);
});

test("explicit pasted session stores scoped records without touching Chrome", async () => {
  const { controller, sessions, importer } = createController();
  sessions.writeResults = [{ state: "ready", quota }];
  const result = await controller.saveSession("Cookie: session=opaque; api=two");
  assert.equal(result.state, "ready");
  assert.equal(importer.calls, 0);
  assert.deepEqual(sessions.writes, [[
    { name: "session", value: "opaque", domain: "cloud-api.nan.builders", hostOnly: true, path: "/", secure: true, expiresAt: null },
    { name: "api", value: "two", domain: "cloud-api.nan.builders", hostOnly: true, path: "/", secure: true, expiresAt: null },
  ]]);
});

test("invalid pasted sessions are inert and keep the working snapshot", async () => {
  const { controller, sessions } = createController();
  sessions.result = { state: "ready", quota };
  assert.equal((await controller.getUsage({})).quota, quota);
  assert.deepEqual(await controller.saveSession("not a session"), { state: "invalid-source" });
  assert.equal(sessions.writes.length, 0);
  assert.equal(controller.getCachedUsage({}).quota, quota);
});

test("pasted session while an import is in flight reports busy without storing", async () => {
  const { controller, sessions, importer } = createController();
  let release!: () => void;
  importer.importCandidates = async () => {
    importer.calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return [];
  };
  const started = controller.importChromeSession();
  assert.deepEqual(await controller.saveSession("session=opaque"), { state: "import-busy" });
  assert.equal(sessions.writes.length, 0);
  release();
  await started;
});

test("dashboard transient keeps only its own last quota and an account reset clears endpoint snapshots", async () => {
  const { controller, sessions } = createController();
  sessions.result = { state: "ready", quota };
  assert.equal((await controller.getUsage({})).quota, quota);
  sessions.result = { state: "transient" };
  assert.equal((await controller.getUsage({})).stale, true);
  sessions.result = { state: "needs-import" };
  assert.deepEqual(await controller.getUsage({}), { source: "dashboard", stale: false, error: "needs-import" });
});

test("shared snapshot preserves quota through metrics failure and discards late old-account reads", async () => {
  const { controller, sessions, importer } = createController();
  const metrics: NanDashboardMetricsSnapshot = { last24h: { totalTokens: 0, byModel: [] }, last30d: { totalTokens: 0, byModel: [] }, monthToDate: { totalTokens: 9, byModel: [{ model: "qwen3.6", inputTokens: 4, outputTokens: 5, totalTokens: 9 }] }, allTime: { totalTokens: 0, byModel: [] } };
  sessions.dashboardResult = { state: "ready", quota, metrics };
  assert.equal((await controller.getUsage({})).metrics, metrics);
  sessions.dashboardResult = { state: "ready", quota, metricsError: "transient" };
  assert.equal((await controller.getUsage({})).metricsStale, true);

  const oldRead = deferred<NanDashboardSnapshotResult>();
  sessions.getCachedDashboard = async () => oldRead.promise;
  const pending = controller.getUsage({});
  importer.candidates = [];
  await controller.importChromeSession();
  oldRead.resolve({ state: "ready", quota, metrics });
  assert.deepEqual(await pending, { source: "dashboard", stale: false, error: "needs-import" });
});

test("dashboard watch retains one shared timer across aggregate consumers", async () => {
  const sessions = new FakeSessions();
  const scheduler = new FakeWatchScheduler();
  sessions.dashboardResult = { state: "ready", quota };
  const controller = new NanDashboardController(sessions, new FakeImporter(), scheduler);
  const first = controller.watchDashboard();
  await waitFor(() => sessions.reads === 1);
  const second = controller.watchDashboard();
  assert.equal(scheduler.size, 1);
  await Promise.resolve();
  await Promise.resolve();
  scheduler.tick();
  await waitFor(() => sessions.reads === 2);
  first();
  assert.equal(scheduler.size, 1);
  second();
  assert.equal(scheduler.size, 0);
});

class FakeWatchScheduler {
  private nextTimer = 0;
  private readonly timers = new Map<number, () => void>();
  get size(): number { return this.timers.size; }
  setInterval(callback: () => void): ReturnType<typeof setInterval> { const id = ++this.nextTimer; this.timers.set(id, callback); return id as unknown as ReturnType<typeof setInterval>; }
  clearInterval(timer: ReturnType<typeof setInterval>): void { this.timers.delete(timer as unknown as number); }
  tick(): void { for (const callback of this.timers.values()) callback(); }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } { let resolve!: (value: T) => void; const promise = new Promise<T>((resolver) => { resolve = resolver; }); return { promise, resolve }; }
async function waitFor(predicate: () => boolean): Promise<void> { while (!predicate()) await new Promise((resolve) => setImmediate(resolve)); }
