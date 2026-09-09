# NaN Dashboard for Stream Deck+

Stream Deck+ plugin supporting NaN Dashboard alongside the current external CLI provider dials for Claude, Codex, and experimental Grok usage.

## Requirements

- macOS 13 or later
- Stream Deck 7.1 or later
- Stream Deck+ hardware
- Claude Code installed and signed in at `$HOME/.local/bin/claude`,
  `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, or `/usr/bin/claude`
- Codex CLI installed, signed in, and available as `codex` to Stream Deck
- Grok Build CLI installed and signed in (optional, experimental Grok action)

## Install

Download the latest `.streamDeckPlugin` bundle from the [Releases](https://github.com/barbatdev/streamdeck-plugins/releases) page and double-click it to install.

## Quick Setup

1. Run `claude` and complete the Claude Code sign-in flow.
2. Run `codex login` and confirm that `codex` is available on the `PATH` used
   by Stream Deck.
3. Add the Claude Usage and GPT / OpenAI Usage actions, then touch an encoder
   to refresh immediately.
4. Add **NaN Dashboard** to a standard keypad position and press it when you explicitly want to open the fixed dashboard URL. The launcher does not import a session, request metrics, refresh usage, or change settings.

## How It Works

The plugin provides four encoder actions, configurable usage keypad actions, and one fixed dashboard launcher:

- **Claude Usage** runs the official Claude CLI `/usage` command with tools
  disabled, then shows its session and weekly usage windows. The command must
  report zero turns, API duration, cost, and token usage.
- **GPT / OpenAI Usage** starts one local `codex app-server`, reuses the Codex
  CLI session, and shows the weekly usage window returned by Codex.
- **Grok Usage (EXPERIMENTAL)** starts the authenticated local Grok Build CLI
  over ACP stdio and requests only its `x.ai/billing` extension. It does
  not read credential files or API keys, send prompts, or invoke inference.
- **NaN Usage** reads dashboard quota from an explicitly imported authenticated
  Chrome session. Choose **Import session from Chrome** in its inspector; the plugin
  never reads Chrome or Chrome Safe Storage during appearance, refresh, rotation,
  settings, or wake handling. Dashboard values show provider quota (`used / cap`),
  raw percentage, and the API-provided reset or rolling window. A saved `legacy`
  source is migrated to `dashboard` once when its dial appears; all other settings
  and model IDs are preserved verbatim.
- **NaN Dashboard** is a settings-free standard keypad launcher. Only an explicit keypress opens `https://cloud.nan.builders/dashboard`; it does not import sessions, request metrics, refresh usage, or modify settings.

Touching an encoder refreshes its data. Pressing a Claude or Codex encoder opens
    the corresponding provider page; Grok and NaN refresh on touch. Rotating the
    NaN dial selects a model; dashboard rotation includes only capped models returned
    by the API. **NaN Model Usage** is a standard keypad action: select one API-returned
    capped or uncapped model per key in its inspector and press the key to refresh the
    shared dashboard snapshot. If no dashboard session exists, import it explicitly from
    the existing NaN Usage dial. A transient dashboard failure keeps only the last dashboard
    quota as `STALE`; a rejected session returns to import onboarding without showing a prior
    account's quota.

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

The generated bundle is committed at
`com.barbatdev.ai-usage.sdPlugin/bin/plugin.js` so the plugin directory remains
self-contained.

## Data Access and Privacy

The plugin reuses existing local sessions; it does not provide a login flow or
store credentials in Stream Deck settings. Claude authentication remains inside
the installed Claude CLI. The plugin runs only its built-in `/usage` command
without tools or model inference and accepts only bounded JSON with affirmative
zero-inference telemetry and the two expected usage lines. It does not read
Claude credentials or call a private usage endpoint. Claude discovery uses only
the four absolute launcher paths listed under Requirements, resolves symlinks,
and checks target identity, ownership, permissions, and parent directories
again immediately before execution. Node on macOS does not expose `fexecve`, so
this minimizes but cannot eliminate the final check-to-exec race against a
same-UID attacker. Codex
authentication remains inside the local Codex CLI and its app server.
Experimental Grok authentication also remains inside the local Grok Build CLI;
the plugin sends only ACP initialization and billing requests. Dashboard session
cache data is stored through the dedicated local session store, never in Stream Deck
settings. The Chrome importer is invoked only by the inspector button, validates one
profile/store candidate at a time, and does not expose cookies, provider URLs, or
Safe Storage secrets in settings, feedback, or logs.

## NaN Dashboard Validation Status

The direct dashboard flow has focused mocked tests only. It still requires human
validation with a real authenticated Chrome profile and normal macOS permission
prompts, followed by the project's signing/release process. This checkout does not
claim production readiness, perform signing, restart Stream Deck, or deploy the
plugin.

Tokens, authorization headers, raw provider payloads, and CLI diagnostics are
not written to logs, settings, action feedback, or the property inspector. Usage
requests go directly through the official provider sessions, with no third-party
relay.

## Reporting Security Issues

If you discover a security vulnerability, please report it privately. See
[SECURITY.md](SECURITY.md) for details.

## Platform Support

The current manifest supports macOS only. Encoder actions target Stream Deck+;
NaN Model Usage and NaN Dashboard are also available as standard keypad actions.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
