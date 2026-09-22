export const NAN_CAPABILITIES_KIND = "nan.capabilities.v1";
export const NAN_CAPABILITIES_RESULT_KIND = "nan.capabilities.result.v1";

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type NanCapabilities = {
  readonly platform: string;
  readonly chromeImport: boolean;
  readonly pasteSession: boolean;
};

export type NanCapabilitiesResult = NanCapabilities & {
  readonly kind: typeof NAN_CAPABILITIES_RESULT_KIND;
  readonly requestId: string;
};

export function nanCapabilities(platform: NodeJS.Platform = process.platform): NanCapabilities {
  const chromeImport = platform === "darwin";
  return { platform, chromeImport, pasteSession: !chromeImport };
}

export function parseNanCapabilitiesMessage(payload: unknown): { readonly requestId: string } | undefined {
  if (typeof payload !== "object" || payload === null || Object.keys(payload).length !== 2) return undefined;
  const { kind, requestId } = payload as { kind?: unknown; requestId?: unknown };
  if (kind !== NAN_CAPABILITIES_KIND || typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return undefined;
  return { requestId };
}

export function createNanCapabilitiesResult(requestId: string, capabilities: NanCapabilities): NanCapabilitiesResult {
  return { kind: NAN_CAPABILITIES_RESULT_KIND, requestId, ...capabilities };
}
