export const GROK_ACP_METHODS = ["initialize", "x.ai/billing"] as const;

export type GrokAcpMethod = (typeof GROK_ACP_METHODS)[number];

export interface GrokAcpRequest {
  readonly id: number;
  readonly method: GrokAcpMethod;
  readonly params: Readonly<Record<string, unknown>>;
}

const allowedMethods = new Set<string>(GROK_ACP_METHODS);
export const GROK_ACP_MAX_REQUEST_FRAME_BYTES = 1024;

const wireMethods: Readonly<Record<GrokAcpMethod, string>> = {
  initialize: "initialize",
  "x.ai/billing": "_x.ai/billing",
};

const initializationParams = {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "streamdeck-ai-usage", version: "1.0" },
} as const;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function hasExactInitializationParams(value: unknown): boolean {
  return (
    hasExactKeys(value, ["protocolVersion", "clientCapabilities", "clientInfo"]) &&
    value.protocolVersion === 1 &&
    hasExactKeys(value.clientCapabilities, []) &&
    hasExactKeys(value.clientInfo, ["name", "version"]) &&
    value.clientInfo.name === initializationParams.clientInfo.name &&
    value.clientInfo.version === initializationParams.clientInfo.version
  );
}

/** Serializes one allowlisted ACP request as a newline-delimited JSON-RPC frame. */
export function encodeGrokAcpRequest(request: GrokAcpRequest): string {
  if (!hasExactKeys(request, ["id", "method", "params"])) {
    throw new TypeError("Invalid ACP request fields");
  }
  if (!Number.isSafeInteger(request.id) || request.id < 1) {
    throw new TypeError("Invalid ACP request id");
  }
  if (!allowedMethods.has(request.method)) {
    throw new TypeError("ACP method is not allowlisted");
  }
  if (
    (request.method === "initialize" && !hasExactInitializationParams(request.params)) ||
    (request.method === "x.ai/billing" && !hasExactKeys(request.params, []))
  ) {
    throw new TypeError("Invalid ACP method params");
  }

  const frame = `${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    method: wireMethods[request.method],
    params: request.params,
  })}\n`;
  if (Buffer.byteLength(frame, "utf8") > GROK_ACP_MAX_REQUEST_FRAME_BYTES) {
    throw new RangeError("ACP request frame exceeds size limit");
  }
  return frame;
}

export function createGrokInitializationRequest(id: number): GrokAcpRequest {
  return {
    id,
    method: "initialize",
    params: initializationParams,
  };
}

export function createGrokBillingRequest(id: number): GrokAcpRequest {
  return { id, method: "x.ai/billing", params: {} };
}

export function encodeGrokInitializedNotification(): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`;
}
