# pi Agent Extensions

Custom extensions for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| `todo` | Todo list management with a live-syncing TUI widget. Supports add, toggle, clear actions. State is stored in tool result details for proper session branching. |
| `questionnaire` | Interactive single or multi-question prompts. Single questions show an options list; multiple questions use a tab bar for navigation. |
| `memory` | Persistent project memory across sessions. Reads `MEMORY.md` from the project root on session start and injects it into the system prompt. Provides `/remember` to summarize the current session into `MEMORY.md` with smart merging. |
| `glob` | Find files by glob pattern, sorted by modification time (newest first). Uses ripgrep for file discovery. Respects `.gitignore`, skips hidden files, returns absolute paths. |
| `list` | List directory contents with optional glob filtering. Shows files and directories with sizes. Non-recursive, respects `.gitignore`, skips hidden files. |

## Installation

Symlink individual extensions into `~/.pi/agent/extensions/`:

```bash
ln -s ~/dev/pi-agent-extensions/<name>.ts ~/.pi/agent/extensions/<name>.ts
```
