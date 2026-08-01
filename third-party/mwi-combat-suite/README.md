# MWI Combat Suite (vendored)

**MWI Combat Suite v0.9.36235** by **Frotty**, MIT licensed. Kept here verbatim as source
material, not as something Toolasha builds or ships.

- `mwi-combat-suite-0.9.36235.user.js` — the script exactly as it was given, unmodified
- `LICENSE.md` — its terms

Nothing in this directory is imported, bundled, linted, or executed. `rollup.config.js` builds
from `src/`, `npm run lint` runs on `src/`, and the pre-commit hooks match `src/**/*.js`, so a
copy here stays inert.

## Why it is in the repository

It arrived as a chat paste, and a chat paste is not a provenance record. The MIT licence
permits reuse and requires the notice to travel with it, which means the thing being attributed
has to be identifiable — "adapted from a version of Frotty's script" is not attribution if
nobody can say which version. Committing the exact 42,155 lines makes any later claim about what
was taken checkable against the original, and makes it possible to diff against a future upstream
release rather than guess at what changed.

The alternative — port from the paste and let the paste evaporate — is how a project ends up with
code it cannot account for.

## What is in it

One floating button opens a menu of twenty-one tools, each its own draggable panel. Most read
the game's WebSocket traffic through a shared hook and keep per-character state in
`GM_getValue`/`localStorage`.

| Tool                  | What it does                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shykai Export         | Exports the character — levels, equipment, food, drinks, abilities, house rooms, zone — into the Shykai combat simulator's import format. Also runs on the simulator site itself. |
| AMazing               | Hides the game's own interface so only the suite's panels remain.                                                                                                                 |
| BRead                 | Ability book planning: how many books to a target level, and what they cost.                                                                                                      |
| CRack                 | Consumable tracking — food and drink burn rate, days left, party ETA.                                                                                                             |
| DPs                   | Damage per second off the combat log, with a filter for non-damage events.                                                                                                        |
| EWatch                | Equipment spy — reads other players' equipment off the wire.                                                                                                                      |
| FLoot                 | The loot drop tracker: drops, rates, and market value. The suite's centre of gravity.                                                                                             |
| GWhiz                 | Experience per hour per skill, and time to a target level.                                                                                                                        |
| HWhat                 | Session profit, with bid/ask pricing modes and the marketplace tax.                                                                                                               |
| IHurt                 | Deaths and deaths per hour, broken down by what killed you.                                                                                                                       |
| JHouse                | House room levels, the inventory against them, recipes, and upgrade cost.                                                                                                         |
| KOllection            | A character score: build score plus net worth across equipment, inventory, market, houses and abilities.                                                                          |
| LYuck                 | Drop luck — how far the session's drops sit from expectation.                                                                                                                     |
| MAna                  | Mana spend per fight.                                                                                                                                                             |
| NTally                | Per-zone tally across the game's fifteen combat zones.                                                                                                                            |
| OPanel                | A configurable overlay: exp/hr, profit, DPS, over-expected drops, luck — pick what shows.                                                                                         |
| PFormance             | CPU and storage monitoring for the suite itself.                                                                                                                                  |
| QCharm                | Charm experience tracking, with the charm-tier percentage guide.                                                                                                                  |
| SCrolling Combat Text | A compact scrolling combat log.                                                                                                                                                   |
| TReasure              | Chest valuation, including cape/quiver/cloak token value and cowbell pricing.                                                                                                     |
| Floating Combat Text  | Damage numbers over the battle panel.                                                                                                                                             |

## What has been taken

Most of the twenty-one are panels. The value is in the analysis behind them, which is pure
computation with no DOM and no game hook and ports cleanly into `src/utils/` with tests.

**Ported.**

- **Drop luck** (`SimpleFFT` line 37999, `CharaFunc` 38073, `CDFDropAnalyzer` 38219,
  `RuckBattleDropAnalyzer` 38292) → `src/utils/drop-luck.js`, `src/utils/complex-fft.js`.
  Builds the characteristic function of a session's income and inverts it through a hand-rolled
  FFT, so "was that unlucky?" gets a percentile rather than a feeling. Toolasha had nothing
  comparable. Validated against an exact binomial and against a Monte Carlo of the drop process.
- **Expected spawns** (`LuckyDropAnalyzer.computeExpectedSpawns` 38568) →
  `src/utils/spawn-expectation.js`. Dynamic programming over a zone's spawn table for the
  expected count of each enemy per wave, which is what turns a drop rate into an expectation.
  Validated against `combat-sim/engine/zone.js`, which samples the same process.

Both now normalise spawn rates by the table's total. The originals read `rate` as a probability;
the game treats it as a weight and divides by the sum when it draws.

**Already in Toolasha, and better — not ported.**

- **Chest EV** and **token-shop valuation** (`_tr_buildChestValueCache` 35014,
  `mcs_tr_calculateTokenValue` 34840). `src/features/market/expected-value-calculator.js` runs
  the same four-round fixed point for chests-inside-chests, but across a worker pool and with
  cowbells, coins and dungeon tokens handled as special cases; `src/utils/token-valuation.js`
  reads the shop from the game's own `shopItemDetailMap` instead of a hardcoded table that goes
  stale whenever the shop changes.

**Not yet assessed.**

- **Enhancement cost** (`mcs_ko_enhancelate`, `mcs_ko_findBestEnhanceStrat`, 19132) — an
  absorbing Markov chain over enhancement levels, solved as `(I − Q)⁻¹`, giving expected attempts
  and expected protections for a target level; the strategy search sweeps the protect-from level
  and prices each. Toolasha has its own enhancement maths in `src/utils/enhancement-calculator.js`
  and `src/features/enhancement/`, so this needs comparing before anything is taken — and this
  version hardcodes the enhancing level, lab level and teas.

## Reading it

It is one 42,000-line IIFE with no module boundaries; panels are methods on a single
`lootDropsTrackerInstance` and communicate through `window` globals and custom events. Grep for
the `createFn` name in the tool list near line 41391 to find any given panel.

This copy came from the author's published script text rather than a download URL, so no upstream
link is recorded here — the version string in the filename and header is the identifier.
