/**
 * Glob Extension - Find files by glob pattern, sorted by modification time (newest first).
 *
 * Works the same as the Glob tool from OpenCode.
 * Uses ripgrep (rg --files -L --null --glob) for all file discovery.
 *
 * Key behaviors:
 * - Only returns file paths (never directories)
 * - Sorted by mtime, newest first (always)
 * - Hard-coded 100 result limit
 * - Skips hidden files and common ignored directories (handled by rg by default)
 * - Respects .gitignore (handled by rg by default)
 * - Returns absolute paths with forward-slash separators
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const LIMIT = 100;
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
    })
  ),
});

function skipHidden(absPath: string): boolean {
  const base = path.basename(absPath);
  // Skip hidden files/dirs (starting with ".") but not "." or ".."
  if (base !== "." && base !== ".." && base.startsWith(".")) {
    return true;
  }
  return false;
}

async function getMtime(absPath: string): Promise<number> {
  try {
    const s = await stat(absPath);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

async function runRg(
  searchPath: string,
  globPattern: string,
  signal: AbortSignal | undefined
): Promise<{ files: string[]; truncated: boolean }> {
  // Prepend "/" to relative patterns so rg matches from the search root.
  // e.g. "**/*.js" becomes "/**/*.js"
  let rgGlob = globPattern;
  if (!path.isAbsolute(rgGlob) && !rgGlob.startsWith("/") && !rgGlob.startsWith("!")) {
    rgGlob = "/" + rgGlob;
  }

  return new Promise((resolve, reject) => {
    const proc = execFile(
      "rg",
      ["--files", "-L", "--null", "--glob", rgGlob],
      {
        cwd: searchPath,
        maxBuffer: 50 * 1024 * 1024,
        timeout: TIMEOUT_MS,
        signal,
      },
      (error, stdout) => {
        if (error) {
          // rg exit code 1 = no matches, treat as empty
          if (error.code === 1 || (error as NodeJS.ErrnoException).killed === false) {
            resolve({ files: [], truncated: false });
            return;
          }
          reject(error);
          return;
        }

        // Split on null bytes
        const rawPaths = stdout.split("\0").filter((p) => p.length > 0);

        // Filter hidden files
        const filtered = rawPaths.filter((p) => !skipHidden(p));

        // Sort by path length (shortest first) as initial ordering,
        // then we'll re-sort by mtime below
        filtered.sort((a, b) => a.length - b.length);

        resolve({
          files: filtered,
          truncated: false,
        });
      }
    );
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "glob",
    label: "Glob",
    description: `Find files by name/pattern (glob syntax), sorted by modification time; max 100 results; skips hidden files. Use grep to search file contents.

<usage>
- Provide glob pattern to match against file paths
- Optional starting directory (defaults to current working directory)
- Results sorted with most recently modified files first
</usage>

<pattern_syntax>
- '*' matches any sequence of non-separator characters
- '**' matches any sequence including separators
- '?' matches any single non-separator character
- '[...]' matches any character in brackets
- '[!...]' matches any character not in brackets
</pattern_syntax>

<examples>
- '*.js' - JavaScript files in current directory
- '**/*.js' - JavaScript files in any subdirectory
- 'src/**/*.{ts,tsx}' - TypeScript files in src directory
- '*.{html,css,js}' - HTML, CSS, and JS files
</examples>

<limitations>
- Results limited to 100 files (newest first)
- Does not search file contents (use grep for that)
- Hidden files (starting with '.') skipped
</limitations>

<tips>
- Combine with grep: find files with glob, search contents with grep
- Check if results are truncated and refine pattern if needed
</tips>`,
    promptSnippet:
      "Find files by name/pattern (glob syntax). Returns matching file paths sorted by modification time (newest first). Max 100 results. Skips hidden files.",
    parameters: GlobParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Validate pattern
      if (!params.pattern) {
        return {
          content: [{ type: "text", text: "pattern is required" }],
          details: { number_of_files: 0, truncated: false } as GlobToolDetails,
        };
      }

      const searchPath = path.resolve(params.path ? path.resolve(ctx.cwd, params.path) : ctx.cwd);

      // Validate search path exists and is a directory
      try {
        const s = await stat(searchPath);
        if (!s.isDirectory()) {
          return {
            content: [
              {
                type: "text",
                text: `Error: path '${params.path ?? "."}' is not a directory`,
              },
            ],
            details: {
              number_of_files: 0,
              truncated: false,
              error: "not a directory",
            } as GlobToolDetails,
          };
        }
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error finding files: path '${params.path ?? searchPath}' does not exist`,
            },
          ],
          details: {
            number_of_files: 0,
            truncated: false,
            error: "path does not exist",
          } as GlobToolDetails,
        };
      }

      // Run ripgrep
      let files: string[];
      let rgTruncated: boolean;
      try {
        const result = await runRg(searchPath, params.pattern, signal);
        files = result.files;
        rgTruncated = result.truncated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error finding files: ${msg}` }],
          details: {
            number_of_files: 0,
            truncated: false,
            error: msg,
          } as GlobToolDetails,
        };
      }

      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: { number_of_files: 0, truncated: false } as GlobToolDetails,
        };
      }

      // Sort by mtime (newest first)
      const withMtime = await Promise.all(
        files.map(async (f) => ({ path: f, mtime: await getMtime(f) }))
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);

      // Apply limit
      const truncated = rgTruncated || withMtime.length > LIMIT;
      const limited = withMtime.slice(0, LIMIT);

      // Normalize to forward slashes and build output
      const output = limited.map((f) => f.path.replaceAll("\\", "/")).join("\n");
      const finalText =
        output +
        (truncated
          ? "\n\n(Results are truncated. Consider using a more specific path or pattern.)"
          : "");

      return {
        content: [{ type: "text", text: finalText }],
        details: {
          number_of_files: limited.length,
          truncated,
        } as GlobToolDetails,
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("glob ")) + theme.fg("muted", args.pattern);
      if (args.path) text += ` ${theme.fg("dim", `in ${args.path}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as GlobToolDetails | undefined;
      const text = result.content[0];
      if (!text || text.type !== "text") {
        return new Text("", 0, 0);
      }

      const content = text.text;

      // Error or special messages
      if (content.startsWith("Error") || content === "pattern is required") {
        return new Text(theme.fg("error", content), 0, 0);
      }

      if (content === "No files found") {
        return new Text(theme.fg("dim", "No files found"), 0, 0);
      }

      // Show count + truncation status
      let header = theme.fg("muted", `${details?.number_of_files ?? "?"} file(s)`);
      if (details?.truncated) {
        header += theme.fg("dim", " (truncated)");
      }

      // Show file paths (compact view)
      const lines = content.split("\n");
      const fileLines = lines.filter((l) => l.length > 0 && !l.startsWith("("));
      const preview = fileLines.slice(0, 5);
      const body = preview.map((f) => theme.fg("muted", f)).join("\n");

      let resultText = header + "\n" + body;
      if (fileLines.length > 5) {
        resultText += `\n${theme.fg("dim", `... ${fileLines.length - 5} more`)}`;
      }

      return new Text(resultText, 0, 0);
    },
  });
}
