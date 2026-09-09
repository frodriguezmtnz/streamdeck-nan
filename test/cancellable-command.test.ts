import assert from "node:assert/strict";
import test from "node:test";
import { hardDeadlineCommand } from "../src/cancellable-command.ts";

test("hard command deadline SIGKILLs and settles without a child callback", async () => {
  const signals: NodeJS.Signals[] = [];
  let resolveLate!: (value: string) => void;
  const command = hardDeadlineCommand(5, (settler) => {
    resolveLate = settler.resolve;
    return { kill: (signal) => { signals.push(signal); return true; } };
  });

  await assert.rejects(command.result, (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "ETIMEDOUT"
  ));
  resolveLate("late");

  assert.deepEqual(signals, ["SIGKILL"]);
  await assert.rejects(command.result);
});

test("hard command cancellation SIGKILLs and settles immediately", async () => {
  const signals: NodeJS.Signals[] = [];
  const command = hardDeadlineCommand<string>(10_000, () => ({
    kill: (signal) => { signals.push(signal); return true; },
  }));

  command.cancel();

  await assert.rejects(command.result, /cancelled/);
  assert.deepEqual(signals, ["SIGKILL"]);
});
