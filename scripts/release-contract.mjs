import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { scanReleaseArtifact } from "./scan-secrets.mjs";

export function validateVersions(tag, packageVersion, manifestVersion) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error("release tag must use strict vX.Y.Z format");
  const version = match.slice(1).join(".");
  if (packageVersion !== version) throw new Error(`package version ${packageVersion} does not match tag ${tag}`);
  if (manifestVersion !== `${version}.0`) throw new Error(`manifest version ${manifestVersion} does not match ${version}.0`);
}

export function validateChecksum(content, artifactName, expectedDigest) {
  const lines = content.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error("checksum file must contain exactly one entry");
  const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(lines[0]);
  if (!match) throw new Error("checksum must contain a lowercase SHA-256 digest and basename only");
  if (match[2] !== artifactName || match[1] !== expectedDigest) throw new Error("checksum name or digest does not match the release artifact");
}

export function validateNotarizationReceipt(content, artifactName, expectedDigest) {
  let receipt;
  try { receipt = JSON.parse(content); } catch { throw new Error("NOTARIZATION.json must contain valid JSON"); }
  if (receipt.status !== "Accepted") throw new Error("NOTARIZATION.json must record an Accepted result");
  if (typeof receipt.submissionId !== "string" || !receipt.submissionId) throw new Error("NOTARIZATION.json must record the Apple submission ID");
  const exactArtifact = receipt.publishedArtifact?.name === artifactName && receipt.publishedArtifact.sha256 === expectedDigest;
  if (receipt.submittedSha256 !== expectedDigest || !exactArtifact) {
    throw new Error("NOTARIZATION.json must bind Accepted status to the exact published artifact");
  }
}

export async function verifyRelease(root, tag, verifyArtifact = true, scanArtifact = true) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "com.barbatdev.ai-usage.sdPlugin", "manifest.json"), "utf8"));
  validateVersions(tag, packageJson.version, manifest.Version);
  if (!verifyArtifact) return;
  const dist = join(root, "dist");
  const artifacts = (await readdir(dist)).filter((name) => name.endsWith(".streamDeckPlugin"));
  if (artifacts.length !== 1) throw new Error(`expected exactly one .streamDeckPlugin artifact, found ${artifacts.length}`);
  const bytes = await readFile(join(dist, artifacts[0]));
  const digest = createHash("sha256").update(bytes).digest("hex");
  validateChecksum(await readFile(join(dist, "SHA256SUMS"), "utf8"), basename(artifacts[0]), digest);
  validateNotarizationReceipt(await readFile(join(dist, "NOTARIZATION.json"), "utf8"), basename(artifacts[0]), digest);
  if (scanArtifact) scanReleaseArtifact(join(dist, artifacts[0]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [tag, mode = "artifacts"] = process.argv.slice(2);
  if (!tag) throw new Error("usage: release-contract.mjs <vX.Y.Z> [versions]");
  await verifyRelease(process.cwd(), tag, mode !== "versions");
}
