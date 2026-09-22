import assert from "node:assert/strict";
import test from "node:test";
import {
  NAN_SESSION_PASTE_MAX_BYTES,
  NAN_SESSION_PASTE_TARGET_DOMAIN,
  parsePastedSession,
} from "../src/providers/nan/nan-session-paste-parser.ts";

const expected = (name: string, value: string) => ({
  name,
  value,
  domain: NAN_SESSION_PASTE_TARGET_DOMAIN,
  hostOnly: true,
  path: "/",
  secure: true,
  expiresAt: null,
});

test("parsePastedSession scopes a raw header to the dashboard host", () => {
  assert.deepEqual(parsePastedSession("session=opaque; api=two"), [expected("session", "opaque"), expected("api", "two")]);
  assert.deepEqual(parsePastedSession("Cookie: session=opaque"), [expected("session", "opaque")]);
  assert.deepEqual(parsePastedSession("  cookie :  session=opaque  "), [expected("session", "opaque")]);
});

test("parsePastedSession extracts the session header from a Copy as cURL command", () => {
  const curl = "curl 'https://cloud-api.nan.builders/api/usage/quota' -H 'accept: application/json' -H 'cookie: session=opaque; api=two'";
  assert.deepEqual(parsePastedSession(curl), [expected("session", "opaque"), expected("api", "two")]);
  assert.deepEqual(parsePastedSession('curl \\\n  --header "Cookie: session=opaque" \\\n  https://cloud-api.nan.builders'), [expected("session", "opaque")]);
});

test("parsePastedSession supports cURL cookie shortcuts", () => {
  assert.deepEqual(parsePastedSession("curl https://cloud-api.nan.builders -b 'session=opaque'"), [expected("session", "opaque")]);
  assert.deepEqual(parsePastedSession('curl https://cloud-api.nan.builders --cookie "session=opaque"'), [expected("session", "opaque")]);
});

test("parsePastedSession keeps the last duplicate and preserves padded values", () => {
  assert.deepEqual(parsePastedSession("session=old; session=new"), [expected("session", "new")]);
  assert.deepEqual(parsePastedSession("token=YWJj=="), [expected("token", "YWJj==")]);
});

test("parsePastedSession fails closed on invalid or empty input", () => {
  for (const input of [
    "",
    "   ",
    "=missing-name",
    "bad;name=value",
    "name=bad\nvalue",
    "name=has space",
    "curl https://cloud-api.nan.builders",
    "session",
  ]) assert.equal(parsePastedSession(input), null, JSON.stringify(input));
});

test("parsePastedSession bounds the cookie count and the pasted size", () => {
  const many = Array.from({ length: 33 }, (_, index) => `c${index}=v`).join("; ");
  assert.equal(parsePastedSession(many), null);
  assert.equal(parsePastedSession("x".repeat(NAN_SESSION_PASTE_MAX_BYTES + 1)), null);
});
