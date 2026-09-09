import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateChecksum, validateNotarizationReceipt, validateVersions, verifyRelease } from "./release-contract.mjs";

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

test("notarization receipt binds Accepted status to the published artifact checksum", () => {
  const digest = "a".repeat(64);
  validateNotarizationReceipt(JSON.stringify({
    status: "Accepted",
    submissionId: "synthetic-submission",
    submittedSha256: digest,
    publishedArtifact: { name: "plugin.streamDeckPlugin", sha256: digest },
  }), "plugin.streamDeckPlugin", digest);
  assert.throws(() => validateNotarizationReceipt(JSON.stringify({ status: "Invalid" }), "plugin.streamDeckPlugin", digest), /Accepted/);
  assert.throws(() => validateNotarizationReceipt(JSON.stringify({
    status: "Accepted",
    submissionId: "synthetic-submission",
    submittedSha256: "b".repeat(64),
    publishedArtifact: { name: "plugin.streamDeckPlugin", sha256: digest },
  }), "plugin.streamDeckPlugin", digest), /exact published artifact/);
});

test("artifact verification rejects missing and multiple packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-contract-"));
  await mkdir(join(root, "com.barbatdev.ai-usage.sdPlugin"), { recursive: true });
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(join(root, "com.barbatdev.ai-usage.sdPlugin", "manifest.json"), JSON.stringify({ Version: "1.2.3.0" }));
  await assert.rejects(verifyRelease(root, "v1.2.3", true, false), /found 0/);
  const first = Buffer.from("first");
  await writeFile(join(root, "dist", "one.streamDeckPlugin"), first);
  await assert.rejects(verifyRelease(root, "v1.2.3", true, false), /SHA256SUMS/);
  const digest = createHash("sha256").update(first).digest("hex");
  await writeFile(join(root, "dist", "SHA256SUMS"), `${digest}  one.streamDeckPlugin\n`);
  await assert.rejects(verifyRelease(root, "v1.2.3", true, false), /NOTARIZATION\.json/);
  await writeFile(join(root, "dist", "NOTARIZATION.json"), JSON.stringify({
    status: "Accepted",
    submissionId: "synthetic-submission",
    submittedSha256: digest,
    publishedArtifact: { name: "one.streamDeckPlugin", sha256: digest },
  }));
  await verifyRelease(root, "v1.2.3", true, false);
  await writeFile(join(root, "dist", "two.streamDeckPlugin"), "second");
  await assert.rejects(verifyRelease(root, "v1.2.3", true, false), /found 2/);
});
