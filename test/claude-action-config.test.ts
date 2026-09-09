import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_COORDINATOR_OPTIONS } from "../src/providers/claude/claude-coordinator-options.ts";

test("Claude coordinator uses bounded success caching and failure cooldown", () => {
  assert.deepEqual(CLAUDE_COORDINATOR_OPTIONS, {
    cacheTtlMs: 30_000,
    failureCooldownMs: 120_000,
    forcedRefreshThrottleMs: 5_000,
  });
});
