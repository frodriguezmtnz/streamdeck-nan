import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  dpapiEnvironment,
  NanDpapiClient,
  NAN_DPAPI_MAX_STDIN_BYTES,
  NAN_DPAPI_TIMEOUT_MS,
  resolveNanDpapiHelperPath,
  resolvePowerShellPath,
} from "../src/providers/nan/nan-dpapi-client.ts";

const helperPath = "C:\\plugin\\bin\\nan-dpapi.ps1";
const powerShellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const environment = { SystemRoot: "C:\\Windows" };

test("NaN DPAPI client invokes PowerShell with a fixed script and stdin-only secrets", async () => {
  const requests: Array<{ executable: string; args: readonly string[]; stdin: string; timeoutMs: number; env?: Readonly<Record<string, string>> }> = [];
  const client = new NanDpapiClient(async (request) => {
    requests.push(request);
    return { exitCode: 0, stdout: "{\"ok\":true}\n" };
  }, helperPath, powerShellPath, environment);

  await client.putSessionCache("session-secret");
  await client.deleteSessionCache();

  assert.deepEqual(requests.map(({ executable }) => executable), [powerShellPath, powerShellPath]);
  assert.deepEqual(requests.map(({ args }) => args), [
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath],
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath],
  ]);
  assert.deepEqual(requests.map(({ stdin }) => stdin), [
    "{\"operation\":\"put\",\"secret\":\"session-secret\"}\n",
    "{\"operation\":\"delete\"}\n",
  ]);
  assert.equal(requests[0].args.join(" ").includes("session-secret"), false);
  for (const request of requests) assert.equal(request.timeoutMs, NAN_DPAPI_TIMEOUT_MS);
  assert.equal(NAN_DPAPI_TIMEOUT_MS > 2_000, true);
});

test("NaN DPAPI client reads and preserves an explicit null secret", async () => {
  const frames: string[] = [];
  const client = new NanDpapiClient(async (request) => {
    frames.push(request.stdin);
    return { exitCode: 0, stdout: "{\"ok\":true,\"secret\":\"value\"}" };
  }, helperPath, powerShellPath, environment);

  assert.equal(await client.getSessionCache(), "value");

  const absent = new NanDpapiClient(async () => ({ exitCode: 0, stdout: "{\"ok\":true,\"secret\":null}\n" }), helperPath, powerShellPath, environment);
  assert.equal(await absent.getSessionCache(), null);
  assert.deepEqual(frames, ["{\"operation\":\"get\"}\n"]);
});

test("NaN DPAPI client fails closed without exposing helper output", async () => {
  const secret = "do-not-leak";
  const denied = new NanDpapiClient(async () => ({ exitCode: 1, stdout: `{"ok":false,"error":"${secret}"}` }), helperPath, powerShellPath, environment);
  await assert.rejects(denied.getSessionCache(), (error: Error) => error.message === "DPAPI helper unavailable" && !error.message.includes(secret));

  const malformed = new NanDpapiClient(async () => ({ exitCode: 0, stdout: "not json" }), helperPath, powerShellPath, environment);
  await assert.rejects(malformed.getSessionCache(), /DPAPI helper unavailable/);

  const wrongSecret = new NanDpapiClient(async () => ({ exitCode: 0, stdout: "{\"ok\":true,\"secret\":7}" }), helperPath, powerShellPath, environment);
  await assert.rejects(wrongSecret.getSessionCache(), /DPAPI helper unavailable/);

  const oversized = new NanDpapiClient(async () => ({ exitCode: 0, stdout: `{"ok":true,"secret":"${"x".repeat(9 * 1024)}"}` }), helperPath, powerShellPath, environment);
  await assert.rejects(oversized.getSessionCache(), /DPAPI helper unavailable/);

  const rejectedStdin = new NanDpapiClient(async () => ({ exitCode: 0, stdout: "{\"ok\":true}" }), helperPath, powerShellPath, environment);
  await assert.rejects(rejectedStdin.putSessionCache("x".repeat(NAN_DPAPI_MAX_STDIN_BYTES)), /DPAPI helper unavailable/);
});

test("NaN DPAPI helper and PowerShell paths resolve deterministically", () => {
  assert.equal(resolveNanDpapiHelperPath("file:///C:/plugin/bin/plugin.js").endsWith("nan-dpapi.ps1"), true);
  assert.equal(
    resolvePowerShellPath({ SystemRoot: "D:\\Windows" }),
    join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
});

test("NaN DPAPI environment allowlist drops unrelated and secret variables", () => {
  assert.deepEqual(
    dpapiEnvironment({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", NAN_API_KEY: "secret", PATH: "/usr/bin", NAN_DPAPI_STORE_DIR: "x" }),
    { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
  );
});
