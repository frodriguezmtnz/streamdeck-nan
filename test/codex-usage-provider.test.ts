import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CodexAppServerClient } from "../src/providers/codex/codex-app-server-client.ts";
import { CodexUsageProvider } from "../src/providers/codex/codex-usage-provider.ts";

test("codex-usage-provider reads complete rateLimits responses and reset timestamps", async () => {
  const provider = providerWithResponse({
    rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 48, windowDurationMins: 10_080, resetsAt: "2027-01-15T08:00:00Z" },
    },
  });

  assert.deepEqual(await provider.getUsage(), {
    ok: true,
    usage: {
      windows: {
        session: { usedPercent: 12, windowMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
        week: { usedPercent: 48, windowMinutes: 10_080, resetsAt: "2027-01-15T08:00:00Z" },
      },
      observedAt: 123,
    },
  });
});

test("codex-usage-provider reads partial snake_case rate_limits responses", async () => {
  const provider = providerWithResponse({
    rate_limits: {
      secondary: { used_percent: 31, window_minutes: 10_080 },
    },
  });

  assert.deepEqual(await provider.getUsage(), {
    ok: true,
    usage: { windows: { week: { usedPercent: 31, windowMinutes: 10_080 } }, observedAt: 123 },
  });
});

test("codex-usage-provider classifies a 10080-minute primary limit as weekly", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/codex-primary-weekly-rate-limits.json", import.meta.url), "utf8"),
  ) as unknown;
  const provider = providerWithResponse(fixture);

  assert.deepEqual(await provider.getUsage(), {
    ok: true,
    usage: {
      windows: {
        week: { usedPercent: 37, windowMinutes: 10_080, resetsAt: "2027-01-15T08:00:00.000Z" },
      },
      observedAt: 123,
    },
  });
});

test("codex-usage-provider rejects malformed rate-limit payloads", async () => {
  const result = await providerWithResponse({ rateLimits: { primary: { usedPercent: "bad" } } }).getUsage();

  assert.equal(errorCode(result), "invalid-response");
});

test("codex-usage-provider sanitizes client failures", async () => {
  const result = await providerWithFailure(new Error("fixture-secret")).getUsage();

  assert.equal(errorCode(result), "unavailable");
  assert.equal(!result.ok && result.error.message.includes("fixture-secret"), false);
});

function providerWithResponse(response: unknown): CodexUsageProvider {
  return providerWithClient({ readRateLimits: async () => response });
}

function providerWithFailure(error: Error): CodexUsageProvider {
  return providerWithClient({ readRateLimits: async () => Promise.reject(error) });
}

function providerWithClient(client: { readRateLimits: () => Promise<unknown> }): CodexUsageProvider {
  return new CodexUsageProvider({
    client: {
      ...client,
      stop: async () => undefined,
      stopImmediately: () => undefined,
    } as unknown as CodexAppServerClient,
    now: () => 123,
  });
}

function errorCode(result: Awaited<ReturnType<CodexUsageProvider["getUsage"]>>) {
  return result.ok ? undefined : result.error.code;
}
