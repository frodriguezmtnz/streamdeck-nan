import assert from "node:assert/strict";
import test from "node:test";
import {
  createSaveSessionResult,
  parseSaveSessionMessage,
  SAVE_SESSION_KIND,
  SAVE_SESSION_MAX_BYTES,
  SAVE_SESSION_RESULT_KIND,
} from "../src/actions/nan-save-session-message.ts";

test("save session parser accepts only an exact correlated bounded paste", () => {
  assert.deepEqual(parseSaveSessionMessage({ kind: SAVE_SESSION_KIND, requestId: "save_1", value: "session=opaque" }), {
    kind: SAVE_SESSION_KIND, requestId: "save_1", value: "session=opaque",
  });
});

test("save session parser rejects malformed, oversized, or control-bearing payloads", () => {
  for (const payload of [
    undefined, null, "nan.saveSession.v1", {}, { kind: SAVE_SESSION_KIND },
    { kind: SAVE_SESSION_KIND, requestId: "save_1" },
    { kind: "other", requestId: "save_1", value: "session=opaque" },
    { kind: SAVE_SESSION_KIND, requestId: "", value: "session=opaque" },
    { kind: SAVE_SESSION_KIND, requestId: "bad id", value: "session=opaque" },
    { kind: SAVE_SESSION_KIND, requestId: "save_1", value: "" },
    { kind: SAVE_SESSION_KIND, requestId: "save_1", value: "x".repeat(SAVE_SESSION_MAX_BYTES + 1) },
    { kind: SAVE_SESSION_KIND, requestId: "save_1", value: "session=\u0000opaque" },
    { kind: SAVE_SESSION_KIND, requestId: "save_1", value: 7 },
    { kind: SAVE_SESSION_KIND, requestId: "save_1", value: "session=opaque", extra: true },
  ]) assert.equal(parseSaveSessionMessage(payload), undefined, JSON.stringify(payload));
});

test("save session parser accepts multi-line cURL pastes", () => {
  const value = "curl 'https://cloud-api.nan.builders' \\\n  -H 'cookie: session=opaque'";
  assert.equal(parseSaveSessionMessage({ kind: SAVE_SESSION_KIND, requestId: "save_1", value })?.value, value);
});

test("save session result carries only the correlated outcome", () => {
  const result = createSaveSessionResult("save_1", "ready");
  assert.deepEqual(result, { kind: SAVE_SESSION_RESULT_KIND, requestId: "save_1", outcome: "ready" });
  assert.deepEqual(Object.keys(result).sort(), ["kind", "outcome", "requestId"]);
});
