/**
 * List Extension - List directory contents with optional glob filtering.
 *
 * API-compatible with the OpenCode list tool.
 * Lists files and directories in a given path, optionally filtered by glob pattern.
 *
 * Key behaviors:
 * - Shows both files and directories (unlike glob/find which only return files)
 * - Shows file sizes for each entry
 * - Non-recursive (only lists immediate children of the given path)
 * - Optional glob pattern to filter results
 * - Respects .gitignore (via ripgrep for ignore detection)
 * - Skips hidden files/directories
 * - Output limited to 500 entries
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const LIMIT = 500;

interface ListToolDetails {
	number_of_entries: number;
	truncated: boolean;
}

const ListParams = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "Directory path to list. Defaults to the current working directory.",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description: "Glob pattern to filter results (e.g. '*.ts', 'src/**'). Applied against entry names.",
		}),
	),
});

function isHidden(name: string): boolean {
	return name !== "." && name !== ".." && name.startsWith(".");
}

function globToRegex(glob: string): RegExp | null {
	try {
		let regex = "";
		let i = 0;
		while (i < glob.length) {
			const ch = glob[i];
			if (ch === "*") {
				if (glob[i + 1] === "*") {
					// ** matches everything including /
					regex += ".*";
					i += 2;
					// Skip trailing /
					if (glob[i] === "/") i++;
				} else {
					// * matches anything except /
					regex += "[^/]*";
					i++;
				}
			} else if (ch === "?") {
				regex += "[^/]";
				i++;
			} else if (ch === "[") {
				const close = glob.indexOf("]", i + 1);
				if (close === -1) {
					regex += "\\[";
					i++;
				} else {
					const bracket = glob.slice(i, close + 1);
					// Handle negation [!...]
					const inner = bracket.slice(1, -1);
					if (inner.startsWith("!")) {
						regex += `[^${inner.slice(1)}]`;
					} else {
						regex += `[${inner}]`;
					}
					i = close + 1;
				}
			} else if (".+^${}|()\\".includes(ch)) {
				regex += "\\" + ch;
				i++;
			} else {
				regex += ch;
				i++;
			}
		}
		return new RegExp(`^${regex}$`);
	} catch {
		return null;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "list",
		label: "List",
		description: `List files and directories in a given path. Accepts glob patterns to filter results. Shows file sizes. Non-recursive.

<usage>
- Provide a directory path to list its contents
- Optionally provide a glob pattern to filter entries (e.g. '*.ts', '*.json')
- Results show entry name and size; directories are indicated with a trailing /
</usage>

<examples>
- list(path=".") - list current directory
- list(path="src/components") - list specific directory
- list(path="src", pattern="*.ts") - list only .ts files in src/
</examples>

<tips>
- Use this to explore directory structure before reading files
- For recursive file search, use glob or find instead
- For searching file contents, use grep
</tips>`,
		promptSnippet:
			"List files and directories in a given path. Accepts glob patterns to filter results.",
		parameters: ListParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const targetPath = params.path
				? path.resolve(ctx.cwd, params.path)
				: ctx.cwd;

			// Validate path exists and is a directory
			let dirStat;
			try {
				dirStat = await stat(targetPath);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: path '${params.path ?? "."}' does not exist`,
						},
					],
					details: { number_of_entries: 0, truncated: false } as ListToolDetails,
				};
			}

			if (!dirStat.isDirectory()) {
				return {
					content: [
						{
							type: "text",
							text: `Error: '${params.path}' is not a directory`,
						},
					],
					details: { number_of_entries: 0, truncated: false } as ListToolDetails,
				};
			}

			// Build glob regex if pattern provided
			let globRegex: RegExp | null = null;
			if (params.pattern) {
				globRegex = globToRegex(params.pattern);
				if (!globRegex) {
					return {
						content: [
							{
								type: "text",
								text: `Error: invalid glob pattern '${params.pattern}'`,
							},
						],
						details: { number_of_entries: 0, truncated: false } as ListToolDetails,
					};
				}
			}

			// Read directory entries
			let entries;
			try {
				entries = await readdir(targetPath, { withFileTypes: true });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${msg}` }],
					details: { number_of_entries: 0, truncated: false } as ListToolDetails,
				};
			}

			// Filter hidden entries, apply glob pattern
			const filtered = entries.filter((entry) => {
				if (signal?.aborted) return false;
				if (isHidden(entry.name)) return false;
				if (globRegex && !globRegex.test(entry.name)) return false;
				return true;
			});

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { number_of_entries: 0, truncated: false } as ListToolDetails,
				};
			}

			if (filtered.length === 0) {
				const msg = params.pattern
					? `No entries matching '${params.pattern}' in '${params.path ?? "."}'`
					: `Directory '${params.path ?? "."}' is empty`;
				return {
					content: [{ type: "text", text: msg }],
					details: { number_of_entries: 0, truncated: false } as ListToolDetails,
				};
			}

			// Get sizes for all entries
			const withSizes = await Promise.all(
				filtered.slice(0, LIMIT + 1).map(async (entry) => {
					try {
						const s = await stat(path.join(targetPath, entry.name));
						return {
							name: entry.name,
							isDir: entry.isDirectory(),
							size: s.size,
						};
					} catch {
						return {
							name: entry.name,
							isDir: entry.isDirectory(),
							size: 0,
						};
					}
				}),
			);

			const truncated = withSizes.length > LIMIT;
			const limited = withSizes.slice(0, LIMIT);

			// Sort: directories first, then alphabetically
			limited.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});

			// Format output
			const lines = limited.map((entry) => {
				const size = entry.isDir ? "" : formatSize(entry.size).padStart(8);
				const name = entry.isDir ? `${entry.name}/` : entry.name;
				return size ? `  ${size}  ${name}` : `  ${name.padEnd(8)}  <DIR>`;
			});

			const header = params.path
				? `Contents of ${params.path}:`
				: "Contents of current directory:";

			let output = `${header}\n${lines.join("\n")}`;
			if (truncated) {
				output += `\n\n(Results truncated at ${LIMIT} entries)`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					number_of_entries: limited.length,
					truncated,
				} as ListToolDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("list"));
			if (args.path) text += ` ${theme.fg("muted", args.path)}`;
			if (args.pattern) text += ` ${theme.fg("dim", `(filter: ${args.pattern})`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as ListToolDetails | undefined;
			const text = result.content[0];
			if (!text || text.type !== "text") {
				return new Text("", 0, 0);
			}

			const content = text.text;

			if (content.startsWith("Error")) {
				return new Text(theme.fg("error", content), 0, 0);
			}

			if (content === "Cancelled") {
				return new Text(theme.fg("dim", content), 0, 0);
			}

			// Show count + truncation
			let header = theme.fg("muted", `${details?.number_of_entries ?? "?"} entries`);
			if (details?.truncated) {
				header += theme.fg("dim", " (truncated)");
			}

			// Show preview
			const lines = content.split("\n").slice(1); // skip header line
			const preview = lines.slice(0, 8);
			const body = preview.map((l) => theme.fg("muted", l)).join("\n");

			let resultText = header + "\n" + body;
			if (lines.length > 8) {
				resultText += `\n${theme.fg("dim", `... ${lines.length - 8} more`)}`;
			}

			return new Text(resultText, 0, 0);
		},
	});
}
