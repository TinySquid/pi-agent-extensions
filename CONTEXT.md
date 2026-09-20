# pi-agent-extensions

A collection of independently versioned [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extensions. This glossary covers terms shared across extensions; each extension's domain terms live here too.

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
