import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { UsageProviderError, type UsageErrorCode } from "../../usage/provider.js";
import {
  resolveTrustedClaudeExecutable,
  validateTrustedClaudeExecutable,
  type ClaudeExecutableIdentity,
} from "../claude/claude-usage-provider.js";

export const GROK_ACP_MAX_RESPONSE_FRAME_BYTES = 64 * 1024;

export interface GrokAcpTransport {
  request(frame: string, id: number): Promise<unknown>;
  notify?(frame: string): void;
  stop(): Promise<void>;
  stopImmediately(): boolean;
  onExitConfirmed?(listener: () => void): () => void;
}

export interface SpawnGrokAcpOptions {
  readonly spawnProcess?: typeof spawn;
  readonly timeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly killConfirmationMs?: number;
  readonly maxFrameBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly grokPath?: string;
  readonly executableCandidates?: readonly string[];
  readonly resolveExecutable?: (candidate: string) => Promise<ClaudeExecutableIdentity | undefined>;
  readonly validateExecutable?: (identity: ClaudeExecutableIdentity) => Promise<boolean>;
}

const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function grokExecutableCandidates(home = homedir()): readonly string[] {
  return [
    join(home, ".local", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
    "/usr/bin/grok",
  ];
}

export async function spawnGrokAcp(options: SpawnGrokAcpOptions = {}): Promise<GrokAcpTransport> {
  const candidates = options.grokPath
    ? [options.grokPath]
    : options.executableCandidates ?? grokExecutableCandidates();
  let identity: ClaudeExecutableIdentity | undefined;
  const resolveExecutable = options.resolveExecutable ?? resolveTrustedClaudeExecutable;
  const validateExecutable = options.validateExecutable ?? validateTrustedClaudeExecutable;
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (!resolved) continue;
    try {
      if (!await validateExecutable(resolved)) continue;
    } catch {
      continue;
    }
    identity = resolved;
    break;
  }
  if (!identity) throw new UsageProviderError("executable-not-found");
  const child = (options.spawnProcess ?? spawn)(identity.executable, ["agent", "stdio"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: safeRuntimeEnvironment(options.env ?? process.env),
  });
  return new ChildGrokAcpTransport(child, options);
}

export function safeRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME"]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  env.PATH = FIXED_PATH;
  return env;
}

class ChildGrokAcpTransport implements GrokAcpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly killConfirmationMs: number;
  private readonly maxFrameBytes: number;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private stopped = false;
  private exited = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: UsageProviderError) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(child: ChildProcessWithoutNullStreams, options: SpawnGrokAcpOptions) {
    this.child = child;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
    this.stopGraceMs = Math.max(1, options.stopGraceMs ?? 500);
    this.killConfirmationMs = Math.max(1, options.killConfirmationMs ?? 500);
    this.maxFrameBytes = Math.max(1, options.maxFrameBytes ?? GROK_ACP_MAX_RESPONSE_FRAME_BYTES);
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    child.once("error", () => this.retire("unavailable"));
    child.once("exit", () => { this.exited = true; this.retire("unavailable", false); });
    child.stdin.on("error", () => this.retire("unavailable"));
  }

  request(frame: string, id: number): Promise<unknown> {
    if (this.stopped) return Promise.reject(new UsageProviderError("stopped"));
    if (this.pending.has(id)) return Promise.reject(new UsageProviderError("unavailable"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.retire("timeout"), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame);
    });
  }

  notify(frame: string): void {
    if (this.stopped) throw new UsageProviderError("stopped");
    this.child.stdin.write(frame);
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopped = true;
    this.rejectAll("stopped");
    await new Promise<void>((resolve, reject) => {
      let confirmation: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => { clearTimeout(timer); if (confirmation) clearTimeout(confirmation); this.exited = true; resolve(); };
      const timer = setTimeout(() => {
        this.stopImmediately();
        confirmation = setTimeout(() => { this.child.off("exit", done); reject(new UsageProviderError("unavailable")); }, this.killConfirmationMs);
      }, this.stopGraceMs);
      this.child.once("exit", done);
      this.child.kill("SIGTERM");
    });
  }

  stopImmediately(): boolean {
    this.stopped = true;
    this.rejectAll("stopped");
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) return true;
    try { return this.child.kill("SIGKILL"); } catch { return false; }
  }

  onExitConfirmed(listener: () => void): () => void {
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.child.once("exit", listener);
    return () => this.child.off("exit", listener);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) { this.retire("invalid-response"); return; }
      if (line.trim()) this.parseLine(line);
      if (this.stopped) return;
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) this.retire("invalid-response");
  }

  private parseLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.retire("invalid-response"); return; }
    if (!isRecord(value) || value.jsonrpc !== "2.0") { this.retire("invalid-response"); return; }
    if (!("id" in value)) return; // Valid notification.
    if (!Number.isSafeInteger(value.id)) { this.retire("invalid-response"); return; }
    const pending = this.pending.get(value.id as number);
    if (!pending) return;
    this.pending.delete(value.id as number);
    clearTimeout(pending.timer);
    if ("error" in value || !("result" in value)) pending.reject(new UsageProviderError("unavailable"));
    else pending.resolve(value.result);
  }

  private retire(code: UsageErrorCode, kill = true): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectAll(code);
    if (kill) this.stopImmediately();
  }

  private rejectAll(code: UsageErrorCode): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new UsageProviderError(code)); }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
