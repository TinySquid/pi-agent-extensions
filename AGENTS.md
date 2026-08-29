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
- `pnpm run check` — local: typecheck + lint + format (prettier write); run before every commit
- `pnpm run ci` — verify-only variant used by CI (prettier check, fails on unformatted code)

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
3. Restart pi in a scratch project and exercise the extension's features (commands, events, UI). For turn-event extensions (agent_end, tool events), a print-mode run is a cheap smoke test: `echo "prompt" | pi -p -e $(pwd)/<name>/<name>.ts`
4. For release candidates, also dress-rehearse the installed form: `pi install $(pwd)/<name>` (loads via the package manifest, like a real install), then `pi remove` it afterwards

Report what was and wasn't tested.

## New package workflow

Order matters — the first publish is manual, after that CI owns releases.

1. Scaffold: copy `memory/` as a template into `<name>/` — `<name>.ts`, `README.md`, `package.json` (name `@tinysquid/pi-<name>`, version `0.1.0`, `"publishConfig": { "access": "public" }` — scoped packages default to private without it). Add the dir to `pnpm-workspace.yaml` and to the extension index in the root `README.md`.
2. `pnpm install && pnpm run check`
3. Smoke test (see Manual testing loop) and report what was and wasn't tested
4. First publish — manual, by the user (`npm login`, then `pnpm publish --filter @tinysquid/pi-<name> --no-git-checks`). `--filter` matches package names, not directory names.
5. Trusted publisher — one-time, by the user: npmjs.com → package page → Access Control → Add Trusted Publisher: GitHub Actions, owner `TinySquid`, repo `pi-agent-extensions`, workflow `.github/workflows/ci.yml`. npm requires the package to exist before a trusted publisher can be attached — hence the manual first publish.
6. Done. Future versions ship through the Release process.

## Release process

Applies to packages that already exist on npm — a brand-new package starts with the New package workflow.

A release is a PR that bumps the version of one or more extension packages. **The user's PR merge is the publish approval: CI publishes to npm automatically on merge.**

1. Bump `version` in each changed `<name>/package.json` (semver, independent per extension). Only bump packages with actual changes.
2. `pnpm run check`
3. The user manually tests the candidate and explicitly approves the release in conversation
4. Push the branch and open a PR (see Git workflow)
5. The user merges → GitHub Actions runs the checks and `pnpm publish -r`. Packages whose version already exists on npm are skipped.

⚠️ **Never run `pnpm publish` (or any publish command) locally.** Publishing happens only in CI on merge — the merge is the user's final approval. Local publishing (the New package workflow step 4) is reserved for the user themselves.

## Git workflow

No issue tracker: **every change — features, fixes, chores, docs tweaks, anything — happens on a branch and ships as a GitHub PR.** Never commit directly to `main`.

1. Pick the branch:
   - Brand-new extension: `git checkout -b ext/<extension-name>`
   - Any other change: check the current branch first (`git branch --show-current`) — the user may have already started a branch for this work. If it's not `main`, use it (ask when unsure). Otherwise create a conventional one: `git checkout -b <type>/<name>` (e.g. `feat/memory-limit`, `chore/dev-boilerplate`)
2. Run `pnpm run check` before every commit
3. Push the branch and open the PR with the GitHub CLI — never ask the user to do it:

   ```bash
   git push -u origin <branch>
   gh pr create --base main --title "..." --body "..."
   ```

   The PR body opens with a plain description of the change (no heading), then only the sections that apply: `## Tested`, `## Not Tested`, `## Before Merging`, `## After Merging`. If content fits none of them, propose a new section in the PR and add it to this list once approved.

4. The user reviews and merges. For release PRs, merging is the publish approval (see Release process).
