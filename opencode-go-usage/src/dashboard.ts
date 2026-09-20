/**
 * Dashboard fetch + parse.
 *
 * opencode.ai publishes no usage API and serves no /api/*. The
 * /workspace/<wrk_…>/go page is a SolidStart app that serializes the resolved
 * values straight into the delivered HTML:
 *
 *   rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}
 *
 * The page is fetched with the browser `auth` cookie and the percentages +
 * reset times are read out of the markup. Percentages and countdowns only —
 * the page carries no dollar amounts.
 */

import { normalizeAuthCookie, normalizeWorkspaceId } from "./config.ts";

const ORIGIN = "https://opencode.ai";
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** One parsed usage window from the dashboard payload. */
export interface UsageMeter {
  period: import("./periods.ts").Period;
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

/** Window keys as they appear in the dashboard HTML hydration payload. */
const WINDOW_KEYS: { key: string; period: UsageMeter["period"] }[] = [
  { key: "rollingUsage", period: "5h" },
  { key: "weeklyUsage", period: "weekly" },
  { key: "monthlyUsage", period: "monthly" },
];

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

/** Parse the three usage windows out of the dashboard HTML. */
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

export function describeFailure(failure: unknown): string {
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
