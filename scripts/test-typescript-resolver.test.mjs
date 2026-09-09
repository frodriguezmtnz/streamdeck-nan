import assert from "node:assert/strict";
import test from "node:test";
import { typescriptFallback } from "./test-typescript-resolver.mjs";

const sourceParent = new URL("../src/actions/usage-feedback.ts", import.meta.url).href;
const testParent = new URL("../test/action-feedback.test.ts", import.meta.url).href;

test("TypeScript resolver maps existing source candidates for source and test parents", () => {
  assert.match(typescriptFallback("../usage/provider-coordinator.js", sourceParent), /src\/usage\/provider-coordinator\.ts$/);
  assert.match(typescriptFallback("../src/usage/provider.js", testParent), /src\/usage\/provider\.ts$/);
});

test("TypeScript resolver rejects missing, non-JS, and non-source parents", () => {
  assert.equal(typescriptFallback("./missing.js", sourceParent), undefined);
  assert.equal(typescriptFallback("./usage-feedback.json", sourceParent), undefined);
  assert.equal(typescriptFallback("../src/plugin.js", import.meta.url), undefined);
});
