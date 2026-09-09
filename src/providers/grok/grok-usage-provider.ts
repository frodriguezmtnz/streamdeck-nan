import { UsageProviderError, sanitizeUsageError, type UsageProvider, type UsageProviderResult } from "../../usage/provider.js";
import { createGrokBillingRequest, createGrokInitializationRequest, encodeGrokAcpRequest, encodeGrokInitializedNotification, type GrokAcpRequest } from "./grok-acp-contract.js";
import { spawnGrokAcp, type GrokAcpTransport } from "./grok-acp-transport.js";

export interface GrokUsageProviderOptions {
  readonly transportFactory?: () => GrokAcpTransport | Promise<GrokAcpTransport>;
  readonly now?: () => number;
  readonly maxRetiringTransports?: number;
}

interface GrokLifecycle {
  transport?: GrokAcpTransport;
  sequence: number;
  queue: Promise<void>;
}

export class GrokUsageProvider implements UsageProvider {
  readonly id = "grok";
  private readonly factory: () => GrokAcpTransport | Promise<GrokAcpTransport>;
  private readonly now: () => number;
  private readonly maxRetiringTransports: number;
  private lifecycle = createLifecycle();
  private readonly retiringTransports = new Set<GrokAcpTransport>();
  private readonly retirementTasks = new Map<GrokAcpTransport, Promise<void>>();
  private readonly retirementExitListeners = new Map<GrokAcpTransport, () => void>();
  private readonly transportCreations = new Set<Promise<GrokAcpTransport>>();
  private stopped = false;

  constructor(options: GrokUsageProviderOptions = {}) {
    this.factory = options.transportFactory ?? spawnGrokAcp;
    this.now = options.now ?? Date.now;
    this.maxRetiringTransports = Math.max(1, options.maxRetiringTransports ?? 8);
  }

  getUsage(): Promise<UsageProviderResult> {
    if (this.stopped) return Promise.resolve({ ok: false, error: new UsageProviderError("stopped") });
    const lifecycle = this.lifecycle;
    const operation = lifecycle.queue.then(() => this.readUsage(lifecycle));
    lifecycle.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const lifecycle = this.lifecycle;
    await lifecycle.queue;
    await Promise.allSettled([...this.transportCreations]);
    const transport = lifecycle.transport;
    lifecycle.transport = undefined;
    if (transport) this.retiringTransports.add(transport);
    await Promise.all([...this.retiringTransports].map((entry) => this.retire(entry)));
  }

  stopImmediately(): void {
    this.stopped = true;
    const transport = this.lifecycle.transport;
    if (transport) this.retiringTransports.add(transport);
    this.lifecycle.transport = undefined;
    for (const transport of this.retiringTransports) transport.stopImmediately();
  }

  recoverAfterWake(): void {
    if (this.stopped) return;
    const previous = this.lifecycle;
    this.lifecycle = createLifecycle();
    const transport = previous.transport;
    previous.transport = undefined;
    if (transport) void this.retire(transport).catch(() => undefined);
  }

  private async readUsage(lifecycle: GrokLifecycle): Promise<UsageProviderResult> {
    if (this.stopped || this.lifecycle !== lifecycle) {
      return { ok: false, error: new UsageProviderError(this.stopped ? "stopped" : "unavailable") };
    }
    try {
      if (!lifecycle.transport
        && this.retiringTransports.size + this.transportCreations.size >= this.maxRetiringTransports) {
        throw new UsageProviderError("unavailable");
      }
      let transport = lifecycle.transport;
      if (!transport) {
        const creation = Promise.resolve().then(() => this.factory());
        this.transportCreations.add(creation);
        let created: GrokAcpTransport;
        try {
          created = await creation;
        } finally {
          this.transportCreations.delete(creation);
        }
        if (this.stopped || this.lifecycle !== lifecycle) {
          void this.retire(created).catch(() => undefined);
          throw new UsageProviderError(this.stopped ? "stopped" : "unavailable");
        }
        lifecycle.transport = created;
        transport = created;
      }
      if (lifecycle.sequence === 0) {
        await this.send(transport, createGrokInitializationRequest(++lifecycle.sequence));
        transport.notify?.(encodeGrokInitializedNotification());
      }
      const billing = parseGrokBilling(await this.send(transport, createGrokBillingRequest(++lifecycle.sequence)));
      if (!billing) throw new UsageProviderError("invalid-response");
      return { ok: true, usage: { windows: { session: billing }, observedAt: this.now() } };
    } catch (error) {
      const failed = lifecycle.transport;
      lifecycle.transport = undefined;
      lifecycle.sequence = 0;
      if (failed) await this.retire(failed).catch(() => undefined);
      return { ok: false, error: sanitizeUsageError(error) };
    }
  }

  private send(transport: GrokAcpTransport, request: GrokAcpRequest): Promise<unknown> {
    return transport.request(encodeGrokAcpRequest(request), request.id);
  }

  private retire(transport: GrokAcpTransport): Promise<void> {
    const existing = this.retirementTasks.get(transport);
    if (existing) return existing;
    this.trackRetiringTransport(transport);
    const retirement = transport.stop().then(() => {
      this.confirmTransportExit(transport);
    }, (error) => {
      this.retirementTasks.delete(transport);
      transport.stopImmediately();
      throw sanitizeUsageError(error);
    });
    this.retirementTasks.set(transport, retirement);
    return retirement;
  }

  private trackRetiringTransport(transport: GrokAcpTransport): void {
    this.retiringTransports.add(transport);
    if (this.retirementExitListeners.has(transport)) return;
    const remove = transport.onExitConfirmed?.(() => this.confirmTransportExit(transport));
    if (remove) this.retirementExitListeners.set(transport, remove);
  }

  private confirmTransportExit(transport: GrokAcpTransport): void {
    this.retirementTasks.delete(transport);
    this.retiringTransports.delete(transport);
    this.retirementExitListeners.get(transport)?.();
    this.retirementExitListeners.delete(transport);
  }
}

function createLifecycle(): GrokLifecycle {
  return { sequence: 0, queue: Promise.resolve() };
}

export function parseGrokBilling(value: unknown): { usedPercent: number; resetsAt?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const payload = isRecord(value.result) ? value.result : value;
  const config = isRecord(payload.config) ? payload.config : payload;
  let usedPercent: unknown;
  if (config.onDemandUsed !== undefined || config.onDemandCap !== undefined) {
    if (!isRecord(config.onDemandUsed) || !isRecord(config.onDemandCap)) return undefined;
    const used = config.onDemandUsed.val;
    const cap = config.onDemandCap.val;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0
      || typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) return undefined;
    if (cap === 0) {
      if (used !== 0) return undefined;
      usedPercent = 0;
    } else {
      usedPercent = used / cap * 100;
    }
  } else {
    usedPercent = config.creditUsagePercent ?? config.usedPercent ?? config.used_percent;
  }
  if (!Number.isFinite(usedPercent) && Number.isFinite(config.monthlyLimit) && Number.isFinite(config.used) && (config.monthlyLimit as number) > 0) {
    usedPercent = (config.used as number) / (config.monthlyLimit as number) * 100;
  }
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const resetsAt = period?.end ?? config.resetsAt ?? config.resets_at;
  if (resetsAt !== undefined && (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt)))) return undefined;
  return { usedPercent, ...(typeof resetsAt === "string" ? { resetsAt } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
