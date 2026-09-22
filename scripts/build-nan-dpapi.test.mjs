import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildNanDpapi } from "./build-nan-dpapi.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nan-dpapi-copy-"));
  const source = join(directory, "nan-dpapi.ps1");
  await writeFile(source, "# fixture helper\n", "utf8");
  return { directory, source };
}

test("NaN DPAPI build copies the helper into a generated plugin path", async () => {
  const { directory, source } = await fixture();
  const output = join(directory, "com.refactor-ia.nan.sdPlugin", "bin", "nan-dpapi.ps1");
  try {
    await buildNanDpapi({ source, output });
    assert.equal(await readFile(output, "utf8"), "# fixture helper\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("NaN DPAPI build creates an absent output parent directory", async () => {
  const { directory, source } = await fixture();
  const output = join(directory, "absent", "bin", "nan-dpapi.ps1");
  try {
    await buildNanDpapi({ source, output });
    assert.equal(await readFile(output, "utf8"), "# fixture helper\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("NaN DPAPI build accepts an existing output parent directory", async () => {
  const { directory, source } = await fixture();
  const output = join(directory, "bin", "nan-dpapi.ps1");
  try {
    await mkdir(dirname(output));
    await buildNanDpapi({ source, output });
    assert.equal(await readFile(output, "utf8"), "# fixture helper\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
