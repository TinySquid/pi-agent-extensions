# Coding Standards

How code in this repo is written for **human maintainers**. Tooling (ESLint, prettier, build) is the floor — it catches what's _broken_, not what's _unreadable_.

---

## 1. Logical grouping (blank lines)

Blank lines are structure, not decoration. They mark where one thought ends and the next begins. Code that runs together line-after-line with no breaks is unreadable, even when it lints clean.

### Object literals: group fields by concern

Fields serving the same concern stay together; a blank line separates concerns. Do this even when the object is short.

```ts
// bad: concerns slammed together
export const DEFAULT_CONFIG: Config = {
  workspaceId: "",
  authCookie: "",
  footerEnabled: true,
  footerPeriods: [...PERIODS],
  footerCountdowns: false,
  refreshMinutes: 3,
};

// good: identity / footer behavior / tuning
export const DEFAULT_CONFIG: Config = {
  workspaceId: "",
  authCookie: "",

  footerEnabled: true,
  footerPeriods: [...PERIODS],
  footerCountdowns: false,

  refreshMinutes: 3,
};
```

### Function bodies: separate phases, not statements

One blank line between **phases** (setup → action → finalize). Lines that are one logical step stay together.

```ts
// bad: setup and action fused into one block
export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  const tmp = `${path}.tmp`;
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}

// good: setup, then the write-rename phase
export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  const tmp = `${path}.tmp`;

  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}
```

### Over-grouping is as bad as under-grouping

A blank line between _every_ statement is just noise. If two lines serve one step, they belong on adjacent lines. A 5-line function with 4 blank lines is wrong.

---

## 2. Comments

- **Placement**: on their own line **above** the code they explain. Never at end-of-line.
- **Content**: explain **why** — intent, constraint, gotcha — never **what** (the code already says that).
- **Style**: short and terse. Lowercase start, period end.
- **Deletion license**: delete any comment that merely restates the code.
- **JSDoc exception**: JSDoc on exported API is allowed to describe _what_ — that's its job.
- **No banner comments**: `// --- config ---` and friends are banned; blank lines do that job.
- **TODOs**: allowed, but must say _why_ the thing is undone, not just that it is.

```ts
// bad: trailing comments, "what" restatements, fused steps
pi.on("session_start", async (_event, ctx: ExtensionContext) => {
  uiRef.ui = ctx.ui;
  uiRef.hasUI = ctx.hasUI;
  installAutocomplete(ctx);
  store.setConfig(await loadConfig());
  await ensureConfigFile();
  renderFooter(store, ctx.ui); // instant hint / previous state; fetch updates it
  store.startTimer();
  void store.refresh(); // fire-and-forget: never block session startup
});

pi.on("turn_end", async () => {
  void store.refresh(); // always: usage just changed
});

// good: phases separated, comments above, why-focused
// we want to keep the store in-sync with usage.
pi.on("turn_end", async () => {
  void store.refresh();
});

pi.on("session_start", async (_event, ctx: ExtensionContext) => {
  uiRef.ui = ctx.ui;
  uiRef.hasUI = ctx.hasUI;

  installAutocomplete(ctx);

  store.setConfig(await loadConfig());
  await ensureConfigFile();

  // instant hint / previous state; fetch updates it
  renderFooter(store, ctx.ui);

  store.startTimer();

  // initial pull as fire-and-forget to be non-blocking.
  void store.refresh();
});
```
