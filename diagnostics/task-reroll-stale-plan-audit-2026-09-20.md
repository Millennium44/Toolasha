# Task reroll stale-plan audit — 2026-09-20

## Scope and result

Audited task slot forecasts/alerts, task-card state, reroll options, spend badge,
and the guided reroll walk. Changed only the walk and its regression tests.
No pricing formulas, storage, game tabs, shared distribution files, or live
game state were changed. Builds use this isolated worktree's relative `dist/`;
the checked-in Rollup configuration has no deployment or copy plugin.

Three source regressions failed before the fix:

1. Updating an existing payment button from 10,000 to 20,000 left its DOM
   identity unchanged, so the walk clicked it under the old quote.
2. Reusing a free-reroll button for a coin offer let the fallback selector
   click the paid option while the armed plan still said free.
3. Lowering the shield's reroll limits between planning and pressing allowed
   payment under the old limits before the widget observer refreshed.

The walk now checks the offered currency and amount for every payment, and
checks the current limit signature before acting on a card. A changed input
causes a replan with no game click. Regression coverage also checks that raising
limits cancels a previously armed discard confirmation. Existing tests cover
unchanged payments, manual fallback, character switching, and one action per
user press.

These are source-level stale-state regressions. Tests do not establish how
often a particular game build reuses payment nodes, nor do they measure task
arrival cadence or reroll mechanics. No source-proven task-slot arithmetic
regression was found in this bounded pass. Grouped progress text remains a
possible follow-up: `cardTaskKey` uses a plain-digit goal regex, but the audit
did not verify whether the live task progress line uses grouped quantities.

## Validation

- Before fix: three new regressions failed; 99 existing walk tests passed.
- After fix: the initial focused seven-file set passed 199 tests.
- A fourth regression covers cancelling a stale discard after limits increase.
- Full ESLint and full Prettier checks passed.
- Normal commit hooks passed final related tests, ESLint, Prettier, Markdown
  lint, standalone development build, and production build.
- All production entrypoint/library files are below the 2 MiB delivery limit.
- An optional full-suite run was stopped to avoid contention with another
  audit's full suite. No full-suite pass is claimed for this branch.

## Publication status

[PR #170](https://github.com/Millennium44/Toolasha/pull/170) is open against main
from `codex/task-progress-forecast-audit`. Publication completed after direct
user approval. The source fix is in commit `19f05ea6`; the follow-up documentation
records this final handoff. No merge or deployment was performed.

## Post-reset live checks

Coordinate with the task that owns the game tabs before any live work. Use an
explicitly approved candidate install; do not copy any build into the served
maintainer `dist/` directory.

1. Open the task board and guided reroll walk. On a task the player intends to
   reroll, open the coin chooser and record the displayed amount and walk label.
2. Before pressing the walk again, lower the shield's coin threshold to the
   quoted amount and block the cowbell option. The walk must refresh or refuse
   the stale payment. Verify no reroll count or currency balance changes from
   that stale walk press. Restore the player's original limits afterward.
3. On a task already offered for discard by both limits, open its discard
   confirmation. Raise the shield limits before the next walk press. Verify the
   stale confirmation is not executed. The current implementation may stop and
   ask the player to close the game's confirmation manually.
4. Observe an intended reroll while recording the task name/goal, payment node
   identity, button amount, and walk label before and after the server response.
   If the game reuses the node with a changed quote, verify the next walk press
   uses a refreshed label or replans without spending. Do not force extra
   rerolls solely to obtain a same-name result.
5. If a free offer is naturally consumed elsewhere while a free step is armed,
   verify the walk refreshes to the current offer before any paid action.
6. Check one ordinary unchanged payment and manual fallback, confirming each
   user press performs at most one game action and the settled tally matches
   the visible payment. Keep all observations local; omit raw private captures
   from public PR artifacts.

No long recordings or endurance tests were run or scheduled.
