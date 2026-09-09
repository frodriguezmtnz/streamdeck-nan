import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BrowserCookieRecord } from "./nan-dashboard-session-store.js";
import { NanKeychainClient } from "./nan-keychain-client.js";

const MAX_PROFILES = 8;
const MAX_ROWS = 32;
const MAX_BLOB_BYTES = 8 * 1024;
const MAX_STRING_BYTES = 4 * 1024;
const CHROME_EPOCH_MS = 11_644_473_600_000;

type StoreName = "Network" | "Cookies";
type Profile = { readonly name: string; readonly path: string };
type StoreRows = { readonly profile: Profile; readonly store: StoreName; readonly rows: readonly Row[] };

export interface NanChromeCookieCandidate {
  readonly profileId: string;
  /** Distinguishes a Network store from a legacy primary Cookies store without merging credentials. */
  readonly store: StoreName;
  readonly cookies: readonly BrowserCookieRecord[];
}

interface Dependencies {
  readonly homes?: readonly string[];
  readonly getChromeSafeStorage?: () => Promise<string | null>;
  readonly now?: () => Date;
}

/** Explicit-call-only Chrome importer. It never runs during construction or module loading. */
export class NanChromeCookieImporter {
  private readonly homes: readonly string[];
  private readonly getChromeSafeStorage: () => Promise<string | null>;
  private readonly now: () => Date;

  constructor(dependencies: Dependencies = {}) {
    this.homes = dependencies.homes ?? [homedir()];
    this.getChromeSafeStorage = dependencies.getChromeSafeStorage ?? (() => new NanKeychainClient().getChromeSafeStorage());
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Returns separate candidates per profile and cookie store; callers must validate one candidate without merging them. */
  async importCandidates(): Promise<readonly NanChromeCookieCandidate[]> {
    const stores: StoreRows[] = [];
    for (const home of this.homes) {
      const root = await chromeRoot(home);
      if (!root) continue;
      for (const profile of await profileDirectories(root)) {
        for (const store of await readRelevantStores(profile)) {
          if (store.rows.length > 0 && !stores.some((existing) => identicalStore(existing, store))) stores.push(store);
        }
      }
    }
    const needsKey = stores.some(({ rows }) => rows.some((row) => !row.value));
    let password: string | null = null;
    if (needsKey) {
      try {
        password = await this.getChromeSafeStorage();
      } catch {
        throw new NanChromeImportError("permission-or-keychain");
      }
      if (!password) throw new NanChromeImportError("permission-or-keychain");
    }
    const candidates: NanChromeCookieCandidate[] = [];
    for (const { profile, store, rows } of stores) {
      const cookies = decryptRows(rows, password, this.now());
      if (cookies.length > 0) candidates.push({ profileId: profile.name, store, cookies });
    }
    return candidates;
  }
}

export class NanChromeImportError extends Error {
  readonly kind: "not-found" | "permission-or-keychain" | "unsupported-format" | "unavailable";

  constructor(kind: "not-found" | "permission-or-keychain" | "unsupported-format" | "unavailable") {
    super(kind === "unsupported-format" ? "Chrome cookie format unsupported" : "Chrome cookies unavailable");
    this.kind = kind;
  }
}

type Row = {
  readonly host: string;
  readonly name: string;
  readonly path: string;
  readonly expires: bigint;
  readonly secure: number;
  readonly value: string;
  readonly encrypted: Uint8Array;
  readonly version: number;
};

async function chromeRoot(home: string): Promise<string | null> {
  const suppliedHome = resolve(home);
  const homeStat = await lstatOrAbsent(suppliedHome);
  if (!homeStat) return null;
  if (!homeStat.isDirectory()) throw new NanChromeImportError("unavailable");
  let canonicalHome: string;
  try {
    canonicalHome = await realpath(suppliedHome);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new NanChromeImportError("unavailable");
  }
  return directoryUnder(canonicalHome, ["Library", "Application Support", "Google", "Chrome"]);
}

async function profileDirectories(root: string): Promise<readonly Profile[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new NanChromeImportError("unavailable");
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && allowedProfileName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (names.length > MAX_PROFILES) throw new NanChromeImportError("unavailable");
  const profiles: Profile[] = [];
  for (const name of names) {
    const path = await directoryUnder(root, [name]);
    if (path) profiles.push({ name, path });
  }
  return profiles;
}

function allowedProfileName(name: string): boolean {
  return name === "Default" || name.startsWith("Profile ") || name.startsWith("user-");
}

async function readRelevantStores(profile: Profile): Promise<readonly StoreRows[]> {
  const stores: StoreRows[] = [];
  for (const store of ["Network", "Cookies"] as const) {
    const path = store === "Network"
      ? await fileUnder(profile.path, ["Network", "Cookies"])
      : await fileUnder(profile.path, ["Cookies"]);
    if (!path) continue;
    const rows = await readRelevantRows(path);
    if (rows.length > 0) stores.push({ profile, store, rows });
  }
  return stores;
}

async function directoryUnder(parent: string, parts: readonly string[]): Promise<string | null> {
  let path = parent;
  for (const part of parts) {
    path = join(path, part);
    const stat = await lstatOrAbsent(path);
    if (!stat) return null;
    if (stat.isSymbolicLink()) return null;
    if (!stat.isDirectory()) throw new NanChromeImportError("unavailable");
  }
  return canonicalPath(parent, path);
}

async function fileUnder(parent: string, parts: readonly string[]): Promise<string | null> {
  const directories = parts.slice(0, -1);
  const filename = parts.at(-1);
  if (!filename) return null;
  const directory = await directoryUnder(parent, directories);
  if (!directory) return null;
  const path = join(directory, filename);
  const stat = await lstatOrAbsent(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return null;
  if (!stat.isFile()) throw new NanChromeImportError("unavailable");
  return canonicalPath(parent, path);
}

async function lstatOrAbsent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new NanChromeImportError("unavailable");
  }
}

async function canonicalPath(parent: string, path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    return inside(parent, canonical) ? canonical : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new NanChromeImportError("unavailable");
  }
}

async function readRelevantRows(path: string): Promise<readonly Row[]> {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw new NanChromeImportError("unavailable");
  }
  try {
    const versionRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("version") as { value?: unknown } | undefined;
    const version = parseVersion(versionRow?.value);
    if (version === undefined) throw new NanChromeImportError("unsupported-format");
    const statement = db.prepare("SELECT host_key, name, path, expires_utc, is_secure, value, encrypted_value FROM cookies WHERE host_key IN (?, ?, ?, ?) LIMIT ?");
    statement.setReadBigInts(true);
    const rows = statement.all("cloud-api.nan.builders", ".cloud-api.nan.builders", "nan.builders", ".nan.builders", MAX_ROWS + 1) as Array<Record<string, unknown>>;
    if (rows.length > MAX_ROWS) throw new NanChromeImportError("unavailable");
    return rows.map((row) => rowFrom(row, version));
  } catch (error) {
    if (error instanceof NanChromeImportError) throw error;
    throw new NanChromeImportError("unsupported-format");
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function rowFrom(row: Record<string, unknown>, version: number): Row {
  const expires = typeof row.expires_utc === "bigint" ? row.expires_utc
    : typeof row.expires_utc === "number" && Number.isSafeInteger(row.expires_utc) ? BigInt(row.expires_utc) : undefined;
  const secure = typeof row.is_secure === "bigint" ? Number(row.is_secure) : row.is_secure;
  if (typeof row.host_key !== "string" || typeof row.name !== "string" || typeof row.path !== "string" || typeof secure !== "number"
    || typeof row.value !== "string" || expires === undefined || !(row.encrypted_value instanceof Uint8Array)
    || !boundedString(row.host_key) || !boundedString(row.name) || !boundedString(row.path) || !boundedString(row.value)
    || row.encrypted_value.byteLength > MAX_BLOB_BYTES) throw new NanChromeImportError("unsupported-format");
  return { host: row.host_key, name: row.name, path: row.path, expires, secure, value: row.value, encrypted: row.encrypted_value, version };
}

function decryptRows(rows: readonly Row[], password: string | null, now: Date): BrowserCookieRecord[] {
  const encrypted = rows.some((row) => !row.value);
  if (encrypted && !password) return [];
  const key = encrypted ? pbkdf2Sync(Buffer.from(password!, "utf8"), "saltysalt", 1003, 16, "sha1") : null;
  try {
    return rows.flatMap((row) => cookieFrom(row, key, now));
  } finally {
    key?.fill(0);
  }
}

function cookieFrom(row: Row, key: Buffer | null, now: Date): BrowserCookieRecord[] {
  if (row.secure !== 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.name) || !row.path.startsWith("/")) return [];
  const value = row.value || key && decrypt(row, key);
  if (!value || !/^[!#$%&'()*+\-./0-9:<=>?@A-Z\[\]^_`a-z{|}~]*$/.test(value)) return [];
  const expiresAt = chromeExpiry(row.expires, now);
  if (expiresAt === "expired") return [];
  const hostOnly = !row.host.startsWith(".");
  const domain = row.host.replace(/^\./, "").toLowerCase();
  return [{ name: row.name, value, domain, hostOnly, path: row.path, secure: true, expiresAt }];
}

function decrypt(row: Row, key: Buffer): string | null {
  if (row.encrypted.byteLength < 4 || Buffer.from(row.encrypted.subarray(0, 3)).toString("ascii") !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(row.encrypted.subarray(3)), decipher.final()]);
    const value = row.version >= 24 ? stripHostHash(plain, row.host) : plain;
    return value ? new TextDecoder("utf-8", { fatal: true }).decode(value) : null;
  } catch {
    return null;
  }
}

function identicalStore(left: StoreRows, right: StoreRows): boolean {
  return left.profile.path === right.profile.path && left.rows.length === right.rows.length && left.rows.every((row, index) => identicalRow(row, right.rows[index]));
}

function identicalRow(left: Row, right: Row | undefined): boolean {
  return !!right && left.host === right.host && left.name === right.name && left.path === right.path
    && left.expires === right.expires && left.secure === right.secure && left.value === right.value
    && left.version === right.version && Buffer.from(left.encrypted).equals(Buffer.from(right.encrypted));
}

function parseVersion(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (typeof value === "bigint") value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stripHostHash(value: Buffer, host: string): Buffer | null {
  const digest = createHash("sha256").update(host).digest();
  return value.subarray(0, 32).equals(digest) ? value.subarray(32) : null;
}

function chromeExpiry(value: bigint, now: Date): string | null | "expired" {
  if (value === 0n) return null;
  const milliseconds = value / 1000n - BigInt(CHROME_EPOCH_MS);
  const maxDateMilliseconds = 8_640_000_000_000_000n;
  const nowMilliseconds = now.valueOf();
  if (!Number.isFinite(nowMilliseconds) || milliseconds < -maxDateMilliseconds || milliseconds > maxDateMilliseconds) return "expired";
  if (milliseconds <= BigInt(nowMilliseconds)) return "expired";
  return new Date(Number(milliseconds)).toISOString();
}

function boundedString(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES;
}

function inside(parent: string, child: string): boolean {
  const result = relative(resolve(parent), resolve(child));
  return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
