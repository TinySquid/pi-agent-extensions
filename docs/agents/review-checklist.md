# Review checklist

Agreed-upon repo rules for a reviewer-agent pass on a diff — the checks the reviewer reports findings against. It covers what a generic TypeScript review misses in this repo: packaging, pi-runtime semantics.

Style (grouping, comments) is the `code-chunking` and `code-comments` skills, not this file. A reviewer pass reads both the skills and this file, works whole touched files for context, and applies fixes only within the task's diff regions — flag out-of-scope violations, don't fix them.

Items are phrased as **findings**: what the reviewer reports when the rule is violated.

## Packaging & shipping

1. **Peer-dependency discipline.** Diff touches `<name>/package.json` and a core pi package (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-agent-core`, `typebox`) appears in `dependencies`, or in `peerDependencies` with a range other than `"*"`. These packages are bundled by pi at runtime; a wrong line ships a duplicate dependency to every install.
2. **Version-bump scope.** A `<name>/package.json` bump with no real change under `<name>/`, or a change under `<name>/` with no bump in a release PR. Semver is independent per extension; root `pnpm-workspace.yaml` and root `README.md` must know about every new extension dir.
3. **README SOP.** A new or changed `<name>/README.md` that doesn't follow [`docs/extension-readme-sop.md`](../extension-readme-sop.md): shape, inventory coverage, index-row alignment, claim-traces-to-source.
4. **Root pins.** Root `devDependencies` pins for pi packages changed without updating both pins together, exactly.

## pi runtime semantics

5. **Auth flows through the host.** Manual `fetch` to an LLM API, a `process.env.*_API_KEY`, or a hand-built `Authorization` header. LLM calls go through `ctx.modelRegistry.complete(model, context, options)`.
6. **Import sources.** Extension API types imported from anywhere but `@earendil-works/pi-coding-agent`; AI/LLM types from anywhere but `@earendil-works/pi-ai`. Never `pi-mono` deep paths.
7. **`session_start` never blocks.** An `await` of network, timer, or other slow work inside a `session_start` handler. Slow work is fire-and-forget (`void something()`) with a why-comment. Reference pattern: `opencode-go-usage/src/extension.ts`.
8. **Headless safety.** A `ctx.ui.*` call without a `ctx.hasUI` guard on the path to it. Extensions run in print mode (`echo "prompt" | pi -p`) with no UI.

The reviewer's final report states what was and wasn't tested, derived from the change — testing is manual; nothing is left to memory.

Items 1 and 4 are scriptable. If a reviewer pass repeatedly misses them, promote them to a check-integrated package-lint rather than relying on the model.
