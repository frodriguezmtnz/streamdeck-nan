# NaN Dashboard for Stream Deck+

NaN Dashboard is the primary Stream Deck+ experience for dashboard quota and model metrics; Claude, Codex, and experimental Grok are auxiliary external CLI integrations.

## Primary Features

- **NaN Dashboard quota:** explicitly import an authenticated Chrome session, then view quota, reset windows, and safe stale-state feedback on the NaN Usage dial.
- **NaN actions:** use a keypad launcher, per-model usage, all-time tokens, or month-to-date tokens without exposing session data in settings.
- **External CLI dials:** optionally view local Claude Code, Codex, and experimental Grok Build usage through their installed, signed-in CLIs.

## Quick Install, NaN Setup, and Use

1. Download the latest `.streamDeckPlugin` bundle from the [Releases](https://github.com/refactor-ia/streamdeck-nan/releases) page and double-click it to install.
2. Add **NaN Usage** to a Stream Deck+ encoder. Choose **Import session from Chrome** in its inspector.
3. Touch the encoder to refresh its dashboard quota. Add **NaN Model Usage**, **NaN Total Tokens**, or **NaN Monthly Tokens** to keypad positions as needed.
4. Add **NaN Dashboard** to a standard keypad position and press it when you explicitly want to open the fixed dashboard URL. The launcher does not import a session, request metrics, refresh usage, or change settings.

**Requirements:** macOS 13 or later, Stream Deck 7.1 or later, and Stream Deck+ hardware for encoder actions. NaN Dashboard keypad actions are also available without an encoder.

The NaN Usage dial reads dashboard quota from the explicitly imported authenticated Chrome session. The plugin never reads Chrome or Chrome Safe Storage during appearance, refresh, rotation, settings, or wake handling. Dashboard values show provider quota (`used / cap`), raw percentage, and the API-provided reset or rolling window. A saved `legacy` source is migrated to `dashboard` once when its dial appears; all other settings and model IDs are preserved verbatim. Touching the dial refreshes its data; rotating it selects an API-returned capped model. **NaN Model Usage** selects one API-returned capped or uncapped model per key and refreshes the shared dashboard snapshot when pressed. If no dashboard session exists, import it explicitly from the existing NaN Usage dial. A transient dashboard failure keeps only the last dashboard quota as `STALE`; a rejected session returns to import onboarding without showing a prior account's quota.

## External Integrations and Requirements

- **Claude Usage** requires Claude Code installed and signed in at `$HOME/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, or `/usr/bin/claude`. It runs the official Claude CLI `/usage` command with tools disabled, then shows its session and weekly usage windows. The command must report zero turns, API duration, cost, and token usage.
- **GPT / OpenAI Usage** requires Codex CLI installed, signed in, and available as `codex` to Stream Deck. It starts one local `codex app-server`, reuses the Codex CLI session, and shows the weekly usage window returned by Codex.
- **Grok Usage (EXPERIMENTAL)** requires the optional Grok Build CLI installed and signed in. It starts the authenticated local Grok Build CLI over ACP stdio and requests only its `x.ai/billing` extension. It does not read credential files or API keys, send prompts, or invoke inference.

Touching an external encoder refreshes its data. Pressing a Claude or Codex encoder opens the corresponding provider page; Grok refreshes on touch.

## Development

Development requires Node.js 24 and pnpm 11.13.0.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Validate TypeScript and the Stream Deck manifest:

```sh
pnpm check
```

Run the full test suite:

```sh
pnpm test:workspace
```

Build the plugin bundle:

```sh
pnpm build
```

The packaging script invokes the repository-local installed Stream Deck CLI entry
(`node_modules/@elgato/cli/bin/streamdeck.mjs`) directly; it never runs pnpm,
npm, or npx. A later authorized disposable isolated copy must expose its complete
installed `node_modules` tree at that same repository-relative path (for example,
through a read-only mount or link); the script does not install or download dependencies.

Watch source files and restart the plugin after each build:

```sh
pnpm watch
```

No final genuine Stream Deck screenshot is currently available; it remains a development limitation rather than a placeholder asset.

## Security and Privacy

The plugin reuses existing local sessions; it does not provide a login flow or
store credentials in Stream Deck settings. Claude authentication remains inside
the installed Claude CLI. The plugin runs only its built-in `/usage` command
without tools or model inference and accepts only bounded JSON with affirmative
zero-inference telemetry and the two expected usage lines. It does not read
Claude credentials or call a private usage endpoint. Claude discovery uses only
the four absolute launcher paths listed under Requirements, resolves symlinks,
and checks target identity, ownership, permissions, and parent directories
again immediately before execution. Codex and Grok use the same trusted
absolute-candidate, symlink-resolution, and pre-spawn identity-validation
controls. The final validated-path-to-spawn interval is a same-user filesystem
residual shared by these CLI launches; it is not an atomic execution guarantee.
Codex authentication remains inside the local Codex CLI and its app server.
Experimental Grok authentication also remains inside the local Grok Build CLI;
the plugin sends only ACP initialization and billing requests. Dashboard session
cache data is stored through the dedicated local session store, never in Stream Deck
settings. The Chrome importer is invoked only by the inspector button, validates one
profile/store candidate at a time, and does not expose cookies, provider URLs, or
Safe Storage secrets in settings, feedback, or logs.

Tokens, authorization headers, raw provider payloads, and CLI diagnostics are
not written to logs, settings, action feedback, or the property inspector. Usage
requests go directly through the official provider sessions, with no third-party
relay.

### Reporting Security Issues

If you discover a security vulnerability, please report it privately. See
[SECURITY.md](SECURITY.md) for details.

## Advanced Architecture and Status

The `com.refactor-ia.nan` migration recreates all eight Stream Deck buttons, so users add the new actions again after installing version 1.0.4. Existing NaN session compatibility is retained internally only; this documentation does not expose session or credential identities.

The generated, tracked bundle at `com.refactor-ia.nan.sdPlugin/bin/plugin.js` keeps the plugin directory self-contained.

### NaN Dashboard Validation Status

The direct dashboard flow has focused mocked tests only. It still requires human
validation with a real authenticated Chrome profile and normal macOS permission
prompts, followed by the project's release-process validation. This checkout does not
claim production readiness, perform signing, restart Stream Deck, or deploy the
plugin.

### Platform Support

The current manifest supports macOS only. Encoder actions target Stream Deck+;
NaN Model Usage and NaN Dashboard are also available as standard keypad actions.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
