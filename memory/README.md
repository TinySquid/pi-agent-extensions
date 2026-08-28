# memory

Persistent project memory across sessions.

- On session start: reads `MEMORY.md` from the project root and injects it into the system prompt
- `/remember` command: summarizes the current session into `MEMORY.md` with smart merge

`MEMORY.md` sections: **Decisions**, **Preferences**, **Lessons**. Output is caveman full intensity (ultra-terse).

## Install

```bash
pi install npm:@tinysquid/pi-memory
```

Or for local development:

```bash
ln -s ~/dev/pi-agent-extensions/memory/memory.ts ~/.pi/agent/extensions/memory.ts
```
