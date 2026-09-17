import { UsageProviderError, type UsageProvider, type UsageProviderResult } from "./provider.js";

export class UnsupportedPlatformUsageProvider implements UsageProvider {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  getUsage(): Promise<UsageProviderResult> {
    return Promise.resolve({
      ok: false,
      error: new UsageProviderError("unsupported-platform"),
    });
  }

  recoverAfterWake(): void {}

  stop(): Promise<void> {
    return Promise.resolve();
  }

  stopImmediately(): void {}
}
