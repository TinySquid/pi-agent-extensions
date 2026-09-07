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
 * Variant 3: exhaustion failover across multiple OpenCode Go workspaces (each
 * holds one subscription, one API key). When a request dies with a Go quota
 * error the extension marks the current workspace exhausted in memory, checks
 * the remaining configured workspaces' usage, and switches the provider API
 * key (the `opencode-go` entry in pi's auth.json) to the first one under
 * 100%. In-memory only — no reset timers, no failback. Setting the
 * OPENCODE_GO_WORKSPACE_ID env var disables the whole workspace system.
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
const AUTH_FILE = "auth.json";
const STATUS_KEY = "opencode-go";
const WIDGET_KEY = "opencode-go";
/** pi provider id whose auth.json entry this extension manages. */
const PROVIDER_ID = "opencode-go";

/**
 * Subscription-quota errors (pi classifies these as non-retryable limits, so
 * the turn fails fast). Transient upstream 429s never match and are ignored.
 */
const QUOTA_ERROR_PATTERN = /GoUsageLimitError|Monthly usage limit reached/i;

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

interface WorkspaceEntry {
  id: string;
  /** Go API key for this workspace's subscription. Empty = not stored. */
  apiKey: string;
}

interface Config {
  /** Configured workspaces and their API keys (failover candidates, in order). */
  workspaces: WorkspaceEntry[];
  /** Auto-switch to the next workspace when a quota error hits. */
  failoverEnabled: boolean;
  /** Active workspace: usage fetch target; select/failover keep it in sync. */
  workspaceId: string;
  /** Empty = unset. Stored normalized (ready-to-use `Cookie` header value). */
  authCookie: string;
  footerEnabled: boolean;
  footerPeriods: Period[];
  footerCountdowns: boolean;
  refreshMinutes: number;
}

const DEFAULT_CONFIG: Config = {
  workspaces: [],
  failoverEnabled: true,
  workspaceId: "",
  authCookie: "",
  footerEnabled: true,
  footerPeriods: ["5h", "weekly", "monthly"],
  footerCountdowns: false,
  refreshMinutes: 3,
};

/** Sub-actions of the `workspace` subcommand (also used for completions). */
const WORKSPACE_ACTIONS: { value: string; description: string }[] = [
  { value: "add", description: "add a workspace + its API key (prompts)" },
  { value: "select", description: "switch the active workspace" },
  { value: "list", description: "show configured workspaces" },
  { value: "remove", description: "forget a workspace" },
];

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
// pi auth.json (read/write the opencode-go entry only — never other providers)
// ---------------------------------------------------------------------------

function authJsonPath(): string {
  return join(getAgentDir(), AUTH_FILE);
}

async function readProviderKey(providerId: string): Promise<string | null> {
  try {
    const data = JSON.parse(
      await fs.readFile(authJsonPath(), "utf8"),
    ) as Record<string, unknown>;
    const entry = data[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const e = entry as Record<string, unknown>;
    if (e.type !== "api_key" || typeof e.key !== "string") return null;
    const key = e.key.trim();
    // Command values ("!…") cannot be copied into the extension config.
    if (!key || key.startsWith("!")) return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * Replace only `providerId`'s credential in auth.json (read-merge-write so
 * other providers are preserved) with an atomic tmp+rename at 0600.
 */
async function writeProviderKey(
  providerId: string,
  apiKey: string,
): Promise<void> {
  const path = authJsonPath();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await fs.readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    data = {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  data[providerId] = { type: "api_key", key: apiKey };
  const tmp = `${path}.tmp`;
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}

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
  if (typeof r.failoverEnabled === "boolean")
    config.failoverEnabled = r.failoverEnabled;
  if (Array.isArray(r.workspaces)) {
    const entries: WorkspaceEntry[] = [];
    for (const item of r.workspaces) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      const id = typeof e.id === "string" ? normalizeWorkspaceId(e.id) : null;
      if (!id) continue;
      const apiKey = typeof e.apiKey === "string" ? e.apiKey.trim() : "";
      const existing = entries.find((entry) => entry.id === id);
      if (existing) {
        if (apiKey) existing.apiKey = apiKey;
      } else {
        entries.push({ id, apiKey });
      }
    }
    config.workspaces = entries;
  }
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
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(configPath(), "utf8"));
  } catch {
    return mergeConfig(undefined); // missing or corrupt: defaults, no migration
  }
  const config = mergeConfig(raw);
  // One-shot migration from the flat pre-0.2.0 format: pull the existing
  // opencode-go API key out of auth.json and pair it with the configured
  // workspace so existing installs land hands-free with workspace A mapped.
  if (!fileHasWorkspaces(raw) && (await migrateFlatConfig(raw, config))) {
    try {
      await saveConfig(config);
    } catch (err) {
      console.error("[opencode-go] could not save migrated config:", err);
    }
  }
  return config;
}

function fileHasWorkspaces(raw: unknown): boolean {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "workspaces" in raw,
  );
}

/** Returns true when the config was changed and should be persisted. */
async function migrateFlatConfig(
  raw: unknown,
  config: Config,
): Promise<boolean> {
  if (config.workspaces.length > 0) return false;
  const oldRawId = (raw as Record<string, unknown> | undefined)?.workspaceId;
  const oldId =
    typeof oldRawId === "string" ? normalizeWorkspaceId(oldRawId) : null;
  if (!oldId) return false;
  const key = await readProviderKey(PROVIDER_ID);
  if (!key) return false;
  config.workspaces = [{ id: oldId, apiKey: key }];
  return true;
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

/** OPENCODE_GO_WORKSPACE_ID pins a single workspace and opts out of the whole
 * multi-workspace system: failover off, workspace commands refuse. */
function workspacePinnedByEnv(): boolean {
  return Boolean(process.env.OPENCODE_GO_WORKSPACE_ID);
}

function workspaceSystemEnabled(config: Config): boolean {
  return config.failoverEnabled && !workspacePinnedByEnv();
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
  /** Workspace ids marked exhausted this session (in-memory only, reset on
   * restart / new session — no reset-timer tracking by design). */
  const exhaustedWorkspaces = new Set<string>();

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
    const failoverState = workspacePinnedByEnv()
      ? "off (env-pinned)"
      : config.failoverEnabled
        ? "on"
        : "off";
    const status = [
      creds ? `connected to ${creds.workspaceId}` : "not configured",
      `failover ${failoverState}`,
      `${config.workspaces.length} workspace(s)`,
      `footer ${config.footerEnabled ? "on" : "off"}`,
      config.footerPeriods.length > 0
        ? config.footerPeriods.join("/")
        : "no periods",
      `reset timer ${config.footerCountdowns ? "on" : "off"}`,
      `refresh ${config.refreshMinutes}m`,
    ].join(" · ");
    const commands: [cmd: string, args: string, description: string][] = [
      ["usage", "", "show the usage table (default)"],
      ["workspace add", "", "add a workspace + its API key (prompts)"],
      ["workspace select", "<id|#|url>", "switch the active workspace"],
      ["workspace list", "", "show configured workspaces"],
      ["workspace remove", "<id|#|url>", "forget a workspace"],
      ["workspace-id", "<id|url>", "alias of workspace select"],
      ["failover", "<on|off>", "auto-switch on quota exhaustion"],
      ["auth-cookie", "[value]", "set the auth cookie (no arg = prompt)"],
      ["footer", "<on|off>", "footer status line visibility"],
      [
        "footer-stats",
        "<list>",
        "footer periods: 5h, weekly, monthly, all, clear",
      ],
      ["footer-reset-timer", "<on|off>", "reset countdown timer in the footer"],
      ["refresh-interval", "<1-60>", "background refresh TTL (minutes)"],
      ["disconnect", "", "forget all workspaces + cookie"],
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

  // --- Workspace management + exhaustion failover ---

  function notifyCtx(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.log(`[opencode-go] ${message}`);
  }

  /** Env-pinned installs refuse the whole workspace system. */
  function requireWorkspaceSystem(ctx: ExtensionCommandContext): boolean {
    if (!workspacePinnedByEnv()) return true;
    ctx.ui.notify(
      "OPENCODE_GO_WORKSPACE_ID is set — the workspace system and failover are disabled. Unset it to use multiple workspaces.",
      "error",
    );
    return false;
  }

  /** Resolve `id | 1-based index | dashboard URL` to a configured entry. */
  function resolveWorkspaceRef(arg: string): WorkspaceEntry | null {
    const trimmed = arg.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      return config.workspaces[Number(trimmed) - 1] ?? null;
    }
    const id = normalizeWorkspaceId(trimmed);
    if (!id) return null;
    return config.workspaces.find((ws) => ws.id === id) ?? null;
  }

  async function addWorkspace(
    rest: string[],
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let id: string | null = null;
    let key: string;
    if (rest.length > 0) {
      // <id> <key> argument form (lands in session history — prompts are safer)
      id = normalizeWorkspaceId(rest[0] ?? "");
      key = rest.slice(1).join(" ").trim();
      if (!id) {
        ctx.ui.notify(
          "Expected a wrk_… id or dashboard URL: /opencode-go workspace add <id|url> [api-key]",
          "error",
        );
        return;
      }
      if (!key && ctx.hasUI) {
        key =
          (await ctx.ui.input(`API key for ${id}`, "OpenCode Go API key")) ??
          "";
      }
    } else if (ctx.hasUI) {
      const raw = await ctx.ui.input(
        "OpenCode Go workspace",
        "workspace id (wrk_…) or dashboard URL",
      );
      if (!raw) return; // cancelled
      id = normalizeWorkspaceId(raw);
      if (!id) {
        ctx.ui.notify("That is not a wrk_… id or dashboard URL", "error");
        return;
      }
      key =
        (await ctx.ui.input(`API key for ${id}`, "OpenCode Go API key")) ?? "";
    } else {
      ctx.ui.notify(
        "Pass id and key: /opencode-go workspace add <id|url> <api-key>",
        "error",
      );
      return;
    }
    if (!id) return;
    const existing = config.workspaces.find((ws) => ws.id === id);
    if (existing) {
      if (key) existing.apiKey = key.trim();
      await saveConfig(config);
      ctx.ui.notify(
        key
          ? `Workspace updated: ${id}`
          : `Workspace kept: ${id} (no key entered)`,
        "info",
      );
      return;
    }
    config.workspaces.push({ id, apiKey: key.trim() });
    await saveConfig(config);
    ctx.ui.notify(
      key
        ? `Workspace added: ${id}`
        : `Workspace added without API key: ${id} (display-only until a key is set)`,
      "info",
    );
  }

  async function selectWorkspace(
    entry: WorkspaceEntry,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    config.workspaceId = entry.id;
    exhaustedWorkspaces.delete(entry.id); // explicit intent beats the heuristic
    meters = [];
    lastFetchedAt = 0;
    lastError = null;
    if (entry.apiKey) {
      await writeProviderKey(PROVIDER_ID, entry.apiKey);
      await saveConfig(config);
      renderFooter();
      ctx.ui.notify(
        `Active workspace: ${entry.id} — API key written to pi auth; usage refreshes next`,
        "info",
      );
    } else {
      await saveConfig(config);
      renderFooter();
      ctx.ui.notify(
        `${entry.id} is active for usage display — no API key stored, provider auth untouched`,
        "warning",
      );
    }
    void refresh();
  }

  function workspaceListLines(theme: Theme | undefined): string[] {
    const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
    const lines = [
      theme
        ? theme.fg("accent", "OpenCode Go — workspaces")
        : "OpenCode Go — workspaces",
    ];
    if (config.workspaces.length === 0) {
      lines.push("No workspaces configured.");
      lines.push("Add one with /opencode-go workspace add");
    } else {
      config.workspaces.forEach((ws, i) => {
        const bits = [
          `${i + 1}. ${ws.id}`,
          ws.apiKey ? `key …${ws.apiKey.slice(-4)}` : "no api key",
        ];
        if (ws.id === config.workspaceId) bits.push("← active");
        if (exhaustedWorkspaces.has(ws.id))
          bits.push("(exhausted this session)");
        lines.push("  " + bits.join("  "));
      });
    }
    const gate = workspacePinnedByEnv()
      ? "disabled — OPENCODE_GO_WORKSPACE_ID is set"
      : config.failoverEnabled
        ? "on"
        : "off";
    lines.push(dim(`Failover: ${gate} · exhausted marks reset on restart`));
    lines.push("/opencode-go close hides this panel");
    return lines;
  }

  async function doFailover(ctx: ExtensionContext): Promise<void> {
    if (!workspaceSystemEnabled(config)) return;
    const current = config.workspaceId;
    if (current) exhaustedWorkspaces.add(current);

    const cookie = resolveCreds(config)?.authCookie ?? "";
    const candidates = config.workspaces.filter(
      (ws) => ws.apiKey && ws.id !== current && !exhaustedWorkspaces.has(ws.id),
    );
    if (candidates.length === 0) {
      notifyCtx(
        ctx,
        config.workspaces.some((ws) => ws.apiKey)
          ? "OpenCode Go: all workspaces exhausted — resend once a usage window resets"
          : "OpenCode Go: usage limit hit and no other workspace has an API key — add one with /opencode-go workspace add",
        "error",
      );
      return;
    }
    for (const ws of candidates) {
      // Best-effort usage check via the dashboard cookie; on fetch failure
      // switch anyway — the next real error re-drives the cascade.
      if (cookie) {
        try {
          const candidateMeters = await fetchUsage(ws.id, cookie);
          if (candidateMeters.some((meter) => meter.percent >= 100)) {
            exhaustedWorkspaces.add(ws.id);
            continue;
          }
        } catch {
          // blind-switch
        }
      }
      await writeProviderKey(PROVIDER_ID, ws.apiKey);
      config.workspaceId = ws.id;
      exhaustedWorkspaces.delete(ws.id);
      await saveConfig(config);
      meters = [];
      lastFetchedAt = 0;
      lastError = null;
      renderFooter();
      notifyCtx(
        ctx,
        `OpenCode Go: quota exhausted on ${current || "workspace"} — switched to ${ws.id}. Resend your message.`,
        "info",
      );
      void refresh();
      return;
    }
    notifyCtx(
      ctx,
      "OpenCode Go: all workspaces exhausted — resend once a usage window resets",
      "error",
    );
  }

  let failoverInFlight: Promise<void> | null = null;

  function handleQuotaExhaustion(ctx: ExtensionContext): Promise<void> {
    if (failoverInFlight) return failoverInFlight;
    failoverInFlight = doFailover(ctx)
      .catch((err) => {
        console.error("[opencode-go] failover failed:", err);
      })
      .finally(() => {
        failoverInFlight = null;
      });
    return failoverInFlight;
  }

  // --- Command ---

  const SUBCOMMANDS: { value: string; description: string }[] = [
    { value: "usage", description: "show the usage table (default)" },
    {
      value: "workspace",
      description: "workspaces: add / select / list / remove",
    },
    {
      value: "workspace-id",
      description: "alias of workspace select (wrk_… or dashboard URL)",
    },
    {
      value: "failover",
      description: "auto-switch workspace on quota exhaustion on/off",
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
    { value: "disconnect", description: "forget all workspaces + cookie" },
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

    // Value position. tokenIndex = 0-based index of the token being typed.
    const tokenIndex = trailingSpace ? parts.length : parts.length - 1;
    const sub = parts[0] ?? "";
    const prefix = trailingSpace ? "" : last;
    let values: { value: string; description?: string }[] = [];
    if (tokenIndex === 1) {
      if (
        sub === "footer" ||
        sub === "footer-reset-timer" ||
        sub === "failover"
      )
        values = ["on", "off"].map((v) => ({ value: v }));
      if (sub === "footer-stats")
        values = ["5h", "weekly", "monthly", "all", "clear"].map((v) => ({
          value: v,
        }));
      if (sub === "workspace") values = WORKSPACE_ACTIONS;
    } else if (tokenIndex === 2 && sub === "workspace") {
      if (parts[1] === "select" || parts[1] === "remove") {
        values = config.workspaces.map((ws) => ({
          value: ws.id,
          description: ws.apiKey ? `key …${ws.apiKey.slice(-4)}` : "no api key",
        }));
      }
    }
    const head = parts.slice(0, tokenIndex).join(" ");
    return values
      .filter((v) => v.value.startsWith(prefix))
      .map((v) => ({
        value: head ? `${head} ${v.value}` : v.value,
        label: v.value,
        description: v.description,
      }));
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
      "usage · workspace · failover · workspace-id · auth-cookie · footer · footer-stats · footer-reset-timer · refresh-interval · disconnect · close · help",
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

          case "workspace": {
            const action = (rest[0] ?? "").toLowerCase();
            const actionRest = rest.slice(1);
            switch (action) {
              case "add":
                if (!requireWorkspaceSystem(ctx)) return;
                await addWorkspace(actionRest, ctx);
                return;
              case "select": {
                if (!requireWorkspaceSystem(ctx)) return;
                const entry = resolveWorkspaceRef(actionRest.join(" "));
                if (!entry) {
                  ctx.ui.notify(
                    "Unknown workspace — add it first with /opencode-go workspace add",
                    "error",
                  );
                  return;
                }
                await selectWorkspace(entry, ctx);
                return;
              }
              case "list": {
                showPanel(workspaceListLines(uiTheme(ctx.ui)), ctx);
                return;
              }
              case "remove": {
                if (!requireWorkspaceSystem(ctx)) return;
                const entry = resolveWorkspaceRef(actionRest.join(" "));
                if (!entry) {
                  ctx.ui.notify(
                    "Unknown workspace — see /opencode-go workspace list",
                    "error",
                  );
                  return;
                }
                config.workspaces = config.workspaces.filter(
                  (ws) => ws !== entry,
                );
                await saveConfig(config);
                ctx.ui.notify(
                  `Workspace removed: ${entry.id}${
                    entry.id === config.workspaceId
                      ? " (still the active workspace — usage display unchanged)"
                      : ""
                  }`,
                  "info",
                );
                return;
              }
              default:
                ctx.ui.notify(
                  "Usage: /opencode-go workspace <add|select|list|remove>",
                  "error",
                );
                return;
            }
          }

          case "workspace-id": {
            // Legacy alias of workspace select; unknown ids get a display-only
            // entry so the old "just display this workspace" behavior survives.
            if (!requireWorkspaceSystem(ctx)) return;
            const id = normalizeWorkspaceId(rest.join(" "));
            if (!id) {
              ctx.ui.notify(
                "Expected a wrk_… id or a dashboard URL like https://opencode.ai/workspace/wrk_…/go",
                "error",
              );
              return;
            }
            let entry = config.workspaces.find((ws) => ws.id === id);
            if (!entry) {
              entry = { id, apiKey: "" };
              config.workspaces.push(entry);
            }
            await selectWorkspace(entry, ctx);
            return;
          }

          case "failover": {
            if (!requireWorkspaceSystem(ctx)) return;
            const parsed = parseOnOff(rest[0]);
            if (parsed === "invalid") {
              ctx.ui.notify("Usage: /opencode-go failover <on|off>", "error");
              return;
            }
            config.failoverEnabled = parsed ?? !config.failoverEnabled;
            await saveConfig(config);
            ctx.ui.notify(
              `Exhaustion failover ${config.failoverEnabled ? "enabled" : "disabled"}`,
              "info",
            );
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
            config.workspaces = [];
            config.workspaceId = "";
            config.authCookie = "";
            exhaustedWorkspaces.clear();
            await saveConfig(config);
            meters = [];
            lastError = null;
            lastFetchedAt = 0;
            renderFooter();
            if (workspacePinnedByEnv() || process.env.OPENCODE_GO_AUTH_COOKIE) {
              ctx.ui.notify(
                "Workspaces, API keys, and cookie cleared — OPENCODE_GO_* env vars still active",
                "warning",
              );
            } else {
              ctx.ui.notify(
                "Workspaces, API keys, and cookie cleared (display settings kept)",
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

  // --- Autocomplete hint: offer the subcommand list at the bare command ---
  //
  // pi queries argument completions only once a space follows the command
  // name. With exactly "/opencode-go" typed, it instead offers a single
  // "complete the command name" entry, and Tab just completes the name and
  // closes the popup. Wrap the autocomplete provider so the subcommand list
  // is offered the moment the bare command is typed.

  let subcommandAutocompleteInstalled = false;

  function installSubcommandAutocomplete(ctx: ExtensionContext): void {
    if (subcommandAutocompleteInstalled || ctx.mode !== "tui") return;
    subcommandAutocompleteInstalled = true;
    try {
      ctx.ui.addAutocompleteProvider((current) => {
        // Identity set of the items we produce, so applyCompletion can tell our
        // items apart from the wrapped provider's even when values/descriptions
        // coincide.
        const ourItems = new Set<{
          value: string;
          label: string;
          description?: string;
        }>();
        return {
          triggerCharacters: current.triggerCharacters,
          async getSuggestions(lines, cursorLine, cursorCol, _options) {
            const line = lines[cursorLine] ?? "";
            const beforeCursor = line.slice(0, cursorCol);
            if (/^\/opencode-go$/.test(beforeCursor)) {
              const items = SUBCOMMANDS.map((s) => ({
                value: s.value,
                label: s.value,
                description: s.description,
              }));
              for (const item of items) ourItems.add(item);
              return { items, prefix: beforeCursor };
            }
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              _options,
            );
          },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            if (ourItems.has(item)) {
              const currentLine = lines[cursorLine] ?? "";
              const beforePrefix = currentLine.slice(
                0,
                cursorCol - prefix.length,
              );
              const afterCursor = currentLine.slice(cursorCol);
              const replacement = `/opencode-go ${item.value}`;
              const newLines = [...lines];
              newLines[cursorLine] = beforePrefix + replacement + afterCursor;
              return {
                lines: newLines,
                cursorLine,
                cursorCol: beforePrefix.length + replacement.length,
              };
            }
            return current.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          },
          shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true,
        };
      });
    } catch (err) {
      subcommandAutocompleteInstalled = false;
      console.error(
        "[opencode-go] could not install subcommand autocomplete:",
        err,
      );
    }
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI;
    installSubcommandAutocomplete(ctx);
    config = await loadConfig();
    await ensureConfigFile();
    exhaustedWorkspaces.clear(); // per-session state, by design
    renderFooter(); // instant hint / previous state; fetch updates it
    restartTimer();
    void refresh(); // fire-and-forget: never block session startup
  });

  // Reactive exhaustion failover: pi classifies Go quota errors as
  // non-retryable, so the turn fails fast — switch the key now and let the
  // user resend onto the new workspace.
  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const message = event.messages[i];
      if (message.role !== "assistant") continue;
      if (message.stopReason !== "error" || !message.errorMessage) continue;
      if (!QUOTA_ERROR_PATTERN.test(message.errorMessage)) continue;
      await handleQuotaExhaustion(ctx);
      return;
    }
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
