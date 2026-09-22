export const SAVE_SESSION_KIND = "nan.saveSession.v1";
export const SAVE_SESSION_RESULT_KIND = "nan.saveSession.result.v1";
export const SAVE_SESSION_MAX_BYTES = 8 * 1024;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export type SaveSessionOutcome = "ready" | "failed" | "busy";

export type SaveSessionRequest = {
  readonly kind: typeof SAVE_SESSION_KIND;
  readonly requestId: string;
  readonly value: string;
};

export type SaveSessionResult = {
  readonly kind: typeof SAVE_SESSION_RESULT_KIND;
  readonly requestId: string;
  readonly outcome: SaveSessionOutcome;
};

/** Accepts only an exact, bounded, correlated paste request before any session parsing. */
export function parseSaveSessionMessage(payload: unknown): SaveSessionRequest | undefined {
  if (typeof payload !== "object" || payload === null || Object.keys(payload).length !== 3) return undefined;
  const { kind, requestId, value } = payload as { kind?: unknown; requestId?: unknown; value?: unknown };
  if (kind !== SAVE_SESSION_KIND || typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > SAVE_SESSION_MAX_BYTES) return undefined;
  if (DISALLOWED_CONTROL.test(value)) return undefined;
  return { kind: SAVE_SESSION_KIND, requestId, value };
}

export function createSaveSessionResult(requestId: string, outcome: SaveSessionOutcome): SaveSessionResult {
  return { kind: SAVE_SESSION_RESULT_KIND, requestId, outcome };
}
