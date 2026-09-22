import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findSecrets, scanReleaseArtifact, verifyReleaseContents } from "./scan-secrets.mjs";

test("secret scanner detects high-confidence JWT and assignment formats", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signature_value_123"].join(".");
  const assignment = ["client_secret = \"", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4", "\""].join("");
  assert.ok(findSecrets(jwt).length > 0);
  assert.ok(findSecrets(assignment).length > 0);
});

test("secret scanner ignores placeholders and ordinary short test values", () => {
  assert.deepEqual(findSecrets('client_secret = "<GENERATE_ME>"\ntoken = "producer-secret"'), []);
});

test("release artifact scanner inspects extracted package contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-secret-test-"));
  const plugin = join(root, "plugin.sdPlugin");
  await mkdir(plugin);
  const secret = ["access_token = \"", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4", "\""].join("");
  await writeFile(join(plugin, "plugin.js"), secret);
  const artifact = join(root, "plugin.streamDeckPlugin");
  execFileSync("zip", ["-X", "-q", artifact, "plugin.sdPlugin/plugin.js"], { cwd: root });
  assert.throws(() => scanReleaseArtifact(artifact), /plugin\.js/);
  await rm(root, { recursive: true, force: true });
});

test("release package contents require both platform runtime entries", () => {
  const root = "com.refactor-ia.nan.sdPlugin/";
  const entries = [`${root}bin/plugin.js`, `${root}bin/nan-keychain`, `${root}bin/nan-dpapi.ps1`];
  assert.doesNotThrow(() => verifyReleaseContents(entries));
  assert.throws(() => verifyReleaseContents(entries.slice(0, 2)), /bin\/nan-dpapi\.ps1/);
  assert.throws(() => verifyReleaseContents(entries.filter((entry) => !entry.endsWith("nan-keychain"))), /bin\/nan-keychain/);
});
