import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ChildProcessTransport,
  spawnCodexAppServer,
} from "../src/providers/codex/codex-app-server-transport.ts";

test("spawns Codex app-server without a shell", async () => {
  const child = new FakeChild();
  let call: { command: string; args: string[]; options: unknown } | undefined;
  const creation = spawnCodexAppServer({
    resolveExecutable: async (candidate) => ({ candidate, executable: "/trusted/codex", dev: 1, ino: 2 }),
    validateExecutable: async () => true,
    spawnProcess: ((command, args, options) => {
      call = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    }) as never,
  });

  await creation;

  assert.ok("shell" in call!.options);
  assert.ok("stdio" in call!.options);
  assert.ok("env" in call!.options);
  assert.equal((call!.options as { shell: boolean }).shell, false);
});

test("uses immediate kill when creation fails before spawn", async () => {
  const child = new FakeChild();
  const creation = spawnCodexAppServer({
    resolveExecutable: async (candidate) => ({ candidate, executable: "/trusted/codex", dev: 1, ino: 2 }),
    validateExecutable: async () => true,
    spawnProcess: (() => {
      queueMicrotask(() => child.emit("error", new Error("missing")));
      return child;
    }) as never,
  });

  await assert.rejects(creation);
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("does not expose child or stdin errors after a listener is removed", () => {
  const child = new FakeChild();
  const transport = new ChildProcessTransport(child as never);
  const remove = transport.onExit(() => undefined);
  remove();

  assert.doesNotThrow(() => child.emit("error", new Error("child error")));
  assert.doesNotThrow(() => child.stdin.emit("error", new Error("stdin error")));
});

test("rejects an unconfirmed graceful stop and remains immediately killable", async () => {
  const child = new FakeChild();
  const transport = new ChildProcessTransport(child as never, {
    stopGraceMs: 1,
    killConfirmationMs: 1,
  });

  await assert.rejects(transport.stop());
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(transport.stopImmediately(), true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL", "SIGKILL"]);
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}
