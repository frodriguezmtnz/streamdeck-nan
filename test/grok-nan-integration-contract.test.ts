import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GROK_ACP_METHODS } from "../src/providers/grok/grok-acp-contract.ts";

const read = (path: string): string => readFileSync(path, "utf8");
const manifest = JSON.parse(read("com.barbatdev.ai-usage.sdPlugin/manifest.json"));

test("README documents the experimental local-CLI-only Grok boundary", () => {
  const readme = read("README.md");
  assert.match(readme, /Grok Usage \(EXPERIMENTAL\)/);
  assert.match(readme, /authenticated local Grok Build CLI/);
  assert.match(readme, /does\s+not read credential files or API keys, send prompts, or invoke inference/);
  assert.deepEqual(GROK_ACP_METHODS, ["initialize", "x.ai/billing"]);
});

test("NaN surfaces describe dashboard import and a straightforward old-profile migration", () => {
  const inspector = read("com.barbatdev.ai-usage.sdPlugin/ui/property-inspector.html");
  const readme = read("README.md");
  const action = manifest.Actions.find(({ UUID }: { UUID: string }) => UUID === "com.barbatdev.ai-usage.nan-demo");

  assert.match(action.Tooltip, /NaN/i);
  assert.match(inspector, /Import session from Chrome/);
  assert.doesNotMatch(inspector, /Legacy collector|nanSource/i);
  assert.match(readme, /^# NaN Dashboard for Stream Deck\+\n\nStream Deck\+ plugin supporting NaN Dashboard alongside the current external CLI provider dials for Claude, Codex, and experimental Grok usage\./);
  assert.match(readme, /saved `legacy`[\s\S]*source is migrated to `dashboard` once/i);
  assert.doesNotMatch(readme, /collector-config|NaN Collector Deployment|Legacy collector/i);
});

test("NaN runtime has no legacy provider or credential-store construction", () => {
  const runtime = [read("src/plugin.ts"), read("src/actions/nan-demo-usage.ts"), read("src/actions/nan-dashboard-controller.ts")].join("\n");
  assert.doesNotMatch(runtime, /NanSummaryProvider|MacOsNanCredentialStore|nan-summary-provider|nan-credential-store/);
});
