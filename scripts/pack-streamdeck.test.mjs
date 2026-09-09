import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "com.barbatdev.ai-usage.sdPlugin";

async function makeFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "streamdeck-pack-test-"));
  const plugin = join(fixture, pluginName);
  const bin = join(fixture, "bin");
  const cli = join(fixture, "node_modules", "@elgato", "cli", "bin", "streamdeck.mjs");
  const record = join(fixture, "record.json");

  await mkdir(join(plugin, "assets"), { recursive: true });
  await mkdir(join(plugin, "bin"), { recursive: true });
  await mkdir(join(plugin, "logs"), { recursive: true });
  await mkdir(join(plugin, "nested"), { recursive: true });
  await mkdir(join(fixture, "directory-fixture", "node_modules"), { recursive: true });
  await mkdir(join(fixture, "dependency-target"), { recursive: true });
  await writeFile(join(plugin, "manifest.json"), "{}");
  await writeFile(join(plugin, "assets", "icon.png"), "icon");
  await writeFile(join(plugin, "bin", "nan-keychain"), "helper");
  await chmod(join(plugin, "bin", "nan-keychain"), 0o755);
  await writeFile(join(plugin, "logs", "input.log"), "synthetic input log");
  await writeFile(join(plugin, "logs", "retained.txt"), "synthetic runtime data");
  await writeFile(join(plugin, "nested", "debug.log"), "synthetic nested log");
  await writeFile(join(plugin, "top.log"), "synthetic top-level log");
  await symlink(join(fixture, "dependency-target"), join(fixture, "symlink-fixture", "node_modules"), "dir").catch(async () => {
    await mkdir(join(fixture, "symlink-fixture"), { recursive: true });
    await symlink(join(fixture, "dependency-target"), join(fixture, "symlink-fixture", "node_modules"), "dir");
  });
  await writeFile(join(fixture, ".gitignore"), await readFile(join(repositoryRoot, ".gitignore")));

  await mkdir(bin, { recursive: true });
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const stage = process.argv[process.argv.indexOf("pack") + 1];
const recordPath = process.env.PACK_TEST_RECORD;
const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : {};
record.streamdeckCli = {
  entry: fileURLToPath(import.meta.url),
  sourceLogsDirectoryPresent: existsSync(join(stage, "logs")),
  sourceTopLevelLogPresent: existsSync(join(stage, "top.log")),
  helperMode: statSync(join(stage, "bin", "nan-keychain")).mode & 0o777,
  arguments: process.argv.slice(2),
};
mkdirSync(join(stage, "logs"), { recursive: true });
writeFileSync(join(stage, "logs", "tool.log"), "packaging tool log");
writeFileSync(join(stage, "pack.log"), "packaging tool log");
mkdirSync("dist", { recursive: true });
writeFileSync(join("dist", "com.barbatdev.ai-usage.streamDeckPlugin"), "intermediate");
writeFileSync(recordPath, JSON.stringify(record));
`);
  for (const packageManager of ["pnpm", "npm", "npx"]) {
    await writeFile(join(bin, packageManager), `#!/bin/sh
echo "${packageManager}" > "$PACK_TEST_POISON"
exit 97
`);
    await chmod(join(bin, packageManager), 0o755);
  }
  await writeFile(join(bin, "zip"), `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const recordPath = process.env.PACK_TEST_RECORD;
const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : {};
record.zip = { cwd: process.cwd(), files: args.slice(3) };
writeFileSync(args[2], "archive");
writeFileSync(recordPath, JSON.stringify(record));
`);
  await chmod(cli, 0o755);
  await chmod(join(bin, "zip"), 0o755);

  return { fixture, bin, cli, plugin, record };
}

test("gitignore declares generic dependency ignores without repository initialization", async () => {
  const ignore = await readFile(join(repositoryRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^node_modules$/m);
});

test("packaging invokes the repository-local installed CLI and excludes runtime logs", async (t) => {
  const { fixture, bin, cli, plugin, record } = await makeFixture();
  const poison = join(fixture, "package-manager-invoked");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "pack-streamdeck.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PACK_TEST_RECORD: record, PACK_TEST_POISON: poison, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);

  const captured = JSON.parse(await readFile(record, "utf8"));
  assert.deepEqual(
    {
      streamdeckCli: captured.streamdeckCli,
      packageManagerInvoked: existsSync(poison),
      archiveFiles: captured.zip.files,
      stagingRemoved: !existsSync(captured.zip.cwd),
      sourceLogsRetained: existsSync(join(plugin, "logs", "input.log")),
    },
    {
      streamdeckCli: {
        entry: await realpath(cli),
        sourceLogsDirectoryPresent: false,
        sourceTopLevelLogPresent: false,
        helperMode: 0o755,
        arguments: ["pack", captured.streamdeckCli.arguments[1], "--force", "--output", "dist", "--no-update-check"],
      },
      packageManagerInvoked: false,
      archiveFiles: [
        `${pluginName}/assets/icon.png`,
        `${pluginName}/bin/nan-keychain`,
        `${pluginName}/manifest.json`,
      ],
      stagingRemoved: true,
      sourceLogsRetained: true,
    },
  );
  assert.deepEqual(captured.streamdeckCli.arguments.slice(0, 1).concat(captured.streamdeckCli.arguments.slice(2)), ["pack", "--force", "--output", "dist", "--no-update-check"]);
  assert.match(captured.streamdeckCli.arguments[1], new RegExp(`${pluginName.replace(".", "\\.")}$`));
  assert.equal(existsSync(cli), true);
});

test("packaging fails closed when the repository-local CLI is unavailable without invoking a package manager", async (t) => {
  const { fixture, bin, cli, record } = await makeFixture();
  const poison = join(fixture, "package-manager-invoked");
  const preservedDistFile = join(fixture, "dist", "preserved-before-cli-validation");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await rm(cli);
  await mkdir(dirname(preservedDistFile), { recursive: true });
  await writeFile(preservedDistFile, "preserved");

  const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "pack-streamdeck.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PACK_TEST_RECORD: record, PACK_TEST_POISON: poison, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stream Deck CLI unavailable/);
  assert.equal(existsSync(poison), false);
  assert.equal(await readFile(preservedDistFile, "utf8"), "preserved");
});
