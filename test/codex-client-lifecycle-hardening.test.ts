import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/providers/codex/codex-app-server-client.ts";
import type { CodexAppServerTransport } from "../src/providers/codex/codex-app-server-transport.ts";

test("codex-client-lifecycle-hardening classifies a missing CLI", async () => {
  const client = new CodexAppServerClient({
    createTransport: async () => {
      throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    },
  });

  await assert.rejects(client.readRateLimits(), (error: unknown) => hasCode(error, "executable-not-found"));
});

test("codex-client-lifecycle-hardening sanitizes malformed JSON frames", async () => {
  const transport = new FakeTransport();
  const client = new CodexAppServerClient({ createTransport: async () => transport });
  const pending = client.readRateLimits();
  await transport.waitFor("initialize");
  transport.emit("not-json fixture-secret\n");

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof Error && error.message.includes("fixture-secret"), false);
    return hasCode(error, "invalid-response");
  });
  assert.equal(transport.stopped, true);
});

test("codex-client-lifecycle-hardening restarts after initialization timeout", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  let starts = 0;
  const client = new CodexAppServerClient({
    createTransport: async () => (++starts === 1 ? first : second),
    timeoutMs: 5,
  });

  await assert.rejects(client.readRateLimits(), (error: unknown) => hasCode(error, "timeout"));
  assert.equal(first.stopped, true);
  await respondToRateLimits(client, second, { recovered: "initialization" });
  assert.equal(starts, 2);
});

test("codex-client-lifecycle-hardening restarts after post-handshake timeout", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  let starts = 0;
  const client = new CodexAppServerClient({
    createTransport: async () => (++starts === 1 ? first : second),
    timeoutMs: 5,
  });
  const timedOut = client.readRateLimits();
  await first.waitFor("initialize");
  first.respondTo("initialize", {});
  await first.waitFor("account/rateLimits/read");

  await assert.rejects(timedOut, (error: unknown) => hasCode(error, "timeout"));
  assert.equal(first.stopped, true);
  await respondToRateLimits(client, second, { recovered: "request" });
  assert.equal(starts, 2);
});

test("codex-client-lifecycle-hardening recovers from write EPIPE", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  let starts = 0;
  const client = new CodexAppServerClient({ createTransport: async () => (++starts === 1 ? first : second) });
  first.failWritesFor = "account/rateLimits/read";
  const failed = client.readRateLimits();
  await first.waitFor("initialize");
  first.respondTo("initialize", {});

  await assert.rejects(failed, (error: unknown) => hasCode(error, "unavailable"));
  assert.equal(first.stopped, true);
  await respondToRateLimits(client, second, { recovered: "write" });
});

test("codex-client-lifecycle-hardening retires EPIPE exits before restart", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  let starts = 0;
  const client = new CodexAppServerClient({ createTransport: async () => (++starts === 1 ? first : second) });
  const interrupted = client.readRateLimits();
  await first.waitFor("initialize");
  first.respondTo("initialize", {});
  await first.waitFor("account/rateLimits/read");
  first.exit(Object.assign(new Error("fixture-secret"), { code: "EPIPE" }));

  await assert.rejects(interrupted, (error: unknown) => {
    assert.equal(error instanceof Error && error.message.includes("fixture-secret"), false);
    return hasCode(error, "unavailable");
  });
  assert.equal(first.stopCalls, 1);
  await respondToRateLimits(client, second, { recovered: "exit" });
});

test("codex-client-lifecycle-hardening serializes retirement before replacement", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  const retirement = deferred<void>();
  first.stopBarrier = retirement.promise;
  let starts = 0;
  const client = new CodexAppServerClient({
    createTransport: async () => (++starts === 1 ? first : second),
    timeoutMs: 5,
  });
  const timedOut = client.readRateLimits();
  await first.waitFor("initialize");
  first.respondTo("initialize", {});
  await first.waitFor("account/rateLimits/read");
  await assert.rejects(timedOut, (error: unknown) => hasCode(error, "timeout"));

  const recovered = client.readRateLimits();
  await Promise.resolve();
  assert.equal(starts, 1);
  retirement.resolve();
  await second.waitFor("initialize");
  second.respondTo("initialize", {});
  await second.waitFor("account/rateLimits/read");
  second.respondTo("account/rateLimits/read", { recovered: "serialized" });
  assert.deepEqual(await recovered, { recovered: "serialized" });
});

test("codex-client-lifecycle-hardening wake recovery bypasses stuck retirement", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  const retirement = deferred<void>();
  first.stopBarrier = retirement.promise;
  let starts = 0;
  const client = new CodexAppServerClient({
    createTransport: async () => (++starts === 1 ? first : second),
    timeoutMs: 5,
  });
  const timedOut = client.readRateLimits();
  await first.waitFor("initialize");
  first.respondTo("initialize", {});
  await first.waitFor("account/rateLimits/read");
  await assert.rejects(timedOut, (error: unknown) => hasCode(error, "timeout"));

  client.recoverAfterWake();
  await respondToRateLimits(client, second, { recovered: "wake" });
  assert.equal(starts, 2);
  assert.equal(first.stoppedImmediately, false);
  retirement.resolve();
});

test("codex-client-lifecycle-hardening quarantines failed retirements until confirmed exit", async () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  first.stopError = new Error("unconfirmed");
  let starts = 0;
  const client = new CodexAppServerClient({
    createTransport: async () => (++starts === 1 ? first : second),
    maxRetiringTransports: 1,
  });
  await respondToRateLimits(client, first, { first: true });

  client.recoverAfterWake();
  await Promise.resolve();
  await Promise.resolve();
  client.recoverAfterWake();
  assert.equal(first.stopCalls, 1);
  assert.equal(first.immediateStopCalls, 0);
  await assert.rejects(client.readRateLimits(), (error: unknown) => hasCode(error, "unavailable"));
  assert.equal(starts, 1);

  first.exit();
  await respondToRateLimits(client, second, { recovered: "confirmed-exit" });
  assert.equal(starts, 2);
});

test("codex-client-lifecycle-hardening wake recovery replaces pending creation", async () => {
  const creation = deferred<FakeTransport>();
  const replacement = new FakeTransport();
  let starts = 0;
  const client = new CodexAppServerClient({
    createTransport: () => ++starts === 1 ? creation.promise : Promise.resolve(replacement),
    timeoutMs: 50,
  });
  const obsolete = client.readRateLimits();
  await Promise.resolve();

  client.recoverAfterWake();
  await respondToRateLimits(client, replacement, { recovered: "creation" });
  const delayed = new FakeTransport();
  creation.resolve(delayed);
  await assert.rejects(obsolete, (error: unknown) => hasCode(error, "unavailable"));
  assert.equal(delayed.stoppedImmediately, true);
});

test("codex-client-lifecycle-hardening stop rejects pending work and pending creation", async () => {
  const active = new FakeTransport();
  const activeClient = new CodexAppServerClient({ createTransport: async () => active });
  const activeRequest = activeClient.readRateLimits();
  await active.waitFor("initialize");
  await activeClient.stop();
  await assert.rejects(activeRequest, (error: unknown) => hasCode(error, "stopped"));
  assert.equal(active.stopped, true);

  const created = deferred<FakeTransport>();
  const pendingClient = new CodexAppServerClient({ createTransport: () => created.promise });
  const pendingRequest = pendingClient.readRateLimits();
  await Promise.resolve();
  const stopping = pendingClient.stop();
  const delayed = new FakeTransport();
  created.resolve(delayed);
  await stopping;
  await assert.rejects(pendingRequest, (error: unknown) => hasCode(error, "stopped"));
  assert.equal(delayed.stopped, true);
});

test("codex-client-lifecycle-hardening immediately stops retiring and pending creation transports", async () => {
  const retiring = new FakeTransport();
  const barrier = deferred<void>();
  retiring.stopBarrier = barrier.promise;
  const client = new CodexAppServerClient({ createTransport: async () => retiring, timeoutMs: 5 });
  const timedOut = client.readRateLimits();
  await retiring.waitFor("initialize");
  retiring.respondTo("initialize", {});
  await retiring.waitFor("account/rateLimits/read");
  await assert.rejects(timedOut, (error: unknown) => hasCode(error, "timeout"));
  client.stopImmediately();
  assert.equal(retiring.stoppedImmediately, true);
  barrier.resolve();
  await client.stop();

  const created = deferred<FakeTransport>();
  const pendingClient = new CodexAppServerClient({ createTransport: () => created.promise });
  const pending = pendingClient.readRateLimits();
  await Promise.resolve();
  pendingClient.stopImmediately();
  const delayed = new FakeTransport();
  created.resolve(delayed);
  await assert.rejects(pending, (error: unknown) => hasCode(error, "stopped"));
  assert.equal(delayed.stoppedImmediately, true);
});

test("codex-client-lifecycle-hardening keeps unconfirmed retirement reachable for immediate stop", async () => {
  const transport = new FakeTransport();
  transport.stopError = new Error("fixture-secret");
  transport.immediateStopSucceeds = false;
  const client = new CodexAppServerClient({ createTransport: async () => transport, timeoutMs: 5 });
  const timedOut = client.readRateLimits();
  await transport.waitFor("initialize");
  transport.respondTo("initialize", {});
  await transport.waitFor("account/rateLimits/read");
  await assert.rejects(timedOut, (error: unknown) => hasCode(error, "timeout"));
  await assert.rejects(client.readRateLimits(), (error: unknown) => hasCode(error, "unavailable"));

  client.stopImmediately();
  assert.equal(transport.immediateStopCalls, 1);
  transport.immediateStopSucceeds = true;
  client.stopImmediately();
  assert.equal(transport.stoppedImmediately, true);
  assert.equal(transport.immediateStopCalls, 2);
});

test("codex-client-lifecycle-hardening quarantines active transport before final immediate stop", async () => {
  const transport = new FakeTransport();
  transport.immediateStopSucceeds = false;
  const client = new CodexAppServerClient({ createTransport: async () => transport });
  await respondToRateLimits(client, transport, { active: true });

  client.stopImmediately();
  assert.equal(transport.immediateStopCalls, 1);
  transport.immediateStopSucceeds = true;
  client.stopImmediately();
  assert.equal(transport.immediateStopCalls, 2);
  assert.equal(transport.stoppedImmediately, true);

  transport.exit();
  client.stopImmediately();
  assert.equal(transport.immediateStopCalls, 2);
});

async function respondToRateLimits(
  client: CodexAppServerClient,
  transport: FakeTransport,
  result: unknown,
): Promise<void> {
  const request = client.readRateLimits();
  await transport.waitFor("initialize");
  transport.respondTo("initialize", {});
  await transport.waitFor("account/rateLimits/read");
  transport.respondTo("account/rateLimits/read", result);
  assert.deepEqual(await request, result);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

class FakeTransport implements CodexAppServerTransport {
  readonly writes: string[] = [];
  stopped = false;
  stoppedImmediately = false;
  stopCalls = 0;
  immediateStopCalls = 0;
  immediateStopSucceeds = true;
  stopBarrier?: Promise<void>;
  stopError?: Error;
  failWritesFor?: string;
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(error?: unknown) => void>();
  private confirmedExitListeners = new Set<() => void>();
  private exited = false;

  write(frame: string): void {
    const method = (JSON.parse(frame) as { method: string }).method;
    if (method === this.failWritesFor) throw Object.assign(new Error("fixture-secret"), { code: "EPIPE" });
    this.writes.push(frame);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (error?: unknown) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onExitConfirmed(listener: () => void): () => void {
    if (this.exited) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.confirmedExitListeners.add(listener);
    return () => this.confirmedExitListeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopped = true;
    await this.stopBarrier;
    if (this.stopError) throw this.stopError;
  }

  stopImmediately(): boolean {
    this.immediateStopCalls += 1;
    if (this.immediateStopSucceeds) {
      this.stoppedImmediately = true;
      this.stopped = true;
    }
    return this.immediateStopSucceeds;
  }

  emit(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  exit(error?: unknown): void {
    this.exited = true;
    for (const listener of this.exitListeners) listener(error);
    for (const listener of this.confirmedExitListeners) listener();
  }

  respondTo(method: string, result: unknown): void {
    const request = this.writes
      .map((frame) => JSON.parse(frame) as { id?: number; method: string })
      .findLast((message) => message.method === method && message.id !== undefined);
    assert.ok(request?.id, `Missing request for ${method}`);
    this.emit(`${JSON.stringify({ id: request.id, result })}\n`);
  }

  async waitFor(method: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (this.writes.some((frame) => (JSON.parse(frame) as { method: string }).method === method)) return;
      await Promise.resolve();
    }
    assert.fail(`Timed out waiting for ${method}`);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
