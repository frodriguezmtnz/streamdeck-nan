import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRemoteAssets } from "./release-assets.mjs";
import { validateVersions } from "./release-contract.mjs";

const expected = ["plugin.streamDeckPlugin", "SHA256SUMS"];
const root = new URL("../", import.meta.url);

async function rootFile(path, encoding) {
  return readFile(new URL(path, root), encoding);
}

test("draft asset contract identifies stale and missing assets before upload", () => {
  assert.deepEqual(validateRemoteAssets({ isDraft: true, assets: [{ name: "stale.zip" }] }, expected, true), {
    unexpected: ["stale.zip"], missing: expected,
  });
});

test("draft asset contract requires the exact post-upload allowlist", () => {
  assert.deepEqual(validateRemoteAssets({ isDraft: true, assets: expected.map((name) => ({ name })) }, expected), { unexpected: [], missing: [] });
  assert.throws(() => validateRemoteAssets({ isDraft: true, assets: [{ name: expected[0] }] }, expected), /missing=SHA256SUMS/);
  assert.throws(() => validateRemoteAssets({ isDraft: true, assets: [...expected, "stale.zip"].map((name) => ({ name })) }, expected), /unexpected=stale.zip/);
  assert.throws(() => validateRemoteAssets({ isDraft: true, assets: [...expected, "NOTARIZATION.json"].map((name) => ({ name })) }, expected), /unexpected=NOTARIZATION\.json/);
});

test("published releases are immutable", () => {
  assert.throws(() => validateRemoteAssets({ isDraft: false, assets: [] }, expected, true), /published release/);
});

test("reproducible packaging preserves executable mode only for the NaN Keychain helper", async () => {
  const source = await readFile(new URL("./pack-streamdeck.mjs", import.meta.url), "utf8");
  assert.match(source, /function normalizedFileMode\(path, isDirectory\)/);
  assert.match(source, /path\.endsWith\("\/bin\/nan-keychain"\) \? 0o755 : 0o644/);
});

test("private development package identity maps to the plugin version", async () => {
  const packageManifest = JSON.parse(await rootFile("package.json", "utf8"));
  const pluginManifest = JSON.parse(await rootFile("com.refactor-ia.nan.sdPlugin/manifest.json", "utf8"));

  assert.equal(packageManifest.name, "streamdeck-nan");
  assert.equal(packageManifest.private, true);
  validateVersions(`v${packageManifest.version}`, packageManifest.version, pluginManifest.Version);
});

test("plugin package preserves root legal notices byte-for-byte", async () => {
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.deepEqual(
      await rootFile(file),
      await rootFile(`com.refactor-ia.nan.sdPlugin/${file}`),
      `${file} must ship unchanged in the plugin package`,
    );
  }
});
