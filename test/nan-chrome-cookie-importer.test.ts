import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { NanChromeCookieImporter, NanChromeImportError } from "../src/providers/nan/nan-chrome-cookie-importer.ts";

const key = pbkdf2Sync("password", "saltysalt", 1003, 16, "sha1");
const epoch = 11_644_473_600_000;
const now = new Date("2025-01-01T00:00:00.000Z");

type Fixture = { home: string; db: DatabaseSync; path: string };

function encryptPlain(plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

function encrypted(host: string, value: string, version = 24): Buffer {
  const plain = version >= 24
    ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value, "utf8")])
    : Buffer.from(value, "utf8");
  return encryptPlain(plain);
}

function expiresAt(iso: string): bigint {
  return (BigInt(Date.parse(iso)) + BigInt(epoch)) * 1000n;
}

async function databaseAt(path: string, version = 24): Promise<Omit<Fixture, "home">> {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT, expires_utc INTEGER, is_secure INTEGER, value TEXT, encrypted_value BLOB);");
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("version", String(version));
  return { db, path };
}

async function fixture(version = 24, profile = "Default", store = "Network"): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "nan-chrome-"));
  return { home, ...(await storeFixture(home, version, profile, store)) };
}

async function storeFixture(home: string, version = 24, profile = "Default", store = "Network"): Promise<Omit<Fixture, "home">> {
  const base = join(home, "Library/Application Support/Google/Chrome", profile);
  return databaseAt(store === "Network" ? join(base, "Network", "Cookies") : join(base, "Cookies"), version);
}

function insert(db: DatabaseSync, values: {
  host?: string; name?: string; path?: string; expires?: bigint; secure?: number; value?: string; encryptedValue?: Buffer;
} = {}): void {
  const { host = ".nan.builders", name = "session", path = "/", expires = 0n, secure = 1, value = "", encryptedValue = Buffer.alloc(0) } = values;
  db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)").run(host, name, path, expires, secure, value, encryptedValue);
}

async function cleanup(f: Fixture): Promise<void> {
  try { f.db.close(); } catch {}
  await rm(f.home, { recursive: true, force: true });
  await assert.rejects(access(f.home));
}

function typed(kind: NanChromeImportError["kind"], forbidden?: string) {
  return (error: unknown): boolean => error instanceof NanChromeImportError && error.kind === kind && (!forbidden || !error.message.includes(forbidden));
}

function importer(home: string, getChromeSafeStorage: () => Promise<string | null>, fixedNow = now): NanChromeCookieImporter {
  return new NanChromeCookieImporter({ homes: [home], getChromeSafeStorage, now: () => fixedNow });
}

test("preserves pre-v24 values and fails closed for v24 crypto and Unicode header values", async () => {
  const f = await fixture();
  try {
    insert(f.db, { name: "matching", encryptedValue: encrypted(".nan.builders", "match") });
    insert(f.db, { name: "mismatch", host: "nan.builders", encryptedValue: encrypted(".nan.builders", "wrong") });
    insert(f.db, { name: "prefix", encryptedValue: Buffer.from("v11-unsupported") });
    const badPadding = encrypted(".nan.builders", "padding"); badPadding[badPadding.length - 1] ^= 0xff;
    insert(f.db, { name: "padding", encryptedValue: badPadding });
    insert(f.db, { name: "utf8", encryptedValue: encryptPlain(Buffer.concat([createHash("sha256").update(".nan.builders").digest(), Buffer.from([0xc3, 0x28])])) });
    insert(f.db, { name: "plainUnicode", value: "snowman-☃" });
    insert(f.db, { name: "encryptedUnicode", encryptedValue: encrypted(".nan.builders", "snowman-☃") });
    f.db.close();
    const candidates = await importer(f.home, async () => "password").importCandidates();
    assert.deepEqual(candidates.map(({ store, cookies }) => [store, cookies.map(({ name, value }) => [name, value])]), [["Network", [["matching", "match"]]]]);
  } finally { await cleanup(f); }

  const legacy = await fixture(23);
  try {
    const value = "a".repeat(48);
    insert(legacy.db, { encryptedValue: encrypted(".nan.builders", value, 23) });
    legacy.db.close();
    assert.equal((await importer(legacy.home, async () => "password").importCandidates())[0]?.cookies[0]?.value, value);
  } finally { await cleanup(legacy); }
});

test("uses BigInt expiry conversion with a deterministic clock and sanitizes invalid dates", async () => {
  const f = await fixture();
  const future = "2026-02-03T04:05:06.789Z";
  const futureValue = expiresAt(future);
  try {
    assert.ok(futureValue > BigInt(Number.MAX_SAFE_INTEGER));
    insert(f.db, { name: "session", value: "session" });
    insert(f.db, { name: "future", value: "future", expires: futureValue });
    insert(f.db, { name: "past", value: "past", expires: expiresAt("2024-12-31T23:59:59.999Z") });
    insert(f.db, { name: "range", value: "range", expires: 9_223_372_036_854_775_807n });
    f.db.close();
    const cookies = (await importer(f.home, async () => "password").importCandidates())[0]?.cookies;
    assert.deepEqual(cookies?.map(({ name, expiresAt: expiry }) => [name, expiry]), [["session", null], ["future", future]]);
  } finally { await cleanup(f); }
});

test("uses one lazy synthetic key lookup across profiles and never retries rejected lookup", async () => {
  const f = await fixture();
  let profileOne: Omit<Fixture, "home"> | undefined;
  try {
    insert(f.db, { name: "default", encryptedValue: encrypted(".nan.builders", "one") });
    f.db.close();
    profileOne = await storeFixture(f.home, 24, "Profile 1");
    insert(profileOne.db, { name: "profile", encryptedValue: encrypted(".nan.builders", "two") });
    profileOne.db.close();
    let lookups = 0;
    const candidates = await importer(f.home, async () => { lookups += 1; return "password"; }).importCandidates();
    assert.deepEqual(candidates.map(({ profileId, store }) => `${profileId}/${store}`), ["Default/Network", "Profile 1/Network"]);
    assert.equal(lookups, 1);
  } finally {
    if (profileOne) { try { profileOne.db.close(); } catch {} }
    await cleanup(f);
  }

  const rejected = await fixture();
  const secret = "fixture: intentional test error";
  try {
    insert(rejected.db, { encryptedValue: encrypted(".nan.builders", "token") });
    rejected.db.close();
    let lookups = 0;
    await assert.rejects(importer(rejected.home, async () => { lookups += 1; throw new Error(secret); }).importCandidates(), typed("permission-or-keychain", secret));
    assert.equal(lookups, 1);
  } finally { await cleanup(rejected); }
});

test("reads Network and primary stores independently, orders them, and only deduplicates exact rows", async () => {
  const f = await fixture();
  let primary: Omit<Fixture, "home"> | undefined;
  try {
    f.db.close();
    primary = await storeFixture(f.home, 24, "Default", "Cookies");
    insert(primary.db, { name: "primary", encryptedValue: encrypted(".nan.builders", "primary") });
    primary.db.close();
    let lookups = 0;
    const emptyNetwork = await importer(f.home, async () => { lookups += 1; return "password"; }).importCandidates();
    assert.deepEqual(emptyNetwork.map(({ profileId, store, cookies }) => [profileId, store, cookies[0]?.value]), [["Default", "Cookies", "primary"]]);
    assert.equal(lookups, 1);
  } finally {
    if (primary) { try { primary.db.close(); } catch {} }
    await cleanup(f);
  }

  const both = await fixture();
  let primaryBoth: Omit<Fixture, "home"> | undefined;
  try {
    insert(both.db, { name: "network", value: "network" });
    both.db.close();
    primaryBoth = await storeFixture(both.home, 24, "Default", "Cookies");
    insert(primaryBoth.db, { name: "primary", value: "primary" });
    primaryBoth.db.close();
    const candidates = await importer(both.home, async () => "password").importCandidates();
    assert.deepEqual(candidates.map(({ store, cookies }) => [store, cookies[0]?.value]), [["Network", "network"], ["Cookies", "primary"]]);
  } finally {
    if (primaryBoth) { try { primaryBoth.db.close(); } catch {} }
    await cleanup(both);
  }
});

test("rejects root, profile, Network, and database symlinks without a key lookup", { skip: process.platform === "win32" }, async () => {
  for (const location of ["root", "profile", "network", "database"] as const) {
    const f = await fixture();
    try {
      f.db.close();
      const root = join(f.home, "Library/Application Support/Google/Chrome");
      const profile = join(root, "Default");
      const network = join(profile, "Network");
      if (location === "root") {
        const target = join(f.home, "safe-root");
        await mkdir(target);
        await rm(root, { recursive: true, force: true });
        await symlink(target, root);
      } else if (location === "profile") {
        const target = await databaseAt(join(root, "safe-profile", "Network", "Cookies"));
        target.db.close();
        await rm(profile, { recursive: true, force: true });
        await symlink(dirname(dirname(target.path)), profile);
      } else if (location === "network") {
        const target = await databaseAt(join(profile, "safe-network", "Cookies"));
        target.db.close();
        await rm(network, { recursive: true, force: true });
        await symlink(dirname(target.path), network);
      } else {
        const target = await databaseAt(join(profile, "safe-cookies"));
        target.db.close();
        await rm(f.path, { force: true });
        await symlink(target.path, f.path);
      }
      let lookups = 0;
      assert.deepEqual(await importer(f.home, async () => { lookups += 1; return "password"; }).importCandidates(), [], location);
      assert.equal(lookups, 0, location);
    } finally { await cleanup(f); }
  }
});

test("bounds profiles, rows, strings, and blobs before key lookup", async () => {
  const homes = await mkdtemp(join(tmpdir(), "nan-chrome-profiles-"));
  try {
    for (let index = 1; index <= 9; index += 1) await mkdir(join(homes, "Library/Application Support/Google/Chrome", `Profile ${index}`), { recursive: true });
    let lookups = 0;
    await assert.rejects(importer(homes, async () => { lookups += 1; return "password"; }).importCandidates(), typed("unavailable"));
    assert.equal(lookups, 0);
  } finally { await rm(homes, { recursive: true, force: true }); await assert.rejects(access(homes)); }

  for (const values of [
    { rows: true },
    { name: "x".repeat(4_097), value: "plain" },
    { encryptedValue: Buffer.alloc(8 * 1024 + 1) },
  ]) {
    const f = await fixture();
    try {
      if ("rows" in values) for (let index = 0; index <= 32; index += 1) insert(f.db, { name: `cookie${index}`, value: "value" });
      else insert(f.db, values);
      f.db.close();
      let lookups = 0;
      await assert.rejects(importer(f.home, async () => { lookups += 1; return "password"; }).importCandidates(), typed("rows" in values ? "unavailable" : "unsupported-format"));
      assert.equal(lookups, 0);
    } finally { await cleanup(f); }
  }
});

test("returns typed sanitized errors for corrupt stores and invalid metadata", async () => {
  const corrupt = await fixture();
  try {
    corrupt.db.close();
    await writeFile(corrupt.path, "not SQLite");
    let lookups = 0;
    await assert.rejects(importer(corrupt.home, async () => { lookups += 1; return "password"; }).importCandidates(), typed("unsupported-format", corrupt.home));
    assert.equal(lookups, 0);
  } finally { await cleanup(corrupt); }

  const meta = await fixture();
  try {
    meta.db.prepare("UPDATE meta SET value = ?").run("invalid");
    meta.db.close();
    await assert.rejects(importer(meta.home, async () => "password").importCandidates(), typed("unsupported-format", meta.home));
  } finally { await cleanup(meta); }
});

test("keeps read-only synthetic database bytes unchanged and skips absent or plaintext-only key access", async () => {
  const f = await fixture();
  try {
    insert(f.db, { name: "plain", value: "snapshot" });
    insert(f.db, { host: "evil.example", name: "irrelevant", encryptedValue: encrypted("evil.example", "secret") });
    f.db.close();
    const before = await readFile(f.path);
    let lookups = 0;
    const candidates = await importer(f.home, async () => { lookups += 1; return "password"; }).importCandidates();
    assert.deepEqual(await readFile(f.path), before);
    assert.deepEqual(candidates.map(({ store }) => store), ["Network"]);
    assert.equal(lookups, 0);
  } finally { await cleanup(f); }

  const absent = await mkdtemp(join(tmpdir(), "nan-chrome-absent-"));
  try {
    let lookups = 0;
    assert.deepEqual(await importer(absent, async () => { lookups += 1; return "password"; }).importCandidates(), []);
    assert.equal(lookups, 0);
  } finally { await rm(absent, { recursive: true, force: true }); await assert.rejects(access(absent)); }
});

test("deduplicates only byte-identical Network and primary rows", async () => {
  const f = await fixture();
  let primary: Omit<Fixture, "home"> | undefined;
  try {
    insert(f.db, { name: "same", value: "value" });
    f.db.close();
    primary = await storeFixture(f.home, 24, "Default", "Cookies");
    insert(primary.db, { name: "same", value: "value" });
    primary.db.close();
    const candidates = await importer(f.home, async () => "password").importCandidates();
    assert.deepEqual(candidates.map(({ profileId, store }) => [profileId, store]), [["Default", "Network"]]);
  } finally {
    if (primary) { try { primary.db.close(); } catch {} }
    await cleanup(f);
  }
});
