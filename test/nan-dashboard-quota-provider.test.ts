import assert from "node:assert/strict";
import test from "node:test";
import { NAN_DASHBOARD_QUOTA_URL, NanDashboardQuotaClient, NanDashboardQuotaError, parseNanDashboardQuota } from "../src/providers/nan/nan-dashboard-quota-provider.ts";

const quota = { periodStart: "2026-09-01", models: [
  { model: "alpha", cap: 1000, tokensUsed: 250, periodEnd: "2026-10-01T00:00:00Z" },
  { model: "rolling", cap: 500, tokensUsed: 0, windowHours: 4 },
  { model: "uncapped", cap: 0, tokensUsed: 99 },
  { model: "over-cap", cap: 100, tokensUsed: 125, periodEnd: null },
] };

test("parses capped, uncapped, and over-cap dynamic quotas without inventing metadata", () => {
  assert.deepEqual(parseNanDashboardQuota(quota), { eligibility: "unknown", models: [
    { model: "alpha", cap: 1000, tokensUsed: 250, percentage: 25, resetAt: "2026-10-01T00:00:00Z", windowHours: null },
    { model: "rolling", cap: 500, tokensUsed: 0, percentage: 0, resetAt: null, windowHours: 4 },
    { model: "over-cap", cap: 100, tokensUsed: 125, percentage: 125, resetAt: null, windowHours: null },
  ], uncappedModels: [{ model: "uncapped", tokensUsed: 99, resetAt: null, windowHours: null }] });
});

test("rejects invalid calendar/schema identities and accepts empty quota results", () => {
  for (const value of [
    {}, { periodStart: "2026-02-30", models: [] }, { periodStart: "2026-09-01", models: [{ model: "a", cap: Infinity, tokensUsed: 0 }] }, { periodStart: "2026-09-01", models: [{ model: "a", cap: 1.5, tokensUsed: 0 }] },
    { periodStart: "2026-09-01", models: [{ model: "a\n", cap: 1, tokensUsed: 0 }] }, { periodStart: "2026-09-01", models: [{ model: "a", cap: 1, tokensUsed: -1 }] },
    { periodStart: "2026-09-01", models: [{ model: "a", cap: 1, tokensUsed: 0, periodEnd: "no" }] },
    { periodStart: "2026-09-01", models: [{ model: "a", cap: 1, tokensUsed: 0 }, { model: "a", cap: 2, tokensUsed: 0 }] },
  ]) assert.throws(() => parseNanDashboardQuota(value), NanDashboardQuotaError);
  assert.deepEqual(parseNanDashboardQuota({ periodStart: "2026-09-01", models: [] }), { eligibility: "unknown", models: [], uncappedModels: [] });
  assert.deepEqual(parseNanDashboardQuota({ periodStart: "2026-09-01", models: [{ model: "free", cap: 0, tokensUsed: 0, periodEnd: null }] }).uncappedModels, [{ model: "free", tokensUsed: 0, resetAt: null, windowHours: null }]);
  assert.throws(() => parseNanDashboardQuota({ periodStart: "2026-09-01", models: [{ model: "a", cap: 1, tokensUsed: 0, periodEnd: "2026-02-30T00:00:00Z" }] }), NanDashboardQuotaError);
});

test("preserves the public six-model quota shape without deciding eligibility", () => {
  // Schema reconstructed from CodexBar PR #3422, a3eac99fc, supplied lines 1990-2045.
  const result = parseNanDashboardQuota({ periodStart: "2026-09-01", models: [
    { model: "glm5.3-flash", cap: 2_000_000_000, tokensUsed: 73_854_494, periodEnd: "2026-10-01T00:00:00Z" },
    { model: "glm5.2", cap: 3_000_000_000, tokensUsed: 0, periodEnd: "2026-10-04T19:25:48Z", windowHours: 4 },
    { model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0, periodEnd: "2026-10-04T19:25:48Z", windowHours: 4 },
    { model: "deepseek-v4-flash", cap: 3_000_000_000, tokensUsed: 0, periodEnd: "2026-10-01T00:00:00Z" },
    { model: "qwen3.8-flash", cap: 500_000_000, tokensUsed: 0, periodEnd: "2026-10-01T00:00:00Z" },
    { model: "mimo-v2.5", cap: 1_000_000_000, tokensUsed: 0, periodEnd: "2026-10-01T00:00:00Z" },
  ] });
  assert.equal(result.eligibility, "unknown");
  assert.deepEqual(result.models.map(({ model, resetAt, windowHours }) => ({ model, resetAt, windowHours })), [
    { model: "glm5.3-flash", resetAt: "2026-10-01T00:00:00Z", windowHours: null },
    { model: "glm5.2", resetAt: "2026-10-04T19:25:48Z", windowHours: 4 },
    { model: "glm5.3", resetAt: "2026-10-04T19:25:48Z", windowHours: 4 },
    { model: "deepseek-v4-flash", resetAt: "2026-10-01T00:00:00Z", windowHours: null },
    { model: "qwen3.8-flash", resetAt: "2026-10-01T00:00:00Z", windowHours: null },
    { model: "mimo-v2.5", resetAt: "2026-10-01T00:00:00Z", windowHours: null },
  ]);
});

test("uses fixed manual redirects and never fetches unsafe header or redirect targets", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = new NanDashboardQuotaClient(async (input, init) => { calls.push({ input: String(input), init }); return new Response(JSON.stringify(quota)); });
  await client.getQuota("session=value");
  assert.equal(calls[0].input, NAN_DASHBOARD_QUOTA_URL);
  assert.equal(calls[0].init?.redirect, "manual");
  for (const unsafe of ["x\r\nInjected: yes", "x\u000b", "x\u007f"]) await assert.rejects(client.getQuota(unsafe), NanDashboardQuotaError);
  assert.equal(calls.length, 1);
  for (const status of [401, 403, 302, 307]) await assert.rejects(new NanDashboardQuotaClient(async () => new Response("", { status })).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "auth-rejected");
  await assert.rejects(new NanDashboardQuotaClient(async () => new Response("", { status: 503 })).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "transport");
});

test("bounds malformed, oversized and secret-bearing transport failures", async () => {
  const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(128 * 1024)); c.close(); } });
  await assert.rejects(new NanDashboardQuotaClient(async () => new Response(oversized)).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "transport");
  await assert.rejects(new NanDashboardQuotaClient(async () => new Response("{")).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "schema");
  await assert.rejects(new NanDashboardQuotaClient(async () => new Response(new Uint8Array([0xff]))).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "schema");
  let contentLengthCancelled = false;
  await assert.rejects(new NanDashboardQuotaClient(async () => new Response(new ReadableStream({ cancel: () => { contentLengthCancelled = true; } }), { headers: { "content-length": "999999" } })).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "transport");
  await Promise.resolve();
  assert.equal(contentLengthCancelled, true);
  let nonOkCancelled = false;
  await assert.rejects(new NanDashboardQuotaClient(async () => new Response(new ReadableStream({ cancel: () => { nonOkCancelled = true; } }), { status: 503 })).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "transport");
  await Promise.resolve();
  assert.equal(nonOkCancelled, true);
  await assert.rejects(new NanDashboardQuotaClient(async () => { throw new Error("credential-secret"); }).getQuota("x"), (error: NanDashboardQuotaError) => error.kind === "transport" && !error.message.includes("credential-secret"));
});

test("timeout aborts stalled headers and bodies when mocks ignore signals", async () => {
  let timer: (() => void) | undefined;
  const clock = { setTimeout: (callback: () => void) => { timer = callback; return 1; }, clearTimeout: () => undefined };
  const headers = new NanDashboardQuotaClient(() => new Promise<Response>(() => undefined), clock).getQuota("x");
  timer?.();
  await assert.rejects(headers, (error: NanDashboardQuotaError) => error.kind === "transport");
  const stalledBody = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
  const body = new NanDashboardQuotaClient(async () => new Response(stalledBody), clock).getQuota("x");
  timer?.();
  await assert.rejects(body, (error: NanDashboardQuotaError) => error.kind === "transport");
});
