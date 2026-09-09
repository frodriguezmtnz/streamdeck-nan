import assert from "node:assert/strict";
import test from "node:test";
import { TransitioningProviderStatusReporter } from "../src/usage/provider-status-reporter.ts";

test("provider status logging emits sanitized transitions without repeated spam", () => {
  const messages: string[] = [];
  const reporter = new TransitioningProviderStatusReporter((message) => messages.push(message));

  reporter.failure("codex", "executable-not-found");
  reporter.failure("codex", "executable-not-found");
  reporter.failure("codex", "timeout");
  reporter.success("codex");
  reporter.failure("codex", "timeout");
  reporter.failure("Bearer secret-token" as never, "https://private.invalid/token" as never);

  assert.deepEqual(messages, [
    "provider=codex state=executable-not-found",
    "provider=codex state=timeout",
    "provider=codex state=timeout",
    "provider=unknown state=unavailable",
  ]);
  assert.equal(messages.join("\n").includes("secret-token"), false);
  assert.equal(messages.join("\n").includes("private.invalid"), false);
});
