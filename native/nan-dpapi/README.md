# NaN DPAPI helper distribution

`nan-dpapi.ps1` is an original Windows 10+ helper using the Windows Data Protection API (DPAPI) scoped to the current user. It is licensed under this repository's MIT license.

## Local development

Copy the helper into the plugin bundle with:

```sh
pnpm build:nan-dpapi
```

The command copies `native/nan-dpapi/nan-dpapi.ps1` to `com.refactor-ia.nan.sdPlugin/bin/nan-dpapi.ps1`. The helper reads a bounded JSON request from standard input, accepts no command-line selectors, and returns bounded JSON on standard output. It stores the NaN session cache as a DPAPI-protected file under `%LOCALAPPDATA%\NaN Dashboard` and returns the secret only for an explicit `get`.

The helper requires Windows PowerShell 5.1 (`powershell.exe`); it does not use PowerShell 7. It is unsigned, and no Authenticode signing, timestamping, or release approval is performed.

## Release distribution

The plugin build (`pnpm build`) and the packaging script (`scripts/pack-streamdeck.mjs`) both copy the helper into the bundle before it is packaged, so the distributed `.streamDeckPlugin` is self-contained. Runtime use of DPAPI remains separate from release distribution.
