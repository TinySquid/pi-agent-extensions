# @tinysquid/pi-auto-session-name

Auto-generates short, descriptive names for pi coding agent sessions. After the first turn, the extension asks a cheap model to summarize the opening prompt into a 3–8 word title and sets it as the session name.

## Install

```bash
pi install npm:@tinysquid/pi-auto-session-name
```

## How it picks a model

1. **Config file** (optional): create `~/.pi/agent/auto-session-name.json` to pin a model:

   ```json
   { "provider": "google", "model": "gemma-4-31b-it" }
   ```

2. **Default**: the cheapest available model (by input token cost), respecting any session model scoping (`enabledModels` / `--models`). Falls back to the active session model.

## Behavior notes

- In the interactive TUI, naming runs in the background — the prompt is never delayed. (Quitting or switching sessions within the ~1-2s naming window loses the name.) In one-shot modes (`-p`, `--json`), the turn ends slightly later while the name is generated.
- Only fires once per session, only if the session has no name yet.
- Failures are skipped and logged to the terminal (`[auto-session-name] ...`), never surfaced in the UI.
- The config file is read at naming time, so edits apply on the next session — no restart needed.
- A configured model that doesn't exist or has no configured credentials falls back to the default pick (with a warning).
