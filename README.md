# Pi Agent Extensions

Custom [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extensions. Each extension is an independently versioned npm package under the `@tinysquid` scope.

## Extensions

| Extension                                 | Description                                                         |
| ----------------------------------------- | ------------------------------------------------------------------- |
| [auto-session-name](./auto-session-name/) | Auto-generates descriptive session names after the first turn       |
| [memory](./memory/)                       | Persistent project memory across sessions (MEMORY.md + `/remember`) |
| [opencode-go-usage](./opencode-go-usage/) | OpenCode Go plan usage in the footer + `/opencode-go` usage table   |

## Install

Install an extension into pi:

```bash
pi install npm:@tinysquid/pi-auto-session-name
pi install npm:@tinysquid/pi-memory
pi install npm:@tinysquid/pi-opencode-go-usage
```

## Development

Requires [pnpm](https://pnpm.io).

```bash
git clone git@github.com:TinySquid/pi-agent-extensions.git
cd pi-agent-extensions
pnpm install
```

There is no build step — pi loads the `.ts` sources directly. For quick iteration, symlink an extension into your pi extensions dir:

```bash
ln -s $(pwd)/memory/memory.ts ~/.pi/agent/extensions/memory.ts
```

Scripts:

| Command              | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `pnpm run check`     | Typecheck + lint + format (fixes)             |
| `pnpm run ci`        | Typecheck + lint + format check (verify-only) |
| `pnpm run typecheck` | `tsc --noEmit` (strict)                       |
| `pnpm run lint`      | ESLint                                        |
| `pnpm run format`    | Prettier (write)                              |

See [AGENTS.md](./AGENTS.md) for conventions, the manual testing loop, and the release process.

## License

[MIT](./LICENSE)
