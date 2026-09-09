import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const filters = process.argv.slice(2).filter((argument) => argument !== "--");
const args = ["--import", "./scripts/test-typescript-resolver.mjs", "--test"];
if (filters.length > 0) args.push(`--test-name-pattern=${filters.join("|")}`);
args.push(...collectTests("test"));

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
