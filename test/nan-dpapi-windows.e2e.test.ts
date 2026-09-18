import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dpapiEnvironment, NanDpapiClient } from "../src/providers/nan/nan-dpapi-client.ts";

test("DPAPI helper round-trips and deletes a session secret on Windows", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nan-dpapi-e2e-"));
  try {
    const client = new NanDpapiClient(undefined, resolve("native/nan-dpapi/nan-dpapi.ps1"), undefined, {
      ...dpapiEnvironment(),
      LOCALAPPDATA: directory,
    });

    assert.equal(await client.getSessionCache(), null);
    await client.putSessionCache("e2e-secret");
    assert.equal(await client.getSessionCache(), "e2e-secret");
    await client.deleteSessionCache();
    assert.equal(await client.getSessionCache(), null);
    assert.deepEqual(await readdir(join(directory, "NaN Dashboard")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
