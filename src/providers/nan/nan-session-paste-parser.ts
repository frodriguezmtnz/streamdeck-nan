import type { BrowserCookieRecord } from "./nan-dashboard-session-store.js";

export const NAN_SESSION_PASTE_MAX_BYTES = 8 * 1024;
export const NAN_SESSION_PASTE_TARGET_DOMAIN = "cloud-api.nan.builders";

const MAX_COOKIES = 32;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[!#$%&'()*+\-./0-9:<=>?@A-Z\[\]^_`a-z{|}~]*$/;
const COOKIE_PREFIX = /^\s*cookie\s*:\s*/i;
const COOKIE_FLAG = /(?:^|\s)(?:-b|--cookie)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i;
const HEADER_FLAG = /(?:^|\s)(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gi;

/** Parses a pasted Cookie header or a browser "Copy as cURL" command into scoped session records. */
export function parsePastedSession(raw: string): BrowserCookieRecord[] | null {
  if (typeof raw !== "string") return null;
  if (Buffer.byteLength(raw, "utf8") > NAN_SESSION_PASTE_MAX_BYTES) return null;
  const header = extractHeader(raw);
  if (!header) return null;
  const records = new Map<string, BrowserCookieRecord>();
  for (const segment of header.split(";")) {
    const pair = segment.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) return null;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) return null;
    records.set(name, { name, value, domain: NAN_SESSION_PASTE_TARGET_DOMAIN, hostOnly: true, path: "/", secure: true, expiresAt: null });
  }
  if (records.size === 0 || records.size > MAX_COOKIES) return null;
  return [...records.values()];
}

function extractHeader(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const cookieFlag = COOKIE_FLAG.exec(text);
  if (cookieFlag) return cookieFlag[1] ?? cookieFlag[2] ?? cookieFlag[3] ?? null;
  for (const match of text.matchAll(HEADER_FLAG)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (COOKIE_PREFIX.test(value)) return value.replace(COOKIE_PREFIX, "");
  }
  if (/^curl\s/i.test(text)) return null;
  return text.replace(COOKIE_PREFIX, "");
}
