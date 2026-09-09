import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageProviderError } from "../../usage/provider.js";
import {
  resolveTrustedClaudeExecutable,
  validateTrustedClaudeExecutable,
  type ClaudeExecutableIdentity,
} from "../claude/claude-usage-provider.js";

export interface CodexAppServerTransport {
  write(frame: string): void;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (error?: unknown) => void): () => void;
  onExitConfirmed?(listener: () => void): () => void;
  stop(): Promise<void>;
  stopImmediately(): boolean;
}

export type CodexTransportFactory = () => Promise<CodexAppServerTransport>;
export type CodexTransportCreation = Promise<CodexAppServerTransport> & {
  stopImmediately(): boolean;
};

export interface SpawnCodexAppServerOptions {
  readonly spawnProcess?: typeof spawn;
  readonly codexPath?: string;
  readonly executableCandidates?: readonly string[];
  readonly resolveExecutable?: (candidate: string) => Promise<ClaudeExecutableIdentity | undefined>;
  readonly validateExecutable?: (identity: ClaudeExecutableIdentity) => Promise<boolean>;
}

/**
 * Allowed environment variables — same policy as the Grok transport.
 * No tokens, no credentials, no NAN_* vars.
 */
const ALLOWED_ENV = ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME"] as const;
const FIXED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Build a safe environment object from the parent process.
 * Only whitelisted variables are propagated; secrets are excluded.
 */
export function codexSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = FIXED_PATH;
  return env;
}

/**
 * Validate that a path points to a regular executable file with no symlink jumps.
 * Returns the resolved absolute path on success.
 */
export async function validateCodexExecutable(path: string): Promise<string> {
  const identity = await resolveTrustedClaudeExecutable(path);
  if (!identity) throw new Error("Codex path is not a trusted executable");
  return identity.executable;
}

/**
 * Re-validate the executable identity immediately before spawning.
 * This catches symlink replacement or file swap between validation and execution.
 */
async function resolveCodexIdentity(
  candidates: readonly string[],
  resolveExecutable: (candidate: string) => Promise<ClaudeExecutableIdentity | undefined>,
): Promise<ClaudeExecutableIdentity | undefined> {
  for (const candidate of candidates) {
    const identity = await resolveExecutable(candidate);
    if (identity) return identity;
  }
  return undefined;
}

export function spawnCodexAppServer(
  options: SpawnCodexAppServerOptions = {},
): CodexTransportCreation {
  let cancelled = false;
  let transport: ChildProcessTransport | undefined;
  const creation = (async () => {
    const candidates = options.codexPath
      ? [options.codexPath]
      : options.executableCandidates ?? [
        join(homedir(), ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/usr/bin/codex",
      ];
    const identity = await resolveCodexIdentity(candidates, options.resolveExecutable ?? resolveTrustedClaudeExecutable);
    if (cancelled) throw new UsageProviderError("stopped");
    if (!identity || !await (options.validateExecutable ?? validateTrustedClaudeExecutable)(identity)) {
      throw new UsageProviderError("executable-not-found");
    }
    if (cancelled) throw new UsageProviderError("stopped");

    const child = (options.spawnProcess ?? spawn)(identity.executable, ["app-server"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexSafeEnvironment(process.env),
    });
    transport = new ChildProcessTransport(child);
    if (cancelled) {
      transport.stopImmediately();
      throw new UsageProviderError("stopped");
    }
    return await new Promise<CodexAppServerTransport>((resolve, reject) => {
      const onError = (error: unknown): void => {
        transport?.stopImmediately();
        reject(error);
      };
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        if (cancelled) {
          transport?.stopImmediately();
          reject(new UsageProviderError("stopped"));
        } else {
          resolve(transport!);
        }
      });
    });
  })() as CodexTransportCreation;
  creation.stopImmediately = () => {
    cancelled = true;
    return transport?.stopImmediately() ?? true;
  };
  return creation;
}

export interface ChildProcessTransportOptions {
  readonly stopGraceMs?: number;
  readonly killConfirmationMs?: number;
}

export class ChildProcessTransport implements CodexAppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stopGraceMs: number;
  private readonly killConfirmationMs: number;
  private confirmedExit = false;
  private readonly handleChildError = (): void => undefined;
  private readonly handleStdinError = (): void => undefined;
  private readonly confirmExit = (): void => {
    this.confirmedExit = true;
    this.child.off("error", this.handleChildError);
    this.child.stdin.off("error", this.handleStdinError);
  };

  constructor(
    child: ChildProcessWithoutNullStreams,
    options: ChildProcessTransportOptions = {},
  ) {
    this.child = child;
    this.stopGraceMs = Math.max(1, options.stopGraceMs ?? 1_000);
    this.killConfirmationMs = Math.max(1, options.killConfirmationMs ?? 1_000);
    this.confirmedExit = child.exitCode !== null || child.signalCode !== null;
    if (!this.confirmedExit) {
      this.child.on("error", this.handleChildError);
      this.child.stdin.on("error", this.handleStdinError);
      this.child.once("exit", this.confirmExit);
    }
    // Drain diagnostics to prevent backpressure without ever logging their contents.
    this.child.stderr.resume();
  }

  write(frame: string): void {
    this.child.stdin.write(frame);
  }

  onData(listener: (chunk: string) => void): () => void {
    const handler = (chunk: Buffer) => listener(chunk.toString("utf8"));
    this.child.stdout.on("data", handler);
    return () => this.child.stdout.off("data", handler);
  }

  onExit(listener: (error?: unknown) => void): () => void {
    const exitHandler = () => listener();
    const errorHandler = (error: unknown) => listener(error);
    const stdinErrorHandler = (error: unknown) => listener(error);
    this.child.once("exit", exitHandler);
    this.child.once("error", errorHandler);
    this.child.stdin.once("error", stdinErrorHandler);
    return () => {
      this.child.off("exit", exitHandler);
      this.child.off("error", errorHandler);
      this.child.stdin.off("error", stdinErrorHandler);
    };
  }

  onExitConfirmed(listener: () => void): () => void {
    if (this.confirmedExit || this.child.exitCode !== null || this.child.signalCode !== null) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.child.once("exit", listener);
    return () => this.child.off("exit", listener);
  }

  async stop(): Promise<void> {
    if (this.confirmedExit) return;
    await new Promise<void>((resolve, reject) => {
      let confirmationTimeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        this.confirmedExit = true;
        clearTimeout(escalationTimeout);
        if (confirmationTimeout) clearTimeout(confirmationTimeout);
        this.child.off("exit", finish);
        resolve();
      };
      const escalationTimeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        confirmationTimeout = setTimeout(() => {
          this.child.off("exit", finish);
          reject(new UsageProviderError("unavailable"));
        }, this.killConfirmationMs);
      }, this.stopGraceMs);
      this.child.once("exit", finish);
      this.child.kill("SIGTERM");
    });
  }

  stopImmediately(): boolean {
    if (this.confirmedExit || this.child.exitCode !== null || this.child.signalCode !== null) {
      return true;
    }
    try {
      return this.child.kill("SIGKILL");
    } catch {
      return false;
    }
  }
}
