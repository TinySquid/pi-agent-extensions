# Pi Agent Extensions

Custom extensions for [Pi Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

| Extension           | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| [memory](./memory/) | Persistent project memory across sessions (MEMORY.md + `/remember`) |

Each extension lives in its own directory, with a README describing what it does.

## Installation

Symlink individual extensions into `~/.pi/agent/extensions/`:

```bash
ln -s ~/dev/pi-agent-extensions/<name>/<name>.ts ~/.pi/agent/extensions/<name>.ts
```
