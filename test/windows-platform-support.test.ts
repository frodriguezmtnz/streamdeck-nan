import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  renderClaudeFeedback,
  renderCodexFeedback,
  renderGrokFeedback,
} from "../src/actions/usage-feedback.ts";
import { UsageProviderError } from "../src/usage/provider.ts";
import { TransitioningProviderStatusReporter } from "../src/usage/provider-status-reporter.ts";
import { UnsupportedPlatformUsageProvider } from "../src/usage/unsupported-platform-provider.ts";

test("manifest declares macOS and Windows support within the two-entry limit", () => {
  const manifest = JSON.parse(
    readFileSync("com.refactor-ia.nan.sdPlugin/manifest.json", "utf8"),
  ) as { OS: Array<{ Platform: string; MinimumVersion: string }> };

  assert.ok(manifest.OS.length >= 1 && manifest.OS.length <= 2);
  const platforms = manifest.OS.map(({ Platform }) => Platform);
  assert.deepEqual(platforms.slice().sort(), ["mac", "windows"]);
  for (const entry of manifest.OS) assert.match(entry.MinimumVersion, /^\d+(\.\d+)*$/);
});

test("unsupported-platform provider fails closed without touching discovery", async () => {
  const provider = new UnsupportedPlatformUsageProvider("claude");

  assert.equal(provider.id, "claude");
  const result = await provider.getUsage();
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "unsupported-platform");

  provider.recoverAfterWake();
  provider.stopImmediately();
  await provider.stop();
});

test("external dials surface MAC ONLY for an unsupported platform result", () => {
  const unsupported = { ok: false as const, error: new UsageProviderError("unsupported-platform") };

  assert.equal(renderClaudeFeedback(unsupported).status, "MAC ONLY");
  assert.equal(renderCodexFeedback(unsupported).status, "MAC ONLY");
  assert.equal(renderGrokFeedback(unsupported).status, "MAC ONLY");
});

test("MAC ONLY does not replace unrelated external-dial failures", () => {
  const unavailable = { ok: false as const, error: new UsageProviderError("unavailable") };

  assert.equal(renderClaudeFeedback(unavailable).status, "NO DATA");
  assert.equal(renderCodexFeedback(unavailable).status, "NO DATA");
  assert.equal(renderGrokFeedback(unavailable).status, "NO DATA");
});

test("provider status logging accepts unsupported-platform", () => {
  const messages: string[] = [];
  const reporter = new TransitioningProviderStatusReporter((message) => messages.push(message));

  reporter.failure("claude", "unsupported-platform");
  reporter.failure("claude", "unsupported-platform");
  reporter.failure("codex", "unsupported-platform");

  assert.deepEqual(messages, [
    "provider=claude state=unsupported-platform",
    "provider=codex state=unsupported-platform",
  ]);
});

test("plugin wiring keeps external integrations macOS-only behind a stable error", () => {
  const plugin = readFileSync("src/plugin.ts", "utf8");

  assert.match(plugin, /const externalUsageSupported = process\.platform === "darwin"/);
  assert.equal(plugin.split("new UnsupportedPlatformUsageProvider(").length - 1, 3);
  assert.match(plugin, /installPluginShutdown\(\[claudeProvider, codexProvider, grokProvider\]\)/);
});
