/**
 * Glob Extension - Find files by glob pattern, sorted by modification time (newest first).
 * Uses ripgrep (rg --files -L --null --glob). Default 100 results, skips hidden files.
 */

import {
  type ExtensionAPI,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIMIT = 100;
const TIMEOUT_MS = 30_000;

interface GlobToolDetails {
  number_of_files: number;
  truncated: boolean;
}

const GlobParams = Type.Object({
  pattern: Type.String({
    description: "The glob pattern to match files against",
  }),
  path: Type.Optional(
    Type.String({
      description: "The directory to search in. Defaults to the current working directory.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results (default: 100)",
    }),
  ),
});

function errorResult(msg: string) {
  return {
    content: [{ type: "text" as const, text: `Error finding files: ${msg}` }],
    details: { number_of_files: 0, truncated: false } satisfies GlobToolDetails,
  };
}

async function runRg(
  searchPath: string,
  globPattern: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  // Prepend "/" to relative patterns so rg matches from the search root.
  let rgGlob = globPattern;
  if (!path.isAbsolute(rgGlob) && !rgGlob.startsWith("/") && !rgGlob.startsWith("!")) {
    rgGlob = "/" + rgGlob;
  }

  return new Promise((resolve, reject) => {
    execFile(
      "rg",
      ["--files", "-L", "--null", "--glob", rgGlob],
      { cwd: searchPath, maxBuffer: 50 * 1024 * 1024, timeout: TIMEOUT_MS, signal },
      (error, stdout) => {
        if (error) {
          // rg exit code 1 = no matches, treat as empty
          if (error.code === 1) return resolve([]);
          return reject(error);
        }
        resolve(stdout.split("\0").filter((p) => p.length > 0));
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "glob",
    label: "Glob",
    description:
      "Find files by name/pattern (glob syntax), sorted by modification time (newest first). Skips hidden files. Respects .gitignore.",
    promptSnippet: "Find files by name/pattern (glob syntax, respects .gitignore)",
    parameters: GlobParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.pattern) {
        return {
          content: [{ type: "text" as const, text: "Error finding files: pattern is required" }],
          details: { number_of_files: 0, truncated: false } satisfies GlobToolDetails,
        };
      }

      const searchPath = params.path ? path.resolve(ctx.cwd, params.path) : ctx.cwd;

      // Validate search path
      try {
        if (!(await stat(searchPath)).isDirectory()) {
          return errorResult(`path '${params.path ?? "."}' is not a directory`);
        }
      } catch {
        return errorResult(`path '${params.path ?? searchPath}' does not exist`);
      }

      let files: string[];
      try {
        files = await runRg(searchPath, params.pattern, signal);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      if (files.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No files found" }],
          details: { number_of_files: 0, truncated: false } satisfies GlobToolDetails,
        };
      }

      // Resolve file paths relative to searchPath for correct stat
      const resolved = files.map((f) => path.join(searchPath, f));

      // Stat resolved files for mtime (0 if disappeared or aborted)
      const mtimes = await Promise.all(
        resolved.map(async (fp) => {
          if (signal?.aborted) return 0;
          try {
            return (await stat(fp)).mtimeMs;
          } catch {
            return 0;
          }
        }),
      );

      // Sort by mtime descending; files with mtime=0 sink to bottom
      const sortedIndices = files.map((_, i) => i).sort((a, b) => mtimes[b] - mtimes[a]);

      const limit = params.limit ?? DEFAULT_LIMIT;
      const truncated = files.length > limit;
      const topIndices = sortedIndices.slice(0, limit);

      const rawOutput = topIndices.map((i) => files[i].replaceAll("\\", "/")).join("\n");

      // Apply truncation (SDK requirement: 50KB / 2000 lines)
      const truncation = truncateHead(rawOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let finalText = truncation.content;
      if (truncated) {
        finalText += "\n\n(Results are truncated. Consider using a more specific path or pattern.)";
      }
      if (truncation.truncated) {
        finalText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text" as const, text: finalText }],
        details: {
          number_of_files: Math.min(files.length, limit),
          truncated,
        } satisfies GlobToolDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("glob ")) + theme.fg("muted", args.pattern);
      if (args.path) text += ` ${theme.fg("dim", `in ${args.path}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const text = result.content[0];
      if (!text || text.type !== "text") return new Text("", 0, 0);
      const content = text.text;

      // Streaming progress indicator
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }

      if (content.startsWith("Error")) return new Text(theme.fg("error", content), 0, 0);
      if (content === "No files found") return new Text(theme.fg("dim", "No files found"), 0, 0);

      const details = result.details as GlobToolDetails | undefined;
      const count = details?.number_of_files ?? 0;

      // Collapsed: show summary count
      if (!expanded) {
        if (count === 0) return new Text("", 0, 0);
        let summary = theme.fg("muted", ` → ${count} file(s)`);
        if (details?.truncated) summary += theme.fg("dim", " (truncated)");
        return new Text(summary, 0, 0);
      }

      // Expanded: show count header + file preview
      let header = theme.fg("muted", `${count} file(s)`);
      if (details?.truncated) header += theme.fg("dim", " (truncated)");

      const fileLines = content.split("\n").filter((l) => l.length > 0 && !l.startsWith("("));
      const preview = fileLines.slice(0, 5);
      let out = header + "\n" + preview.map((f) => theme.fg("muted", f)).join("\n");
      if (fileLines.length > 5) out += `\n${theme.fg("dim", `... ${fileLines.length - 5} more`)}`;
      return new Text(out, 0, 0);
    },
  });
}
