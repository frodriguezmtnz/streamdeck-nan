import { action, type KeyDownEvent, SingletonAction, streamDeck } from "@elgato/streamdeck";

type NanDashboardLauncherSettings = Record<string, never>;
const DASHBOARD_URL = "https://cloud.nan.builders/dashboard";
const OPEN_FAILED_WARNING = "NaN Dashboard could not be opened.";

/** Keypad-only launcher for the NaN Dashboard; it owns no settings or dashboard lifecycle. */
@action({ UUID: "com.refactor-ia.nan.nan-dashboard" })
export class NanDashboardLauncher extends SingletonAction<NanDashboardLauncherSettings> {
  override async onKeyDown(ev: KeyDownEvent<NanDashboardLauncherSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    try {
      await streamDeck.system.openUrl(DASHBOARD_URL);
    } catch {
      streamDeck.logger.warn(OPEN_FAILED_WARNING);
    }
  }
}
