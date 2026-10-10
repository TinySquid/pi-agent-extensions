# pi-agent-extensions

A collection of independently versioned [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extensions. This glossary covers terms shared across extensions; each extension's domain terms live here too.

**Interactive run**:
A pi run in TUI mode (`ctx.mode === "tui"`). The only mode auto-rename operates in. Includes `-c`/`-r` and an initial prompt that falls through to the TUI.
_Avoid_: Interactive mode (ambiguous about which layer), TUI session

**One-shot run**:
A pi run in print, JSON, or RPC mode. No naming — sessions in these runs are unnamed unless `--name` set one. Non-persisted (`--no-session`) runs are excluded too.
_Avoid_: Non-interactive, headless

**Naming run**:
The single naming attempt per fresh session: first prompt of the run through the naming model, then `setSessionName`. Never for an already-named session.
_Avoid_: Rename (implies overwriting an existing name)

## OpenCode Go usage

**Period**:
One of the three usage windows on the OpenCode Go plan: rolling 5h, weekly, monthly.
_Avoid_: Window (reserved for the dashboard payload — see Window key)

**Meter**:
One reading of one period: a percent (0–100) plus rollover time. Three meters per fetch, one per period.

**Footer**:
The one-line status line in pi's built-in footer, e.g. `go 5h 62% · wk 31%`.
_Avoid_: Status line

**Panel**:
The above-editor widget that `/opencode-go usage` and `help` render (usage table or command list). Shows a snapshot; does not live-update.
_Avoid_: Widget, popup, table

**Stale**:
Old data — displayed results come from a previous successful fetch.
_Avoid_: Outdated, expired
