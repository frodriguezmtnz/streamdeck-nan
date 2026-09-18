import { NanDpapiClient } from "./nan-dpapi-client.js";
import { NanKeychainClient } from "./nan-keychain-client.js";

export interface SessionSecretStore {
  getSessionCache(): Promise<string | null>;
  putSessionCache(secret: string): Promise<void>;
  deleteSessionCache(): Promise<void>;
}

export function createSessionSecretStore(platform: NodeJS.Platform = process.platform): SessionSecretStore {
  if (platform === "darwin") return new NanKeychainClient();
  if (platform === "win32") return new NanDpapiClient();
  throw new Error("Session secret store unavailable on this platform");
}
