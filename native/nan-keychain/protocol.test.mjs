import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../../com.refactor-ia.nan.sdPlugin/bin/nan-keychain", import.meta.url));

function rejectedWithoutKeychain(request) {
  const result = spawnSync(helper, [], { input: Buffer.from(`${JSON.stringify(request)}\n`, "utf8"), stdio: ["pipe", "pipe", "ignore"] });
  assert.equal(result.status, 1);
  assert.equal(isUtf8(result.stdout), true);
  assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), { ok: false, error: "unavailable" });
}

test("offline Keychain policy uses injected statuses and never prompts background operations", { skip: process.platform !== "darwin" }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nan-keychain-policy-"));
  try {
    const result = spawnSync("/usr/bin/xcrun", ["swiftc", "native/nan-keychain/KeychainAccess.swift", "native/nan-keychain/KeychainAccess.test.swift", "-o", join(temporaryDirectory, "policy-test")], { encoding: "utf8", stdio: "ignore" });
    assert.equal(result.status, 0);
    assert.equal(spawnSync(join(temporaryDirectory, "policy-test"), [], { stdio: "ignore" }).status, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("helper rejects arbitrary selectors before a Keychain operation", { skip: process.platform !== "darwin" || !existsSync(helper) }, () => {
  rejectedWithoutKeychain({ operation: "security", service: "any-service", account: "any-account" });
});

test("helper rejects secret-bearing read requests before a Keychain operation", { skip: process.platform !== "darwin" || !existsSync(helper) }, () => {
  rejectedWithoutKeychain({ operation: "get", secret: "forbidden" });
  rejectedWithoutKeychain({ operation: "getChromeSafeStorage", secret: "forbidden" });
});
