import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const requiredNames = [
  "APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64",
  "APPLE_APP_STORE_CONNECT_KEY_ID",
  "APPLE_APP_STORE_CONNECT_ISSUER_ID",
];

export function notarizationConfig(environment = process.env) {
  const missing = requiredNames.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`missing required notarization configuration: ${missing.join(", ")}`);
  return {
    apiKeyBase64: environment.APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64,
    keyId: environment.APPLE_APP_STORE_CONNECT_KEY_ID,
    issuerId: environment.APPLE_APP_STORE_CONNECT_ISSUER_ID,
  };
}

function command(executable, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", () => rejectCommand(new Error(`notarization command unavailable: ${executable}`)));
    child.once("close", (status) => resolveCommand({ status, stdout, stderr }));
  });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyZip(run, artifactPath) {
  const result = await run("/usr/bin/unzip", ["-t", artifactPath]);
  if (result.status !== 0) throw new Error("Stream Deck artifact ZIP integrity validation failed");
}

export async function notarizeArtifact({
  artifact,
  environment = process.env,
  temporaryRoot = tmpdir(),
  run = command,
} = {}) {
  if (!artifact || extname(artifact).toLowerCase() !== ".streamdeckplugin") {
    throw new Error("notarization requires the final .streamDeckPlugin artifact");
  }
  const config = notarizationConfig(environment);
  const artifactPath = resolve(artifact);
  await verifyZip(run, artifactPath);
  const artifactSha256 = await sha256(artifactPath);
  const apiKey = Buffer.from(config.apiKeyBase64, "base64");
  if (!apiKey.length) throw new Error("APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64 must decode to an API key");
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, "nan-keychain-notarize-"));
  const submissionPath = join(temporaryDirectory, "plugin.zip");
  const apiKeyPath = join(temporaryDirectory, `notarization-key-${config.keyId}.p8`);
  try {
    await chmod(temporaryDirectory, 0o700);
    await copyFile(artifactPath, submissionPath);
    await chmod(submissionPath, 0o600);
    if (await sha256(submissionPath) !== artifactSha256) throw new Error("notarization copy does not match the final Stream Deck artifact");
    await writeFile(apiKeyPath, apiKey, { mode: 0o600 });
    const result = await run("/usr/bin/xcrun", ["notarytool", "submit", submissionPath, "--key", apiKeyPath, "--key-id", config.keyId, "--issuer", config.issuerId, "--wait", "--output-format", "json"]);
    if (result.status !== 0) throw new Error("notarization command failed");
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error("notarization returned an unreadable response"); }
    if (response.status !== "Accepted") throw new Error(`notarization was not accepted: ${response.status ?? "unknown"}`);
    if (typeof response.id !== "string" || !response.id) throw new Error("notarization Accepted response is missing its submission ID");
    const [submittedSha256, publishedSha256] = await Promise.all([sha256(submissionPath), sha256(artifactPath)]);
    if (submittedSha256 !== artifactSha256 || publishedSha256 !== artifactSha256) {
      throw new Error("final Stream Deck artifact changed while notarization was pending");
    }
    const receipt = {
      status: "Accepted",
      submissionId: response.id,
      submittedSha256,
      publishedArtifact: { name: basename(artifactPath), sha256: publishedSha256 },
    };
    await writeFile(join(dirname(artifactPath), "NOTARIZATION.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    return {
      status: receipt.status,
      submissionId: receipt.submissionId,
      submittedSha256,
      publishedArtifact: artifactPath,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const artifact = process.argv[2];
    if (!artifact) throw new Error("usage: notarize-streamdeck.mjs <final.streamDeckPlugin>");
    await notarizeArtifact({ artifact });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
