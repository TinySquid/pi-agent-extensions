# @tinysquid/pi-opencode-go-usage

Shows OpenCode Go plan usage — rolling 5-hour, weekly, and monthly percentages and reset times — inside pi: a status line appended to the built-in footer (refreshed in the background) and a `/opencode-go` usage table. Usage data comes from opencode.ai's console API (`GET /console/api/go/status`), authenticated with your browser's `__Host-console_session` cookie and your workspace id.

> **0.2.0 — API migration.** opencode.ai replaced the dashboard page with an API. The old `auth` cookie no longer works; re-authenticate with `/opencode-go session-cookie` using the `__Host-console_session` cookie's `st_…` value. The old `auth-cookie` subcommand name is kept as an alias.

## Install

```bash
pi install npm:@tinysquid/pi-opencode-go-usage
```

For local development, symlink the extension directory (multi-file extensions must be loaded as a directory, not a single file):

```bash
ln -sfn $(pwd)/opencode-go-usage ~/.pi/agent/extensions/opencode-go-usage
```

## Screenshots

![Usage table widget](docs/opencode-go-ext-usage.png)

![Commands and config panel](docs/opencode-go-ext-commands.png)

## What it does

- Footer status line (via `ctx.ui.setStatus`, joined onto the built-in footer's extension-status line; the footer itself is never replaced): `OpenCode Go 5h 62% · wk 31% · mo 44%`, or with countdowns on: `OpenCode Go 5h 62% (1h12m) · wk 31% (3d4h) · mo 44% (12d0h)`. Percentages are colored: dim below 70%, warning at 70%+, error at 90%+.
- `/opencode-go` (or `/opencode-go usage`) — force-fetches and shows a bordered ASCII table widget above the editor with a usage bar, percentage, and reset countdown per window. `/opencode-go close` hides it.
- `/opencode-go workspace-id <id|url>` — sets the workspace (org) id, sent as the `x-org-id` header. Accepts a bare `wrk_…` id or a full dashboard URL (`https://opencode.ai/workspace/wrk_…/go` or `https://opencode.ai/console/wrk_…/go`); the id is extracted and validated.
- `/opencode-go session-cookie [value]` — sets the console session cookie. With no argument it prompts via an input dialog (recommended: inline slash-command text is persisted to session history, dialog input is not). The dialog is not masked. Accepts a bare `st_…` value, a `__Host-console_session=…` pair, or a full `Cookie:` header line containing the pair; stored normalized to the bare `st_…` id. The old `auth-cookie` spelling still works as an alias.
- `/opencode-go footer <on|off>` — toggles footer status visibility (no argument = toggle).
- `/opencode-go footer-stats <list>` — sets which periods the footer shows: `5h`, `weekly`, `monthly`, a comma list (`5hr,mo`), `all`, or `clear`/`none`. Aliases: `5h/5hr/rolling`, `weekly/wk/week`, `monthly/mo/month`. Stored in canonical order.
- `/opencode-go footer-reset-timer <on|off>` — toggles reset countdown timers in the footer (no argument = toggle). Default off.
- `/opencode-go refresh-interval <1-60>` — background refresh TTL in minutes. Default 3.
- `/opencode-go disconnect` — forgets workspace id + cookie (display settings kept). Warns if `OPENCODE_GO_*` env vars still supply credentials.
- `/opencode-go help` — command list + current config state as a widget.
- Subcommand and value autocomplete while typing the command. Typing just `/opencode-go` immediately offers the subcommand list (the extension wraps the autocomplete provider) — Tab or Enter picks a subcommand without needing a space first.
- Background refresh: a 30s timer fetches only when the cached data is older than the TTL; `turn_end` always refreshes (usage just changed); the `usage` command always fetches. Concurrent triggers share one in-flight request.
- On session start the extension loads the config, creates the default config file if missing, renders the footer immediately (last known state or a setup hint), and fetches without blocking startup.

## Configuration

Config file: `~/.pi/agent/opencode_go_usage_settings.json` (created with defaults, mode 0600, on first load; all writes are atomic tmp+rename at 0600):

```json
{
  "workspaceId": "",
  "sessionCookie": "",
  "footerEnabled": true,
  "footerPeriods": ["5h", "weekly", "monthly"],
  "footerCountdowns": false,
  "refreshMinutes": 3
}
```

- Env vars override the file: `OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_SESSION_COOKIE`. Commands that save a field warn when a matching env var takes precedence.
- Manual edits are validated per field; invalid values fall back to that field's default (never crash). `footerPeriods` accepts alias tokens; a non-array value falls back to all three. An empty array is valid and means "no periods in the footer". `refreshMinutes` is clamped to 1–60.
- Every setting is also managed by the commands above; the file is the escape hatch, not the primary interface.
- The `__Host-console_session` cookie is a browser session credential: the file is 0600, the recommended way to set it is the `/opencode-go session-cookie` prompt (keeps it out of session history files), and env vars are an alternative. Never commit it. Configs from pre-0.2.0 versions are migrated in place (`authCookie` → `sessionCookie`); the old `auth` cookie value is dead and must be replaced with the new session value.

## Behavior notes

- Unconfigured: the footer shows a dim hint `OpenCode Go: not configured · /opencode-go help` (suppressed when `footerEnabled` is false); `/opencode-go usage` shows setup instructions.
- Failure display: on fetch failure the footer keeps the last data with a `· stale` marker; if no data was ever fetched it shows the error (e.g. `OpenCode Go: session expired — set a fresh one with /opencode-go session-cookie`). The table shows `Stale — <error>` under the data.
- A 401/403 response, or a 200 whose JSON parses but carries no meters, is reported as an expired/invalid session cookie. A 200 with meters missing some window (e.g. no `month`) simply omits that row.
- The API reports usage in microcents; the extension converts to percentages and never displays dollar amounts. A schema change in the payload will surface as `no usage data in response — opencode.ai API may have changed`.
- Print mode (`pi -p`): `usage` and `help` print to stdout; UI-dependent features (footer, widgets, the cookie prompt) are inactive — pass the cookie as an argument instead.
- Requests go to `https://opencode.ai/console/api/go/status` with the session cookie, the `x-org-id` header, and a 20s timeout.
