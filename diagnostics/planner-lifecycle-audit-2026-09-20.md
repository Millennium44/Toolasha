# Goal planner lifecycle audit — 2026-09-20

Base: `9db5a9db`. Scope: planner panel state at asynchronous character and feature boundaries.

## Reproduced source defects

- A delayed departing-character snapshot replaced the arriving character's plans.
- An add or removal returning after a switch replaced the arriving goal list. An add could then price and save that list under the arriving character.
- Disabling the feature left pricing busy. Resetting that flag alone would permit an abandoned same-character request to overwrite a newer request or clear its busy state.

Four focused regressions failed before the fix. Operations now retain both their character and feature generation. Teardown clears goals and releases pricing, and abandoned operations cannot adopt results, reopen the panel, register its command, report stale failures, or change a newer operation's busy state.

## Validation and limits

The panel suite passes 41 tests. Normal pre-commit related tests, ESLint, Prettier, Markdown lint, bundle-sharing, development build and production build must pass before this change is committed. Build configuration was inspected: all output paths are relative to this isolated worktree and there is no copy-to-served-dist plugin.

No game tab, shared served build, external message, game mechanic, or storage schema was changed. These are deterministic client state reproductions; live character timing remains unmeasured.

## Post-reset checks

1. After the user chooses to install a reviewed build, open Goal Planner with distinct goals saved on two characters.
2. Start Refresh on character A, switch to B while Pricing is visible, and open its planner. Confirm only B's goals appear and Refresh can run immediately.
3. Switch back to A while its earlier pricing might still be pending. Confirm only the newest refresh controls results and the busy state.
4. Disable and re-enable Goal Planner during a refresh. Confirm the old request cannot reopen the panel or replace a newer plan.
5. Repeat a switch after Add or Remove; reload both characters and check their own goal lists and snapshots. Use test goals; no destructive purchase is needed.

No long or live checks were scheduled automatically.
