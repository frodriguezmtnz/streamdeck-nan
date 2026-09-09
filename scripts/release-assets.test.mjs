import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRemoteAssets } from "./release-assets.mjs";

const expected = ["plugin.streamDeckPlugin", "SHA256SUMS"];

test("draft asset contract identifies stale and missing assets before upload", () => {
  assert.deepEqual(validateRemoteAssets({ isDraft: true, assets: [{ name: "stale.zip" }] }, expected, true), {
    unexpected: ["stale.zip"], missing: expected,
  });
});

test("draft asset contract requires the exact post-upload allowlist", () => {
  assert.deepEqual(validateRemoteAssets({ isDraft: true, assets: expected.map((name) => ({ name })) }, expected), { unexpected: [], missing: [] });
  assert.throws(() => validateRemoteAssets({ isDraft: true, assets: [{ name: expected[0] }] }, expected), /missing=SHA256SUMS/);
  assert.throws(() => validateRemoteAssets({ isDraft: true, assets: [...expected, "stale.zip"].map((name) => ({ name })) }, expected), /unexpected=stale.zip/);
});

test("published releases are immutable", () => {
  assert.throws(() => validateRemoteAssets({ isDraft: false, assets: [] }, expected, true), /published release/);
});

test("reproducible packaging preserves executable mode only for the NaN Keychain helper", async () => {
  const source = await readFile(new URL("./pack-streamdeck.mjs", import.meta.url), "utf8");
  assert.match(source, /function normalizedFileMode\(path, isDirectory\)/);
  assert.match(source, /path\.endsWith\("\/bin\/nan-keychain"\) \? 0o755 : 0o644/);
});
