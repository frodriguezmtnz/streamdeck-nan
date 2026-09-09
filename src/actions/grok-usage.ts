import {
  action,
  type DialAction,
  DidReceiveSettingsEvent,
  TouchTapEvent,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { GrokUsageProvider } from "../providers/grok/grok-usage-provider.js";
import { RefreshingAction, type RefreshSettings } from "../refreshing-action.js";
import { UsageProviderCoordinator } from "../usage/provider-coordinator.js";
import type { CoordinatedUsageResult } from "../usage/provider-coordinator.js";
import { renderGrokFeedback } from "./usage-feedback.js";

@action({ UUID: "com.barbatdev.ai-usage.grok" })
export class GrokUsage extends RefreshingAction {
  private readonly coordinator: UsageProviderCoordinator;
  private lastResult: CoordinatedUsageResult | null = null;

  constructor(coordinator = new UsageProviderCoordinator(new GrokUsageProvider())) {
    super();
    this.coordinator = coordinator;
  }

  override async onWillAppear(ev: WillAppearEvent<RefreshSettings>): Promise<void> {
    const action = ev.action;
    if (!action.isDial()) return;
    await this.activateOnAppearance(
      action,
      ev.payload.settings,
      () => action.setFeedbackLayout("layouts/grok.json"),
    );
  }

  override async onTouchTap(ev: TouchTapEvent<RefreshSettings>): Promise<void> {
    await this.refresh(ev.action);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<RefreshSettings>,
  ): Promise<void> {
    if (!ev.action.isDial()) return;
    this.configureRefresh(ev.action, ev.payload.settings);
    await this.refresh(ev.action);
  }

  protected override async updateDisplay(
    action: Parameters<RefreshingAction["refresh"]>[0],
    isCurrent: () => boolean,
    force: boolean,
  ): Promise<void> {
    this.lastResult = await this.coordinator.getUsage({ force });
    const hasResetsAt = Boolean(this.lastResult.ok && this.lastResult.usage.windows.session?.resetsAt);
    if (hasResetsAt) this.configureAlternation(action, 3_000);
    const feedback = renderGrokFeedback(this.lastResult, false);
    if (isCurrent()) await action.setFeedback(feedback);
  }

  protected override async onAlternationTick(
    action: DialAction<RefreshSettings>,
    showCountdown: boolean,
  ): Promise<void> {
    if (!this.lastResult) return;
    const feedback = renderGrokFeedback(this.lastResult, showCountdown);
    const isCurrent = this.lifecycleGuard(action);
    if (isCurrent()) await action.setFeedback(feedback);
  }
}
