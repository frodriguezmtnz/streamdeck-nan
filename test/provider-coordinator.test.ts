import assert from "node:assert/strict";
import test from "node:test";
import {
  UsageProviderError,
  sanitizeUsageError,
  type UsageProvider,
  type UsageProviderResult,
} from "../src/usage/provider.ts";
import { TransitioningProviderStatusReporter } from "../src/usage/provider-status-reporter.ts";
import { UsageProviderCoordinator } from "../src/usage/provider-coordinator.ts";

const snapshot = (usedPercent: number, observedAt = usedPercent) => ({
  windows: { week: { usedPercent } },
  observedAt,
});

test("provider-coordinator preserves partial normalized windows", async () => {
  const provider = providerFrom(async () => ({ ok: true, usage: snapshot(42, 100) }));
  const result = await new UsageProviderCoordinator(provider).getUsage();

  assert.deepEqual(result, {
    ok: true,
    usage: snapshot(42, 100),
    stale: false,
  });
});

test("provider-coordinator deduplicates concurrent requests", async () => {
  const pending = deferred<UsageProviderResult>();
  let calls = 0;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(() => {
      calls += 1;
      return pending.promise;
    }),
  );

  const first = coordinator.getUsage();
  const second = coordinator.getUsage();
  assert.equal(first, second);
  assert.equal(calls, 1);

  pending.resolve({ ok: true, usage: snapshot(20) });
  assert.deepEqual(await first, await second);
});

test("provider-coordinator reuses a successful cache within its ttl", async () => {
  let calls = 0;
  let now = 1_000;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => ({ ok: true, usage: snapshot(++calls) })),
    { cacheTtlMs: 100, now: () => now },
  );

  await coordinator.getUsage();
  now += 99;
  const result = await coordinator.getUsage();

  assert.equal(calls, 1);
  assert.equal(result.ok && result.usage.windows.week?.usedPercent, 1);
});

test("provider-coordinator returns the last success as stale after failure", async () => {
  let fail = false;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () =>
      fail
        ? { ok: false, error: new UsageProviderError("timeout") }
        : { ok: true, usage: snapshot(35) },
    ),
  );

  await coordinator.getUsage();
  fail = true;
  const result = await coordinator.getUsage();

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.stale, true);
  assert.equal(result.ok && result.usage.windows.week?.usedPercent, 35);
  assert.equal(result.ok && result.error?.code, "timeout");
});

test("provider-coordinator throttles repeated failures and resumes after cooldown", async () => {
  let calls = 0;
  let now = 1_000;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => {
      calls += 1;
      return { ok: false, error: new UsageProviderError("rate-limited") };
    }),
    { failureCooldownMs: 100, now: () => now },
  );

  await coordinator.getUsage();
  await coordinator.getUsage();
  assert.equal(calls, 1);

  now += 100;
  await coordinator.getUsage();
  assert.equal(calls, 2);
});

test("provider-coordinator keeps cached success stale during failure cooldown", async () => {
  let calls = 0;
  let now = 1_000;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => ++calls === 1
      ? { ok: true, usage: snapshot(35) }
      : { ok: false, error: new UsageProviderError("rate-limited") }),
    { cacheTtlMs: 50, failureCooldownMs: 100, now: () => now },
  );

  await coordinator.getUsage();
  now += 50;
  const failed = await coordinator.getUsage();
  const throttled = await coordinator.getUsage();

  assert.equal(calls, 2);
  assert.equal(failed.ok && failed.stale, true);
  assert.equal(throttled.ok && throttled.stale, true);
  assert.equal(throttled.ok && throttled.usage.windows.week?.usedPercent, 35);
  assert.equal(throttled.ok && throttled.error?.code, "rate-limited");
});

test("provider-coordinator force does not bypass failure cooldown", async () => {
  let calls = 0;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => ++calls === 1
      ? { ok: false, error: new UsageProviderError("rate-limited") }
      : { ok: true, usage: snapshot(70) }),
    { failureCooldownMs: 100 },
  );

  await coordinator.getUsage();
  const throttled = await coordinator.getUsage({ force: true });

  assert.equal(calls, 1);
  assert.equal(throttled.ok, false);
});

test("provider-coordinator honors provider retry delay and resumes exactly at expiry", async () => {
  let calls = 0;
  let now = 1_000;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, error: new UsageProviderError("unavailable", { retryAfterMs: 1_527_000 }) }
        : { ok: true, usage: snapshot(70) };
    }),
    { failureCooldownMs: 120_000, now: () => now },
  );

  await coordinator.getUsage();
  now += 1_526_999;
  await coordinator.getUsage({ force: true });
  assert.equal(calls, 1);

  now += 1;
  const resumed = await coordinator.getUsage({ force: true });
  assert.equal(calls, 2);
  assert.equal(resumed.ok && resumed.usage.windows.week?.usedPercent, 70);
});

test("provider-coordinator keeps configured cooldown when provider delay is shorter", async () => {
  let calls = 0;
  let now = 1_000;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => {
      calls += 1;
      return { ok: false, error: new UsageProviderError("unavailable", { retryAfterMs: 10 }) };
    }),
    { failureCooldownMs: 100, now: () => now },
  );

  await coordinator.getUsage();
  now += 99;
  await coordinator.getUsage();
  assert.equal(calls, 1);
  now += 1;
  await coordinator.getUsage();
  assert.equal(calls, 2);
});

test("provider-coordinator caps huge provider retry delays at 24 hours", async () => {
  let calls = 0;
  let now = 1_000;
  const huge = new UsageProviderError("unavailable", { retryAfterMs: Number.MAX_SAFE_INTEGER });
  assert.equal(huge.retryAfterMs, 86_400_000);
  assert.equal(new UsageProviderError("unavailable", { retryAfterMs: 123_000 }).retryAfterMs, 123_000);
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => ++calls === 1
      ? { ok: false, error: huge }
      : { ok: true, usage: snapshot(70) }),
    { failureCooldownMs: 120_000, now: () => now },
  );

  await coordinator.getUsage();
  now += 86_399_999;
  await coordinator.getUsage({ force: true });
  assert.equal(calls, 1);
  now += 1;
  await coordinator.getUsage({ force: true });
  assert.equal(calls, 2);
});

test("provider-coordinator force bypasses fresh cache but coalesces in-flight requests", async () => {
  const pending = deferred<UsageProviderResult>();
  let calls = 0;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ ok: true, usage: snapshot(20) }) : pending.promise;
    }),
    { cacheTtlMs: 10_000 },
  );

  await coordinator.getUsage();
  const forced = coordinator.getUsage({ force: true });
  const repeatedForce = coordinator.getUsage({ force: true });
  assert.equal(forced, repeatedForce);
  assert.equal(calls, 2);

  pending.resolve({ ok: true, usage: snapshot(40) });
  assert.equal((await forced).ok, true);
});

test("provider-coordinator throttles forced refreshes after success independently of cache ttl", async () => {
  let calls = 0;
  let now = 1_000;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => ({ ok: true, usage: snapshot(++calls) })),
    { cacheTtlMs: 30_000, forcedRefreshThrottleMs: 5_000, now: () => now },
  );

  await coordinator.getUsage();
  now += 4_999;
  await coordinator.getUsage({ force: true });
  assert.equal(calls, 1);

  now += 1;
  const forced = await coordinator.getUsage({ force: true });
  assert.equal(calls, 2);
  assert.equal(forced.ok && forced.usage.windows.week?.usedPercent, 2);
});

test("provider-coordinator returns sanitized no-data failures", async () => {
  const secret = "Bearer secret-token";
  const logs: string[] = [];
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => {
      throw new Error(secret);
    }),
    { statusReporter: new TransitioningProviderStatusReporter((message) => logs.push(message)) },
  );

  const result = await coordinator.getUsage();

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, "unavailable");
  assert.equal(!result.ok && result.error.message.includes(secret), false);
  assert.equal(sanitizeUsageError(secret).message.includes(secret), false);
  assert.deepEqual(logs, ["provider=unknown state=unavailable"]);
  assert.equal(logs.join("\n").includes(secret), false);
});

test("provider-coordinator rejects malformed data without losing its cache", async () => {
  let malformed = false;
  const coordinator = new UsageProviderCoordinator(
    providerFrom(async () => ({
      ok: true,
      usage: malformed
        ? ({ windows: {}, observedAt: 2 } as never)
        : snapshot(10, 1),
    })),
  );

  await coordinator.getUsage();
  malformed = true;
  const result = await coordinator.getUsage();

  assert.equal(result.ok && result.stale, true);
  assert.equal(result.ok && result.error?.code, "invalid-response");
  assert.equal(result.ok && result.usage.observedAt, 1);
});

test("provider-coordinator wake recovery bypasses cooldown and forced throttling", async () => {
  let calls = 0;
  let recoveries = 0;
  let now = 1_000;
  const provider = providerFrom(async () => {
    calls += 1;
    if (calls === 2) return { ok: false, error: new UsageProviderError("timeout", { retryAfterMs: 10_000 }) };
    return { ok: true, usage: snapshot(calls * 10) };
  });
  provider.recoverAfterWake = () => { recoveries += 1; };
  const coordinator = new UsageProviderCoordinator(provider, {
    cacheTtlMs: 10_000,
    failureCooldownMs: 10_000,
    forcedRefreshThrottleMs: 10_000,
    now: () => now,
  });

  await coordinator.getUsage();
  now += 10_000;
  await coordinator.getUsage({ force: true });
  coordinator.recoverAfterWake();
  const recovered = await coordinator.getUsage({ force: true });

  assert.equal(recoveries, 1);
  assert.equal(calls, 3);
  assert.equal(recovered.ok && recovered.usage.windows.week?.usedPercent, 30);
});

test("provider-coordinator wake recovery isolates late pre-wake completion", async () => {
  const sleeping = deferred<UsageProviderResult>();
  let calls = 0;
  const coordinator = new UsageProviderCoordinator(providerFrom(async () => {
    calls += 1;
    if (calls === 1) return sleeping.promise;
    return { ok: true, usage: snapshot(calls * 10) };
  }), { failureCooldownMs: 10_000 });

  const obsolete = coordinator.getUsage();
  coordinator.recoverAfterWake();
  const recovered = await coordinator.getUsage({ force: true });
  sleeping.resolve({ ok: false, error: new UsageProviderError("timeout", { retryAfterMs: 10_000 }) });
  await obsolete;
  const following = await coordinator.getUsage({ force: true });

  assert.equal(calls, 3);
  assert.equal(recovered.ok && recovered.usage.windows.week?.usedPercent, 20);
  assert.equal(following.ok && following.usage.windows.week?.usedPercent, 30);
});

function providerFrom(getUsage: () => Promise<UsageProviderResult>): UsageProvider {
  return { id: "test", getUsage };
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
