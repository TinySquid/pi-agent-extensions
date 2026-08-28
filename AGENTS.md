# AGENTS.md

This repository is a collection of custom [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extensions. Each extension is an independently versioned npm package under the `@tinysquid` scope, installable via `pi install npm:@tinysquid/<name>`.

## Layout

- One directory per extension: `<name>/<name>.ts` (entry point), `<name>/README.md` (becomes the npm README), `<name>/package.json` (publish metadata)
- Every extension dir is a pnpm workspace member — list it in `pnpm-workspace.yaml`
- The root `README.md` holds the extension index — update it when adding or removing extensions

## Tooling

Package manager is **pnpm** (workspaces). Use pnpm for install, scripts, and publishing.

- `pnpm install` — install dependencies
- `pnpm run typecheck` — `tsc --noEmit` (strict)
- `pnpm run lint` — eslint (typescript-eslint recommended, flat config)
- `pnpm run format` — prettier (write)
- `pnpm run check` — all of the above; run before every commit

There is no build step: pi loads the `.ts` sources directly with Bun. There is no test framework for pi extensions — testing is manual (see below).

## Extension code conventions

- Import the extension API from `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, `SessionEntry`, etc.).
- Import AI/LLM types from `@earendil-works/pi-ai`.
- Call LLMs via `ctx.modelRegistry.complete(model, context, options)` — auth is handled internally. Never fetch API keys or auth headers manually.
- Core packages (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-agent-core`, `typebox`) are bundled by pi at runtime. In an extension's `package.json` they must be `peerDependencies` with a `"*"` range — never `dependencies` (wildcard prevents duplication and version mismatches with the host pi installation).
- The root `devDependencies` pin the pi packages **exactly** to the installed pi version. Check with `pi --version`; when pi is upgraded, update both root pins to match. Types must reflect the runtime the user actually runs.

## Manual testing loop

No automated tests exist for pi extensions. After any non-trivial change:

1. `pnpm run check`
2. Symlink the extension: `ln -sf $(pwd)/<name>/<name>.ts ~/.pi/agent/extensions/<name>.ts`
3. Restart pi in a scratch project and exercise the extension's features (commands, events, UI)
4. For release candidates, also dress-rehearse the installed form: `pi install $(pwd)/<name>` (loads via the package manifest, like a real install), then `pi remove` it afterwards

Report what was and wasn't tested.

## Release process

⚠️ **The user has final approval. NEVER run `pnpm publish` (or any publish command) without explicit approval in the conversation — the user manually tests every release candidate first, because errors surface only at runtime.**

1. Bump `version` in `<name>/package.json` (semver, versions are independent per extension)
2. `pnpm run check`
3. User manually tests and explicitly approves (or denies) the release
4. On approval: `pnpm publish --filter <name> --dry-run` first, then `pnpm publish --filter <name>`
5. Update the root README index if the extension is new

First-time publishing requires a one-time `npm login` (writes `~/.npmrc`; pnpm reads the same auth). Packages are public under the `@tinysquid` scope.

## Adding a new extension

1. Copy `memory/` as a template: `<name>/<name>.ts`, `<name>/README.md`, `<name>/package.json` (name `@tinysquid/pi-<name>`, version `0.1.0`)
2. Add the dir to `pnpm-workspace.yaml`
3. Add it to the extension index in the root `README.md`
4. `pnpm install && pnpm run check`

## Repo workflow

No issue tracker: work happens on a branch and ships as a GitHub PR.
