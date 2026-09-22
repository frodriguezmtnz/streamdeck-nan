import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  streamDeck,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { NanDashboardController, type NanDashboardUsage } from "./nan-dashboard-controller.js";
import { renderNanMetricsUsageImage, type NanMetricsPeriod } from "./nan-metrics-feedback.js";
import { createImportChromeSessionResult, parseImportChromeSessionMessage, type ImportChromeSessionRequest } from "./nan-chrome-import-message.js";
import { respondToNanCapabilities } from "./nan-capabilities-responder.js";
import { createSaveSessionResult, parseSaveSessionMessage, type SaveSessionRequest } from "./nan-save-session-message.js";

type NanMetricsSettings = Record<string, never>;
type VisibleMetricsAction = { readonly action: KeyAction<NanMetricsSettings>; disposeWatch: () => void };

/** Shared keypad lifecycle for server aggregate metrics; it never creates a per-key timer. */
abstract class NanMetricsUsage extends SingletonAction<NanMetricsSettings> {
  private readonly visible = new Map<string, VisibleMetricsAction>();
  private readonly dashboard: NanDashboardController;
  private readonly period: NanMetricsPeriod;

  protected constructor(dashboard: NanDashboardController, period: NanMetricsPeriod) {
    super();
    this.period = period;
    this.dashboard = dashboard;
    this.dashboard.subscribe((usage) => { void this.redrawVisible(usage); });
  }

  override async onWillAppear(ev: WillAppearEvent<NanMetricsSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const existing = this.visible.get(ev.action.id);
    existing?.disposeWatch();
    const entry: VisibleMetricsAction = { action: ev.action, disposeWatch: this.dashboard.watchDashboard() };
    this.visible.set(ev.action.id, entry);
    await this.render(entry, this.dashboard.getCachedUsage({ source: "dashboard" }));
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NanMetricsSettings>): Promise<void> {
    if (ev.action.isKey() && this.isCurrent(ev.action)) await this.render(this.visible.get(ev.action.id)!, this.dashboard.getCachedUsage({ source: "dashboard" }));
  }

  override async onKeyDown(ev: KeyDownEvent<NanMetricsSettings>): Promise<void> {
    if (!ev.action.isKey() || !this.isCurrent(ev.action)) return;
    // A keypress remains an explicit fresh read even while the shared visibility watch is active.
    await this.dashboard.getUsage({ source: "dashboard" });
  }

  override async onSendToPlugin(ev: SendToPluginEvent<any, NanMetricsSettings>): Promise<void> {
    if (!ev.action.isKey() || !this.isCurrent(ev.action)) return;
    if (await respondToNanCapabilities(ev.action.id, ev.payload)) return;
    const importRequest = parseImportChromeSessionMessage(ev.payload);
    const saveRequest = importRequest === undefined ? parseSaveSessionMessage(ev.payload) : undefined;
    if (!importRequest && !saveRequest) return;
    let outcome: "ready" | "failed" | "busy" = "failed";
    try {
      const result = importRequest
        ? await this.dashboard.importChromeSession()
        : await this.dashboard.saveSession(saveRequest!.value);
      outcome = result.state === "ready" ? "ready" : result.state === "import-busy" ? "busy" : "failed";
    } catch {}
    if (importRequest) await this.sendImportResult(ev.action, importRequest, outcome);
    else if (saveRequest) await this.sendSaveResult(ev.action, saveRequest, outcome);
  }

  override onWillDisappear(ev: WillDisappearEvent<NanMetricsSettings>): void {
    const entry = this.visible.get(ev.action.id);
    if (!entry || entry.action !== ev.action) return;
    this.visible.delete(ev.action.id);
    entry.disposeWatch();
  }

  private isCurrent(action: KeyAction<NanMetricsSettings>): boolean {
    return this.visible.get(action.id)?.action === action;
  }

  private async sendImportResult(
    action: KeyAction<NanMetricsSettings>,
    request: ImportChromeSessionRequest,
    outcome: "ready" | "failed" | "busy",
  ): Promise<void> {
    if (!("requestId" in request) || !this.isCurrent(action) || streamDeck.ui.action?.id !== action.id) return;
    try {
      await streamDeck.ui.sendToPropertyInspector(createImportChromeSessionResult(request.requestId, outcome));
    } catch {}
  }

  private async sendSaveResult(
    action: KeyAction<NanMetricsSettings>,
    request: SaveSessionRequest,
    outcome: "ready" | "failed" | "busy",
  ): Promise<void> {
    if (!this.isCurrent(action) || streamDeck.ui.action?.id !== action.id) return;
    try {
      await streamDeck.ui.sendToPropertyInspector(createSaveSessionResult(request.requestId, outcome));
    } catch {}
  }

  private async redrawVisible(usage: NanDashboardUsage): Promise<void> {
    await Promise.all([...this.visible.values()].map((entry) => this.render(entry, usage)));
  }

  private async render(entry: VisibleMetricsAction, usage: NanDashboardUsage): Promise<void> {
    if (this.visible.get(entry.action.id) !== entry) return;
    await entry.action.setImage(renderNanMetricsUsageImage(usage, this.period));
  }
}

@action({ UUID: "com.refactor-ia.nan.nan-total-tokens" })
export class NanTotalTokensUsage extends NanMetricsUsage {
  constructor(dashboard: NanDashboardController) { super(dashboard, "allTime"); }
}

@action({ UUID: "com.refactor-ia.nan.nan-monthly-tokens" })
export class NanMonthlyTokensUsage extends NanMetricsUsage {
  constructor(dashboard: NanDashboardController) { super(dashboard, "monthToDate"); }
}
