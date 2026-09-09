# NaN Keychain helper distribution

`NanKeychain.swift` is an original macOS 13+ helper using Foundation, Security, and LocalAuthentication. It is licensed under this repository's MIT license.

## Local development

Build the universal `arm64` and `x86_64` helper into the plugin bundle with:

```sh
pnpm build:nan-keychain
```

The command requires installed Xcode Command Line Tools `xcrun swiftc` and `/usr/bin/lipo`; it writes only `com.barbatdev.ai-usage.sdPlugin/bin/nan-keychain`. The helper reads a bounded JSON request from standard input, accepts no command-line selectors, and returns bounded JSON on standard output. Session-cache reads, writes, and deletes never permit authentication UI. Explicit Chrome Safe Storage import first reads without UI and makes at most one UI-enabled retry only when the noninteractive query reports interaction-required; cancellation and denial are never retried.

This local build is unsigned development evidence. It is not a distribution signing, notarization, Gatekeeper, or quarantine policy.

## Release signing setup

Tag-triggered `release.yml` is the only configured signing path; pull-request CI receives no Apple secrets. The release job builds the universal helper, signs and verifies that exact file, then packages it. It does not rebuild the helper between signing and packaging.

Configure these GitHub Actions **secrets** with organization-approved values; do not put any value in the repository, local shell history, or workflow logs.

| Secret | Required for | Value supplied by release owner |
| --- | --- | --- |
| `APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64` | Signing | Base64-encoded Developer ID Application `.p12` |
| `APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD` | Signing | Password for that `.p12` |
| `APPLE_DEVELOPER_ID_APPLICATION_IDENTITY` | Signing | Exact Developer ID Application identity string |
| `APPLE_DEVELOPER_ID_TEAM_ID` | Signing | Apple Developer Team ID expected in the signature |
| `APPLE_APP_STORE_CONNECT_API_KEY_P8_BASE64` | Notarization | Base64-encoded App Store Connect API `.p8` |
| `APPLE_APP_STORE_CONNECT_KEY_ID` | Notarization | App Store Connect API key ID |
| `APPLE_APP_STORE_CONNECT_ISSUER_ID` | Notarization | App Store Connect issuer ID |

The signing script fails before signing when any signing value is absent. In CI it creates a private temporary directory, a temporary keychain, and a private `.p12`; cleanup removes them on success and failure. It does not enumerate identities, access a local Keychain, print credentials, or enable shell tracing. It signs with the configured identity using hardened runtime options and a timestamp, then verifies the signature, configured identity/team, and both `arm64` and `x86_64` slices.

## Notarization gate

`pack-streamdeck.mjs` replaces the CLI output with the final `zip -X -q` `.streamDeckPlugin` archive. The release job validates that archive with `unzip -t`, then copies it byte-for-byte to a private temporary file named `plugin.zip` for `xcrun notarytool submit --wait`. It does not repack, wrap, or nest the signed helper. Before recording acceptance, it hashes both the temporary ZIP and the public `.streamDeckPlugin` again; either mutation fails the gate.

This follows Apple's [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow): the notary service accepts ZIP archives and processes nested containers, generating tickets for the top-level file and nested files. The final archive is therefore submitted as a ZIP by content while its public `.streamDeckPlugin` filename and release asset name remain unchanged.

Only an `Accepted` response with a nonempty submission ID writes `dist/NOTARIZATION.json`. The file records the observed result and the matching submitted/published SHA-256; `scripts/release-contract.mjs` verifies those values before artifact upload and again before draft publication. There is no manual receipt bypass.

A ZIP cannot be stapled directly, and Apple does not support stapling tickets to standalone binaries. This workflow performs neither operation. Gatekeeper may therefore need an online ticket lookup; real signed-install and Gatekeeper validation remain pending a release owner with credentials and a macOS test environment.

Do not run production signing, Keychain access, identity discovery, notarization submission, workflow dispatch, or publication from a developer machine as part of this preparation.
