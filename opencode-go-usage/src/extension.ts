import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureConfigFile, loadConfig, DEFAULT_CONFIG } from "./config.ts";
import { createSubcommandAutocompleteInstaller } from "./autocomplete.ts";
import {
  registerOpencodeGoCommand,
  SUBCOMMANDS,
  type UiRef,
} from "./commands.ts";
import { renderFooter } from "./footer.ts";
import { PERIODS } from "./periods.ts";
import { UsageStore } from "./state.ts";

/**
 * Composition root: create the store, wire the command and session events,
 * and keep the footer in sync with store changes. All feature logic lives in
 * the modules under src/.
 */
export default function opencodeGoUsage(pi: ExtensionAPI): void {
  const store = new UsageStore({
    ...DEFAULT_CONFIG,
    footerPeriods: [...PERIODS],
  });
  const uiRef: UiRef = { ui: null, hasUI: false };
  const installAutocomplete = createSubcommandAutocompleteInstaller(
    "opencode-go",
    () =>
      SUBCOMMANDS.map((s) => ({
        value: s.value,
        description: s.description,
      })),
  );

  // Any store mutation re-renders the extension status line.
  store.subscribe(() => renderFooter(store, uiRef.ui ?? undefined));

  registerOpencodeGoCommand(pi, store, uiRef);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    uiRef.ui = ctx.ui;
    uiRef.hasUI = ctx.hasUI;
    installAutocomplete(ctx);
    store.setConfig(await loadConfig());
    await ensureConfigFile();
    renderFooter(store, ctx.ui); // instant hint / previous state; fetch updates it
    store.startTimer();
    void store.refresh(); // fire-and-forget: never block session startup
  });

  pi.on("turn_end", async () => {
    void store.refresh(); // always: usage just changed
  });

  pi.on("session_shutdown", () => {
    store.stopTimer();
  });
}
