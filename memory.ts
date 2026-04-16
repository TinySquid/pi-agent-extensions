/**
 * Memory extension - persistent project memory across sessions
 *
 * On session start: reads MEMORY.md from project root and injects into system prompt.
 * /remember: summarizes current session into MEMORY.md with smart merge.
 *
 * MEMORY.md sections: Decisions, Preferences, Lessons
 * Output format: caveman full intensity (ultra-terse)
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT_MARKERS = [
  ".git",
  "AGENTS.md",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "CmakeLists.txt",
];

const SECTIONS = ["Decisions", "Preferences", "Lessons"] as const;
type SectionName = (typeof SECTIONS)[number];

const MAX_LINES = 500;
const MEMORY_FILE = "MEMORY.md";

const CAVEMAN_RULES = `Respond terse like smart caveman. All technical substance stay. Only fluff die.
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms. Technical terms exact. Code blocks unchanged.
Pattern: [thing] [action] [reason].
One line per entry. No preamble. No explanation.`;

// ---------------------------------------------------------------------------
// Root Detection
// ---------------------------------------------------------------------------

function findProjectRoot(cwd: string): string | null {
  const root = resolve("/");
  let dir = resolve(cwd);

  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(resolve(dir, marker))) {
        return dir;
      }
    }
    if (dir === root) break;

    const parent = resolve(dir, "..");

    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readMemoryFile(root: string): string | null {
  const path = resolve(root, MEMORY_FILE);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

function writeMemoryFile(root: string, content: string): void {
  const path = resolve(root, MEMORY_FILE);
  writeFileSync(path, content + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Section Parsing / Rendering
// ---------------------------------------------------------------------------

function parseSections(content: string): Map<SectionName, string[]> {
  const sections = new Map<SectionName, string[]>();
  for (const name of SECTIONS) {
    sections.set(name, []);
  }
  if (!content) return sections;

  let currentSection: SectionName | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (match) {
      const normalized = SECTIONS.find((s) => s.toLowerCase() === match[1].trim().toLowerCase());
      if (normalized) {
        currentSection = normalized;
        continue;
      }
    }
    if (currentSection && trimmed && !trimmed.startsWith("#")) {
      const entry = trimmed.replace(/^[-*•]\s+/, "").trim();
      if (entry) {
        sections.get(currentSection)!.push(entry);
      }
    }
  }

  return sections;
}

function renderSections(sections: Map<SectionName, string[]>): string {
  const parts: string[] = [];
  for (const name of SECTIONS) {
    const entries = sections.get(name)!.filter((e) => e !== "_none_");
    parts.push(`## ${name}\n`);
    if (entries.length === 0) {
      parts.push("\n");
    } else {
      for (const entry of entries) {
        parts.push(`- ${entry}\n`);
      }
      parts.push("\n");
    }
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Smart Merge
// ---------------------------------------------------------------------------

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_*•\s]+/g, " ")
    .trim();
}

function isDuplicate(newEntry: string, existingEntries: string[]): boolean {
  const norm = normalizeForComparison(newEntry);
  if (!norm) return false;

  for (const existing of existingEntries) {
    const normExisting = normalizeForComparison(existing);
    if (!normExisting) continue;

    // Substring check
    if (norm.includes(normExisting) || normExisting.includes(norm)) {
      return true;
    }

    // Word overlap check
    const newWords = new Set(norm.split(/\s+/));
    const existingWords = new Set(normExisting.split(/\s+/));
    if (newWords.size === 0 || existingWords.size === 0) continue;

    let overlap = 0;
    for (const word of newWords) {
      if (existingWords.has(word)) overlap++;
    }
    const ratio = overlap / Math.min(newWords.size, existingWords.size);
    if (ratio > 0.7) return true;
  }

  return false;
}

function smartMerge(
  existing: Map<SectionName, string[]>,
  incoming: Map<SectionName, string[]>
): Map<SectionName, string[]> {
  const merged = new Map<SectionName, string[]>();

  for (const name of SECTIONS) {
    const existingEntries = [...(existing.get(name) ?? [])];
    const incomingEntries = incoming.get(name) ?? [];

    for (const entry of incomingEntries) {
      if (entry === "_none_") continue;

      if (entry.startsWith("[update]")) {
        const updateText = entry.replace(/^\[update\]\s*/i, "").trim();
        if (!updateText) continue;

        let replaced = false;
        for (let i = 0; i < existingEntries.length; i++) {
          if (isDuplicate(updateText, [existingEntries[i]])) {
            existingEntries[i] = updateText;
            replaced = true;
            break;
          }
        }
        if (!replaced && !isDuplicate(updateText, existingEntries)) {
          existingEntries.push(updateText);
        }
      } else {
        if (!isDuplicate(entry, existingEntries)) {
          existingEntries.push(entry);
        }
      }
    }

    merged.set(name, existingEntries);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Conversation Extraction
// ---------------------------------------------------------------------------

type ContentBlock = { type?: string; text?: string };

function extractText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts;
}

function buildConversationText(entries: SessionEntry[]): string {
  const parts: string[] = [];

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const role = entry.message.role;
      if (role === "user" || role === "assistant") {
        const texts = extractText(entry.message.content);
        if (texts.length > 0) {
          const text = texts.join("\n").trim();
          if (text) {
            parts.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
          }
        }
      }
    } else if (entry.type === "compaction" && entry.summary) {
      parts.push(`[Previous context summary]: ${entry.summary}`);
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// LLM Helper
// ---------------------------------------------------------------------------

async function callModel(
  ctx: ExtensionContext,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("No model selected");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}/${model.id}` : auth.error);
  }

  const response = await complete(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userMessage }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal }
  );

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let cachedMemory: string | null = null;
  let projectRoot: string | null = null;

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = findProjectRoot(ctx.cwd);
    cachedMemory = projectRoot ? readMemoryFile(projectRoot) : null;
  });

  pi.on("before_agent_start", async (event) => {
    if (!cachedMemory) return;
    return {
      systemPrompt: event.systemPrompt + `\n\n## MEMORY.md\n\n${cachedMemory}\n`,
    };
  });

  // --- /remember command ---

  pi.registerCommand("remember", {
    description: "Summarize session into MEMORY.md (decisions, preferences, lessons)",
    handler: async (_args, ctx) => {
      const root = projectRoot ?? findProjectRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify("No project root found", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // Gather conversation
      const branch = ctx.sessionManager.getBranch();
      const conversationText = buildConversationText(branch);
      if (!conversationText.trim()) {
        ctx.ui.notify("No conversation to remember", "warning");
        return;
      }

      ctx.ui.notify("Extracting memories...", "info");

      const existingMemory = readMemoryFile(root) ?? "";

      // --- Extraction ---
      const extractPrompt = [
        "Extract key decisions, preferences, and lessons from this session.",
        "Output ONLY new info not already in existing memory.",
        "For entries that update/replace existing ones, prefix with [update].",
        "Use exactly these sections: ## Decisions, ## Preferences, ## Lessons.",
        "If section has nothing new: ## SectionName then _none_ on next line.",
        "",
        CAVEMAN_RULES,
        "",
        "=== EXISTING MEMORY ===",
        existingMemory || "(none yet)",
        "",
        "=== SESSION ===",
        conversationText,
      ].join("\n");

      let extracted: string;
      try {
        extracted = await callModel(
          ctx,
          "You extract project memory entries. Ultra-terse. Caveman style. No preamble.",
          extractPrompt,
          ctx.signal
        );
      } catch (err) {
        ctx.ui.notify(`Extraction failed: ${err instanceof Error ? err.message : err}`, "error");
        return;
      }

      // Parse + merge
      const existingSections = parseSections(existingMemory);
      const incomingSections = parseSections(extracted);
      const merged = smartMerge(existingSections, incomingSections);
      let rendered = renderSections(merged);

      // --- Compression if over limit ---
      const lineCount = rendered.split("\n").length;
      if (lineCount > MAX_LINES) {
        ctx.ui.notify(`Memory at ${lineCount} lines, compressing...`, "info");

        const compressPrompt = [
          `Compress this project memory to under ${MAX_LINES} lines.`,
          "Remove redundant, merge related, drop least valuable.",
          "Keep all three sections: ## Decisions, ## Preferences, ## Lessons.",
          "If section empty: ## SectionName then _none_ on next line.",
          "",
          CAVEMAN_RULES,
          "",
          rendered,
        ].join("\n");

        let compressed: string;
        try {
          compressed = await callModel(
            ctx,
            "You compress project memory. Ultra-terse. Caveman style. No preamble.",
            compressPrompt,
            ctx.signal
          );
        } catch (err) {
          ctx.ui.notify(
            `Compression failed, writing uncompressed: ${err instanceof Error ? err.message : err}`,
            "warning"
          );
          writeMemoryFile(root, rendered);
          cachedMemory = rendered.trim();
          projectRoot = root;
          return;
        }

        const compressedSections = parseSections(compressed);
        rendered = renderSections(compressedSections);
        const newLineCount = rendered.split("\n").length;

        if (newLineCount > MAX_LINES) {
          ctx.ui.notify(
            `Warning: MEMORY.md at ${newLineCount} lines after compression (max ${MAX_LINES}). Consider pruning manually.`,
            "warning"
          );
        }
      }

      // --- Write ---
      writeMemoryFile(root, rendered);
      cachedMemory = rendered.trim();
      projectRoot = root;

      const finalLines = rendered.split("\n").length;
      ctx.ui.notify(`Memory updated: ${finalLines} lines`, "success");
    },
  });
}
