# @tinysquid/pi-auto-session-name

Auto-generates short, descriptive names for pi coding agent sessions: after the first turn, a (configurable) model summarizes the opening prompt into a 3–8 word title and sets it as the session name.

## Install

```bash
pi install npm:@tinysquid/pi-auto-session-name
```

For local development:

```bash
ln -s $(pwd)/auto-session-name/auto-session-name.ts ~/.pi/agent/extensions/auto-session-name.ts
```

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

- `provider`, `model` — pin the naming model (see below).
- `temperature` — sampling temperature passed to the naming request as-is. Omitted by default (provider default applies).
- `thinking` — reasoning level for the naming request: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Defaults to `"off"`.

If no config file exists, one is generated on first use, pinning the cheapest available model by input token cost, respecting session model scoping (`enabledModels` / `--models`); if none, the active session model is used. An existing file is never overwritten.

A configured model that is unknown or has no configured credentials falls back to the default pick (with a warning). A config file that can't be parsed is likewise ignored with a warning and left untouched. A malformed `temperature` or `thinking` value is ignored with a warning; the rest of the config still applies.

## Behavior notes

- In the interactive TUI, naming runs in the background so the prompt is never delayed. Quitting or switching sessions within the ~1–2s naming window loses the name. In one-shot modes (`-p`, `--json`), the turn ends slightly later while the name is generated.
- Fires at most once per session, and only if the session has no name yet.
- Failures are logged to the terminal (`[auto-session-name] ...`), never surfaced in the UI.
