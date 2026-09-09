import assert from "node:assert/strict";
import test from "node:test";
import { NAN_DASHBOARD_METRICS_URL, NanDashboardMetricsClient, NanDashboardMetricsError, parseNanDashboardMetrics } from "../src/providers/nan/nan-dashboard-metrics-provider.ts";

const metrics = {
  last24h: { totalTokens: 100, byModel: [
    { model: "qwen3.6", inputTokens: 40, outputTokens: 30 },
    { model: "gemma4", inputTokens: 10, outputTokens: 5 },
  ] },
  last30d: { totalTokens: 900, byModel: [
    { model: "qwen3.6", inputTokens: 120, outputTokens: 110 },
    { model: "deepseek-v4-flash-0731", inputTokens: 70, outputTokens: 60 },
  ] },
  monthToDate: { totalTokens: 400, byModel: [
    { model: "qwen3.6", inputTokens: 50, outputTokens: 45 },
    { model: "gemma4", inputTokens: 20, outputTokens: 15 },
    { model: "glm5.3-flash", inputTokens: 10, outputTokens: 5 },
  ] },
  allTime: { totalTokens: 1_500, cachedAt: "2026-09-08T23:37:20Z", byModel: [
    { model: "deepseek-v4-flash-0731", inputTokens: 500, outputTokens: 300 },
    { model: "glm5.3-flash", inputTokens: 50, outputTokens: 25 },
  ] },
  timeSeries: [{ date: "2026-09-08", model: "qwen3.6", inputTokens: 2, outputTokens: 1 }],
};

test("parses all four independent usage windows without consuming time series", () => {
  const result = parseNanDashboardMetrics({ ...metrics, ignored: true, timeSeries: [{ nope: true }] });
  assert.deepEqual(result.last24h.byModel, [
    { model: "qwen3.6", inputTokens: 40, outputTokens: 30, totalTokens: 70 },
    { model: "gemma4", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  ]);
  assert.equal(result.last24h.totalTokens, 100); // Server aggregate is authoritative, not row sum.
  assert.equal(result.monthToDate.totalTokens, 400);
  assert.notEqual(result.monthToDate.totalTokens, result.last30d.totalTokens);
  assert.equal(result.allTime.cachedAt, "2026-09-08T23:37:20Z");
  assert.deepEqual(result.last30d.byModel.map(({ model }) => model), ["qwen3.6", "deepseek-v4-flash-0731"]);
  assert.deepEqual(result.allTime.byModel.map(({ model }) => model), ["deepseek-v4-flash-0731", "glm5.3-flash"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.monthToDate.byModel), true);
  assert.equal(Object.isFrozen(result.monthToDate.byModel[0]), true);
});

test("accepts real empty windows and treats cachedAt as all-time-only optional freshness", () => {
  const empty = { last24h: { totalTokens: 0, byModel: [] }, last30d: { totalTokens: 0, byModel: [] }, monthToDate: { totalTokens: 0, byModel: [] }, allTime: { totalTokens: 0, byModel: [] } };
  assert.deepEqual(parseNanDashboardMetrics(empty), empty);
  assert.throws(() => parseNanDashboardMetrics({ ...empty, last24h: { ...empty.last24h, cachedAt: "invalid" } }), NanDashboardMetricsError);
  assert.throws(() => parseNanDashboardMetrics({ ...empty, allTime: { ...empty.allTime, cachedAt: "2026-02-30T00:00:00Z" } }), NanDashboardMetricsError);
});

test("rejects missing windows, duplicate per-window ids, unsafe counters, and row total overflow", () => {
  const invalidRows = [
    { model: "a", inputTokens: -1, outputTokens: 0 },
    { model: "a", inputTokens: 1.5, outputTokens: 0 },
    { model: "a", inputTokens: Infinity, outputTokens: 0 },
    { model: "a", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  ];
  assert.throws(() => parseNanDashboardMetrics({ last24h: metrics.last24h, last30d: metrics.last30d, monthToDate: metrics.monthToDate }), NanDashboardMetricsError);
  assert.throws(() => parseNanDashboardMetrics({ ...metrics, last24h: { totalTokens: 1, byModel: [{ model: "a", inputTokens: 0, outputTokens: 0 }, { model: "a", inputTokens: 0, outputTokens: 0 }] } }), NanDashboardMetricsError);
  for (const row of invalidRows) assert.throws(() => parseNanDashboardMetrics({ ...metrics, last24h: { totalTokens: 1, byModel: [row] } }), NanDashboardMetricsError);
  assert.throws(() => parseNanDashboardMetrics({ ...metrics, last24h: { totalTokens: Number.MAX_SAFE_INTEGER + 1, byModel: [] } }), NanDashboardMetricsError);
});

test("uses only the fixed metrics route with bounded manual, sanitized transport", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = new NanDashboardMetricsClient(async (input, init) => { calls.push({ input: String(input), init }); return new Response(JSON.stringify(metrics)); });
  await client.getMetrics("session=value");
  assert.equal(calls[0].input, NAN_DASHBOARD_METRICS_URL);
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.redirect, "manual");
  for (const unsafe of ["x\r\nInjected: yes", "x\u000b", "x\u007f", "x".repeat(4 * 1024 + 1)]) await assert.rejects(client.getMetrics(unsafe), NanDashboardMetricsError);
  assert.equal(calls.length, 1);
  for (const status of [401, 403, 302, 307]) await assert.rejects(new NanDashboardMetricsClient(async () => new Response("", { status })).getMetrics("x"), (error: NanDashboardMetricsError) => error.kind === "auth-rejected");
  await assert.rejects(new NanDashboardMetricsClient(async () => new Response("", { status: 503 })).getMetrics("x"), (error: NanDashboardMetricsError) => error.kind === "transport");
  await assert.rejects(new NanDashboardMetricsClient(async () => { throw new Error("cookie-secret"); }).getMetrics("x"), (error: NanDashboardMetricsError) => error.kind === "transport" && !error.message.includes("cookie-secret"));
});

test("bounds metrics response stream and total timeout", async () => {
  const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(257 * 1024)); c.close(); } });
  await assert.rejects(new NanDashboardMetricsClient(async () => new Response(oversized)).getMetrics("x"), (error: NanDashboardMetricsError) => error.kind === "transport");
  let timer: (() => void) | undefined;
  const clock = { setTimeout: (callback: () => void) => { timer = callback; return 1; }, clearTimeout: () => undefined };
  const pending = new NanDashboardMetricsClient(() => new Promise<Response>(() => undefined), clock).getMetrics("x");
  timer?.();
  await assert.rejects(pending, (error: NanDashboardMetricsError) => error.kind === "transport");
});
