# NaN Keychain helper distribution

`NanKeychain.swift` is an original macOS 13+ helper using Foundation, Security, and LocalAuthentication. It is licensed under this repository's MIT license.

## Local development

Build the universal `arm64` and `x86_64` helper into the plugin bundle with:

```sh
pnpm build:nan-keychain
```

The command requires installed Xcode Command Line Tools `xcrun swiftc` and `/usr/bin/lipo`; it writes only `com.barbatdev.ai-usage.sdPlugin/bin/nan-keychain`. The helper reads a bounded JSON request from standard input, accepts no command-line selectors, and returns bounded JSON on standard output. Session-cache reads, writes, and deletes never permit authentication UI. Explicit Chrome Safe Storage import first reads without UI and makes at most one UI-enabled retry only when the noninteractive query reports interaction-required; cancellation and denial are never retried.

This local build is unsigned development evidence. It is not a distribution signing, notarization, Gatekeeper, or quarantine policy.

## Release distribution

Tag-triggered `release.yml` builds the universal helper and verifies that it is executable before packaging. The helper and the distributed `.streamDeckPlugin` artifact are intentionally unsigned: the release pipeline performs no Apple code signing, notarization, or Apple credential import.

The release contract remains one integrity and security boundary. It retains version validation, reproducible packaging, secret scanning, SHA-256 checksums, exact release-asset validation, and isolated artifact handoff before draft publication. The pipeline does not rebuild the helper between its executable check and packaging.

This document makes no claim about Gatekeeper behavior or store approval. Runtime use of the macOS Keychain remains separate from release distribution.
