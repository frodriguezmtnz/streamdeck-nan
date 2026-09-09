export const NAN_DASHBOARD_QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
export const NAN_DASHBOARD_METRICS_URL = "https://cloud-api.nan.builders/api/metrics/usage";

const RESOURCE_URLS = {
  quota: NAN_DASHBOARD_QUOTA_URL,
  metrics: NAN_DASHBOARD_METRICS_URL,
} as const;
const MAX_COOKIE_HEADER_BYTES = 4 * 1024;
const TIMEOUT_MS = 5_000;

/** The caller supplies a freshly scoped Cookie header for this literal resource path. */
export type NanDashboardHttpResource = keyof typeof RESOURCE_URLS;
export type NanDashboardHttpErrorKind = "auth-rejected" | "transport" | "schema";

export interface NanDashboardHttpClock {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: NanDashboardHttpClock = { setTimeout, clearTimeout };

export interface NanDashboardHttpOptions<E extends Error> {
  readonly resource: NanDashboardHttpResource;
  readonly cookieHeader: string;
  readonly fetcher?: typeof fetch;
  readonly clock?: NanDashboardHttpClock;
  readonly maxResponseBytes: number;
  readonly createError: (kind: NanDashboardHttpErrorKind) => E;
  readonly isExpectedError: (error: unknown) => error is E;
}

/**
 * Fixed-route dashboard transport. It intentionally has no arbitrary endpoint API:
 * quota and metrics are the only resources whose supplied Cookie header it sends.
 */
export async function getNanDashboardJson<E extends Error>(options: NanDashboardHttpOptions<E>): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const clock = options.clock ?? systemClock;
  if (!isSafeCookieHeader(options.cookieHeader)) throw options.createError("transport");
  const controller = new AbortController();
  const timer = clock.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await abortable(fetcher(RESOURCE_URLS[options.resource], {
      method: "GET",
      headers: { cookie: options.cookieHeader },
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    }), controller.signal, options.createError);
    if (response.status === 401 || response.status === 403 || response.redirected
      || response.status >= 300 && response.status < 400) {
      safeCancel(response.body);
      throw options.createError("auth-rejected");
    }
    if (!response.ok) {
      safeCancel(response.body);
      throw options.createError("transport");
    }
    return await readJson(response, controller.signal, options.maxResponseBytes, options.createError);
  } catch (error) {
    if (options.isExpectedError(error)) throw error;
    throw options.createError("transport");
  } finally {
    clock.clearTimeout(timer);
  }
}

async function readJson<E extends Error>(response: Response, signal: AbortSignal, maxResponseBytes: number, createError: (kind: NanDashboardHttpErrorKind) => E): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxResponseBytes) {
    safeCancel(response.body);
    throw createError("transport");
  }
  if (!response.body) throw createError("transport");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal, createError);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) throw createError("transport");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw createError("schema");
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function abortable<T, E extends Error>(promise: Promise<T>, signal: AbortSignal, createError: (kind: NanDashboardHttpErrorKind) => E): Promise<T> {
  if (signal.aborted) return Promise.reject(createError("transport"));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(createError("transport"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function safeCancel(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => undefined);
}

function isSafeCookieHeader(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_COOKIE_HEADER_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
