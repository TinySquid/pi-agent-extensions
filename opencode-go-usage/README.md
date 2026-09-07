# @tinysquid/pi-opencode-go-usage

Shows OpenCode Go plan usage — rolling 5-hour, weekly, and monthly percentages and reset times — inside pi: a status line appended to the built-in footer (refreshed in the background) and a `/opencode-go` usage table. opencode.ai publishes no usage API, so the extension scrapes the authenticated `/workspace/<wrk_…>/go` dashboard page with your browser `auth` cookie. It also manages multiple OpenCode Go workspaces (one subscription each) and fails over to the next workspace's API key when the active one hits its quota.

## Install

```bash
pi install npm:@tinysquid/pi-opencode-go-usage
```

For local development:

```bash
ln -s $(pwd)/opencode-go-usage/opencode-go-usage.ts ~/.pi/agent/extensions/opencode-go-usage.ts
```

## Screenshots

![Usage table widget](docs/opencode-go-ext-usage.png)

![Commands and config panel](docs/opencode-go-ext-commands.png)

## What it does

- Footer status line (via `ctx.ui.setStatus`, joined onto the built-in footer's extension-status line; the footer itself is never replaced): `OpenCode Go 5h 62% · wk 31% · mo 44%`, or with countdowns on: `OpenCode Go 5h 62% (1h12m) · wk 31% (3d4h) · mo 44% (12d0h)`. Percentages are colored: dim below 70%, warning at 70%+, error at 90%+.
- `/opencode-go` (or `/opencode-go usage`) — force-fetches and shows a bordered ASCII table widget above the editor with a usage bar, percentage, and reset countdown per window. `/opencode-go close` hides it.
- `/opencode-go workspace add` — prompts for the workspace id (or dashboard URL) and the workspace's Go API key, then stores the pair in the config. Also accepts `/opencode-go workspace add <id|url> <api-key>` for non-interactive use (argument text lands in session history — prefer the prompts).
- `/opencode-go workspace select <id|#|url>` — makes a configured workspace active: writes its API key to pi's `auth.json` (`opencode-go` provider entry), points usage display at it, and clears its exhausted mark. Selecting an entry without a stored key switches display only and warns (provider auth untouched).
- `/opencode-go workspace list` — panel of configured workspaces: index, id, redacted key (`…last4`), which one is active, which are exhausted this session, and the failover state.
- `/opencode-go workspace remove <id|#|url>` — forgets a workspace. Removing the active one leaves usage display and provider auth unchanged.
- `/opencode-go workspace-id <id|url>` — legacy alias of `workspace select`; an unknown id gets a display-only entry so the old "just display this workspace" behavior survives.
- `/opencode-go failover <on|off>` — toggles automatic workspace failover on quota exhaustion (no argument = toggle). Default on.
- `/opencode-go auth-cookie [value]` — sets the auth cookie. With no argument it prompts via an input dialog (recommended: inline slash-command text is persisted to session history, dialog input is not). The dialog is not masked. Accepts a bare cookie value, an `auth=…` pair, a full `Cookie:` header line, or a multi-pair header; stored normalized. The cookie is global — it fetches usage for any workspace under the account.
- `/opencode-go footer <on|off>` — toggles footer status visibility (no argument = toggle).
- `/opencode-go footer-stats <list>` — sets which periods the footer shows: `5h`, `weekly`, `monthly`, a comma list (`5hr,mo`), `all`, or `clear`/`none`. Aliases: `5h/5hr/rolling`, `weekly/wk/week`, `monthly/mo/month`. Stored in canonical order.
- `/opencode-go footer-reset-timer <on|off>` — toggles reset countdown timers in the footer (no argument = toggle). Default off.
- `/opencode-go refresh-interval <1-60>` — background refresh TTL in minutes. Default 3.
- `/opencode-go disconnect` — forgets all workspaces, API keys, and the cookie (display settings kept). Provider auth in `auth.json` is left alone.
- `/opencode-go help` — command list + current config state as a widget.
- **Exhaustion failover** — when a model request dies with a Go subscription limit error (`GoUsageLimitError`, "Monthly usage limit reached"; transient 429s are ignored), the extension marks the active workspace exhausted in memory, walks the remaining configured workspaces in order, checks each candidate's usage (any window at 100% → skip it), and switches to the first one with capacity: writes its API key to pi's `auth.json`, moves usage display to it, and notifies "switched to <workspace> — resend your message". If no candidate survives the check (or none is configured), it notifies that all workspaces are exhausted. Exhausted marks are in-memory only: they reset on restart or a new session, there are no reset timers, and there is no automatic failback — switch back manually with `workspace select`, or let the cascade move on the next error.
- Subcommand and value autocomplete while typing the command. Typing just `/opencode-go` immediately offers the subcommand list (the extension wraps the autocomplete provider) — Tab or Enter picks a subcommand without needing a space first. `workspace select|remove` complete configured workspace ids.
- Background refresh: a 30s timer fetches only when the cached data is older than the TTL; `turn_end` always refreshes (usage just changed); the `usage` command always fetches. Concurrent triggers share one in-flight request.
- On session start the extension loads the config, migrates a pre-0.2.0 flat config automatically (see Configuration), creates the default config file if missing, renders the footer immediately (last known state or a setup hint), and fetches without blocking startup.

## Configuration

Config file: `~/.pi/agent/opencode_go_usage_settings.json` (created with defaults, mode 0600, on first load; all writes are atomic tmp+rename at 0600):

```json
{
  "workspaces": [{ "id": "wrk_…", "apiKey": "…" }],
  "failoverEnabled": true,
  "workspaceId": "wrk_…",
  "authCookie": "",
  "footerEnabled": true,
  "footerPeriods": ["5h", "weekly", "monthly"],
  "footerCountdowns": false,
  "refreshMinutes": 3
}
```

- `workspaces` — the failover candidate list, in cascade order. Each entry pairs a workspace id with that subscription's Go API key; an empty `apiKey` makes the entry display-only (never written to provider auth, never a failover candidate).
- `failoverEnabled` — gates the automatic cascade only; manual `workspace select` works regardless.
- `workspaceId` — the active workspace: the usage fetch target. `workspace select` and failover keep it in sync with the key written to pi's `auth.json`, so usage display always matches the billing key, including across restarts.
- `authCookie` — global; works for every workspace under the account.
- **Migration**: a pre-0.2.0 config (flat `workspaceId`, no `workspaces` key) is migrated in place on first load — the extension reads the existing `opencode-go` API key from pi's `auth.json`, pairs it with the configured workspace id as the first entry, and sets `failoverEnabled: true`. Everything else is preserved. Existing installs need no manual steps; add further workspaces with `workspace add`.
- pi's `auth.json` is read-merged, never clobbered: only the `opencode-go` entry is ever written; other providers' credentials are preserved. Writes are atomic tmp+rename at 0600.
- Env vars: `OPENCODE_GO_WORKSPACE_ID` pins a single workspace and opts out of the whole multi-workspace system — failover is disabled and `workspace add/select/remove` (and `workspace-id`, `failover`) refuse with an explanation until it is unset; `list`/`help` still show state. `OPENCODE_GO_AUTH_COOKIE` only overrides the fetch cookie; the workspace system keeps working (failover blind-switches if the cookie can't fetch).
- Manual edits are validated per field; invalid values fall back to that field's default (never crash). `workspaces` entries need a `wrk_…` id; malformed entries are dropped. `footerPeriods` accepts alias tokens; a non-array value falls back to all three. An empty array is valid and means "no periods in the footer". `refreshMinutes` is clamped to 1–60.
- Every setting is also managed by the commands above; the file is the escape hatch, not the primary interface.
- The `auth` cookie and workspace API keys are credentials: the file is 0600, the recommended way to set them is the prompts (keeps them out of session history files), and env vars are an alternative. Never commit them.

## Behavior notes

- Unconfigured: the footer shows a dim hint `OpenCode Go: not configured · /opencode-go help` (suppressed when `footerEnabled` is false); `/opencode-go usage` shows setup instructions.
- Failure display: on fetch failure the footer keeps the last data with a `· stale` marker; if no data was ever fetched it shows the error (e.g. `OpenCode Go: cookie expired — set a fresh one with /opencode-go auth-cookie`). The table shows `Stale — <error>` under the data.
- A 200 response can still be a login page; redirect-to-login, 401/403, and login markers in the HTML are all detected as an expired cookie. A page without the usage fields reports "opencode.ai markup may have changed" instead of showing a confident zero.
- The dashboard carries percentages and reset seconds only — no dollar amounts — so neither does the extension. `monthlyUsage` can be absent; that row is simply omitted.
- This is an HTML scrape of a SolidStart hydration payload (`rollingUsage:$R[N]={…usagePercent,resetInSec}`); a redesign of the opencode.ai dashboard will break parsing, and the extension will say so.
- Failover decision data comes from the same dashboard scrape as the display. If the cookie is dead or the fetch fails during a cascade, the extension blind-switches to the next candidate anyway — the next real request re-drives the logic if that workspace is also capped. Worst case after a restart with all workspaces still capped: two failed requests re-learn what the previous session knew (in-memory marks), then the all-exhausted message appears.
- Quota errors are detected from the failed turn's error message; pi treats these as non-retryable, so the turn has already failed when the switch happens — resend your message to continue on the new workspace. The switch takes effect on the next request without a restart.
- Multiple concurrent pi sessions share pi's `auth.json`, so a failover in one session switches billing for all of them immediately; other sessions' footers catch up on their next restart (display state is per-session).
- Print mode (`pi -p`): `usage`, `help`, and `workspace list` print to stdout; UI-dependent features (footer, widgets, the id/key prompts) are inactive — pass credentials as arguments instead. Failover notifications go to stdout.
- Requests go to `https://opencode.ai/workspace/<id>/go` with a browser User-Agent and a 20s timeout; redirects are followed manually to detect auth redirects.
