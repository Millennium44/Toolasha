# Goal completion state audit — 2026-09-20

Base: `9db5a9db`. Scope: the Next Goal Step overlay tile.

## Source regression

The tile reported "Every goal is done" whenever it found no next step, including saved goals with no priced snapshot, a snapshot missing a newer goal, and an unsatisfied plan without usable steps. Three focused regressions reproduced that false completion message.

Completion now requires an explicitly satisfied plan for every current goal. Otherwise the tile says "Goals need planning" and directs the player to Refresh. The existing next-step selection and genuine completion behavior remain covered.

## Validation and post-reset check

Run the co-located overlay tests and the required lint, formatting, related tests and isolated development/production builds. No game state or game mechanic is inferred from these DOM fixtures.

After a reviewed build is deliberately installed, enable Next Goal Step, add a test goal and observe the tile before pricing finishes or after a pricing failure. It should request planning, never claim completion. Press Refresh and verify the actual next step appears; use an already satisfied gold goal to confirm legitimate completion still appears.

No live test, deployment or automatic schedule was performed. Build plugins were inspected and output stays in the isolated worktree's `dist`.
