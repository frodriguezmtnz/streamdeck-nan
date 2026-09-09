import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

test("manifest executable installs one ordered system wake recovery pipeline", () => {
  const manifestPath = "com.barbatdev.ai-usage.sdPlugin/manifest.json";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { CodePath: string };
  const executablePath = join(dirname(manifestPath), manifest.CodePath);
  assert.equal(statSync(executablePath).isFile(), true);
  const plugin = readFileSync(executablePath, "utf8");
  assertWakeContract(plugin);
});

test("manifest executable contract rejects a bundle without wake wiring", () => {
  const manifestPath = "com.barbatdev.ai-usage.sdPlugin/manifest.json";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { CodePath: string };
  const plugin = readFileSync(join(dirname(manifestPath), manifest.CodePath), "utf8");

  assert.throws(
    () => assertWakeContract(plugin.replace("streamDeck.system.onSystemDidWakeUp", "streamDeck.system.missingWakeHandler")),
    /wake listener/,
  );
});

function assertWakeContract(plugin: string): void {
  const listener = "streamDeck.system.onSystemDidWakeUp";
  const recoveries = [
    "claudeCoordinator.recoverAfterWake()",
    "codexCoordinator.recoverAfterWake()",
    "grokCoordinator.recoverAfterWake()",
  ];
  const legacyCollectorReferences = [
    "NanSummaryProvider",
    "nanProvider",
  ];
  const resumes = [
    "claudeAction.resumeAfterSystemWake()",
    "codexAction.resumeAfterSystemWake()",
    "grokAction.resumeAfterSystemWake()",
    "nanAction.resumeAfterSystemWake()",
  ];

  assert.equal(plugin.split(listener).length - 1, 1, "wake listener");
  assert.equal(
    plugin.split("installPluginShutdown([claudeProvider, codexProvider, grokProvider])").length - 1,
    1,
    "network provider shutdown targets",
  );
  for (const reference of legacyCollectorReferences) {
    assert.equal(plugin.includes(reference), false, `legacy collector reference: ${reference}`);
  }
  for (const call of [...recoveries, ...resumes]) assert.equal(plugin.split(call).length - 1, 1, call);
  assert.ok(plugin.indexOf(listener) < plugin.indexOf("streamDeck.connect()"));
  assert.ok(Math.max(...recoveries.map((call) => plugin.indexOf(call)))
    < Math.min(...resumes.map((call) => plugin.indexOf(call))));
}
