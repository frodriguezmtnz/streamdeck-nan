import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { grokExecutableCandidates, safeRuntimeEnvironment, spawnGrokAcp, type GrokAcpTransport, type SpawnGrokAcpOptions } from "../src/providers/grok/grok-acp-transport.ts";
import { GrokUsageProvider, parseGrokBilling } from "../src/providers/grok/grok-usage-provider.ts";

test("resolves an absolute GUI-local Grok candidate with a credential-free fixed environment", async () => {
  const child = new FakeChild();
  let call: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
  const candidates = grokExecutableCandidates("/Users/gui");
  await spawnGrokAcp({
    ...trustedGrokOptions(child),
    executableCandidates: candidates,
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/gui", XAI_API_KEY: "secret", NAN_API_KEY: "secret", GROK_TOKEN: "secret" },
    resolveExecutable: async (candidate) => candidate === "/Users/gui/.local/bin/grok"
      ? { candidate, executable: candidate, dev: 1, ino: 2 }
      : undefined,
    spawnProcess: ((command, args, options) => { call = { command, args: args!, options: options! }; return child; }) as never,
  });
  assert.equal(call?.command, "/Users/gui/.local/bin/grok");
  assert.deepEqual(call?.args, ["agent", "stdio"]);
  assert.deepEqual(call?.options, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { HOME: "/Users/gui", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  assert.deepEqual(safeRuntimeEnvironment({ PATH: "/hostile", XAI_API_KEY: "x", API_KEY: "x" }), { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
});

test("Grok spawn rejects an executable identity swap before process creation", async () => {
  let spawned = false;
  await assert.rejects(spawnGrokAcp({
    executableCandidates: ["/candidate/grok"],
    resolveExecutable: async (candidate) => ({ candidate, executable: "/canonical/grok", dev: 1, ino: 2 }),
    validateExecutable: async () => false,
    spawnProcess: (() => { spawned = true; throw new Error("must not spawn"); }) as never,
  }), (error: unknown) => errorCode(error) === "executable-not-found");
  assert.equal(spawned, false);
});

test("Grok candidate resolution continues after a stale first identity", async () => {
  const child = new FakeChild();
  const validated: string[] = [];
  let spawned: string | undefined;
  await spawnGrokAcp({
    executableCandidates: ["/first/grok", "/second/grok"],
    resolveExecutable: async (candidate) => ({ candidate, executable: candidate, dev: 1, ino: 2 }),
    validateExecutable: async (identity) => {
      validated.push(identity.executable);
      return identity.executable === "/second/grok";
    },
    spawnProcess: ((command) => { spawned = command; return child; }) as never,
  });

  assert.deepEqual(validated, ["/first/grok", "/second/grok"]);
  assert.equal(spawned, "/second/grok");
});

test("parses the sanitized source-visible billing envelope and legacy fallback", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/grok-billing-response.json", import.meta.url), "utf8"));
  const provider = providerFromScripts([[{}, fixture, { monthlyLimit: 200, used: 50 }]], 123);
  assert.deepEqual(await provider.getUsage(), { ok: true, usage: { windows: { session: { usedPercent: 27, resetsAt: "2026-08-01T00:00:00Z" } }, observedAt: 123 } });
  assert.deepEqual(await provider.getUsage(), { ok: true, usage: { windows: { session: { usedPercent: 25 } }, observedAt: 123 } });
});

test("parses current on-demand billing schema with strict amount semantics", () => {
  const resetsAt = "2026-08-01T00:00:00Z";
  assert.deepEqual(parseGrokBilling({ result: { config: {
    onDemandUsed: { val: 25 }, onDemandCap: { val: 100 }, currentPeriod: { end: resetsAt },
  } } }), { usedPercent: 25, resetsAt });
  assert.deepEqual(parseGrokBilling({ result: { config: {
    onDemandUsed: { val: 0 }, onDemandCap: { val: 0 }, currentPeriod: { end: resetsAt },
  } } }), { usedPercent: 0, resetsAt });
  for (const value of [
    { onDemandUsed: { val: 1 }, onDemandCap: { val: 0 } },
    { onDemandUsed: { val: -1 }, onDemandCap: { val: 100 } },
    { onDemandUsed: { val: Number.POSITIVE_INFINITY }, onDemandCap: { val: 100 } },
    { onDemandUsed: 1, onDemandCap: { val: 100 } },
    { onDemandUsed: { val: 101 }, onDemandCap: { val: 100 } },
  ]) assert.equal(parseGrokBilling(value), undefined);
});

test("retires failed initialization and billing transports, then recovers", async () => {
  const provider = providerFromScripts([[new Error("raw startup")], [{}, { usedPercent: "bad" }], [{}, { usedPercent: 20 }]]);
  assert.equal(errorCode(await provider.getUsage()), "unavailable");
  assert.equal(errorCode(await provider.getUsage()), "invalid-response");
  assert.equal((await provider.getUsage()).ok, true);
});

test("cleanup failure does not permanently stop the provider", async () => {
  let creations = 0;
  const provider = new GrokUsageProvider({ transportFactory: () => {
    creations += 1;
    if (creations === 1) {
      return {
        request: async () => { throw new Error("request failed"); },
        stop: async () => { throw new Error("cleanup failed"); },
        stopImmediately: () => false,
      };
    }
    return scriptedTransport([{}, { usedPercent: 20 }]);
  } });

  assert.equal(errorCode(await provider.getUsage()), "unavailable");
  assert.equal((await provider.getUsage()).ok, true);
});

test("wake recovery replaces a transport with pending work", async () => {
  let creations = 0;
  let immediateStops = 0;
  const provider = new GrokUsageProvider({ transportFactory: () => {
    creations += 1;
    if (creations === 1) {
      return {
        request: () => new Promise(() => undefined),
        stop: async () => undefined,
        stopImmediately: () => { immediateStops += 1; return true; },
      };
    }
    return scriptedTransport([{}, { usedPercent: 30 }]);
  } });

  void provider.getUsage();
  await Promise.resolve();
  provider.recoverAfterWake();
  const recovered = await provider.getUsage();

  assert.equal(creations, 2);
  assert.equal(recovered.ok && recovered.usage.windows.session?.usedPercent, 30);
  assert.equal(immediateStops, 0);
});

test("repeated wakes bound pending Grok factories and retire stale resolutions", async () => {
  const first = deferred<GrokAcpTransport>();
  const second = deferred<GrokAcpTransport>();
  const stopCalls: number[] = [0, 0];
  let creations = 0;
  const staleTransport = (index: number): GrokAcpTransport => ({
    request: async () => { throw new Error("stale transport must not be used"); },
    stop: async () => { stopCalls[index] += 1; },
    stopImmediately: () => true,
  });
  const provider = new GrokUsageProvider({
    maxRetiringTransports: 2,
    transportFactory: () => {
      creations += 1;
      return creations === 1 ? first.promise : second.promise;
    },
  });
  const firstUsage = provider.getUsage();
  await waitFor(() => creations === 1);
  provider.recoverAfterWake();
  const secondUsage = provider.getUsage();
  await waitFor(() => creations === 2);
  provider.recoverAfterWake();

  assert.equal(errorCode(await provider.getUsage()), "unavailable");
  assert.equal(creations, 2);
  first.resolve(staleTransport(0));
  second.resolve(staleTransport(1));
  assert.equal(errorCode(await firstUsage), "unavailable");
  assert.equal(errorCode(await secondUsage), "unavailable");
  assert.deepEqual(stopCalls, [1, 1]);
});

test("Grok graceful shutdown waits for stale pending factory retirement", async () => {
  const factory = deferred<GrokAcpTransport>();
  let stopCalls = 0;
  const provider = new GrokUsageProvider({ transportFactory: () => factory.promise });
  const usage = provider.getUsage();
  await Promise.resolve();
  provider.recoverAfterWake();
  let stopped = false;
  const stopping = provider.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);

  factory.resolve({
    request: async () => { throw new Error("stale transport must not be used"); },
    stop: async () => { stopCalls += 1; },
    stopImmediately: () => true,
  });
  await stopping;
  assert.equal(errorCode(await usage), "stopped");
  assert.equal(stopCalls, 1);
});

test("failed Grok retirements stay quarantined without repeated wake signals until exit", async () => {
  const first = new QuarantinedGrokTransport();
  const second = scriptedTransport([{}, { usedPercent: 40 }]);
  let creations = 0;
  const provider = new GrokUsageProvider({
    maxRetiringTransports: 1,
    transportFactory: () => (++creations === 1 ? first : second),
  });
  assert.equal((await provider.getUsage()).ok, true);

  provider.recoverAfterWake();
  await Promise.resolve();
  await Promise.resolve();
  provider.recoverAfterWake();
  assert.equal(first.stopCalls, 1);
  assert.equal(first.immediateStopCalls, 1);
  assert.equal(errorCode(await provider.getUsage()), "unavailable");
  assert.equal(creations, 1);

  first.confirmExit();
  const recovered = await provider.getUsage();
  assert.equal(recovered.ok && recovered.usage.windows.session?.usedPercent, 40);
  assert.equal(creations, 2);
  assert.equal(first.immediateStopCalls, 1);
});

test("serializes concurrent refreshes with unique request identifiers", async () => {
  const ids: number[] = [];
  const methods: string[] = [];
  const transport: GrokAcpTransport = {
    request: async (frame, id) => { ids.push(id); const method = JSON.parse(frame).method; methods.push(method); return method === "initialize" ? {} : { usedPercent: id }; },
    notify: (frame) => { methods.push(JSON.parse(frame).method); },
    stop: async () => undefined,
    stopImmediately: () => true,
  };
  const provider = new GrokUsageProvider({ transportFactory: () => transport });
  await Promise.all([provider.getUsage(), provider.getUsage()]);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(methods, ["initialize", "initialized", "_x.ai/billing", "_x.ai/billing"]);
  assert.equal(methods.includes("x.ai/billing"), false);
});

test("accepts notifications, unknown ids, batched frames, and fragmented UTF-8", async () => {
  const child = new FakeChild();
  const transport = await spawnGrokAcp({ ...trustedGrokOptions(child), maxFrameBytes: 80, timeoutMs: 20 });
  const first = transport.request("{}\n", 1);
  const second = transport.request("{}\n", 2);
  const bytes = Buffer.from('{"jsonrpc":"2.0","method":"notice","params":{"text":"é"}}\n{"jsonrpc":"2.0","id":99,"result":{}}\n');
  const split = bytes.indexOf(0xc3) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n{"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n');
  assert.deepEqual(await Promise.all([first, second]), [{ ok: 1 }, { ok: 2 }]);
});

test("timeouts and oversized frames retire the process", async () => {
  const timeoutChild = new FakeChild();
  const timeoutTransport = await spawnGrokAcp({ ...trustedGrokOptions(timeoutChild), timeoutMs: 2 });
  await assert.rejects(timeoutTransport.request("{}\n", 1), (error: unknown) => errorCode(error) === "timeout");
  assert.deepEqual(timeoutChild.signals, ["SIGKILL"]);
  const frameChild = new FakeChild();
  const frameTransport = await spawnGrokAcp({ ...trustedGrokOptions(frameChild), maxFrameBytes: 10 });
  const pending = frameTransport.request("{}\n", 1);
  frameChild.stdout.write("x".repeat(11));
  await assert.rejects(pending, (error: unknown) => errorCode(error) === "invalid-response");
  assert.deepEqual(frameChild.signals, ["SIGKILL"]);
});

test("graceful shutdown confirms exit or escalates to SIGKILL", async () => {
  const graceful = new FakeChild();
  const first = await spawnGrokAcp({ ...trustedGrokOptions(graceful), stopGraceMs: 5 });
  const stopping = first.stop();
  graceful.emit("exit");
  await stopping;
  assert.deepEqual(graceful.signals, ["SIGTERM"]);
  const stubborn = new FakeChild();
  const second = await spawnGrokAcp({ ...trustedGrokOptions(stubborn), stopGraceMs: 1, killConfirmationMs: 1 });
  await assert.rejects(second.stop());
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(second.stopImmediately(), true);
});

test("provider shutdown is permanent and prevents queued recreation", async () => {
  let creations = 0;
  const provider = new GrokUsageProvider({ transportFactory: () => {
    creations++;
    return { request: async () => ({}), stop: async () => undefined, stopImmediately: () => true };
  } });
  await provider.stop();
  assert.equal(errorCode(await provider.getUsage()), "stopped");
  assert.equal(creations, 0);
});

test("provider keeps unconfirmed transports reachable during final shutdown", async () => {
  let immediateStops = 0;
  const provider = new GrokUsageProvider({ transportFactory: () => ({
    request: async (frame) => JSON.parse(frame).method === "initialize" ? {} : { usedPercent: 20 },
    stop: async () => { throw new Error("unconfirmed"); },
    stopImmediately: () => { immediateStops += 1; return immediateStops > 1; },
  }) });
  await provider.getUsage();

  provider.stopImmediately();
  provider.stopImmediately();

  assert.equal(immediateStops, 2);
});

function providerFromScripts(scripts: unknown[][], now = 1): GrokUsageProvider {
  return new GrokUsageProvider({ now: () => now, transportFactory: () => {
    return scriptedTransport(scripts.shift()!);
  } });
}

function scriptedTransport(items: unknown[]): GrokAcpTransport {
  return {
    request: async () => {
      const item = items.shift();
      if (item instanceof Error) throw item;
      return item;
    },
    stop: async () => undefined,
    stopImmediately: () => true,
  };
}

function errorCode(value: unknown): string | undefined {
  if (value && typeof value === "object" && "ok" in value && value.ok === false && "error" in value) return errorCode(value.error);
  return value instanceof Error && "code" in value ? String(value.code) : undefined;
}

function trustedGrokOptions(child: FakeChild): SpawnGrokAcpOptions {
  return {
    executableCandidates: ["/canonical/grok"],
    resolveExecutable: async (candidate) => ({ candidate, executable: candidate, dev: 1, ino: 2 }),
    validateExecutable: async () => true,
    spawnProcess: (() => child) as never,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

class QuarantinedGrokTransport implements GrokAcpTransport {
  stopCalls = 0;
  immediateStopCalls = 0;
  private requests = 0;
  private readonly exitListeners = new Set<() => void>();

  async request(): Promise<unknown> {
    this.requests += 1;
    return this.requests === 1 ? {} : { usedPercent: 20 };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error("unconfirmed");
  }

  stopImmediately(): boolean {
    this.immediateStopCalls += 1;
    return false;
  }

  onExitConfirmed(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  confirmExit(): void {
    for (const listener of this.exitListeners) listener();
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = []; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
}
