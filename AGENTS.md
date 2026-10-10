# AGENTS.md

This repository is a collection of custom [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extensions. Each extension is an independently versioned npm package under the `@tinysquid` scope, installable via `pi install npm:@tinysquid/<name>`.

## Layout

- One directory per extension: `<name>/<name>.ts` (entry point), `<name>/README.md` (becomes the npm README), `<name>/package.json` (publish metadata)
- Extension READMEs follow [`docs/extension-readme-sop.md`](docs/extension-readme-sop.md) — read it before writing or updating one, on every README change. Done when: every README claim traces to the source, every registered command/hook/config default appears, and the file conforms to the SOP's shape.
- Every extension dir is a pnpm workspace member — list it in `pnpm-workspace.yaml`
- The root `README.md` holds the extension index — update it when adding or removing extensions

## Tooling

Package manager is **pnpm** (workspaces). Use pnpm for install and scripts.

Every change — features, fixes, chores, docs tweaks, anything — runs the full sequence before every commit:

```bash
pnpm run check
```

`check` = typecheck + lint + prettier write. CI runs the verify-only version, `pnpm run ci` (typecheck + lint + `format:check`), and fails on any of them.

There is no build step: pi loads the `.ts` sources directly with Bun. There is no test framework for pi extensions — testing is manual (see below).

## Extension code conventions

- Import the extension API from `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, `SessionEntry`, etc.).
- Import AI/LLM types from `@earendil-works/pi-ai`.
- Call LLMs via `ctx.modelRegistry.complete(model, context, options)` — auth is handled internally. Never fetch API keys or auth headers manually.
- Core packages (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-agent-core`, `typebox`) are bundled by pi at runtime. In an extension's `package.json` they must be `peerDependencies` with a `"*"` range — never `dependencies` (wildcard prevents duplication and version mismatches with the host pi installation).
- The root `devDependencies` pin the pi packages **exactly** to the installed pi version. Check with `pi --version`; when pi is upgraded, update both root pins to match. Types must reflect the runtime the user actually runs.

The style rules that apply on top: the `code-chunking` and `code-comments` skills (installed in your skills dir). They cover vertical grouping and comment content; apply them to every file a diff touches.

## Manual testing loop

No automated tests exist for pi extensions. After any non-trivial change — done when every feature the diff touches has been exercised:

1. `pnpm run check`
2. Symlink the extension into `~/.pi/agent/extensions/`. Single-file extensions get a file symlink:

   ```bash
   ln -sf $(pwd)/<name>/<name>.ts ~/.pi/agent/extensions/<name>.ts
   ```

   Multi-file extensions (a `src/` dir or sibling modules) get a dir symlink, because a symlinked single file resolves relative imports against the symlink's directory, not the file's real location:

   ```bash
   ln -sfn $(pwd)/<name> ~/.pi/agent/extensions/<name>
   ```

3. Restart pi in a scratch project and exercise the extension's features (commands, events, UI). For turn-event extensions (agent_end, tool events), a print-mode run is a cheap smoke test:

   ```bash
   echo "prompt" | pi -p -e $(pwd)/<name>/<name>.ts
   ```

4. For release candidates, also dress-rehearse the installed form — `pi install $(pwd)/<name>` loads via the package manifest like a real install — then `pi remove` it afterwards.

Report what was and wasn't tested.

## New package workflow

Order matters — the first publish is manual, after that CI owns releases.

1. Scaffold: copy `memory/` as a template into `<name>/` (the package is deprecated — only its files serve as the template) — `<name>.ts`, `README.md`, `package.json` (name `@tinysquid/pi-<name>`, version `0.1.0`, `"publishConfig": { "access": "public" }` — scoped packages default to private without it). Add the dir to `pnpm-workspace.yaml` and to the extension index in the root `README.md`.
2. `pnpm install && pnpm run check`
3. Smoke test (see Manual testing loop) and report what was and wasn't tested
4. Stop. The rest is the user's: first publish by hand, then attach the npm trusted publisher. Hand over with the branch ready and the smoke-test report.
5. Future versions ship through the Release process.

## Release process

Applies to packages that already exist on npm — a brand-new package starts with the New package workflow.

A release is a PR that bumps the version of one or more extension packages. **The user's PR merge is the publish approval: CI publishes to npm automatically on merge.**

1. Bump `version` in each changed `<name>/package.json` (semver, independent per extension). Only bump packages with actual changes.
2. `pnpm run check`
3. The user manually tests the candidate and explicitly approves the release in conversation
4. Push the branch and open a PR (see Git workflow)
5. The user merges → GitHub Actions runs the checks and `pnpm publish -r`. Packages whose version already exists on npm are skipped.

The agent never runs a publish command; if one is ever needed by hand, only the user runs it. Automated publishing is CI's job on merge.

## Git workflow

Every change — features, fixes, chores, docs tweaks, anything — happens on a branch and ships as a GitHub PR. The user's merge is the approval for the whole change.

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

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical role names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Review checklist

Reviewer-agent passes on a diff follow the repo checklist. See `docs/agents/review-checklist.md`.
