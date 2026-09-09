import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { notarizationConfig, notarizeArtifact } from "./notarize-streamdeck.mjs";

const environment = {
  APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64: Buffer.from("synthetic-p8").toString("base64"),
  APPLE_APP_STORE_CONNECT_KEY_ID: "ABCDE12345",
  APPLE_APP_STORE_CONNECT_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notarize-streamdeck-test-"));
  const artifact = join(root, "plugin.streamDeckPlugin");
  await writeFile(artifact, "synthetic-zip-bytes");
  return { root, artifact };
}

test("notarization configuration fails closed when any App Store Connect value is missing", () => {
  for (const name of Object.keys(environment)) {
    const missing = { ...environment };
    delete missing[name];
    assert.throws(() => notarizationConfig(missing), new RegExp(name));
  }
});

test("submits a validated Stream Deck ZIP through a byte-for-byte private .zip copy", async () => {
  const { root, artifact } = await fixture();
  const commands = [];
  const result = await notarizeArtifact({
    artifact,
    environment,
    temporaryRoot: root,
    run: async (executable, args) => {
      commands.push({ executable, args });
      if (executable === "/usr/bin/unzip") return { status: 0, stdout: "No errors detected", stderr: "" };
      const submitted = args[2];
      assert.equal(await readFile(submitted, "utf8"), await readFile(artifact, "utf8"));
      return { status: 0, stdout: JSON.stringify({ status: "Accepted", id: "synthetic-submission" }), stderr: "" };
    },
  });

  assert.equal(result.status, "Accepted");
  assert.equal(result.submissionId, "synthetic-submission");
  assert.equal(result.publishedArtifact, artifact);
  assert.match(result.submittedSha256, /^[a-f0-9]{64}$/);
  assert.ok(commands.some(({ executable, args }) => executable === "/usr/bin/unzip" && args[0] === "-t" && args[1] === artifact));
  const notarization = commands.find(({ executable }) => executable === "/usr/bin/xcrun");
  assert.match(notarization.args[2], /\.zip$/);
  const keyPath = notarization.args[notarization.args.indexOf("--key") + 1];
  await assert.rejects(access(keyPath));
  const receipt = JSON.parse(await readFile(join(root, "NOTARIZATION.json"), "utf8"));
  assert.equal(receipt.submittedSha256, receipt.publishedArtifact.sha256);
  assert.equal(receipt.publishedArtifact.name, "plugin.streamDeckPlugin");
});

test("rejects an invalid Stream Deck ZIP before submission", async () => {
  const { artifact } = await fixture();
  const commands = [];
  await assert.rejects(notarizeArtifact({
    artifact,
    environment,
    run: async (executable, args) => {
      commands.push({ executable, args });
      return { status: 1, stdout: "", stderr: "invalid archive" };
    },
  }), /ZIP integrity/);
  assert.ok(commands.every(({ executable }) => executable === "/usr/bin/unzip"));
});

test("rejects a non-Accepted response and removes private API-key material", async () => {
  const { root, artifact } = await fixture();
  let keyPath;
  await assert.rejects(notarizeArtifact({
    artifact,
    environment,
    temporaryRoot: root,
    run: async (executable, args) => {
      if (executable === "/usr/bin/unzip") return { status: 0, stdout: "", stderr: "" };
      keyPath = args[args.indexOf("--key") + 1];
      return { status: 0, stdout: JSON.stringify({ status: "Invalid", id: "synthetic-submission" }), stderr: "" };
    },
  }), /not accepted/);
  await assert.rejects(access(keyPath));
});

test("rejects a published artifact that changes while notarytool waits", async () => {
  const { artifact } = await fixture();
  await assert.rejects(notarizeArtifact({
    artifact,
    environment,
    run: async (executable) => {
      if (executable === "/usr/bin/unzip") return { status: 0, stdout: "", stderr: "" };
      await writeFile(artifact, "mutated-after-submission");
      return { status: 0, stdout: JSON.stringify({ status: "Accepted", id: "synthetic-submission" }), stderr: "" };
    },
  }), /changed while notarization was pending/);
});
