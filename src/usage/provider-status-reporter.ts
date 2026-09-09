import type { UsageErrorCode } from "./provider.js";

export type ProviderFailureState = UsageErrorCode
  | "missing-configuration"
  | "invalid-configuration"
  | "unavailable-credentials"
  | "unavailable-fetch";

export interface ProviderStatusReporter {
  failure(providerId: string, state: ProviderFailureState): void;
  success(providerId: string): void;
}

const allowedProviderIds = new Set(["claude", "codex", "grok", "nan"]);
const allowedStates = new Set<ProviderFailureState>([
  "authentication", "executable-not-found", "timeout", "invalid-response", "unavailable", "stopped",
  "missing-configuration", "invalid-configuration", "unavailable-credentials", "unavailable-fetch",
]);

export class TransitioningProviderStatusReporter implements ProviderStatusReporter {
  private readonly failures = new Map<string, ProviderFailureState>();
  private readonly write: (message: string) => void;

  constructor(write: (message: string) => void) {
    this.write = write;
  }

  failure(providerId: string, state: ProviderFailureState): void {
    const safeProviderId = allowedProviderIds.has(providerId) ? providerId : "unknown";
    const safeState = allowedStates.has(state) ? state : "unavailable";
    if (this.failures.get(safeProviderId) === safeState) return;
    this.failures.set(safeProviderId, safeState);
    try { this.write(`provider=${safeProviderId} state=${safeState}`); } catch { /* Observability never changes provider behavior. */ }
  }

  success(providerId: string): void {
    this.failures.delete(allowedProviderIds.has(providerId) ? providerId : "unknown");
  }
}
