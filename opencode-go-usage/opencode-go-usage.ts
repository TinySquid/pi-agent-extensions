/**
 * OpenCode Go usage — footer status line + usage table for the OpenCode Go plan.
 *
 * opencode.ai publishes no usage API and serves no /api/*. The
 * /workspace/<wrk_…>/go page is a SolidStart app that serializes the resolved
 * values straight into the delivered HTML:
 *
 *   rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}
 *
 * This extension fetches that page with the browser `auth` cookie and reads
 * the percentages + reset times out of the markup. It reports percentages and
 * countdowns only — the page carries no dollar amounts.
 *
 * Variant 1: a footer status line (`go 5h 62% · wk 31% · mo 44%`) rendered via
 * ctx.ui.setStatus() on the built-in footer's extension-status line. The
 * built-in footer itself is never replaced.
 * Variant 2: `/opencode-go` (or `/opencode-go usage`) renders a usage table
 * widget above the editor, plus subcommands for setup and configuration.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const ORIGIN = "https://opencode.ai";
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CONFIG_FILE = "opencode_go_usage_settings.json";
const STATUS_KEY = "opencode-go";
const WIDGET_KEY = "opencode-go";

/** Interval that checks the cache TTL. Fetches only happen when the TTL passed. */
const TICK_MS = 30_000;

const PERIODS = ["5h", "weekly", "monthly"] as const;
type Period = (typeof PERIODS)[number];

const PERIOD_ALIASES: Record<string, Period> = {
  "5h": "5h",
  "5hr": "5h",
  rolling: "5h",
  weekly: "weekly",
  wk: "weekly",
  week: "weekly",
  monthly: "monthly",
  mo: "monthly",
  month: "monthly",
};

const PERIOD_LABEL: Record<Period, string> = {
  "5h": "Rolling 5h",
  weekly: "Weekly",
  monthly: "Monthly",
};

const PERIOD_SHORT: Record<Period, string> = {
  "5h": "5h",
  weekly: "wk",
  monthly: "mo",
};

/** Window keys as they appear in the dashboard HTML hydration payload. */
const WINDOW_KEYS: { key: string; period: Period }[] = [
  { key: "rollingUsage", period: "5h" },
  { key: "weeklyUsage", period: "weekly" },
  { key: "monthlyUsage", period: "monthly" },
];

interface Config {
  workspaceId: string;
  /** Empty = unset. Stored normalized (ready-to-use `Cookie` header value). */
  authCookie: string;
  footerEnabled: boolean;
  footerPeriods: Period[];
  footerCountdowns: boolean;
  refreshMinutes: number;
}

const DEFAULT_CONFIG: Config = {
  workspaceId: "",
  authCookie: "",
  footerEnabled: true,
  footerPeriods: ["5h", "weekly", "monthly"],
  footerCountdowns: false,
  refreshMinutes: 3,
};

/** One parsed usage window from the dashboard payload. */
export interface UsageMeter {
  period: Period;
  /** 0–100, clamped. May carry decimals (0.7 means 0.7%). */
  percent: number;
  /** ISO timestamp of rollover, or null when the window is not open. */
  resetsAt: string | null;
  status: "ok" | "error" | "unknown";
}

export type FetchFailure =
  | { kind: "timeout" }
  | { kind: "network"; detail: string }
  | { kind: "unauthorized" }
  | { kind: "http"; status: number }
  | { kind: "no-payload"; loginPage: boolean };

// ---------------------------------------------------------------------------
// Config file (~/.pi/agent/opencode_go_usage_settings.json, mode 0600)
// ---------------------------------------------------------------------------

function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function mergeConfig(raw: unknown): Config {
  const config: Config = { ...DEFAULT_CONFIG, footerPeriods: [...PERIODS] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;

  const r = raw as Record<string, unknown>;
  if (typeof r.workspaceId === "string")
    config.workspaceId = r.workspaceId.trim();
  if (typeof r.authCookie === "string") config.authCookie = r.authCookie.trim();
  if (typeof r.footerEnabled === "boolean")
    config.footerEnabled = r.footerEnabled;
  if (Array.isArray(r.footerPeriods)) {
    const mapped: Period[] = [];
    for (const token of r.footerPeriods) {
      if (typeof token === "string") {
        const period = PERIOD_ALIASES[token.trim().toLowerCase()];
        if (period && !mapped.includes(period)) mapped.push(period);
      }
    }
    config.footerPeriods = PERIODS.filter((p) => mapped.includes(p));
  }
  if (typeof r.footerCountdowns === "boolean")
    config.footerCountdowns = r.footerCountdowns;
  if (
    typeof r.refreshMinutes === "number" &&
    Number.isFinite(r.refreshMinutes) &&
    r.refreshMinutes > 0
  ) {
    config.refreshMinutes = Math.min(
      60,
      Math.max(1, Math.round(r.refreshMinutes)),
    );
  }
  return config;
}

async function loadConfig(): Promise<Config> {
  try {
    return mergeConfig(JSON.parse(await fs.readFile(configPath(), "utf8")));
  } catch {
    return mergeConfig(undefined);
  }
}

async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  const tmp = `${path}.tmp`;
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}

/** Create the default config file on first load so the schema is discoverable. */
async function ensureConfigFile(): Promise<void> {
  try {
    await fs.access(configPath());
  } catch {
    try {
      await saveConfig(mergeConfig(undefined));
    } catch (err) {
      console.error("[opencode-go] could not create default config:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Credential resolution (env vars win over the config file)
// ---------------------------------------------------------------------------

interface Credentials {
  workspaceId: string;
  authCookie: string;
}

function resolveCreds(config: Config): Credentials | null {
  const workspaceId = (
    process.env.OPENCODE_GO_WORKSPACE_ID ??
    config.workspaceId ??
    ""
  ).trim();
  const authCookie = (
    process.env.OPENCODE_GO_AUTH_COOKIE ??
    config.authCookie ??
    ""
  ).trim();
  return workspaceId && authCookie ? { workspaceId, authCookie } : null;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

/** Extract a `wrk_…` id from a bare id or a full dashboard URL. */
export function normalizeWorkspaceId(raw: string): string | null {
  const match = raw.match(/wrk_[A-Za-z0-9]+/);
  return match ? match[0] : null;
}

/**
 * Normalize user-provided auth into a ready-to-use `Cookie` header value.
 * Accepted: bare cookie value (`Fe26…`), `auth=…` pair, full multi-pair
 * header (`auth=x; other=y`), or a line prefixed with `Cookie:`.
 */
export function normalizeAuthCookie(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^cookie:\s*/i, "").trim();
  value = value.replace(/;\s*$/, "").trim();
  if (/^[A-Za-z0-9_-]+=.+/.test(value)) return value;
  return `auth=${value}`;
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

function workspaceUrl(workspaceId: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/go`;
}

function scriptBodies(html: string): string {
  const bodies: string[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    bodies.push(match[1] ?? "");
  }
  return bodies.join("\n");
}

function findObjectBody(haystack: string, key: string): string | null {
  // SolidStart hydration format: key:$R[N]={...} — also tolerate key:{...} and key={...}
  const pattern = new RegExp(
    `${key}(?:\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=?)?|\\s*=)?\\s*\\{([^{}]*)\\}`,
  );
  return pattern.exec(haystack)?.[1] ?? null;
}

function readNumber(body: string, field: string): number | null {
  const match = new RegExp(`${field}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readStatus(body: string): UsageMeter["status"] {
  const value = /status\s*:\s*"([^"]*)"/.exec(body)?.[1];
  return value === "ok" || value === "error" ? value : "unknown";
}

/** Parse the three usage windows out of the dashboard HTML. Exported for tests. */
export function parseWorkspaceHtml(
  html: string,
  now = Date.now(),
): UsageMeter[] {
  const haystack = scriptBodies(html) || html;
  const meters: UsageMeter[] = [];
  for (const { key, period } of WINDOW_KEYS) {
    const body = findObjectBody(haystack, key);
    if (body === null) continue;
    const percent = readNumber(body, "usagePercent");
    if (percent === null) continue;
    const resetInSec =
      readNumber(body, "resetInSec") ?? readNumber(body, "resetsInSeconds");
    meters.push({
      period,
      percent: Math.min(100, Math.max(0, percent)),
      resetsAt:
        resetInSec !== null && resetInSec > 0
          ? new Date(now + resetInSec * 1000).toISOString()
          : null,
      status: readStatus(body),
    });
  }
  return meters;
}

/** Fetch the dashboard page and parse it. Throws FetchFailure on any problem. */
export async function fetchUsage(
  workspaceId: string,
  authCookie: string,
  origin = ORIGIN,
): Promise<UsageMeter[]> {
  const url = workspaceUrl(
    normalizeWorkspaceId(workspaceId) ?? workspaceId,
    origin,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Cookie: normalizeAuthCookie(authCookie),
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw { kind: "timeout" } as FetchFailure;
    }
    throw {
      kind: "network",
      detail: err instanceof Error ? err.message : String(err),
    } as FetchFailure;
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    if (/auth|login|sign-?in/i.test(location)) {
      throw { kind: "unauthorized" } as FetchFailure;
    }
    throw { kind: "http", status: response.status } as FetchFailure;
  }
  if (response.status === 401 || response.status === 403) {
    throw { kind: "unauthorized" } as FetchFailure;
  }
  if (!response.ok)
    throw { kind: "http", status: response.status } as FetchFailure;

  const html = await response.text();
  const meters = parseWorkspaceHtml(html);
  if (meters.length === 0) {
    const loginPage = /\/auth\/authorize|sign\s?in to opencode/i.test(html);
    throw { kind: "no-payload", loginPage } as FetchFailure;
  }
  return meters;
}

function describeFailure(failure: unknown): string {
  const f = failure as FetchFailure;
  switch (f?.kind) {
    case "timeout":
      return "request timed out";
    case "network":
      return `network error: ${f.detail}`;
    case "unauthorized":
      return "cookie expired — set a fresh one with /opencode-go auth-cookie";
    case "http":
      return `HTTP ${f.status}`;
    case "no-payload":
      return f.loginPage
        ? "cookie expired — set a fresh one with /opencode-go auth-cookie"
        : "no usage data on page — opencode.ai markup may have changed";
    default:
      return failure instanceof Error ? failure.message : String(failure);
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "3d 4h" / "1h 12m" / "42m" / "resets now". Exported for tests. */
export function formatCountdown(
  resetsAt: string | null,
  now = Date.now(),
): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const ms = target - now;
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCountdownCompact(
  resetsAt: string | null,
  now = Date.now(),
): string | null {
  const countdown = formatCountdown(resetsAt, now);
  if (countdown === null || countdown === "resets now") return countdown;
  return countdown.replace(/\s+/g, "");
}

/** 42 → "42%", 0.7 → "0.7%", 62.5 → "62.5%". */
function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function bar(percent: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** ANSI SGR escape sequence (foreground/background color resets). */
const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

/** Visible length of a string after stripping ANSI SGR escape sequences. */
function visibleLength(text: string): number {
  return text.replace(ANSI_SGR_RE, "").length;
}

/** Pad `text` with trailing spaces so its visible width equals `width`. */
function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

// ---------------------------------------------------------------------------
// Theming (ctx.ui.theme exists at runtime but is not in the 0.84.x type defs)
// ---------------------------------------------------------------------------

function uiTheme(ui: ExtensionUIContext): Theme | undefined {
  return (ui as unknown as { theme?: Theme }).theme;
}

function colorPercent(
  theme: Theme | undefined,
  percent: number,
  text: string,
): string {
  if (!theme) return text;
  if (percent >= 90) return theme.fg("error", text);
  if (percent >= 70) return theme.fg("warning", text);
  return theme.fg("dim", text);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function opencodeGoUsage(pi: ExtensionAPI): void {
  let config: Config = { ...DEFAULT_CONFIG, footerPeriods: [...PERIODS] };
  let meters: UsageMeter[] = [];
  let lastFetchedAt = 0;
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ui: ExtensionUIContext | null = null;
  let hasUI = false;

  // --- Refresh engine ---

  async function doFetch(): Promise<void> {
    const creds = resolveCreds(config);
    if (!creds) {
      meters = [];
      lastError = null;
      lastFetchedAt = 0;
      renderFooter();
      return;
    }
    const workspaceId = normalizeWorkspaceId(creds.workspaceId);
    if (!workspaceId) {
      meters = [];
      lastError = "invalid workspace id (expected wrk_…)";
      renderFooter();
      return;
    }
    try {
      meters = await fetchUsage(workspaceId, creds.authCookie);
      lastFetchedAt = Date.now();
      lastError = null;
    } catch (err) {
      lastError = describeFailure(err); // keep meters — footer marks them stale
    }
    renderFooter();
  }

  /** Single-flight refresh: concurrent triggers reuse the running fetch. */
  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = doFetch().catch((err) => {
      console.error("[opencode-go] refresh failed:", err);
    });
    void inFlight.then(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function restartTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (
        lastFetchedAt === 0 ||
        Date.now() - lastFetchedAt >= config.refreshMinutes * 60_000
      ) {
        void refresh();
      }
    }, TICK_MS);
  }

  // --- Footer (variant 1) ---

  function footerText(theme: Theme | undefined): string | undefined {
    const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
    if (!config.footerEnabled) return undefined;
    if (!resolveCreds(config))
      return dim("OpenCode Go: not configured · /opencode-go help");
    if (meters.length === 0) {
      if (lastError)
        return theme
          ? theme.fg("warning", `OpenCode Go: ${lastError}`)
          : `OpenCode Go: ${lastError}`;
      return dim("OpenCode Go: loading…");
    }
    if (config.footerPeriods.length === 0) return undefined;

    const byPeriod = new Map(meters.map((m) => [m.period, m]));
    const parts: string[] = [];
    for (const period of config.footerPeriods) {
      const meter = byPeriod.get(period);
      if (!meter) continue;
      let part = `${dim(PERIOD_SHORT[period])} ${colorPercent(theme, meter.percent, formatPercent(meter.percent))}`;
      if (config.footerCountdowns) {
        const countdown = formatCountdownCompact(meter.resetsAt);
        if (countdown) part += dim(` (${countdown})`);
      }
      parts.push(part);
    }
    if (parts.length === 0) return dim("OpenCode Go: (no usage data)");
    let text = `${dim("OpenCode Go")} ${parts.join(dim(" · "))}`;
    if (lastError) text += dim(" · stale");
    return text;
  }

  function renderFooter(): void {
    if (!ui || !hasUI) return;
    ui.setStatus(STATUS_KEY, footerText(uiTheme(ui)));
  }

  // --- Usage table (variant 2) ---

  function tableLines(theme: Theme | undefined): string[] {
    const creds = resolveCreds(config);
    const title = `OpenCode Go Usage${creds ? ` — ${creds.workspaceId}` : ""}`;
    const lines: string[] = [theme ? theme.fg("accent", title) : title];

    if (!creds) {
      lines.push("Not configured. Set up with:");
      lines.push("  /opencode-go workspace-id <wrk_… or dashboard URL>");
      lines.push(
        "  /opencode-go auth-cookie    (prompts; keeps the cookie out of session history)",
      );
      lines.push(
        "Or export OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE.",
      );
      lines.push("/opencode-go close hides this panel");
      return lines;
    }
    if (meters.length === 0) {
      lines.push(lastError ? `Error: ${lastError}` : "Loading…");
      lines.push("/opencode-go close hides this panel");
      return lines;
    }

    const headers = ["Window", "Usage", "Resets in"];
    const rows = meters.map((meter) => {
      const label = PERIOD_LABEL[meter.period];
      const percent = formatPercent(meter.percent);
      const usage = `${bar(meter.percent)} ${percent}`;
      const usageColored = `${bar(meter.percent)} ${colorPercent(theme, meter.percent, percent)}`;
      const resets = formatCountdown(meter.resetsAt) ?? "—";
      return { label, usage, usageColored, resets };
    });

    const widths = [
      Math.max(headers[0].length, ...rows.map((r) => r.label.length)),
      Math.max(headers[1].length, ...rows.map((r) => r.usage.length)),
      Math.max(headers[2].length, ...rows.map((r) => r.resets.length)),
    ];
    const border = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
    const headerCells = headers.map((h, i) => padVisible(h, widths[i]));

    lines.push(border);
    lines.push(`| ${headerCells.join(" | ")} |`);
    lines.push(border);
    for (const row of rows) {
      const cells = [row.label, row.usageColored, row.resets].map((cell, i) =>
        padVisible(cell, widths[i]),
      );
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push(border);
    if (lastError) lines.push(`Stale — ${lastError}`);
    lines.push("/opencode-go close hides this panel");
    return lines;
  }

  function helpLines(theme: Theme | undefined): string[] {
    const creds = resolveCreds(config);
    const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
    const status = [
      creds ? `connected to ${creds.workspaceId}` : "not configured",
      `footer ${config.footerEnabled ? "on" : "off"}`,
      config.footerPeriods.length > 0
        ? config.footerPeriods.join("/")
        : "no periods",
      `reset timer ${config.footerCountdowns ? "on" : "off"}`,
      `refresh ${config.refreshMinutes}m`,
    ].join(" · ");
    const commands: [cmd: string, args: string, description: string][] = [
      ["usage", "", "show the usage table (default)"],
      ["workspace-id", "<id|url>", "set the workspace id"],
      ["auth-cookie", "[value]", "set the auth cookie (no arg = prompt)"],
      ["footer", "<on|off>", "footer status line visibility"],
      [
        "footer-stats",
        "<list>",
        "footer periods: 5h, weekly, monthly, all, clear",
      ],
      ["footer-reset-timer", "<on|off>", "reset countdown timer in the footer"],
      ["refresh-interval", "<1-60>", "background refresh TTL (minutes)"],
      ["disconnect", "", "forget workspace id + cookie"],
      ["close", "", "hide this panel"],
      ["help", "", "show commands + current config"],
    ];
    const commandWidth = Math.max(
      ...commands.map(([cmd, args]) => (args ? `${cmd} ${args}` : cmd).length),
    );
    return [
      theme
        ? theme.fg("accent", "OpenCode Go — commands")
        : "OpenCode Go — commands",
      ...commands.map(([cmd, args, description]) => {
        const left = args ? `${cmd} ${args}` : cmd;
        return `  ${left.padEnd(commandWidth)}  ${description}`;
      }),
      dim(`Status: ${status}`),
      dim(`Config: ${configPath()}`),
      dim("Env overrides: OPENCODE_GO_WORKSPACE_ID, OPENCODE_GO_AUTH_COOKIE"),
      "/opencode-go close hides this panel",
    ];
  }

  function showPanel(lines: string[], ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      console.log(lines.join("\n"));
      return;
    }
    if (ctx.mode === "tui") {
      // String-array widgets are capped at 10 lines in the interactive TUI;
      // render through the component factory so long panels (help) show fully.
      ctx.ui.setWidget(
        WIDGET_KEY,
        () => ({
          invalidate() {},
          render() {
            return lines;
          },
        }),
        { placement: "aboveEditor" },
      );
    } else {
      // RPC mode supports string arrays only — factory functions are ignored.
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    }
  }

  // --- Command ---

  const SUBCOMMANDS: { value: string; description: string }[] = [
    { value: "usage", description: "show the usage table (default)" },
    {
      value: "workspace-id",
      description: "set the workspace id (wrk_… or dashboard URL)",
    },
    {
      value: "auth-cookie",
      description: "set the auth cookie (no arg = prompt)",
    },
    { value: "footer", description: "footer status line on/off" },
    {
      value: "footer-stats",
      description: "footer periods: 5h, weekly, monthly, all, clear",
    },
    {
      value: "footer-reset-timer",
      description: "reset countdown timer in the footer on/off",
    },
    {
      value: "refresh-interval",
      description: "background refresh TTL in minutes (1-60)",
    },
    { value: "disconnect", description: "forget workspace id + cookie" },
    { value: "close", description: "hide the usage/help panel" },
    { value: "help", description: "show commands + current config" },
  ];

  function completions(
    argumentPrefix: string,
  ): { value: string; label: string; description?: string }[] {
    // pi replaces the ENTIRE argument prefix with `value`, so value
    // completions must carry the full argument text (subcommand included),
    // like the built-in /model and /thinking commands do.
    const trailingSpace = /\s$/.test(argumentPrefix);
    const parts = argumentPrefix.trim().split(/\s+/).filter(Boolean);
    const last = parts[parts.length - 1] ?? "";

    // Subcommand position (mid-token or empty): complete the subcommand name.
    if (!trailingSpace && parts.length <= 1) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(last)).map((s) => ({
        value: s.value,
        label: s.value,
        description: s.description,
      }));
    }

    // Value position.
    const sub = parts[0] ?? "";
    const prefix = trailingSpace || parts.length < 2 ? "" : last;
    let values: string[] = [];
    if (sub === "footer" || sub === "footer-reset-timer")
      values = ["on", "off"];
    if (sub === "footer-stats")
      values = ["5h", "weekly", "monthly", "all", "clear"];
    return values
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value: `${sub} ${value}`, label: value }));
  }

  function parseOnOff(raw: string | undefined): boolean | null | "invalid" {
    if (raw === undefined || raw === "") return null;
    const value = raw.toLowerCase();
    if (["on", "enabled", "true", "yes"].includes(value)) return true;
    if (["off", "disabled", "false", "no"].includes(value)) return false;
    return "invalid";
  }

  async function handleUsage(ctx: ExtensionCommandContext): Promise<void> {
    await refresh();
    showPanel(tableLines(uiTheme(ctx.ui)), ctx);
  }

  pi.registerCommand("opencode-go", {
    description:
      "OpenCode Go usage: table + footer status. Subcommands: usage, workspace-id, auth-cookie, footer, footer-stats, footer-reset-timer, refresh-interval, disconnect, close, help",
    getArgumentCompletions: completions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      hasUI = ctx.hasUI;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "usage";
      const rest = tokens.slice(1);

      try {
        switch (sub) {
          case "usage": {
            await handleUsage(ctx);
            return;
          }

          case "workspace-id": {
            const id = normalizeWorkspaceId(rest.join(" "));
            if (!id) {
              ctx.ui.notify(
                "Expected a wrk_… id or a dashboard URL like https://opencode.ai/workspace/wrk_…/go",
                "error",
              );
              return;
            }
            config.workspaceId = id;
            await saveConfig(config);
            if (process.env.OPENCODE_GO_WORKSPACE_ID) {
              ctx.ui.notify(
                `Saved ${id} — but OPENCODE_GO_WORKSPACE_ID is set and takes precedence`,
                "warning",
              );
            } else {
              ctx.ui.notify(`Workspace id saved: ${id}`, "info");
            }
            void refresh();
            return;
          }

          case "auth-cookie": {
            let value = rest.join(" ").trim();
            if (!value) {
              if (!ctx.hasUI) {
                ctx.ui.notify(
                  "Pass the cookie as an argument: /opencode-go auth-cookie <value>",
                  "error",
                );
                return;
              }
              value =
                (await ctx.ui.input(
                  "OpenCode Go auth cookie",
                  "value of the auth cookie from opencode.ai (not masked)",
                )) ?? "";
            }
            value = value.trim();
            if (!value) return;
            config.authCookie = normalizeAuthCookie(value);
            await saveConfig(config);
            if (process.env.OPENCODE_GO_AUTH_COOKIE) {
              ctx.ui.notify(
                "Cookie saved — but OPENCODE_GO_AUTH_COOKIE is set and takes precedence",
                "warning",
              );
            } else {
              ctx.ui.notify("Auth cookie saved", "info");
            }
            void refresh();
            return;
          }

          case "footer": {
            const parsed = parseOnOff(rest[0]);
            if (parsed === "invalid") {
              ctx.ui.notify("Usage: /opencode-go footer <on|off>", "error");
              return;
            }
            config.footerEnabled = parsed ?? !config.footerEnabled;
            await saveConfig(config);
            renderFooter();
            ctx.ui.notify(
              `Footer ${config.footerEnabled ? "enabled" : "disabled"}`,
              "info",
            );
            return;
          }

          case "footer-stats": {
            const spec = rest.join(" ").trim().toLowerCase();
            if (!spec) {
              ctx.ui.notify(
                `Footer periods: ${config.footerPeriods.join(", ") || "none"} — usage: /opencode-go footer-stats <5h|weekly|monthly|all|clear>`,
                "info",
              );
              return;
            }
            if (spec === "all") {
              config.footerPeriods = [...PERIODS];
            } else if (spec === "clear" || spec === "none") {
              config.footerPeriods = [];
            } else {
              const mapped: Period[] = [];
              const bad: string[] = [];
              for (const token of spec
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)) {
                const period = PERIOD_ALIASES[token];
                if (period) {
                  if (!mapped.includes(period)) mapped.push(period);
                } else {
                  bad.push(token);
                }
              }
              if (bad.length > 0) {
                ctx.ui.notify(
                  `Unknown period(s): ${bad.join(", ")} — valid: 5h, weekly, monthly, all, clear`,
                  "error",
                );
                return;
              }
              config.footerPeriods = PERIODS.filter((p) => mapped.includes(p));
            }
            await saveConfig(config);
            renderFooter();
            ctx.ui.notify(
              `Footer periods: ${config.footerPeriods.join(", ") || "none"}`,
              "info",
            );
            return;
          }

          case "footer-reset-timer": {
            const parsed = parseOnOff(rest[0]);
            if (parsed === "invalid") {
              ctx.ui.notify(
                "Usage: /opencode-go footer-reset-timer <on|off>",
                "error",
              );
              return;
            }
            config.footerCountdowns = parsed ?? !config.footerCountdowns;
            await saveConfig(config);
            renderFooter();
            ctx.ui.notify(
              `Footer reset timer ${config.footerCountdowns ? "on" : "off"}`,
              "info",
            );
            return;
          }

          case "refresh-interval": {
            const minutes = Number(rest[0]);
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
              ctx.ui.notify(
                "Usage: /opencode-go refresh-interval <1-60> (minutes)",
                "error",
              );
              return;
            }
            config.refreshMinutes = minutes;
            await saveConfig(config);
            restartTimer();
            ctx.ui.notify(`Background refresh TTL: ${minutes}m`, "info");
            return;
          }

          case "disconnect": {
            config.workspaceId = "";
            config.authCookie = "";
            await saveConfig(config);
            meters = [];
            lastError = null;
            lastFetchedAt = 0;
            renderFooter();
            if (resolveCreds(config)) {
              ctx.ui.notify(
                "Credentials cleared — OPENCODE_GO_* env vars still active",
                "warning",
              );
            } else {
              ctx.ui.notify(
                "Credentials cleared (display settings kept)",
                "info",
              );
            }
            return;
          }

          case "close": {
            if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
          }

          case "help": {
            showPanel(helpLines(uiTheme(ctx.ui)), ctx);
            return;
          }

          default: {
            ctx.ui.notify(
              `Unknown subcommand '${sub}' — try /opencode-go help`,
              "error",
            );
            return;
          }
        }
      } catch (err) {
        ctx.ui.notify(
          `opencode-go: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // --- Events ---

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI;
    config = await loadConfig();
    await ensureConfigFile();
    renderFooter(); // instant hint / previous state; fetch updates it
    restartTimer();
    void refresh(); // fire-and-forget: never block session startup
  });

  pi.on("turn_end", async () => {
    void refresh(); // always: usage just changed
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}
