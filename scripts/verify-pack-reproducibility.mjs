import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

async function packageDigest() {
  const result = spawnSync(process.execPath, ["scripts/pack-streamdeck.mjs"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const artifacts = (await readdir("dist")).filter((name) => name.endsWith(".streamDeckPlugin"));
  if (artifacts.length !== 1) throw new Error(`expected exactly one package, found ${artifacts.length}`);
  return createHash("sha256").update(await readFile(`dist/${artifacts[0]}`)).digest("hex");
}

const first = await packageDigest();
const second = await packageDigest();
if (first !== second) throw new Error("two clean package builds produced different SHA-256 digests");
