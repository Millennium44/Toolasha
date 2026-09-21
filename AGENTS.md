# AGENTS.md - Toolasha Developer Guide

Guide for AI coding agents working on this Tampermonkey userscript for Milky Way Idle.

## Build, Lint, and Test Commands

```bash
npm install            # Install dependencies
npm run build:dev       # Build dev standalone → dist/Toolasha-dev.user.js
npm run build           # Build production bundles → dist/Toolasha.user.js + dist/libraries
npm run dev            # Watch mode (auto-rebuild)

npm run lint           # Lint code
npm run lint:fix       # Auto-fix lint issues
npm run format         # Prettier (JS/MD)

npm run lint:md        # Markdown lint
npm run lint:md:fix    # Auto-fix markdown
npm run lint:md:links  # Link check

npm test               # Run all tests
npm run test:watch     # Test watch mode

# Single test file
npm test -- src/utils/formatters.test.js

# Single test by pattern
npm test -- -t "numberFormatter"
```

**Pre-commit hooks:** ESLint + Prettier + tests + build run on commit.
**Manual testing:** Install `dist/Toolasha-dev.user.js` in Tampermonkey and open <https://www.milkywayidle.com/game>.

### Committing a multi-line message

Write the message to a file and pass the path:

```bash
cat > /tmp/msg.txt <<'EOF'
fix: subject line
EOF
git commit -F /tmp/msg.txt
```

**Never `git commit -F -`, and never pipe a `git commit` through `tail` or `head`.** Bash attaches a
heredoc to the _last_ command in a pipeline, so `git commit -F - | tail -3 <<'EOF'` feeds the message
to `tail` and leaves `git` reading a pipe that never closes. It hangs silently and forever — the
commit never lands and nothing is printed. This has cost hours.

## Workflow Rules (every agent)

These govern how work reaches `main`. `CLAUDE.md` restates several of them for Claude, and Claude's
hooks enforce some at the tool boundary — **other agents get none of those hooks, so follow these by
hand.** Agents other than the maintainer's own session work on branches and hand them off; they do not
push to `main` or merge.

### Commits

- **Conventional Commit subjects, always**: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`,
  `chore:`, `build:`. release-please builds the public GreasyFork changelog from these prefixes and
  **silently drops any commit without one**. A descriptive prefix like `Lab sim:` is not a type and is
  dropped. Put the area in the subject text: `fix: lab sim opens monster abilities at half-cooldown`.
- **No attribution trailers** — no `Co-Authored-By` or session trailers. Commits that reach the
  `releases` branch are rendered publicly by GreasyFork as the version changelog.
- Write commit messages to a file, as described above.

### The fork changelog

- Record every change under the current `## Unreleased — branch main` heading in `CHANGELOG.md`, **in
  the same commit that makes the change**. A branch handed off without its entries leaves someone else
  to reconstruct them.
- One or two sentences per change: what changed and why it matters to a player. The mechanism and the
  story of how it was found belong in the commit body.
- Never edit the upstream changelog section below the fork's.

### Handing work off

- **Rebase onto current `main` before handing a branch off.** `main` moves quickly; a branch written
  against an older one can be half-superseded by the time it is reviewed.
- **Do not commit working notes** — audit write-ups, scratch plans, `AUDIT-*.md` files. Keep them
  outside the repo and link to them from the PR if they matter.
- Prefer independent branches to stacked ones. If you must stack, name the base in the PR.
- **Say plainly what was and was not verified in a live game client.** Passing tests do not establish
  that anything works in game, and reviewers need to know which is which.

### Easy to get wrong here

- **Never name the companion script** anywhere in this repo — code, comments, `CHANGELOG.md`, commit
  subjects or PR text. Write "a companion script" if a cross-plugin hook must be described at all.
  `listing-markers.test.js` enforces this for `src/`; everything else is by hand.
- **Test fixtures must use the shapes the game actually produces.** Equipment in a player DTO is keyed
  by full hrid (`/equipment_types/main_hand`), not `main_hand`. A fixture and the code can agree on a
  shape the game never emits, and the test then passes over code that never works. Check any
  shape-dependent lookup against a live DTO.
- **Every `@require` must be a classic script.** A CDN URL can keep answering 200 while the file behind
  it changes shape: Chart.js 4's `dist/chart.min.js` is an ES module, and requiring it aborted the entire
  userscript for every user. A status code is not verification. `scripts/check-require-urls.mjs`
  checks the bodies.
- **Use the repo's Vitest** (5.x) through `npx --no-install vitest` or `node_modules/.bin/vitest`, not a
  global install.
- **Pull with `git pull --rebase`**, never a merge.
- **Never merge a release-please PR on sight.** Wait for the "Format Release Please" workflow to push
  its `chore: sync version and format release notes` commit onto the PR branch — the userscript
  `@version` is stamped only there. Merging earlier ships a release labelled with the previous version.

### Before handing off or pushing

Run `bash scripts/gates.sh`. It mirrors CI step for step: ESLint, Prettier with CI's globs, the suite,
both builds, the bundle-sharing check, the 2 MiB `@require` ceiling, and the `@require` classic-script
check. A branch that passes it will not learn anything new from CI.

## Project Structure (High-Level)

```
src/
├── main.js           # Entry point
├── core/             # Core systems (storage, config, websocket, data-manager)
├── features/         # Feature modules (market, actions, combat, tasks, etc.)
├── api/              # External API integrations (marketplace)
└── utils/            # Shared utilities (formatters, dom, efficiency, profit-helpers)
```

Tests are co-located: `formatters.js` → `formatters.test.js`.

### Testing something that draws

Tests run in `node` by default, because most of what is worth testing is
arithmetic. A module that builds DOM needs a DOM, which is opted into per file:

```js
/** @vitest-environment happy-dom */
```

Keep it per-file rather than global — the DOM environment costs setup time on
every file that takes it, and only a handful need it.

The pattern, from `src/features/ui/combat-level-panel.test.js`:

- **Mock the game, not the panel.** `vi.mock('../../core/data-manager.js', …)`
  with a `vi.hoisted` object you mutate between tests, so each test decides what
  character the panel is looking at.
- **Mock anything that reaches storage.** `panel-geometry.js` lives in IndexedDB
  and is never what the test is about.
- **Drive the clock, do not let it run.** `vi.setSystemTime(…)` then call
  `_render()` directly. `vi.advanceTimersByTime(5 * 60_000)` fires a
  five-second refresh sixty times to produce the two readings a rate needs, and
  turns a 50 ms test into a 2 s one.
- **Assert that nothing failed to draw.** The panel catches per-section errors so
  one failure does not blank the rest; `expect(text()).not.toContain('could not
be drawn')` is what catches a missing method, a renamed helper, or a property
  read off something that stopped having it. No arithmetic test can.
- **Reset panel state in `afterEach`.** A panel remembers its selections between
  openings, which is right for a panel and wrong for a test.

## Code Style & Conventions

### Imports

- **Always use `.js` extension** in imports.
- **Order:** core → api → features → utils.

```js
import config from '../core/config.js';
import marketAPI from '../api/marketplace.js';
import someFeature from '../features/foo/bar.js';
import { formatWithSeparator } from '../utils/formatters.js';
```

### Formatting

- 4 spaces indentation
- 120-char line length
- Single quotes, semicolons required
- Trailing commas (ES5), LF line endings

### Naming

- Files: `kebab-case.js`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`

### Async/Await

- **Use async/await** only (no `.then()` chains).

### Error Handling

- Use try/catch with module-prefixed logs.

```js
try {
    const result = await someAsyncOperation();
    return result;
} catch (error) {
    console.error('[ModuleName] Operation failed:', error);
    return null;
}
```

### JSDoc

- Document public functions and exported helpers with JSDoc.

## Architecture Patterns

### Singleton Core Modules

```js
class DataManager {
    constructor() {
        this.data = null;
    }
}
const dataManager = new DataManager();
export default dataManager;
```

### Feature Interface

```js
export default {
    name: 'Feature Name',
    initialize: async () => {
        /* setup */
    },
    cleanup: () => {
        /* teardown */
    },
};
```

### Data Access

```js
import dataManager from '../core/data-manager.js';
const itemDetails = dataManager.getItemDetails(itemHrid);
```

### Storage

```js
import storage from '../core/storage.js';
await storage.set('key', value, 'storeName');
const value = await storage.get('key', 'storeName', defaultValue);
```

## Lifecycle & Cleanup

- Prefer `createCleanupRegistry()` for timers/observers.
- Use `createTimerRegistry()` for intervals/timeouts.
- Remove observers/listeners on `cleanup()` or `disable()`.

## Anti-Patterns to Avoid

- ❌ `.then()` chains
- ❌ Direct `localStorage` access → use storage module
- ❌ Direct game data access → use dataManager
- ❌ `var`
- ❌ Mutating function parameters
- ❌ Missing `.js` in imports

## Key Files

- `src/main.js` (entry/init)
- `src/core/data-manager.js` (game data access)
- `src/core/storage.js` (IndexedDB)
- `src/core/websocket.js` (WS interception)
- `src/core/feature-registry.js` (feature bootstrapping)
- `src/utils/formatters.js` (number/time formatting)
- `src/utils/efficiency.js` (efficiency math)
- `src/utils/profit-helpers.js` (profit/rate helpers)

## Tooling Rules

- ESLint: no `var`, no `eval`, prefer `const`, no duplicate imports.

## Cursor / Copilot Rules

- No `.cursorrules` or `.github/copilot-instructions.md` found in this repo.

```

```
