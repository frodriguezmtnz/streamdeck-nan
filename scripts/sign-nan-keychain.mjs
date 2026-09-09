import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const requiredNames = [
  "APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64",
  "APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD",
  "APPLE_DEVELOPER_ID_APPLICATION_IDENTITY",
  "APPLE_DEVELOPER_ID_TEAM_ID",
];

export function signingConfig(environment = process.env) {
  const missing = requiredNames.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`missing required signing configuration: ${missing.join(", ")}`);
  return {
    p12Base64: environment.APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64,
    p12Password: environment.APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD,
    identity: environment.APPLE_DEVELOPER_ID_APPLICATION_IDENTITY,
    teamId: environment.APPLE_DEVELOPER_ID_TEAM_ID,
  };
}

function command(executable, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", () => rejectCommand(new Error(`signing command unavailable: ${executable}`)));
    child.once("close", (status) => resolveCommand({ status, stdout, stderr }));
  });
}

async function runChecked(run, executable, args) {
  const result = await run(executable, args);
  if (result.status !== 0) throw new Error(`signing command failed: ${executable}`);
  return result;
}

export async function signNanKeychain({
  helperPath = resolve("com.barbatdev.ai-usage.sdPlugin/bin/nan-keychain"),
  environment = process.env,
  temporaryRoot = tmpdir(),
  run = command,
} = {}) {
  const config = signingConfig(environment);
  const p12 = Buffer.from(config.p12Base64, "base64");
  if (!p12.length) throw new Error("APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64 must decode to a PKCS#12 file");
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, "nan-keychain-sign-"));
  const keychainPassword = randomBytes(32).toString("base64");
  const p12Path = join(temporaryDirectory, "developer-id-application.p12");
  const keychainPath = join(temporaryDirectory, "signing.keychain-db");
  let keychainCreated = false;
  try {
    await chmod(temporaryDirectory, 0o700);
    await writeFile(p12Path, p12, { mode: 0o600 });
    await runChecked(run, "/usr/bin/security", ["create-keychain", "-p", keychainPassword, keychainPath]);
    keychainCreated = true;
    await runChecked(run, "/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
    await runChecked(run, "/usr/bin/security", ["unlock-keychain", "-p", keychainPassword, keychainPath]);
    await runChecked(run, "/usr/bin/security", ["import", p12Path, "-k", keychainPath, "-P", config.p12Password, "-T", "/usr/bin/codesign"]);
    await runChecked(run, "/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainPath]);
    await runChecked(run, "/usr/bin/codesign", ["--force", "--sign", config.identity, "--keychain", keychainPath, "--options", "runtime", "--timestamp", helperPath]);
    await runChecked(run, "/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", helperPath]);
    await runChecked(run, "/usr/bin/lipo", ["-verify_arch", "arm64", "x86_64", helperPath]);
    const details = await runChecked(run, "/usr/bin/codesign", ["-dv", "--verbose=4", helperPath]);
    const signatureDetails = `${details.stdout}\n${details.stderr}`;
    if (!signatureDetails.includes(`Authority=${config.identity}`)) throw new Error("signature does not match the configured Developer ID identity");
    if (!signatureDetails.includes(`TeamIdentifier=${config.teamId}`)) throw new Error("signature does not match the configured Apple team");
    return { identity: config.identity, teamId: config.teamId };
  } finally {
    if (keychainCreated) {
      try { await run("/usr/bin/security", ["delete-keychain", keychainPath]); } catch {}
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await signNanKeychain();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
