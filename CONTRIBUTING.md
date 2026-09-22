# Contributing

Thanks for your interest in contributing to **NaN Dashboard**.

## Reporting Issues

Use the GitHub issue tracker to report bugs, feature requests, or questions.
Include as much detail as possible:

- Steps to reproduce the issue
- Expected vs. actual behavior
- Plugin version and Stream Deck+ firmware
- Relevant log files (`com.refactor-ia.nan.sdPlugin/logs/`)

## Pull Requests

1. Fork the repository and create a feature branch from `main`.
2. Make your changes. Ensure the build passes:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check:workspace
   pnpm test:workspace
   pnpm build
   ```

3. Add tests for new functionality. Run the full test suite:

   ```sh
   pnpm test:workspace
   ```

4. Submit a pull request with a clear description and any relevant screenshots or logs.

## Development on Windows

The plugin targets both macOS and Windows, and one bundle serves both. On a Windows machine:

- `pnpm check:workspace` and `pnpm test` work as written. The macOS-only tests (symlink, uid/mode, and `/Applications` checks plus the Keychain helper) skip automatically on `win32`, so the suite stays green locally.
- `pnpm test:workspace` also runs the release script tests, which need macOS/Linux tooling (`zip`, `unzip`, `shasum`) and the macOS Keychain build; leave those to the macOS CI job.
- `pnpm release:pack` and `pnpm release:pack:verify` require `zip` and stay on the macOS packaging job, which produces the single universal `.streamDeckPlugin`.
- `pnpm build` runs Rollup and then copies the PowerShell DPAPI helper (`native/nan-dpapi/nan-dpapi.ps1`) into `com.refactor-ia.nan.sdPlugin/bin/`. The Windows CI job verifies that copy and runs the DPAPI round-trip e2e test.

## Project history

Public history starts at the sanitized source import. Contributions proceed normally from that point; refer to the retained provenance notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Code Style

- TypeScript strict mode is enforced.
- Follow existing patterns in the codebase — no comments in production code.
- Keep changes focused and reviewable.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.

## Project metadata

The root package is marked `private: true` and is not published to npm.
The repository boundaries are plugin source (`src/`), native helper code (`native/`), build and release scripts (`scripts/`), and tests (`test/` and `scripts/*.test.mjs`).
The repository lives under the `refactor-ia` GitHub organization; the npm package is unscoped (`streamdeck-nan`) and marked `private: true` for internal development. The `com.barbatdev.ai-usage.nan-session` Keychain identity is a historical compatibility name pinned by contract tests and must not be renamed.