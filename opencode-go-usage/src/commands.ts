import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { normalizeAuthCookie, normalizeWorkspaceId } from "./config.ts";
import { uiTheme } from "./format.ts";
import { closePanel, helpLines, showPanel, tableLines } from "./panel.ts";
import {
  PERIODS,
  PERIOD_ALIASES,
  completeSubcommandValues,
  type Period,
} from "./periods.ts";
import type { UsageStore } from "./state.ts";

interface Subcommand {
  value: string;
  args: string;
  description: string;
  helpDescription: string;
}

/** One table drives the command description, completions, and the help panel. */
export const SUBCOMMANDS: Subcommand[] = [
  {
    value: "usage",
    args: "",
    description: "show the usage table (default)",
    helpDescription: "show the usage table (default)",
  },
  {
    value: "workspace-id",
    args: "<id|url>",
    description: "set the workspace id (wrk_… or dashboard URL)",
    helpDescription: "set the workspace id",
  },
  {
    value: "auth-cookie",
    args: "[value]",
    description: "set the auth cookie (no arg = prompt)",
    helpDescription: "set the auth cookie (no arg = prompt)",
  },
  {
    value: "footer",
    args: "<on|off>",
    description: "footer status line on/off",
    helpDescription: "footer status line visibility",
  },
  {
    value: "footer-stats",
    args: "<list>",
    description: "footer periods: 5h, weekly, monthly, all, clear",
    helpDescription: "footer periods: 5h, weekly, monthly, all, clear",
  },
  {
    value: "footer-reset-timer",
    args: "<on|off>",
    description: "reset countdown timer in the footer on/off",
    helpDescription: "reset countdown timer in the footer",
  },
  {
    value: "refresh-interval",
    args: "<1-60>",
    description: "background refresh TTL in minutes (1-60)",
    helpDescription: "background refresh TTL (minutes)",
  },
  {
    value: "disconnect",
    args: "",
    description: "forget workspace id + cookie",
    helpDescription: "forget workspace id + cookie",
  },
  {
    value: "close",
    args: "",
    description: "hide the usage/help panel",
    helpDescription: "hide this panel",
  },
  {
    value: "help",
    args: "",
    description: "show commands + current config",
    helpDescription: "show commands + current config",
  },
];

/** Mutable UI holder shared with the composition root's footer subscription. */
export interface UiRef {
  ui: import("@earendil-works/pi-coding-agent").ExtensionUIContext | null;
  hasUI: boolean;
}

function parseOnOff(raw: string | undefined): boolean | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  const value = raw.toLowerCase();
  if (["on", "enabled", "true", "yes"].includes(value)) return true;
  if (["off", "disabled", "false", "no"].includes(value)) return false;
  return "invalid";
}

/** Argument completions for /opencode-go (pi replaces the whole prefix with `value`). */
export function completions(
  argumentPrefix: string,
): { value: string; label: string; description?: string }[] {
  // Subcommand position (mid-token or empty): complete the subcommand name.
  const parts = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (!/\s$/.test(argumentPrefix) && parts.length <= 1) {
    return SUBCOMMANDS.filter((s) => s.value.startsWith(last)).map((s) => ({
      value: s.value,
      label: s.value,
      description: s.description,
    }));
  }
  // Value position.
  const sub = parts[0] ?? "";
  return completeSubcommandValues(sub, argumentPrefix);
}

export function registerOpencodeGoCommand(
  pi: ExtensionAPI,
  store: UsageStore,
  uiRef: UiRef,
): void {
  pi.registerCommand("opencode-go", {
    description:
      "usage · workspace-id · auth-cookie · footer · footer-stats · footer-reset-timer · refresh-interval · disconnect · close · help",
    getArgumentCompletions: completions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      uiRef.ui = ctx.ui;
      uiRef.hasUI = ctx.hasUI;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "usage";
      const rest = tokens.slice(1);

      try {
        switch (sub) {
          case "usage": {
            await store.refresh();
            showPanel(tableLines(store, uiTheme(ctx.ui)), ctx);
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
            await store.setWorkspaceId(id);
            if (process.env.OPENCODE_GO_WORKSPACE_ID) {
              ctx.ui.notify(
                `Saved ${id} — but OPENCODE_GO_WORKSPACE_ID is set and takes precedence`,
                "warning",
              );
            } else {
              ctx.ui.notify(`Workspace id saved: ${id}`, "info");
            }
            void store.refresh();
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
            await store.setAuthCookie(normalizeAuthCookie(value));
            if (process.env.OPENCODE_GO_AUTH_COOKIE) {
              ctx.ui.notify(
                "Cookie saved — but OPENCODE_GO_AUTH_COOKIE is set and takes precedence",
                "warning",
              );
            } else {
              ctx.ui.notify("Auth cookie saved", "info");
            }
            void store.refresh();
            return;
          }

          case "footer": {
            const parsed = parseOnOff(rest[0]);
            if (parsed === "invalid") {
              ctx.ui.notify("Usage: /opencode-go footer <on|off>", "error");
              return;
            }
            await store.setFooterEnabled(parsed);
            ctx.ui.notify(
              `Footer ${store.current.footerEnabled ? "enabled" : "disabled"}`,
              "info",
            );
            return;
          }

          case "footer-stats": {
            const spec = rest.join(" ").trim().toLowerCase();
            if (!spec) {
              ctx.ui.notify(
                `Footer periods: ${store.current.footerPeriods.join(", ") || "none"} — usage: /opencode-go footer-stats <5h|weekly|monthly|all|clear>`,
                "info",
              );
              return;
            }
            if (spec === "all") {
              await store.setFooterPeriods([...PERIODS]);
            } else if (spec === "clear" || spec === "none") {
              await store.setFooterPeriods([]);
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
              await store.setFooterPeriods(
                PERIODS.filter((p) => mapped.includes(p)),
              );
            }
            ctx.ui.notify(
              `Footer periods: ${store.current.footerPeriods.join(", ") || "none"}`,
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
            await store.setFooterCountdowns(parsed);
            ctx.ui.notify(
              `Footer reset timer ${store.current.footerCountdowns ? "on" : "off"}`,
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
            await store.setRefreshInterval(minutes);
            ctx.ui.notify(`Background refresh TTL: ${minutes}m`, "info");
            return;
          }

          case "disconnect": {
            await store.disconnect();
            if (store.credentials) {
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
            closePanel(ctx);
            return;
          }

          case "help": {
            showPanel(helpLines(store, uiTheme(ctx.ui)), ctx);
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
}
