import assert from "node:assert/strict";
import test from "node:test";
import { NanDpapiClient } from "../src/providers/nan/nan-dpapi-client.ts";
import { NanKeychainClient } from "../src/providers/nan/nan-keychain-client.ts";
import { createSessionSecretStore } from "../src/providers/nan/nan-session-secret-store.ts";

test("session secret store selects the macOS Keychain on darwin", () => {
  assert.ok(createSessionSecretStore("darwin") instanceof NanKeychainClient);
});

test("session secret store selects the DPAPI helper on win32", () => {
  assert.ok(createSessionSecretStore("win32") instanceof NanDpapiClient);
});

test("session secret store refuses unsupported platforms", () => {
  assert.throws(() => createSessionSecretStore("linux"), /unavailable on this platform/);
});
