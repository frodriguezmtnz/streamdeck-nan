import { streamDeck } from "@elgato/streamdeck";
import { createNanCapabilitiesResult, nanCapabilities, parseNanCapabilitiesMessage } from "./nan-capabilities-message.js";

/** Answers an exact capabilities probe for the current inspector; returns whether the payload was claimed. */
export async function respondToNanCapabilities(actionId: string, payload: unknown): Promise<boolean> {
  const request = parseNanCapabilitiesMessage(payload);
  if (!request) return false;
  if (streamDeck.ui.action?.id !== actionId) return true;
  try {
    await streamDeck.ui.sendToPropertyInspector(createNanCapabilitiesResult(request.requestId, nanCapabilities()));
  } catch {}
  return true;
}
