import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function gitMarkdownFiles(...args) {
  return execFileSync("git", args, { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

const deleted = new Set(gitMarkdownFiles("ls-files", "-z", "--deleted", "--", "*.md"));
const tracked = gitMarkdownFiles("ls-files", "-z", "--", "*.md").filter((file) => !deleted.has(file));
const untracked = gitMarkdownFiles("ls-files", "-z", "--others", "--exclude-standard", "--", "*.md");
const files = [...new Set([...tracked, ...untracked])].sort();
const failures = [];

for (const file of files) {
  let content;
  try {
    if (lstatSync(file).isSymbolicLink()) {
      failures.push(`${file}: markdown document must not be a symlink`);
      continue;
    }
    content = readFileSync(file, "utf8");
  } catch (error) {
    failures.push(`${file}: unable to read markdown document (${error.code ?? error.message})`);
    continue;
  }

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) {
      failures.push(`${file}: missing ${target}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Markdown links passed: ${files.length} files checked`);
