# Extension README SOP

Standard for every `<name>/README.md` in this repo. The file ships inside the npm tarball and renders as the package page on npmjs.com — it is the extension's storefront. Apply it on every README change. The three shipped READMEs are the reference: [`auto-session-name/README.md`](../auto-session-name/README.md), [`memory/README.md`](../memory/README.md), [`opencode-go-usage/README.md`](../opencode-go-usage/README.md).

## Steps

1. **Inventory the source.** Read `<name>/<name>.ts` and everything under `<name>/src/` end to end. List every registered command, event hook, config file read, user-visible constant (limits, section names, paths), fallback, and failure mode.
   Done when: the list covers everything a user could observe about the extension.
2. **Write the README to the shape below**, in section order. Extend freely — screenshots, callouts, command tables, diagrams; the reference READMEs show the range. Omit nothing from the inventory: every inventory item gets a home, and every README claim traces to the source.
3. **Verify.**
   - `pnpm run check` passes (Prettier formats Markdown).
   - The H1 and the install command match `name` in `<name>/package.json`.
   - The root `README.md` index row for this extension agrees with the intro paragraph.

   Done when: all three hold.

## Shape

- `# @tinysquid/pi-<name>` plus badges, then one paragraph: what the extension does and when it fires. Present tense, no marketing.
- `## Install` — the `pi install npm:@tinysquid/pi-<name>` command, then the symlink form that matches the extension's layout (file for single-file, dir for multi-file).
- Body — how it works, commands, configuration. One bullet (or table row) per command, hook, or behavior, with user-visible limits and defaults; exact file paths, schemas, defaults, precedence, and invalid-config behavior. Bullets over prose; never restate the intro.
- `## Behavior notes` — edge cases a user can observe: timing, background vs blocking, guards, failure logging.

## Notes

- Source and README must not drift: when they disagree, fix one or the other in the same change.
- A README change reaches npm users only with a version bump (see AGENTS.md release process).
- A deprecated extension's README stays accurate — prepend the deprecation notice (see `memory/README.md`).
