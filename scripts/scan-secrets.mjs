import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const excludedDirectories = new Set([".git", "node_modules", "dist"]);
export const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-(?:live-|test-)?[A-Za-z0-9]{24,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{24,}/i,
  /NAN_(?:USAGE|HERMES|API)[A-Z0-9_]*\s*[=:]\s*["']?[a-f0-9]{64}["']?/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?token|password)\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{24,}["']/i,
];

function collectFiles(directory = ".", exclusions = excludedDirectories) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return exclusions.has(entry.name) ? [] : collectFiles(path, exclusions);
    return entry.isFile() ? [path] : [];
  });
}

export function findSecrets(content) {
  return secretPatterns.filter((pattern) => pattern.test(content));
}

export function scanFiles(files) {
  const findings = [];
  for (const file of files) {
    let content;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    for (const pattern of findSecrets(content)) findings.push(`${file}: ${pattern}`);
  }
  if (findings.length) throw new Error(findings.join("\n"));
  return files.length;
}

export function scanReleaseArtifact(artifact) {
  const directory = mkdtempSync(join(tmpdir(), "streamdeck-secret-scan-"));
  try {
    execFileSync("unzip", ["-qq", artifact, "-d", directory]);
    const files = collectFiles(directory, new Set());
    scanFiles(files);
    return files.length;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const artifactIndex = process.argv.indexOf("--artifact");
    if (artifactIndex !== -1) {
      const artifact = process.argv[artifactIndex + 1];
      if (!artifact) throw new Error("--artifact requires a path");
      const count = scanReleaseArtifact(fileURLToPath(pathToFileURL(artifact)));
      console.log(`Secret scan passed: ${count} extracted release files checked`);
    } else {
      const files = collectFiles();
      scanFiles(files);
      console.log(`Secret scan passed: ${files.length} workspace files checked`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
