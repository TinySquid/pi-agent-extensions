# Review checklist

Repo-specific rules for a reviewer-agent pass on a diff. Everything here exists because this repo is a collection of **independently versioned pi extensions** — a generic TypeScript review would miss all of it.

Style rules (grouping, comments) live in [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md); this file covers packaging, pi-runtime semantics, and process. A reviewer pass reads both, works whole touched files for context, and applies fixes only within the task's diff regions — flag out-of-scope violations, don't fix them.

Each item below is phrased as a **finding**: what the reviewer reports when the rule is violated.

---

## Packaging & shipping

### 1. Peer-dependency discipline

**Finding**: diff touches `<name>/package.json` and a core pi package appears in `dependencies`, or appears in `peerDependencies` with a range other than `"*"`.

The core packages — `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-agent-core`, `typebox` — are bundled by pi at runtime. They must be `peerDependencies` with `"*"` ranges in every extension's `package.json`, never `dependencies`. One wrong line ships a duplicate dependency to every install.

### 2. Root pins match the running pi

**Finding**: diff changes root `devDependencies` pins for pi packages, and the pins don't exactly match `pi --version`, or one pin was updated without the other.

The root pins must reflect the pi version the user actually runs. Both pins update together, exactly.

### 3. Version-bump scope

**Finding**: a `<name>/package.json` version bump with no actual change under `<name>/`, or a change under `<name>/` with no bump (in a release PR).

Only packages with real changes get bumped; semver is independent per extension.

### 4. New-extension completeness

**Finding**: a new `<name>/` directory missing any of:

- entry in `pnpm-workspace.yaml`
- entry in the root `README.md` extension index
- `name` is `@tinysquid/pi-<name>` and `"publishConfig": { "access": "public" }` is set (scoped packages default to private without it)
- README conforms to [`docs/extension-readme-sop.md`](../extension-readme-sop.md)

---

## pi runtime semantics

### 5. Auth flows through the host

**Finding**: manual `fetch` to an LLM API, `process.env.*_API_KEY`, or a hand-built `Authorization` header in a diff.

LLM calls go through `ctx.modelRegistry.complete(model, context, options)` — auth is handled internally. No exceptions.

### 6. Import sources

**Finding**: extension API or AI types imported from anywhere but the two canonical packages.

- Extension API (`ExtensionAPI`, `ExtensionContext`, `SessionEntry`, …) → `@earendil-works/pi-coding-agent`
- AI/LLM types → `@earendil-works/pi-ai`

Never `pi-mono` or deep package paths.

### 7. `session_start` never blocks

**Finding**: an `await` of network, timer, or other slow work inside a `session_start` handler.

Session startup must be fast. Slow work is fire-and-forget (`void something()`) with a why-comment explaining why it's non-blocking. Reference pattern: `opencode-go-usage/src/extension.ts`.

### 8. Headless safety

**Finding**: a `ctx.ui.*` call in a diff without a `ctx.hasUI` guard on the path to it.

Extensions run in print mode (`echo "prompt" | pi -p`) with no UI. Every UI touchpoint must survive `ctx.hasUI === false`. The manual smoke test exists to catch this — the reviewer catches it first.

---

## Process

### 9. PR body shape

**Finding**: a PR missing its `Tested` / `Not Tested` sections, or empty ones for a non-trivial change. A branch name outside the repo's conventions (`ext/<name>` for new extensions, `<type>/<name>` otherwise) is also a finding.

### 10. Tested / not-tested statement

**Finding**: the reviewer's final report doesn't state what was and wasn't tested.

There is no test framework for pi extensions — testing is manual. The reviewer pass ends with an explicit "what was tested / what wasn't" statement derived from the change, so it's never left to memory.

---

## Mechanical backstops

Items 1–3 (and the first two of 4) are checkable by a script: parse each `package.json`, compare against the rule list. If a reviewer pass repeatedly misses them, promote them to a `pnpm run check`-integrated package-lint rather than relying on the model.
