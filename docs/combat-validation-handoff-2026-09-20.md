# Combat replay validation and assumptions — 2026-09-20

## Latest short live checks

The user deferred longer experiments until after reset. The concrete setups, durations and
pass/fail evidence are saved in [the post-reset test plan](combat-post-reset-validation-2026-09-20.md).

**Opening equipment evidence:** at 20:56:54.653 UTC the client applied the Siren room's automatic
swap from Blooming Trident +10 / Bishop's Codex +10 to Arcane Bow +0. `new_battle` arrived at
20:56:57.596 UTC, 2.943 seconds later. Both its captured client equipment and the saved fight DTO
contain the bow in the two-hand slot, with no old main-hand/off-hand. This supports PR #142 for
one observed transition; it does not establish all room, retry, trigger or refresh paths.

This was test-server build `3.56.0.20260920203142`, integration commit `9f6a97d0` (main `9db5a9db`
plus PR #142 at `57bd95a5` and the initial PR #146 capture). The 337-event raw capture has no
dropped entries and is saved locally as `toolasha-labyrinth-ticks-2026-09-20-20-58-09.json`
(SHA-256 `e3b2b58cf6e80061ec8f4901c4f42252414f83014f38357452fd1f661e7e9180`).
Paired pool: `toolasha-labyrinth-2026-09-20-20-58-10.json`. The Siren Lv.35 fight was complete,
started at full HP, and lasted 21.475 measured seconds. The raw files remain outside Git.

The earlier Pyre Hunter Lv.34 fight was also complete and retained its trident DTO. After a new
unrelated saved loadout was created, both fights replayed from recorded inputs with zero
exclusions/failures. Both had one observation and correctly received insufficient-evidence verdicts.
Same-monster/different-build cohorts still need repeated live tests. A preliminary Low Mana
loadout test produced no equipment update and was inconclusive for swap timing.

PR #142 also now ignores unused DTO metadata when grouping and labels historical builds.
Task progress is also excluded from equality because recorded replay currently leaves task
damage off. A focused regression previously produced six groups and deferred three solely
because task counters changed; it now pools five otherwise identical builds while retaining
one genuinely changed combat-level build as a second group. The original saved DTOs stay intact.
PR #146's follow-up makes all battle consumers ignore equipment/ability diagnostic markers;
focused regressions caught marker-induced hit loss and hidden gaps before that follow-up.
Those follow-ups were tested locally and are separate from the opening-capture build named above.

**Refresh persistence:** after two reloads onto build `3.56.0.20260920210120` (integration
`60178ba5`: PR #142 `3f929182`, PR #146 including `d096a4b7`, and PR #147), both persisted
`replayInputs` objects were deeply equal to their pre-refresh exports. Both replayed again with
zero exclusions/failures: `Build 64e2a1be · Blooming Trident ★ +10` and `Build 5ef07346 · Arcane Bow`.
All verdicts remained insufficient. Pool: `toolasha-labyrinth-2026-09-20-21-12-10.json`;
comparison: `toolasha-labyrinth-2026-09-20-21-12-19.json`. This checks persistence for these two
records; it does not settle first-fight capture during a post-refresh automatic swap.

## Handoff to the test-server reviewer

Please validate [PR #142](https://github.com/Millennium44/Toolasha/pull/142), including its follow-up
fix for capturing the equipped build. The current-skill-level fix and opening fingerprint capture
are already on main. Fetch the latest PR head
and main before testing; record the exact commit and userscript version tested.

The original PR captured inputs at fight opening but reapplied the room's configured loadout.
The follow-up captures the currently equipped DTO instead. Legacy recordings without saved inputs
still reconstruct the configured room under a matching global fingerprint. The adapter also now
reads data-manager's current skill array after `skills_updated`, rather than its login array.
Three targeted regressions reproduced these problems before the fixes. These tests establish
client behavior, not parity with server mechanics.

Please return pass/fail/inconclusive for each case, with exports and any mismatch details:

1. Record clean, complete labyrinth fights from before `new_battle` through resolution. Compare
   saved `replayInputs.playerDTO` with the gear, enhancement levels, ability slots/levels/triggers,
   combat levels, crates and buffs actually in effect at opening. Include an automatic room
   loadout switch and, if the game permits it, a manual equipped-build difference from the saved
   room loadout. Check the first fight after refresh while loadout snapshots are loading.
2. Change an unrelated saved loadout and the current ability kit after recording. Verify the old
   fights still replay with their saved inputs, even though the global fingerprint changes.
3. Change the relevant equipped build and record more fights against the same monster/level.
   Confirm old/new builds produce separate replay groups. Include a combat level-up; the next
   captured DTO must contain the new level without a page refresh.
4. Refresh and compare persisted inputs with the pre-refresh export. Replay again and verify the
   build is unchanged. Predictions may vary because replay is unseeded.
5. Record a joined-mid-fight start and a start below 90% HP. Verify partial/wounded exclusions are
   explained. Check legacy mismatches and unsupported snapshots separately; one eligible fight
   should allow an exploratory comparison, while an accuracy verdict still needs five. If more
   than three groups qualify, the remaining groups must be reported as deferred.
6. Measure storage/performance with a representative populated pool: serialized bytes with/without
   replay DTOs, capture and Replay main-thread time, IndexedDB load/save duration, and refresh/sync
   responsiveness. Use a disposable profile for synthetic near-cap data, and identify it as
   synthetic. The pool caps at 1,000 attempts, not a byte limit; each save reads/merges/writes the
   pool. Two device pools can contribute up to 2,000 entries before the merged cap is applied.

For each artifact include the build/commit, room and monster level, starting HP/MP, relevant
equipment/abilities/buffs, reproduction steps, completeness and exclusion diagnostics. Keep the
raw capture paired with the accuracy export. Do not treat reception timestamps as exact ordering
of events the server bundled in one update.

## Recorder selection

| Scenario                       | Recorder and required artifact                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Normal combat or dungeons      | `combat-recorder.js`: export the whole session; inspect `ticksComplete` because older raw segments can expire. |
| Controlled labyrinth mechanics | `labyrinth-tick-capture.js`, armed before the fight, plus the accuracy export.                                 |
| Long-term labyrinth outcomes   | `labyrinth-fight-recorder.js`: persisted attempts and their replay inputs.                                     |
| Guild combat                   | `guild-trial-trace.js`: persisted raw trace.                                                                   |

`captureLab()` inspects message shapes; it is not a complete fight timeline. The parked
`codex/combat-sim-bounded-trace` branch is not needed to collect live evidence. If simulator event
tracing is later useful, integrate it with existing diagnostics instead of adding another recorder.

## Confirmed behavior and boundaries

- **Confirmed by the user:** an out-of-mana character continues autoattacking. Another AI owns the
  correction to the earlier OOM change. Do not restore a wait-without-autoattacking policy.
- **Code behavior, not game evidence:** passing simulator tests proves consistency with the
  implementation. FIFO queue tests prove deterministic local order, not server order.
- **Replay limitation:** saved inputs use current game data and the current engine, not an archived
  balance patch. Comparisons across a game balance change must be identified as such.
- **Authorization:** no merges by this agent. The user authorized testing in the supplied Zombie T3
  and Pirate Cove T2 test-server tabs. The Zombie tab was used for the recorder checks below.

## Assumptions requiring game evidence

This is the working checklist for the current combat/recorder audit, not an exhaustive inventory
of every simulator formula. See also [the existing claim-verification notes](sim-claim-verification.md).
A1 has the limited live equipment evidence above; its other paths remain open. Other rows remain
unverified in this audit. A local regression test does not establish a game mechanic.

| ID                         | Assumption or unresolved question                                                                                                                                                                                                   | Evidence to collect / decision                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 — opening build         | At `new_battle`, current client equipment and its ability/skill state describe the build actually fighting. Client handler order alone cannot establish when the server sends equipment/trigger updates.                            | Capture automatic and manual loadout transitions. Compare wire equipment/ability updates, opening units and the saved DTO. Check triggers, enhancement levels and first post-refresh fight. If these disagree, capture must use an authoritative source or report unavailable inputs. |
| A2 — fight boundary        | Each labyrinth `new_battle` denotes a fresh attempt and supplies its initial HP before any omitted damage, even when battle IDs repeat.                                                                                             | Retain consecutive retries, transitions, and a refresh/reconnect mid-fight. Check for repeated/resumed snapshots before calling an attempt complete.                                                                                                                                  |
| A3 — starting state        | The replay's fresh HP/MP, cooldowns and transient statuses are representative of eligible fights. Current eligibility uses HP and completeness; a start at 90% HP passes, and MP/cooldowns are not part of the saved replay inputs. | Compare retry and new-room starts for HP, MP, buffs, cooldowns and status carryover. Use full-health/full-mana starts for initial parity checks. Decide whether eligibility must tighten or more starting state must be saved.                                                        |
| A4 — labyrinth consumables | Food/drinks are unavailable in labyrinth combat and crate buffs replace their role as modeled.                                                                                                                                      | Test with combat consumables equipped and distinct crates. Inspect consumption, effects and active buff/stat changes. The worker currently removes food/drinks.                                                                                                                       |
| A5 — buff inputs           | Captured community buffs, labyrinth upgrades, guild/achievement/house buffs and ability mode match what the server applies in labyrinth.                                                                                            | Compare opening server stats/effects with the saved inputs; change one source at a time. Check whether any buff changes during a fight.                                                                                                                                               |
| A6 — AoE and caster death  | Does an AoE continue to later targets when an earlier target's reflect kills its caster?                                                                                                                                            | Arrange multiple targets with reflect and a low-health caster. Retain the whole normal-combat session and counters for later targets. A bundled update that cannot distinguish this is inconclusive.                                                                                  |
| A7 — healing order         | What is the order of reflected damage versus lifesteal and Life Drain healing?                                                                                                                                                      | Isolate each heal source with reflect, varying starting HP near lethal thresholds. Compare death/survival and damage/healing, not only one final HP value.                                                                                                                            |
| A8 — same-time stun expiry | Does an attack scheduled at stun expiry fire, get cancelled or get rescheduled, and in what order?                                                                                                                                  | Find repeated boundary cases with authoritative action/status/counter evidence. If the wire cannot distinguish simultaneous operations, leave order unknown. FIFO simulator tests do not settle it.                                                                                   |
| A9 — wake-up timing        | Stun/blind expiry and mana recovery resume eligible attacks at the interval/timing the engine uses; stun suppresses wake-up attacks.                                                                                                | Capture overlapping stun/blind, mana recovery during stun and recovery after expiry. Verify attack counters and intervals. Preserve confirmed OOM autoattacks outside stun.                                                                                                           |
| A10 — damage measurement   | Tick-summed HP drops and observed healing approximate gross damage well enough for accuracy comparisons. Damage and healing within one update can conceal each other.                                                               | Compare raw hit/counter evidence with HP deltas and reconciliation fields, with and without healing/reflect. The current 3% damage-taken adjustment and 2% simulation noise floor are analysis assumptions, not game laws.                                                            |
| A11 — room-level pooling   | A 10-level room bucket simulated at its median is sufficiently comparable to its constituent fights.                                                                                                                                | Compare exact-level groups before pooling, especially near clear/death/timeout thresholds. Five fights is an application minimum, not proof of adequate statistical power.                                                                                                            |

Additional analysis assumptions:

- **A12 — uncertainty estimates:** consecutive fights are sufficiently comparable and independent
  for the panel's per-fight variance estimate and square-root sample-size projection. Check
  cooldown/HP/MP carryover, changing buffs and correlation between adjacent fight durations.
  The displayed ±5% is the panel's estimate, not a guarantee of total model error below 5%.
- **A13 — dungeon rewards:** current main applies the party level-gap multiplier to dungeon reward
  chests as well as monster drops. Its magnitude is explicitly unverified in
  `dungeon-chest-luck.js`. Compare level-gapped and ungapped controlled dungeon completions,
  including completions that pay no chest; a loot increase alone cannot count zero-payout runs.
- **A14 — action counters:** an increment in `attackAttemptCounter`/`atkCounter` identifies an
  attempt or scheduling transition, not necessarily a landed attack. In the initial capture,
  two monster updates at offsets 151 ms and 1,450 ms both have `isStunned: true` while the counter
  changes from 2 to 3. This alone does not establish damage during stun or exact event order.
  Require action, victim HP/damage-counter and status evidence together.
- **A15 — task damage in labyrinth:** recorded replay currently leaves task damage off, so task
  targets and remaining counts do not affect its effective build. Whether the live game applies
  task bonuses in labyrinth still needs a controlled matching-target versus nonmatching-target
  comparison. If that mechanic changes the model, saved input equality must change with it.

## Code audit notes

- `labyrinth-room-logs.js` opens captures synchronously from `new_battle` and passes the detached
  inputs to the persistent fight recorder on resolution.
- `labyrinth-sim-cache.js` now uses the equipped DTO for new captures. The monster argument is
  reserved for configured-loadout reconstruction of eligible legacy records.
- `combat-sim-adapter.js` reads equipment from the current equipment map and abilities through
  `getEquippedAbilities()`. The data manager reconciles abilities on `new_battle`; a live capture
  must still establish the server/update timing described in A1.
- `data-manager.js` replaces its current skills array on `skills_updated`. Reading `getSkills()`
  avoids freezing an earlier level into new recordings.
- No live storage/performance measurements have been made. The item-count bound and detached-copy
  tests do not establish browser quota use, save latency or game-tab responsiveness.

## Evidence log

| Check                                    | Status                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Equipped versus configured build capture | Reproduced by targeted test before fix; passes after fix.                                                                                                                                                          |
| Capture during loadout-snapshot loading  | Reproduced by targeted test before fix; passes after fix.                                                                                                                                                          |
| DTO levels after `skills_updated`        | Reproduced by targeted test before fix; passes after fix.                                                                                                                                                          |
| Live test-server parity                  | Pooled 105-fight normal comparison is within its estimated bands. One actual labyrinth equipment swap and two persisted replay inputs passed the limited checks above; repeated mechanics validation remains open. |
| Browser storage/performance              | Pending reviewer measurements.                                                                                                                                                                                     |

Update this log with commit, artifact, observed result and remaining ambiguity after each live
test. Do not mark a mechanic confirmed from a simulator-only test or a bundled arrival timestamp.

## Local validation

- The three focused regressions above failed before the fixes and passed after them.
- The normal pre-commit checks completed for the implementation: full test suite, ESLint,
  Prettier, Markdown lint, development build and production build.
- Compatibility checked by applying the PR and fixes to main `745b0f1c`; 1,210 tests across
  34 relevant suites passed, including the newly changed expected-drop calculations.
- Final compatibility checkout: main `cf5aadf3` with PRs #142–#145 applied together passes 1,490
  tests across 37 relevant suites and the production build. This checkout did not merge any PR.
- Later integration `60178ba5` on main `9db5a9db` passed 1,372 tests across 28 relevant files,
  development/production builds and bundle-sharing checks before the short refresh/ingest checks.

## Live recorder evidence

The initial Zombie T3 export was collected on test-server userscript
`3.56.0.20260920152508`, **not the updated PR #142 build**. The artifact is named
`toolasha-sim-accuracy-sanitized-2026-09-20-19-32-33.json`. Its raw payload is retained locally,
outside Git; it is not attached here because this version's Sanitized export still contains
character IDs in consumable inventory hashes. A separate recorder fix removes those redundant
hashes while retaining the item HRID, count, enhancement level and availability time.

- `ticksComplete: true`, one segment, 137 ticks: 131 `battle_updated` and six `new_battle` messages.
- Five completed fights contributed 80.255 seconds to the rate comparison. The recording began
  mid-fight and ended during another fight. Raw-tick completeness does not mean every fight was
  captured from start to finish.
- The incoming-ability section counts six starts and labels one initial partial excluded. Its
  last attempt has unknown outcome and nonzero monster HP. Do not equate that section's count
  with the five completed fights in the rate comparison.
- Observed DPS was 256.99 versus simulated 206.67: +24.35%, with the panel's ±16.41% margin.
  Damage per landed hit differed by +26.16% ±21.62%; swing rate by -3.22% ±5.33%. This is a lead
  for a larger sample, not an established engine defect or validation of a newer engine build.
- Boundary payloads retain consumable counts and coffee buff maps, offering more evidence about
  consumable availability than equipped slots alone. A boundary snapshot still does not prove
  uninterrupted uptime throughout the recording.
- The recording target initially appeared unchanged immediately after interaction, but a later
  observation showed `15 fights — ±13% of ±5%`. The noise target did take effect; the immediate
  post-click display was not sufficient evidence of a target-control defect. The longer capture
  was subsequently bounded at 100 additional fights and is complete below.

### Completed extended baseline

The same Zombie T3 build was recorded for 100 additional complete fights, auto-stopping at the
fight boundary at 20:10:38 UTC. Export: `toolasha-sim-accuracy-sanitized-2026-09-20-20-11-36.json`.
The full session retains 2,385 raw ticks and 101 `new_battle` messages in one segment:
`ticksComplete: true`, `live: false`, no truncation. Its loadout matches the original observation
except for capture time. The 100 new fights cover 1,948.444 measured seconds with 211.71 DPS,
100 kills, no deaths and zero endpoint damage residual.

A fresh 12-hour check pools both recordings (105 fights total):

| Metric              | Observed | Predicted | Difference and panel margin |
| ------------------- | -------- | --------- | --------------------------- |
| DPS                 | 213.50   | 209.19    | +2.06% ±7.21%               |
| Damage taken/second | 16.25    | 17.83     | -8.83% ±13.26%              |
| Seconds/fight       | 19.32    | 19.73     | -2.05% ±6.41%               |
| Combat XP/second    | 63.86    | 62.69     | +1.86% ±6.63%               |
| Swings/second       | 0.4210   | 0.4241    | -0.73% ±2.36%               |
| Hit share           | 84.07%   | 83.49%    | +0.70% ±3.25%               |
| Damage/landed hit   | 603.24   | 590.86    | +2.10% ±7.53%               |

All displayed metrics are inside the panel's estimated bands. The original five-fight DPS gap
did not persist. The sample did **not** reach ±5%, and it does not establish broad game parity or
validate the newer PR build. The export is kept locally; its old sanitizer still leaves inventory
hashes, so a scrubbed copy is required before public sharing. A separate 30-minute Pirate Cove
party capture completed with 245 fights, 7,381 raw ticks across two segments and `ticksComplete: true`.
The new short stopped-recording export verified frozen duration and zero consumable hash leaks.

## Recorder follow-up PRs

PRs #143–#145 are now closed with their fixes on main. The build failure described below is
historical and resolved. Newer recorder work is under review in PRs #146–#153; none was merged
by this agent. PR #152 now stacks on #147 and resets its recording ID during cleanup; PR #153
stacks on #151 and preserves character ownership during slow restores.

- [PR #143](https://github.com/Millennium44/Toolasha/pull/143) removes character IDs from sanitized
  consumable hashes. One focused regression reproduced the live export defect.
- [PR #144](https://github.com/Millennium44/Toolasha/pull/144) freezes recording duration at Stop.
  The first export reports 139.797 seconds, although its last tick is at 109.812 seconds and the
  completion observation was saved about 110.097 seconds after start. A focused regression shows
  that a stopped 10-second recording previously became a 70-second recording when exported one
  minute later. Completed-fight timing is separate and is not changed by this fix.
- Both fixes passed their focused suites, full pre-commit test runs and development builds.
  Their production builds hit current main's duplicated `dungeon-chest-luck.js` module in combat
  and sim. Neither fix changes imports or bundle configuration. The blocker is recorded in each
  PR. [PR #145](https://github.com/Millennium44/Toolasha/pull/145) fixes it by exporting the helper
  from the existing Utils bundle; three lines change bundle ownership without changing chest
  calculations. It passes the full normal checks, and the combined compatibility checkout's
  production build passes. No merges were performed.
