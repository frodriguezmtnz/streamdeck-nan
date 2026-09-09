import { sanitizeUsageError, UsageProviderError } from "../../usage/provider.js";
import {
  spawnCodexAppServer,
  type CodexAppServerTransport,
  type CodexTransportFactory,
} from "./codex-app-server-transport.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: UsageProviderError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface CodexAppServerClientOptions {
  readonly createTransport?: CodexTransportFactory;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxRetiringTransports?: number;
}

export class CodexAppServerClient {
  private readonly createTransport: CodexTransportFactory;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxRetiringTransports: number;
  private transport?: CodexAppServerTransport;
  private initialization?: Promise<void>;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private buffer = "";
  private stopped = false;
  private generation = 0;
  private stopping?: Promise<void>;
  private retirement?: Promise<void>;
  private transportCreation?: Promise<CodexAppServerTransport>;
  private readonly transportCreations = new Set<Promise<CodexAppServerTransport>>();
  private pendingCreationStop?: () => boolean;
  private pendingCreationTransport?: CodexAppServerTransport;
  private readonly retiringTransports = new Set<CodexAppServerTransport>();
  private readonly retirementTasks = new Map<CodexAppServerTransport, Promise<void>>();
  private readonly retirementExitListeners = new Map<CodexAppServerTransport, () => void>();
  private removeDataListener?: () => void;
  private removeExitListener?: () => void;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.createTransport = options.createTransport ?? spawnCodexAppServer;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    this.maxFrameBytes = Math.max(256, options.maxFrameBytes ?? 1024 * 1024);
    this.maxRetiringTransports = Math.max(1, options.maxRetiringTransports ?? 8);
  }

  async readRateLimits(): Promise<unknown> {
    if (this.stopped) throw new UsageProviderError("stopped");
    await this.ensureInitialized();
    return this.request("account/rateLimits/read");
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = this.stopAll();
    return this.stopping;
  }

  recoverAfterWake(): void {
    if (this.stopped) return;
    this.generation += 1;
    const transport = this.reset(new UsageProviderError("unavailable"));
    this.pendingCreationStop?.();
    this.pendingCreationTransport?.stopImmediately();
    this.pendingCreationStop = undefined;
    this.pendingCreationTransport = undefined;
    this.transportCreation = undefined;
    this.retirement = undefined;
    if (transport) this.retireDetached(transport);
  }

  stopImmediately(): void {
    this.stopped = true;
    const activeTransport = this.reset(new UsageProviderError("stopped"));
    if (activeTransport) this.trackRetiringTransport(activeTransport);
    if (this.pendingCreationTransport) this.trackRetiringTransport(this.pendingCreationTransport);
    else this.pendingCreationStop?.();
    for (const transport of this.retiringTransports) {
      transport.stopImmediately();
    }
  }

  private async stopAll(): Promise<void> {
    const initialization = this.initialization;
    const transport = this.reset(new UsageProviderError("stopped"));
    if (transport) this.retire(transport);
    if (initialization) {
      try {
        await initialization;
      } catch (error) {
        if (!(error instanceof UsageProviderError && error.code === "stopped")) {
          throw sanitizeUsageError(error);
        }
      }
    }
    await this.awaitRetirement();
    await Promise.all([...this.retiringTransports].map((entry) => this.retireTransport(entry)));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;
    await this.awaitRetirement();
    if (this.initialization) return this.initialization;
    if (this.retiringTransports.size + this.transportCreations.size >= this.maxRetiringTransports) {
      throw new UsageProviderError("unavailable");
    }
    const initialization = this.initialize(this.generation);
    this.initialization = initialization;
    try {
      await initialization;
    } catch (error) {
      if (this.initialization === initialization) this.initialization = undefined;
      throw error;
    }
  }

  private async initialize(generation: number): Promise<void> {
    let transport: CodexAppServerTransport | undefined;
    try {
      const creation = this.createTransport();
      this.transportCreations.add(creation);
      void creation.then(
        () => this.transportCreations.delete(creation),
        () => this.transportCreations.delete(creation),
      );
      this.transportCreation = creation;
      this.pendingCreationStop = getImmediateStop(creation);
      try {
        transport = await this.awaitTransportCreation(creation);
      } finally {
        if (this.transportCreation === creation) {
          this.transportCreation = undefined;
          this.pendingCreationStop = undefined;
        }
      }
      if (this.stopped || generation !== this.generation) {
        throw new UsageProviderError(this.stopped ? "stopped" : "unavailable");
      }
      this.pendingCreationTransport = transport;
      this.transport = transport;
      this.pendingCreationTransport = undefined;
      this.removeDataListener = transport.onData((chunk) => this.receive(chunk));
      this.removeExitListener = transport.onExit(() => {
        this.terminate(new UsageProviderError("unavailable"));
      });
      await this.request("initialize", {
        clientInfo: { name: "streamdeck-ai-usage", version: "1.0.0" },
      });
      this.notify("initialized");
    } catch (error) {
      const classified = classifyStartError(error);
      if (generation !== this.generation) {
        if (transport) {
          transport.stopImmediately();
          this.retireDetached(transport);
        }
        throw classified;
      }
      this.pendingCreationTransport = undefined;
      const activeTransport = this.reset(classified);
      if (transport && transport !== activeTransport) {
        transport.stopImmediately();
        this.retireDetached(transport);
      }
      if (activeTransport) this.retire(activeTransport);
      throw classified;
    }
  }

  private request(method: string, params: unknown = {}): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new UsageProviderError("unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.terminate(new UsageProviderError("timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        transport.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        this.terminate(new UsageProviderError("unavailable"));
      }
    });
  }

  private notify(method: string, params: unknown = {}): void {
    try {
      this.transport?.write(`${JSON.stringify({ method, params })}\n`);
    } catch {
      this.terminate(new UsageProviderError("unavailable"));
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const frame = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(frame) > this.maxFrameBytes) {
        this.terminate(new UsageProviderError("invalid-response"));
        return;
      }
      if (frame.length > 0 && !this.handleFrame(frame)) return;
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.terminate(new UsageProviderError("invalid-response"));
    }
  }

  private handleFrame(frame: string): boolean {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      this.terminate(new UsageProviderError("invalid-response"));
      return false;
    }
    if (!isRecord(message) || !Number.isInteger(message.id)) return true;
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) return true;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (message.error !== undefined) {
      pending.reject(new UsageProviderError("unavailable"));
    } else if ("result" in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new UsageProviderError("invalid-response"));
    }
    return true;
  }

  private terminate(error: UsageProviderError): void {
    const transport = this.reset(error);
    if (transport) this.retire(transport);
  }

  private retire(transport: CodexAppServerTransport): void {
    const previous = this.retirement;
    const retirement = (async () => {
      let previousError: unknown;
      if (previous) {
        try {
          await previous;
        } catch (error) {
          previousError = error;
        }
      }
      try {
        await this.retireTransport(transport);
      } catch (error) {
        throw sanitizeUsageError(error);
      }
      if (previousError) throw previousError;
    })();
    this.retirement = retirement;
    void retirement.catch(() => undefined);
  }

  private async awaitRetirement(): Promise<void> {
    const retirement = this.retirement;
    if (!retirement) return;
    try {
      await retirement;
    } finally {
      if (this.retirement === retirement) this.retirement = undefined;
    }
  }

  private awaitTransportCreation(
    creation: Promise<CodexAppServerTransport>,
  ): Promise<CodexAppServerTransport> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        getImmediateStop(creation)?.();
        reject(new UsageProviderError("timeout"));
      }, this.timeoutMs);
      void creation.then((transport) => {
        if (settled) {
          transport.stopImmediately();
          this.retireDetached(transport);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(transport);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private retireDetached(transport: CodexAppServerTransport): void {
    void this.retireTransport(transport).catch(() => undefined);
  }

  private retireTransport(transport: CodexAppServerTransport): Promise<void> {
    const existing = this.retirementTasks.get(transport);
    if (existing) return existing;
    this.trackRetiringTransport(transport);
    const retirement = transport.stop().then(() => {
      this.confirmTransportExit(transport);
    }, (error) => {
      this.retirementTasks.delete(transport);
      throw sanitizeUsageError(error);
    });
    this.retirementTasks.set(transport, retirement);
    return retirement;
  }

  private trackRetiringTransport(transport: CodexAppServerTransport): void {
    this.retiringTransports.add(transport);
    if (this.retirementExitListeners.has(transport)) return;
    const remove = transport.onExitConfirmed?.(() => this.confirmTransportExit(transport));
    if (remove) this.retirementExitListeners.set(transport, remove);
  }

  private confirmTransportExit(transport: CodexAppServerTransport): void {
    this.retirementTasks.delete(transport);
    this.retiringTransports.delete(transport);
    this.retirementExitListeners.get(transport)?.();
    this.retirementExitListeners.delete(transport);
  }

  private reset(error: UsageProviderError): CodexAppServerTransport | undefined {
    const transport = this.transport;
    this.removeDataListener?.();
    this.removeExitListener?.();
    this.removeDataListener = undefined;
    this.removeExitListener = undefined;
    this.transport = undefined;
    this.initialization = undefined;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    return transport;
  }
}

function classifyStartError(error: unknown): UsageProviderError {
  if (error instanceof UsageProviderError) return error;
  return isRecord(error) && error.code === "ENOENT"
    ? new UsageProviderError("executable-not-found")
    : new UsageProviderError("unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getImmediateStop(
  creation: Promise<CodexAppServerTransport>,
): (() => boolean) | undefined {
  if (!("stopImmediately" in creation)) return undefined;
  const stopImmediately = creation.stopImmediately;
  return typeof stopImmediately === "function"
    ? stopImmediately.bind(creation) as () => boolean
    : undefined;
}
