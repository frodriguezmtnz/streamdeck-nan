import assert from "node:assert/strict";
import test from "node:test";
import type { DialAction } from "@elgato/streamdeck";
import { RefreshingAction, type RefreshScheduler, type RefreshSettings } from "../src/refreshing-action.ts";

test("refreshing-action serializes refreshes and suppresses obsolete completions", async () => {
  const completions: Array<() => void> = [];
  const feedback: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let updates = 0;
  const action = fakeAction("context");
  const subject = new TestRefreshingAction(async (_action, isCurrent) => {
    const value = ++updates;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => completions.push(resolve));
    active -= 1;
    if (isCurrent()) feedback.push(value);
  });

  subject.configure(action);
  const first = subject.run(action);
  subject.configure(action);
  const queued = subject.run(action);
  assert.equal(first, queued);
  assert.equal(updates, 1);

  completions.shift()?.();
  await waitFor(() => updates === 2);
  assert.deepEqual(feedback, []);
  assert.equal(maximumActive, 1);
  completions.shift()?.();
  await first;
  assert.deepEqual(feedback, [2]);
});

test("refreshing-action suppresses completion after disappearance", async () => {
  const pending = deferred<void>();
  let displayed = false;
  const action = fakeAction("gone");
  const subject = new TestRefreshingAction(async (_action, isCurrent) => {
    await pending.promise;
    displayed = isCurrent();
  });

  subject.configure(action);
  const refresh = subject.run(action);
  subject.disappear(action);
  pending.resolve(undefined);
  await refresh;
  assert.equal(displayed, false);
});

test("refreshing-action replaces pre-wake work with one immediate forced refresh", async () => {
  const completions: Array<ReturnType<typeof deferred<void>>> = [];
  const displayed: number[] = [];
  const forces: boolean[] = [];
  let updates = 0;
  const action = fakeAction("wake");
  const subject = new TestRefreshingAction(async (_action, isCurrent, force) => {
    const value = ++updates;
    forces.push(force);
    const completion = deferred<void>();
    completions.push(completion);
    await completion.promise;
    if (isCurrent()) displayed.push(value);
  });

  subject.configure(action);
  const sleeping = subject.run(action);
  const waking = subject.wake();
  await waitFor(() => updates === 2);

  assert.deepEqual(forces, [false, true]);
  completions[1].resolve(undefined);
  await waking;
  assert.deepEqual(displayed, [2]);
  completions[0].resolve(undefined);
  await sleeping;
  assert.deepEqual(displayed, [2]);
});

test("refreshing-action resumes only visible actions", async () => {
  const refreshed: string[] = [];
  const first = fakeAction("visible");
  const second = fakeAction("gone");
  const subject = new TestRefreshingAction(async (action) => {
    refreshed.push(action.id);
  });

  subject.configure(first);
  subject.configure(second);
  subject.disappear(second);
  await subject.wake();

  assert.deepEqual(refreshed, ["visible"]);
});

test("refreshing-action appearance cannot resurrect after disappearing during layout", async () => {
  const scheduler = new FakeScheduler();
  const layout = deferred<void>();
  let updates = 0;
  const action = fakeAction("layout-race");
  const subject = new TestRefreshingAction(async () => { updates += 1; }, scheduler);

  const appearance = subject.appear(action, { autoRefresh: true, refreshInterval: 10 }, () => layout.promise);
  assert.equal(scheduler.activeCount, 0);
  subject.disappear(action);
  layout.resolve(undefined);
  await appearance;

  assert.equal(updates, 0);
  assert.equal(scheduler.activeCount, 0);
  await subject.wake();
  assert.equal(updates, 0);
});

test("refreshing-action owns one auto-refresh timer for a visible appearance", async () => {
  const scheduler = new FakeScheduler();
  let updates = 0;
  const action = fakeAction("timer");
  const subject = new TestRefreshingAction(async () => { updates += 1; }, scheduler);

  await subject.appear(action, { autoRefresh: true, refreshInterval: 10 });
  assert.equal(updates, 1);
  assert.equal(scheduler.activeCount, 1);
  scheduler.fireAll();
  await waitFor(() => updates === 2);

  subject.disappear(action);
  assert.equal(scheduler.activeCount, 0);
  scheduler.fireAll();
  await Promise.resolve();
  assert.equal(updates, 2);
});

test("refreshing-action settings cannot recreate a disappeared lifecycle", async () => {
  const scheduler = new FakeScheduler();
  let updates = 0;
  const action = fakeAction("late-settings");
  const subject = new TestRefreshingAction(async () => { updates += 1; }, scheduler);
  await subject.appear(action, { autoRefresh: true, refreshInterval: 10 });
  subject.disappear(action);

  subject.reconfigure(action, { autoRefresh: true, refreshInterval: 10 });
  await subject.run(action);

  assert.equal(updates, 1);
  assert.equal(scheduler.activeCount, 0);
});

test("refreshing-action delayed appearance applies only current settings after reconfiguration", async () => {
  const scheduler = new FakeScheduler();
  const preparation = deferred<void>();
  let updates = 0;
  const action = fakeAction("appearance-settings");
  const subject = new TestRefreshingAction(async () => { updates += 1; }, scheduler);

  const appearance = subject.appear(
    action,
    { autoRefresh: true, refreshInterval: 10 },
    () => preparation.promise,
  );
  subject.reconfigure(action, { autoRefresh: false, refreshInterval: 300 });
  preparation.resolve(undefined);
  await appearance;

  assert.equal(updates, 1);
  assert.equal(scheduler.activeCount, 0);
});

test("refreshing-action defers wake during layout and forces one post-layout refresh", async () => {
  const scheduler = new FakeScheduler();
  const preparation = deferred<void>();
  const forces: boolean[] = [];
  const action = fakeAction("wake-during-layout");
  const subject = new TestRefreshingAction(async (_action, _isCurrent, force) => { forces.push(force); }, scheduler);

  const appearance = subject.appear(action, { autoRefresh: false }, () => preparation.promise);
  await subject.wake();
  await subject.wake();
  assert.deepEqual(forces, []);
  assert.equal(scheduler.activeCount, 0);
  preparation.resolve(undefined);
  await appearance;

  assert.deepEqual(forces, [true]);
  assert.equal(scheduler.activeCount, 0);
});

test("refreshing-action remains refreshable after layout preparation rejects", async () => {
  let updates = 0;
  const action = fakeAction("layout-failure");
  const subject = new TestRefreshingAction(async () => { updates += 1; });

  await assert.rejects(subject.appear(
    action,
    { autoRefresh: false },
    async () => { throw new Error("layout failed"); },
  ), /layout failed/);
  await subject.run(action);
  await subject.wake();

  assert.equal(updates, 2);
});

test("refreshing-action appearance epoch survives wake but not reappearance", async () => {
  const action = fakeAction("appearance-epoch");
  const subject = new TestRefreshingAction(async () => undefined);
  await subject.appear(action, { autoRefresh: false });
  const firstAppearance = subject.currentAppearance(action);

  await subject.wake();
  assert.equal(firstAppearance(), true);
  subject.disappear(action);
  await subject.appear(action, { autoRefresh: false });

  assert.equal(firstAppearance(), false);
});

class TestRefreshingAction extends RefreshingAction {
  private readonly update: (
    action: DialAction<RefreshSettings>,
    isCurrent: () => boolean,
    force: boolean,
  ) => Promise<void>;

  constructor(update: (
    action: DialAction<RefreshSettings>,
    isCurrent: () => boolean,
    force: boolean,
  ) => Promise<void>, scheduler?: RefreshScheduler) {
    super(scheduler);
    this.update = update;
  }

  configure(action: DialAction<RefreshSettings>): void {
    if (!this.lifecycleGuard(action)()) this.beginAppearance(action, { autoRefresh: false }, false);
    this.configureRefresh(action, { autoRefresh: false });
  }

  appear(
    action: DialAction<RefreshSettings>,
    settings: RefreshSettings,
    prepare?: () => Promise<void>,
  ): Promise<void> {
    return this.activateOnAppearance(action, settings, prepare);
  }

  reconfigure(action: DialAction<RefreshSettings>, settings: RefreshSettings): void {
    this.configureRefresh(action, settings);
  }

  currentAppearance(action: DialAction<RefreshSettings>): () => boolean {
    return this.appearanceGuard(action);
  }

  run(action: DialAction<RefreshSettings>): Promise<void> {
    return this.refresh(action);
  }

  disappear(action: DialAction<RefreshSettings>): void {
    this.onWillDisappear({ action } as never);
  }

  wake(): Promise<void> {
    return this.resumeAfterSystemWake();
  }

  protected override updateDisplay(
    action: DialAction<RefreshSettings>,
    isCurrent: () => boolean,
    force: boolean,
  ): Promise<void> {
    return this.update(action, isCurrent, force);
  }
}

class FakeScheduler implements RefreshScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  get activeCount(): number { return this.callbacks.size; }

  setInterval(callback: () => void, _milliseconds: number): ReturnType<typeof setInterval> {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(timer: ReturnType<typeof setInterval>): void {
    this.callbacks.delete(timer as unknown as number);
  }

  fireAll(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

function fakeAction(id: string): DialAction<RefreshSettings> {
  return { id, manifestId: "test" } as DialAction<RefreshSettings>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}
