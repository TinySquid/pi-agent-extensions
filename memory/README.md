# @tinysquid/pi-memory

Persistent project memory for the pi coding agent: the project's `MEMORY.md` is injected into the system prompt, and `/remember` summarizes the current session back into it.

## Install

```bash
pi install npm:@tinysquid/pi-memory
```

For local development:

```bash
ln -s $(pwd)/memory/memory.ts ~/.pi/agent/extensions/memory.ts
```

## What it does

- **Session start**: walks up from the working directory to the project root — the first ancestor containing a marker (`.git`, `AGENTS.md`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `Gemfile`, `CMakeLists.txt`) — reads `MEMORY.md` from it, and injects the full content into the system prompt.
- **`/remember` command**: extracts decisions, preferences, and lessons from the current session (user/assistant messages plus any compaction summary) with the active model, merges them into `MEMORY.md`, and updates the in-session memory immediately.

## Behavior notes

- `MEMORY.md` uses three sections — **Decisions**, **Preferences**, **Lessons** — one terse line per entry; extraction writes caveman-style by design.
- Merging deduplicates: an entry that duplicates an existing one (substring either way, or >70% shared words) is dropped; an entry prefixed `[update]` replaces the entry it matches.
- Merged output over 500 lines triggers model-driven compression. If compression fails, the uncompressed file is written anyway; if it is still over the limit, a warning is shown.
- `/remember` needs a project root, a selected model, and a non-empty conversation — otherwise it notifies and does nothing.
- Extraction and compression both use the active session model.
