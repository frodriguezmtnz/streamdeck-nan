import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-markdown-links.mjs", import.meta.url));

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "markdown-link-check-"));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  return directory;
}

function writeFixtureFile(directory, file, content) {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function addFixtureFiles(directory, ...files) {
  execFileSync("git", ["add", "--", ...files], { cwd: directory });
}

function runChecker(directory) {
  return spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });
}

function withFixture(callback) {
  const directory = createFixture();
  try {
    callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("skips a tracked markdown file deleted from the working tree", () => {
  withFixture((directory) => {
    writeFixtureFile(directory, "deploy/README.md", "# Retired collector\n");
    addFixtureFiles(directory, "deploy/README.md");
    unlinkSync(join(directory, "deploy/README.md"));

    const result = runChecker(directory);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Markdown links passed: 0 files checked/);
  });
});

test("rejects a retained document that links to a tracked deleted target", () => {
  withFixture((directory) => {
    writeFixtureFile(directory, "docs/README.md", "[Retired target](../deploy/README.md)\n");
    writeFixtureFile(directory, "deploy/README.md", "# Retired collector\n");
    addFixtureFiles(directory, "docs/README.md", "deploy/README.md");
    unlinkSync(join(directory, "deploy/README.md"));

    const result = runChecker(directory);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/README\.md: missing \..\/deploy\/README\.md/);
  });
});

test("checks an untracked markdown document for invalid relative links", () => {
  withFixture((directory) => {
    writeFixtureFile(directory, "new-guide.md", "[Missing](missing.md)\n");

    const result = runChecker(directory);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /new-guide\.md: missing missing\.md/);
  });
});

test("passes existing valid tracked and untracked markdown documents", () => {
  withFixture((directory) => {
    writeFixtureFile(directory, "docs/README.md", "[Guide](guide.md)\n");
    writeFixtureFile(directory, "docs/guide.md", "# Guide\n");
    writeFixtureFile(directory, "new-guide.md", "[Guide](docs/guide.md#usage)\n");
    addFixtureFiles(directory, "docs/README.md", "docs/guide.md");

    const result = runChecker(directory);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Markdown links passed: 3 files checked/);
  });
});

test("does not follow a markdown symlink outside the candidate", () => {
  withFixture((directory) => {
    const outside = join(tmpdir(), `outside-${process.pid}-${Date.now()}.md`);
    writeFileSync(outside, "# Outside candidate\n");
    symlinkSync(outside, join(directory, "linked.md"));
    addFixtureFiles(directory, "linked.md");

    try {
      const result = runChecker(directory);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /linked\.md: markdown document must not be a symlink/);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
