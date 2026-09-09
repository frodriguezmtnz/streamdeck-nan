import {
  UsageProviderError,
  sanitizeUsageError,
  type UsageProvider,
  type UsageProviderResult,
  type UsageWindow,
} from "../../usage/provider.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

const WEEK_WINDOW_MINUTES = 7 * 24 * 60;

export interface CodexUsageProviderOptions {
  readonly client?: CodexAppServerClient;
  readonly now?: () => number;
}

export class CodexUsageProvider implements UsageProvider {
  readonly id = "codex";
  private readonly client: CodexAppServerClient;
  private readonly now: () => number;

  constructor(options: CodexUsageProviderOptions = {}) {
    this.client = options.client ?? new CodexAppServerClient();
    this.now = options.now ?? Date.now;
  }

  async getUsage(): Promise<UsageProviderResult> {
    try {
      const windows = parseRateLimits(await this.client.readRateLimits());
      if (!windows) {
        return { ok: false, error: new UsageProviderError("invalid-response") };
      }
      return { ok: true, usage: { windows, observedAt: this.now() } };
    } catch (error) {
      return { ok: false, error: sanitizeUsageError(error) };
    }
  }

  stop(): Promise<void> {
    return this.client.stop();
  }

  recoverAfterWake(): void {
    this.client.recoverAfterWake();
  }

  stopImmediately(): void {
    this.client.stopImmediately();
  }
}

function parseRateLimits(
  value: unknown,
): Partial<Record<"session" | "week", UsageWindow>> | undefined {
  if (!isRecord(value)) return undefined;
  const rateLimits = isRecord(value.rateLimits)
    ? value.rateLimits
    : isRecord(value.rate_limits)
      ? value.rate_limits
      : value;
  const windows: Partial<Record<"session" | "week", UsageWindow>> = {};
  addWindow(windows, parseWindow(rateLimits.primary), "session");
  addWindow(windows, parseWindow(rateLimits.secondary), "week");
  return Object.keys(windows).length > 0 ? windows : undefined;
}

function addWindow(
  windows: Partial<Record<"session" | "week", UsageWindow>>,
  window: UsageWindow | undefined,
  fallbackName: "session" | "week",
): void {
  if (!window) return;
  const name = window.windowMinutes === undefined
    ? fallbackName
    : window.windowMinutes >= WEEK_WINDOW_MINUTES
      ? "week"
      : "session";
  windows[name] = window;
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = value.usedPercent ?? value.used_percent;
  if (!Number.isFinite(usedPercent)) return undefined;
  const windowMinutes = value.windowDurationMins ?? value.window_minutes;
  const resetsAt = value.resetsAt ?? value.resets_at;
  return {
    usedPercent: usedPercent as number,
    ...(Number.isFinite(windowMinutes) ? { windowMinutes: windowMinutes as number } : {}),
    ...parseReset(resetsAt),
  };
}

function parseReset(value: unknown): { resetsAt?: string } {
  if (typeof value === "string") return { resetsAt: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1_000);
    if (!Number.isNaN(date.valueOf())) return { resetsAt: date.toISOString() };
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
