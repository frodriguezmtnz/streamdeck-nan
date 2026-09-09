import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocument } from "yaml";

function parseWorkflow(content) {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length) throw document.errors[0];
  return document.toJS();
}

async function workflow(name) {
  return parseWorkflow(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
}

function checkoutSteps(value) {
  return Object.values(value.jobs).flatMap(({ steps }) => steps).filter(({ uses }) => uses?.startsWith("actions/checkout@"));
}

test("workflow parser rejects duplicate semantic keys", () => {
  assert.throws(() => parseWorkflow("permissions:\n  contents: read\npermissions:\n  contents: write\n"), /Map keys must be unique/);
});

test("CI triggers pushes and pull requests with read-only permissions", async () => {
  const ci = await workflow("ci.yml");
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.deepEqual(ci.on.pull_request.branches, ["main"]);
  assert.deepEqual(ci.permissions, { contents: "read", "pull-requests": "read" });
  assert.ok(checkoutSteps(ci).length >= 2);
  assert.ok(checkoutSteps(ci).every((step) => step.with?.["persist-credentials"] === false));
  assert.equal(ci.jobs["collector-linux"], undefined);
  assert.doesNotMatch(JSON.stringify(ci), /nan-usage-collector|verify-nan-collector-e2e/i);
  assert.ok(Object.values(ci.jobs).flatMap(({ steps }) => steps).some(({ uses }) => uses?.startsWith("gitleaks/gitleaks-action@")));
  assert.ok(Object.values(ci.jobs).flatMap(({ steps }) => steps).every(({ env }) => !Object.keys(env ?? {}).some((name) => name.startsWith("APPLE_"))));
});

test("release uses read-only packaging, artifact handoff, and isolated write publishing", async () => {
  const release = await workflow("release.yml");
  assert.deepEqual(release.on.push.tags, ["v*"]);
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.equal(release.jobs.publish.needs, "package");
  assert.deepEqual(release.jobs.publish.permissions, { contents: "write" });
  assert.equal(release.jobs.package.permissions, undefined);
  assert.ok(checkoutSteps(release).every((step) => step.with?.["persist-credentials"] === false));
  const upload = release.jobs.package.steps.find(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
  const download = release.jobs.publish.steps.find(({ uses }) => uses?.startsWith("actions/download-artifact@"));
  assert.ok(upload && download);
  assert.equal(upload.with.name, download.with.name);
  assert.equal(download.with.path, "dist");
  const tokenEnvSteps = Object.entries(release.jobs).flatMap(([job, value]) => value.steps.filter(({ env }) => Object.keys(env ?? {}).some((name) => /token|secret/i.test(name))).map((step) => ({ job, step })));
  assert.ok(tokenEnvSteps.every(({ job, step }) => job === "package" && step.uses?.startsWith("gitleaks/gitleaks-action@") && step.env.GITHUB_TOKEN === "${{ github.token }}"));
  const packageCommands = release.jobs.package.steps.map(({ run }) => run ?? "").join("\n");
  const publishCommands = release.jobs.publish.steps.map(({ run }) => run ?? "").join("\n");
  assert.match(publishCommands, /github\.token.*gh auth login --with-token/s);
  assert.doesNotMatch(packageCommands, /gh auth login/);
  assert.match(packageCommands, /release-contract\.mjs/);
  assert.ok(release.jobs.package.steps.some(({ uses }) => uses?.startsWith("gitleaks/gitleaks-action@")));
  const sign = release.jobs.package.steps.find(({ run }) => run === "node scripts/sign-nan-keychain.mjs");
  assert.ok(sign);
  assert.deepEqual(sign.env, {
    APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64: "${{ secrets.APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64 }}",
    APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD: "${{ secrets.APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD }}",
    APPLE_DEVELOPER_ID_APPLICATION_IDENTITY: "${{ secrets.APPLE_DEVELOPER_ID_APPLICATION_IDENTITY }}",
    APPLE_DEVELOPER_ID_TEAM_ID: "${{ secrets.APPLE_DEVELOPER_ID_TEAM_ID }}",
  });
  const notarize = release.jobs.package.steps.find(({ run }) => run === "node scripts/notarize-streamdeck.mjs dist/*.streamDeckPlugin");
  assert.ok(notarize);
  assert.deepEqual(notarize.env, {
    APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64: "${{ secrets.APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64 }}",
    APPLE_APP_STORE_CONNECT_KEY_ID: "${{ secrets.APPLE_APP_STORE_CONNECT_KEY_ID }}",
    APPLE_APP_STORE_CONNECT_ISSUER_ID: "${{ secrets.APPLE_APP_STORE_CONNECT_ISSUER_ID }}",
  });
  const buildIndex = packageCommands.indexOf("pnpm build:nan-keychain");
  const signIndex = packageCommands.indexOf("node scripts/sign-nan-keychain.mjs");
  const packIndex = packageCommands.indexOf("pnpm release:pack:verify");
  const notarizeIndex = packageCommands.indexOf("node scripts/notarize-streamdeck.mjs dist/*.streamDeckPlugin");
  const checksumIndex = packageCommands.indexOf("shasum -a 256");
  assert.ok(buildIndex >= 0 && buildIndex < signIndex && signIndex < packIndex && packIndex < notarizeIndex && notarizeIndex < checksumIndex);
  assert.match(upload.with.path, /dist\/NOTARIZATION\.json/);
  assert.match(publishCommands, /release-assets\.mjs.*clean/);
  assert.match(publishCommands, /release-assets\.mjs.*exact/);
});
