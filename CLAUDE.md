# Claude Instructions for Toolasha

This file contains general workflow and behavioral guidelines for AI assistants working on this project.

## General Workflow Rules

### Git & Version Control

- **Always rebase, never merge**: When pulling changes, always use `git pull --rebase`
- **Keep the fork changelog current**: Every pushed change must be recorded in the "Fork Changelog" section at the top of `CHANGELOG.md`, in the same commit that makes the change. Add an entry under the current branch's Unreleased heading with the commit's subject and user-facing bullet points (what changed, why it matters). Do not touch the upstream changelog section below it.

### Code Changes

- **Never add code without approval**: Only add debuggers without approval; all other code requires explicit user permission
- **Always build after implementing**: Run `npm run build:dev` immediately after every approved code change

### Communication

- **No time estimates**: Never give estimates for how long something will take

## Releases & Tooling

Knowledge that is not obvious from the repository itself, and expensive to rediscover.

### Cutting a release

Releases are driven by Release Please (`.github/workflows/release.yml`), not by hand:

1. Merging to `main` opens (or updates) a release PR that collects conventional commits.
2. Merging **that** PR tags the version, builds the production bundles, and pushes them to the
   `releases` branch as two commits — one adding the files, one pinning the `@require` URLs.
3. The workflow rewrites every `https://UPDATE-THIS-URL/` placeholder into
   `cdn.jsdelivr.net/gh/<repo>@<commit>/dist/libraries/…`, so the released entrypoint pulls
   libraries pinned to that exact commit.

The workflow needs `secrets.PAT`. A release that appears to do nothing is usually that secret.

- **Never bump the version in `package.json` by hand.** `scripts/check-version-bump.js` rejects it;
  only Release Please may change versions.
- Greasy Fork syncs from a configured webhook, so a push is enough — no manual upload. It syncs
  from released bundles, so pushing to a feature branch will not update it.

### Testing

- Vitest runs with `environment: 'node'` and **no jsdom or happy-dom installed**. Tests that touch
  the DOM need hand-rolled stubs covering only the surface the code actually uses — do not add a
  DOM dependency to work around this.
- Tests are co-located (`formatters.js` → `formatters.test.js`).

### Pre-commit

Husky runs ESLint, Prettier, markdownlint, the full test suite, and both builds on commit, and
commitlint enforces conventional commit messages. A commit that seems to hang is usually the
production build. Expect commits to take a while rather than assuming something is stuck.

## Project-Specific Context

### Recent Breaking Changes

**February 21, 2026 Game Update:**

- Game removed `__reactFiber$...` keys from DOM elements
- Chat commands `/item` and `/mp` no longer work (game core inaccessible via old method)
- Marketplace navigation required new approach using `_reactRootContainer`

**React Fiber Navigation Pattern:**

```javascript
const rootEl = document.getElementById('root');
const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;

function find(fiber) {
    if (!fiber) return null;
    if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
    return find(fiber.child) || find(fiber.sibling);
}
```

This approach traverses the React fiber tree to find game methods without depending on obfuscated property names.

### Common Bugs to Watch For

1. **Pricing mode not passed through**: Always ensure `pricingMode` is included in calculator return objects and passed to display formatters
2. **MutationObserver missing attributes**: When watching for item changes, include `attributes: true` and `attributeFilter` for SVG href changes
3. **Early returns in switch statements**: Use variable assignment instead of returning directly in switch cases
4. **Unreachable code after return**: Lint will catch console.logs after return statements

## Technical Details

For code style, architecture patterns, build commands, and technical guidelines, see:

@AGENTS.md
