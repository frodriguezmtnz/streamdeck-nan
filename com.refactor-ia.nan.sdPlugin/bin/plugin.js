import { SingletonAction, streamDeck, action } from '@elgato/streamdeck';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { realpath, stat, access, readdir, lstat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, isAbsolute, dirname, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pbkdf2Sync, createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */


function __esDecorate(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
}
function __runInitializers(thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
}
typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

function cancellableCommand(execution) {
    return "result" in execution
        ? execution
        : { result: execution, cancel: () => undefined };
}
function hardDeadlineCommand(timeoutMs, start) {
    let child;
    let deadline;
    let settled = false;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    const resolve = (value) => {
        if (settled)
            return;
        settled = true;
        if (deadline)
            clearTimeout(deadline);
        resolveResult(value);
    };
    const reject = (error) => {
        if (settled)
            return;
        settled = true;
        if (deadline)
            clearTimeout(deadline);
        rejectResult(error);
    };
    try {
        child = start({ resolve, reject });
    }
    catch (error) {
        reject(error);
    }
    if (!settled) {
        deadline = setTimeout(() => {
            try {
                child?.kill("SIGKILL");
            }
            catch { /* El deadline sigue siendo terminal. */ }
            reject(Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" }));
        }, Math.max(1, timeoutMs));
    }
    return {
        result,
        cancel: () => {
            if (settled)
                return;
            try {
                child?.kill("SIGKILL");
            }
            catch { /* La cancelacion igualmente liquida la promesa. */ }
            reject(new Error("Command cancelled"));
        },
    };
}

const usageWindowNames = ["session", "week"];
const MAX_PROVIDER_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const safeErrorMessages = {
    authentication: "Authentication is unavailable.",
    "executable-not-found": "The required command is unavailable.",
    timeout: "The usage request timed out.",
    "invalid-response": "The usage response is invalid.",
    unavailable: "Usage is unavailable.",
    stopped: "The usage provider is stopped.",
};
class UsageProviderError extends Error {
    code;
    retryAfterMs;
    constructor(code, options = {}) {
        super(safeErrorMessages[code]);
        this.name = "UsageProviderError";
        this.code = code;
        if (Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0) {
            this.retryAfterMs = Math.min(options.retryAfterMs, MAX_PROVIDER_RETRY_AFTER_MS);
        }
    }
}
function sanitizeUsageError(error, fallback = "unavailable") {
    return error instanceof UsageProviderError
        ? error
        : new UsageProviderError(fallback);
}
function normalizeUsageSnapshot(value) {
    if (!isRecord$9(value) || !Number.isFinite(value.observedAt) || !isRecord$9(value.windows)) {
        return undefined;
    }
    const windows = {};
    for (const name of usageWindowNames) {
        const window = value.windows[name];
        if (window === undefined)
            continue;
        if (!isUsageWindow(window))
            return undefined;
        windows[name] = {
            usedPercent: window.usedPercent,
            ...(window.windowMinutes === undefined
                ? {}
                : { windowMinutes: window.windowMinutes }),
            ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        };
    }
    if (Object.keys(windows).length === 0)
        return undefined;
    return { windows, observedAt: value.observedAt };
}
function isUsageWindow(value) {
    return (isRecord$9(value) &&
        Number.isFinite(value.usedPercent) &&
        (value.windowMinutes === undefined || Number.isFinite(value.windowMinutes)) &&
        (value.resetsAt === undefined || typeof value.resetsAt === "string"));
}
function isRecord$9(value) {
    return typeof value === "object" && value !== null;
}

const CLAUDE_USAGE_ARGS = [
    "-p",
    "/usage",
    "--tools",
    "",
    "--output-format",
    "json",
];
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const FIXED_PATH$2 = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
class ClaudeUsageProvider {
    id = "claude";
    runCommand;
    resolveExecutable;
    validateExecutable;
    executableCandidates;
    environment;
    now;
    timeoutMs;
    maxStdoutBytes;
    activeCommands = new Set();
    generation = 0;
    stopped = false;
    stopping;
    constructor(options = {}) {
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
    async getUsage() {
        if (this.stopped)
            return failure("stopped");
        const generation = this.generation;
        try {
            for (const candidate of this.executableCandidates) {
                const identity = await this.resolveExecutable(candidate);
                if (!this.isCurrent(generation))
                    return failure(this.stopped ? "stopped" : "unavailable");
                if (!identity || !await this.validateExecutable(identity))
                    continue;
                if (!this.isCurrent(generation))
                    return failure(this.stopped ? "stopped" : "unavailable");
                try {
                    const command = cancellableCommand(this.runCommand(identity.executable, CLAUDE_USAGE_ARGS, {
                        timeoutMs: this.timeoutMs,
                        maxStdoutBytes: this.maxStdoutBytes,
                        env: this.environment,
                    }));
                    this.activeCommands.add(command);
                    let response;
                    try {
                        response = await command.result;
                    }
                    finally {
                        this.activeCommands.delete(command);
                    }
                    if (!this.isCurrent(generation))
                        return failure(this.stopped ? "stopped" : "unavailable");
                    if (response.exitCode !== 0)
                        return failure("unavailable");
                    if (Buffer.byteLength(response.stdout, "utf8") > this.maxStdoutBytes) {
                        return failure("invalid-response");
                    }
                    const windows = parseClaudeUsage(response.stdout);
                    if (!windows)
                        return failure("invalid-response");
                    return { ok: true, usage: { windows, observedAt: this.now() } };
                }
                catch (error) {
                    if (!this.isCurrent(generation))
                        return failure(this.stopped ? "stopped" : "unavailable");
                    if (isTimeout(error))
                        return failure("timeout");
                    if (isMaxBufferError(error))
                        return failure("invalid-response");
                    return failure("unavailable");
                }
            }
            return failure("executable-not-found");
        }
        catch (error) {
            return { ok: false, error: sanitizeUsageError(error) };
        }
    }
    recoverAfterWake() {
        if (this.stopped)
            return;
        this.generation += 1;
        this.cancelActiveCommands();
    }
    stop() {
        if (this.stopping)
            return this.stopping;
        this.stopped = true;
        this.generation += 1;
        const active = [...this.activeCommands];
        for (const command of active)
            command.cancel();
        this.stopping = Promise.allSettled(active.map(({ result }) => result)).then(() => undefined);
        return this.stopping;
    }
    stopImmediately() {
        this.stopped = true;
        this.generation += 1;
        this.cancelActiveCommands();
    }
    isCurrent(generation) {
        return !this.stopped && generation === this.generation;
    }
    cancelActiveCommands() {
        for (const command of this.activeCommands)
            command.cancel();
    }
}
async function resolveTrustedClaudeExecutable(candidate, policy = {}) {
    if (!isAbsolute(candidate))
        return undefined;
    try {
        const resolved = await realpath(candidate);
        if (!isAbsolute(resolved))
            return undefined;
        const metadata = await stat(resolved);
        if (!isTrustedExecutableMetadata(metadata, policy) || !await hasTrustedParentChains(candidate, resolved, policy)) {
            return undefined;
        }
        await access(resolved, constants.X_OK);
        return { candidate, executable: resolved, dev: metadata.dev, ino: metadata.ino };
    }
    catch {
        return undefined;
    }
}
async function validateTrustedClaudeExecutable(identity, policy = {}) {
    try {
        const candidateTarget = await realpath(identity.candidate);
        const executableTarget = await realpath(identity.executable);
        if (candidateTarget !== identity.executable || executableTarget !== identity.executable) {
            return false;
        }
        const metadata = await stat(identity.executable);
        if (metadata.dev !== identity.dev
            || metadata.ino !== identity.ino
            || !isTrustedExecutableMetadata(metadata, policy)
            || !await hasTrustedParentChains(identity.candidate, identity.executable, policy))
            return false;
        await access(identity.executable, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function isTrustedExecutableMetadata(metadata, policy) {
    const uid = policy.uid ?? process.getuid?.();
    return metadata.isFile()
        && uid !== undefined
        && (metadata.uid === uid || metadata.uid === 0)
        && (metadata.mode & 0o022) === 0;
}
async function hasTrustedParentChains(candidate, executable, policy) {
    const candidateParent = await realpath(dirname(candidate));
    const executableParent = await realpath(dirname(executable));
    return await hasTrustedDirectoryChain(candidateParent, policy)
        && (candidateParent === executableParent || await hasTrustedDirectoryChain(executableParent, policy));
}
async function hasTrustedDirectoryChain(start, policy) {
    let directory = start;
    while (true) {
        const metadata = await stat(directory);
        const uid = policy.uid ?? process.getuid?.();
        if (!metadata.isDirectory()
            || uid === undefined
            || (metadata.uid !== uid && metadata.uid !== 0)
            || !isTrustedDirectoryMode(directory, metadata, uid, policy))
            return false;
        const parent = dirname(directory);
        if (parent === directory)
            return true;
        directory = parent;
    }
}
function isTrustedDirectoryMode(directory, metadata, uid, policy) {
    if ((metadata.mode & 0o002) !== 0)
        return false;
    if ((metadata.mode & 0o020) === 0)
        return true;
    return isTrustedHomebrewDirectory(directory, metadata, { ...policy, uid });
}
function isTrustedHomebrewDirectory(directory, metadata, policy = {}) {
    const uid = policy.uid ?? process.getuid?.();
    const platform = policy.platform ?? process.platform;
    const adminGid = policy.adminGid ?? 80;
    const prefixes = policy.homebrewPrefixes ?? ["/opt/homebrew", "/usr/local"];
    if (platform !== "darwin" || uid === undefined || metadata.uid !== uid || metadata.gid !== adminGid
        || (metadata.mode & 0o020) === 0 || (metadata.mode & 0o002) !== 0)
        return false;
    // macOS admin (gid 80) members already hold local administrative authority; no other writable group is trusted.
    return prefixes.some((prefix) => {
        const fromPrefix = relative(prefix, directory);
        return fromPrefix === "" || (!fromPrefix.startsWith("..") && !isAbsolute(fromPrefix));
    });
}
function claudeEnvironment() {
    const username = userInfo().username;
    const env = {
        HOME: homedir(),
        PATH: FIXED_PATH$2,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        USER: username,
        LOGNAME: username,
        SHELL: "/bin/zsh",
        TERM: "dumb",
    };
    for (const name of ["TMPDIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
        const value = process.env[name];
        if (value)
            env[name] = value;
    }
    return env;
}
function runCommand(executable, args, options) {
    return hardDeadlineCommand(options.timeoutMs, ({ resolve, reject }) => execFile(executable, [...args], {
        encoding: "utf8",
        env: { ...options.env },
        maxBuffer: options.maxStdoutBytes,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        shell: false,
    }, (error, stdout) => {
        if (error) {
            if (typeof error.code === "number")
                resolve({ exitCode: error.code, stdout });
            else
                reject(error);
            return;
        }
        resolve({ exitCode: 0, stdout });
    }));
}
function parseClaudeUsage(stdout) {
    let payload;
    try {
        payload = JSON.parse(stdout);
    }
    catch {
        return undefined;
    }
    if (!isRecord$8(payload) || typeof payload.result !== "string" || !hasZeroInference(payload)) {
        return undefined;
    }
    const windows = {};
    for (const line of payload.result.split(/\r?\n/)) {
        const session = /^\s*Current session:\s*(\d+(?:\.\d+)?)% used(?:\s|$)/.exec(line);
        if (session)
            windows.session = parseWindow$2(session[1]);
        const week = /^\s*Current week \(all models\):\s*(\d+(?:\.\d+)?)% used(?:\s|$)/.exec(line);
        if (week)
            windows.week = parseWindow$2(week[1]);
    }
    return windows.session && windows.week ? windows : undefined;
}
function parseWindow$2(value) {
    const usedPercent = Number(value);
    return Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
        ? { usedPercent }
        : undefined;
}
function hasZeroInference(payload) {
    if (payload.num_turns !== 0
        || payload.duration_api_ms !== 0
        || payload.total_cost_usd !== 0
        || !isRecord$8(payload.usage)
        || !isRecord$8(payload.modelUsage)
        || Object.keys(payload.modelUsage).length !== 0)
        return false;
    const totals = hasOnlyZeroUsageTotals(payload.usage);
    return totals.valid && totals.found;
}
function hasOnlyZeroUsageTotals(value) {
    let found = false;
    for (const [key, item] of Object.entries(value)) {
        if (key.endsWith("_tokens") || key.endsWith("_requests")) {
            if (typeof item !== "number" || !Number.isFinite(item) || item !== 0) {
                return { valid: false, found: true };
            }
            found = true;
        }
        else if (isRecord$8(item)) {
            const nested = hasOnlyZeroUsageTotals(item);
            if (!nested.valid)
                return nested;
            found ||= nested.found;
        }
    }
    return { valid: true, found };
}
function failure(code) {
    return { ok: false, error: new UsageProviderError(code) };
}
function errorCode(error) {
    return isRecord$8(error) ? error.code : undefined;
}
function isTimeout(error) {
    return errorCode(error) === "ETIMEDOUT" || (isRecord$8(error) && error.killed === true);
}
function isMaxBufferError(error) {
    return errorCode(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}
function isRecord$8(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CLAUDE_COORDINATOR_OPTIONS = {
    cacheTtlMs: 30_000,
    failureCooldownMs: 120_000,
    forcedRefreshThrottleMs: 5_000,
};

class RefreshingAction extends SingletonAction {
    timers = new Map();
    alternationTimers = new Map();
    lifecycles = new Map();
    scheduler;
    nextAppearanceEpoch = 0;
    constructor(scheduler = defaultScheduler) {
        super();
        this.scheduler = scheduler;
    }
    onWillDisappear(ev) {
        this.clearTimer(ev.action.id);
        this.clearAlternationTimer(ev.action.id);
        this.lifecycles.delete(ev.action.id);
    }
    configureRefresh(action, settings) {
        this.clearTimer(action.id);
        const lifecycle = this.lifecycles.get(action.id);
        if (!lifecycle)
            return;
        lifecycle.action = action;
        lifecycle.settings = settings;
        lifecycle.generation += 1;
        this.lifecycles.set(action.id, lifecycle);
        if (!lifecycle.preparing)
            this.armTimer(action, settings);
    }
    async activateOnAppearance(action, settings, prepare = () => Promise.resolve()) {
        this.beginAppearance(action, settings);
        const isSameAppearance = this.appearanceGuard(action);
        try {
            await prepare();
        }
        catch (error) {
            if (isSameAppearance()) {
                const lifecycle = this.lifecycles.get(action.id);
                if (lifecycle) {
                    lifecycle.preparing = false;
                    lifecycle.pending = false;
                    lifecycle.force = false;
                    this.configureRefresh(lifecycle.action, lifecycle.settings);
                }
            }
            throw error;
        }
        if (!isSameAppearance())
            return;
        const lifecycle = this.lifecycles.get(action.id);
        if (!lifecycle)
            return;
        const force = lifecycle.force;
        lifecycle.preparing = false;
        lifecycle.pending = false;
        lifecycle.force = false;
        this.configureRefresh(lifecycle.action, lifecycle.settings);
        await this.refresh(lifecycle.action, force);
    }
    beginAppearance(action, settings, preparing = true) {
        this.clearTimer(action.id);
        const previous = this.lifecycles.get(action.id);
        const lifecycle = {
            action,
            settings,
            appearanceEpoch: ++this.nextAppearanceEpoch,
            generation: (previous?.generation ?? 0) + 1,
            preparing,
            pending: false,
            force: false,
            showCountdown: false,
        };
        this.lifecycles.set(action.id, lifecycle);
        const generation = lifecycle.generation;
        return () => this.lifecycles.get(action.id) === lifecycle && lifecycle.generation === generation;
    }
    resumeAfterSystemWake() {
        const refreshes = [];
        for (const [contextId, previous] of [...this.lifecycles]) {
            this.clearTimer(contextId);
            if (previous.preparing) {
                previous.pending = true;
                previous.force = true;
                continue;
            }
            const lifecycle = {
                action: previous.action,
                settings: previous.settings,
                appearanceEpoch: previous.appearanceEpoch,
                generation: previous.generation + 1,
                preparing: false,
                pending: false,
                force: false,
                showCountdown: false,
            };
            this.lifecycles.set(contextId, lifecycle);
            this.armTimer(lifecycle.action, lifecycle.settings);
            refreshes.push(this.refresh(lifecycle.action, true));
        }
        return Promise.all(refreshes).then(() => undefined);
    }
    armTimer(action, settings) {
        if (settings.autoRefresh === false)
            return;
        const configuredInterval = settings.refreshInterval;
        const seconds = typeof configuredInterval === "number" && Number.isFinite(configuredInterval)
            ? Math.min(300, Math.max(10, configuredInterval))
            : 30;
        const timer = this.scheduler.setInterval(() => void this.refresh(action), seconds * 1000);
        this.timers.set(action.id, timer);
    }
    refresh(action, force = false) {
        const lifecycle = this.lifecycles.get(action.id);
        if (!lifecycle)
            return Promise.resolve();
        if (lifecycle.preparing) {
            lifecycle.pending = true;
            lifecycle.force ||= force;
            return Promise.resolve();
        }
        if (lifecycle.inFlight) {
            lifecycle.pending = true;
            lifecycle.force ||= force;
            return lifecycle.inFlight;
        }
        lifecycle.force = force;
        const request = this.runRefreshes(action, lifecycle).finally(() => {
            if (lifecycle.inFlight === request)
                lifecycle.inFlight = undefined;
        });
        lifecycle.inFlight = request;
        return request;
    }
    lifecycleGuard(action) {
        const lifecycle = this.lifecycles.get(action.id);
        if (!lifecycle)
            return () => false;
        const generation = lifecycle?.generation;
        return () => this.lifecycles.get(action.id) === lifecycle && lifecycle?.generation === generation;
    }
    hasActiveLifecycle(action) {
        return this.lifecycles.has(action.id);
    }
    appearanceGuard(action) {
        const appearanceEpoch = this.lifecycles.get(action.id)?.appearanceEpoch;
        if (appearanceEpoch === undefined)
            return () => false;
        return () => this.lifecycles.get(action.id)?.appearanceEpoch === appearanceEpoch;
    }
    async runRefreshes(action, lifecycle) {
        do {
            lifecycle.pending = false;
            const force = lifecycle.force;
            lifecycle.force = false;
            const generation = lifecycle.generation;
            try {
                await this.updateDisplay(action, () => this.lifecycles.get(action.id) === lifecycle && lifecycle.generation === generation, force);
            }
            catch {
                streamDeck.logger.error("action=refresh state=unavailable");
            }
        } while (lifecycle.pending && this.lifecycles.get(action.id) === lifecycle);
    }
    clearTimer(contextId) {
        const timer = this.timers.get(contextId);
        if (timer)
            this.scheduler.clearInterval(timer);
        this.timers.delete(contextId);
    }
    configureAlternation(action, intervalMs) {
        this.clearAlternationTimer(action.id);
        const lifecycle = this.lifecycles.get(action.id);
        if (!lifecycle)
            return;
        lifecycle.showCountdown = false;
        const timer = setInterval(() => {
            const lc = this.lifecycles.get(action.id);
            if (!lc)
                return;
            lc.showCountdown = !lc.showCountdown;
            void this.onAlternationTick(action, lc.showCountdown);
        }, intervalMs);
        this.alternationTimers.set(action.id, timer);
    }
    onAlternationTick(_action, _showCountdown) {
        return Promise.resolve();
    }
    clearAlternationTimer(contextId) {
        const timer = this.alternationTimers.get(contextId);
        if (timer)
            clearInterval(timer);
        this.alternationTimers.delete(contextId);
    }
}
const defaultScheduler = {
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (timer) => clearInterval(timer),
};

class UsageProviderCoordinator {
    provider;
    cacheTtlMs;
    failureCooldownMs;
    forcedRefreshThrottleMs;
    now;
    statusReporter;
    cache;
    inFlight;
    nextRequestId = 0;
    committedRequestId = 0;
    settledRequestId = 0;
    latestSettledError;
    failureCooldownUntil = 0;
    constructor(provider, options = {}) {
        this.provider = provider;
        this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
        this.failureCooldownMs = Math.max(0, options.failureCooldownMs ?? 0);
        this.forcedRefreshThrottleMs = Math.max(0, options.forcedRefreshThrottleMs ?? 0);
        this.now = options.now ?? Date.now;
        this.statusReporter = options.statusReporter;
    }
    get providerId() {
        return this.provider.id;
    }
    recoverAfterWake() {
        this.provider.recoverAfterWake?.();
        this.inFlight = undefined;
        this.nextRequestId += 1;
        this.settledRequestId = this.nextRequestId;
        this.latestSettledError = undefined;
        this.failureCooldownUntil = 0;
        if (this.cache)
            this.cache = { usage: this.cache.usage, cachedAt: Number.NEGATIVE_INFINITY };
    }
    getUsage(options = {}) {
        if (this.latestSettledError && this.now() < this.failureCooldownUntil) {
            return Promise.resolve(this.cache
                ? { ok: true, usage: this.cache.usage, stale: true, error: this.latestSettledError }
                : { ok: false, error: this.latestSettledError });
        }
        if (this.inFlight)
            return this.inFlight;
        if (options.force &&
            this.cache &&
            this.now() - this.cache.cachedAt < this.forcedRefreshThrottleMs) {
            return Promise.resolve({ ok: true, usage: this.cache.usage, stale: false });
        }
        if (!options.force) {
            const cached = this.currentCache();
            if (cached)
                return Promise.resolve({ ok: true, usage: cached, stale: false });
        }
        const request = this.requestUsage(++this.nextRequestId);
        this.inFlight = request;
        void request.finally(() => {
            if (this.inFlight === request)
                this.inFlight = undefined;
        });
        return request;
    }
    currentCache() {
        if (!this.cache ||
            this.cacheTtlMs === 0 ||
            this.now() - this.cache.cachedAt >= this.cacheTtlMs) {
            return undefined;
        }
        return this.cache.usage;
    }
    async requestUsage(requestId) {
        try {
            const result = await this.provider.getUsage();
            if (!result.ok)
                return this.failure(result.error, requestId);
            const usage = normalizeUsageSnapshot(result.usage);
            if (!usage) {
                return this.failure(new UsageProviderError("invalid-response"), requestId);
            }
            if (requestId === this.nextRequestId) {
                this.cache = { usage, cachedAt: this.now() };
                this.committedRequestId = requestId;
                this.settledRequestId = requestId;
                this.latestSettledError = undefined;
                this.failureCooldownUntil = 0;
                this.statusReporter?.success(this.provider.id);
                return { ok: true, usage, stale: false };
            }
            if (this.cache) {
                return {
                    ok: true,
                    usage: this.cache.usage,
                    stale: this.latestSettledError !== undefined,
                    ...(this.latestSettledError ? { error: this.latestSettledError } : {}),
                };
            }
            return this.latestSettledError
                ? { ok: false, error: this.latestSettledError }
                : { ok: true, usage, stale: true };
        }
        catch (error) {
            return this.failure(sanitizeUsageError(error), requestId);
        }
    }
    failure(error, requestId) {
        const sanitized = sanitizeUsageError(error);
        if (requestId < this.settledRequestId) {
            if (this.cache) {
                return {
                    ok: true,
                    usage: this.cache.usage,
                    stale: this.latestSettledError !== undefined,
                    ...(this.latestSettledError ? { error: this.latestSettledError } : {}),
                };
            }
            return this.latestSettledError
                ? { ok: false, error: this.latestSettledError }
                : { ok: false, error: sanitized };
        }
        if (requestId > this.settledRequestId) {
            this.settledRequestId = requestId;
            this.latestSettledError = sanitized;
            this.failureCooldownUntil = this.now() + Math.max(this.failureCooldownMs, Math.min(sanitized.retryAfterMs ?? 0, MAX_PROVIDER_RETRY_AFTER_MS));
            this.statusReporter?.failure(this.provider.id, sanitized.code);
        }
        if (this.cache && requestId < this.committedRequestId) {
            return { ok: true, usage: this.cache.usage, stale: false };
        }
        return this.cache
            ? { ok: true, usage: this.cache.usage, stale: true, error: sanitized }
            : { ok: false, error: sanitized };
    }
}

const REMOVED_NAN_MODELS = new Set(["glm5.2", "flux-2-klein"]);
function isSelectableNanLiveModel(model) {
    return typeof model === "string" && model.length > 0 && model.length <= 128
        && model.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(model) && !REMOVED_NAN_MODELS.has(model);
}
function cycleNanLiveModel(models, current, ticks) {
    const selected = models.indexOf(current ?? ""), index = selected === -1 ? (ticks > 0 ? -1 : 0) : selected;
    return models[((index + ticks) % models.length + models.length) % models.length];
}
function resolveNanLiveModel(models, observed, selected) {
    const validObserved = observed.filter(isSelectableNanLiveModel);
    return isSelectableNanLiveModel(selected) && models.includes(selected) ? selected : validObserved[0] ?? models[0];
}
async function persistLatestNanSettings(generation, settings, latest, writeSettings, isCurrent = () => true, canReconcile = isCurrent) {
    let targetGeneration = generation;
    let targetSettings = settings;
    while (true) {
        if (!isCurrent() && !canReconcile())
            return latest().settings;
        const current = latest();
        if (current.generation !== targetGeneration) {
            targetGeneration = current.generation;
            targetSettings = current.settings;
        }
        await writeSettings(targetSettings);
        if (!isCurrent() && !canReconcile())
            return latest().settings;
        const persisted = latest();
        if (persisted.generation === targetGeneration)
            return targetSettings;
    }
}
class NanSettingsWriteQueue {
    pending = new Map();
    write(contextId, settings, writeSettings, isSameAppearance = () => true) {
        const previous = this.pending.get(contextId) ?? Promise.resolve();
        const write = previous.catch(() => undefined).then(() => {
            if (!isSameAppearance())
                return;
            return writeSettings(settings);
        });
        const tracked = write.finally(() => {
            if (this.pending.get(contextId) === tracked)
                this.pending.delete(contextId);
        });
        this.pending.set(contextId, tracked);
        return tracked;
    }
}

function renderNanDashboardFeedback(state, settings) {
    const base = { title: "NaN", demo: "DASHBOARD" };
    if (!state.quota) {
        return { ...base, model: "Dashboard", value: "--", unit: "PROVIDER QUOTA", status: dashboardStatus(state.error) };
    }
    const selected = resolveNanLiveModel(state.quota.models.map(({ model }) => model), state.quota.models.map(({ model }) => model), settings.model);
    if (selected) {
        const model = state.quota.models.find((entry) => entry.model === selected);
        const period = model.resetAt ? `RESETS ${formatResetDate(model.resetAt)}`
            : model.windowHours ? `ROLLING ${model.windowHours}H` : "PER MODEL";
        return {
            ...base,
            model: model.model,
            value: `${compactNumber(model.tokensUsed)} / ${compactNumber(model.cap)}`,
            // Preserve the raw API percentage (including over-cap values); there is no dial bar to clamp here.
            unit: `${formatPercentage$1(model.percentage)}% · ${period}`,
            status: state.stale ? "STALE" : "",
        };
    }
    const uncapped = state.quota.uncappedModels[0];
    if (uncapped)
        return { ...base, model: uncapped.model, value: `${compactNumber(uncapped.tokensUsed)} · UNCAPPED`, unit: "PROVIDER QUOTA · ELIGIBILITY UNKNOWN", status: state.stale ? "STALE" : "" };
    return { ...base, model: "Dashboard", value: "--", unit: "PROVIDER QUOTA", status: "NO QUOTA" };
}
function renderNanImportProgress() {
    return { title: "NaN", demo: "DASHBOARD", model: "Chrome session", value: "--", unit: "PROVIDER QUOTA", status: "IMPORTING" };
}
function dashboardStatus(error) {
    switch (error) {
        case "needs-import": return "IMPORT SESSION";
        case "keychain-unavailable": return "KEYCHAIN UNAVAILABLE";
        case "eviction-failed": return "SESSION RESET FAILED";
        case "schema-invalid": return "QUOTA INVALID";
        case "transient": return "DASHBOARD UNAVAILABLE";
        case "import-unavailable": return "IMPORT UNAVAILABLE";
        case "import-busy": return "IMPORT BUSY";
        case "invalid-source": return "INVALID SOURCE";
        default: return "NO QUOTA";
    }
}
function formatPercentage$1(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
function formatCountdown(isoString) {
    const now = Date.now();
    const target = new Date(isoString).getTime();
    if (Number.isNaN(target) || target <= now)
        return null;
    const diffMs = target - now;
    const hours = Math.floor(diffMs / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    const seconds = Math.floor((diffMs % 60_000) / 1000);
    if (hours >= 1)
        return `${hours}h ${minutes}m`;
    if (minutes >= 1)
        return `${minutes}m ${seconds}s`;
    return "<1m";
}
function renderClaudeFeedback(result, _showCountdown = false) {
    if (!result.ok) {
        return {
            title: "Claude",
            status: "NO DATA",
            sessionValue: "--",
            sessionBar: 0,
            weeklyValue: "--",
            weeklyBar: 0,
        };
    }
    const session = usageDisplay(result.usage.windows.session?.usedPercent);
    const weekly = usageDisplay(result.usage.windows.week?.usedPercent);
    return {
        title: "Claude",
        status: result.stale
            ? "STALE"
            : !result.usage.windows.session || !result.usage.windows.week
                ? "NO DATA"
                : "",
        sessionValue: session.value,
        sessionBar: session.bar,
        weeklyValue: weekly.value,
        weeklyBar: weekly.bar,
    };
}
function renderCodexFeedback(result, showCountdown = false) {
    const week = result.ok ? result.usage.windows.week : undefined;
    if (!result.ok || !week) {
        return {
            title: "GPT / OPENAI",
            period: "WEEKLY",
            value: "--",
            indicator: 0,
            status: "NO DATA",
        };
    }
    const weekly = Math.min(100, Math.max(0, week.usedPercent));
    const countdown = showCountdown && week.resetsAt ? formatCountdown(week.resetsAt) : null;
    return {
        title: "GPT / OPENAI",
        period: "WEEKLY",
        value: countdown ?? `${Math.round(weekly)}%`,
        indicator: weekly,
        status: result.stale ? "STALE" : "",
    };
}
function renderGrokFeedback(result, showCountdown = false) {
    const billing = result.ok ? result.usage.windows.session : undefined;
    if (!result.ok || !billing) {
        return {
            title: "GROK",
            experimental: "EXPERIMENTAL",
            period: "BILLING PERIOD",
            value: "--",
            indicator: 0,
            status: "NO DATA",
        };
    }
    const used = Math.min(100, Math.max(0, billing.usedPercent));
    const countdown = showCountdown && billing.resetsAt ? formatCountdown(billing.resetsAt) : null;
    return {
        title: "GROK",
        experimental: "EXPERIMENTAL",
        period: billing.resetsAt ? `RESETS ${formatResetDate(billing.resetsAt)}` : "BILLING PERIOD",
        value: countdown ?? `${Math.round(used)}%`,
        indicator: used,
        status: result.stale ? "STALE" : "",
    };
}
function usageDisplay(value) {
    if (value === undefined)
        return { value: "--", bar: 0 };
    const clamped = Math.min(100, Math.max(0, value));
    return { value: `${Math.round(clamped)}%`, bar: clamped };
}
function compactNumber(value) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function formatResetDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? "UNKNOWN"
        : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
}

let ClaudeUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.claude" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = RefreshingAction;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        coordinator;
        lastResult = null;
        constructor(coordinator = new UsageProviderCoordinator(new ClaudeUsageProvider(), CLAUDE_COORDINATOR_OPTIONS)) {
            super();
            this.coordinator = coordinator;
        }
        async onWillAppear(ev) {
            const action = ev.action;
            if (!action.isDial())
                return;
            await this.activateOnAppearance(action, ev.payload.settings, () => action.setFeedbackLayout("layouts/claude.json"));
        }
        async onTouchTap(ev) {
            await this.refresh(ev.action, true);
        }
        async onDialUp(_ev) {
            await streamDeck.system.openUrl("https://claude.ai/settings/usage");
        }
        async onDidReceiveSettings(ev) {
            if (!ev.action.isDial())
                return;
            this.configureRefresh(ev.action, ev.payload.settings);
            await this.refresh(ev.action);
        }
        async updateDisplay(action, isCurrent, force) {
            this.lastResult = await this.coordinator.getUsage({ force });
            const feedback = renderClaudeFeedback(this.lastResult, false);
            if (isCurrent())
                await action.setFeedback(feedback);
        }
        async onAlternationTick(action, showCountdown) {
            if (!this.lastResult)
                return;
            const feedback = renderClaudeFeedback(this.lastResult, showCountdown);
            const isCurrent = this.lifecycleGuard(action);
            if (isCurrent())
                await action.setFeedback(feedback);
        }
    });
    return _classThis;
})();

/**
 * Allowed environment variables — same policy as the Grok transport.
 * No tokens, no credentials, no NAN_* vars.
 */
const ALLOWED_ENV = ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME"];
const FIXED_PATH$1 = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/**
 * Build a safe environment object from the parent process.
 * Only whitelisted variables are propagated; secrets are excluded.
 */
function codexSafeEnvironment(source) {
    const env = {};
    for (const name of ALLOWED_ENV) {
        const value = source[name];
        if (value !== undefined)
            env[name] = value;
    }
    env.PATH = FIXED_PATH$1;
    return env;
}
/**
 * Re-validate the executable identity immediately before spawning.
 * This catches symlink replacement or file swap between validation and execution.
 */
async function resolveCodexIdentity(candidates, resolveExecutable) {
    for (const candidate of candidates) {
        const identity = await resolveExecutable(candidate);
        if (identity)
            return identity;
    }
    return undefined;
}
function spawnCodexAppServer(options = {}) {
    let cancelled = false;
    let transport;
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
        if (cancelled)
            throw new UsageProviderError("stopped");
        if (!identity || !await (options.validateExecutable ?? validateTrustedClaudeExecutable)(identity)) {
            throw new UsageProviderError("executable-not-found");
        }
        if (cancelled)
            throw new UsageProviderError("stopped");
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
        return await new Promise((resolve, reject) => {
            const onError = (error) => {
                transport?.stopImmediately();
                reject(error);
            };
            child.once("error", onError);
            child.once("spawn", () => {
                child.off("error", onError);
                if (cancelled) {
                    transport?.stopImmediately();
                    reject(new UsageProviderError("stopped"));
                }
                else {
                    resolve(transport);
                }
            });
        });
    })();
    creation.stopImmediately = () => {
        cancelled = true;
        return transport?.stopImmediately() ?? true;
    };
    return creation;
}
class ChildProcessTransport {
    child;
    stopGraceMs;
    killConfirmationMs;
    confirmedExit = false;
    handleChildError = () => undefined;
    handleStdinError = () => undefined;
    confirmExit = () => {
        this.confirmedExit = true;
        this.child.off("error", this.handleChildError);
        this.child.stdin.off("error", this.handleStdinError);
    };
    constructor(child, options = {}) {
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
    write(frame) {
        this.child.stdin.write(frame);
    }
    onData(listener) {
        const handler = (chunk) => listener(chunk.toString("utf8"));
        this.child.stdout.on("data", handler);
        return () => this.child.stdout.off("data", handler);
    }
    onExit(listener) {
        const exitHandler = () => listener();
        const errorHandler = (error) => listener(error);
        const stdinErrorHandler = (error) => listener(error);
        this.child.once("exit", exitHandler);
        this.child.once("error", errorHandler);
        this.child.stdin.once("error", stdinErrorHandler);
        return () => {
            this.child.off("exit", exitHandler);
            this.child.off("error", errorHandler);
            this.child.stdin.off("error", stdinErrorHandler);
        };
    }
    onExitConfirmed(listener) {
        if (this.confirmedExit || this.child.exitCode !== null || this.child.signalCode !== null) {
            queueMicrotask(listener);
            return () => undefined;
        }
        this.child.once("exit", listener);
        return () => this.child.off("exit", listener);
    }
    async stop() {
        if (this.confirmedExit)
            return;
        await new Promise((resolve, reject) => {
            let confirmationTimeout;
            const finish = () => {
                this.confirmedExit = true;
                clearTimeout(escalationTimeout);
                if (confirmationTimeout)
                    clearTimeout(confirmationTimeout);
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
    stopImmediately() {
        if (this.confirmedExit || this.child.exitCode !== null || this.child.signalCode !== null) {
            return true;
        }
        try {
            return this.child.kill("SIGKILL");
        }
        catch {
            return false;
        }
    }
}

class CodexAppServerClient {
    createTransport;
    timeoutMs;
    maxFrameBytes;
    maxRetiringTransports;
    transport;
    initialization;
    pending = new Map();
    nextId = 0;
    buffer = "";
    stopped = false;
    generation = 0;
    stopping;
    retirement;
    transportCreation;
    transportCreations = new Set();
    pendingCreationStop;
    pendingCreationTransport;
    retiringTransports = new Set();
    retirementTasks = new Map();
    retirementExitListeners = new Map();
    removeDataListener;
    removeExitListener;
    constructor(options = {}) {
        this.createTransport = options.createTransport ?? spawnCodexAppServer;
        this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
        this.maxFrameBytes = Math.max(256, options.maxFrameBytes ?? 1024 * 1024);
        this.maxRetiringTransports = Math.max(1, options.maxRetiringTransports ?? 8);
    }
    async readRateLimits() {
        if (this.stopped)
            throw new UsageProviderError("stopped");
        await this.ensureInitialized();
        return this.request("account/rateLimits/read");
    }
    async stop() {
        if (this.stopping)
            return this.stopping;
        this.stopped = true;
        this.stopping = this.stopAll();
        return this.stopping;
    }
    recoverAfterWake() {
        if (this.stopped)
            return;
        this.generation += 1;
        const transport = this.reset(new UsageProviderError("unavailable"));
        this.pendingCreationStop?.();
        this.pendingCreationTransport?.stopImmediately();
        this.pendingCreationStop = undefined;
        this.pendingCreationTransport = undefined;
        this.transportCreation = undefined;
        this.retirement = undefined;
        if (transport)
            this.retireDetached(transport);
    }
    stopImmediately() {
        this.stopped = true;
        const activeTransport = this.reset(new UsageProviderError("stopped"));
        if (activeTransport)
            this.trackRetiringTransport(activeTransport);
        if (this.pendingCreationTransport)
            this.trackRetiringTransport(this.pendingCreationTransport);
        else
            this.pendingCreationStop?.();
        for (const transport of this.retiringTransports) {
            transport.stopImmediately();
        }
    }
    async stopAll() {
        const initialization = this.initialization;
        const transport = this.reset(new UsageProviderError("stopped"));
        if (transport)
            this.retire(transport);
        if (initialization) {
            try {
                await initialization;
            }
            catch (error) {
                if (!(error instanceof UsageProviderError && error.code === "stopped")) {
                    throw sanitizeUsageError(error);
                }
            }
        }
        await this.awaitRetirement();
        await Promise.all([...this.retiringTransports].map((entry) => this.retireTransport(entry)));
    }
    async ensureInitialized() {
        if (this.initialization)
            return this.initialization;
        await this.awaitRetirement();
        if (this.initialization)
            return this.initialization;
        if (this.retiringTransports.size + this.transportCreations.size >= this.maxRetiringTransports) {
            throw new UsageProviderError("unavailable");
        }
        const initialization = this.initialize(this.generation);
        this.initialization = initialization;
        try {
            await initialization;
        }
        catch (error) {
            if (this.initialization === initialization)
                this.initialization = undefined;
            throw error;
        }
    }
    async initialize(generation) {
        let transport;
        try {
            const creation = this.createTransport();
            this.transportCreations.add(creation);
            void creation.then(() => this.transportCreations.delete(creation), () => this.transportCreations.delete(creation));
            this.transportCreation = creation;
            this.pendingCreationStop = getImmediateStop(creation);
            try {
                transport = await this.awaitTransportCreation(creation);
            }
            finally {
                if (this.transportCreation === creation) {
                    this.transportCreation = undefined;
                    this.pendingCreationStop = undefined;
                }
            }
            if (this.stopped || generation !== this.generation) {
                throw new UsageProviderError(this.stopped ? "stopped" : "unavailable");
            }
            this.pendingCreationTransport = transport;
            this.transport = transport;
            this.pendingCreationTransport = undefined;
            this.removeDataListener = transport.onData((chunk) => this.receive(chunk));
            this.removeExitListener = transport.onExit(() => {
                this.terminate(new UsageProviderError("unavailable"));
            });
            await this.request("initialize", {
                clientInfo: { name: "streamdeck-ai-usage", version: "1.0.0" },
            });
            this.notify("initialized");
        }
        catch (error) {
            const classified = classifyStartError(error);
            if (generation !== this.generation) {
                if (transport) {
                    transport.stopImmediately();
                    this.retireDetached(transport);
                }
                throw classified;
            }
            this.pendingCreationTransport = undefined;
            const activeTransport = this.reset(classified);
            if (transport && transport !== activeTransport) {
                transport.stopImmediately();
                this.retireDetached(transport);
            }
            if (activeTransport)
                this.retire(activeTransport);
            throw classified;
        }
    }
    request(method, params = {}) {
        const transport = this.transport;
        if (!transport)
            return Promise.reject(new UsageProviderError("unavailable"));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.terminate(new UsageProviderError("timeout"));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timeout });
            try {
                transport.write(`${JSON.stringify({ id, method, params })}\n`);
            }
            catch {
                this.terminate(new UsageProviderError("unavailable"));
            }
        });
    }
    notify(method, params = {}) {
        try {
            this.transport?.write(`${JSON.stringify({ method, params })}\n`);
        }
        catch {
            this.terminate(new UsageProviderError("unavailable"));
        }
    }
    receive(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const frame = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (Buffer.byteLength(frame) > this.maxFrameBytes) {
                this.terminate(new UsageProviderError("invalid-response"));
                return;
            }
            if (frame.length > 0 && !this.handleFrame(frame))
                return;
            newline = this.buffer.indexOf("\n");
        }
        if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
            this.terminate(new UsageProviderError("invalid-response"));
        }
    }
    handleFrame(frame) {
        let message;
        try {
            message = JSON.parse(frame);
        }
        catch {
            this.terminate(new UsageProviderError("invalid-response"));
            return false;
        }
        if (!isRecord$7(message) || !Number.isInteger(message.id))
            return true;
        const id = message.id;
        const pending = this.pending.get(id);
        if (!pending)
            return true;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        if (message.error !== undefined) {
            pending.reject(new UsageProviderError("unavailable"));
        }
        else if ("result" in message) {
            pending.resolve(message.result);
        }
        else {
            pending.reject(new UsageProviderError("invalid-response"));
        }
        return true;
    }
    terminate(error) {
        const transport = this.reset(error);
        if (transport)
            this.retire(transport);
    }
    retire(transport) {
        const previous = this.retirement;
        const retirement = (async () => {
            let previousError;
            if (previous) {
                try {
                    await previous;
                }
                catch (error) {
                    previousError = error;
                }
            }
            try {
                await this.retireTransport(transport);
            }
            catch (error) {
                throw sanitizeUsageError(error);
            }
            if (previousError)
                throw previousError;
        })();
        this.retirement = retirement;
        void retirement.catch(() => undefined);
    }
    async awaitRetirement() {
        const retirement = this.retirement;
        if (!retirement)
            return;
        try {
            await retirement;
        }
        finally {
            if (this.retirement === retirement)
                this.retirement = undefined;
        }
    }
    awaitTransportCreation(creation) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                settled = true;
                getImmediateStop(creation)?.();
                reject(new UsageProviderError("timeout"));
            }, this.timeoutMs);
            void creation.then((transport) => {
                if (settled) {
                    transport.stopImmediately();
                    this.retireDetached(transport);
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                resolve(transport);
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    retireDetached(transport) {
        void this.retireTransport(transport).catch(() => undefined);
    }
    retireTransport(transport) {
        const existing = this.retirementTasks.get(transport);
        if (existing)
            return existing;
        this.trackRetiringTransport(transport);
        const retirement = transport.stop().then(() => {
            this.confirmTransportExit(transport);
        }, (error) => {
            this.retirementTasks.delete(transport);
            throw sanitizeUsageError(error);
        });
        this.retirementTasks.set(transport, retirement);
        return retirement;
    }
    trackRetiringTransport(transport) {
        this.retiringTransports.add(transport);
        if (this.retirementExitListeners.has(transport))
            return;
        const remove = transport.onExitConfirmed?.(() => this.confirmTransportExit(transport));
        if (remove)
            this.retirementExitListeners.set(transport, remove);
    }
    confirmTransportExit(transport) {
        this.retirementTasks.delete(transport);
        this.retiringTransports.delete(transport);
        this.retirementExitListeners.get(transport)?.();
        this.retirementExitListeners.delete(transport);
    }
    reset(error) {
        const transport = this.transport;
        this.removeDataListener?.();
        this.removeExitListener?.();
        this.removeDataListener = undefined;
        this.removeExitListener = undefined;
        this.transport = undefined;
        this.initialization = undefined;
        this.buffer = "";
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        return transport;
    }
}
function classifyStartError(error) {
    if (error instanceof UsageProviderError)
        return error;
    return isRecord$7(error) && error.code === "ENOENT"
        ? new UsageProviderError("executable-not-found")
        : new UsageProviderError("unavailable");
}
function isRecord$7(value) {
    return typeof value === "object" && value !== null;
}
function getImmediateStop(creation) {
    if (!("stopImmediately" in creation))
        return undefined;
    const stopImmediately = creation.stopImmediately;
    return typeof stopImmediately === "function"
        ? stopImmediately.bind(creation)
        : undefined;
}

const WEEK_WINDOW_MINUTES = 7 * 24 * 60;
class CodexUsageProvider {
    id = "codex";
    client;
    now;
    constructor(options = {}) {
        this.client = options.client ?? new CodexAppServerClient();
        this.now = options.now ?? Date.now;
    }
    async getUsage() {
        try {
            const windows = parseRateLimits(await this.client.readRateLimits());
            if (!windows) {
                return { ok: false, error: new UsageProviderError("invalid-response") };
            }
            return { ok: true, usage: { windows, observedAt: this.now() } };
        }
        catch (error) {
            return { ok: false, error: sanitizeUsageError(error) };
        }
    }
    stop() {
        return this.client.stop();
    }
    recoverAfterWake() {
        this.client.recoverAfterWake();
    }
    stopImmediately() {
        this.client.stopImmediately();
    }
}
function parseRateLimits(value) {
    if (!isRecord$6(value))
        return undefined;
    const rateLimits = isRecord$6(value.rateLimits)
        ? value.rateLimits
        : isRecord$6(value.rate_limits)
            ? value.rate_limits
            : value;
    const windows = {};
    addWindow(windows, parseWindow$1(rateLimits.primary), "session");
    addWindow(windows, parseWindow$1(rateLimits.secondary), "week");
    return Object.keys(windows).length > 0 ? windows : undefined;
}
function addWindow(windows, window, fallbackName) {
    if (!window)
        return;
    const name = window.windowMinutes === undefined
        ? fallbackName
        : window.windowMinutes >= WEEK_WINDOW_MINUTES
            ? "week"
            : "session";
    windows[name] = window;
}
function parseWindow$1(value) {
    if (!isRecord$6(value))
        return undefined;
    const usedPercent = value.usedPercent ?? value.used_percent;
    if (!Number.isFinite(usedPercent))
        return undefined;
    const windowMinutes = value.windowDurationMins ?? value.window_minutes;
    const resetsAt = value.resetsAt ?? value.resets_at;
    return {
        usedPercent: usedPercent,
        ...(Number.isFinite(windowMinutes) ? { windowMinutes: windowMinutes } : {}),
        ...parseReset(resetsAt),
    };
}
function parseReset(value) {
    if (typeof value === "string")
        return { resetsAt: value };
    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value * 1_000);
        if (!Number.isNaN(date.valueOf()))
            return { resetsAt: date.toISOString() };
    }
    return {};
}
function isRecord$6(value) {
    return typeof value === "object" && value !== null;
}

let CodexUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.codex" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = RefreshingAction;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        coordinator;
        lastResult = null;
        constructor(coordinator = new UsageProviderCoordinator(new CodexUsageProvider())) {
            super();
            this.coordinator = coordinator;
        }
        async onWillAppear(ev) {
            const action = ev.action;
            if (!action.isDial())
                return;
            await this.activateOnAppearance(action, ev.payload.settings, () => action.setFeedbackLayout("layouts/openai.json"));
        }
        async onTouchTap(ev) {
            await this.refresh(ev.action);
        }
        async onDialUp(_ev) {
            await streamDeck.system.openUrl("https://chatgpt.com/codex/settings/usage");
        }
        async onDidReceiveSettings(ev) {
            if (!ev.action.isDial())
                return;
            this.configureRefresh(ev.action, ev.payload.settings);
            await this.refresh(ev.action);
        }
        async updateDisplay(action, isCurrent, force) {
            this.lastResult = await this.coordinator.getUsage({ force });
            const hasResetsAt = Boolean(this.lastResult.ok && this.lastResult.usage.windows.week?.resetsAt);
            if (hasResetsAt)
                this.configureAlternation(action, 3_000);
            const feedback = renderCodexFeedback(this.lastResult, false);
            if (isCurrent())
                await action.setFeedback(feedback);
        }
        async onAlternationTick(action, showCountdown) {
            if (!this.lastResult)
                return;
            const feedback = renderCodexFeedback(this.lastResult, showCountdown);
            const isCurrent = this.lifecycleGuard(action);
            if (isCurrent())
                await action.setFeedback(feedback);
        }
    });
    return _classThis;
})();

const GROK_ACP_METHODS = ["initialize", "x.ai/billing"];
const allowedMethods = new Set(GROK_ACP_METHODS);
const GROK_ACP_MAX_REQUEST_FRAME_BYTES = 1024;
const wireMethods = {
    initialize: "initialize",
    "x.ai/billing": "_x.ai/billing",
};
const initializationParams = {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "streamdeck-ai-usage", version: "1.0" },
};
function hasExactKeys(value, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const actualKeys = Object.keys(value).sort();
    const expectedKeys = [...keys].sort();
    return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}
function hasExactInitializationParams(value) {
    return (hasExactKeys(value, ["protocolVersion", "clientCapabilities", "clientInfo"]) &&
        value.protocolVersion === 1 &&
        hasExactKeys(value.clientCapabilities, []) &&
        hasExactKeys(value.clientInfo, ["name", "version"]) &&
        value.clientInfo.name === initializationParams.clientInfo.name &&
        value.clientInfo.version === initializationParams.clientInfo.version);
}
/** Serializes one allowlisted ACP request as a newline-delimited JSON-RPC frame. */
function encodeGrokAcpRequest(request) {
    if (!hasExactKeys(request, ["id", "method", "params"])) {
        throw new TypeError("Invalid ACP request fields");
    }
    if (!Number.isSafeInteger(request.id) || request.id < 1) {
        throw new TypeError("Invalid ACP request id");
    }
    if (!allowedMethods.has(request.method)) {
        throw new TypeError("ACP method is not allowlisted");
    }
    if ((request.method === "initialize" && !hasExactInitializationParams(request.params)) ||
        (request.method === "x.ai/billing" && !hasExactKeys(request.params, []))) {
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
function createGrokInitializationRequest(id) {
    return {
        id,
        method: "initialize",
        params: initializationParams,
    };
}
function createGrokBillingRequest(id) {
    return { id, method: "x.ai/billing", params: {} };
}
function encodeGrokInitializedNotification() {
    return `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`;
}

const GROK_ACP_MAX_RESPONSE_FRAME_BYTES = 64 * 1024;
const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
function grokExecutableCandidates(home = homedir()) {
    return [
        join(home, ".local", "bin", "grok"),
        "/opt/homebrew/bin/grok",
        "/usr/local/bin/grok",
        "/usr/bin/grok",
    ];
}
async function spawnGrokAcp(options = {}) {
    const candidates = options.grokPath
        ? [options.grokPath]
        : options.executableCandidates ?? grokExecutableCandidates();
    let identity;
    const resolveExecutable = options.resolveExecutable ?? resolveTrustedClaudeExecutable;
    const validateExecutable = options.validateExecutable ?? validateTrustedClaudeExecutable;
    for (const candidate of candidates) {
        const resolved = await resolveExecutable(candidate);
        if (!resolved)
            continue;
        try {
            if (!await validateExecutable(resolved))
                continue;
        }
        catch {
            continue;
        }
        identity = resolved;
        break;
    }
    if (!identity)
        throw new UsageProviderError("executable-not-found");
    const child = (options.spawnProcess ?? spawn)(identity.executable, ["agent", "stdio"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: safeRuntimeEnvironment(options.env ?? process.env),
    });
    return new ChildGrokAcpTransport(child, options);
}
function safeRuntimeEnvironment(source) {
    const env = {};
    for (const name of ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME"]) {
        if (source[name] !== undefined)
            env[name] = source[name];
    }
    env.PATH = FIXED_PATH;
    return env;
}
class ChildGrokAcpTransport {
    child;
    timeoutMs;
    stopGraceMs;
    killConfirmationMs;
    maxFrameBytes;
    buffer = "";
    decoder = new StringDecoder("utf8");
    stopped = false;
    exited = false;
    pending = new Map();
    constructor(child, options) {
        this.child = child;
        this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
        this.stopGraceMs = Math.max(1, options.stopGraceMs ?? 500);
        this.killConfirmationMs = Math.max(1, options.killConfirmationMs ?? 500);
        this.maxFrameBytes = Math.max(1, options.maxFrameBytes ?? GROK_ACP_MAX_RESPONSE_FRAME_BYTES);
        child.stderr.resume();
        child.stdout.on("data", (chunk) => this.receive(this.decoder.write(chunk)));
        child.once("error", () => this.retire("unavailable"));
        child.once("exit", () => { this.exited = true; this.retire("unavailable", false); });
        child.stdin.on("error", () => this.retire("unavailable"));
    }
    request(frame, id) {
        if (this.stopped)
            return Promise.reject(new UsageProviderError("stopped"));
        if (this.pending.has(id))
            return Promise.reject(new UsageProviderError("unavailable"));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.retire("timeout"), this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(frame);
        });
    }
    notify(frame) {
        if (this.stopped)
            throw new UsageProviderError("stopped");
        this.child.stdin.write(frame);
    }
    async stop() {
        if (this.exited)
            return;
        this.stopped = true;
        this.rejectAll("stopped");
        await new Promise((resolve, reject) => {
            let confirmation;
            const done = () => { clearTimeout(timer); if (confirmation)
                clearTimeout(confirmation); this.exited = true; resolve(); };
            const timer = setTimeout(() => {
                this.stopImmediately();
                confirmation = setTimeout(() => { this.child.off("exit", done); reject(new UsageProviderError("unavailable")); }, this.killConfirmationMs);
            }, this.stopGraceMs);
            this.child.once("exit", done);
            this.child.kill("SIGTERM");
        });
    }
    stopImmediately() {
        this.stopped = true;
        this.rejectAll("stopped");
        if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null)
            return true;
        try {
            return this.child.kill("SIGKILL");
        }
        catch {
            return false;
        }
    }
    onExitConfirmed(listener) {
        if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) {
            queueMicrotask(listener);
            return () => undefined;
        }
        this.child.once("exit", listener);
        return () => this.child.off("exit", listener);
    }
    receive(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
                this.retire("invalid-response");
                return;
            }
            if (line.trim())
                this.parseLine(line);
            if (this.stopped)
                return;
            newline = this.buffer.indexOf("\n");
        }
        if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes)
            this.retire("invalid-response");
    }
    parseLine(line) {
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            this.retire("invalid-response");
            return;
        }
        if (!isRecord$5(value) || value.jsonrpc !== "2.0") {
            this.retire("invalid-response");
            return;
        }
        if (!("id" in value))
            return; // Valid notification.
        if (!Number.isSafeInteger(value.id)) {
            this.retire("invalid-response");
            return;
        }
        const pending = this.pending.get(value.id);
        if (!pending)
            return;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        if ("error" in value || !("result" in value))
            pending.reject(new UsageProviderError("unavailable"));
        else
            pending.resolve(value.result);
    }
    retire(code, kill = true) {
        if (this.stopped)
            return;
        this.stopped = true;
        this.rejectAll(code);
        if (kill)
            this.stopImmediately();
    }
    rejectAll(code) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new UsageProviderError(code));
        }
        this.pending.clear();
    }
}
function isRecord$5(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

class GrokUsageProvider {
    id = "grok";
    factory;
    now;
    maxRetiringTransports;
    lifecycle = createLifecycle();
    retiringTransports = new Set();
    retirementTasks = new Map();
    retirementExitListeners = new Map();
    transportCreations = new Set();
    stopped = false;
    constructor(options = {}) {
        this.factory = options.transportFactory ?? spawnGrokAcp;
        this.now = options.now ?? Date.now;
        this.maxRetiringTransports = Math.max(1, options.maxRetiringTransports ?? 8);
    }
    getUsage() {
        if (this.stopped)
            return Promise.resolve({ ok: false, error: new UsageProviderError("stopped") });
        const lifecycle = this.lifecycle;
        const operation = lifecycle.queue.then(() => this.readUsage(lifecycle));
        lifecycle.queue = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async stop() {
        this.stopped = true;
        const lifecycle = this.lifecycle;
        await lifecycle.queue;
        await Promise.allSettled([...this.transportCreations]);
        const transport = lifecycle.transport;
        lifecycle.transport = undefined;
        if (transport)
            this.retiringTransports.add(transport);
        await Promise.all([...this.retiringTransports].map((entry) => this.retire(entry)));
    }
    stopImmediately() {
        this.stopped = true;
        const transport = this.lifecycle.transport;
        if (transport)
            this.retiringTransports.add(transport);
        this.lifecycle.transport = undefined;
        for (const transport of this.retiringTransports)
            transport.stopImmediately();
    }
    recoverAfterWake() {
        if (this.stopped)
            return;
        const previous = this.lifecycle;
        this.lifecycle = createLifecycle();
        const transport = previous.transport;
        previous.transport = undefined;
        if (transport)
            void this.retire(transport).catch(() => undefined);
    }
    async readUsage(lifecycle) {
        if (this.stopped || this.lifecycle !== lifecycle) {
            return { ok: false, error: new UsageProviderError(this.stopped ? "stopped" : "unavailable") };
        }
        try {
            if (!lifecycle.transport
                && this.retiringTransports.size + this.transportCreations.size >= this.maxRetiringTransports) {
                throw new UsageProviderError("unavailable");
            }
            let transport = lifecycle.transport;
            if (!transport) {
                const creation = Promise.resolve().then(() => this.factory());
                this.transportCreations.add(creation);
                let created;
                try {
                    created = await creation;
                }
                finally {
                    this.transportCreations.delete(creation);
                }
                if (this.stopped || this.lifecycle !== lifecycle) {
                    void this.retire(created).catch(() => undefined);
                    throw new UsageProviderError(this.stopped ? "stopped" : "unavailable");
                }
                lifecycle.transport = created;
                transport = created;
            }
            if (lifecycle.sequence === 0) {
                await this.send(transport, createGrokInitializationRequest(++lifecycle.sequence));
                transport.notify?.(encodeGrokInitializedNotification());
            }
            const billing = parseGrokBilling(await this.send(transport, createGrokBillingRequest(++lifecycle.sequence)));
            if (!billing)
                throw new UsageProviderError("invalid-response");
            return { ok: true, usage: { windows: { session: billing }, observedAt: this.now() } };
        }
        catch (error) {
            const failed = lifecycle.transport;
            lifecycle.transport = undefined;
            lifecycle.sequence = 0;
            if (failed)
                await this.retire(failed).catch(() => undefined);
            return { ok: false, error: sanitizeUsageError(error) };
        }
    }
    send(transport, request) {
        return transport.request(encodeGrokAcpRequest(request), request.id);
    }
    retire(transport) {
        const existing = this.retirementTasks.get(transport);
        if (existing)
            return existing;
        this.trackRetiringTransport(transport);
        const retirement = transport.stop().then(() => {
            this.confirmTransportExit(transport);
        }, (error) => {
            this.retirementTasks.delete(transport);
            transport.stopImmediately();
            throw sanitizeUsageError(error);
        });
        this.retirementTasks.set(transport, retirement);
        return retirement;
    }
    trackRetiringTransport(transport) {
        this.retiringTransports.add(transport);
        if (this.retirementExitListeners.has(transport))
            return;
        const remove = transport.onExitConfirmed?.(() => this.confirmTransportExit(transport));
        if (remove)
            this.retirementExitListeners.set(transport, remove);
    }
    confirmTransportExit(transport) {
        this.retirementTasks.delete(transport);
        this.retiringTransports.delete(transport);
        this.retirementExitListeners.get(transport)?.();
        this.retirementExitListeners.delete(transport);
    }
}
function createLifecycle() {
    return { sequence: 0, queue: Promise.resolve() };
}
function parseGrokBilling(value) {
    if (!isRecord$4(value))
        return undefined;
    const payload = isRecord$4(value.result) ? value.result : value;
    const config = isRecord$4(payload.config) ? payload.config : payload;
    let usedPercent;
    if (config.onDemandUsed !== undefined || config.onDemandCap !== undefined) {
        if (!isRecord$4(config.onDemandUsed) || !isRecord$4(config.onDemandCap))
            return undefined;
        const used = config.onDemandUsed.val;
        const cap = config.onDemandCap.val;
        if (typeof used !== "number" || !Number.isFinite(used) || used < 0
            || typeof cap !== "number" || !Number.isFinite(cap) || cap < 0)
            return undefined;
        if (cap === 0) {
            if (used !== 0)
                return undefined;
            usedPercent = 0;
        }
        else {
            usedPercent = used / cap * 100;
        }
    }
    else {
        usedPercent = config.creditUsagePercent ?? config.usedPercent ?? config.used_percent;
    }
    if (!Number.isFinite(usedPercent) && Number.isFinite(config.monthlyLimit) && Number.isFinite(config.used) && config.monthlyLimit > 0) {
        usedPercent = config.used / config.monthlyLimit * 100;
    }
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
        return undefined;
    const period = isRecord$4(config.currentPeriod) ? config.currentPeriod : undefined;
    const resetsAt = period?.end ?? config.resetsAt ?? config.resets_at;
    if (resetsAt !== undefined && (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt))))
        return undefined;
    return { usedPercent, ...(typeof resetsAt === "string" ? { resetsAt } : {}) };
}
function isRecord$4(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

let GrokUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.grok" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = RefreshingAction;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        coordinator;
        lastResult = null;
        constructor(coordinator = new UsageProviderCoordinator(new GrokUsageProvider())) {
            super();
            this.coordinator = coordinator;
        }
        async onWillAppear(ev) {
            const action = ev.action;
            if (!action.isDial())
                return;
            await this.activateOnAppearance(action, ev.payload.settings, () => action.setFeedbackLayout("layouts/grok.json"));
        }
        async onTouchTap(ev) {
            await this.refresh(ev.action);
        }
        async onDidReceiveSettings(ev) {
            if (!ev.action.isDial())
                return;
            this.configureRefresh(ev.action, ev.payload.settings);
            await this.refresh(ev.action);
        }
        async updateDisplay(action, isCurrent, force) {
            this.lastResult = await this.coordinator.getUsage({ force });
            const hasResetsAt = Boolean(this.lastResult.ok && this.lastResult.usage.windows.session?.resetsAt);
            if (hasResetsAt)
                this.configureAlternation(action, 3_000);
            const feedback = renderGrokFeedback(this.lastResult, false);
            if (isCurrent())
                await action.setFeedback(feedback);
        }
        async onAlternationTick(action, showCountdown) {
            if (!this.lastResult)
                return;
            const feedback = renderGrokFeedback(this.lastResult, showCountdown);
            const isCurrent = this.lifecycleGuard(action);
            if (isCurrent())
                await action.setFeedback(feedback);
        }
    });
    return _classThis;
})();

const NAN_KEYCHAIN_TIMEOUT_MS = 2_000;
const NAN_KEYCHAIN_IMPORT_TIMEOUT_MS = 30_000;
const NAN_KEYCHAIN_MAX_STDIN_BYTES = 8 * 1024;
const NAN_KEYCHAIN_MAX_STDOUT_BYTES = 8 * 1024;
function resolveNanKeychainHelperPath(moduleUrl) {
    return fileURLToPath(new URL("./nan-keychain", moduleUrl));
}
class NanKeychainClient {
    run;
    helperPath;
    constructor(run = runNanKeychain, helperPath = resolveNanKeychainHelperPath(import.meta.url)) {
        this.run = run;
        this.helperPath = helperPath;
    }
    async putSessionCache(secret) {
        await this.request({ operation: "put", secret }, false, NAN_KEYCHAIN_TIMEOUT_MS);
    }
    async getSessionCache() {
        return this.request({ operation: "get" }, true, NAN_KEYCHAIN_TIMEOUT_MS);
    }
    async deleteSessionCache() {
        await this.request({ operation: "delete" }, false, NAN_KEYCHAIN_TIMEOUT_MS);
    }
    async getChromeSafeStorage() {
        return this.request({ operation: "getChromeSafeStorage" }, true, NAN_KEYCHAIN_IMPORT_TIMEOUT_MS);
    }
    async request(payload, expectsSecret, timeoutMs) {
        const stdin = `${JSON.stringify(payload)}\n`;
        if (Buffer.byteLength(stdin, "utf8") > NAN_KEYCHAIN_MAX_STDIN_BYTES)
            throw unavailable$1();
        let result;
        try {
            result = await this.run({
                executable: this.helperPath,
                args: [],
                stdin,
                timeoutMs,
                maxStdoutBytes: NAN_KEYCHAIN_MAX_STDOUT_BYTES,
            });
        }
        catch {
            throw unavailable$1();
        }
        if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > NAN_KEYCHAIN_MAX_STDOUT_BYTES)
            throw unavailable$1();
        let response;
        try {
            response = JSON.parse(result.stdout);
        }
        catch {
            throw unavailable$1();
        }
        if (!isRecord$3(response) || response.ok !== true)
            throw unavailable$1();
        if (!expectsSecret)
            return;
        if (typeof response.secret !== "string" && response.secret !== null)
            throw unavailable$1();
        return response.secret;
    }
}
function runNanKeychain(request) {
    return new Promise((resolve, reject) => {
        let completed = false;
        let stdout = "";
        let stdoutBytes = 0;
        const child = spawn(request.executable, [...request.args], {
            env: {},
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
        });
        const finish = (callback) => {
            if (completed)
                return;
            completed = true;
            clearTimeout(timeout);
            callback();
        };
        const fail = () => finish(() => {
            child.kill("SIGKILL");
            reject(unavailable$1());
        });
        const timeout = setTimeout(fail, request.timeoutMs);
        child.once("error", fail);
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > request.maxStdoutBytes)
                return fail();
            stdout += chunk.toString("utf8");
        });
        child.stdin.once("error", fail);
        child.once("close", (exitCode) => finish(() => resolve({ exitCode: exitCode ?? 1, stdout })));
        child.stdin.end(request.stdin, "utf8");
    });
}
function unavailable$1() {
    return new Error("Keychain helper unavailable");
}
function isRecord$3(value) {
    return typeof value === "object" && value !== null;
}

const MAX_PROFILES = 8;
const MAX_ROWS = 32;
const MAX_BLOB_BYTES = 8 * 1024;
const MAX_STRING_BYTES = 4 * 1024;
const CHROME_EPOCH_MS = 11_644_473_600_000;
/** Explicit-call-only Chrome importer. It never runs during construction or module loading. */
class NanChromeCookieImporter {
    homes;
    getChromeSafeStorage;
    now;
    constructor(dependencies = {}) {
        this.homes = dependencies.homes ?? [homedir()];
        this.getChromeSafeStorage = dependencies.getChromeSafeStorage ?? (() => new NanKeychainClient().getChromeSafeStorage());
        this.now = dependencies.now ?? (() => new Date());
    }
    /** Returns separate candidates per profile and cookie store; callers must validate one candidate without merging them. */
    async importCandidates() {
        const stores = [];
        for (const home of this.homes) {
            const root = await chromeRoot(home);
            if (!root)
                continue;
            for (const profile of await profileDirectories(root)) {
                for (const store of await readRelevantStores(profile)) {
                    if (store.rows.length > 0 && !stores.some((existing) => identicalStore(existing, store)))
                        stores.push(store);
                }
            }
        }
        const needsKey = stores.some(({ rows }) => rows.some((row) => !row.value));
        let password = null;
        if (needsKey) {
            try {
                password = await this.getChromeSafeStorage();
            }
            catch {
                throw new NanChromeImportError("permission-or-keychain");
            }
            if (!password)
                throw new NanChromeImportError("permission-or-keychain");
        }
        const candidates = [];
        for (const { profile, store, rows } of stores) {
            const cookies = decryptRows(rows, password, this.now());
            if (cookies.length > 0)
                candidates.push({ profileId: profile.name, store, cookies });
        }
        return candidates;
    }
}
class NanChromeImportError extends Error {
    kind;
    constructor(kind) {
        super(kind === "unsupported-format" ? "Chrome cookie format unsupported" : "Chrome cookies unavailable");
        this.kind = kind;
    }
}
async function chromeRoot(home) {
    const suppliedHome = resolve(home);
    const homeStat = await lstatOrAbsent(suppliedHome);
    if (!homeStat)
        return null;
    if (!homeStat.isDirectory())
        throw new NanChromeImportError("unavailable");
    let canonicalHome;
    try {
        canonicalHome = await realpath(suppliedHome);
    }
    catch (error) {
        if (isNotFound(error))
            return null;
        throw new NanChromeImportError("unavailable");
    }
    return directoryUnder(canonicalHome, ["Library", "Application Support", "Google", "Chrome"]);
}
async function profileDirectories(root) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        throw new NanChromeImportError("unavailable");
    }
    const names = entries
        .filter((entry) => entry.isDirectory() && allowedProfileName(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    if (names.length > MAX_PROFILES)
        throw new NanChromeImportError("unavailable");
    const profiles = [];
    for (const name of names) {
        const path = await directoryUnder(root, [name]);
        if (path)
            profiles.push({ name, path });
    }
    return profiles;
}
function allowedProfileName(name) {
    return name === "Default" || name.startsWith("Profile ") || name.startsWith("user-");
}
async function readRelevantStores(profile) {
    const stores = [];
    for (const store of ["Network", "Cookies"]) {
        const path = store === "Network"
            ? await fileUnder(profile.path, ["Network", "Cookies"])
            : await fileUnder(profile.path, ["Cookies"]);
        if (!path)
            continue;
        const rows = await readRelevantRows(path);
        if (rows.length > 0)
            stores.push({ profile, store, rows });
    }
    return stores;
}
async function directoryUnder(parent, parts) {
    let path = parent;
    for (const part of parts) {
        path = join(path, part);
        const stat = await lstatOrAbsent(path);
        if (!stat)
            return null;
        if (stat.isSymbolicLink())
            return null;
        if (!stat.isDirectory())
            throw new NanChromeImportError("unavailable");
    }
    return canonicalPath(parent, path);
}
async function fileUnder(parent, parts) {
    const directories = parts.slice(0, -1);
    const filename = parts.at(-1);
    if (!filename)
        return null;
    const directory = await directoryUnder(parent, directories);
    if (!directory)
        return null;
    const path = join(directory, filename);
    const stat = await lstatOrAbsent(path);
    if (!stat)
        return null;
    if (stat.isSymbolicLink())
        return null;
    if (!stat.isFile())
        throw new NanChromeImportError("unavailable");
    return canonicalPath(parent, path);
}
async function lstatOrAbsent(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (isNotFound(error))
            return null;
        throw new NanChromeImportError("unavailable");
    }
}
async function canonicalPath(parent, path) {
    try {
        const canonical = await realpath(path);
        return inside(parent, canonical) ? canonical : null;
    }
    catch (error) {
        if (isNotFound(error))
            return null;
        throw new NanChromeImportError("unavailable");
    }
}
async function readRelevantRows(path) {
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        throw new NanChromeImportError("unavailable");
    }
    try {
        const versionRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("version");
        const version = parseVersion(versionRow?.value);
        if (version === undefined)
            throw new NanChromeImportError("unsupported-format");
        const statement = db.prepare("SELECT host_key, name, path, expires_utc, is_secure, value, encrypted_value FROM cookies WHERE host_key IN (?, ?, ?, ?) LIMIT ?");
        statement.setReadBigInts(true);
        const rows = statement.all("cloud-api.nan.builders", ".cloud-api.nan.builders", "nan.builders", ".nan.builders", MAX_ROWS + 1);
        if (rows.length > MAX_ROWS)
            throw new NanChromeImportError("unavailable");
        return rows.map((row) => rowFrom(row, version));
    }
    catch (error) {
        if (error instanceof NanChromeImportError)
            throw error;
        throw new NanChromeImportError("unsupported-format");
    }
    finally {
        try {
            db.close();
        }
        catch { }
    }
}
function rowFrom(row, version) {
    const expires = typeof row.expires_utc === "bigint" ? row.expires_utc
        : typeof row.expires_utc === "number" && Number.isSafeInteger(row.expires_utc) ? BigInt(row.expires_utc) : undefined;
    const secure = typeof row.is_secure === "bigint" ? Number(row.is_secure) : row.is_secure;
    if (typeof row.host_key !== "string" || typeof row.name !== "string" || typeof row.path !== "string" || typeof secure !== "number"
        || typeof row.value !== "string" || expires === undefined || !(row.encrypted_value instanceof Uint8Array)
        || !boundedString(row.host_key) || !boundedString(row.name) || !boundedString(row.path) || !boundedString(row.value)
        || row.encrypted_value.byteLength > MAX_BLOB_BYTES)
        throw new NanChromeImportError("unsupported-format");
    return { host: row.host_key, name: row.name, path: row.path, expires, secure, value: row.value, encrypted: row.encrypted_value, version };
}
function decryptRows(rows, password, now) {
    const encrypted = rows.some((row) => !row.value);
    if (encrypted && !password)
        return [];
    const key = encrypted ? pbkdf2Sync(Buffer.from(password, "utf8"), "saltysalt", 1003, 16, "sha1") : null;
    try {
        return rows.flatMap((row) => cookieFrom(row, key, now));
    }
    finally {
        key?.fill(0);
    }
}
function cookieFrom(row, key, now) {
    if (row.secure !== 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.name) || !row.path.startsWith("/"))
        return [];
    const value = row.value || key && decrypt(row, key);
    if (!value || !/^[!#$%&'()*+\-./0-9:<=>?@A-Z\[\]^_`a-z{|}~]*$/.test(value))
        return [];
    const expiresAt = chromeExpiry(row.expires, now);
    if (expiresAt === "expired")
        return [];
    const hostOnly = !row.host.startsWith(".");
    const domain = row.host.replace(/^\./, "").toLowerCase();
    return [{ name: row.name, value, domain, hostOnly, path: row.path, secure: true, expiresAt }];
}
function decrypt(row, key) {
    if (row.encrypted.byteLength < 4 || Buffer.from(row.encrypted.subarray(0, 3)).toString("ascii") !== "v10")
        return null;
    try {
        const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
        const plain = Buffer.concat([decipher.update(row.encrypted.subarray(3)), decipher.final()]);
        const value = row.version >= 24 ? stripHostHash(plain, row.host) : plain;
        return value ? new TextDecoder("utf-8", { fatal: true }).decode(value) : null;
    }
    catch {
        return null;
    }
}
function identicalStore(left, right) {
    return left.profile.path === right.profile.path && left.rows.length === right.rows.length && left.rows.every((row, index) => identicalRow(row, right.rows[index]));
}
function identicalRow(left, right) {
    return !!right && left.host === right.host && left.name === right.name && left.path === right.path
        && left.expires === right.expires && left.secure === right.secure && left.value === right.value
        && left.version === right.version && Buffer.from(left.encrypted).equals(Buffer.from(right.encrypted));
}
function parseVersion(value) {
    if (typeof value === "string" && /^\d+$/.test(value))
        value = Number(value);
    if (typeof value === "bigint")
        value = Number(value);
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function stripHostHash(value, host) {
    const digest = createHash("sha256").update(host).digest();
    return value.subarray(0, 32).equals(digest) ? value.subarray(32) : null;
}
function chromeExpiry(value, now) {
    if (value === 0n)
        return null;
    const milliseconds = value / 1000n - BigInt(CHROME_EPOCH_MS);
    const maxDateMilliseconds = 8640000000000000n;
    const nowMilliseconds = now.valueOf();
    if (!Number.isFinite(nowMilliseconds) || milliseconds < -maxDateMilliseconds || milliseconds > maxDateMilliseconds)
        return "expired";
    if (milliseconds <= BigInt(nowMilliseconds))
        return "expired";
    return new Date(Number(milliseconds)).toISOString();
}
function boundedString(value) {
    return Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES;
}
function inside(parent, child) {
    const result = relative(resolve(parent), resolve(child));
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`));
}
function isNotFound(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const NAN_DASHBOARD_QUOTA_URL$1 = "https://cloud-api.nan.builders/api/usage/quota";
const NAN_DASHBOARD_METRICS_URL$1 = "https://cloud-api.nan.builders/api/metrics/usage";
const RESOURCE_URLS = {
    quota: NAN_DASHBOARD_QUOTA_URL$1,
    metrics: NAN_DASHBOARD_METRICS_URL$1,
};
const MAX_COOKIE_HEADER_BYTES = 4 * 1024;
const TIMEOUT_MS = 5_000;
const systemClock = { setTimeout, clearTimeout };
/**
 * Fixed-route dashboard transport. It intentionally has no arbitrary endpoint API:
 * quota and metrics are the only resources whose supplied Cookie header it sends.
 */
async function getNanDashboardJson(options) {
    const fetcher = options.fetcher ?? fetch;
    const clock = options.clock ?? systemClock;
    if (!isSafeCookieHeader(options.cookieHeader))
        throw options.createError("transport");
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
    }
    catch (error) {
        if (options.isExpectedError(error))
            throw error;
        throw options.createError("transport");
    }
    finally {
        clock.clearTimeout(timer);
    }
}
async function readJson(response, signal, maxResponseBytes, createError) {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxResponseBytes) {
        safeCancel(response.body);
        throw createError("transport");
    }
    if (!response.body)
        throw createError("transport");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const next = await abortable(reader.read(), signal, createError);
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > maxResponseBytes)
                throw createError("transport");
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
        }
        catch {
            throw createError("schema");
        }
    }
    catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
function abortable(promise, signal, createError) {
    if (signal.aborted)
        return Promise.reject(createError("transport"));
    return new Promise((resolve, reject) => {
        const abort = () => reject(createError("transport"));
        signal.addEventListener("abort", abort, { once: true });
        void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
function safeCancel(body) {
    void body?.cancel().catch(() => undefined);
}
function isSafeCookieHeader(value) {
    return typeof value === "string" && value.length > 0
        && Buffer.byteLength(value, "utf8") <= MAX_COOKIE_HEADER_BYTES
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

const NAN_DASHBOARD_METRICS_URL = NAN_DASHBOARD_METRICS_URL$1;
const MAX_RESPONSE_BYTES$1 = 256 * 1024;
class NanDashboardMetricsError extends Error {
    kind;
    constructor(kind) {
        super(kind === "auth-rejected"
            ? "NaN dashboard session rejected"
            : kind === "schema" ? "NaN dashboard metrics response invalid" : "NaN dashboard unavailable");
        this.kind = kind;
    }
}
class NanDashboardMetricsClient {
    fetcher;
    clock;
    /**
     * This client neither acquires nor persists credentials. Callers must rebuild a
     * Cookie header scoped to /api/metrics/usage; quota-path cookies are not reusable.
     */
    constructor(fetcher = fetch, clock = { setTimeout, clearTimeout }) {
        this.fetcher = fetcher;
        this.clock = clock;
    }
    async getMetrics(cookieHeader) {
        const value = await getNanDashboardJson({
            resource: "metrics",
            cookieHeader,
            fetcher: this.fetcher,
            clock: this.clock,
            maxResponseBytes: MAX_RESPONSE_BYTES$1,
            createError: (kind) => new NanDashboardMetricsError(kind),
            isExpectedError: (error) => error instanceof NanDashboardMetricsError,
        });
        return parseNanDashboardMetrics(value);
    }
}
function parseNanDashboardMetrics(value) {
    if (!isRecord$2(value))
        throw new NanDashboardMetricsError("schema");
    const last24h = parseWindow(value.last24h);
    const last30d = parseWindow(value.last30d);
    const monthToDate = parseWindow(value.monthToDate);
    const allTime = parseAllTimeWindow(value.allTime);
    return Object.freeze({ last24h, last30d, monthToDate, allTime });
}
function parseAllTimeWindow(value) {
    if (!isRecord$2(value))
        throw new NanDashboardMetricsError("schema");
    const window = parseWindow(value, true);
    if (value.cachedAt === undefined)
        return window;
    if (typeof value.cachedAt !== "string" || !isIsoTimestamp$1(value.cachedAt))
        throw new NanDashboardMetricsError("schema");
    return Object.freeze({ ...window, cachedAt: value.cachedAt });
}
function parseWindow(value, allowCachedAt = false) {
    if (!isRecord$2(value) || !isCounter$1(value.totalTokens) || !Array.isArray(value.byModel) || (!allowCachedAt && value.cachedAt !== undefined)) {
        throw new NanDashboardMetricsError("schema");
    }
    const names = new Set();
    const byModel = [];
    for (const entry of value.byModel) {
        if (!isRecord$2(entry) || !isModelName$1(entry.model) || !isCounter$1(entry.inputTokens) || !isCounter$1(entry.outputTokens)) {
            throw new NanDashboardMetricsError("schema");
        }
        if (names.has(entry.model) || entry.inputTokens > Number.MAX_SAFE_INTEGER - entry.outputTokens) {
            throw new NanDashboardMetricsError("schema");
        }
        names.add(entry.model);
        byModel.push(Object.freeze({
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.inputTokens + entry.outputTokens,
        }));
    }
    return Object.freeze({ totalTokens: value.totalTokens, byModel: Object.freeze(byModel) });
}
function isRecord$2(value) {
    return typeof value === "object" && value !== null;
}
function isModelName$1(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128
        && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function isCounter$1(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isIsoTimestamp$1(value) {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && calendarDate$1(value) !== null && !Number.isNaN(new Date(value).valueOf());
}
function calendarDate$1(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match)
        return null;
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

const NAN_DASHBOARD_QUOTA_URL = NAN_DASHBOARD_QUOTA_URL$1;
const MAX_RESPONSE_BYTES = 64 * 1024;
class NanDashboardQuotaError extends Error {
    kind;
    constructor(kind) {
        super(kind === "auth-rejected"
            ? "NaN dashboard session rejected"
            : kind === "schema" ? "NaN dashboard quota response invalid" : "NaN dashboard unavailable");
        this.kind = kind;
    }
}
class NanDashboardQuotaClient {
    fetcher;
    clock;
    constructor(fetcher = fetch, clock = { setTimeout, clearTimeout }) {
        this.fetcher = fetcher;
        this.clock = clock;
    }
    async getQuota(cookieHeader) {
        const value = await getNanDashboardJson({
            resource: "quota",
            cookieHeader,
            fetcher: this.fetcher,
            clock: this.clock,
            maxResponseBytes: MAX_RESPONSE_BYTES,
            createError: (kind) => new NanDashboardQuotaError(kind),
            isExpectedError: (error) => error instanceof NanDashboardQuotaError,
        });
        return parseNanDashboardQuota(value);
    }
}
function parseNanDashboardQuota(value) {
    if (!isRecord$1(value) || !isDateOnly(value.periodStart) || !Array.isArray(value.models)) {
        throw new NanDashboardQuotaError("schema");
    }
    const names = new Set();
    const models = [];
    const uncappedModels = [];
    for (const entry of value.models) {
        if (!isRecord$1(entry) || !isModelName(entry.model) || !isCounter(entry.cap) || !isCounter(entry.tokensUsed)) {
            throw new NanDashboardQuotaError("schema");
        }
        if (names.has(entry.model))
            throw new NanDashboardQuotaError("schema");
        names.add(entry.model);
        const resetAt = optionalDate(entry.periodEnd);
        const windowHours = optionalWindow(entry.windowHours);
        if (entry.cap === 0) {
            uncappedModels.push({ model: entry.model, tokensUsed: entry.tokensUsed, resetAt, windowHours });
            continue;
        }
        models.push({
            model: entry.model,
            cap: entry.cap,
            tokensUsed: entry.tokensUsed,
            percentage: entry.tokensUsed / entry.cap * 100,
            resetAt,
            windowHours,
        });
    }
    return { eligibility: "unknown", models, uncappedModels };
}
function isRecord$1(value) {
    return typeof value === "object" && value !== null;
}
function isModelName(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128
        && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function isCounter(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalDate(value) {
    if (value == null)
        return null;
    if (typeof value !== "string" || !isIsoTimestamp(value))
        throw new NanDashboardQuotaError("schema");
    return value;
}
function optionalWindow(value) {
    if (value == null)
        return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw new NanDashboardQuotaError("schema");
    return value;
}
function isDateOnly(value) {
    return typeof value === "string" && calendarDate(value) !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function isIsoTimestamp(value) {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && calendarDate(value) !== null && !Number.isNaN(new Date(value).valueOf());
}
function calendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match)
        return null;
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

const VERSION = 1;
const SCOPE = "nan-dashboard-session";
const MAX_BYTES = 4 * 1024;
const MAX_COOKIES = 32;
const quotaUrl = new URL(NAN_DASHBOARD_QUOTA_URL);
const metricsUrl = new URL(NAN_DASHBOARD_METRICS_URL);
/** A shared instance serializes cache writes and auth-driven eviction. */
class NanDashboardSessionStore {
    pending = Promise.resolve();
    keychain;
    quota;
    metrics;
    now;
    constructor(keychain = new NanKeychainClient(), quota = new NanDashboardQuotaClient(), now = () => new Date(), metrics = new NanDashboardMetricsClient()) {
        this.keychain = keychain;
        this.quota = quota;
        this.metrics = metrics;
        this.now = now;
    }
    /** Validates a canonical explicit candidate before persisting it to Keychain. */
    validateAndStore(cookies) {
        return this.serial(async () => {
            let candidate;
            try {
                candidate = canonicalSession(cookies, this.now());
            }
            catch {
                return { state: "needs-import" };
            }
            const secret = JSON.stringify({ version: VERSION, scope: SCOPE, cookies: candidate.cookies });
            if (Buffer.byteLength(secret, "utf8") > MAX_BYTES)
                return { state: "needs-import" };
            try {
                const quota = await this.quota.getQuota(candidate.quotaHeader);
                try {
                    await this.keychain.putSessionCache(secret);
                }
                catch {
                    return { state: "keychain-unavailable" };
                }
                return { state: "ready", quota };
            }
            catch (error) {
                if (error instanceof NanDashboardQuotaError && error.kind === "transport")
                    return { state: "transient" };
                if (error instanceof NanDashboardQuotaError && error.kind === "schema")
                    return { state: "schema-invalid" };
                return { state: "needs-import" };
            }
        });
    }
    /** Reads only the cache and never invokes browser acquisition. */
    getCachedQuota() {
        return this.serial(async () => {
            const candidate = await this.readCachedSession();
            if ("state" in candidate)
                return candidate;
            try {
                return { state: "ready", quota: await this.quota.getQuota(candidate.quotaHeader) };
            }
            catch (error) {
                return this.quotaFailure(error);
            }
        });
    }
    /** Reads quota and metrics once from the same cached session without credential acquisition. */
    getCachedDashboard() {
        return this.serial(async () => {
            const candidate = await this.readCachedSession();
            if ("state" in candidate)
                return candidate;
            let quota;
            try {
                quota = await this.quota.getQuota(candidate.quotaHeader);
            }
            catch (error) {
                return this.quotaFailure(error);
            }
            // A cache created before metrics-only cookies existed remains usable for quota.
            if (!candidate.metricsHeader)
                return { state: "ready", quota, metricsError: "unavailable" };
            try {
                return { state: "ready", quota, metrics: await this.metrics.getMetrics(candidate.metricsHeader) };
            }
            catch (error) {
                return { state: "ready", quota, metricsError: metricsFailure(error) };
            }
        });
    }
    async readCachedSession() {
        let encoded;
        try {
            encoded = await this.keychain.getSessionCache();
        }
        catch {
            return { state: "keychain-unavailable" };
        }
        if (!encoded)
            return { state: "needs-import" };
        try {
            return canonicalSession(decodeSession(encoded), this.now());
        }
        catch {
            return this.evict();
        }
    }
    quotaFailure(error) {
        if (error instanceof NanDashboardQuotaError && error.kind === "auth-rejected")
            return this.evict();
        if (error instanceof NanDashboardQuotaError && error.kind === "schema")
            return { state: "schema-invalid" };
        return { state: "transient" };
    }
    async evict() {
        try {
            await this.keychain.deleteSessionCache();
            return { state: "needs-import" };
        }
        catch {
            return { state: "eviction-failed" };
        }
    }
    serial(operation) {
        const next = this.pending.catch(() => undefined).then(operation);
        this.pending = next.then(() => undefined, () => undefined);
        return next;
    }
}
function canonicalSession(records, now) {
    const cookies = canonicalCookies(records, now).filter((cookie) => matchesTarget(cookie, quotaUrl) || matchesTarget(cookie, metricsUrl));
    const quotaHeader = buildHeader(cookies, quotaUrl);
    if (!quotaHeader)
        throw new Error("invalid session");
    return { cookies, quotaHeader, metricsHeader: buildHeader(cookies, metricsUrl) };
}
function canonicalCookies(records, now) {
    if (!Number.isFinite(now.valueOf()) || records.length === 0 || records.length > MAX_COOKIES)
        throw new Error("invalid session");
    const identities = new Set();
    return records.flatMap((record) => {
        const cookie = canonicalCookie(record);
        const identity = `${cookie.name}\n${cookie.domain}\n${cookie.path}\n${cookie.hostOnly}`;
        if (identities.has(identity))
            throw new Error("ambiguous session");
        identities.add(identity);
        return isExpired(cookie, now) ? [] : [cookie];
    }).sort((a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name));
}
function buildHeader(cookies, target) {
    const header = cookies.filter((cookie) => matchesTarget(cookie, target)).map(({ name, value }) => `${name}=${value}`).join("; ");
    if (Buffer.byteLength(header, "utf8") > MAX_BYTES)
        throw new Error("invalid session");
    return header;
}
function decodeSession(encoded) {
    if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES)
        throw new Error("invalid session");
    const value = JSON.parse(encoded);
    if (!isRecord(value) || value.version !== VERSION || value.scope !== SCOPE || !Array.isArray(value.cookies))
        throw new Error("invalid session");
    return value.cookies;
}
function canonicalCookie(value) {
    if (!isRecord(value) || !isToken(value.name) || typeof value.value !== "string" || !isCookieValue(value.value)
        || typeof value.domain !== "string" || typeof value.hostOnly !== "boolean" || typeof value.path !== "string"
        || !value.path.startsWith("/") || value.secure !== true || !validExpiry(value.expiresAt))
        throw new Error("invalid session");
    const domain = value.domain.toLowerCase();
    const normalized = value.hostOnly ? domain : domain.replace(/^\./, "");
    if (!normalized || containsControl(normalized))
        throw new Error("invalid session");
    return { name: value.name, value: value.value, domain: normalized, hostOnly: value.hostOnly, path: value.path, secure: true, expiresAt: value.expiresAt };
}
function matchesTarget(cookie, target) {
    return matchesHost(cookie, target) && matchesPath(cookie.path, target.pathname);
}
function matchesHost(cookie, target) {
    return cookie.hostOnly ? cookie.domain === target.hostname : cookie.domain === "nan.builders" || cookie.domain === target.hostname;
}
function matchesPath(path, target) { return target.startsWith(path) && (path.endsWith("/") || target.length === path.length || target[path.length] === "/"); }
function isExpired(cookie, now) { return cookie.expiresAt !== null && new Date(cookie.expiresAt).valueOf() <= now.valueOf(); }
function metricsFailure(error) {
    if (error instanceof NanDashboardMetricsError && error.kind === "schema")
        return "schema-invalid";
    return error instanceof NanDashboardMetricsError && error.kind === "transport" ? "transient" : "unavailable";
}
function validExpiry(value) { return value === null || typeof value === "string" && isValidIso(value); }
function isValidIso(value) { const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value); if (!m || Number.isNaN(new Date(value).valueOf()))
    return false; const [y, mo, d] = m.slice(1).map(Number), date = new Date(Date.UTC(y, mo - 1, d)); return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d; }
function isToken(value) { return typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value); }
function isCookieValue(value) { return /^[!#$%&'()*+\-./0-9:<=>?@A-Z\[\]^_`a-z{|}~]*$/.test(value); }
function containsControl(value) { return /[\u0000-\u001f\u007f-\u009f]/.test(value); }
function isRecord(value) { return typeof value === "object" && value !== null; }

/** Coordinates cached dashboard reads without acquiring Chrome data implicitly. */
class NanDashboardController {
    lastDashboardQuota;
    lastDashboardMetrics;
    lastMetricsError;
    importInFlight;
    dashboardReadInFlight;
    dashboardCacheInvalidated = false;
    dashboardEpoch = 0;
    listeners = new Set();
    dashboardWatchers = new Set();
    dashboardWatchTimer;
    sessions;
    importer;
    watchScheduler;
    constructor(sessions = new NanDashboardSessionStore(), importer = new NanChromeCookieImporter(), watchScheduler = defaultWatchScheduler) {
        this.sessions = sessions;
        this.importer = importer;
        this.watchScheduler = watchScheduler;
    }
    isImporting() { return this.importInFlight !== undefined; }
    isDashboardWatched() { return this.dashboardWatchers.size > 0; }
    /** Leases the one shared dashboard poll for visible aggregate keypad actions. */
    watchDashboard() {
        const watcher = Symbol("dashboard-watcher");
        this.dashboardWatchers.add(watcher);
        if (this.dashboardWatchers.size === 1) {
            void this.getUsage({ source: "dashboard" });
            this.dashboardWatchTimer = this.watchScheduler.setInterval(() => void this.getUsage({ source: "dashboard" }), 30_000);
        }
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            this.dashboardWatchers.delete(watcher);
            if (this.dashboardWatchers.size !== 0 || !this.dashboardWatchTimer)
                return;
            this.watchScheduler.clearInterval(this.dashboardWatchTimer);
            this.dashboardWatchTimer = undefined;
        };
    }
    /** Subscribes visible dashboard consumers to completed shared snapshot reads. */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async getUsage(settings, options = {}) {
        if (settings.source !== undefined && settings.source !== "dashboard" && settings.source !== "legacy") {
            return { source: "dashboard", stale: false, error: "invalid-source" };
        }
        return options.cacheWhileWatched && this.isDashboardWatched()
            ? this.cachedDashboardUsage()
            : this.getDashboardUsage();
    }
    getCachedUsage(settings) {
        if (settings.source !== undefined && settings.source !== "dashboard" && settings.source !== "legacy") {
            return { source: "dashboard", stale: false, error: "invalid-source" };
        }
        return this.cachedDashboardUsage();
    }
    importChromeSession() {
        if (this.importInFlight)
            return Promise.resolve({ state: "import-busy" });
        // A replacement account invalidates both endpoint snapshots before the importer runs.
        this.dashboardEpoch += 1;
        this.lastDashboardQuota = undefined;
        this.lastDashboardMetrics = undefined;
        this.lastMetricsError = undefined;
        this.dashboardCacheInvalidated = true;
        const request = this.importCandidates().then((result) => {
            this.notify(result.state === "ready"
                ? { source: "dashboard", quota: result.quota, stale: false, metricsStale: false }
                : { source: "dashboard", stale: false, error: result.state });
            return result;
        }).finally(() => {
            if (this.importInFlight === request)
                this.importInFlight = undefined;
        });
        this.importInFlight = request;
        return request;
    }
    getDashboardUsage() {
        if (this.dashboardReadInFlight)
            return this.dashboardReadInFlight;
        const request = this.readDashboardUsage().then((usage) => {
            this.notify(usage);
            return usage;
        }).finally(() => {
            if (this.dashboardReadInFlight === request)
                this.dashboardReadInFlight = undefined;
        });
        this.dashboardReadInFlight = request;
        return request;
    }
    async readDashboardUsage() {
        if (this.importInFlight)
            return { source: "dashboard", stale: false, error: "import-busy" };
        if (this.dashboardCacheInvalidated)
            return { source: "dashboard", stale: false, error: "needs-import" };
        const epoch = this.dashboardEpoch;
        let result;
        try {
            result = await this.sessions.getCachedDashboard();
        }
        catch {
            result = { state: "transient" };
        }
        // A late result from the prior account must not repopulate either endpoint snapshot.
        if (epoch !== this.dashboardEpoch)
            return { source: "dashboard", stale: false, error: "needs-import" };
        if (result.state === "ready") {
            this.lastDashboardQuota = result.quota;
            if (result.metrics) {
                this.lastDashboardMetrics = result.metrics;
                this.lastMetricsError = undefined;
                return { source: "dashboard", quota: result.quota, metrics: result.metrics, stale: false, metricsStale: false };
            }
            this.lastMetricsError = result.metricsError;
            return this.lastDashboardMetrics
                ? { source: "dashboard", quota: result.quota, metrics: this.lastDashboardMetrics, stale: false, metricsStale: true, metricsError: result.metricsError }
                : { source: "dashboard", quota: result.quota, stale: false, metricsStale: false, metricsError: result.metricsError };
        }
        // Authentication/cache reset must never show the preceding account's snapshots.
        if (result.state === "needs-import" || result.state === "eviction-failed") {
            this.lastDashboardQuota = undefined;
            this.lastDashboardMetrics = undefined;
            this.lastMetricsError = undefined;
        }
        return result.state === "transient" && this.lastDashboardQuota
            ? { source: "dashboard", quota: this.lastDashboardQuota, metrics: this.lastDashboardMetrics, stale: true, metricsStale: this.lastDashboardMetrics !== undefined, error: "transient", metricsError: this.lastMetricsError }
            : { source: "dashboard", stale: false, error: result.state };
    }
    notify(usage) {
        for (const listener of this.listeners)
            listener(usage);
    }
    cachedDashboardUsage() {
        if (this.importInFlight)
            return { source: "dashboard", stale: false, error: "import-busy" };
        if (this.dashboardCacheInvalidated)
            return { source: "dashboard", stale: false, error: "needs-import" };
        return this.lastDashboardQuota
            ? { source: "dashboard", quota: this.lastDashboardQuota, metrics: this.lastDashboardMetrics, stale: false, metricsStale: this.lastDashboardMetrics !== undefined && this.lastMetricsError !== undefined, metricsError: this.lastMetricsError }
            : { source: "dashboard", stale: false, error: "needs-import" };
    }
    async importCandidates() {
        let candidates;
        try {
            candidates = await this.importer.importCandidates();
        }
        catch (error) {
            return { state: error instanceof NanChromeImportError ? "import-unavailable" : "import-unavailable" };
        }
        for (const candidate of candidates) {
            let result;
            try {
                result = await this.sessions.validateAndStore(candidate.cookies);
            }
            catch {
                return { state: "transient" };
            }
            if (result.state === "ready") {
                this.lastDashboardQuota = result.quota;
                this.dashboardCacheInvalidated = false;
                return result;
            }
            // A rejected/invalid isolated candidate can try the next profile/store. The
            // remaining typed errors are not candidate-specific and must not be retried.
            if (result.state !== "needs-import")
                return result;
        }
        return { state: "needs-import" };
    }
}
const defaultWatchScheduler = {
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (timer) => clearInterval(timer),
};

const IMPORT_CHROME_SESSION_KIND = "nan.importChromeSession.v1";
let NanDemoUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.nan-demo" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = RefreshingAction;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        selectionGenerations = new Map();
        desiredSettings = new Map();
        settingsWrites = new NanSettingsWriteQueue();
        legacySourceMigrated = new Set();
        dashboard;
        constructor(dashboard = new NanDashboardController()) {
            super();
            this.dashboard = dashboard;
        }
        async onWillAppear(ev) {
            if (!ev.action.isDial())
                return;
            const action = ev.action;
            this.recordSelection(action.id, ev.payload.settings);
            await this.activateOnAppearance(action, ev.payload.settings, async () => {
                await this.migrateLegacySource(action, ev.payload.settings, this.lifecycleGuard(action));
            });
        }
        async onTouchTap(ev) {
            if (!ev.action.isDial())
                return;
            await this.refresh(ev.action);
        }
        async onDidReceiveSettings(ev) {
            if (!ev.action.isDial())
                return;
            this.configureRefresh(ev.action, ev.payload.settings);
            const isCurrent = this.lifecycleGuard(ev.action);
            if (!isCurrent())
                return;
            this.recordSelection(ev.action.id, ev.payload.settings);
            const settings = await this.migrateLegacySource(ev.action, ev.payload.settings, isCurrent);
            if (!isCurrent())
                return;
            await this.render(ev.action, this.dashboard.getCachedUsage(settings), settings);
        }
        async onDialRotate(ev) {
            if (!ev.action.isDial())
                return;
            const isCurrent = this.lifecycleGuard(ev.action);
            const isSameAppearance = this.appearanceGuard(ev.action);
            if (!isCurrent())
                return;
            const currentSettings = this.desiredSettings.get(ev.action.id) ?? ev.payload.settings;
            const settings = this.rotateSettings(currentSettings, this.dashboard.getCachedUsage(currentSettings), ev.payload.ticks);
            if (settings === currentSettings) {
                if (isCurrent())
                    await this.render(ev.action, this.dashboard.getCachedUsage(currentSettings), currentSettings);
                return;
            }
            const selectionGeneration = this.recordSelection(ev.action.id, settings);
            const persisted = await persistLatestNanSettings(selectionGeneration, settings, () => this.latestSelection(ev.action.id, settings), (latest) => this.writeSettings(ev.action, latest), isCurrent, isSameAppearance);
            if (isCurrent() && this.selectionGeneration(ev.action.id) === selectionGeneration) {
                await this.render(ev.action, this.dashboard.getCachedUsage(persisted), persisted);
            }
        }
        async onSendToPlugin(ev) {
            if (!ev.action.isDial() || !this.hasActiveLifecycle(ev.action) || !isImportChromeSessionMessage(ev.payload))
                return;
            const action = ev.action;
            const isCurrent = this.lifecycleGuard(action);
            const isSameAppearance = this.appearanceGuard(action);
            if (!isCurrent())
                return;
            await action.setFeedback(renderNanImportProgress());
            const result = await this.dashboard.importChromeSession();
            if (!isCurrent() || !isSameAppearance())
                return;
            const settings = this.desiredSettings.get(action.id) ?? {};
            await this.render(action, result.state === "ready"
                ? { source: "dashboard", quota: result.quota, stale: false }
                : { source: "dashboard", stale: false, error: result.state }, settings);
        }
        onWillDisappear(ev) {
            super.onWillDisappear(ev);
            this.selectionGenerations.delete(ev.action.id);
            this.desiredSettings.delete(ev.action.id);
            this.legacySourceMigrated.delete(ev.action.id);
        }
        async updateDisplay(action, isCurrent, force) {
            // Aggregate keypad keys own the shared poll. A dial timer redraws its cached snapshot
            // while that lease is active; touch/manual refreshes remain fresh reads.
            const state = await this.dashboard.getUsage(this.desiredSettings.get(action.id) ?? {}, { cacheWhileWatched: !force });
            if (!isCurrent())
                return;
            const readSettings = await action.getSettings();
            if (!isCurrent())
                return;
            const settings = await this.migrateLegacySource(action, readSettings, isCurrent);
            if (!isCurrent())
                return;
            this.rememberSelection(action.id, this.selectionGeneration(action.id), settings);
            await this.render(action, state, settings);
        }
        rotateSettings(settings, state, ticks) {
            const models = state.quota?.models.map(({ model }) => model) ?? [];
            if (models.length === 0)
                return settings;
            const current = resolveNanLiveModel(models, models, settings.model);
            return { ...settings, model: cycleNanLiveModel(models, current, ticks) };
        }
        async migrateLegacySource(action, settings, isCurrent) {
            if (settings.source !== "legacy")
                return settings;
            const migrated = { ...settings, source: "dashboard" };
            if (this.legacySourceMigrated.has(action.id)) {
                this.recordSelection(action.id, migrated);
                return migrated;
            }
            this.legacySourceMigrated.add(action.id);
            const generation = this.recordSelection(action.id, migrated);
            return persistLatestNanSettings(generation, migrated, () => this.latestDashboardSelection(action.id, migrated), (latest) => this.writeSettings(action, latest), isCurrent, this.appearanceGuard(action));
        }
        latestDashboardSelection(contextId, fallback) {
            const latest = this.latestSelection(contextId, fallback);
            if (latest.settings.source !== "legacy")
                return latest;
            const migrated = { ...latest.settings, source: "dashboard" };
            this.desiredSettings.set(contextId, migrated);
            return { generation: latest.generation, settings: migrated };
        }
        async render(action, state, settings) {
            await action.setFeedback(renderNanDashboardFeedback(state, settings));
        }
        selectionGeneration(contextId) { return this.selectionGenerations.get(contextId) ?? 0; }
        recordSelection(contextId, settings) {
            const generation = this.selectionGeneration(contextId) + 1;
            this.selectionGenerations.set(contextId, generation);
            this.desiredSettings.set(contextId, settings);
            return generation;
        }
        rememberSelection(contextId, generation, settings) {
            if (this.selectionGeneration(contextId) === generation)
                this.desiredSettings.set(contextId, settings);
        }
        latestSelection(contextId, fallback) {
            return { generation: this.selectionGeneration(contextId), settings: this.desiredSettings.get(contextId) ?? fallback };
        }
        writeSettings(action, settings) {
            return this.settingsWrites.write(action.id, settings, (latest) => action.setSettings(latest), this.appearanceGuard(action));
        }
    });
    return _classThis;
})();
function isImportChromeSessionMessage(payload) {
    return typeof payload === "object" && payload !== null
        && Object.keys(payload).length === 1
        && payload.kind === IMPORT_CHROME_SESSION_KIND;
}

const COLORS$1 = { bg: "#06080f", fg: "#f3f6f9", blue: "#7fb4ca", gold: "#dfbd76", green: "#b7cc85", rose: "#cb7c94" };
/** Renders a full 72px key canvas; Stream Deck scales the SVG for high-density devices. */
function renderNanModelUsageImage(state, settings) {
    return `data:image/svg+xml,${encodeURIComponent(renderNanModelUsageSvg(state, settings))}`;
}
function renderNanModelUsageSvg(state, settings) {
    const selected = validModel(settings.model) ? settings.model : undefined;
    const quotaModel = selected && state.quota
        ? state.quota.models.find((entry) => entry.model === selected) ?? state.quota.uncappedModels.find((entry) => entry.model === selected)
        : undefined;
    const monthlyModel = selected ? state.metrics?.monthToDate.byModel.find((entry) => entry.model === selected) : undefined;
    const display = !selected
        ? pendingSelection()
        : quotaModel
            ? isCapped(quotaModel)
                ? capped(quotaModel, state.stale)
                : uncapped(quotaModel, state.stale)
            : monthlyModel
                ? monthly(monthlyModel, state.metricsStale === true || state.stale)
                : !state.quota && !state.metrics
                    ? unavailable(state.error)
                    : { label: labelLines(selected), primary: "--", secondary: "NOT RETURNED", tertiary: "", status: "NO DATA", accent: COLORS$1.gold, gauge: 0 };
    const labels = display.label.map((line, index) => text$1(line, 6, display.label.length === 1 ? 16 : 11 + index * 8, COLORS$1.fg, 8)).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="NaN model usage">
<rect width="72" height="72" rx="6" fill="${COLORS$1.bg}"/><rect x="6" y="4" width="60" height="1" fill="${COLORS$1.blue}"/>
${labels}${text$1(display.primary, 6, 38, display.accent, 16)}${text$1(display.secondary, 6, 48, COLORS$1.fg, 7)}${text$1(display.tertiary, 6, 56, COLORS$1.fg, 7)}
<rect x="6" y="60" width="60" height="3" rx="1.5" fill="#202633"/><rect x="6" y="60" width="${display.gauge.toFixed(2)}" height="3" rx="1.5" fill="${display.accent}"/>
${text$1(display.status || "LIVE", 6, 70, display.status ? COLORS$1.rose : COLORS$1.green, 7)}</svg>`;
}
function pendingSelection() {
    return { label: ["CHOOSE MODEL"], primary: "--", secondary: "USE INSPECTOR", tertiary: "", status: "", accent: COLORS$1.blue, gauge: 0 };
}
function capped(model, stale) {
    return {
        label: labelLines(model.model),
        primary: `${formatPercentage(model.percentage)}%`,
        secondary: `USED ${compact$1(model.tokensUsed)}`,
        tertiary: `CAP ${compact$1(model.cap)} · ${period(model)}`,
        status: stale ? "STALE" : "",
        accent: stale ? COLORS$1.gold : COLORS$1.green,
        // The API can be over cap; clamp only this visual gauge, never displayed data.
        gauge: 60 * Math.min(100, Math.max(0, model.percentage)) / 100,
    };
}
function isCapped(value) {
    return typeof value === "object" && value !== null && "cap" in value && "percentage" in value;
}
function uncapped(model, stale) {
    return {
        label: labelLines(model.model),
        primary: compact$1(model.tokensUsed),
        secondary: "UNCAPPED",
        tertiary: period(model),
        status: stale ? "STALE" : "",
        accent: stale ? COLORS$1.gold : COLORS$1.green,
        gauge: 0,
    };
}
function monthly(model, stale) {
    return {
        label: labelLines(model.model),
        primary: compact$1(model.totalTokens),
        secondary: "MONTH TOKENS",
        tertiary: `MTD · IN ${compact$1(model.inputTokens)} OUT ${compact$1(model.outputTokens)}`,
        status: stale ? "STALE" : "",
        accent: stale ? COLORS$1.gold : COLORS$1.green,
        gauge: 0,
    };
}
function unavailable(error) {
    const status = error === "needs-import" || error === "import-busy" ? "IMPORT" : error === "transient" ? "ERROR" : "NO DATA";
    const secondary = status === "IMPORT" ? "USE NaN DIAL" : "DASHBOARD OFFLINE";
    return { label: ["NaN DASHBOARD"], primary: "--", secondary, tertiary: "", status, accent: status === "ERROR" ? COLORS$1.rose : COLORS$1.gold, gauge: 0 };
}
function period(model) {
    const details = [];
    if (model.resetAt) {
        const date = new Date(model.resetAt);
        if (!Number.isNaN(date.valueOf()))
            details.push(`${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`);
    }
    if (model.windowHours)
        details.push(`${model.windowHours}H`);
    if (details.length === 1 && model.windowHours && !model.resetAt)
        return `${details[0]} WINDOW`;
    return details.length > 0 ? details.join(" · ") : "QUOTA";
}
function labelLines(value) {
    if (value.length <= 12)
        return [value];
    const candidate = value.slice(0, 12);
    const breakAt = Math.max(candidate.lastIndexOf("-"), candidate.lastIndexOf("_"), candidate.lastIndexOf(" "));
    const firstEnd = breakAt >= 4 ? breakAt + 1 : 12;
    const first = value.slice(0, firstEnd);
    const rest = value.slice(firstEnd);
    return [first, rest.length > 12 ? `${rest.slice(0, 11)}…` : rest];
}
function text$1(value, x, y, fill, size) {
    return value ? `<text x="${x}" y="${y}" fill="${fill}" font-family="Arial,sans-serif" font-size="${size}" font-weight="700">${escapeXml$1(value)}</text>` : "";
}
const UTC_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function compact$1(value) { return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatPercentage(value) { return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, ""); }
function validModel(value) { return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value); }
function escapeXml$1(value) { return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]); }

const GET_MODELS = "nan.modelUsage.getModels.v1";
const REFRESH_MODELS = "nan.modelUsage.refreshModels.v1";
const MODELS = "nan.modelUsage.models.v1";
/** Keypad-only live NaN dashboard quota view. Each key holds an exact returned model ID. */
let NanModelUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.nan-model-usage" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = SingletonAction;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        dashboard;
        visible = new Map();
        nextEpoch = 0;
        constructor(dashboard) {
            super();
            this.dashboard = dashboard;
            // One controller subscription redraws every currently visible key after a shared read.
            this.dashboard.subscribe((usage) => { void this.redrawVisible(usage); });
        }
        async onWillAppear(ev) {
            if (!ev.action.isKey())
                return;
            const entry = { action: ev.action, settings: ev.payload.settings, epoch: ++this.nextEpoch };
            this.visible.set(ev.action.id, entry);
            const usage = await this.dashboard.getUsage({ source: "dashboard" });
            await this.render(entry, usage);
        }
        async onDidReceiveSettings(ev) {
            if (!ev.action.isKey())
                return;
            const existing = this.visible.get(ev.action.id);
            if (!existing || existing.action !== ev.action)
                return;
            existing.settings = ev.payload.settings;
            await this.render(existing, this.dashboard.getCachedUsage({ source: "dashboard" }));
        }
        async onKeyDown(ev) {
            if (!this.isCurrent(ev.action))
                return;
            await this.dashboard.getUsage({ source: "dashboard" });
        }
        async onSendToPlugin(ev) {
            if (!ev.action.isKey() || !this.isCurrent(ev.action))
                return;
            if (isModelsRequest(ev.payload)) {
                const usage = await this.dashboard.getUsage({ source: "dashboard" });
                if (this.isCurrent(ev.action))
                    await this.sendModels(ev.action, usage);
                return;
            }
            if (isRefreshModelsRequest(ev.payload)) {
                const usage = await this.dashboard.getUsage({ source: "dashboard" });
                if (this.isCurrent(ev.action))
                    await this.sendModels(ev.action, usage);
            }
        }
        onWillDisappear(ev) {
            const existing = this.visible.get(ev.action.id);
            if (existing?.action === ev.action)
                this.visible.delete(ev.action.id);
        }
        isCurrent(action) {
            return this.visible.get(action.id)?.action === action;
        }
        async redrawVisible(usage) {
            await Promise.all([...this.visible.values()].map((entry) => this.render(entry, usage)));
        }
        async render(entry, usage) {
            if (this.visible.get(entry.action.id) !== entry)
                return;
            const image = renderNanModelUsageImage(usage, entry.settings);
            if (this.visible.get(entry.action.id) !== entry)
                return;
            await entry.action.setImage(image);
        }
        sendModels(action, usage) {
            // The SDK routes this only to its current property-inspector context; do not send a
            // response if the inspector changed while an asynchronous shared refresh completed.
            if (streamDeck.ui.action?.id !== action.id)
                return Promise.resolve();
            const models = [
                ...(usage.quota?.models.map(({ model }) => ({ id: model, kind: "capped" })) ?? []),
                ...(usage.quota?.uncappedModels.map(({ model }) => ({ id: model, kind: "uncapped" })) ?? []),
                ...(usage.metrics?.monthToDate.byModel
                    .filter(({ model }) => !usage.quota?.models.some((quota) => quota.model === model) && !usage.quota?.uncappedModels.some((quota) => quota.model === model))
                    .map(({ model }) => ({ id: model, kind: "monthly" })) ?? []),
            ];
            return streamDeck.ui.sendToPropertyInspector({ kind: MODELS, models });
        }
    });
    return _classThis;
})();
function isModelsRequest(payload) {
    return isExactKind(payload, GET_MODELS);
}
function isRefreshModelsRequest(payload) {
    return isExactKind(payload, REFRESH_MODELS);
}
function isExactKind(payload, kind) {
    return typeof payload === "object" && payload !== null && Object.keys(payload).length === 1 && payload.kind === kind;
}

const COLORS = { bg: "#06080f", fg: "#f3f6f9", blue: "#7fb4ca", gold: "#dfbd76", green: "#b7cc85", rose: "#cb7c94" };
/** Renders server-authoritative aggregate tokens on the standard 72px keypad canvas. */
function renderNanMetricsUsageImage(state, period) {
    return `data:image/svg+xml,${encodeURIComponent(renderNanMetricsUsageSvg(state, period))}`;
}
function renderNanMetricsUsageSvg(state, period) {
    const display = metricsDisplay(state, period);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="NaN ${display.title.toLowerCase()}">
  <rect width="72" height="72" rx="6" fill="${COLORS.bg}"/><rect x="6" y="4" width="60" height="1" fill="${COLORS.blue}"/>
  ${text("NaN", 6, 16, COLORS.fg, 9)}${text(display.title, 6, 26, COLORS.fg, 8)}
  ${text(display.value, 6, 45, display.accent, 18)}${text(display.unit, 6, 56, COLORS.fg, 7)}
  <rect x="6" y="61" width="60" height="2" rx="1" fill="#202633"/>${text(display.status || "LIVE", 6, 70, display.status ? COLORS.rose : COLORS.green, 7)}</svg>`;
}
function metricsDisplay(state, period) {
    const title = period === "allTime" ? "TOTAL TOKENS" : "MONTHLY TOKENS";
    const unit = period === "allTime" ? "ALL TIME · TOKENS" : "MONTH TO DATE · TOKENS";
    const window = state.metrics?.[period];
    if (!window) {
        const status = state.metricsError ? "METRICS ERROR" : "NO DATA";
        return { title, value: "--", unit: "DASHBOARD METRICS", status, accent: status === "METRICS ERROR" ? COLORS.rose : COLORS.gold };
    }
    const stale = state.stale || state.metricsStale === true;
    return { title, value: compact(window.totalTokens), unit, status: stale ? "STALE" : "", accent: stale ? COLORS.gold : COLORS.blue };
}
function compact(value) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function text(value, x, y, fill, size) {
    return `<text x="${x}" y="${y}" fill="${fill}" font-family="Arial,sans-serif" font-size="${size}" font-weight="700">${escapeXml(value)}</text>`;
}
function escapeXml(value) {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
}

/** Shared keypad lifecycle for server aggregate metrics; it never creates a per-key timer. */
class NanMetricsUsage extends SingletonAction {
    visible = new Map();
    dashboard;
    period;
    constructor(dashboard, period) {
        super();
        this.period = period;
        this.dashboard = dashboard;
        this.dashboard.subscribe((usage) => { void this.redrawVisible(usage); });
    }
    async onWillAppear(ev) {
        if (!ev.action.isKey())
            return;
        const existing = this.visible.get(ev.action.id);
        existing?.disposeWatch();
        const entry = { action: ev.action, disposeWatch: this.dashboard.watchDashboard() };
        this.visible.set(ev.action.id, entry);
        await this.render(entry, this.dashboard.getCachedUsage({ source: "dashboard" }));
    }
    async onDidReceiveSettings(ev) {
        if (ev.action.isKey() && this.isCurrent(ev.action))
            await this.render(this.visible.get(ev.action.id), this.dashboard.getCachedUsage({ source: "dashboard" }));
    }
    async onKeyDown(ev) {
        if (!ev.action.isKey() || !this.isCurrent(ev.action))
            return;
        // A keypress remains an explicit fresh read even while the shared visibility watch is active.
        await this.dashboard.getUsage({ source: "dashboard" });
    }
    onWillDisappear(ev) {
        const entry = this.visible.get(ev.action.id);
        if (!entry || entry.action !== ev.action)
            return;
        this.visible.delete(ev.action.id);
        entry.disposeWatch();
    }
    isCurrent(action) {
        return this.visible.get(action.id)?.action === action;
    }
    async redrawVisible(usage) {
        await Promise.all([...this.visible.values()].map((entry) => this.render(entry, usage)));
    }
    async render(entry, usage) {
        if (this.visible.get(entry.action.id) !== entry)
            return;
        await entry.action.setImage(renderNanMetricsUsageImage(usage, this.period));
    }
}
let NanTotalTokensUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.nan-total-tokens" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = NanMetricsUsage;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        constructor(dashboard) { super(dashboard, "allTime"); }
    });
    return _classThis;
})();
let NanMonthlyTokensUsage = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.nan-monthly-tokens" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = NanMetricsUsage;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        constructor(dashboard) { super(dashboard, "monthToDate"); }
    });
    return _classThis;
})();

const DASHBOARD_URL = "https://cloud.nan.builders/dashboard";
const OPEN_FAILED_WARNING = "NaN Dashboard could not be opened.";
/** Keypad-only launcher for the NaN Dashboard; it owns no settings or dashboard lifecycle. */
let NanDashboardLauncher = (() => {
    let _classDecorators = [action({ UUID: "com.refactor-ia.nan.nan-dashboard" })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = SingletonAction;
    (class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        async onKeyDown(ev) {
            if (!ev.action.isKey())
                return;
            try {
                await streamDeck.system.openUrl(DASHBOARD_URL);
            }
            catch {
                streamDeck.logger.warn(OPEN_FAILED_WARNING);
            }
        }
    });
    return _classThis;
})();

function installPluginShutdown(target, runtime = process, timeoutMs = 5_000) {
    const targets = Array.isArray(target) ? target : [target];
    let cleanupPromise;
    let terminalSignal;
    const stopImmediately = () => {
        for (const entry of targets) {
            try {
                entry.stopImmediately();
            }
            catch { /* Sigue limpiando los demas recursos. */ }
        }
    };
    const cleanup = () => {
        if (!cleanupPromise) {
            const graceful = Promise.all(targets.map((entry) => Promise.resolve().then(() => entry.stop())))
                .then(() => undefined);
            cleanupPromise = withTimeout(graceful, timeoutMs).catch((error) => {
                stopImmediately();
                throw error;
            });
        }
        return cleanupPromise;
    };
    const signalHandlers = {
        SIGINT: () => stopForSignal("SIGINT"),
        SIGTERM: () => stopForSignal("SIGTERM"),
    };
    const stopForSignal = (signal) => {
        if (terminalSignal)
            return;
        terminalSignal = signal;
        void cleanup().catch(() => undefined).finally(() => {
            runtime.off("SIGINT", signalHandlers.SIGINT);
            runtime.off("SIGTERM", signalHandlers.SIGTERM);
            runtime.exit(signal === "SIGINT" ? 130 : 143);
        });
    };
    runtime.once("beforeExit", () => void cleanup().catch(() => undefined));
    runtime.once("exit", stopImmediately);
    runtime.once("SIGINT", signalHandlers.SIGINT);
    runtime.once("SIGTERM", signalHandlers.SIGTERM);
    return cleanup;
}
function withTimeout(operation, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Plugin shutdown timed out")), Math.max(1, timeoutMs));
        void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
}

const allowedProviderIds = new Set(["claude", "codex", "grok", "nan"]);
const allowedStates = new Set([
    "authentication", "executable-not-found", "timeout", "invalid-response", "unavailable", "stopped",
    "missing-configuration", "invalid-configuration", "unavailable-credentials", "unavailable-fetch",
]);
class TransitioningProviderStatusReporter {
    failures = new Map();
    write;
    constructor(write) {
        this.write = write;
    }
    failure(providerId, state) {
        const safeProviderId = allowedProviderIds.has(providerId) ? providerId : "unknown";
        const safeState = allowedStates.has(state) ? state : "unavailable";
        if (this.failures.get(safeProviderId) === safeState)
            return;
        this.failures.set(safeProviderId, safeState);
        try {
            this.write(`provider=${safeProviderId} state=${safeState}`);
        }
        catch { /* Observability never changes provider behavior. */ }
    }
    success(providerId) {
        this.failures.delete(allowedProviderIds.has(providerId) ? providerId : "unknown");
    }
}

const statusReporter = new TransitioningProviderStatusReporter((message) => streamDeck.logger.warn(message));
const claudeProvider = new ClaudeUsageProvider();
const claudeCoordinator = new UsageProviderCoordinator(claudeProvider, { ...CLAUDE_COORDINATOR_OPTIONS, statusReporter });
const codexProvider = new CodexUsageProvider();
const codexCoordinator = new UsageProviderCoordinator(codexProvider, { statusReporter });
const grokProvider = new GrokUsageProvider();
const grokCoordinator = new UsageProviderCoordinator(grokProvider, { statusReporter });
const claudeAction = new ClaudeUsage(claudeCoordinator);
const codexAction = new CodexUsage(codexCoordinator);
const grokAction = new GrokUsage(grokCoordinator);
const nanDashboard = new NanDashboardController();
const nanAction = new NanDemoUsage(nanDashboard);
const nanModelAction = new NanModelUsage(nanDashboard);
const nanTotalTokensAction = new NanTotalTokensUsage(nanDashboard);
const nanMonthlyTokensAction = new NanMonthlyTokensUsage(nanDashboard);
const nanDashboardLauncher = new NanDashboardLauncher();
streamDeck.actions.registerAction(claudeAction);
streamDeck.actions.registerAction(codexAction);
streamDeck.actions.registerAction(grokAction);
streamDeck.actions.registerAction(nanAction);
streamDeck.actions.registerAction(nanModelAction);
streamDeck.actions.registerAction(nanTotalTokensAction);
streamDeck.actions.registerAction(nanMonthlyTokensAction);
streamDeck.actions.registerAction(nanDashboardLauncher);
streamDeck.system.onSystemDidWakeUp(() => {
    claudeCoordinator.recoverAfterWake();
    codexCoordinator.recoverAfterWake();
    grokCoordinator.recoverAfterWake();
    void Promise.all([
        claudeAction.resumeAfterSystemWake(),
        codexAction.resumeAfterSystemWake(),
        grokAction.resumeAfterSystemWake(),
        nanAction.resumeAfterSystemWake(),
    ]);
});
installPluginShutdown([claudeProvider, codexProvider, grokProvider]);
streamDeck.connect();
