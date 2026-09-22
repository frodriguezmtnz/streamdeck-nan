import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildNanDpapi({
  source = resolve("native/nan-dpapi/nan-dpapi.ps1"),
  output = resolve("com.refactor-ia.nan.sdPlugin/bin/nan-dpapi.ps1"),
} = {}) {
  await mkdir(dirname(output), { recursive: true });
  await copyFile(source, output);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await buildNanDpapi();
  } catch {
    process.stderr.write("NaN DPAPI helper copy unavailable\n");
    process.exitCode = 1;
  }
}
