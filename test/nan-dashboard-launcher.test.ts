import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

const actionUrl = new URL("../src/actions/nan-dashboard-launcher.ts", import.meta.url);
const manifestUrl = new URL("../com.refactor-ia.nan.sdPlugin/manifest.json", import.meta.url);
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
  export function action() { return () => {}; }
  export class SingletonAction {}
  export const streamDeck = {
    system: { openUrl: async (url) => {
      if (globalThis.__nanLauncher.reject) throw globalThis.__nanLauncher.reject;
      globalThis.__nanLauncher.openUrls.push(url);
    } },
    logger: { warn: (message) => globalThis.__nanLauncher.warnings.push(message) },
  };
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@elgato/streamdeck" && context.parentURL === actionUrl.href) {
      return { url: sdkUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== actionUrl.href) return loaded;
    return { ...loaded, source: loaded.source.toString().replace(/^@action\([^\n]+\)\n/gm, "") };
  },
});

type Launcher = { onKeyDown(event: unknown): Promise<void> };

async function loadLauncher(): Promise<new () => Launcher> {
  return (await import(actionUrl.href)).NanDashboardLauncher;
}

function keyguard(isKey: boolean): unknown {
  return { action: { isKey: () => isKey } };
}

test("dashboard launcher opens exactly the fixed URL only for a keypad keypress", async () => {
  const state = { openUrls: [] as string[], warnings: [] as string[] };
  Object.assign(globalThis, { __nanLauncher: state });
  const NanDashboardLauncher = await loadLauncher();
  const launcher = new NanDashboardLauncher();

  await launcher.onKeyDown(keyguard(false));
  assert.deepEqual(state.openUrls, []);

  await launcher.onKeyDown(keyguard(true));
  assert.deepEqual(state.openUrls, ["https://cloud.nan.builders/dashboard"]);
  assert.deepEqual(state.warnings, []);
});

test("dashboard launcher logs one bounded warning without retrying or exposing a rejected error", async () => {
  const state = {
    openUrls: [] as string[],
    warnings: [] as string[],
    reject: new Error("https://secret.example.test/?token=do-not-log"),
  };
  Object.assign(globalThis, { __nanLauncher: state });
  const NanDashboardLauncher = await loadLauncher();
  const launcher = new NanDashboardLauncher();

  await launcher.onKeyDown(keyguard(true));
  assert.equal(state.openUrls.length, 0);
  assert.deepEqual(state.warnings, ["NaN Dashboard could not be opened."]);
  assert.doesNotMatch(state.warnings[0]!, /secret|token|https?:\/\//i);
});

test("manifest identifies the NaN Dashboard plugin at its public repository URL", () => {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  assert.equal(manifest.URL, "https://github.com/refactor-ia/streamdeck-nan");
  assert.equal(manifest.UUID, "com.refactor-ia.nan");
  assert.equal(manifest.Category, "NaN Dashboard");
});

test("launcher source has no settings, controller, polling, or session dependencies", () => {
  const source = readFileSync(actionUrl, "utf8");
  assert.match(source, /@action\(\{ UUID: "com\.refactor-ia\.nan\.nan-dashboard" \}\)/);
  assert.doesNotMatch(source, /getSettings|setSettings|NanDashboardController|provider|poll|session|retry/i);
});
