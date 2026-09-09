import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  cancellableCommand,
  hardDeadlineCommand,
  type CancellableCommand,
  type CommandExecution,
} from "../../cancellable-command.js";
import {
  UsageProviderError,
  sanitizeUsageError,
  type UsageProvider,
  type UsageProviderResult,
  type UsageWindow,
} from "../../usage/provider.js";

const CLAUDE_USAGE_ARGS = [
  "-p",
  "/usage",
  "--tools",
  "",
  "--output-format",
  "json",
] as const;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

export interface ClaudeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface ClaudeCommandOptions {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export type ClaudeCommandRunner = (
  executable: string,
  args: readonly string[],
  options: ClaudeCommandOptions,
) => CommandExecution<ClaudeCommandResult>;

export interface ClaudeExecutableIdentity {
  readonly candidate: string;
  readonly executable: string;
  readonly dev: number;
  readonly ino: number;
}

export interface TrustedExecutablePolicy {
  readonly uid?: number;
  readonly platform?: NodeJS.Platform;
  readonly homebrewPrefixes?: readonly string[];
  readonly adminGid?: number;
}

export type ClaudeExecutableResolver = (
  candidate: string,
) => Promise<ClaudeExecutableIdentity | undefined>;
export type ClaudeExecutableValidator = (
  identity: ClaudeExecutableIdentity,
) => Promise<boolean>;

export interface ClaudeUsageProviderOptions {
  readonly runCommand?: ClaudeCommandRunner;
  readonly resolveExecutable?: ClaudeExecutableResolver;
  readonly validateExecutable?: ClaudeExecutableValidator;
  readonly executableCandidates?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
}

export class ClaudeUsageProvider implements UsageProvider {
  readonly id = "claude";
  private readonly runCommand: ClaudeCommandRunner;
  private readonly resolveExecutable: ClaudeExecutableResolver;
  private readonly validateExecutable: ClaudeExecutableValidator;
  private readonly executableCandidates: readonly string[];
  private readonly environment: Readonly<Record<string, string>>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly activeCommands = new Set<CancellableCommand<ClaudeCommandResult>>();
  private generation = 0;
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(options: ClaudeUsageProviderOptions = {}) {
    this.runCommand = options.runCommand ?? runCommand;
    this.resolveExecutable = options.resolveExecutable ?? resolveTrustedClaudeExecutable;
    this.validateExecutable = options.validateExecutable ?? validateTrustedClaudeExecutable;
    this.executableCandidates = options.executableCandidates ?? [
      join(homedir(), ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
    ];
    this.environment = options.environment ?? claudeEnvironment();
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    this.maxStdoutBytes = Math.max(1, options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES);
  }

  async getUsage(): Promise<UsageProviderResult> {
    if (this.stopped) return failure("stopped");
    const generation = this.generation;
    try {
      for (const candidate of this.executableCandidates) {
        const identity = await this.resolveExecutable(candidate);
        if (!this.isCurrent(generation)) return failure(this.stopped ? "stopped" : "unavailable");
        if (!identity || !await this.validateExecutable(identity)) continue;
        if (!this.isCurrent(generation)) return failure(this.stopped ? "stopped" : "unavailable");
        try {
          const command = cancellableCommand(this.runCommand(identity.executable, CLAUDE_USAGE_ARGS, {
            timeoutMs: this.timeoutMs,
            maxStdoutBytes: this.maxStdoutBytes,
            env: this.environment,
          }));
          this.activeCommands.add(command);
          let response: ClaudeCommandResult;
          try {
            response = await command.result;
          } finally {
            this.activeCommands.delete(command);
          }
          if (!this.isCurrent(generation)) return failure(this.stopped ? "stopped" : "unavailable");
          if (response.exitCode !== 0) return failure("unavailable");
          if (Buffer.byteLength(response.stdout, "utf8") > this.maxStdoutBytes) {
            return failure("invalid-response");
          }
          const windows = parseClaudeUsage(response.stdout);
          if (!windows) return failure("invalid-response");
          return { ok: true, usage: { windows, observedAt: this.now() } };
        } catch (error) {
          if (!this.isCurrent(generation)) return failure(this.stopped ? "stopped" : "unavailable");
          if (isTimeout(error)) return failure("timeout");
          if (isMaxBufferError(error)) return failure("invalid-response");
          return failure("unavailable");
        }
      }
      return failure("executable-not-found");
    } catch (error) {
      return { ok: false, error: sanitizeUsageError(error) };
    }
  }

  recoverAfterWake(): void {
    if (this.stopped) return;
    this.generation += 1;
    this.cancelActiveCommands();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.generation += 1;
    const active = [...this.activeCommands];
    for (const command of active) command.cancel();
    this.stopping = Promise.allSettled(active.map(({ result }) => result)).then(() => undefined);
    return this.stopping;
  }

  stopImmediately(): void {
    this.stopped = true;
    this.generation += 1;
    this.cancelActiveCommands();
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private cancelActiveCommands(): void {
    for (const command of this.activeCommands) command.cancel();
  }
}

export async function resolveTrustedClaudeExecutable(
  candidate: string,
  policy: TrustedExecutablePolicy = {},
): Promise<ClaudeExecutableIdentity | undefined> {
  if (!isAbsolute(candidate)) return undefined;
  try {
    const resolved = await realpath(candidate);
    if (!isAbsolute(resolved)) return undefined;
    const metadata = await stat(resolved);
    if (!isTrustedExecutableMetadata(metadata, policy) || !await hasTrustedParentChains(candidate, resolved, policy)) {
      return undefined;
    }
    await access(resolved, constants.X_OK);
    return { candidate, executable: resolved, dev: metadata.dev, ino: metadata.ino };
  } catch {
    return undefined;
  }
}

export async function validateTrustedClaudeExecutable(
  identity: ClaudeExecutableIdentity,
  policy: TrustedExecutablePolicy = {},
): Promise<boolean> {
  try {
    const candidateTarget = await realpath(identity.candidate);
    const executableTarget = await realpath(identity.executable);
    if (candidateTarget !== identity.executable || executableTarget !== identity.executable) {
      return false;
    }
    const metadata = await stat(identity.executable);
    if (
      metadata.dev !== identity.dev
      || metadata.ino !== identity.ino
      || !isTrustedExecutableMetadata(metadata, policy)
      || !await hasTrustedParentChains(identity.candidate, identity.executable, policy)
    ) return false;
    await access(identity.executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isTrustedExecutableMetadata(metadata: Stats, policy: TrustedExecutablePolicy): boolean {
  const uid = policy.uid ?? process.getuid?.();
  return metadata.isFile()
    && uid !== undefined
    && (metadata.uid === uid || metadata.uid === 0)
    && (metadata.mode & 0o022) === 0;
}

async function hasTrustedParentChains(
  candidate: string,
  executable: string,
  policy: TrustedExecutablePolicy,
): Promise<boolean> {
  const candidateParent = await realpath(dirname(candidate));
  const executableParent = await realpath(dirname(executable));
  return await hasTrustedDirectoryChain(candidateParent, policy)
    && (candidateParent === executableParent || await hasTrustedDirectoryChain(executableParent, policy));
}

async function hasTrustedDirectoryChain(start: string, policy: TrustedExecutablePolicy): Promise<boolean> {
  let directory = start;
  while (true) {
    const metadata = await stat(directory);
    const uid = policy.uid ?? process.getuid?.();
    if (
      !metadata.isDirectory()
      || uid === undefined
      || (metadata.uid !== uid && metadata.uid !== 0)
      || !isTrustedDirectoryMode(directory, metadata, uid, policy)
    ) return false;
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

function isTrustedDirectoryMode(
  directory: string,
  metadata: Stats,
  uid: number,
  policy: TrustedExecutablePolicy,
): boolean {
  if ((metadata.mode & 0o002) !== 0) return false;
  if ((metadata.mode & 0o020) === 0) return true;
  return isTrustedHomebrewDirectory(directory, metadata, { ...policy, uid });
}

export function isTrustedHomebrewDirectory(
  directory: string,
  metadata: Pick<Stats, "uid" | "gid" | "mode">,
  policy: TrustedExecutablePolicy = {},
): boolean {
  const uid = policy.uid ?? process.getuid?.();
  const platform = policy.platform ?? process.platform;
  const adminGid = policy.adminGid ?? 80;
  const prefixes = policy.homebrewPrefixes ?? ["/opt/homebrew", "/usr/local"];
  if (platform !== "darwin" || uid === undefined || metadata.uid !== uid || metadata.gid !== adminGid
    || (metadata.mode & 0o020) === 0 || (metadata.mode & 0o002) !== 0) return false;
  // macOS admin (gid 80) members already hold local administrative authority; no other writable group is trusted.
  return prefixes.some((prefix) => {
    const fromPrefix = relative(prefix, directory);
    return fromPrefix === "" || (!fromPrefix.startsWith("..") && !isAbsolute(fromPrefix));
  });
}

function claudeEnvironment(): Readonly<Record<string, string>> {
  const username = userInfo().username;
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: FIXED_PATH,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    USER: username,
    LOGNAME: username,
    SHELL: "/bin/zsh",
    TERM: "dumb",
  };
  for (const name of ["TMPDIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function runCommand(
  executable: string,
  args: readonly string[],
  options: ClaudeCommandOptions,
): CancellableCommand<ClaudeCommandResult> {
  return hardDeadlineCommand(options.timeoutMs, ({ resolve, reject }) => execFile(executable, [...args], {
      encoding: "utf8",
      env: { ...options.env },
      maxBuffer: options.maxStdoutBytes,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      shell: false,
    }, (error, stdout) => {
      if (error) {
        if (typeof error.code === "number") resolve({ exitCode: error.code, stdout });
        else reject(error);
        return;
      }
      resolve({ exitCode: 0, stdout });
    }));
}

function parseClaudeUsage(
  stdout: string,
): Partial<Record<"session" | "week", UsageWindow>> | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || typeof payload.result !== "string" || !hasZeroInference(payload)) {
    return undefined;
  }

  const windows: Partial<Record<"session" | "week", UsageWindow>> = {};
  for (const line of payload.result.split(/\r?\n/)) {
    const session = /^\s*Current session:\s*(\d+(?:\.\d+)?)% used(?:\s|$)/.exec(line);
    if (session) windows.session = parseWindow(session[1]!);
    const week = /^\s*Current week \(all models\):\s*(\d+(?:\.\d+)?)% used(?:\s|$)/.exec(line);
    if (week) windows.week = parseWindow(week[1]!);
  }
  return windows.session && windows.week ? windows : undefined;
}

function parseWindow(value: string): UsageWindow | undefined {
  const usedPercent = Number(value);
  return Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
    ? { usedPercent }
    : undefined;
}

function hasZeroInference(payload: Record<string, unknown>): boolean {
  if (
    payload.num_turns !== 0
    || payload.duration_api_ms !== 0
    || payload.total_cost_usd !== 0
    || !isRecord(payload.usage)
    || !isRecord(payload.modelUsage)
    || Object.keys(payload.modelUsage).length !== 0
  ) return false;
  const totals = hasOnlyZeroUsageTotals(payload.usage);
  return totals.valid && totals.found;
}

function hasOnlyZeroUsageTotals(value: Record<string, unknown>): { valid: boolean; found: boolean } {
  let found = false;
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("_tokens") || key.endsWith("_requests")) {
      if (typeof item !== "number" || !Number.isFinite(item) || item !== 0) {
        return { valid: false, found: true };
      }
      found = true;
    } else if (isRecord(item)) {
      const nested = hasOnlyZeroUsageTotals(item);
      if (!nested.valid) return nested;
      found ||= nested.found;
    }
  }
  return { valid: true, found };
}

function failure(code: ConstructorParameters<typeof UsageProviderError>[0]): UsageProviderResult {
  return { ok: false, error: new UsageProviderError(code) };
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isTimeout(error: unknown): boolean {
  return errorCode(error) === "ETIMEDOUT" || (isRecord(error) && error.killed === true);
}

function isMaxBufferError(error: unknown): boolean {
  return errorCode(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
