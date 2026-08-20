# Third-party licences

Code in this repository that came from somewhere else, and the terms it came under.

## Scaley Way Idle

`src/features/ui/combat-panel-scale.js` implements the idea behind **Scaley Way Idle** by
Frotty — scaling the two sides of the battle panel independently, and setting the height of
the character panel beside it.

The published script carries no licence, so nothing was copied from it. The feature was
written against Toolasha's own settings, style helpers, and feature lifecycle, and differs
in substance: a single stylesheet in place of a `MutationObserver` sweep that re-set inline
styles on every combat tick, class-prefix selectors in place of pinned CSS-module hashes
that the game regenerates each build, `zoom` in place of `transform` so a shrunk side gives
its space back instead of needing a spacer element and a forced 50/50 split, and per-
character settings in the settings page in place of a floating control panel. The free
repositioning of the two areas by drag handle is not reproduced.

Credit for the idea and for working out which parts of the battle panel are worth resizing
belongs to Frotty.

## MWI Combat Suite

The ports below come from **MWI Combat Suite v0.9.36235** by Frotty, under the MIT licence it
declares in its own userscript header. The script itself is **not kept in this repository** — it
is ~2 MB and 42,155 lines, which is not worth carrying in the history for a file nothing builds
against. `third-party/mwi-combat-suite/` keeps its licence and a record of what was taken and
from which lines of that exact version.

Same author as Scaley Way Idle above, but not the same situation. Scaley Way Idle carries no
licence, so that feature could take the idea and nothing else. This one is MIT, which permits the
code itself to be reused.

Ported so far, all of it the analysis rather than the panels around it:

Beyond the five analysis modules detailed below, the per-file record: **BRead** →
`src/utils/ability-books.js`, `src/features/abilities/ability-book-panel.js`; **DPs** →
`src/utils/damage-attribution.js`, `src/features/combat/damage-tracker.js`,
`src/features/combat/portrait-dps.js`; **IHurt** → `src/utils/damage-taken.js`,
`src/utils/expected-kills.js`, `src/features/combat/damage-taken-tracker.js`; **MAna** →
`src/utils/mana-spend.js`, `src/features/combat/mana-tracker.js`; **GWhiz** →
`src/utils/combat-level.js`, `src/utils/exp-session.js`, `src/features/ui/combat-level-panel.js`,
`src/features/skills/skill-ttl-row.js`; **QCharm** → `src/utils/charm-value.js`,
`src/features/inventory/charm-value-row.js`; **EWatch** → `src/utils/equipment-savings.js`,
`src/features/inventory/equipment-savings-row.js`; **NTally** → `src/utils/watchlist.js`,
`src/utils/drop-sources.js`, `src/features/inventory/watchlist.js`; **HWhat** and the floating
combat text → `src/features/ui/combat-panels.js`, `src/features/ui/combat-text.js`; **OPanel** →
`src/utils/overlay-format.js`, `src/utils/overlay-layout.js`, `src/utils/opanel-config.js`; plus
`src/utils/chest-import.js` and `src/utils/combat-events.js`. Each file's own header names its
source tool.

- `src/utils/drop-luck.js` and `src/utils/complex-fft.js` — the drop-luck analysis, from
  `SimpleFFT`, `CharaFunc`, `CDFDropAnalyzer` and `RuckBattleDropAnalyzer`. The algorithm is
  Frotty's throughout: modelling session income as a product of characteristic functions, the
  three-case discretisation of a drop's count, the guard band and re-basing that contain
  wrap-around, and the shrinking search for a transform window. Restructured into modules with
  the dead FFT twiddle cache dropped and the four-at-a-time vector loops replaced by plain ones
  (they overran any length that was not a multiple of four), and the spawn-table weights are now
  normalised.
- `src/utils/spawn-expectation.js` — the expected-spawn dynamic programme, from
  `LuckyDropAnalyzer.computeExpectedSpawns`. Same states and recurrence; spawn rates normalised
  by the table's total, matching how the game draws.
- `src/utils/combat-drop-model.js` — the drop-rate and quantity arithmetic from
  `RuckBattleData.getDropData` and `LuckyDropAnalyzer.getTierDropRate`: how difficulty tier,
  `combatDropRate`, `combatRareFind`, `combatDropQuantity`, party size and the dungeon multiplier
  turn a table's numbers into the rates a player actually sees.

- `src/utils/chest-tally.js` — the chest ledger from TReasure: fold each opening into a running
  total, compare it against what the drop table owed, and break the verdict down per item. The
  idea and the ledger's shape are Frotty's; the code is written against Toolasha's own storage
  and pricing.

`src/features/ui/overlay-panel.js` takes its shape from OPanel — one overlay with a toggleable,
reorderable row per feature — but none of its code. OPanel is a switch statement with a branch
per row inside a 42,000-line file; this is a registry a feature adds itself to.

`src/features/combat/combat-drop-luck.js` and `src/features/inventory/treasure-tracker.js`
display the results. The panels, their wording and their placement are Toolasha's own — LYuck and
TReasure are floating windows in a suite of twenty-one, while these are a line in the game's own
battle panel and a single panel opened from the settings page.

Deliberately not ported: the chest expected-value fixed point and token-shop valuation.
`src/features/market/expected-value-calculator.js` and `src/utils/token-valuation.js` already do
both, across a worker pool and from the game's own shop data rather than a hardcoded table.

Full terms in `third-party/mwi-combat-suite/LICENSE.md`; what else the script contains in
`third-party/mwi-combat-suite/README.md`.

## KikiMeter

`src/utils/damage-attribution.js`, `src/features/guild/guild-trial-damage.js` and
`src/features/guild/guild-trial-support.js` adopt eight findings from **KikiMeter v3.32.1** by
ZhuLiMoon, under the MIT licence it declares in its own userscript header. **No code was
copied**, and the script is not kept in this repository — it is a single 218 KB file nothing
builds against, and the version number is what makes the attribution checkable.

What was taken is the analysis, all of it reached against real trial captures:

- **Health lost without the monster's hit counter moving is still damage.** A bleed tick and a
  thorns reflect are counted like anything else. Toolasha gated on the counter and discarded
  that volume, which is exactly why its per-player tables disagreed with the party total off the
  boss bar. It is now a labelled event class, kept out of the hit, crit and miss counts.
- **An unsplittable collision is divided, not awarded.** ~13% of trial messages have several
  players acting at once, up to 23 of them; handing the tick to whoever swung most recently is
  an iteration-order artifact. Above three present, it is split equally.
- **Equally, not weighted by damage already confirmed.** ZhuLiMoon tried the weighted version
  and abandoned it — rich-get-richer, 56% mean error against the game's own end-of-trial
  figures. Toolasha took the result rather than repeating the experiment.
- **A lone mana drop stops being evidence in a crowd.** Its field hardening of 26/07 caps the
  mana rung at the same three-player threshold: in a 12–23 player trial most of the roster
  auto-attacks and never touches its mana, so the single member whose mana moved is the only one
  who _could_ leave a trace, not the only one who acted. Above the threshold Toolasha now skips
  the rung and falls through to the equal split.
- **A change in a monster slot's maximum health is a new monster in it.** A guild trial gets
  `new_guild_battle` one to three times an _hour_, so nothing else re-baselines a respawn.
- **A revive is not a heal.** Zero to positive returns a whole bar at once and swamps every real
  cast on the table.
- **`guild_updated.currentTrialsData` is a JSON string** carrying each trial's status, per-party
  `done` flags and `budgetRemainingMs` counting down from exactly 3,600,000 — the one trial
  lifecycle signal that arrives whether or not the guild panel is open, and the basis of both
  the freeze at trial end and the stale-stream fallback.

The code against all of it is Toolasha's own, written into an attribution module that already
existed and differs in substance — counter-first rungs where KikiMeter consults no counters at
all, a per-ability and per-enemy split it does not keep, and the roster read off the game's own
`new_guild_battle` rather than scraped out of the DOM. Its floating meter and history panels are
not reproduced.

Naming each trial row's class is KikiMeter's idea too, and `src/utils/class-inference.js` takes
it. The rules are Toolasha's own and read the game's `abilityDetailMap` — an effect's type, its
`combatStyleHrid` and its `damageType` — rather than matching ability names, so a new ability
classifies itself; every verdict carries the evidence it was drawn from, and a captured stat
sheet's `threat` outranks the stream.

<https://greasyfork.org/scripts/584984>

Full terms in `third-party/kikimeter/LICENSE.md`; what was and was not adopted, in detail, in
`third-party/kikimeter/README.md`.

## mooket II

`src/features/market/mooket/` is adapted from **mooket II** by Q7, used under the MIT
licence. The Chinese-language strings and item dictionaries were replaced with English and
with Toolasha's own game data, the storage moved from `localStorage` to Toolasha's
IndexedDB layer, and the WebSocket interception dropped in favour of Toolasha's existing
hook — but the market history API, the volume-split estimate, and the shape of the price
panel are Q7's work.

<https://greasyfork.org/scripts/531109>

```text
MIT License

Copyright (c) Q7

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MWI Combat Simulator

The simulation engine under `src/features/combat-sim/engine/` (~4,600 lines: combat units,
buffs, consumables, triggers, equipment, monsters, zones, house rooms, and the event queue with
its event classes) is a port of the **[MWI Combat Simulator](https://github.com/shykai/MWICombatSimulatorTest)**
— MIT, Copyright (c) 2024 AmVoidGuy; the KuganDev → AmVoidGuy → shykai line, with vlad among its
contributors. The engine runs in-game inside Toolasha, and the sim-site export format is
implemented beside it. The MIT licence text, with the holder named, is vendored at `third-party/mwi-combat-simulator/LICENSE.md`.

## Enhancelator

The enhancement-strategy search in `src/features/enhancement/tooltip-enhancement.js` follows
**[Enhancelator](https://doh-nuts.github.io/Enhancelator/)** by doh-nuts (MIT) — the per-level
protection matrix, the mixed-strategy minimum, and the `fib()` / `mirrorFib()` breakdown
functions in `src/libraries/enhancement-standalone.js`, which were taken directly. Enhancelator
itself credits MangoFlavor for the underlying game mechanic. The MIT licence text, with the holder named, is vendored at `third-party/enhancelator/LICENSE.md`.

## MWI Ultimate Enhancement Tracker

The enhancement tracker (`src/features/enhancement/enhancement-ui.js`,
`enhancement-handlers.js`, `enhancement-xp.js`) is based on
**[MWI Ultimate Enhancement Tracker v3.7.9](https://greasyfork.org/en/scripts/531872)** by
TheNeroNex (MIT) — its material-cost tracking, XP formulas and panel styling. The MIT licence text, with the holder named, is vendored at `third-party/ultimate-enhancement-tracker/LICENSE.md`.

## MWI Game Commands

The `/item`, `/wiki` and `/market` chat commands (`src/features/chat/chat-commands.js`) are
ported from **[MWI Game Commands (Item/Wiki/Market)](https://greasyfork.org/en/scripts/563313)**
by salairkas (MIT). The MIT licence text, with the holder named, is vendored at `third-party/mwi-game-commands/LICENSE.md`.

## Labyrinth Clear Rate Calculator

Parts of `src/features/combat/labyrinth-room-logs.js` — and material consulted throughout the
labyrinth simulator — are ported from the
**[Labyrinth Win Rate Calculator](https://greasyfork.org/en/scripts/566829)** by dakonglong
(MIT). The MIT licence text, with the holder named, is vendored at `third-party/labyrinth-clear-rate/LICENSE.md`.

## MWITools - Extended

The settings-tab injection (`src/features/settings/settings-ui.js`) and the per-action output
totals (`src/features/actions/output-totals.js`) are based on
**[MWITools - Extended](https://greasyfork.org/en/scripts/540440)** by byteArray567
(CC-BY-NC-SA-4.0 — the same licence as this project, so ShareAlike is satisfied by the project
licence itself; this entry is the attribution the BY clause requires). No separate licence file
is vendored because the licence is identical to this repository's own.

## Edible Tools

The loot-log statistics (`src/features/actions/loot-log-stats.js`) are ported from
**[Edible Tools](https://greasyfork.org/en/scripts/499963)** by Truth_Light (CC-BY-NC-SA-4.0 —
same licence as this project; this entry is the attribution the BY clause requires).

## mooket I

The mooket I pooled market-history endpoint by **IOMisaka** is one of the two sources the
History panel can read from (`src/features/market/mooket/market-history-api.js`). Endpoint use
only; no code was taken.

## JIGS

**[JIGS](https://greasyfork.org/en/scripts/550346)** by jigglymoose is credited for ideas behind
the upgrade advisor, and Toolasha emits JIGS-compatible markers/library exports for
interoperability. Ideas only — no code was taken, which is why nothing is vendored here. The
same applies to **Milkonomy** by hyhfish and the **Character Sheet** by Tib: Toolasha writes
their export/URL formats for interoperability, taking no code.
