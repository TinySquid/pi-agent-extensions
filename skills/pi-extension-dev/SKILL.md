---
name: pi-extension-dev
description: Reference for building pi agent extensions. Manually invoked — does not auto-trigger. Covers architecture decisions, development workflow, common pitfalls, and an index of examples and docs. Use when explicitly asked to help build, debug, or modify a pi extension.
disable-model-invocation: true
---

# Pi Extension Development

## Phase 0: Understand the Use Case

Before writing any code, interview the user to nail down what they're building. Ask:

1. **What should happen?** — Describe the desired behavior from the user's perspective. What do they see? What changes in the agent's behavior?

2. **When should it happen?** — On every prompt? On specific tool calls? At session start? On a command?

3. **What state does it need?** — Does it need to remember things across turns? Across sessions? Is the state per-project or global?

4. **Does it need user interaction?** — Confirmations, selections, text input, custom dialogs? Or is it fully automatic?

5. **Where should it live?** — Global (`~/.pi/agent/extensions/`) for all projects, or project-local (`.pi/extensions/`) for one codebase?

Get concrete answers before proceeding. If the user is vague, press for specifics — ambiguous answers lead to the wrong architecture.

---

## Phase 1: Architecture Decision

Use this decision tree to determine the right mechanism:

### Extension (TypeScript module)

Choose an extension when the feature needs **any** of:

- Run automatically on every session (no user invocation needed)
- Intercept or modify lifecycle events (tool calls, prompts, compaction)
- Register LLM-callable custom tools
- Add UI elements (status bars, widgets, custom renderers, overlays)
- Register commands (`/mycommand`) or keyboard shortcuts
- Register custom model providers

Extensions have **zero prompt cost** if they don't register tools. They're auto-loaded from trusted directories and hot-reloaded with `/reload`.

### Skill (SKILL.md)

Choose a skill when the feature is:

- Domain expertise or workflow guidance the agent loads on-demand
- Instructions-only (no code execution)
- Best for: framework conventions, language patterns, company-specific workflows, step-by-step procedures

Only the skill's description lives in the system prompt (~100 words). The full content loads when the agent decides it's relevant.

### Custom Tool (registered inside an extension)

Choose a custom tool when:

- The LLM needs to call it as a function during a turn
- It has structured inputs/outputs the LLM can reason about
- You're OK with the prompt cost (every registered tool adds tokens to the system prompt)

### Tool Override (registered with a built-in tool's name)

Choose a tool override when:

- You want to change _how_ a built-in tool executes (add logging, permission checks, transform inputs)
- You want to change _how_ a built-in tool renders (minimal mode, custom formatting)
- **Important:** your implementation must match the exact result shape, including the `details` type. Built-in renderer inheritance is independent of execution override — you can replace just the rendering without touching execution, or vice versa.

### Quick disqualifiers

- "I just want to run a command sometimes" → probably a **command** inside an extension, not a full extension itself
- "I want the agent to know about my codebase conventions" → **skill** or AGENTS.md, not an extension
- "I want to block dangerous operations" → **extension** with `tool_call` event handler
- "I want a persistent todo list the LLM can use" → **custom tool** inside an extension, with state in `details`

---

## Phase 2: Before Writing Code

### Read the API docs

**Never guess function signatures, types, or constants.** The API is large and hallucinated calls will fail. Read the relevant docs before writing:

| Doc              | Path                                                      | Read When                                          |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Extensions (API) | `@earendil-works/pi-coding-agent/docs/extensions.md`      | Always — before any extension code                 |
| TUI Components   | `@earendil-works/pi-coding-agent/docs/tui.md`             | Building custom UI, renderers, overlays            |
| Keybindings      | `@earendil-works/pi-coding-agent/docs/keybindings.md`     | Registering shortcuts                              |
| Themes           | `@earendil-works/pi-coding-agent/docs/themes.md`          | Custom rendering, theme colors                     |
| Sessions         | `@earendil-works/pi-coding-agent/docs/sessions.md`        | Session management, branching, tree navigation     |
| Session Format   | `@earendil-works/pi-coding-agent/docs/session-format.md`  | SessionManager API, entry types, state persistence |
| Custom Providers | `@earendil-works/pi-coding-agent/docs/custom-provider.md` | registerProvider(), OAuth, custom streaming        |
| Packages         | `@earendil-works/pi-coding-agent/docs/packages.md`        | Distributing extensions as pi packages             |
| SDK              | `@earendil-works/pi-coding-agent/docs/sdk.md`             | Programmatic embedding                             |

Find the docs on disk:

```bash
ls $(npm root -g)/@earendil-works/pi-coding-agent/docs/
```

The `read` tool can open these paths directly.

### Find a relevant example

Before writing from scratch, read at least one example that's close to what you're building. The pi project ships extensive examples:

```
@earendil-works/pi-coding-agent/examples/extensions/README.md
```

Use this index to find the right one:

| Task                           | Example(s)                                                               |
| ------------------------------ | ------------------------------------------------------------------------ |
| First extension / minimal tool | `hello.ts`, `question.ts`                                                |
| Event interception / blocking  | `permission-gate.ts`, `protected-paths.ts`                               |
| Tool registration with state   | `todo.ts`, `dynamic-tools.ts`                                            |
| Override built-in tools        | `tool-override.ts`, `minimal-mode.ts`                                    |
| Custom rendering               | `truncated-tool.ts`, `structured-output.ts`, `built-in-tool-renderer.ts` |
| Input transformation           | `input-transform.ts`, `inline-bash.ts`                                   |
| System prompt modification     | `pirate.ts`, `claude-rules.ts`, `prompt-customizer.ts`                   |
| Session management             | `git-checkpoint.ts`, `bookmark.ts`, `session-name.ts`                    |
| Compaction                     | `custom-compaction.ts`, `trigger-compact.ts`                             |
| Custom UI / dialogs            | `questionnaire.ts`, `qna.ts`, `modal-editor.ts`                          |
| Widgets / status               | `status-line.ts`, `widget-placement.ts`, `custom-footer.ts`              |
| Working indicator              | `working-indicator.ts`, `hidden-thinking-label.ts`                       |
| Overlays                       | `overlay-test.ts`, `overlay-qa-tests.ts`                                 |
| Commands                       | `summarize.ts`, `handoff.ts`, `shutdown-command.ts`                      |
| Reload flow                    | `reload-runtime.ts`                                                      |
| Inter-extension events         | `event-bus.ts`                                                           |
| SSH / remote execution         | `ssh.ts`                                                                 |
| Provider registration          | `custom-provider-anthropic/`, `custom-provider-gitlab-duo/`              |
| Package with dependencies      | `with-deps/`                                                             |
| Full plan mode (complex)       | `plan-mode/`                                                             |

### Local Extensions

These are live extensions in this pi setup: `~/.pi/agent/extensions/`

## Phase 3: Development Workflow

### Write the extension

Extensions are TypeScript files loaded via [jiti](https://github.com/unjs/jiti) — no compilation step needed. The entry point is a default export:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Subscribe to events, register tools/commands/shortcuts
}
```

### Develop outside the extensions directory, symlink when ready

**Don't develop directly inside `~/.pi/agent/extensions/`.** pi loads every top-level `.js` and `.ts` file as an extension — tooling configs like `eslint.config.js` will crash startup. And without `package.json`/`tsconfig.json` in the same directory, VSCode won't resolve imports for intellisense.

Instead, maintain a separate workspace for extension development:

```
~/dev/pi-extensions/          # Development workspace
├── package.json               # Dependencies for all extensions
├── tsconfig.json              # Type checking, path aliases
├── eslint.config.js           # Linting
├── .prettierrc                # Formatting
├── my-extension.ts            # Extension source
├── another-extension/
│   └── index.ts
└── ...
```

Symlink individual extensions into the auto-discover directory when they're ready to activate:

```bash
ln -s ~/dev/pi-extensions/my-extension.ts ~/.pi/agent/extensions/my-extension.ts
ln -s ~/dev/pi-extensions/another-extension ~/.pi/agent/extensions/another-extension
```

This gives you:

- Full editor tooling (intellisense, linting, formatting) in the dev workspace
- Only symlinked extensions load into pi — WIP extensions stay invisible
- No tooling config pollution in the extensions directory
- Easy enable/disable: `ln -s` to activate, `rm` the symlink to deactivate

For project-local extensions, you can either symlink into `.pi/extensions/` or just keep them directly there since a project directory already has its own tooling context.

### Quick test (no symlink needed)

```bash
pi -e ./path/to/my-extension.ts
```

### Format before shipping

```bash
cd ~/dev/pi-extensions && npx prettier --write .
```

### Debug errors

Extension errors are logged to pi's terminal output but don't crash the agent. If your extension silently does nothing, check the terminal for stack traces.

### Package for distribution

See `@earendil-works/pi-coding-agent/docs/packages.md` for packaging extensions as installable pi packages (npm or git).

---

## Common Pitfalls

These are hard-won lessons from real extension development. Read them before you start — several of these produce silent failures that are hard to debug.

### Event scope surprises

- **`user_bash` only covers `!` commands** typed by the user. It does NOT cover LLM-initiated `bash` tool calls. To intercept all bash execution, use `tool_call` or override the `bash` tool.
- **`tool_result` handlers chain** in extension load order. Each handler sees modifications from earlier handlers — order matters.
- **`ctx.signal` is `undefined` in idle contexts** (session events, commands while idle, shortcuts). It's only defined during active agent turns. Guard with `if (ctx.signal) {...}` or only use it in turn-scoped events.

### Session lifecycle footguns

- **After `await ctx.reload()`**, in-memory state from the old extension instance is stale. Treat reload as terminal: `await ctx.reload(); return;`
- **`withSession` receives a fresh context.** Captured old `pi` or command `ctx` objects will throw if used after a session switch. Only use the `ctx` passed to the `withSession` callback.
- **Store state in tool result `details`** for proper fork/branch support. Reconstruct in-memory state from `ctx.sessionManager.getBranch()` on `session_start`. Don't rely on in-memory state surviving across sessions or forks.

### Tool registration details

- **Use `StringEnum` from `@earendil-works/pi-ai`** for string enum parameters. `Type.Union`/`Type.Literal` doesn't work with Google's API.
- **`promptGuidelines` bullets are flat** — there's no tool name prefix. Each bullet must explicitly name the tool it refers to. Don't write "Use this tool when..." — write "Use my_tool when..."
- **Throw to signal tool errors.** Returning a value, even with error text, never sets `isError: true`. The LLM will treat it as a successful result.
- **Use `withFileMutationQueue()`** when a custom tool mutates files. Without it, parallel writes from built-in tools can race with your tool.
- **`terminate: true`** makes a tool the final call in a turn — the agent won't continue after it. Use for structured-output tools that produce a final answer.

### Rendering details

- **`renderCall` and `renderResult` must return a `Component`** (from `@earendil-works/pi-tui`). Return an empty `Container` if you intentionally want nothing shown — don't return `undefined` or `null`.
- **Check `ctx.hasUI`** before calling UI methods. It's `false` in print (`-p`) and JSON modes — calling UI methods there will crash.

### Parallel tool mode

- In parallel tool execution, sibling tool results from the same assistant message aren't guaranteed to be visible in `tool_call` handlers.
- `tool_result` and `tool_execution_end` may interleave in completion order, not source order.

### Extensions directory is for active extensions only

- **pi loads every top-level `.js` and `.ts` file** in `~/.pi/agent/extensions/` as an extension. If a file doesn't export a valid factory function, pi fails at startup with "Extension does not export a valid factory function."
- Develop in a separate workspace and symlink only active extensions in. This keeps tooling configs (eslint, prettier, tsconfig) out of the auto-discover directory and gives you proper editor intellisense.
- pi scans `*.ts`/`*.js` at the top level and `*/index.ts` one level deep in subdirectories. It won't recurse further — but don't rely on this; symlinking from a dev directory is the cleaner approach.
- `node_modules/` inside `~/.pi/agent/extensions/` is gitignored by default, but if present and scanned, every `.js` file inside could trigger the same loader error.
