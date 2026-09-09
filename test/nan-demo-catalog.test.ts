import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NAN_DEMO_MODEL,
  NAN_DEMO_CATALOG,
  cycleNanDemoModel,
  getNanDemoModel,
} from "../src/providers/nan/nan-demo-catalog.ts";

test("NaN demo catalog contains only the approved static models and caps", () => {
  assert.equal(DEFAULT_NAN_DEMO_MODEL, "deepseek-v4-flash");
  assert.deepEqual(Object.keys(NAN_DEMO_CATALOG), [
    "deepseek-v4-flash", "mimo-v2.5", "qwen3.6", "gemma4",
  ]);
  assert.deepEqual(NAN_DEMO_CATALOG["deepseek-v4-flash"], { label: "DeepSeek V4 Flash", kind: "capped", cap: 500_000_000, unit: "tokens/month" });
  assert.deepEqual(NAN_DEMO_CATALOG["mimo-v2.5"], { label: "MiMo V2.5", kind: "capped", cap: 500_000_000, unit: "tokens/month" });
  assert.equal(NAN_DEMO_CATALOG["qwen3.6"].kind, "uncapped");
  assert.equal(NAN_DEMO_CATALOG.gemma4.kind, "uncapped");
});

test("NaN demo catalog rejects unknown, missing, and non-string model keys", () => {
  assert.equal(getNanDemoModel("not-a-model"), undefined);
  assert.equal(getNanDemoModel(undefined), undefined);
  assert.equal(getNanDemoModel(42), undefined);
});

test("NaN demo catalog cycles forward and backward", () => {
  assert.equal(cycleNanDemoModel("mimo-v2.5", 1), "qwen3.6");
  assert.equal(cycleNanDemoModel("mimo-v2.5", -1), "deepseek-v4-flash");
});

test("NaN demo catalog wraps at both ends", () => {
  assert.equal(cycleNanDemoModel("gemma4", 1), "deepseek-v4-flash");
  assert.equal(cycleNanDemoModel("deepseek-v4-flash", -1), "gemma4");
});

test("NaN demo catalog defaults invalid and missing current models", () => {
  assert.equal(cycleNanDemoModel("not-a-model", 0), DEFAULT_NAN_DEMO_MODEL);
  assert.equal(cycleNanDemoModel(undefined, 0), DEFAULT_NAN_DEMO_MODEL);
});

test("NaN demo catalog advances by multiple ticks in either direction", () => {
  assert.equal(cycleNanDemoModel("deepseek-v4-flash", 3), "gemma4");
  assert.equal(cycleNanDemoModel("deepseek-v4-flash", -2), "qwen3.6");
  assert.equal(cycleNanDemoModel("mimo-v2.5", 13), "qwen3.6");
});
