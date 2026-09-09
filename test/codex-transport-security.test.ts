import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnCodexAppServer, codexSafeEnvironment, validateCodexExecutable } from "../src/providers/codex/codex-app-server-transport.ts";
import { validateTrustedClaudeExecutable } from "../src/providers/claude/claude-usage-provider.ts";

test("codexSafeEnvironment excludes secrets", () => {
  const env = codexSafeEnvironment({
    HOME: "/home/user",
    PATH: "/usr/bin",
    NAN_API_KEY: "secret-key",
    NAN_USAGE_READ_TOKEN: "token",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "anthropic-secret",
    XDG_CONFIG_HOME: "/config",
  });
  assert.ok("HOME" in env);
  assert.ok("PATH" in env);
  assert.notEqual(env.PATH, "/usr/bin");
  assert.ok("LANG" in env);
  assert.ok("XDG_CONFIG_HOME" in env);
  assert.ok(!("NAN_API_KEY" in env));
  assert.ok(!("NAN_USAGE_READ_TOKEN" in env));
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});

test("codexSafeEnvironment preserves undefined values", () => {
  const env = codexSafeEnvironment({ HOME: "/home" });
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.ok(!("TMPDIR" in env));
});

test("validateCodexExecutable rejects non-absolute paths", async () => {
  await assert.rejects(
    validateCodexExecutable("codex"),
    /not a trusted executable/,
  );
});

test("validateCodexExecutable rejects non-existent files", async () => {
  await assert.rejects(
    validateCodexExecutable("/nonexistent/path/to/codex"),
    /not a trusted executable/,
  );
});

test("validateCodexExecutable rejects directories", async () => {
  const tmpDir = mkdtempSync(join(homedir(), ".codex-test-"));
  try {
    await assert.rejects(
      validateCodexExecutable(tmpDir),
      /not a trusted executable/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test("validateCodexExecutable accepts a valid executable", async () => {
  const tmpDir = mkdtempSync(join(homedir(), ".codex-test-"));
  try {
    const exePath = join(tmpDir, "fake-codex");
    writeFileSync(exePath, "#!/bin/sh\necho test\n");
    chmodSync(exePath, 0o755);

    const resolved = await validateCodexExecutable(exePath);
    const resolvedTmp = realpathSync(tmpDir);
    assert.ok(resolved.startsWith(resolvedTmp));
    assert.ok(resolved.endsWith("fake-codex"));
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test("validateCodexExecutable rejects non-executable files", async () => {
  const tmpDir = mkdtempSync(join(homedir(), ".codex-test-"));
  try {
    const noExecPath = join(tmpDir, "no-exec");
    writeFileSync(noExecPath, "not executable\n");
    chmodSync(noExecPath, 0o644);

    await assert.rejects(
      validateCodexExecutable(noExecPath),
      /not a trusted executable/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test("validateCodexExecutable rejects unsafe parent permissions", async () => {
  const tmpDir = mkdtempSync(join(homedir(), ".codex-unsafe-parent-"));
  try {
    const executable = join(tmpDir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    chmodSync(tmpDir, 0o777);
    await assert.rejects(validateCodexExecutable(executable), /not a trusted executable/);
  } finally {
    chmodSync(tmpDir, 0o700);
    rmSync(tmpDir, { recursive: true });
  }
});

test("spawn uses the canonical validated executable and never PATH lookup", async () => {
  let command;
  const child = new (await import("node:events")).EventEmitter();
  Object.assign(child, {
    stdin: new (await import("node:stream")).PassThrough(),
    stdout: new (await import("node:stream")).PassThrough(),
    stderr: new (await import("node:stream")).PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const creation = spawnCodexAppServer({
    executableCandidates: ["/candidate/codex"],
    resolveExecutable: async (candidate) => ({ candidate, executable: "/canonical/codex", dev: 1, ino: 2 }),
    validateExecutable: async () => true,
    spawnProcess: ((executable) => {
      command = executable;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as never,
  });
  await creation;
  assert.equal(command, "/canonical/codex");
});

test("spawn aborts when executable identity changes before spawn", async () => {
  let spawned = false;
  await assert.rejects(spawnCodexAppServer({
    executableCandidates: ["/candidate/codex"],
    resolveExecutable: async (candidate) => ({ candidate, executable: "/canonical/codex", dev: 1, ino: 2 }),
    validateExecutable: async () => false,
    spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as never,
  }), /unavailable/);
  assert.equal(spawned, false);
});

test("spawn aborts when a candidate symlink is replaced before validation", async () => {
  const tmpDir = mkdtempSync(join(homedir(), ".codex-symlink-"));
  try {
    const first = join(tmpDir, "codex-a");
    const second = join(tmpDir, "codex-b");
    const candidate = join(tmpDir, "codex");
    writeFileSync(first, "#!/bin/sh\nexit 0\n");
    writeFileSync(second, "#!/bin/sh\nexit 0\n");
    chmodSync(first, 0o755);
    chmodSync(second, 0o755);
    symlinkSync(first, candidate);
    let spawned = false;
    await assert.rejects(spawnCodexAppServer({
      codexPath: candidate,
      validateExecutable: async (identity) => {
        unlinkSync(candidate);
        symlinkSync(second, candidate);
        return validateTrustedClaudeExecutable(identity);
      },
      spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as never,
    }), /unavailable/);
    assert.equal(spawned, false);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test("spawn rejects non-existent codexPath", async () => {
  const creation = spawnCodexAppServer({ codexPath: "/nonexistent/path/to/codex" });
  await assert.rejects(
    creation,
    /executable-not-found|unavailable/,
  );
});
