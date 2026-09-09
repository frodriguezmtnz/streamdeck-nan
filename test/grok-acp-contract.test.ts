import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createGrokBillingRequest,
  createGrokInitializationRequest,
  encodeGrokAcpRequest,
  encodeGrokInitializedNotification,
  GROK_ACP_MAX_REQUEST_FRAME_BYTES,
  GROK_ACP_METHODS,
} from "../src/providers/grok/grok-acp-contract.ts";

test("encodes the protocol initialized notification without an id", () => {
  const frame = encodeGrokInitializedNotification();
  assertSingleLfFrame(frame);
  assert.deepEqual(JSON.parse(frame), { jsonrpc: "2.0", method: "initialized", params: {} });
});

async function readFixture(name: string): Promise<string> {
  const url = new URL(`fixtures/${name}`, import.meta.url);
  return readFile(url, "utf8");
}

function assertSingleLfFrame(frame: string): void {
  assert.equal(frame.includes("\r"), false);
  assert.equal(frame.match(/\n/g)?.length, 1);
  assert.equal(frame.endsWith("\n"), true);
}

test("encodes the fixture-backed ACP initialization frame", async () => {
  const frame = encodeGrokAcpRequest(createGrokInitializationRequest(1));

  assertSingleLfFrame(frame);
  assert.equal(frame, await readFixture("grok-acp-initialize.json"));
});

test("encodes the fixture-backed x.ai/billing request with its extension wire prefix", async () => {
  const frame = encodeGrokAcpRequest(createGrokBillingRequest(2));

  assertSingleLfFrame(frame);
  assert.equal(frame, await readFixture("grok-acp-billing.json"));
  assert.equal(JSON.parse(frame).method, "_x.ai/billing");
  assert.equal(frame.includes('"method":"x.ai/billing"'), false);
});

test("exposes only initialization and billing in the ACP allowlist", () => {
  assert.deepEqual(GROK_ACP_METHODS, ["initialize", "x.ai/billing"]);

  for (const method of [
    "session/new",
    "session/prompt",
    "prompt",
    "infer",
    "auth/read",
    "credentials/read",
  ]) {
    assert.throws(
      () =>
        encodeGrokAcpRequest({
          id: 3,
          method,
          params: {},
        } as never),
      /not allowlisted/,
    );
  }
});

test("rejects invalid request identifiers before framing", () => {
  for (const id of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => encodeGrokAcpRequest(createGrokBillingRequest(id)),
      /Invalid ACP request id/,
    );
  }
});

test("rejects unknown or sensitive fields even on allowlisted methods", () => {
  for (const request of [
    { ...createGrokBillingRequest(4), params: { prompt: "secret" } },
    { ...createGrokBillingRequest(4), params: { apiKey: "secret" } },
    { ...createGrokInitializationRequest(4), params: { ...createGrokInitializationRequest(4).params, token: "secret" } },
    { ...createGrokBillingRequest(4), credentials: "secret" },
  ]) {
    assert.throws(() => encodeGrokAcpRequest(request as never), /Invalid ACP (method params|request fields)/);
  }
});

test("keeps serialized request frames within the conservative byte limit", () => {
  for (const request of [createGrokInitializationRequest(Number.MAX_SAFE_INTEGER), createGrokBillingRequest(Number.MAX_SAFE_INTEGER)]) {
    assert.ok(Buffer.byteLength(encodeGrokAcpRequest(request), "utf8") <= GROK_ACP_MAX_REQUEST_FRAME_BYTES);
  }
});
