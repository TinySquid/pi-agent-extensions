# @tinysquid/pi-auto-session-name

[![npm version](https://img.shields.io/npm/v/@tinysquid/pi-auto-session-name?style=flat-square)](https://www.npmjs.com/package/@tinysquid/pi-auto-session-name)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/TinySquid/pi-agent-extensions/blob/main/LICENSE)

> Never see `untitled-session` again — a cheap model names your [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) sessions for you

After the first turn, this extension takes your opening prompt, asks a small, configurable model to summarize it into a 3–8 word title, and sets it as the session name.

Without it, pi's `/resume` picker falls back to showing each session's raw first prompt — fine for a one-liner, useless when the opening message is a pasted stack trace, a long spec, or a skill invocation, since you only see a truncated fragment:

```text
TypeError: Cannot read properties of undefi…   42 3h
kitchen-sink Review the draft README and tell…  7 2d
```

With it, every session gets a short, searchable title instead:

```text
Fix WebSocket reconnect race                   42 3h
Debug flaky Vitest snapshot                     7 2d
```

## How it works

```text
┌─────────────────┐  first prompt   ┌────────────────┐
│  user's opening │ ──────────────▶ │  naming model  │
│  prompt         │                 │  (configurable)│
└─────────────────┘                 └───────┬────────┘
                                            │  3–8 word title
                    ┌───────────────────────▼────────┐
                    │ pi.setSessionName("Fix         │
                    │   WebSocket reconnect race")   │
                    └────────────────────────────────┘
```

- **When it fires** — once per session, on `agent_end` after the first turn, and only if the session has no name yet. Skill invocations at session start are ignored; `/reload` re-runs the extension but the existing-name guard prevents a second naming run.
- **Why a name** — named sessions are searchable in the `/resume` picker (and survive Ctrl+N's named-only filter), and the terminal title becomes `pi - <session name> - <cwd>` instead of just `pi - <cwd>`.
- **Model pick** — uses the model pinned in the config file. Without a config, it picks the cheapest available model by input token cost (respecting session model scoping via `enabledModels` / `--models`), falling back to the active session model.
- **Non-blocking** — in the interactive TUI, naming runs in the background so the prompt is never delayed. In one-shot modes (`-p`, `--json`), the turn ends slightly later while the name is generated.

## Install

```bash
pi install npm:@tinysquid/pi-auto-session-name
```

For local development:

```bash
ln -s $(pwd)/auto-session-name/auto-session-name.ts ~/.pi/agent/extensions/auto-session-name.ts
```

That's it — start a session, and after the first agent turn it gets a name. No commands, no flags.

## Configuration

Config file `~/.pi/agent/auto-session-name.json` pins the naming model and request options:

```json
{
  "provider": "google",
  "model": "gemma-4-26b-a4b-it",
  "temperature": 0.2,
  "thinking": "off"
}
```

- `provider`, `model` — pin the naming model (required keys).
- `temperature` — sampling temperature passed to the naming request as-is. Must be between 0 and 2; values outside that range (or non-numbers) are treated as malformed and repaired away. Omitted by default (provider default applies). Providers may drop it where they forbid it (Anthropic ignores it when thinking is enabled, and only accepts 0–1).
- `thinking` — reasoning level for the naming request: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Defaults to `"off"`. The level is clamped to what the model supports (model-specific level mappings are respected).

The file is read at naming time, so edits apply on the next session — no reload required. When a file is generated or repaired (see below), the rewrite is schema-normalizing: only `provider`, `model`, `temperature`, and `thinking` are kept, so any extra keys are dropped.

### Self-healing config

The config file repairs itself, with three levels of intervention:

| File state                                                         | What happens                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Missing                                                            | Generated on first use, pinning the default model pick (see above)             |
| Unusable (unparseable JSON, or missing/invalid `provider`/`model`) | Regenerated from the default pick, with a warning                              |
| Valid `provider`/`model`, but malformed `temperature`/`thinking`   | Those fields are dropped and the file is rewritten in place, keeping the model |
| Valid                                                              | Never overwritten                                                              |

Missing keys are simply left unset (defaults apply).

> [!TIP]
> The generated file is a starting point for your edits — pin a tiny, fast model like Gemma or a mini-tier model to keep naming cheap and instant.

> [!NOTE]
> A configured model that is unknown or has no configured credentials falls back to the default pick (with a warning).

## Behavior notes

- In the interactive TUI, quitting or switching sessions within the ~1–2s naming window loses the name (cosmetic; a warning is logged).
- Failures and config problems are logged to the terminal (`[auto-session-name] ...`), never surfaced in the UI.
- Titles are sanitized: surrounding quotes added by chatty models are stripped, and an empty response leaves the session unnamed rather than setting a garbage name.
