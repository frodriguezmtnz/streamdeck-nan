import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  parseVerificationMode,
  validateChecksum,
  validateVersions,
  verifyRelease,
  verifyUnsignedCiArtifacts,
} from "./release-contract.mjs";

const execFile = promisify(execFileCallback);

async function createReleaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "release-contract-"));
  const source = join(root, "artifact-source");
  await mkdir(join(root, "com.barbatdev.ai-usage.sdPlugin"), { recursive: true });
  await mkdir(join(root, "dist"));
  await mkdir(source);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(join(root, "com.barbatdev.ai-usage.sdPlugin", "manifest.json"), JSON.stringify({ Version: "1.2.3.0" }));
  return { root, source };
}

async function writeArtifact(root, source, content = "synthetic plugin contents", artifactName = "one.streamDeckPlugin") {
  await writeFile(join(source, "plugin.txt"), content);
  await execFile("zip", ["-q", join(root, "dist", artifactName), "plugin.txt"], { cwd: source });
  const bytes = await readFile(join(root, "dist", artifactName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "dist", "SHA256SUMS"), `${digest}  ${artifactName}\n`);
  return { artifactName, digest };
}

test("release versions require exact tag, package, and four-part manifest versions", () => {
  validateVersions("v1.2.3", "1.2.3", "1.2.3.0");
  for (const tag of ["1.2.3", "v1.2", "v1.2.3-beta", "v01.2.3"]) {
    assert.throws(() => validateVersions(tag, "1.2.3", "1.2.3.0"));
  }
  assert.throws(() => validateVersions("v1.2.3", "1.2.4", "1.2.3.0"), /package version/);
  assert.throws(() => validateVersions("v1.2.3", "1.2.3", "1.2.4.0"), /manifest version/);
});

test("checksum accepts one exact basename and digest", () => {
  const digest = "a".repeat(64);
  validateChecksum(`${digest}  plugin.streamDeckPlugin\n`, "plugin.streamDeckPlugin", digest);
  assert.throws(() => validateChecksum(`not-a-checksum  plugin.streamDeckPlugin\n`, "plugin.streamDeckPlugin", digest), /lowercase SHA-256/);
  assert.throws(() => validateChecksum(`${digest}  dist/plugin.streamDeckPlugin\n`, "plugin.streamDeckPlugin", digest), /basename/);
  assert.throws(() => validateChecksum(`${digest}  plugin.streamDeckPlugin\n${digest}  other.streamDeckPlugin\n`, "plugin.streamDeckPlugin", digest), /exactly one/);
  assert.throws(() => validateChecksum(`${"b".repeat(64)}  plugin.streamDeckPlugin\n`, "plugin.streamDeckPlugin", digest), /does not match/);
});

test("release validation requires one package, exact checksum, and an archive secret scan", async () => {
  const { root, source } = await createReleaseFixture();
  await assert.rejects(verifyRelease(root, "v1.2.3"), /found 0/);

  await writeArtifact(root, source);
  await verifyRelease(root, "v1.2.3");
  await verifyUnsignedCiArtifacts(root, "v1.2.3");

  await writeFile(join(root, "dist", "SHA256SUMS"), `${"b".repeat(64)}  one.streamDeckPlugin\n`);
  await assert.rejects(verifyRelease(root, "v1.2.3"), /does not match/);

  await writeArtifact(root, source, String.fromCharCode(97, 112, 105, 95, 107, 101, 121, 32, 61, 32, 34, 115, 121, 110, 116, 104, 101, 116, 105, 99, 45, 118, 97, 108, 117, 101, 45, 110, 111, 116, 45, 97, 45, 114, 101, 97, 108, 45, 115, 101, 99, 114, 101, 116, 45, 49, 50, 51, 34));
  await assert.rejects(verifyRelease(root, "v1.2.3"), /api.*key/i);

  await writeArtifact(root, source, "second synthetic plugin", "two.streamDeckPlugin");
  await assert.rejects(verifyRelease(root, "v1.2.3"), /found 2/);
});

test("verification CLI modes keep versions-only and reject unknown modes", async () => {
  assert.deepEqual(parseVerificationMode("versions"), { artifacts: false });
  assert.deepEqual(parseVerificationMode("unsigned-ci"), { artifacts: true });
  assert.deepEqual(parseVerificationMode(undefined), { artifacts: true });
  assert.throws(() => parseVerificationMode("unsigned"), /unknown verification mode/);
  await assert.rejects(
    execFile(process.execPath, [join(process.cwd(), "scripts", "release-contract.mjs"), "v1.2.3", "unsigned"], { cwd: process.cwd() }),
    (error) => /unknown verification mode/.test(error.stderr),
  );
});
