import type { NanDashboardUsage } from "./nan-dashboard-controller.js";

export type NanMetricsPeriod = "allTime" | "monthToDate";

const COLORS = { bg: "#06080f", fg: "#f3f6f9", blue: "#7fb4ca", gold: "#dfbd76", green: "#b7cc85", rose: "#cb7c94" } as const;

type MetricsDisplay = {
  readonly title: string;
  readonly value: string;
  readonly unit: string;
  readonly status: "" | "NO DATA" | "STALE" | "METRICS ERROR";
  readonly accent: string;
};

/** Renders server-authoritative aggregate tokens on the standard 72px keypad canvas. */
export function renderNanMetricsUsageImage(state: NanDashboardUsage, period: NanMetricsPeriod): string {
  return `data:image/svg+xml,${encodeURIComponent(renderNanMetricsUsageSvg(state, period))}`;
}

export function renderNanMetricsUsageSvg(state: NanDashboardUsage, period: NanMetricsPeriod): string {
  const display = metricsDisplay(state, period);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="NaN ${display.title.toLowerCase()}">
  <rect width="72" height="72" rx="6" fill="${COLORS.bg}"/><rect x="6" y="4" width="60" height="1" fill="${COLORS.blue}"/>
  ${text("NaN", 6, 16, COLORS.fg, 9)}${text(display.title, 6, 26, COLORS.fg, 8)}
  ${text(display.value, 6, 45, display.accent, 18)}${text(display.unit, 6, 56, COLORS.fg, 7)}
  <rect x="6" y="61" width="60" height="2" rx="1" fill="#202633"/>${text(display.status || "LIVE", 6, 70, display.status ? COLORS.rose : COLORS.green, 7)}</svg>`;
}

function metricsDisplay(state: NanDashboardUsage, period: NanMetricsPeriod): MetricsDisplay {
  const title = period === "allTime" ? "TOTAL TOKENS" : "MONTHLY TOKENS";
  const unit = period === "allTime" ? "ALL TIME · TOKENS" : "MONTH TO DATE · TOKENS";
  const window = state.metrics?.[period];
  if (!window) {
    const status = state.metricsError ? "METRICS ERROR" : "NO DATA";
    return { title, value: "--", unit: "DASHBOARD METRICS", status, accent: status === "METRICS ERROR" ? COLORS.rose : COLORS.gold };
  }
  const stale = state.stale || state.metricsStale === true;
  return { title, value: compact(window.totalTokens), unit, status: stale ? "STALE" : "", accent: stale ? COLORS.gold : COLORS.blue };
}

function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function text(value: string, x: number, y: number, fill: string, size: number): string {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="Arial,sans-serif" font-size="${size}" font-weight="700">${escapeXml(value)}</text>`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}
