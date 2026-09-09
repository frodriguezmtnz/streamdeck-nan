import {
  SingletonAction,
  streamDeck,
  type DialAction,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

export type RefreshSettings = Partial<{
  autoRefresh: boolean;
  refreshInterval: number;
}>;

export interface RefreshScheduler {
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

interface RefreshLifecycle<Settings extends RefreshSettings> {
  action: DialAction<Settings>;
  settings: Settings;
  readonly appearanceEpoch: number;
  generation: number;
  preparing: boolean;
  inFlight?: Promise<void>;
  pending: boolean;
  force: boolean;
  showCountdown: boolean;
}

export abstract class RefreshingAction<Settings extends RefreshSettings = RefreshSettings> extends SingletonAction<Settings> {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly alternationTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lifecycles = new Map<string, RefreshLifecycle<Settings>>();
  private readonly scheduler: RefreshScheduler;
  private nextAppearanceEpoch = 0;

  constructor(scheduler: RefreshScheduler = defaultScheduler) {
    super();
    this.scheduler = scheduler;
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.clearTimer(ev.action.id);
    this.clearAlternationTimer(ev.action.id);
    this.lifecycles.delete(ev.action.id);
  }

  protected configureRefresh(
    action: DialAction<Settings>,
    settings: Settings,
  ): void {
    this.clearTimer(action.id);
    const lifecycle = this.lifecycles.get(action.id);
    if (!lifecycle) return;
    lifecycle.action = action;
    lifecycle.settings = settings;
    lifecycle.generation += 1;
    this.lifecycles.set(action.id, lifecycle);
    if (!lifecycle.preparing) this.armTimer(action, settings);
  }

  protected async activateOnAppearance(
    action: DialAction<Settings>,
    settings: Settings,
    prepare: () => Promise<void> = () => Promise.resolve(),
  ): Promise<void> {
    this.beginAppearance(action, settings);
    const isSameAppearance = this.appearanceGuard(action);
    try {
      await prepare();
    } catch (error) {
      if (isSameAppearance()) {
        const lifecycle = this.lifecycles.get(action.id);
        if (lifecycle) {
          lifecycle.preparing = false;
          lifecycle.pending = false;
          lifecycle.force = false;
          this.configureRefresh(lifecycle.action, lifecycle.settings);
        }
      }
      throw error;
    }
    if (!isSameAppearance()) return;
    const lifecycle = this.lifecycles.get(action.id);
    if (!lifecycle) return;
    const force = lifecycle.force;
    lifecycle.preparing = false;
    lifecycle.pending = false;
    lifecycle.force = false;
    this.configureRefresh(lifecycle.action, lifecycle.settings);
    await this.refresh(lifecycle.action, force);
  }

  protected beginAppearance(
    action: DialAction<Settings>,
    settings: Settings,
    preparing = true,
  ): () => boolean {
    this.clearTimer(action.id);
    const previous = this.lifecycles.get(action.id);
    const lifecycle: RefreshLifecycle<Settings> = {
      action,
      settings,
      appearanceEpoch: ++this.nextAppearanceEpoch,
      generation: (previous?.generation ?? 0) + 1,
      preparing,
      pending: false,
      force: false,
      showCountdown: false,
    };
    this.lifecycles.set(action.id, lifecycle);
    const generation = lifecycle.generation;
    return () => this.lifecycles.get(action.id) === lifecycle && lifecycle.generation === generation;
  }

  resumeAfterSystemWake(): Promise<void> {
    const refreshes: Promise<void>[] = [];
    for (const [contextId, previous] of [...this.lifecycles]) {
      this.clearTimer(contextId);
      if (previous.preparing) {
        previous.pending = true;
        previous.force = true;
        continue;
      }
      const lifecycle: RefreshLifecycle<Settings> = {
        action: previous.action,
        settings: previous.settings,
        appearanceEpoch: previous.appearanceEpoch,
        generation: previous.generation + 1,
        preparing: false,
        pending: false,
        force: false,
        showCountdown: false,
      };
      this.lifecycles.set(contextId, lifecycle);
      this.armTimer(lifecycle.action, lifecycle.settings);
      refreshes.push(this.refresh(lifecycle.action, true));
    }
    return Promise.all(refreshes).then(() => undefined);
  }

  private armTimer(action: DialAction<Settings>, settings: Settings): void {
    if (settings.autoRefresh === false) return;
    const configuredInterval = settings.refreshInterval;
    const seconds =
      typeof configuredInterval === "number" && Number.isFinite(configuredInterval)
      ? Math.min(300, Math.max(10, configuredInterval))
      : 30;
    const timer = this.scheduler.setInterval(() => void this.refresh(action), seconds * 1000);
    this.timers.set(action.id, timer);
  }

  protected refresh(action: DialAction<Settings>, force = false): Promise<void> {
    const lifecycle = this.lifecycles.get(action.id);
    if (!lifecycle) return Promise.resolve();
    if (lifecycle.preparing) {
      lifecycle.pending = true;
      lifecycle.force ||= force;
      return Promise.resolve();
    }
    if (lifecycle.inFlight) {
      lifecycle.pending = true;
      lifecycle.force ||= force;
      return lifecycle.inFlight;
    }

    lifecycle.force = force;
    const request = this.runRefreshes(action, lifecycle).finally(() => {
      if (lifecycle.inFlight === request) lifecycle.inFlight = undefined;
    });
    lifecycle.inFlight = request;
    return request;
  }

  protected abstract updateDisplay(
    action: DialAction<Settings>,
    isCurrent: () => boolean,
    force: boolean,
  ): Promise<void>;

  protected lifecycleGuard(action: DialAction<Settings>): () => boolean {
    const lifecycle = this.lifecycles.get(action.id);
    if (!lifecycle) return () => false;
    const generation = lifecycle?.generation;
    return () => this.lifecycles.get(action.id) === lifecycle && lifecycle?.generation === generation;
  }

  protected hasActiveLifecycle(action: DialAction<Settings>): boolean {
    return this.lifecycles.has(action.id);
  }

  protected appearanceGuard(action: DialAction<Settings>): () => boolean {
    const appearanceEpoch = this.lifecycles.get(action.id)?.appearanceEpoch;
    if (appearanceEpoch === undefined) return () => false;
    return () => this.lifecycles.get(action.id)?.appearanceEpoch === appearanceEpoch;
  }

  private async runRefreshes(
    action: DialAction<Settings>,
    lifecycle: RefreshLifecycle<Settings>,
  ): Promise<void> {
    do {
      lifecycle.pending = false;
      const force = lifecycle.force;
      lifecycle.force = false;
      const generation = lifecycle.generation;
      try {
        await this.updateDisplay(
          action,
          () => this.lifecycles.get(action.id) === lifecycle && lifecycle.generation === generation,
          force,
        );
      } catch {
        streamDeck.logger.error("action=refresh state=unavailable");
      }
    } while (lifecycle.pending && this.lifecycles.get(action.id) === lifecycle);
  }

  private clearTimer(contextId: string): void {
    const timer = this.timers.get(contextId);
    if (timer) this.scheduler.clearInterval(timer);
    this.timers.delete(contextId);
  }

  protected configureAlternation(
    action: DialAction<Settings>,
    intervalMs: number,
  ): void {
    this.clearAlternationTimer(action.id);
    const lifecycle = this.lifecycles.get(action.id);
    if (!lifecycle) return;
    lifecycle.showCountdown = false;
    const timer = setInterval(() => {
      const lc = this.lifecycles.get(action.id);
      if (!lc) return;
      lc.showCountdown = !lc.showCountdown;
      void this.onAlternationTick(action, lc.showCountdown);
    }, intervalMs);
    this.alternationTimers.set(action.id, timer);
  }

  protected onAlternationTick(
    _action: DialAction<Settings>,
    _showCountdown: boolean,
  ): Promise<void> {
    return Promise.resolve();
  }

  private clearAlternationTimer(contextId: string): void {
    const timer = this.alternationTimers.get(contextId);
    if (timer) clearInterval(timer);
    this.alternationTimers.delete(contextId);
  }
}

const defaultScheduler: RefreshScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
};
