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
