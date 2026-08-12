# Claude Instructions for Toolasha

This file contains general workflow and behavioral guidelines for AI assistants working on this project.

## General Workflow Rules

### Git & Version Control

- **Always rebase, never merge**: When pulling changes, always use `git pull --rebase`
- **Never merge a release-please PR immediately**: wait for the "Format Release Please" workflow to push its `version:sync` + prettier commit onto the release-please branch first — the userscript `@version` is stamped only there. Merging before it lands ships a release labelled with the previous version (this happened with 2.90.0).
- **No attribution trailers in public-facing commits**: commits on the `releases` branch must not carry Co-Authored-By or session trailers — GreasyFork renders those commit messages as the public version changelog.
- **Keep the fork changelog current**: Every pushed change must be recorded in the "Fork Changelog" section at the top of `CHANGELOG.md`, in the same commit that makes the change. Add an entry under the current branch's Unreleased heading. **Keep it short**: a one- to two-sentence summary per change, or a few terse bullets when there are genuinely separate changes — not multi-paragraph explanations. Say what changed and why it matters; leave the deep mechanism and the war story to the commit body and the code. Do not touch the upstream changelog section below it.

### Code Changes

- **Never add code without approval**: Only add debuggers without approval; all other code requires explicit user permission
- **Always build after implementing**: Run `npm run build:dev` immediately after every approved code change

### Communication

- **No time estimates**: Never give estimates for how long something will take

### Subagents

- **Use Opus or Sonnet subagents when helpful**: For parallel research, codebase sweeps, or audits, delegate to Opus/Sonnet subagents at your discretion — no need to ask first

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
