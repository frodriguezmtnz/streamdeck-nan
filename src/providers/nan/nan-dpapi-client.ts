import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runNanKeychain,
  type NanKeychainResult,
  type NanKeychainRunner,
} from "./nan-keychain-client.js";

export const NAN_DPAPI_TIMEOUT_MS = 10_000;
export const NAN_DPAPI_MAX_STDIN_BYTES = 8 * 1024;
const NAN_DPAPI_MAX_STDOUT_BYTES = 8 * 1024;
const NAN_DPAPI_ENVIRONMENT_NAMES = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "COMSPEC",
  "PATHEXT",
  "PSModuleAnalysisCachePath",
] as const;

export function resolveNanDpapiHelperPath(moduleUrl: string): string {
  return fileURLToPath(new URL("./nan-dpapi.ps1", moduleUrl));
}

export function resolvePowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function dpapiEnvironment(source: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of NAN_DPAPI_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export class NanDpapiClient {
  private readonly run: NanKeychainRunner;
  private readonly helperPath: string;
  private readonly powerShellPath: string;
  private readonly environment: Readonly<Record<string, string>>;

  constructor(
    run: NanKeychainRunner = runNanKeychain,
    helperPath = resolveNanDpapiHelperPath(import.meta.url),
    powerShellPath = resolvePowerShellPath(),
    environment = dpapiEnvironment(),
  ) {
    this.run = run;
    this.helperPath = helperPath;
    this.powerShellPath = powerShellPath;
    this.environment = environment;
  }

  async putSessionCache(secret: string): Promise<void> {
    await this.request({ operation: "put", secret }, false);
  }

  async getSessionCache(): Promise<string | null> {
    return this.request({ operation: "get" }, true);
  }

  async deleteSessionCache(): Promise<void> {
    await this.request({ operation: "delete" }, false);
  }

  private request(payload: Record<string, unknown>, expectsSecret: true): Promise<string | null>;
  private request(payload: Record<string, unknown>, expectsSecret: false): Promise<void>;
  private async request(payload: Record<string, unknown>, expectsSecret: boolean): Promise<string | null | void> {
    const stdin = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(stdin, "utf8") > NAN_DPAPI_MAX_STDIN_BYTES) throw unavailable();
    let result: NanKeychainResult;
    try {
      result = await this.run({
        executable: this.powerShellPath,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.helperPath],
        stdin,
        timeoutMs: NAN_DPAPI_TIMEOUT_MS,
        maxStdoutBytes: NAN_DPAPI_MAX_STDOUT_BYTES,
        env: this.environment,
      });
    } catch {
      throw unavailable();
    }
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > NAN_DPAPI_MAX_STDOUT_BYTES) throw unavailable();
    let response: unknown;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      throw unavailable();
    }
    if (!isRecord(response) || response.ok !== true) throw unavailable();
    if (!expectsSecret) return;
    if (typeof response.secret !== "string" && response.secret !== null) throw unavailable();
    return response.secret;
  }
}

function unavailable(): Error {
  return new Error("DPAPI helper unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
