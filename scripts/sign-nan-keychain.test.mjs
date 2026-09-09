import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signingConfig, signNanKeychain } from "./sign-nan-keychain.mjs";

const environment = {
  APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64: Buffer.from("synthetic-p12").toString("base64"),
  APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD: "synthetic-password",
  APPLE_DEVELOPER_ID_APPLICATION_IDENTITY: "Developer ID Application: Example, Inc. (ABCDE12345)",
  APPLE_DEVELOPER_ID_TEAM_ID: "ABCDE12345",
};

test("signing configuration fails closed when any required value is missing", () => {
  for (const name of Object.keys(environment)) {
    const missing = { ...environment };
    delete missing[name];
    assert.throws(() => signingConfig(missing), new RegExp(name));
  }
});

test("signs and verifies the universal helper using an isolated temporary keychain", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sign-nan-keychain-test-"));
  const commands = [];
  const result = await signNanKeychain({
    helperPath: "/synthetic/nan-keychain",
    environment,
    temporaryRoot,
    run: async (executable, args) => {
      commands.push({ executable, args });
      if (executable === "/usr/bin/codesign" && args[0] === "-dv") {
        return { status: 0, stdout: "", stderr: `Authority=${environment.APPLE_DEVELOPER_ID_APPLICATION_IDENTITY}\nTeamIdentifier=${environment.APPLE_DEVELOPER_ID_TEAM_ID}\n` };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.teamId, environment.APPLE_DEVELOPER_ID_TEAM_ID);
  assert.ok(commands.some(({ executable, args }) => executable === "/usr/bin/security" && args[0] === "create-keychain"));
  assert.ok(commands.some(({ executable, args }) => executable === "/usr/bin/security" && args[0] === "import"));
  assert.ok(commands.some(({ executable, args }) => executable === "/usr/bin/codesign" && args.includes("--options") && args.includes("runtime") && args.includes("--timestamp") && args.includes(environment.APPLE_DEVELOPER_ID_APPLICATION_IDENTITY)));
  assert.ok(commands.some(({ executable, args }) => executable === "/usr/bin/codesign" && args[0] === "--verify" && args.includes("--strict")));
  assert.deepEqual(commands.filter(({ executable }) => executable === "/usr/bin/lipo").map(({ args }) => args), [["-verify_arch", "arm64", "x86_64", "/synthetic/nan-keychain"]]);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test("does not accept a signature whose identity or team differs from the configured values", async () => {
  await assert.rejects(signNanKeychain({
    helperPath: "/synthetic/nan-keychain",
    environment,
    run: async (executable, args) => ({
      status: 0,
      stdout: "",
      stderr: executable === "/usr/bin/codesign" && args[0] === "-dv" ? "Authority=other\nTeamIdentifier=other\n" : "",
    }),
  }), /configured Developer ID identity/);
});
