# Combat replay validation and assumptions — 2026-09-20

## Handoff to the test-server reviewer

Please validate [PR #142](https://github.com/Millennium44/Toolasha/pull/142), including its follow-up
fixes for capturing the equipped build and reading current skill levels. Fetch the latest PR head
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
All rows below remain unverified in this audit. A local regression test does not change that status.

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

| Check                                    | Status                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Equipped versus configured build capture | Reproduced by targeted test before fix; passes after fix.                                                                   |
| Capture during loadout-snapshot loading  | Reproduced by targeted test before fix; passes after fix.                                                                   |
| DTO levels after `skills_updated`        | Reproduced by targeted test before fix; passes after fix.                                                                   |
| Live test-server parity                  | Five-fight normal-combat smoke test collected; a longer capture is underway. PR #142 still needs live labyrinth validation. |
| Browser storage/performance              | Pending reviewer measurements.                                                                                              |

Update this log with commit, artifact, observed result and remaining ambiguity after each live
test. Do not mark a mechanic confirmed from a simulator-only test or a bundled arrival timestamp.

## Local validation

- The three focused regressions above failed before the fixes and passed after them.
- The normal pre-commit checks completed for the implementation: full test suite, ESLint,
  Prettier, Markdown lint, development build and production build.
- Compatibility checked by applying the PR and fixes to main `745b0f1c`; 1,210 tests across
  34 relevant suites passed, including the newly changed expected-drop calculations.

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
- Setting a count target and pressing Record, and pressing Record to ±5%, both left the running
  recorder displaying an unlimited target in this installed build. A longer recording was
  started and will be stopped manually; the target-control issue needs reproduction on a
  current complete bundle set before assigning a cause.

The longer sample should retain the same build and zone. Recheck its measured uncertainty rather
than treating a fixed fight count as sufficient, and keep its results separate from this first
smoke test. Export the whole session and verify `ticksComplete` again.
