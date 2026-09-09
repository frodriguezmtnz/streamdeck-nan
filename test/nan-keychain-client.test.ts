import assert from "node:assert/strict";
import test from "node:test";
import {
  NAN_KEYCHAIN_IMPORT_TIMEOUT_MS,
  NAN_KEYCHAIN_MAX_STDIN_BYTES,
  NAN_KEYCHAIN_TIMEOUT_MS,
  NanKeychainClient,
  resolveNanKeychainHelperPath,
} from "../src/providers/nan/nan-keychain-client.ts";

test("NaN Keychain client uses a fixed absolute helper and stdin-only secret writes", async () => {
  const requests: Array<{ executable: string; args: readonly string[]; stdin: string; timeoutMs: number; maxStdoutBytes: number }> = [];
  const helperPath = resolveNanKeychainHelperPath("file:///Applications/com.barbatdev.ai-usage.sdPlugin/bin/plugin.js");
  const client = new NanKeychainClient(async (request) => {
    requests.push(request);
    return { exitCode: 0, stdout: "{\"ok\":true}\n" };
  }, helperPath);

  await client.putSessionCache("session-secret");
  await client.deleteSessionCache();

  assert.equal(helperPath, "/Applications/com.barbatdev.ai-usage.sdPlugin/bin/nan-keychain");
  assert.equal(requests[0].executable, helperPath);
  assert.deepEqual(requests.map(({ args }) => args), [[], []]);
  assert.deepEqual(requests.map(({ stdin }) => stdin), [
    "{\"operation\":\"put\",\"secret\":\"session-secret\"}\n",
    "{\"operation\":\"delete\"}\n",
  ]);
  assert.equal(requests[0].args.join(" ").includes("session-secret"), false);
  assert.equal(requests[0].timeoutMs, NAN_KEYCHAIN_TIMEOUT_MS);
  await assert.rejects(client.putSessionCache("x".repeat(NAN_KEYCHAIN_MAX_STDIN_BYTES)), /Keychain helper unavailable/);
});

test("NaN Keychain client denies authentication UI for background secret reads", async () => {
  const requests: Array<{ stdin: string }> = [];
  const client = new NanKeychainClient(async (request) => {
    requests.push(request);
    return { exitCode: 0, stdout: "{\"ok\":true,\"secret\":\"value\"}" };
  });

  assert.equal(await client.getSessionCache(), "value");
  assert.equal(await client.getChromeSafeStorage(), "value");
  assert.deepEqual(requests.map(({ stdin }) => stdin), [
    "{\"operation\":\"get\"}\n",
    "{\"operation\":\"getChromeSafeStorage\"}\n",
  ]);
});

test("NaN Keychain client gives only explicit Chrome import a bounded human-response timeout", async () => {
  const requests: Array<{ stdin: string; timeoutMs: number }> = [];
  const client = new NanKeychainClient(async (request) => {
    requests.push(request);
    return { exitCode: 0, stdout: "{\"ok\":true,\"secret\":null}" };
  });

  assert.equal(await client.getSessionCache(), null);
  assert.equal(await client.getChromeSafeStorage(), null);
  assert.deepEqual(requests.map(({ stdin, timeoutMs }) => ({ stdin, timeoutMs })), [
    { stdin: "{\"operation\":\"get\"}\n", timeoutMs: NAN_KEYCHAIN_TIMEOUT_MS },
    { stdin: "{\"operation\":\"getChromeSafeStorage\"}\n", timeoutMs: NAN_KEYCHAIN_IMPORT_TIMEOUT_MS },
  ]);
  assert.equal(NAN_KEYCHAIN_IMPORT_TIMEOUT_MS > NAN_KEYCHAIN_TIMEOUT_MS, true);
});

test("NaN Keychain client fails closed without exposing helper output", async () => {
  const secret = "do-not-leak";
  const client = new NanKeychainClient(async () => ({ exitCode: 1, stdout: `{\"ok\":false,\"error\":\"${secret}\"}` }));
  await assert.rejects(client.getSessionCache(), (error: Error) => error.message === "Keychain helper unavailable" && !error.message.includes(secret));

  const malformed = new NanKeychainClient(async () => ({ exitCode: 0, stdout: "not json" }));
  await assert.rejects(malformed.getSessionCache(), /Keychain helper unavailable/);
});
