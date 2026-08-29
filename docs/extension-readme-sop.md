# Extension README SOP

Standard for every `<name>/README.md` in this repo. The file ships inside the npm tarball and renders as the package page on npmjs.com — it is the extension's storefront. Apply it when writing a README for a new extension or updating an existing one.

## Steps

1. **Inventory the source.** Read `<name>/<name>.ts` end to end. List every registered command, event hook, config file read, user-visible constant (limits, section names, paths), fallback, and failure mode.
   Done when: the list covers everything a user could observe about the extension.
2. **Write the README from the template** below, in section order, omitting any section that would be empty.
   Done when: every inventory item has a home in the README, and every README claim traces to the source.
3. **Verify.**
   - `pnpm run check` passes (Prettier formats Markdown).
   - The H1 and the install command match `name` in `<name>/package.json`.
   - The root `README.md` index row for this extension agrees with the intro paragraph.

   Done when: all three hold.

## Template

````markdown
# @tinysquid/pi-<name>

One paragraph: what the extension does and when it fires.

## Install

```bash
pi install npm:@tinysquid/pi-<name>
```

For local development:

```bash
ln -s $(pwd)/<name>/<name>.ts ~/.pi/agent/extensions/<name>.ts
```

## What it does

- One bullet per command, hook, or behavior, with user-visible limits and defaults.

## Configuration

Exact file paths, schemas, defaults, precedence, invalid-config behavior.

## Behavior notes

Edge cases a user can observe: timing, background vs blocking, guards, failure logging.
````

## Section rules

- **Intro** — what the extension does and when it fires. Present tense, no marketing.
- **Install** — the `pi install` command, then the symlink form for local development.
- **What it does** — one bullet per command, hook, or behavior; include user-visible limits and defaults.
- **Configuration** — exact file paths, schemas, defaults, precedence, and what happens on missing or invalid config.
- **Behavior notes** — edge cases a user can observe: timing, background vs blocking, guards, failure logging.

## Notes

- Bullets over prose; never restate the intro in the body.
- Source and README must not drift: when they disagree, fix one or the other in the same change.
- A README change reaches npm users only with a version bump (see AGENTS.md release process).
