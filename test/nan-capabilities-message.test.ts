import assert from "node:assert/strict";
import test from "node:test";
import {
  createNanCapabilitiesResult,
  NAN_CAPABILITIES_KIND,
  NAN_CAPABILITIES_RESULT_KIND,
  nanCapabilities,
  parseNanCapabilitiesMessage,
} from "../src/actions/nan-capabilities-message.ts";

test("capabilities reflect macOS Chrome import and Windows paste", () => {
  assert.deepEqual(nanCapabilities("darwin"), { platform: "darwin", chromeImport: true, pasteSession: false });
  assert.deepEqual(nanCapabilities("win32"), { platform: "win32", chromeImport: false, pasteSession: true });
});

test("capabilities parser accepts only an exact correlated probe", () => {
  assert.deepEqual(parseNanCapabilitiesMessage({ kind: NAN_CAPABILITIES_KIND, requestId: "caps_1" }), { requestId: "caps_1" });
  for (const payload of [
    undefined, null, "nan.capabilities.v1", {}, { kind: NAN_CAPABILITIES_KIND },
    { kind: "other", requestId: "caps_1" }, { kind: NAN_CAPABILITIES_KIND, requestId: "" },
    { kind: NAN_CAPABILITIES_KIND, requestId: "bad id" }, { kind: NAN_CAPABILITIES_KIND, requestId: "caps_1", extra: true },
  ]) assert.equal(parseNanCapabilitiesMessage(payload), undefined, JSON.stringify(payload));
});

test("capabilities result carries only the allowlisted fields", () => {
  const result = createNanCapabilitiesResult("caps_1", nanCapabilities("win32"));
  assert.deepEqual(result, { kind: NAN_CAPABILITIES_RESULT_KIND, requestId: "caps_1", platform: "win32", chromeImport: false, pasteSession: true });
  assert.deepEqual(Object.keys(result).sort(), ["chromeImport", "kind", "pasteSession", "platform", "requestId"]);
});
