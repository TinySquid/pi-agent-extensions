# @tinysquid/pi-memory

[![npm version](https://img.shields.io/npm/v/@tinysquid/pi-memory?style=flat-square)](https://www.npmjs.com/package/@tinysquid/pi-memory)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/TinySquid/pi-agent-extensions/blob/main/LICENSE)

> Persistent project memory for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

Give your agent a project brain. `MEMORY.md` lives at the project root and is injected into the system prompt on every session start, and the `/remember` command distills the current session back into it — decisions, preferences, and lessons that survive across sessions, projects, and model resets.

## How it works

```text
┌───────────────┐   session start   ┌─────────────────┐
│   MEMORY.md   │ ────────────────▶ │ system prompt   │
│ (project root)│                   └─────────────────┘
│               │   /remember       ┌─────────────────┐
│  Decisions    │ ◀──────────────── │ current session │
│  Preferences  │  (smart merge)    └─────────────────┘
│  Lessons      │
└───────────────┘
```

- **Session start** — walks up from the working directory to the project root (the first ancestor containing `.git`, `AGENTS.md`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `Gemfile`, or `CMakeLists.txt`), reads `MEMORY.md`, and injects the full content into the system prompt.
- **`/remember`** — feeds the current conversation (user/assistant messages plus any compaction summary) to the active model, extracts new decisions, preferences, and lessons, and merges them into `MEMORY.md`. The in-session memory is updated immediately, so the next turn already benefits.

## Install

```bash
pi install npm:@tinysquid/pi-memory
```

For local development:

```bash
ln -s $(pwd)/memory/memory.ts ~/.pi/agent/extensions/memory.ts
```

## Usage

1. Install the extension and start a coding session in your project.
2. Work with the agent — `MEMORY.md` (if present) is silently part of its context.
3. When you're happy with how things went, run:

   ```
   /remember
   ```

4. Review the diff, commit `MEMORY.md` alongside your code, and every future session starts with that knowledge.

> [!TIP]
> Commit `MEMORY.md` to your repository so the whole team — and every CI agent — shares the same project memory.

## Memory file

`MEMORY.md` lives at the project root and always keeps the same three sections, one terse line per entry:

```markdown
## Decisions

- Use pnpm workspaces, not npm
- Vitest over Jest for new tests

## Preferences

- Concise answers, no code comments unless asked

## Lessons

- pi extensions load .ts directly, no build step
```

> [!NOTE]
> Extracted entries are written in an ultra-terse "caveman" style on purpose: articles and filler are dropped, technical terms stay exact. Less noise in the prompt, more room for substance.

## Smart merge

`/remember` never blindly appends. Incoming entries go through a dedup pass before hitting the file:

- An entry that duplicates an existing one — substring match in either direction, or more than 70% shared words — is dropped.
- An entry prefixed with `[update]` replaces the existing entry it matches instead of adding a new line.
- Entries marked `_none_` by the model are ignored.

## Behavior notes

- Memory size is capped at **500 lines**. Going over triggers a model-driven compression pass; if compression fails, the uncompressed file is written anyway, and if it's still over the limit a warning asks for manual pruning.
- `/remember` needs a project root, a selected model, and a non-empty conversation — otherwise it notifies and does nothing.
- Extraction, merging, and compression all run with the session's active model; the LLM call honors `ctx.signal`, so aborting the session cancels it.
- Missing `MEMORY.md` is fine — the first `/remember` creates it.
