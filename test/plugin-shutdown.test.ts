import assert from "node:assert/strict";
import test from "node:test";
import { installPluginShutdown } from "../src/plugin-shutdown.ts";

test("plugin shutdown waits for asynchronous cleanup before re-raising signals", async () => {
  const runtime = new FakeProcess();
  const stopped = deferred<void>();
  let stopCalls = 0;
  installPluginShutdown({
    stop: () => {
      stopCalls += 1;
      return stopped.promise;
    },
    stopImmediately: () => undefined,
  }, runtime);

  runtime.emit("SIGTERM");
  assert.deepEqual(runtime.exits, []);
  stopped.resolve();
  await waitFor(() => runtime.exits.length === 1);
  assert.equal(stopCalls, 1);
  assert.deepEqual(runtime.exits, [143]);
});

test("plugin shutdown immediately stops before re-raising a signal when graceful cleanup rejects", async () => {
  const events: string[] = [];
  const runtime = new FakeProcess(events);
  const failure = new Error("fixture cleanup failure");
  const cleanup = installPluginShutdown({
    stop: async () => {
      events.push("stop");
      throw failure;
    },
    stopImmediately: () => {
      events.push("stopImmediately");
    },
  }, runtime);

  runtime.emit("SIGTERM");
  await assert.rejects(cleanup(), failure);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, [
    "stop",
    "stopImmediately",
    "off:SIGINT",
    "off:SIGTERM",
    "exit:143",
  ]);
});

test("plugin exit uses only the synchronous final-kill fallback", () => {
  const runtime = new FakeProcess();
  let asyncStops = 0;
  let immediateStops = 0;
  installPluginShutdown({
    stop: async () => {
      asyncStops += 1;
    },
    stopImmediately: () => {
      immediateStops += 1;
    },
  }, runtime);

  runtime.emit("exit");
  assert.equal(asyncStops, 0);
  assert.equal(immediateStops, 1);
});

test("plugin shutdown shares one lifecycle across every provider", async () => {
  const runtime = new FakeProcess();
  const events: string[] = [];
  const target = (name: string) => ({
    stop: async () => { events.push(`stop:${name}`); },
    stopImmediately: () => { events.push(`immediate:${name}`); },
  });
  const cleanup = installPluginShutdown([target("codex"), target("grok")], runtime);

  await cleanup();
  await cleanup();
  assert.deepEqual(events, ["stop:codex", "stop:grok"]);

  runtime.emit("exit");
  assert.deepEqual(events, [
    "stop:codex",
    "stop:grok",
    "immediate:codex",
    "immediate:grok",
  ]);
});

test("plugin shutdown bounds hung cleanup and re-raises the first signal", async () => {
  const runtime = new FakeProcess();
  let immediateStops = 0;
  const cleanup = installPluginShutdown({
    stop: () => new Promise(() => undefined),
    stopImmediately: () => { immediateStops += 1; },
  }, runtime, 5);

  runtime.emit("SIGTERM");
  runtime.emit("SIGINT");
  await assert.rejects(cleanup(), /timed out/);
  await Promise.resolve();

  assert.equal(immediateStops, 1);
  assert.deepEqual(runtime.exits, [143]);
});

test("plugin shutdown latches one terminal signal while cleanup is pending", async () => {
  const runtime = new FakeProcess();
  const stopped = deferred<void>();
  installPluginShutdown({
    stop: () => stopped.promise,
    stopImmediately: () => undefined,
  }, runtime);

  runtime.emit("SIGINT");
  runtime.emit("SIGTERM");
  stopped.resolve();
  await waitFor(() => runtime.exits.length === 1);

  assert.deepEqual(runtime.exits, [130]);
});

class FakeProcess {
  readonly exits: number[] = [];
  private listeners = new Map<string, Set<() => void>>();
  private readonly events?: string[];

  constructor(events?: string[]) {
    this.events = events;
  }

  once(event: string, listener: () => void): void {
    this.listeners.set(event, new Set([listener]));
  }

  off(event: string, listener: () => void): void {
    this.events?.push(`off:${event}`);
    this.listeners.get(event)?.delete(listener);
  }

  exit(code: number): void {
    this.events?.push(`exit:${code}`);
    this.exits.push(code);
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    this.listeners.delete(event);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}
