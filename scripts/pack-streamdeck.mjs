import { spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, rm, stat, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { buildNanDpapi } from "./build-nan-dpapi.mjs";

const pluginName = "com.refactor-ia.nan.sdPlugin";
const streamDeckCli = resolve("node_modules", "@elgato", "cli", "bin", "streamdeck.mjs");
const normalizedTime = new Date("2000-01-01T00:00:00.000Z");

async function requireInstalledStreamDeckCli() {
  try {
    if ((await stat(streamDeckCli)).isFile()) return streamDeckCli;
  } catch {
    // The sanitized error below is the only missing-install detail exposed to callers.
  }
  throw new Error(
    `Stream Deck CLI unavailable: expected repository-local @elgato/cli entry at ${streamDeckCli}. `
      + "Make the isolated copy's installed node_modules available read-only; package-manager execution is disabled.",
  );
}

const installedStreamDeckCli = await requireInstalledStreamDeckCli();
const staging = await mkdtemp(join(tmpdir(), "streamdeck-package-"));

function normalizedFileMode(path, isDirectory) {
  if (isDirectory) return 0o755;
  return path.endsWith("/bin/nan-keychain") ? 0o755 : 0o644;
}

async function normalizePermissions(path) {
  const value = await stat(path);
  await chmod(path, normalizedFileMode(path, value.isDirectory()));
  if (value.isDirectory()) {
    for (const entry of await readdir(path)) await normalizePermissions(join(path, entry));
  }
  await utimes(path, normalizedTime, normalizedTime);
}

function isRuntimeLogPath(path) {
  return path.split(sep).includes("logs") || path.endsWith(".log");
}

async function filesUnder(path, prefix = "") {
  const files = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = join(prefix, entry.name);
    if (isRuntimeLogPath(relativePath)) continue;
    if (entry.isDirectory()) files.push(...await filesUnder(join(path, entry.name), relativePath));
    else files.push(join(pluginName, relativePath));
  }
  return files;
}

try {
  await rm("dist", { recursive: true, force: true });
  await buildNanDpapi();
  const stagedPlugin = join(staging, pluginName);
  await cp(pluginName, stagedPlugin, {
    recursive: true,
    filter: (source) => !isRuntimeLogPath(relative(pluginName, source)),
  });
  await normalizePermissions(stagedPlugin);
  const result = spawnSync(installedStreamDeckCli, ["pack", stagedPlugin, "--force", "--output", "dist", "--no-update-check"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  await normalizePermissions(stagedPlugin);
  const artifact = resolve("dist", "com.refactor-ia.nan.streamDeckPlugin");
  await unlink(artifact);
  const archive = spawnSync("zip", ["-X", "-q", artifact, ...await filesUnder(stagedPlugin)], { cwd: staging, stdio: "inherit" });
  if (archive.status !== 0) process.exit(archive.status ?? 1);
} finally {
  await rm(staging, { recursive: true, force: true });
}
