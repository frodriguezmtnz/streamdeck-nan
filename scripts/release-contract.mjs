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

async function validateReleaseVersions(root, tag) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "com.barbatdev.ai-usage.sdPlugin", "manifest.json"), "utf8"));
  validateVersions(tag, packageJson.version, manifest.Version);
}

async function validateReleaseArtifact(root) {
  const dist = join(root, "dist");
  const artifacts = (await readdir(dist)).filter((name) => name.endsWith(".streamDeckPlugin"));
  if (artifacts.length !== 1) throw new Error(`expected exactly one .streamDeckPlugin artifact, found ${artifacts.length}`);
  const artifactName = basename(artifacts[0]);
  const artifactPath = join(dist, artifactName);
  const bytes = await readFile(artifactPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  validateChecksum(await readFile(join(dist, "SHA256SUMS"), "utf8"), artifactName, digest);
  scanReleaseArtifact(artifactPath);
}

export async function verifyRelease(root, tag) {
  await validateReleaseVersions(root, tag);
  await validateReleaseArtifact(root);
}

export const verifyUnsignedCiArtifacts = verifyRelease;

export function parseVerificationMode(mode) {
  switch (mode) {
    case undefined:
    case "artifacts":
    case "unsigned-ci":
      return { artifacts: true };
    case "versions":
      return { artifacts: false };
    default:
      throw new Error(`unknown verification mode: ${mode}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [tag, mode] = process.argv.slice(2);
  if (!tag) throw new Error("usage: release-contract.mjs <vX.Y.Z> [versions|unsigned-ci]");
  const verification = parseVerificationMode(mode);
  if (!verification.artifacts) {
    await validateReleaseVersions(process.cwd(), tag);
  } else {
    await verifyRelease(process.cwd(), tag);
  }
}
