import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actionSource = readFileSync("src/actions/nan-demo-usage.ts", "utf8");

test("NaN runtime constructs only the dashboard controller and keeps the dial UUID", () => {
  const plugin = readFileSync("src/plugin.ts", "utf8");
  assert.match(actionSource, /@action\(\{ UUID: "com\.barbatdev\.ai-usage\.nan-demo" \}\)/);
  assert.doesNotMatch(actionSource, /NanSummaryProvider|MacOsNanCredentialStore|nan-summary-provider|nan-credential-store/);
  assert.doesNotMatch(plugin, /NanSummaryProvider|MacOsNanCredentialStore|nanProvider/);
  assert.match(plugin, /const nanDashboard = new NanDashboardController\(\)/);
  assert.match(plugin, /const nanAction = new NanDemoUsage\(nanDashboard\)/);
});

test("legacy source migration uses the existing ordered write queue and preserves the settings object", () => {
  assert.match(actionSource, /settings\.source !== "legacy"/);
  assert.match(actionSource, /const migrated = \{ \.\.\.settings, source: "dashboard" \}/);
  assert.match(actionSource, /persistLatestNanSettings\([\s\S]*this\.latestDashboardSelection[\s\S]*this\.writeSettings/);
  assert.match(actionSource, /legacySourceMigrated/);
  assert.doesNotMatch(actionSource, /migrateNanLiveSettings|readAndMigrateCurrentNanSettings|persistNanLiveInitialization/);
});

test("appearance, refresh, rotation, settings, and wake use cached/dashboard reads; only the exact UI message imports", () => {
  assert.match(actionSource, /onWillAppear[\s\S]*activateOnAppearance[\s\S]*migrateLegacySource/);
  assert.match(actionSource, /onDidReceiveSettings[\s\S]*getCachedUsage/);
  assert.match(actionSource, /onDialRotate[\s\S]*getCachedUsage/);
  assert.match(actionSource, /updateDisplay[\s\S]*this\.dashboard\.getUsage/);
  assert.match(actionSource, /Object\.keys\(payload\)\.length === 1/);
  const beforeSend = actionSource.slice(0, actionSource.indexOf("onSendToPlugin"));
  assert.doesNotMatch(beforeSend, /importChromeSession\(/);
  const sendHandler = actionSource.slice(actionSource.indexOf("onSendToPlugin"), actionSource.indexOf("onWillDisappear"));
  assert.match(sendHandler, /isImportChromeSessionMessage[\s\S]*this\.dashboard\.importChromeSession\(\)/);
});
