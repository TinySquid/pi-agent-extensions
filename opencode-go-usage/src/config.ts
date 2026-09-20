import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PERIODS, parsePeriodList, type Period } from "./periods.ts";

const CONFIG_FILE = "opencode_go_usage_settings.json";

export interface Config {
  workspaceId: string;
  /** Empty = unset. Stored normalized (ready-to-use `Cookie` header value). */
  authCookie: string;
  footerEnabled: boolean;
  footerPeriods: Period[];
  footerCountdowns: boolean;
  refreshMinutes: number;
}

export const DEFAULT_CONFIG: Config = {
  workspaceId: "",
  authCookie: "",
  footerEnabled: true,
  footerPeriods: [...PERIODS],
  footerCountdowns: false,
  refreshMinutes: 3,
};

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

export function configPath(): string {
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
    const { periods } = parsePeriodList(r.footerPeriods.join(","));
    config.footerPeriods = periods;
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

export async function loadConfig(): Promise<Config> {
  try {
    return mergeConfig(JSON.parse(await fs.readFile(configPath(), "utf8")));
  } catch {
    return mergeConfig(undefined);
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  const tmp = `${path}.tmp`;
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}

/** Create the default config file on first load so the schema is discoverable. */
export async function ensureConfigFile(): Promise<void> {
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

// env vars win over the config file.
export interface Credentials {
  workspaceId: string;
  authCookie: string;
}

export function resolveCreds(config: Config): Credentials | null {
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
