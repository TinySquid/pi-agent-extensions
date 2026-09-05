/**
 * Auto Session Naming Extension
 *
 * After the first turn, this extension generates a short, descriptive
 * name for the session using a cheap available model.
 *
 * The naming model and request options can be overridden via a global config
 * file: ~/.pi/agent/auto-session-name.json
 *   { "provider": "google", "model": "gemma-4-31b-it", "temperature": 0.2 }
 *
 * Without a config file, the cheapest available model (respecting the
 * session's model scoping) is used; falling back to the active model. That
 * default pick is then written to the config file as a starting point for
 * user edits (an unusable file is regenerated; a file with a valid model has
 * only its invalid fields dropped, in place).
 *
 * Thinking is explicitly disabled for reasoning-capable models unless the
 * config opts into a level ("minimal" ... "max").
 */

import type { Api, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "auto-session-name.json";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ConfigThinkingLevel = (typeof THINKING_LEVELS)[number];

type NameConfig = {
  provider: string;
  model: string;
  temperature?: number;
  thinking?: ConfigThinkingLevel;
};

const sessionNamePrompt = (userMessage: string): string => {
  return [
    "Generate a short, descriptive, relevant title (between 3 and 8 words max) for an AI prompting session based on the following message:",
    `"${userMessage}"`,
  ].join("\n");
};

type ConfigRead =
  | { status: "ok"; config: NameConfig }
  /** valid provider/model; malformed temperature/thinking fields were dropped */
  | { status: "repair"; config: NameConfig }
  /** missing or unusable — regenerate the whole file from the default pick */
  | { status: "regen" };

const configPath = (): string => join(getAgentDir(), CONFIG_FILE);

const writeConfigFile = (config: NameConfig, message: string): void => {
  try {
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
    console.warn(`[auto-session-name] ${message}`);
  } catch (err) {
    console.warn(`[auto-session-name] failed to write ${CONFIG_FILE}:`, err);
  }
};

const readConfig = (): ConfigRead => {
  let parsed: Partial<NameConfig>;
  try {
    parsed = JSON.parse(
      readFileSync(configPath(), "utf8"),
    ) as Partial<NameConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "regen" };
    }
    console.warn(
      `[auto-session-name] invalid ${CONFIG_FILE} — regenerating from default pick (${err})`,
    );
    return { status: "regen" };
  }
  if (
    typeof parsed.provider !== "string" ||
    parsed.provider.length === 0 ||
    typeof parsed.model !== "string" ||
    parsed.model.length === 0
  ) {
    console.warn(
      `[auto-session-name] invalid ${CONFIG_FILE}: expected { "provider": "...", "model": "...", "temperature"?: number, "thinking"?: "off" | "minimal" | ... | "max" } — regenerating from default pick`,
    );
    return { status: "regen" };
  }

  const config: NameConfig = {
    provider: parsed.provider,
    model: parsed.model,
  };
  let dropped = false;
  if (parsed.temperature !== undefined) {
    if (typeof parsed.temperature === "number") {
      config.temperature = parsed.temperature;
    } else {
      console.warn(
        `[auto-session-name] invalid ${CONFIG_FILE}: "temperature" must be a number — dropping it`,
      );
      dropped = true;
    }
  }
  if (parsed.thinking !== undefined) {
    if (
      typeof parsed.thinking === "string" &&
      (THINKING_LEVELS as readonly string[]).includes(parsed.thinking)
    ) {
      config.thinking = parsed.thinking;
    } else {
      console.warn(
        `[auto-session-name] invalid ${CONFIG_FILE}: "thinking" must be one of ${THINKING_LEVELS.join(" | ")} — dropping it`,
      );
      dropped = true;
    }
  }
  return dropped ? { status: "repair", config } : { status: "ok", config };
};

/**
 * Generate a config pinning the model the default pick resolved to, so users
 * have a starting point to edit. Called when the file is missing or unusable
 * (no valid provider/model). A file with a valid provider/model is never
 * overwritten — malformed option fields are repaired in place instead.
 */
const writeDefaultConfig = (model: Model<Api>): void => {
  writeConfigFile(
    { provider: model.provider, model: model.id },
    `generated ${CONFIG_FILE} (provider "${model.provider}", model "${model.id}") — edit it to change the naming model or request options`,
  );
};

const pickModel = (
  ctx: ExtensionContext,
  config: NameConfig | undefined,
): Model<Api> | undefined => {
  if (config) {
    const model = ctx.modelRegistry.find(config.provider, config.model);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
      return model;
    }
    console.warn(
      `[auto-session-name] configured model ${config.provider}/${config.model} not found or not authenticated — using default pick`,
    );
  }

  const pool =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((s) => s.model)
      : ctx.modelRegistry.getAvailable();
  if (pool.length > 0) {
    return [...pool].sort((a, b) => a.cost.input - b.cost.input)[0];
  }
  return ctx.model;
};

/**
 * Build per-API request options for the naming call.
 *
 * - temperature: passed through as-is when configured; otherwise omitted
 *   (adapters guard provider-specific temperature support internally).
 * - thinking: defaults to "off". For reasoning-capable models we disable it
 *   explicitly, because some APIs default reasoning on (Google, OpenAI
 *   o-series). Note some APIs cannot fully disable thinking (Google maps
 *   "off" to the lowest supported level with thought output hidden).
 *   Non-reasoning models and uncovered APIs disable by omission.
 */
const buildRequestOptions = (
  model: Model<Api>,
  config: NameConfig | undefined,
): ModelsApiStreamOptions<Api> => {
  const options: Record<string, unknown> = {};
  if (config?.temperature !== undefined) {
    options.temperature = config.temperature;
  }

  const level: ConfigThinkingLevel = config?.thinking ?? "off";
  if (!model.reasoning) {
    return options as ModelsApiStreamOptions<Api>;
  }

  switch (model.api) {
    case "anthropic-messages": {
      if (level === "off") {
        options.thinkingEnabled = false;
      } else {
        options.thinkingEnabled = true;
        // Anthropic has no "minimal" effort
        options.effort = level === "minimal" ? "low" : level;
      }
      break;
    }
    case "google-generative-ai":
    case "google-vertex": {
      options.thinking =
        level === "off"
          ? { enabled: false }
          : {
              enabled: true,
              level:
                level === "xhigh" || level === "max"
                  ? "HIGH"
                  : level.toUpperCase(),
            };
      break;
    }
    case "openai-responses":
    case "openai-completions":
    case "azure-openai-responses": {
      options.reasoningEffort =
        level === "off"
          ? "minimal"
          : level === "xhigh" || level === "max"
            ? "high"
            : level;
      break;
    }
    default:
      break;
  }
  return options as ModelsApiStreamOptions<Api>;
};

const generateSessionName = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
) => {
  try {
    const read = readConfig();
    const config = read.status === "regen" ? undefined : read.config;
    const model = pickModel(ctx, config);
    if (!model) {
      console.warn(
        "[auto-session-name] no model available — skipping session naming",
      );
      return;
    }
    if (read.status === "regen") {
      writeDefaultConfig(model);
    } else if (read.status === "repair") {
      // Keep the user's model choice; rewrite without the invalid fields only
      writeConfigFile(
        read.config,
        `rewrote ${CONFIG_FILE} without invalid fields (provider "${read.config.provider}", model "${read.config.model}" kept)`,
      );
    }

    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: sessionNamePrompt(prompt) }],
            timestamp: Date.now(),
          },
        ],
      },
      buildRequestOptions(model, config),
    );

    // Defend against model shenanigans
    const title = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim()
      .replace(/^["']|["']$/g, "");

    if (title) {
      pi.setSessionName(title);
    }
  } catch (err) {
    console.warn("[auto-session-name] failed to generate session name:", err);
  }
};

/**
 * /reload will cause a re-run of the extension but getSessionName() guard prevents
 * us from generating another session name (pi doesn't set session name by default)
 **/
export default function (pi: ExtensionAPI) {
  let startPrompt: string | undefined;
  let isSessionNamed = false;

  // Excludes any skill invocation at session start
  pi.on("before_agent_start", (event) => {
    if (!startPrompt) {
      startPrompt = event.prompt;
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!startPrompt) return;
    if (isSessionNamed) return;
    if (pi.getSessionName()) return;

    isSessionNamed = true;
    const naming = generateSessionName(pi, ctx, startPrompt);

    // TUI: the session outlives the turn, so run naming in the background
    // without delaying the user's prompt. One-shot modes (print/json/rpc)
    // tear down the session right after agent_end — awaiting there is free
    // (no interactive user) and avoids the stale-session guard.
    // TUI edge: quitting or switching sessions within the ~1-2s naming
    // window loses the name (warned, cosmetic).
    return ctx.mode === "tui" ? undefined : naming;
  });
}
