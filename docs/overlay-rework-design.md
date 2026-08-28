# Overlay layout rework: from placed pixels to browser-native flow

Status: proposal, for approval section by section. No code changed.

The row-provider contract does not change. What changes is everything underneath it: the layout and
persistence layer is replaced with a CSS grid whose tiles sit in document order with a column span and a
natural height. Persistence becomes order, span, visibility and per-tile text size. Dragging a tile
anywhere becomes dragging it into place in the flow.

## 1. Problem statement: four geometries, one panel

A tile's rectangle is computed four separate times, by four separate mechanisms, and the bugs live in the
seams between them.

| Stage        | Where                                                                                 | What it produces                                                         |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Saved        | `settings.positions` / `settings.sizes`                                               | Pixel `{x, y}` and `{width, height}` per row key                         |
| Materialized | `resolveLayout` + `clampTile` + `findFreeSpot` (`overlay-layout.js:174`)              | A rectangle per visible row, with anything unplaced invented on the spot |
| Settled      | `_settleToContent` → `settleLines` (`overlay-panel.js:2748`, `overlay-layout.js:572`) | The same tiles, shrunk to what they drew and closed up by whole lines    |
| Flowed       | `_needsFlow` / `squeezeToWidth` / `_flowTiles` (`overlay-panel.js:2524`–`2586`)       | A different arrangement entirely, when the saved one is too wide         |

`_drawBody` (`overlay-panel.js:2634`) runs `_adoptPlacements`, then `_layout()`, then draws every row, then
runs `_layout()` **again** with the empty tiles skipped and resized, then runs `_settleToContent`, which
measures every tile's children with `offsetTop + offsetHeight` (`_drawnHeight`, line 2787) and lays out a
third time. Once a second. The panel is doing, in JavaScript, the measure-and-reflow that the browser's
layout engine exists to do.

Every one of the six recent rounds is a seam between two of those stages:

1. **`45195dc7` — tiles stop jumbling as they come and go.** A tile with no saved position was placed
   against whichever tiles happened to be on screen _that tick_, and the result was thrown away. Two
   fixes: placement restricted to corners of the existing arrangement (`findFreeSpot`), and the result
   written down (`_adoptPlacements`, line 2840). Saved geometry and materialized geometry had disagreed,
   so the fix was to make materialization write itself back into the save.
2. **`d6b7e1d6` — an empty tile keeps its slot instead of leaving a hole.** `auto` stopped hiding
   measurements. The reasoning is recorded in `overlay-rows.js:272`: hiding is right for a list and wrong
   for a grid, "where the arrangement is the point", because a vanished tile leaves its coordinates
   behind as a hole.
3. **`af57604c` — lines close up to what their tiles actually drew.** `settleLines`: a third geometry,
   applied only when the layout is provably line-structured, declining otherwise (`overlay-layout.js:585`).
4. **`77d404be` — the overlay stops reflowing itself when a scrollbar appears.** `clientWidth` shrinks by
   the scrollbar, which pushed a fitted two-column layout over the edge, which fired `_needsFlow`, which
   made the panel shorter, which removed the scrollbar. An oscillation once a second. Fixed by measuring
   the border box and reserving scrollbar width _unconditionally_ (`_canvasWidth`, line 2436).
5. **`d3304864` — a layout a few pixels too wide is squeezed, not dealt into one column.** The same
   width sensitivity from the other side: a sixteen-pixel change in reserved gutter turned every saved
   two-column layout into one column. `squeezeToWidth` is a fifth geometry bolted on to absorb it.
6. **`e4974139` / `8f579df1` — the strip stays in its own cell; tiles sharing a line are drawn to the
   same height.** Consequences of the previous two: a compact tile is a different height from its
   neighbour, and nothing in a coordinate model makes two tiles agree on a height unless it is computed
   and written into both.

Two further commits belong to the same story: `4460e2bb` (a preset must switch off the rows it does not
name, or a preset is the union of two layouts) and `b18f93a4` (activity read from the action queue rather
than from stale history).

The pattern is one thing: **pixel coordinates are a derived quantity being stored as a source of truth**.
They depend on panel width, on scrollbar presence, on what each row happened to draw this second, and on
which neighbours exist — none of which is knowable when the coordinates are written. Every round adds
another correction pass that reconciles stored pixels against present reality, and every pass is a new
seam. A fifth geometry would fix the next report and create the round after it.

The new model stores only what the player actually decided — _this tile before that one, this tile twice
as wide_ — and lets the browser derive the pixels every frame, for free, correctly, at the width that
exists right now.

## 2. The new model

### 2.1 Settings schema

Version 2 of the per-character `overlayPanel` record (`STORAGE_KEY`, `overlay-panel.js:139`, scoped per
character; the named-layout library stays global and unscoped).

```js
{
    version: 2,
    order: ['netWorth', 'coins', ...],   // reading order; the layout itself
    span: { netWorth: 1, luck: 2 },      // integer columns, 1..MAX_SPAN, absent = 1
    visible: { [key]: boolean },
    zoom: { [key]: percent },            // per-tile text size, unchanged
    locked: true,
    separators: true,
    textScale: 100,
    emptyTiles: 'auto',
    curatedDefaults: true,
    autoSwitchLayout: false,
    layoutActivity: { [layoutName]: activity },
    open: false,
    docked: false,
    dockHeightPx: null,

    // Absent until first toggled, and not layout at all: these are row-render
    // options read cross-bundle through `rowOption()` (overlay-rows.js:464).
    // They must keep round-tripping through this record.
    expectedOnlyNumbers, expectedOnlyPlayer, luckOnlyNumbers, luckOnlyPlayer,
}
```

Removed: `positions`, `sizes`, `snapToGrid`. Everything else is carried over untouched.

The four `*Only*` flags deserve the comment they are given: they live in this object but are read from the
combat bundle via the bundle-bridge global, so a rewrite that rebuilds the settings object from a narrower
schema silently switches four row options off. They are not layout and must simply survive.

Three sibling records are **not touched by this rework**: the panel's own frame geometry (`panel-geometry.js`,
key `overlayPanel`, global rather than per-character), the named-layout library (`overlayLayouts`, global),
and the dock state carried in the settings record above.

`order` already exists and already resolves correctly against a changing registry — `resolveRows`
(`overlay-rows.js:393`) handles a key for a row that no longer exists and a row no saved order has heard
of. It stops being an advisory ordering for the row picker and becomes the layout.

### 2.2 The grid

The canvas becomes a grid container:

```css
display: grid;
grid-template-columns: repeat(var(--overlay-columns), minmax(0, 1fr));
gap: 4px;
align-items: stretch;
scrollbar-gutter: stable;
```

Tiles are appended in `order` and carry `grid-column: span min(span, N)`.

| Constant     | Value | Why                                                                                                                                                          |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COLUMN_MIN` | 220px | Between today's `MIN_DESIGNED_COLUMN` (170) and `MIN_FLOW_COLUMN` (240); the default 480px panel yields exactly 2 columns, which every preset is written for |
| `GAP`        | 4px   | Today's `FLOW_GAP`                                                                                                                                           |
| `MAX_SPAN`   | 4     | A span nobody can exceed, so a stored span is always meaningful                                                                                              |

`columnsFor(width) = clamp(1, floor((width + GAP) / (COLUMN_MIN + GAP)), MAX_SPAN)`

Default canvas (480 panel, ~452 canvas) gives 2. A 700px panel gives 3. A phone at 370 gives 1, which is
`ONE_COLUMN_WIDTH`'s behaviour without `ONE_COLUMN_WIDTH`, without `_needsFlow`, and without a separate
code path that has to disable dragging.

**`N` is the only measured quantity in the entire system.** It is computed once per panel resize from a
`ResizeObserver`, not once per tick, and written to `--overlay-columns`. This is what closes round 4 and
round 5 permanently: `N` is an integer, so a fifteen-pixel change in width cannot change it except exactly
at a boundary — and with `scrollbar-gutter: stable` the width does not change when a scrollbar arrives at
all. There is no quantity that both depends on tile height and feeds back into tile width. The
oscillation is not fixed; it is unrepresentable.

`scrollbar-gutter: stable` is already set (`overlay-panel.js:599`). It is not sufficient today only
because `_canvasWidth` still feeds a placement computation; once nothing places anything, it is.

### 2.3 Tile lifecycle

Heights are natural. `align-items: stretch` is the default and is kept, which means every tile in a grid
row is drawn to the height of the tallest in it — the requirement `8f579df1` established, granted by the
layout engine rather than computed and written into both tiles.

Every tile carries `min-height` from its row's `defaultSize.height`. This does three jobs: it gives the
watchlist and equipment-watch tiles the room the preset height hints used to buy them, it stops a tile
whose content changes every second from resizing the grid under the reader, and it means a tile's height
only ever grows past a floor the row itself declared.

| State            | Rendering                               | Grid effect                                                 |
| ---------------- | --------------------------------------- | ----------------------------------------------------------- |
| Drawn            | Content, at its natural height          | Row height is the tallest tile in it                        |
| Empty, `compact` | A dim strip carrying the row's own name | Row shrinks to the strip if it is the tallest thing gone    |
| Empty, `full`    | The row's placeholder line              | As drawn                                                    |
| Hidden           | `display: none`                         | **The tile leaves the flow; everything after it closes up** |

The last line is the change worth arguing.

**Recommendation: keep the compact strip as the `auto` default, but rewrite its rationale.** The
justification recorded at `overlay-rows.js:272` — that hiding leaves a hole in a grid with saved positions
— is _no longer true_. There are no saved positions and there is no hole; `display: none` on a grid item
closes the flow perfectly. Every reason that comment gives for compacting evaporates with this rework.

What survives is a different and still good reason: the strip is identity and reachability. It says the
tile is switched on and waiting rather than broken (which is exactly the report `waitingLine` and
`justEnabled` exist to answer, `overlay-rows.js:327`), and for a watch tile with an `onOpen` it is the
click target that fills it. So `compact` stays the default on the merits, `hide` stops being a trap and
becomes a genuinely good option for anyone who wants it, and the doc comment must be rewritten rather than
carried across — a stale rationale citing a mechanism that no longer exists is how the next round starts.

### 2.4 Where each gear-popover option lands

| Control                                                     | Line                 | Fate                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Snap to 10px grid`                                         | 1921                 | **Obsolete — delete.** There are no pixel coordinates to snap. Retires `GRID`, `snap`, `snapUp`                                                                                                                                                                                                             |
| `Separators`                                                | 1923                 | Unchanged; a CSS border on the tile                                                                                                                                                                                                                                                                         |
| `Empty tiles` (By tile / Compact / Hide / Full)             | 1881–1911            | Unchanged in the UI; `hide` becomes free rather than harmful (2.3)                                                                                                                                                                                                                                          |
| `Text −/+` (global `textScale`)                             | 1952–1963            | Unchanged                                                                                                                                                                                                                                                                                                   |
| Per-tile text size (`settings.zoom`)                        | 3338                 | Unchanged; still the hover −/+ on an unlocked tile                                                                                                                                                                                                                                                          |
| `Autogrid`                                                  | 1965                 | **Vanishes.** "Repack every tile from the top left, in order" is now the permanent, only state. Retires `autoGrid`, `gridColumns`, `columnWidth`, `_autoGrid`, `_packVisible`                                                                                                                               |
| `Import layout`                                             | 1968                 | Kept; reads v1 and OPanel files through the migration in section 5                                                                                                                                                                                                                                          |
| `Export layout`                                             | 1973                 | Kept; writes order/spans natively and synthesises pixels for OPanel compatibility (section 5)                                                                                                                                                                                                               |
| `Reset layout`                                              | 1977                 | Kept; now "forget the order, spans and text scales" — applies the Default preset                                                                                                                                                                                                                            |
| `Undo`                                                      | 1985                 | Kept, and the snapshot gets smaller (`order`, `span`, `visible`, `zoom`, `textScale`, `curatedDefaults`)                                                                                                                                                                                                    |
| Lock / unlock (🔒)                                          | 1998                 | Kept; now gates drag-to-reorder and the span handles instead of free drag and pixel resize                                                                                                                                                                                                                  |
| Named layouts: `Switch to…` / `Save as…` / `Delete`         | 1415–1464            | Unchanged. The file contents change shape; the machinery does not                                                                                                                                                                                                                                           |
| `Switch layout with activity` + `Use for:`                  | 1489–1518            | **Entirely untouched.** `decideAutoSwitch`, `layoutForActivity` and `pauseForManualChoice` are pure functions over layout _names_; they never see geometry                                                                                                                                                  |
| Row picker checkboxes and ◀▶                                | 1818–1824, `moveRow` | Kept, and promoted: `moveRow` (`overlay-rows.js:439`) already operates on the full order and now literally moves a tile in the layout. It becomes the keyboard-reachable path to reordering                                                                                                                 |
| Row picker's `settings.order = resolved.map(…)` side effect | 1347                 | **Must change.** `_renderPicker` currently rewrites the whole order as a side effect of drawing itself. Harmless when order is advisory; when order _is_ the layout, opening the gear would rewrite the arrangement. The materialization has to move to load, where `resolveRows` already does it correctly |
| `Reset to default tiles`                                    | 1364                 | Unchanged                                                                                                                                                                                                                                                                                                   |
| Luck / Expected sub-options                                 | 1929–1948            | Untouched; they are row options, not layout                                                                                                                                                                                                                                                                 |
| Flow hint ("too narrow for the saved arrangement…")         | 1991                 | **Deleted.** There is no narrow fallback to explain, because there is no arrangement that can fail to fit. Retires `this.flowing`, `wasFlowing`, `_noteFlowChange`                                                                                                                                          |

## 3. Arranging UX

**Drag to reorder.** Unlocked, dragging a tile moves it through the flow. The pointer-down / move / up
machinery of `_attachTileDrag` (`overlay-panel.js:3220`) is kept; what changes is the arithmetic between
them. Instead of `snap` + `clampTile` writing `settings.positions[key]`, the move handler finds the tile
whose midpoint the pointer is nearest and, when that is a different slot, splices `order` and re-appends
the DOM in the new order. Pointer-up saves `order`. The dragged tile is drawn lifted and semi-transparent
in place; the others slide because the grid reflows.

This deletes the whole class of bug where a drag lands a tile somewhere no arrangement can express. A drop
is a position in a list; there is no invalid one.

**Span resize.** The corner grip becomes a right-edge handle that steps the span between 1 and `min(N,
MAX_SPAN)`, snapping to column boundaries as it drags. Height is not resizable, because height is content.
`settings.span[key]` is written on pointer-up. `MIN_TILE`, `COMPACT_TILE` and the pixel width/height
arithmetic in `_attachTileResize` (line 3288) all die.

**Keyboard and touch.** The row picker's ◀▶ remain a full reordering path, which is the accessible one —
today they reorder a list that the layout ignores. On touch, `touch-action: none` while unlocked already
exists (line 2898) and keeps working.

**What is lost.** Freeform pixel placement: a deliberate gap, a tile inset from the column edge, two tiles
five pixels apart, an arrangement that is not made of rows. `settleLines` already refuses to touch such
layouts (`overlay-layout.js:585`), which is a fair measure of how much the current system can do with them
— they are the layouts every recent fix had to carve an exception for.

**What is gained.** Tiles cannot overlap, cannot be dropped off-canvas, cannot be hidden underneath one
another, and cannot arrive unplaced. A layout is width-independent, so the same saved arrangement is
correct on a desktop and on a phone with no second code path. Empty tiles close up instead of leaving
holes. DOM order matches reading order, so the panel becomes tabbable and screen-reader-coherent for the
first time. And the panel stops measuring itself once a second.

## 4. Presets, re-expressed

Each preset becomes `{ activity, order, span }`; visibility stays derived exactly as it is today (every
registered row off, then the preset's own rows on — `overlay-layouts.js:490`, the fix from `4460e2bb`).
The translation is mechanical because every existing line is either two one-column tiles or one tile
spanning the width, which is the rule `PRESET_GRIDS` already held itself to (`overlay-layouts.js:288`).

| Preset    | Activity    | Order                                                                                                                                         | Span 2                                          |
| --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Combat    | `combat`    | combatStatus, battleTimer, dps, deathsPerHour, manaPerFight, treasure, combatRevenue, luck, combatSession, consumables                        | combatRevenue, luck, combatSession, consumables |
| Skilling  | `skilling`  | skillLevel, timeToLevel, experiencePerHour, queueTimeLeft, coins, totalProfit, consumables, houses                                            | consumables, houses                             |
| Labyrinth | `labyrinth` | combatStatus, dps, deathsPerHour, manaPerFight, treasure, combatSession, combatRevenue, replayCheck, consumables                              | combatRevenue, replayCheck, consumables         |
| Market    | `market`    | netWorth, coins, inventoryValue, marketListings, skillBooks, watchlist, equipmentWatch                                                        | skillBooks, watchlist, equipmentWatch           |
| Default   | `none`      | netWorth, coins, inventoryValue, buildScore, combatLevel, combatStatus, experiencePerHour, timeToLevel, dps, deathsPerHour, luck, totalProfit | luck, totalProfit                               |

`gridOrder` is no longer needed to derive `rows` from the grid, because the order _is_ the data — which
removes the disagreement it was written to prevent (`overlay-layout.js:407`).

Two things drop out. The `{ cells, height: 70 }` hints on the Market watch lists are replaced by the
`min-height` floor from each row's own `defaultSize.height` (section 2.3), which is where that knowledge
belonged in the first place — the panel was guessing on the row's behalf. And `null` gap cells are gone;
no preset uses one.

On a one-column panel a span of 2 clamps to 1 and the order is unchanged, so the presets are correct on a
phone with no narrow-mode branch. `materializeGrid`, `PRESET_CANVAS_WIDTH` and the whole
"build against the canvas the player has" apparatus disappear: a preset is no longer a function of width.

## 5. Migration

One-way, at load, when a saved record has no `version` field.

```text
migrate(v1):
  tiles = [ {key, x, y, w, h} for each key in v1.positions with a size ]

  # 1. the column unit the old layout was built on
  edges = sorted(unique( x for tiles ) + [ max(x + w) ])
  unit  = min positive difference between consecutive edges,
          or max(x + w) when there is only one edge
  W     = max(x + w)
  C     = clamp(round(W / unit), 1, MAX_SPAN)

  # 2. spans from widths
  span[key] = clamp(round(w / unit), 1, C)

  # 3. order from position: sweep into lines, then read each line left to right
  sort tiles by y
  group into lines: a tile joins the current line if y < (line top + line height)
  order = for each line, its tiles sorted by x

  # 4. carry across untouched
  visible, zoom, textScale, separators, locked, emptyTiles,
  curatedDefaults, autoSwitchLayout, layoutActivity
```

The line sweep, rather than a bare `sort by y then x`, because a two-column layout whose tiles differ by a
pixel of `y` would otherwise interleave its columns. It is the same "does this layout consist of lines"
judgement `settleLines` makes (`overlay-layout.js:601`), and like it, it is pure and unit-testable.

Worked example — the Combat preset as saved today on a 440 canvas: edges are `{0, 220, 440}`, so
`unit = 220`, `W = 440`, `C = 2`. `combatStatus` at `x=0 w=220` gives span 1; `combatRevenue` at `x=0
w=440` gives span 2. The sweep yields the preset's own reading order. The migration reproduces the preset
exactly.

**Preserved:** which tiles are on, their reading order, relative widths as spans, per-tile text sizes,
global text size, separators, lock, empty-tile policy, curated-defaults flag, named layouts, activity
mappings, panel geometry and dock state.

**Lossy:** exact pixel coordinates and heights, deliberate gaps and insets, overlapping or non-line
arrangements (their order is recovered but their spacing is not), and `snapToGrid`.

**Rollback.** The v1 record is copied verbatim to a sibling key `overlayPanel.v1` (same store, same
character scoping) before the v2 record is written, and never read by v2 code. A rolled-back build reads
`overlayPanel` and finds… a v2 record it does not understand, so the migration must write v1's untouched
copy back under the original key on rollback. Simpler and recommended: **v2 writes to a new key
`overlayPanelV2` and leaves `overlayPanel` alone entirely.** A rollback is then a build swap with no data
step, v1 data survives indefinitely at no cost, and the only price is one dead key to remove in a later
release. Named layouts are migrated on apply rather than in bulk, so the global library keeps working for
both builds.

**Import/export.** `fromOPanelConfig` (`opanel-config.js:107`) still yields `positions` and `sizes`, from
either OPanel's section or a v1 `toolasha` section; both go through the same `migrate` above, so importing
an old file costs no new code. Export writes a `toolasha` section at `version: 2` carrying `order` and
`span`, and — to keep the round trip to MWI Combat Suite alive — synthesises OPanel-shaped
`config.positions` / `config.sizes` from order and spans against `PRESET_CANVAS_WIDTH`. That synthesis is
the only place pixel arithmetic survives, it is about twenty lines, and it is pure.

## 6. Provider-contract audit

`registerRow` is unchanged. Every production call site works as written.

There are **39** module-level or init-time `registerRow` call sites across 35 feature files (35 at module
scope; `accountView`, `guildRoster`, `guildTrialLedger` and `predictionCalibration` register inside their
feature's setup). The brief said 38; the discrepancy is worth a glance before implementation, but every
one of the 39 was checked and none needs a change.

| Field                                                                                             | Pixel-dependent? | Under flow                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`, `name`, `render`, `version`, `defaultVisible`, `onOpen`, `empty`, `tileClass`, `whenEmpty` | No               | Unchanged                                                                                                                                                                                                                                                                              |
| `defaultZoom`                                                                                     | No               | Unchanged — per-tile text size                                                                                                                                                                                                                                                         |
| `defaultSize.width`                                                                               | **Yes**          | Seeds the initial span for a row with no saved one: `clamp(round(width / COLUMN_MIN), 1, MAX_SPAN)`. Today's widths run 130–280, so everything seeds to span 1 except `combatRevenue` (280) which seeds to 1 as well — the presets, not the defaults, are what give a tile two columns |
| `defaultSize.height`                                                                              | **Yes**          | Becomes the tile's `min-height` floor (section 2.3) rather than its height                                                                                                                                                                                                             |

`defaultSize` is passed by all 39 sites and is the _only_ pixel-shaped field in the contract. Neither
half is dropped; both are reinterpreted, and both reinterpretations are more honest than what they meant
before — a row saying "I need about 200 across and at least 30 down" is exactly what a span seed and a
min-height are.

Three render-path assumptions need attention, none of them in the contract:

1. **`CONTENT_STYLE` sets `height: '100%'`** (`overlay-panel.js:211`). Against a natural-height tile this
   must become `height: auto` with `min-height: 0`, or a row that styles its content box as a flex column
   will collapse. This is the single concrete change to how a provider's output is hosted.
2. **Rows that draw aligned columns** (`row`, `alignedRows` — the shapes `CONTENT_STYLE` is restored
   around) size themselves from the container's width. Under grid the width comes from the span, and
   `minmax(0, 1fr)` is what keeps a long unbreakable string from forcing the track wider than its share.
   `minmax(0, 1fr)` rather than `1fr` is load-bearing and must not be simplified.
3. **`_drawnHeight`'s measurement cache** (`tile._contentHeight`, `tile._redrawn`, line 2787) is deleted
   along with the function. `_redrawn` is also read by nothing else; `_version` and `_wasEmpty`, which
   drive the per-row redraw skip in `_drawRow` (line 2941), are untouched and keep working.

Segments with a title, and `tile._content`, carry no geometry — they are DOM structure, and they are
untouched. The panel never sees a segment: `Segment`, `drawLine`, `row`, `rows` and `alignedRows` are a
convention of `overlay-format.js` that rows import for themselves, and the only "height hint" that has
ever existed is `defaultSize.height` plus the preset grids' per-line `height`. Both are addressed above.

`_resetContent` (line 3074) — wiping `cssText` and re-applying `CONTENT_STYLE` before the panel draws a
strip or a placeholder into a box some row left styled as a three-column grid — is load-bearing and
survives unchanged. It is the fix from `e4974139` and it is orthogonal to layout.

## 7. Risks and open questions

| #   | Risk / question                                                                                                                      | Recommendation                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Natural heights + a 1s redraw could make the grid jitter as content grows and shrinks                                                | The `min-height` floor from `defaultSize.height` damps this to the case where a tile genuinely exceeds what its author expected. Accept, and watch `combatText` and `consumables` in live testing        |
| 2   | Losing freeform placement will annoy whoever arranged pixels deliberately                                                            | Accept, and say so in the changelog. `overlayPanel` v1 data is retained (section 5) so a rollback is a build swap. The layouts this loses are precisely the ones `settleLines` already declines to touch |
| 3   | Drag-to-reorder is a different gesture from drag-anywhere; muscle memory breaks                                                      | Accept. Mitigate with the unlocked hint text, which is already rewritten in this design, and by keeping the ◀▶ path in the row picker                                                                    |
| 4   | Does `span` need to vary by column count?                                                                                            | No. Clamping to `N` is sufficient and is what makes one saved layout correct at every width. Do not add breakpoints                                                                                      |
| 5   | Should `hide` become the `auto` default now that it is free?                                                                         | No — keep `compact`. See 2.3; the reasoning changes but the answer does not                                                                                                                              |
| 6   | Do we still need `MIN_TILE`, `GRID`, `snapToGrid` anywhere?                                                                          | No. Confirm by deletion; the build will find any straggler                                                                                                                                               |
| 7   | OPanel export fidelity — is synthesising pixels worth ~20 lines?                                                                     | Yes. Interoperability with MWI Combat Suite is a stated goal of `opanel-config.js` and a one-way export break is a poor trade for twenty pure lines                                                      |
| 8   | `COLUMN_MIN = 220` is a judgement call                                                                                               | Verify live at 480 (must be 2), 700 (3) and 370 (1). If the default panel ever reads as 1 column, the whole preset set is wrong; this is the first thing to check in phase 2                             |
| 9   | Column count via `ResizeObserver` while docked, where height is driven by the tiles                                                  | The dock sets height, not width, so `N` is unaffected. Confirm in `overlay-panel.dock.test.js`                                                                                                           |
| 10  | `_renderPicker` writes `settings.order` as a side effect of drawing (line 1347)                                                      | **Must be fixed as part of phase 2**, not left. Opening the gear would otherwise rewrite the layout. Move the materialization to load                                                                    |
| 11  | The four `*Only*` row options live in the settings record but are read from another bundle                                           | Do not rebuild the settings object from a narrow v2 schema; merge over the loaded record as `initialize` already does (line 467)                                                                         |
| 12  | Presets currently arrive **locked** on purpose — "somebody else's arrangement arriving under your cursor" (`overlay-layouts.js:501`) | Keep. Nothing about flow changes that reasoning                                                                                                                                                          |

## 8. Implementation plan

### Phases

| Phase | Content                                                                                                                                                                                                                          | Verification                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0     | New `src/utils/overlay-flow.js`: `columnsFor`, `spanFor`, `migrate` (unit derivation, span derivation, line sweep). No DOM                                                                                                       | **Pure unit tests.** This is where the migration's awkward cases live and all of them are testable |
| 1     | Presets re-expressed as `{activity, order, span}`; `overlay-layouts.js` loses `materializeGrid`/`PRESET_CANVAS_WIDTH`, keeps names, storage, presets and auto-switching                                                          | **Pure.** Most of `overlay-layouts.test.js` survives with the geometry assertions rewritten        |
| 2     | Render path: canvas becomes a grid, `_styleTile` sets `grid-column` and DOM order, `--overlay-columns` from a `ResizeObserver`. Delete the second layout pass, `_settleToContent`, `_adoptPlacements`, the flow/squeeze branches | **Live.** Column count at three widths; a tile going empty and filling in; a scrollbar appearing   |
| 3     | Arranging: drag-to-reorder, span handle                                                                                                                                                                                          | **Live**, plus happy-dom tests for the order splice, which is pure given a pointer position        |
| 4     | Popover cleanup (drop Snap and Autogrid, rewrite hints), import/export v2, migration wired at load                                                                                                                               | Mixed; the import path is testable pure                                                            |
| 5     | Delete the dead machinery and rewrite the tests it owned                                                                                                                                                                         | `npm test`, `npm run lint`, `npm run build:dev`                                                    |

### What gets deleted

From `src/utils/overlay-layout.js` (706 lines; survivors are `clampZoom` and the zoom constants, so this
file is very likely replaced outright by `overlay-flow.js`):

`GRID`, `DEFAULT_TILE`, `MIN_TILE`, `COMPACT_TILE`, `snap`, `snapUp`, `overlaps`, `findFreeSpot` (corner
placement), `clampTile`, `resolveLayout`, `compactColumns`, `columnWidth`, `gridColumns`, `autoGrid`,
`MIN_DESIGNED_COLUMN`, `normalizeLine`, `gridOrder`, `materializeGrid`, `toMaps`, `settleLines`,
`SQUEEZE_LIMIT`, `squeezeToWidth`, `contentBounds`.

From `src/features/ui/overlay-panel.js`:

`_adoptPlacements`, `_packVisible`, `_autoGrid`, `_layout`'s flow branches, `_needsFlow`, `_flowTiles`,
`_flowColumns`, `_savedExtent`, `_settleToContent`, `_drawnHeight`, `_importWidth`, `_fitSizes`, the
second layout pass in `_drawBody`, `_canvasWidth`'s scrollbar arithmetic, `_noteFlowChange`, the canvas
width/height assignment at the end of `_drawBody`, the pixel arithmetic inside `_attachTileDrag` and
`_attachTileResize`, and the constants `ONE_COLUMN_WIDTH`, `MIN_FLOW_COLUMN`, `FLOW_GAP`,
`SCROLLBAR_RESERVE`, `TILE_CHROME`, plus the `this.flowing` / `this.wasFlowing` / `tile._contentHeight` /
`tile._redrawn` state.

Two consequential simplifications fall out. `get isEditable()` becomes `!this.settings.locked` — the
`&& !this.flowing` term exists only because flowed tiles must not be dragged, and there is no flow.
And the "returns the identical array" convention that `settleLines` and `squeezeToWidth` use to signal
"declined to act", which callers branch on (`squeezed !== roomy`, line 2477), disappears with both
functions; nothing else in the codebase uses it.

The existing `ResizeObserver` on the panel (lines 642–652) is kept and gets simpler: instead of comparing
`lastCanvasWidth` to decide whether a full redraw is needed, it recomputes `N` and writes
`--overlay-columns`, and only a change of `N` needs anything further. The redraw loop it guards against —
the draw writing `canvasEl.style.width`, which the observer then sees — cannot occur, because the canvas
no longer has its width written to it.

From `src/features/ui/overlay-layouts.js`: `PRESET_GRIDS`'s cell-and-span notation, `registrySizes`,
`PRESET_CANVAS_WIDTH`, and `materializeGrid`'s call site.

Settings fields retired: `positions`, `sizes`, `snapToGrid`.

### Tests

`overlay-panel.narrow.test.js` (~600 lines) and most of `overlay-panel.stability.test.js` describe
behaviours that become structurally impossible — no two tiles can overlap, nothing can be drawn past the
right edge, nothing needs settling. They are deleted and replaced by a much smaller set asserting the
grid's column count and that a saved layout is width-independent. `overlay-panel.empty.test.js`,
`.picker.test.js`, `.dock.test.js`, `.redraw.test.js`, `.layouts.test.js` and `.autoswitch.test.js` survive
with their coordinate assertions rewritten as order and span assertions. `overlay-rows.test.js` is
untouched.

Two harness properties established by `b18f93a4` must be preserved when these tests are rewritten: the
storage double has to answer reads from the same store the writes went to (it previously returned `null`
unconditionally, so the panel always started from defaults and reload could not be tested at all), and
tests must read the tiles off the canvas rather than off `settings.order` filtered by `settings.visible` —
that pair "was telling the truth while the panel drew something else". The second matters more, not less,
under the new model, since order and visibility are now the whole of the layout and it would be very easy
to write a suite that only ever checks its own inputs.

### Rough size

Deletions dominate: roughly 1,300–1,600 lines removed across the three modules and their tests, against
roughly 500–700 added (`overlay-flow.js`, the grid render path, drag-to-reorder, migration, new tests).
Net around −800. The provider-side of the codebase — all 39 `registerRow` call sites — is not touched at
all.
