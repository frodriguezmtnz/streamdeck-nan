import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const retiredPaths = [
  "packages/nan-usage-contract",
  "packages/nan-usage-collector",
  "packages/nan-hermes-hook",
  "packages/nan-opencode-plugin",
  "deploy/nan-usage-collector",
  "scripts/verify-nan-collector-e2e.mjs",
  "src/providers/nan/nan-credential-store.ts",
  "src/providers/nan/nan-summary-provider.ts",
  "test/nan-summary-provider.test.ts",
  "test/nan-usage-e2e.test.ts",
];

async function exists(path) {
  try {
    await access(new URL(path, root));
    return true;
  } catch {
    return false;
  }
}

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("collector retirement removes the closed cluster and its legacy runtime", async () => {
  for (const path of retiredPaths) {
    assert.equal(await exists(path), false, `retired path remains: ${path}`);
  }

  for (const path of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".dockerignore",
    ".gitleaks.toml",
    "README.md",
    "SECURITY.md",
  ]) {
    const content = await source(path);
    assert.doesNotMatch(content, /nan-usage-(contract|collector)|nan-hermes-hook|nan-opencode-plugin|nan-summary-provider|nan-credential-store|verify-nan-collector-e2e/i, path);
  }
});

test("dashboard-only NaN providers and generic security controls remain", async () => {
  for (const path of [
    "src/providers/nan/nan-dashboard-http.ts",
    "src/providers/nan/nan-dashboard-session-store.ts",
    "src/providers/nan/nan-keychain-client.ts",
    "scripts/build-nan-keychain.mjs",
    "scripts/sign-nan-keychain.mjs",
  ]) assert.equal(await exists(path), true, `required active boundary is missing: ${path}`);

  const gitleaks = await source(".gitleaks.toml");
  assert.match(gitleaks, /useDefault\s*=\s*true/);
  assert.doesNotMatch(gitleaks, /nan-usage-collector/i);

  const release = await source(".github/workflows/release.yml");
  assert.match(release, /Build universal NaN Keychain helper/);
  assert.match(release, /Sign and verify universal NaN Keychain helper/);
  assert.match(release, /Notarize immutable staged plugin/);
});
