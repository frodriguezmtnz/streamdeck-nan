import assert from "node:assert/strict";
import test from "node:test";
import { nativeBuildPlan } from "./build-nan-keychain.mjs";

test("native NaN Keychain build plan compiles macOS 13 arm64 and x86_64 then merges only the helper", () => {
  assert.deepEqual(nativeBuildPlan({
    source: "/repo/native/nan-keychain/NanKeychain.swift",
    output: "/repo/com.barbatdev.ai-usage.sdPlugin/bin/nan-keychain",
    temporaryDirectory: "/tmp/nan-keychain",
  }), [
    {
      executable: "/usr/bin/xcrun",
      args: ["swiftc", "-target", "arm64-apple-macos13.0", "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication", "/repo/native/nan-keychain/KeychainAccess.swift", "/repo/native/nan-keychain/NanKeychain.swift", "-o", "/tmp/nan-keychain/nan-keychain-arm64"],
    },
    {
      executable: "/usr/bin/xcrun",
      args: ["swiftc", "-target", "x86_64-apple-macos13.0", "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication", "/repo/native/nan-keychain/KeychainAccess.swift", "/repo/native/nan-keychain/NanKeychain.swift", "-o", "/tmp/nan-keychain/nan-keychain-x86_64"],
    },
    {
      executable: "/usr/bin/lipo",
      args: ["-create", "-output", "/repo/com.barbatdev.ai-usage.sdPlugin/bin/nan-keychain", "/tmp/nan-keychain/nan-keychain-arm64", "/tmp/nan-keychain/nan-keychain-x86_64"],
    },
  ]);
});
