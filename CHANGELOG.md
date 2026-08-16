# Changelog

## Fork Changelog (Millennium44/Toolasha)

All changes to this fork since diverging from upstream (Celasha/Toolasha at v2.84.0, commit `77e9ddb`). Newest first. Every pushed change must be recorded here in the same commit that makes it. Upstream release history is preserved below.

## Unreleased — branch `main`

### Lab Sim: `Toolasha.Debug.monsterAbilityData()` — dump a monster's raw ability kit

Read-only console diagnostic for tracing a cadence gap (the sim casting an ability more or less often than the real fight). Given a monster hrid (or the last tick-capture's monster), it prints the ability array **in cast order** — which is the sim's cast priority — with each ability's cooldown, its `defaultCombatTriggers` (the gates that decide when it fires), the buff uniqueHrids it applies, and any keys on the monster's ability entry the sim ignores. Pairs with the uptime harness: the harness localises which ability is over/under-cast, this shows the data that drives it.

### Lab Sim: player build check — the sim's build of your character next to your live stats

Closes the player-init gap. Every other check verifies how the sim builds the _monster_; none looked at how it builds _you_ — the gear, ability levels and persistent buffs (teas/community/guild/house) that decide your damage and mitigation. A **"Check my build"** button in the Monster Stat Check panel runs a one-fight sim probe and reads back the sim player's resolved `combatDetails` at the one faithful moment (first combat start, after `generatePermanentBuffs()` + `reset(0)`, before any transient combat buff), then diffs it field-by-field against your live in-game stats from clicking yourself in combat. Both sides carry the persistent buffs, so a `⚠ off` row is a real build difference — a gear, ability-level or buff-init gap — not a "which side has the buff?" question. Reads at fight start, so a transient combat buff (fury) or a monster debuff on you shows as an expected gap. Needs the same flag-gated capture hook pattern as the blind sim, off for every normal sim (`combat-simulator.js` snapshots the player build only when the probe asks).

### Lab Sim: uptime harness — the monster's incoming damage, per ability, real vs sim

Closes the last diagnostic gap: **timing**. The stat check and blind sim confirm the sim's stats and buff production; neither can see how often a monster casts or how long its buffs stay up — which is what a "monster deals more damage than predicted" gap comes down to. `Toolasha.Debug.uptimeHarness()` decomposes the monster's incoming damage per ability from a tick capture (attack-counter rises named by the ability prepared the tick before; health falling with no attack is damage-over-time) and compares it against the sim's own per-ability attack histogram (already in `SimResult.attacks`, no engine change). The comparison is unit-free — cast share, damage share, mean damage per cast — so a `sim-under` on one ability points straight at a cadence or buff-uptime gap for that ability. Run it from a **"Run uptime harness"** button in the Monster Stat Check panel (or `Toolasha.Debug.uptimeHarness()`): with no capture yet for that monster the button **arms a tick capture on the spot** — fight the monster, then click again and the per-ability table renders in place. No separate Capture step. The copy button and the panel export include the result.

### Monster stat check: the game's live stats next to the sim's

New opt-in diagnostic (off by default, under Combat Features). With it on, clicking a monster in combat opens a floating panel that reads the game's live combat stats from the `battle_unit_fetched` message and compares them field-by-field against what the combat sim computes for the same monster — armour, the three resistances, evasion and accuracy ratings, max hit, max HP. Room level is backed out of the unit's scaled defence so the sim scales identically. This is the tool that would have caught the resistance-wipe bug on sight.

- **The sim is built with the unit's active effects applied, so the comparison is buffed-against-buffed.** The game's `combatBuffMap` records are the engine's own buff shape, so the same self-buffs (Toughness, elusiveness) and player shreds (pestilent shot, puncture) fold into the sim's accuracy, evasion, damage, armour and resistance ratings the way the game's did. With effects on both sides every row should match, and a `⚠ off` means the sim genuinely disagrees — a real modelling gap, not a "which side has the buff?" question. A **Sim: buffed / baseline** toggle switches the sim column to the unbuffed baseline instead, where each row is read against the active effects (`↑ buff` / `↓ debuff`) so the raw effect the game applied is visible — useful for spotting a base-stat or scaling error the buffed view would mask. Both views are computed per click and travel with the history entry.
- **The panel grows to fit, resizes, and copies.** Its height now grows to show the whole readout without a scrollbar (capped just under the viewport), it is resizable from the corner, and a ⧉ button copies the on-screen comparison — stat rows, active effects and the blind-sim diff — as plain text for pasting.
- **A "Run blind sim" button checks whether the sim produces the effects at all.** The buffed comparison verifies the sim's stat math _given_ the effects; this asks the deeper question — fed only the monster and its room level (never the live buffs), does the sim independently generate them? It runs a short blind fight in the sim worker with buff-capture on, then lists every effect either side has: `⚠ missing` (the game has it, the blind sim never produced it — an unmodelled ability or one its rotation never cast), `≠` different strength, `+` sim-only (usually timing), or a match. This is what catches "the sim never applies this monster's self-buff / your debuff", which the stat rows alone cannot. Needs a tiny, flag-gated capture hook in the combat engine (`CombatUnit.addBuff`) that is off for every normal sim.
- **The log is now a labelled corpus: every distinct buff state is kept, not just the latest.** Each click is a deterministic test of the sim's stat arithmetic — the monster, the exact effects up, and the game's resolved totals — so keying the log by the effect set (not just monster+room) retains the monster unbuffed, part-stacked and fully stacked, each auto-diffed. The Cyclops-class bug (a buff wiped from the stat total) then flags on the first buffed sample, hands-free, and the exported log doubles as a regression fixture. An in-engine invariant test backs this up: `updateCombatDetails` must be idempotent and reconstructive (a fresh rebuild equals the incrementally-buffed unit).
- **Session log you can page through, with discrepancies surfaced first.** Every clicked monster's comparison is kept for the session, deduped by monster, room level and effect set, and capped. A nav bar pages through them — ▲/▼ buttons or, while the pointer is over the panel, the ↑/↓ arrows — ordering the ones with a mismatch first (newest first), then the clean views, so paging lands on the problems before anything else. A `⚠ N` count, a red title, and the position/"how long ago" readout make a discrepancy view obvious; a fresh click jumps back to live. A **Show: all / ⚠ only** toggle is a non-destructive filter — it changes what you page through, never what is stored, so switching it can't lose views — and the nav controls stay visible even when the log is empty, so a filter can never strand you. **Clear** wipes the log; ⭳ downloads the log plus the current snapshot as JSON. The log and the view choices **persist across refreshes** (in the labyrinth store), so a survey carries over between sessions. `Toolasha.Debug.monsterStatCheck()` dumps the last comparison; `Toolasha.Debug.monsterStatCheckLog()` returns the whole log.

### Lab Sim: labyrinth monsters keep their resistance/armour self-buffs

The room-level rescale of a labyrinth monster's armour and resistances reassigned them from base stats, wiping any resistance/armour **buff** the parent had folded in — so a monster's self-buffs (the Cyclops's Toughness and Guardian Aura) never mitigated anything and the sim over-credited your damage per hit (measured ~24% high, hit rate spot-on — a mitigation gap, not accuracy). The rescale now re-applies those buff boosts on top of the scaled base. Labyrinth clear-chance predictions for monsters that buff their own defence will drop toward reality; monsters without such buffs are unchanged.

### Lab Sim: the Accuracy Reset button now also clears the recorded fights

Reset promised to "throw away every recorded fight" but only cleared the clear-chance tallies — the calibration replay's fight pool survived. It now clears both, so Reset genuinely starts the whole accuracy record over (useful after a change that makes old recordings incomparable).

### Lab Sim: calibration replay splits the damage gap into accuracy vs mitigation

The passive fight recorder now keeps your per-fight swing counts (hits and misses, from the same `dmgCounter` the wire already sends), so the calibration replay can decompose a "sim over-credits your damage" verdict into **hit rate** (accuracy vs the monster's evasion) and **damage per hit** (what each landed hit does after mitigation). When one is off, the diagnosis now names it — fewer hits than predicted points at an unmodelled evasion buff (Guardian Aura); softer hits point at an unmodelled resistance/armour buff (Toughness). Both rates read off the sim's own attack tally, so no engine change. Older recordings without swing counts simply skip the two new rows.

### Lab Sim & Find Max Level build the monster with its full ability kit

The interactive **Lab Sim** run and **Find Max Level** were fighting a bare auto-attacker — they never passed `fullAbilities`, so tier-gated abilities (stun, defence shred, self-buffs) were dropped, unlike the tile badges and the calibration replay, which already build the full kit. Both now pass it too, so an interactive sim can no longer read rosier than the tile it sits on.

### Guild trials: forecast box beside the fight, and the damage feed sees the whole wave

- On the In Progress fight view a multi-enemy wave now attaches its forecast box the same way a single boss does — full-width below the enemy grid — instead of a narrow mirrored cell or an absolutely-positioned box that overflowed the panel and added a horizontal scrollbar. (A single boss is a one-column grid that already took the below-the-grid path; a wave is a multi-column grid, which diverged into the tile-row logic.)
- The battle-feed path is no longer single-enemy: the spectated pool (`_readPool`) and the per-tier boss sheet now sum every enemy in a wave, so the stream-fed clear/kill-time and the damage ceiling reflect all of them. This fixes the Trial Swarm remaining bar (four monsters, previously read as one) and stops the false "measured damage runs over the bosses' combined health" note on multi-enemy waves.

### Guild trials: multi-enemy combat waves are priced as one HP pool

A combat trial that fields several enemies under one name — two "Trial Badger"s, say — was mishandled: the two cards collided on their name-based key, so the record kept only one badger's health bar and the clear was priced off half the wave. That made "Kill in", "Next tier HP" and the tier pace optimistic (the current tier read at ~1/N of its real HP) while the forecast's own wave total, summed from client data, disagreed. The same-named cards are now folded into one wave tile with their health bars summed before sampling, so the measured remaining, the rate and the party DPS all describe the whole wave and line up with the forecast.

### Guild trials: overlay appears fast on the Trials and In Progress tabs, and each pass is cheaper

Those two tabs were the slowest to show Toolasha's forecast boxes — up to ~5s. Switching to them fires no socket event, so first paint waited on a trailing-edge debounced DOM observer, and on the In Progress tab that debounce **starved**: the live bar/countdown re-armed the 100ms timer without pause so it never fired, falling back to the 5s sampler. Added an opt-in `maxWait` to the shared DOM observer's debounce (bounds how long it may defer under continuous churn) and set it to 400ms for the trials handler, so the tab now draws within that of opening whatever the churn. `maxWait` defaults to 0 (unbounded) for every other handler, so nothing else changes.

The render pass itself is lighter too: the whole-panel element scan for trial cards now runs its two ancestor-climbing exclusions only on the handful of candidates instead of every element; the panel's text is walked once per pass and shared between the status and personal-stat readers rather than twice; and a forecast box in its shared row skips the per-box `getComputedStyle` squash probe (a wrapping row can't squash a card), leaving that check for the blocks that actually live in the game's own layout. That last one, plus the faster cadence, also shortens the moment where the In Progress unit icon is briefly squished before settling.

### Guild trials: tiles stay in a row with boxes beneath, cleaner notes, and a scheduled start alert

- The per-trial forecast boxes no longer sit in the grid cell beside each tile: each section now gathers its boxes into one full-width row (deferred past the tiles) that mirrors the tile grid's own columns, so the boxes line up in a row directly under the matching tiles — four across for skilling, two for combat. Fixes both the boxes landing beside the tiles and the flicker where they briefly appeared underneath and then jumped back — the layout now lives on a panel-owned row the per-block style reset can't wipe.
- Dropped the "No Treasury level seen" note — a guild with no Treasury levels bought adds nothing to the token figures, so its absence is nothing to flag.
- The **trial-starting** alert now anchors on the start instant (seen time + time-till-start) and arms a timer for the lead moment, so it still fires if the panel is closed after the cycle is glimpsed once — previously the panel had to stay open across the whole lead window.

### Lab Sim combat crates default to equipped too; recommendation & breakdown tooltips spell out the working

- The **combat** sim's tea/coffee/food dropdowns had the same hardcoded-Expert bug as the skilling tab — so a fight was scored with an Expert coffee crate's **+15 combat levels** the character may not own. They now default to the equipped crates (manual pick still opts out), same as skilling.
- The Automation-tab **recommendation badge** now has a full hover breakdown for skilling rooms — the room the recommended trigger maps to (and _why_ it's `trigger − 1` above you), the effective level, the success formula, the clear, and the crate tiers — matching the Lab Sim's row breakdown.
- Both breakdowns now **name the crate tiers** driving the numbers and explain the `− 1` in words (a room is skipped once it's ≥ trigger above you, so the hardest you still fight is one below).

### Lab Sim skilling: crates default to what you have equipped, plus a per-row calc breakdown

The Skilling tab's tea/coffee/food dropdowns were hardcoded to **Expert**, so the sim scored a room against Expert crates the character may not own while the room level itself came from the equipped crate — the two halves disagreed, and the sim's clear read higher than the Automation tab's recommendation for the same skip trigger (e.g. Recommend +63 but the sim needing +67 to hit 30%). The dropdowns now default to the equipped crates (a manual pick still opts out for exploring). And every skilling row now has a hover breakdown showing the working: `Room = skip level + trigger − 1`, `Eff level = base + buffs`, the level gap, the success formula, and the clear — so a mismatch is visible at a glance. (Reported by Doobs.)

### Craft arbitrage adapter: expose `skipProcessing` and `timeCostPerHour`

`describeCraft`/`describeCrafts` now forward a `skipProcessing` flag (buy processed intermediates like leather/lumber instead of making them — a direct craft off bought materials) and a `timeCostPerHour` (folds crafting time into the unit cost) to the planner. Lets a companion script offer a "direct craft" toggle and a local time-value rate. Both default off, so existing callers are unchanged.

### Labyrinth auto-calc: stop the bar looping, and move the toggle inline

- Auto-calc no longer re-runs the whole floor (refilling the progress bar) every time the game repaints the grid or our own badge draw trips the observer. An auto pass is now gated on a fingerprint of the rooms + gear + precision; when nothing that changes a result has changed, it silently restores any badges a re-render wiped from cache instead of re-simming.
- The **Auto-calc** toggle now sits inline with the other controls instead of stranded on its own row below the full-width progress bar.

### Fix: the labyrinth "Enable auto-calc" button actually toggles the setting

The new auto-calc button wrote the setting with `setSettingValue` (which sets `.value`), but `labyrinthAutoCalcTiles` is a checkbox read back as `.isTrue` — so the write never reached the read and the button did nothing. It now uses `setSetting`.

### Fix: Lab Sim skilling clear rates now match the Automation tab

The Lab Sim's Skilling tab was reading only speed/efficiency off your gear, dropping the **success** and **gathering-quantity** stats the live Automation clear-rate reader counts — so the sim's clear% ran low on exactly the skills whose tools carry them (gathering: milking/foraging/woodcutting, and cheesesmithing), while skills without them agreed. The sim now extracts those stats the same way, so the two tabs agree. (Reported by Doobs.)

### Labyrinth mobile: tidier collapsed bar and un-clipped tile times

The collapsed control bar now keeps the toggle and quick-calc on one line, with the calc button shrunk to just **C** while folded so it fits. And the clear-chance tile badge no longer clips the seconds to a stray digit on a phone — the fonts step down another notch so "100% 19s" shows whole instead of being cut off.

### Guild trials: the measured-vs-reported comparison, on screen

The Per-player scoreboard now shows the game's authoritative per-member totals (from the wire, so no need to open the Stats modal and it survives a refresh) with each row carrying **meas ±X%** — how far the plugin's own live measurement ran from the game's figure. The wire stats are preferred over the scraped modal where present.

### Labyrinth: lab sim reachable on mobile (tab bar scrolls)

The labyrinth tab bar now scrolls horizontally on mobile, so the tabs past the right edge — Lab Sim among them — can be reached with a swipe instead of being stranded off-screen.

### Labyrinth: tile badges fit on mobile, plus quick-calc and auto-calc buttons

The clear-chance tile badge ("100% 19s") no longer spills out of its coloured box on a phone — mobile font inflation is pinned off and the fonts step down a size so the reading stays inside the tile. The collapsible control bar gains a **Calc** button beside the toggle (a one-tap floor calc when auto-calc is off, so a folded bar still recalculates without expanding) and an **Enable auto-calc** button in the expanded controls that flips the setting and recomputes.

### Guild trials: capture the game's own end-of-trial stats to check the measurement

Toolasha now reads the game's authoritative per-member totals off the wire (`guild_trial_stats_updated` — exact damage, healing and pre-mitigation damage taken) and keeps them beside its own live measurement so the two can be compared. The comparison is persisted per encounter and survives a refresh until the week's ladder rolls over, and it rides along in the Export (`statsComparison`: measured vs reported, with the delta). Members are named through a character-id map accumulated across every tier, so the stats are still attributable after the per-wave roster has re-dealt.

### Fix: In Progress tab knows its tier right after a mid-trial refresh

On the In Progress fight view, the trial's stated tier is now taken straight from the live spectator stream, so a mid-trial refresh no longer drops the card to "tier 1 / banked nothing" until you visit the Trials tab. The stream states the tier outright; it's applied as a floor (tiers only climb, so it can only raise the count) and, being this render's reading of a currently-flowing stream, can't go stale the way the persisted tier could. Previously the fight-view card ignored it because it already carried the boss bars, and fell back to the lagging badge.

### Guild trials: drop the partial-tier payout notes, shorten the forecast text

The two partial-tier explanation paragraphs on the In Progress payout card ("Includes partial-tier credit…" and "… states N pts at T12 …") are gone — the credit still counts, it just isn't spelled out. Trimmed the wordiest forecast values too: "no data — only trials you join can be measured" → "only trials you join", "needs one tier's total to anchor the ladder" → "awaits a full tier", "nothing yet — tier N in progress" → "nothing yet · tier N". Full detail stays on hover.

### Fix: personal combat no longer leaks into the trial DPS split

While spectating a trial from the In Progress tab, the client's own side-combat (farming a zone) was being folded into the trial's per-player damage — a local build could read ~7× the boss's health and dominate the split (reported with a member farming a Chameleon zone during a Chameleon trial). The trial only ever streams over `guild_battle_updated`, so a `battle_updated` arriving while that spectator stream is live is now recognised as personal combat and dropped. This is the same separation KikiMeter (ZhuLiMoon) uses — credited in the code.

### Fix: skilling trial panels no longer squash the unit icon (In Progress tab)

On the skilling In Progress tab our injected blocks (the forecast and the payout) could land inside the non-wrapping `challengeArea` row beside the unit card, stealing its width and squashing the unit icon to ~42px (reported by Ana, tailoring). They were placed there by the pre-styles fallback and not re-placed, since each block's own anchor test read a block buried inside an ancestor row as still anchored. `_placeBlock` now re-homes **any** block that ends up inside a non-wrapping flex row — no full-width block belongs in one — so every panel lifts out onto its own line once the game's flex styles compute.

### Perf: party Profile button detection no longer scans the whole document

The battle-unit popup detection was sweeping `[class*="tab"] > *` across the entire page (~4.7ms) on every DOM change, even with no popup open — the priciest probe in the startup trace. It now anchors on the ARIA `role="tablist"` the game's tab strip carries (stable and sparse), so the check is near-free when no popup is present. Opt-in feature, so only affected users who enabled it, but it was the one avoidable hotspot.

### Guild trials: partial-tier credit now counts on live (was test-server only)

The partial-tier payout rule (an unfinished tier pays 0.5% per 1% of progress, up to 50%) went live with the guild patch, but the on-pace math still gated it to the test server — so live guilds were **undercounting** their projected points by up to half a tier. It now counts everywhere, and the tooltip wording dropped its "on the test server" framing and is much shorter.

### Labyrinth tile controls: collapsible, folded by default on mobile

The labyrinth calculator's control bar now folds behind a **▸ Labyrinth** toggle. On a phone it starts collapsed so it no longer eats most of the labyrinth panel (reported by Ana); on desktop it stays open. The choice sticks across redraws within the session, and open/closed is one tap.

### Action bar: compact width on by default in mobile mode

The compact-width action bar (clips the stats line instead of wrapping it) now turns on automatically in mobile mode, where the long "…actions/hr (… items/hr)" line was overflowing the narrow game header. Still a manual toggle on desktop; the setting note explains the mobile default.

### Docs: note the tradable-range band is a ~±10% approximation

Documented that the market-value band clamp is a multiplicative ~±10% and runs one price increment tighter than the game's real range on each side (the 8/14 hotfix widened it by one increment) — an intentional, bounded approximation, since the game publishes only values, not range bounds, and the plugin has no increment-tier table. Audited the rest of the 8/13 + 8/14 marketplace/guild patches (hourly market updates, 1T max price, compact prices, game-provided values, shrine buff rates): all already handled or read from game data, no change needed.

### Docs: settings notes now say 5% market tax (the calculations already did)

The market tax has been 5% in every calculation since the 8/13 patch went live (`MARKET_TAX` reads the live gate), but several settings descriptions and code comments still said "2%". Updated the effective-price, minimum-sell-tax, bulk-sell vendor-beats-market, trade-ledger, and buy-vs-sell notes to 5% so the text matches the math. No behaviour change.

### Lab Simulator Upgrade tab: default to your own character, and remember the pick

The Upgrade tab's Player dropdown defaulted to whichever party member was listed first and reset every time you switched tabs. It now defaults to your own character and remembers the chosen player (by name) across tab switches, so the sim stops jumping to someone else.

### First-run: offer a full backup before switching to the fork

The first time the fork runs on a browser that already carries Toolasha data, it now offers a one-time **full backup** before the What's New popup can touch any settings — so anyone switching from upstream (or who fumbles a settings import) keeps a clean restore point of their pre-fork state. Shown once, only for existing users (a fresh install has nothing to back up), and it's still available any time from Settings → Back Up Everything.

### Labyrinth tile controls: tidy wrapping on narrow/mobile panels

The labyrinth calculator's control bar (Calculate / Precision / Path / Clear≥ / Shroud / Beacons / Clear) was one flex row that wrapped item by item, so on a narrow panel labels got orphaned from their inputs and it read as a cramped, uneven column (reported by Ana on mobile). Each control's pieces are now a nowrap group — a label with its input, a button with its field — so the bar wraps _between_ controls into tidy rows and stays a single line when there's room.

### Fix: live clear-chance readout no longer shifts the fight header (mobile)

The in-fight clear-chance readout in the game header changed width every second — the band flipping between "Clear 75–100%?" and "Clear 100%", plus the ticking seconds — which reflowed the whole centered header, most jarring on mobile (reported by Ana). The readout now reserves the widest footprint it has shown during the fight and never shrinks, so a narrower reading leaves the layout put. The reservation resets when the fight ends.

### CI: publish stamps @version from package.json so a release can't ship mislabelled

3.2.0 first published with `@version 3.1.1` because the merge raced the Format Release Please stamp, so the built userscript carried the previous version and wouldn't register as an update. The publish workflow now runs `version:sync` (which stamps `@version` from package.json, the version release-please owns) immediately before building, as a backstop that guarantees the artifact matches the version being published. 3.2.0's assets were re-published with the correct version.

### Profiles open directly everywhere, not just filled into chat

Added a shared `openPlayerProfile()` that opens a player's profile through the game's own `handleViewProfile` (no chat needed), falling back to the `/profile` chat command only if that handler is missing. Every place that used to fill `/profile <name>` into chat and wait for Enter now opens the profile directly: clickable chat names, the combat DPS/portrait names, dungeon-history player names, the guild roster, and the guild member-skills cycler. The party-member Profile button uses the same helper. Their hover tooltips now read "Open <name>'s profile" instead of "Fill …into chat".

### Lab Simulator: Upgrade tab gets the full run-cap controls

The Upgrade tab now carries the same run controls as Single Sim — **Precision** (shared with the Single Sim tab and Settings), **Max fights**, **Max hrs**, and **Uncapped**. They bound the baseline sim each comparison is paired against (it stops at the precision target, the fight cap, or the time ceiling), and every candidate inherits the baseline's fight count so comparisons stay paired. Uncapped ignores both numeric caps and runs the baseline to precision.

### Combat: "Profile" button on party members (opt-in)

New setting "Combat: Profile button on party members" (off by default). When on, clicking another player's unit in group/party/dungeon combat adds a **Profile** button to the battle-unit popup's tab row (next to Battle Info / Stats) that opens their profile directly via the game's own `handleViewProfile` handler — so you no longer have to detour through "My Party", and it works whether or not chat is open (falling back to the `/profile` chat command only if that handler is ever missing). Shown for other players only. The popup is located by its tab labels and the player by the "name - Lv.N" header (hashed classes aren't relied on).

### Fix: tooltip feature was still skipped at the registry level with prices off

3.1.1 fixed the module's own init guard, but the feature registry had a second gate (`customCheck`) that still required "Show 24-hour average market prices" or pin-to-top to be on — so with those off the registry skipped the feature entirely and never called it. The check now defers to the module (`shouldEnable()` = any tooltip section enabled), so profit / expected value / enhancement tooltips draw with prices off.

### Lab Simulator: "Max Level" → "Single Sim", per-tab run caps with an Uncapped toggle

The tab that sims one selected monster is now called **Single Sim**. Both the Single Sim and Upgrade tabs now carry their own run caps on their control row:

- **Single Sim**: **Max fights** (the trial cap, previously hardcoded at 20000), **Max hrs** (simulated-time ceiling, default 24), and an **Uncapped** checkbox that ignores both numbers (they stay in the field) and runs to the precision target.
- **Upgrade**: **Max hrs** (default 24) and its own **Uncapped** checkbox. This replaces the old shared "Hours" box on the Configure tab, which is removed.

All four persist as settings and are scoped to their tab; the live labyrinth tile calculator keeps its own ceiling.

### Fix: item tooltip went fully blank when "market prices" was turned off

The whole tooltip module (prices, profit, expected value, enhancement path/milestones, ability status, gathering) was gated at startup on only `itemTooltip_prices` or pin-to-top being on, so anyone who turned market prices off but left profit/EV/enhancement on got a bare game tooltip with none of the Toolasha sections — the DOM observer never started. Init and the two "anything to do?" guards now key off _any_ enabled tooltip feature, and market data loads whenever a price-consuming section is on. Turning prices off now hides just the price line, as intended.

### Item tooltip: option to cost profit from the direct recipe only

New setting "Profit: direct recipe only (buy base items, no sub-craft chain)" (off by default). When on, each recipe ingredient is costed at its own market Ask/Bid and the calc stops there, instead of recursing into how a craftable ingredient is itself made — so a Holy Brush is figured as Rainbow Brush / Holy Cheese / Arcane Log bought at market, not the whole brush chain. Applies to both the detailed breakdown table **and** the profit/hr (no upgrade-item craft cost or chain time), so the two stay consistent. Overrides "Use crafting cost for upgrade items if cheaper" while on.

### Combat lab sim: precision is now adjustable from the sim panel

The Monte-Carlo win-rate precision (`labyrinthSimPrecision`) was only reachable from Settings even though it drives the Max Level tab's sim. Added a "Precision ±%" input to the sim's run-control row (0.1–10, same knob the labyrinth tile calculator already exposes) so it can be tuned in place; it reads and writes the one shared setting, so all three stay in step.

### Fix: stop the "Inventory Badge Manager failed to start" false alarm

Its health check reported failure whenever the inventory was on screen but not yet priced — a normal "not yet" (the price badges render asynchronously, and don't render at all if the price-badge provider is off), most visible on a marketplace/mobile open. It now confirms health only when a priced container exists and otherwise stands down, never reporting failure (the real badge output is already health-checked by Inventory Badge Prices). No behaviour change to the badges themselves; just no more spurious startup notice.

### Fix: minify the @require bundles so they install under Steam's 2 MB limit

The production library bundles shipped unminified, so `sim`, `combat` and `ui` (2.6–3.5 MB) exceeded the ~2 MB per-`@require` limit in the Steam Extension Manager and failed to install there. Wiring terser into the production build (keeping function/class names, since the code reads them at runtime) drops every bundle well under 2 MB — sim 1.06, combat 0.80, ui 1.15 MB. Also adds an opt-in `MINIFY=1 npm run build:dev` for smoke-testing the minified output before release.

### CI: harden the release publish so large release notes can't break it

The release workflow read the version's notes out of `CHANGELOG.md` with an `awk` that only stopped at the next `## [x.y.z]`, so the whole Fork Changelog (which sits above the version entries) bled into 3.0.0's notes — ~240 KB — and `git commit -m "$notes"` overflowed the OS argument limit, failing the publish to GreasyFork. The notes now stop at the next `##` or the first non-release-please `###`, and the userscript commit is written with `git commit -F` (a file) so notes of any size are safe. Added a `workflow_dispatch` `publish_version` input to re-publish a specific version through the same pipeline without cutting a new release.

### Combat Profit: "Tax" button renamed to "Moopass", plus a real sale-tax toggle

The panel's "Tax" toggle was actually the weekly **MooPass** cowbell cost, so it's renamed to match (the button and the "Pay the MooPass" card). A new **"Tax"** toggle now subtracts the **market sale tax** from combat income — netted at the source (`calculateIncome`, coin untaxed / cowbell 18% / else 5%), so the Daily Income stat, the Combat Profit panel, and the sim-vs-measured calibration all read post-tax. On by default; a remembered choice under the old "Tax" name migrates to Moopass.

### Fix: "auto-click max" was maxing the price, not the quantity

The 8/13 marketplace layout gave the price row its own "Max" button and put it ahead of the quantity row, so the auto-click-max feature grabbed the first "Max"/"All" in the modal — the price one — which slammed the sell price to the top of the tradable range **and** left the quantity un-maxed (both halves of the reported "fills the max price, no longer maxes items"). It now scopes the search to the quantity inputs and excludes the price row, so it maxes the amount and leaves the price alone.

### Combat sim nets the market sale tax off drop revenue

The simulator valued every drop at its gross market price, so profit ignored the sale tax entirely — which is why the 8/13 rise to 5% never moved it. Every drop-revenue path now nets the tax off each non-coin drop (cowbell bags at their own 18%): the Results **Summary** (Profit/day, Revenue), the **Drops** table's Gold columns, and the comparison/upgrade rows all go through one shared `taxedDropValue`. Coin drops stay whole, and the expected-value fallback is left alone since it is already taxed.

## [3.7.0](https://github.com/Millennium44/Toolasha/compare/v3.6.1...v3.7.0) (2026-08-15)

### Features

- guild trials row layout, drop treasury note, schedule the start alert ([7056fd9](https://github.com/Millennium44/Toolasha/commit/7056fd9714dd2ba848bc735566095b8dfd0157c3))
- set combat forecast beside the fight; sum the whole wave in the damage feed ([0c22646](https://github.com/Millennium44/Toolasha/commit/0c226469bbdd981c2259a758e0187ae4fc1d0ba2))

### Bug Fixes

- align trial forecast boxes to the tile columns (four for skilling) ([480c31b](https://github.com/Millennium44/Toolasha/commit/480c31b413400c7e9955b7484be93dfcc6210362))
- anchor the combat forecast box to the panel so it hugs the enemies at width ([5b87a1c](https://github.com/Millennium44/Toolasha/commit/5b87a1c5e6ba69133276ea3b90dd165f5477f12c))
- fold multi-enemy combat waves into one HP pool for the clear ([9ebcb9a](https://github.com/Millennium44/Toolasha/commit/9ebcb9ab66809b8984b7a6df9f50ab18ee5ef892))
- gather trial forecast boxes into a compact row, and stop them reverting ([3fa78c7](https://github.com/Millennium44/Toolasha/commit/3fa78c7fd74c89222c01ea7ce769dc36011d641b))
- hug the combat forecast box against the enemies inside the monsters half ([4c51f9a](https://github.com/Millennium44/Toolasha/commit/4c51f9a0bdf3709c894ababa896fb8a46c44fa8d))
- place a multi-enemy fight box below the grid like a single boss, no scroll ([fd4f3b0](https://github.com/Millennium44/Toolasha/commit/fd4f3b04eded6fa55925e1bd7ad6d6551fa961df))
- span trial forecast boxes across the outer tab grid, not the one-cell tile ([669d758](https://github.com/Millennium44/Toolasha/commit/669d758593ee317934cd861bea34eb1558f835fe))

### Performance Improvements

- bound the trials DOM-observer debounce so the overlay paints fast ([2d07b7b](https://github.com/Millennium44/Toolasha/commit/2d07b7bd8c4ae02c1e3977eb73ce2c68dd26cbf8))
- lighten the trials render pass — scan, text walk, and squash probe ([47511a1](https://github.com/Millennium44/Toolasha/commit/47511a125902d528ffee9f9975d88491201fe199))

## [3.6.1](https://github.com/Millennium44/Toolasha/compare/v3.6.0...v3.6.1) (2026-08-15)

### Bug Fixes

- correct the shipped in-game changelog wording ([3a9994e](https://github.com/Millennium44/Toolasha/commit/3a9994e68ddad3d8094f6c115ec4933ebf9fd515))

### Documentation

- scrub companion-script name from the changelog; add the no-naming rule ([5f5dd0a](https://github.com/Millennium44/Toolasha/commit/5f5dd0a1a51413739e5b2c5d5c7a41fe7556770d))

## [3.6.0](https://github.com/Millennium44/Toolasha/compare/v3.5.2...v3.6.0) (2026-08-15)

### Features

- craft arbitrage adapter forwards skipProcessing and timeCostPerHour ([db197f7](https://github.com/Millennium44/Toolasha/commit/db197f78af8e6ee1cdf3c094cc75955e71633e2c))
- default combat sim crates to equipped; richer recommendation & breakdown tooltips ([141879b](https://github.com/Millennium44/Toolasha/commit/141879b6ba4d0c17b40675566a0b201d8626fbe2))

### Bug Fixes

- Lab Sim skilling crates default to equipped, add per-row calc breakdown ([dfe4f3a](https://github.com/Millennium44/Toolasha/commit/dfe4f3abb31c66a5d97bd6c8b19713550d6be8a2))

## [3.5.2](https://github.com/Millennium44/Toolasha/compare/v3.5.1...v3.5.2) (2026-08-15)

### Bug Fixes

- stop labyrinth auto-calc looping the bar on a static floor; move toggle inline ([4246ea6](https://github.com/Millennium44/Toolasha/commit/4246ea65e96f655d8437e549303f3201333fadc8))

### Documentation

- standing rule to work directly on main ([e414d26](https://github.com/Millennium44/Toolasha/commit/e414d26d8c431ef9f03939da84e7d19f99c3a540))

## [3.5.1](https://github.com/Millennium44/Toolasha/compare/v3.5.0...v3.5.1) (2026-08-15)

### Bug Fixes

- labyrinth auto-calc button writes the checkbox setting correctly ([681ade5](https://github.com/Millennium44/Toolasha/commit/681ade53a2695dda8f63289b61e23f3c8739934b))
- labyrinth mobile control bar and tile badge polish ([dcff2e7](https://github.com/Millennium44/Toolasha/commit/dcff2e7286b9f3fcb7741f692dc4c616cc28b893))
- sim skilling clear rate reads success and gathering gear stats ([80d6132](https://github.com/Millennium44/Toolasha/commit/80d6132afc39c9620235194c923a8be51639b8a2))

## [3.5.0](https://github.com/Millennium44/Toolasha/compare/v3.4.0...v3.5.0) (2026-08-14)

### Features

- capture the game's end-of-trial stats to check the measurement ([7d0932d](https://github.com/Millennium44/Toolasha/commit/7d0932d5bc6b9680ba83ecb169d101ea4c16a9d5))
- labyrinth mobile — fit tile badges, add quick-calc and auto-calc buttons ([27de49d](https://github.com/Millennium44/Toolasha/commit/27de49da4d2ca0e1fc8b4aeebfb9a1361c8cff19))
- on-screen trial stats comparison + mobile lab-sim tab access ([edc2362](https://github.com/Millennium44/Toolasha/commit/edc23625564cb6a1f271e6edfd26c8b582912678))

### Bug Fixes

- apply the live spectator tier on the In Progress fight view ([9d7980b](https://github.com/Millennium44/Toolasha/commit/9d7980b6953c4d9670576cd295a392774a8b7517))
- count guild partial-tier credit on live, not just test server ([fe650e1](https://github.com/Millennium44/Toolasha/commit/fe650e18be19cef97a02c6c671d928a222832362))
- drop personal combat from the spectated trial DPS split ([5045a60](https://github.com/Millennium44/Toolasha/commit/5045a6012720f6ff8ea7ee736aaadbfbf10d90ed))
- re-home any trial block stuck in a squashing row, not just the forecast ([2f7631d](https://github.com/Millennium44/Toolasha/commit/2f7631dc2c3b2ae948e3cde45446c9814a66ec2e))
- skilling trial forecast block no longer squashes the unit icon ([f7bce95](https://github.com/Millennium44/Toolasha/commit/f7bce95efa5acfadefa75e1e163a4dc8d00a5889))
- trim guild trial payout notes and forecast text ([4c9c2bc](https://github.com/Millennium44/Toolasha/commit/4c9c2bc430d0901e8bc56f6d84dbeaa4115c0c40))

### Performance Improvements

- anchor party Profile button on role=tablist, not a document sweep ([176bb61](https://github.com/Millennium44/Toolasha/commit/176bb610c15b7e00e2d62ae6bd80dcdadf3d78b9))

## [3.4.0](https://github.com/Millennium44/Toolasha/compare/v3.3.0...v3.4.0) (2026-08-14)

### Features

- mobile-friendly lab controls and compact action bar ([89ac391](https://github.com/Millennium44/Toolasha/commit/89ac391b44e402707702e8f7c466e7fbf43df659))

### Documentation

- note tradable-range band is a bounded ~10% approximation ([ac649ab](https://github.com/Millennium44/Toolasha/commit/ac649ab71ece287665d182177f5b0ca1c9b32e10))
- update stale "2%" market-tax notes to 5% ([cc7e37a](https://github.com/Millennium44/Toolasha/commit/cc7e37a0f276eb63b6685d0002d78267eaccacda))

## [3.3.0](https://github.com/Millennium44/Toolasha/compare/v3.2.1...v3.3.0) (2026-08-14)

### Features

- offer a full backup on first fork run ([2ae30b3](https://github.com/Millennium44/Toolasha/commit/2ae30b3180fc7f486d03e1a624a381ba151a5e6d))

### Bug Fixes

- default Lab Upgrade tab to own character and keep the player pick ([f58df8c](https://github.com/Millennium44/Toolasha/commit/f58df8c4e61545ed795304fd4858c49fc88d511e))
- group labyrinth tile controls so they wrap tidily on mobile ([da34895](https://github.com/Millennium44/Toolasha/commit/da34895088ab9f9c9c5573c65db88735a7573d00))
- stop the live clear-chance readout reflowing the fight header ([60bfb5f](https://github.com/Millennium44/Toolasha/commit/60bfb5fbb418e258973456a8506454b3f8f75c13))

## [3.2.1](https://github.com/Millennium44/Toolasha/compare/v3.2.0...v3.2.1) (2026-08-14)

### Miscellaneous Chores

- sync [@version](https://github.com/version) to 3.2.0 and stamp version at publish time ([1a376fe](https://github.com/Millennium44/Toolasha/commit/1a376fe5928dde25e32b6e8dacf5baf6cf783d17))

## [3.2.0](https://github.com/Millennium44/Toolasha/compare/v3.1.1...v3.2.0) (2026-08-14)

### Features

- add opt-in Profile button to combat battle-unit popup ([54ce2ba](https://github.com/Millennium44/Toolasha/commit/54ce2ba4ba817a3a56ba38f1ca9bfd5621048915))
- add per-tab run caps and Uncapped toggle to Lab Simulator ([0d11cad](https://github.com/Millennium44/Toolasha/commit/0d11cad9447f945815ff1603ae619a0065c4b99f))
- add precision and max-fights controls to Lab Upgrade tab ([268db82](https://github.com/Millennium44/Toolasha/commit/268db82092a6fa0a40ed542c06b1e5bd3b197d1b))
- add uncappable fight/time limits to Lab Simulator Single Sim tab ([9077ebf](https://github.com/Millennium44/Toolasha/commit/9077ebf4728161690607c23a71b5d7bb3d048db4))
- open party profile directly via handleViewProfile ([9f6a5e4](https://github.com/Millennium44/Toolasha/commit/9f6a5e432f47cb0b5188341c2c562febf6a41b31))
- open profiles directly via shared helper across all /profile sites ([20d10cf](https://github.com/Millennium44/Toolasha/commit/20d10cf8e4ad2b03f786a9c73721a317193d828b))
- reword profile-link tooltips to "Open &lt;name&gt;'s profile" ([8cd3add](https://github.com/Millennium44/Toolasha/commit/8cd3add8532c4ee349348648fa77b50489020faf))

### Bug Fixes

- start tooltip feature when any tooltip section is enabled ([af2debc](https://github.com/Millennium44/Toolasha/commit/af2debced7d8cc28b5010c76b503673a1ab33258))

## [3.1.1](https://github.com/Millennium44/Toolasha/compare/v3.1.0...v3.1.1) (2026-08-14)

### Bug Fixes

- draw item tooltip sections even when market prices are off ([0280879](https://github.com/Millennium44/Toolasha/commit/0280879175265eb4c4ddcd46a2aadfdadef78c5d))

## [3.1.0](https://github.com/Millennium44/Toolasha/compare/v3.0.1...v3.1.0) (2026-08-14)

### Features

- direct-recipe-only setting now drives the global profit math ([1d381ad](https://github.com/Millennium44/Toolasha/commit/1d381ad24e105d6401f746f89ea890c20d7e6520))
- expose combat lab sim precision control in the sim panel ([6a78ca9](https://github.com/Millennium44/Toolasha/commit/6a78ca9d6f8bd55eda3f45e4b8051754850b6f39))
- flatten item-tooltip materials breakdown to the direct recipe ([12d917e](https://github.com/Millennium44/Toolasha/commit/12d917ed8b93ad178811f4fffeb9751ddf439b44))

### Bug Fixes

- **inventory:** stop the Inventory Badge Manager health-check false alarm ([1af6290](https://github.com/Millennium44/Toolasha/commit/1af629037fc6bd8d6d7fc804792a3a14183fda53))

## [3.0.1](https://github.com/Millennium44/Toolasha/compare/v3.0.0...v3.0.1) (2026-08-14)

### Bug Fixes

- **build:** minify [@require](https://github.com/require) bundles to fit Steam's 2MB per-require limit ([1ea6e49](https://github.com/Millennium44/Toolasha/commit/1ea6e49ed6e3b72f862916001605b60fd086fa9d))

### Continuous Integration

- harden release publish against oversized notes; add manual re-publish ([a71a2b2](https://github.com/Millennium44/Toolasha/commit/a71a2b2cff2c8eff0d1a79daa37482f102ecbcc2))

## [3.0.0](https://github.com/Millennium44/Toolasha/compare/v2.102.0...v3.0.0) (2026-08-14)

### Features

- **combat-profit:** rename MooPass toggle, add a real sale-tax toggle ([5ac07cb](https://github.com/Millennium44/Toolasha/commit/5ac07cbeba825f31a42a86b160d13a82efd6acca))
- **combat-sim:** net the market sale tax off drop revenue ([e867855](https://github.com/Millennium44/Toolasha/commit/e867855d2f2ac5f5900c38db3e8bb2a62e033910))
- **overlay:** rework curated default tiles, add reset button; un-gate 8/13 patch ([c84ca7d](https://github.com/Millennium44/Toolasha/commit/c84ca7dfb23e20fadecdaeb7071d7bf595c0c72d))

### Bug Fixes

- **combat-sim:** apply the drop sale tax on the Results panel too ([175e291](https://github.com/Millennium44/Toolasha/commit/175e291f5c9b7ba2a9dc7e01bed103dddc1833d5))
- **market:** auto-click-max was maxing the price, not the quantity ([b6c074e](https://github.com/Millennium44/Toolasha/commit/b6c074e77c8d53af120d2ad86b453e0116650f7b))

### Miscellaneous Chores

- release Toolasha 3.0.0 ([452196e](https://github.com/Millennium44/Toolasha/commit/452196ed8835d2192b3699bed4875eb2a59b23fb))

### 8/13/2026 marketplace patch un-gated (now live on www too)

The patch reached the live server, so `isMarketplacePatchLive()` now returns `true` everywhere. Every gated behaviour — 5% market tax across all profit/net-worth math, the game's official market-value reconciliation, and shrine levels folded into gear score and the combat sim — is now in effect on both servers, not just test. The gate is kept as a one-line function so a future server-staged change can re-gate from the same place.

### Overlay: reworked default tile set + a "Reset to default tiles" button

The curated overlay default is regrouped into **Wealth** (net worth, coins, inventory value), **Character** (build score, combat level) and **This session** (combat status, XP/hr, profit, DPS, deaths/hr, drop luck, time to level), so the tiles read as clusters instead of a flat row. The session figures are all measurements, which stay hidden until they have data — so a fresh or non-combat character still opens onto a handful of tiles, not a wall. A new **Reset to default tiles** button in ⚙ puts any character back to that set (clearing hand-picked rows and order, leaving positions and sizes alone), undoable like the other bulk layout actions.

### First-run setup: copy from another character, and a way back to it

The welcome prompt now offers **"Copy from another character"** — pick one of your other characters and its settings are copied onto this one, the one-click way to set up a fresh alt (especially an Iron Cow) instead of only offering generic presets. Added to both first-run pickers, and to a new **"First-time setup"** button in the Toolasha settings tab so the one-shot prompt is recoverable: a stray click that dismissed it (or a character already past it) can re-open it any time, on any character. Defaults now leads the picker, a **No change** option sits beside it, and dismissing the dialog is "no change" rather than a reset — so re-opening it on a configured character can no longer wipe settings by accident.

### Fix: marketplace autofill after the typable-price update

The 8/13/2026 update made the marketplace Price/Quantity fields typable text inputs (`type="text"`), which broke every Toolasha selector that looked for `input[type="number"]` — most visibly the missing-material autofill no longer filled the quantity. Now targets the game's own `MarketplacePanel_quantityInputs` row (falling back to reading all inputs by label), and rewinds React's value tracker on write so a strictly-controlled field can't snap back. Works on both the old (number) and new (text) inputs, so it needs no server gate. The companion script's autofill was already class-based and unaffected.

The game's market tax went from 2% to 5%. Updated the single `MARKET_TAX` constant and swept out every place that had hardcoded 2% (`0.02`/`0.98`) — networth, order totals, bulk-sell floor, listing value, guild-credit sell→rebuy, profit/hr, enhancement worth-it, EV, tea optimizer — so all profit, net-proceeds and break-even figures use the new rate. Tax labels now derive from the constant instead of a baked-in "2%".

The 5% rate (and the shrine-in-gear-score change below) is **gated to the test server** for now via `isMarketplacePatchLive()` — the live server keeps 2% until the patch reaches it. One line to un-gate everything once it is live everywhere (`server-gate.js`).

### Prices reconciled against the game's official market values

The 8/13/2026 update publishes an estimated value for every item and enhancement level (`localStorageUtil.getMarketItemValues()`, the figure behind the inventory's "Total Market Value"). Toolasha now reads it (cached, version-guarded) and reconciles every ask/bid at the shared price choke point (`getItemPrice`/`getItemPrices`): a stale price is **clamped into the ±10% tradable range** the game now enforces, and an item with an empty book is **valued the way the game values it** instead of collapsing to crafting cost. This flows through to networth/inventory value and the profit calculators at once. Gated to the test server (a pass-through until the patch is live). Combat-loot valuation, which reads the market API directly, is unchanged this pass.

New setting **"Net worth value source"** (Order book / Game's market value, default Order book). The game's value refreshes every ~10 min — far fresher than the ~hourly market feed — so switching to it makes the net-worth total match the game's own inventory total. It also reaches the batched net-worth path (via `getPricesBatch` → `getMarketPrice`), which the choke-point reconcile above did not, so the clamp/fallback now applies to the full net-worth sweep too. Gated to the test server.

### Profiles: shrine levels count toward gear score and combat sim

The game now shares each player's shrine levels on their profile (`guildBuffLevelMap`). Toolasha reads them and folds their value into the **Combat and Skiller scores** (combat shrines into combat, skilling into skiller) instead of leaving them off other players' cards — the "+ Guild Shrine" line now shows for everyone. **Sim Character** (and party-member sims) also carries the viewed player's shrine buffs into the combat sim, so an imported character fights with its shrines rather than without.

### Labyrinth: full monster abilities always modelled

Removed the "Model full monster abilities in combat sim (testing)" toggle — the verified behaviour is now permanent. The sim builds each labyrinth monster with its full ability kit (stuns, shreds, self-buffs) rather than the tier-0 subset, so combat-room clear chances read closer to reality.

### Enhancement Tracker: idle duration fix, session merge, and an on-screen toggle

- **Session Duration no longer runs while idle.** It stopped only when a run reached its target; a session left In Progress counted wall-clock forever. The clock now ends at the last recorded attempt, so it freezes when you stop enhancing (and XP/Hour with it).
- **Merge sessions (∑).** A new ∑ button in the tracker header opens a checklist of your sessions and shows a combined summary of the ones you pick — per-level tally, attempts, success rate, XP, duration, and total cost — for a target reached across several separate runs. Defaults to every session of the item currently in view.
- **Show/hide button on the Enhancing screen.** A "∑ Tracker" button now sits in the Enhancing panel's corner, like the marketplace's Bulk Sell tab, toggling the tracker on demand (a manual hide sticks).

### Notifications: labyrinth entry regenerated (opt-in)

New default-off notification "Notify when a labyrinth entry regenerates". The Labyrinth holds up to five entries and regenerates one on a cooldown (a couple of days, less with upgrades); this fires when the stock rises or when the projected regeneration instant passes on an open tab — computed from `lastLabyrinthTimestamp + labyrinthCooldownHours` — so an entry doesn't sit wasted at the cap. Uses the existing notification service (toast in-page, browser notification when the tab is hidden).

### Loot Log: enhancing cost, luck and profit (opt-in)

Now prices materials and protection with the same helper the live Enhancement Tracker uses (production-cost/NPC fallbacks for unlisted materials), so the loot-log figures line up with the tracker for the same run instead of collapsing to near-zero when a material has no market listing.

Enhancing loot-log entries can now carry a summary line — material and protection cost against the statistically expected cost (how lucky the run was), and the profit (the finished item's after-fee value minus the base and what you spent). It's reconstructed from the run's own per-level results and priced through Toolasha's enhancement calculator, assuming the cost-optimal protect level. New setting "Loot Log: Enhancing cost, luck and profit", **off by default**. The summary text is a readable size.

Each enhancing entry also has a **+ merge** chip: pick two or more runs of the same item and a panel at the top of the loot log sums their real cost, luck and profit into one total — for a target reached across several split runs.

### Enhancement Tracker: cost-vs-expected (luck) and worth-it lines

The Enhancement Tracker now shows two new readings under the run stats: **Expected Cost + Cost Factor** with how far below/above the expected cost this run landed (the cost twin of the Attempt Factor — pure attempt/protection luck, at this run's own prices), and a **Worth it (net)** line — the +N item's after-fee resale value minus the base you gave up minus what you spent, so you can see whether the enhance actually paid off. Click the Worth-it line to expand a breakdown. (A loot-log version is a planned follow-up.)

### Enhancement Tracker: toggle it from the command palette

The Enhancement Tracker now appears in the Ctrl/Cmd+K command palette, so you can show or hide it on demand. A manual hide sticks (the auto-show logic won't bring it back until you toggle it on again or re-enable the feature).

### Fixes: sort defaults, minimize placement, clickable quiet members

- **Combat Sim all-zones and the Upgrade advisor now default to sorting by Score.** The all-zones run was resetting to Profit and the Upgrade table opened on DPS; both now open on Score (best first).
- **The minimize button sits next to the close ✕ again** on Combat Sim, Lab Sim, and the Trade Ledger — it was landing in the middle of the header (and swapped past close on the Trade Ledger).
- **Guild Roster: click a "Gone quiet" member** to load `/profile <name>` in chat (press Enter to open), the same trick the profile cycler uses.

### Every panel can be minimized without closing it

Floating panels now have a **–** button in the header (beside the close ✕) that folds the panel down to its title strip, leaving it draggable and running — click **□** to bring it back. It works across both shared panel shells (party loot, guild roster, DPS/deaths/profit tiles, and the rest) and the bespoke tool windows (Combat Sim, Lab Sim, Enhancement XP/hr, Consumables, Houses, Goal Planner, and more). The minimized state is remembered per panel across refreshes, alongside its position.

### Combat & Lab Sim: optionally remember upgrade results across refreshes

New opt-in setting (default off) keeps the last Upgrade-tab results after a page reload — for both Combat Sim and Lab Sim — until you run a new analysis, so a run you waited minutes on is still there when you come back. A quiet banner marks restored results. Off by default because it stores the full result set (one blob per character per sim) in the browser database.

### Combat Sim Results: a ⌖ button targets that zone in Configure

Each row of the all-zones Results table now has a ⌖ button that sets that zone and tier as the Configure target and jumps to the Configure tab (leaving all-zones mode so the single-zone selects reappear) — no more scrolling the zone dropdown to sim a promising row. The table also now defaults to sorting by Score (descending) instead of unsorted.

### Upgrade advisor: path boots (base and refined) are offered and simmed at +7

The upgrade advisor simmed a proposed gear swap at the current piece's enhancement level, so path boots (Pathbreaker/Pathfinder/Pathseeker) were quoted at whatever your worn boots are (e.g. +10). They're only obtainable at +7, so a swap to them is now always simmed and priced at +7 — the refined variants override the usual +10 refined floor. The refined path boots are now also _offered_: the crafting-chain walk only reaches the base boot (refined is one hop further), so each base path-boot swap now gets a refined sibling in the table, at +7.

### Enhancement XP/hr panel: get a route for any item, even one you don't own

The enhancing-route (target level, protection plan, cost) was only reachable by hovering an item that's rendered — owned or listed — so an item with no listing at that level showed nothing. The Enhancement XP/hr panel now has an "Enhance any item" box: type any enhanceable item, pick a target level, and get its full route. The base-item price falls back to crafting cost when the market is empty, so it works with zero listings.

### Ability hover: optional "fresh to level" cost, priced at the level shown

Hovering an ability itself (in a loadout, an ability slot, or on another player's profile) can now add a "Fresh to Lv N: <cost> (<books> books)" line, priced at the level the tooltip shows — so on someone else's profile it uses their level, not yours. It's identified from the ability tooltip's own name and gated behind a new, default-off setting ("Show fresh-to-level cost on ability hovers"), separate from the ability-book tooltip status.

### Enhancement tooltip: the source toggle is discoverable and mobile-friendly

The "Yours ⇄ / Pro ⇄" chip on enhancement tooltips now shows a keycap **P** so the press-to-toggle hotkey is visible, not just buried in the hover title. On touch devices it drops the key (no keyboard), enlarges to a finger-sized tap target, and reads "tap" — the chip was already tappable on tap-to-open tooltips, just too small and unlabeled.

### Upgrade advisor: "Signature only" is now "Aura only"

The Ability Swaps sub-option that restricted swaps to the aura + signature groups now restricts to just the aura group — the single "which aura" decision. Renamed the checkbox to "Aura only" with an updated tooltip, and renamed the internal option throughout (`auraOnly` / `auraSwapsOnly`).

### Upgrade advisor: the aura OR-alternative is offered again

Ability Swaps stopped offering the other aura in your archetype's aura group — e.g. running Mystic Aura, it never proposed Critical Aura. The generator was running each guide offer through a style-from-buff-data heuristic that misreads a universal aura (Critical Aura) as another style and vetoed it. The guide's own ability set is style-correct by construction, so on the guide path that heuristic no longer runs; it now only guards the every-ability fallback.

### Sim: Achievements section — toggle your achievement combat buffs

The sim already applied your completed-achievement combat buffs (e.g. Damage +2%) silently; there was no way to see or change them. A new **Achievements** section on the Configure tab lists the combat buffs your achievements grant, each ticked by default (so results are unchanged) — untick one to sim without it. It reads your real buffs with their exact values; a character with no combat achievement buffs shows no section.

### Sim: the loadout picker is back in the packaged build

The Combat Sim and Lab Sim loadout dropdown vanished in the released userscript (it still worked in dev): both UIs read the loadout list from their own bundle's copy of the snapshot store, which the websocket never feeds in the multi-bundle build, so the list was always empty and the `<select>` never rendered. Both now read the fed store through the bundle bridge — the same fix the apply path already had — so you can pick a saved loadout to sim as again. A regression test now asserts the picker renders from the bridge store.

### Author credit: full contributor list and code-source attribution

Both userscript headers now carry the same, tidied `@author` credit. It restores the contributors who were only in the dev header (Shykai, amVoidGuy, vlad, kuganDev, Paradoxian, Maarg, SilkyPanda, MekaPyon, vidonnus) and adds a line crediting the tools this fork borrowed code and ideas from: MWITools (bot7420), MWI Combat Suite (Frotty), JIGS (jigglymoose), the Labyrinth Win Rate Calculator (dakonglong), and the mooket pools (Q7, IOMisaka).

### Author credit leads with Millennium44 (production header too)

The previous author change only touched the dev header (`userscript-header.txt`); the GreasyFork build takes its header from `library-headers/entrypoint.txt`, which still led with the upstream authors. That production header now leads with "Millennium44 (fork of Celasha and Claude's Toolasha)" as well, so the published listing shows the fork maintainer.

### Author credit leads with Millennium44

The userscript `@author` header now opens with "Millennium44 (fork of Celasha and Claude's Toolasha)" instead of leading with the upstream authors, so the GreasyFork listing credits the fork maintainer. The contributor thank-yous are unchanged.

### Task reroll tracker: drop the experimental warning

The "Track task reroll costs" setting no longer warns it is experimental and may freeze the UI — it's stable. Default unchanged (on).

### My Listings: a fresh undercut now shows without opening the item

The Top Order Price column trusted the last-opened order book, so an undercut stayed hidden behind your own price until you reopened the item. It now surfaces the game snapshot's price when it beats you (a rival's by definition, never your own order) — so undercuts show on their own, without ever displaying your own listing or downgrading a genuinely-fresher book. The age column follows suit.

### Labyrinth: the calibration recorder is now passive and accumulates across runs

No Record button any more — every combat fight is kept automatically, per character and tagged with the gear it was fought in, pooled into 10-level bands so a monster's scattered random levels still accumulate. Press **Replay** to judge whatever has built up on your current gear; a loadout change starts a fresh pool. Bounded to 500 fights.

### Labyrinth: a fight recorder and a calibration replay

The Sim accuracy record says _whether_ a room's clear chance is wrong, not _why_ — a timeout and a death are both "lost", and the fixes are opposite. This adds the decomposition.

- **Replay** re-sims the recorded rooms and puts your real damage/s, the monster's, the clear rate and the fight length beside the sim's, each with a noise-aware verdict and a one-line diagnosis of which side the sim gets wrong. **Save comparison** downloads the whole check as one file.
- **Capture** saves the raw tick feed of a fight — stun uptime, ability cadence, per-hit damage — for mechanism-level analysis (previously console-only).
- Measurement fixes found via real captures: damage measured **gross** (not net of your ~16 HP/s regen, which made monsters look 15–40% weaker than the sim); self-healing monsters (life drain, the Dryad) no longer **split one fight into several**; partial-HP fights are dropped; and the diagnosis names all four over/under directions.

### Labyrinth: full-ability sim calibration (testing), tooltip clear-time, tidier panel bar

- Testing setting to model a monster's **full ability kit** in the sim — the labyrinth otherwise builds every monster at tier 0 and drops its gated abilities (the Cyclops's stun, shred, self-buffs). Off by default; it's part of the cache key, so toggling re-sims.
- **Est. clear time** on combat/skilling room hover, shown past the tile's "999+" cap.
- Room Logs top bar wraps cleanly; "Sim accuracy" tab shortened to "Accuracy".

### Labyrinth: stop counting un-fought rooms as clears, and an uncapped sim option

- **Phantom clears removed** — a revealed-but-unfought room (shroud, beacon, floor skip) is marked `isCleared` with no entry; it no longer counts as a win and drags the accuracy record toward "sim too low".
- **Uncapped** toggle lifts the sim's time cap for the next Recompute, so a slow, timeout-heavy room reaches its precision target instead of a wide "(capped)" band.

### Labyrinth: Recompute button, honest attempt counts, and a panel that stays put

- **Recompute** throws away cached clear-chance sims and re-runs the visible rooms — a plain equip doesn't always refresh a sim cached under old gear.
- Room Log shows the server's own attempt count, not just the fights it watched on the combat view: "Won 0/6 · 26 total".
- The panel keeps its scroll position across redraws instead of jumping to the top on every update.

### Undercut alerts finally fire passively, backed by Mooket

The alert distrusts any price older than 15 minutes, but the game snapshot refreshes only ~hourly — so undercuts on items you weren't watching stayed silent for hours. It now also consults the freshest **Mooket** sighting per listing (refreshed every 15 min), reporting its true age, so it can fire for items you never opened. Rides the Price history panel setting.

### Selectable price-history source: mooket I alongside mooket II

A **Market: Price history data source** setting picks between the Q7 pool (mooket II, default — ask/bid/avg/volume) and IOMisaka's original (mooket I — ask/bid only). On mooket I the chart's third line is a computed "Mid", the volume bars vanish, and the goal planner's volume limits switch off (a source with no volume tells us nothing about how fast a thing sells — unknown, not a measured zero). The order books you contribute back follow the selected source.

### "Mooket Refresh" button on the My Listings tab

A **Mooket Refresh** button in the My Listings header pulls fresher Top Order Prices for every listed item from the Mooket pool in one click, patching the fresher ones into the price cache the column redraws from — no opening each item by hand. Skips a sighting older than the game's snapshot, and keeps a one-sided sighting's other side. Rides the Price history panel setting.

### My Listings' Top Order Price refreshes when the market moves

The Top Order Price column on the My Listings tab only redrew when your own listings changed (or, with the age column on, when you re-opened an item's order book), so an undercut fired an alert but left the column showing the stale price. It now subscribes to the same market-data updates the undercut alert uses — a marketplace snapshot refresh or an order-book price patch redraws the column (debounced), so being undercut turns the price red here too.

### Custom Tabs: an enhanced item is no longer double-counted in Unorganized

An enhanced item is tracked under both its base and its `+level` key, so an unassigned one was collected through both — inflating the "Unorganized (N)" count and placing the tile twice. A shared, deduped collector (each physical tile once) now backs both the header count and the lightweight visibility pass (ported from upstream Celasha/Toolasha#627).

### Custom Tabs action buttons heal when the sort-controls row is removed

The +Tab/Export/Import/Expand group is merged into the game's inventory sort-controls row and isn't tracked with the other injected elements, so when the InventorySort feature removed that row the buttons vanished and didn't return. A direct connectivity check now forces a rebuild when they disconnect (ported from upstream Celasha/Toolasha#632).

### Estimated listing age: a null price no longer suppresses a match

Two "your listings beyond the top 20" match sites used a parsed price without checking for `null` (which the parser returns on empty/invalid text). A null coerces to 0 in the price comparison and can hide a correct match; both sites now skip the row instead (ported from upstream Celasha/Toolasha 2.85.0).

### Character switches are serialized, so rapid switching no longer bleeds settings

A rapid character switch could drop a re-init (leaving the previous character's per-character settings applied) or start a rebuild before the last character's teardown finished. The switch lifecycle now runs through one serialized chain, and each re-init verifies it is still for the current character before it applies — latest character wins, nothing dropped or overlapped (ported from upstream Celasha/Toolasha#622).

### Action Filter's pricing mode resyncs after a character switch

The persistent Action Filter never re-initializes, and a character switch skips the per-key change callbacks (the cache is cleared first), so its mode/craft buttons and profit rows could keep the previous character's pricing mode. A new `config.onSettingsLoaded` channel fires whenever settings finish loading, so the filter resyncs (ported from upstream Celasha/Toolasha#630).

### The Unorganized tab no longer vanishes mid-character-switch

The Custom Tabs "Unorganized" bucket was gated on `getSettingValue`, which reads `null` while the per-character cache is briefly empty during a switch — hiding the section until it reloaded. It now reads `getSetting`, which falls back to the schema default (ported from upstream Celasha/Toolasha#636).

### Action-bar display no longer risks freezing the tab on a character switch

`setupActionNameObserver` now disconnects any running observer before replacing it, so a character switch can't leak a duplicate watcher that loops on the stats span and freezes the tab (ported from upstream Celasha/Toolasha#623).

### The Sort Tasks button sorts even with a reroll menu open

A direct press now sorts the board immediately, mid-reroll and all. The automatic passes (auto-sort, sort-after-read) still wait for the board to settle so they never yank a pending click.

### The protected/cap task border keeps up again

It is redrawn right away on a card that is mid-reroll (it used to wait for the menu to close, so the edge looked stuck until you pressed Back), and painted the instant the board opens instead of after a 150 ms delay.

### The task bulk-reroll button is removed

The game only honours a reroll from a real click that opens the menu, which a userscript can't fake — so the button never worked unless you opened the menu by hand first. Reroll protection and the 🛡️ cap/per-task guards are untouched.

### In Progress payout: leaner, plus a Roster button

Drops the token gold valuation and the "No Treasury level seen" nag from the In Progress tab (both kept on the Trials tab), and adds a Roster button that opens the guild roster panel.

### Skilling In Progress panel no longer squashes the game's card off-screen

Injected payout/analysis blocks now take a full-width line above and below the roster+card row instead of shrinking the game's own skilling card to a sliver beside them.

### Skilling trials: no flat projection once slowing is measured, and timestamped readings

Drops the misleadingly-high "On pace (flat)" tier once a slowdown is known (it survives in the tooltip), and keeps a downsampled timestamped reading series in the export so the tier forecast can be checked against what was banked.

### Trial scoreboard: honest damage-taken label, and a runaway split is flagged

Damage taken is now labelled pre- vs post-mitigation (the live stream can only read the latter), and a per-player damage split that runs past the bosses' combined health is flagged as over-attributing.

### Dev builds install over a same-numbered release

The dev build now appends its build timestamp as a fourth version segment, so a reinstall always takes even when the release number hasn't changed.

### Scrolls in the Combat Simulator

The sim and Upgrade advisor now carry the seven Labyrinth combat scrolls (Damage, Attack Speed, Cast Speed, Critical Rate, Combat Drop, Wisdom, Rare Find): a Scrolls section on Configure to sim with them, and a Scrolls mode on Upgrade to measure what each is worth.

## Unreleased — branch `claude/mcs-ingest`

### Trial Swarm now shows a panel on the In Progress tab (test server)

The Trials tab already anchored Trial Swarm once its encounter resolved, but the In Progress fight view stayed blank: the game draws it four separately named monster cards (Beetle, Dragonfly, Wasp, Firefly), none of which is a trial name, so the tile scraper found no card to draw on (a single-monster trial like Jellyfish has one "Trial Jellyfish" card and never hit this).

- **A stand-in tile is drawn when a composite fight is watched.** If a combat fight is streaming and its encounter has no card of its own, Toolasha now stands a tile in — named from the trial, anchored to the fight's monsters area so the panel sits below the fight — and the watched pool grafts onto it exactly as it does on the Trials tab, filling in the tier, pace and banked count. Single-monster trials are unaffected (they already have a card). Only triggers while a fight of that encounter is actually being watched.

### Per-player scoreboard prefers the game's post-trial stats (test server)

When the game's Combat Trial Stats modal has been captured for a trial, the per-player scoreboard now uses it as the authoritative source instead of the streamed estimate — and gains a **Taken** tab. This matters because the live stream only sees the stretch the fight view was open (a mid-fight plugin restart left one measured at ~5% of the trial) and can barely measure damage taken at all (it reads it from health falling per tick, most of it masked by healing).

- **Damage and healing** prefer the modal's whole-trial totals when captured, labelled "from the game's post-trial stats" so a real figure is never mistaken for the estimate. They fall back to the stream, then to the build estimate, exactly as before when no modal has been opened.
- **New Taken tab** shows per-member damage taken — modal-authoritative, with the stream's partial tally as the fallback.
- Purely additive and test-server-gated in practice: the modal only exists on the test server, so nothing changes on live until the feature ships there.

### Trial Swarm's tier, pace and banked count now show (test server)

Trial Swarm fights four differently named monsters at once — Beetle, Dragonfly, Wasp, Firefly — none of which reduces to the "swarm" encounter. So the watched pool from a Swarm fight was filed under no trial, never attached to the Swarm card, and the In Progress tab showed "needs one tier's total to anchor the ladder" and "Banked nothing yet — tier 1 in progress" for the whole hour. (The per-player DPS still showed, because that comes from the damage stream, which recognises the fight a different way.)

- **The encounter of a monster now resolves through the game's own trial→monster listing** (`guildTrialDetailMap`), so any of Swarm's four monsters names the Swarm encounter. The pool is then tagged `swarm` and attaches to the Swarm card, which anchors its tier and fills in the pace and banked lines. Single-monster trials are unchanged — they still resolve from their own name with no data needed. Read live, never pinned, so it follows the game's roster.

### Capture the post-trial Combat Trial Stats modal (test server)

The test-server trials rework adds a post-trial "Combat Trial - Stats" modal with the game's own per-member Damage, Healing and Damage Taken. Those are authoritative where the live damage stream is not: the stream reads damage taken from health falling per tick and captures only a fraction of the real total, and it splits shared ticks by actor, which under-credits the local player. This is the groundwork for showing the game's figures beside the measured ones.

- **New scraper** reads the modal's active tab (per trial) into per-member totals, expanding the abbreviated figures ("1213K" → 1,213,000). It watches the stats table, so switching to another trial's tab captures that trial too. It is header-driven — the combat modal's Damage / Healing / Damage Taken and the skilling modal's Work column are each read by their own header, so neither is mislabelled.
- **Included in the trial export** (`Toolasha.debug.exportTrialData()`) as `trialStatsModal`, so a captured trial can be checked against the measured attribution.
- **Test-server only in practice**: the modal does not exist on the live server, so the observer never fires there and nothing changes — it activates on its own when the feature reaches live.

### Partial-tier card figures no longer trigger a false "tier ladder needs checking" warning (test server)

On the test server, a trial that ends part-way into a tier now states its whole-tier points **plus** the partial credit for that last tier — e.g. a 6-tier enhancing trial that ended 37% into tier 7 states 862 pts, not 840. The banked figure was already correct (the card is used as stated), but Toolasha flagged it as "neither the running total nor the per-tier step… the tier ladder here needs checking," because the reconciliation only knew whole-tier totals.

- **Card reconciliation now recognises the partial-tier shape.** A figure sitting just above the whole-tier total by up to half the next tier's step reads as `partial-tier` (the ladder plus a partial tier), not a disagreement — so the false warning is gone. A short note explains the higher figure instead.
- **Gated to the test server**, like the pace credit: on live the same figure is still reported as a genuine disagreement (no partial rule exists there), so nothing changes on the live server.

### Trial pace credits partial-tier progress (test server only)

The test-server trial rework grants partial rewards for an unfinished tier when a trial ends — 0.5% of that tier's points per 1% of progress, capped at 50%. The "Guild Points on pace" projection now folds that in, so on the test server it matches what the game will actually pay instead of only counting whole tiers.

- **Gated to the test server.** The credit is applied only when the client is on `test.milkywayidle.com` (via the existing `isTestServer()` check). On the live server the projection is byte-for-byte unchanged — no partial credit exists there yet, so live users see no phantom points. When the rule reaches live, this activates on its own with no further change.
- **Only the pace, not "banked".** Partial credit settles when a trial ends, so "Guild Points banked" still counts whole completed tiers; the projection is where the leftover tier is counted. A short note appears under the payout on the test server explaining the higher pace figure.
- The tokens lines (eligible / participant) follow the pace's base points, so they include the partial credit too.

### Undercut alerts stop adding market-API load; rate-limit failures are now visible

The game rate-limits its `marketplace.json` file — a burst of requests (often several userscripts hitting it at once) trips a temporary CloudFront 403 block. The undercut-alert feature had a configurable "re-fetch market snapshot every 1–15 minutes" setting (default 5) that _forced_ a fresh fetch on that timer, which could contribute to that load.

- **Removed the "re-fetch market snapshot every (minutes)" setting.** The snapshot refresh is now fixed at the market cache's own 15-minute cadence and uses the cache-respecting fetch, so it never pulls faster than the cache would on its own — it only touches the network when the 15-minute cache has actually expired. Undercut alerts still work; they just no longer add fetches beyond the normal cache. Nothing to reconfigure — the old setting simply disappears.
- **Rate-limit failures are now called out.** When a market fetch fails with a 403 (or 429), the console explains it's a rate-limit — not a Toolasha bug on its own — and the on-screen network alert says "Market API rate-limited — using cached prices" instead of a generic "outdated data" message. Toolasha keeps serving cached prices and retries on the normal cadence.

### Marketplace resilience ahead of the test-server market rework

Backward-compatible hardening so the marketplace features survive the upcoming (test-server) Marketplace rework without waiting for it to break on the live server. None of this changes behavior on the current live market — it only adds tolerance for the new formats and turns future selector breakage into a visible health warning.

- **Trillion-value prices parse correctly.** The rework raises the max listing price from 100B to 1T, but the price parsers stopped at the "B" suffix, so a "1.2T" price would have been read as 1.2. Added "T" (1e12) handling to the shared number parser and to the order-book / My-Listings price readers.
- **The "\*" boundary marker on My Listings no longer breaks price reads.** The rework marks any listing whose original limit price differs from its resting boundary price with a trailing "\*". The expired-listing price parser is `$`-anchored and would have rejected the whole cell; it now strips the marker before parsing.
- **Marketplace selectors centralized and hardened.** The current-item, order-book, My-Listings, new-listing-buttons and panel selectors were hardcoded with the game's CSS-module hash suffix (e.g. `__3ercC`), which any UI rebuild rehashes. Moved them into the shared selectors file as stable prefix matches, so the market rework doesn't silently sever them.
- **Marketplace health canaries.** Added the marketplace item grid, current item, order books and new-listing buttons to the startup selector-canary check. Marketplace selectors were previously uncovered, so a market update that renamed them failed silently; now it surfaces in the health report.

### More cross-bundle singleton reads fixed in the packaged build

A triage of the 62 modules the bundle-sharing checker flags found several more stateful singletons read from an empty duplicate outside their owning bundle (same class as the loadout/treasure fixes). Fixed so far — all now read the live copy through the bundle bridge, dev-standalone unaffected:

- **Combat Simulator container values.** The sim bundle's copy of the expected-value calculator was never initialized, so `calculateExpectedValue()` returned null and openable containers (chests/caches) showed no expected value in the Combat Simulator. Now reads the market bundle's live calculator.
- **Scroll/buff simulation in gathering & production profit.** The actions bundle's copy of the scroll simulator was empty, so the profit displays and quick-input buttons ignored your configured scroll buffs. Now reads the combat bundle's live simulator.
- **Task Profit "best alternative /hr" + alchemy pin protection.** The action-panel sort/pin singleton was read from empty copies outside the actions bundle: the Task Profit "you could earn X/hr instead" figure never appeared, and toggling an alchemy pin ran against an empty set — which could overwrite the saved pinned-action list. It's now published to the actions namespace and read through the bridge.
- **Custom price overrides apply without a reload.** Setting or editing a custom item price in Settings didn't affect any profit/price calculation until the page was reloaded — Settings (ui bundle) wrote to one copy of the override cache while price math (utils bundle) read a separate copy. The module is now a single shared `Toolasha.Utils` global, so writes and reads hit the same cache.
- **Guild token valuations use the captured Guild Shop rate.** The shrine upgrade advisor and the chat token-value summary read the token-exchange capture from empty copies, so they fell back to the configured token/credit rate instead of the rate scraped from the Guild Shop dialog. Now read the combat bundle's captured rate.
- **`Toolasha.debug.exportTrialData()` exports real data.** The console export command gathered the guild name and trial damage/session/skilling/member-skill data from empty ui-bundle copies (the trial panels themselves were unaffected). It now gathers from the live combat copies.
- **Lab Sim room level during a live run.** The Lab Sim panel read the labyrinth clear-rate singleton from an empty sim-bundle copy, so mid-run it used a skip-derived room level and no live recommendation. Now reads the combat bundle's live copy.

### Loadout-driven features (net-worth exclusions, bulk-sell protection, profit label) work again in the packaged build

- **Features that read saved loadout snapshots now work in the multi-bundle build.** Outside the combat bundle each consumer had its own empty copy of the loadout store (only the combat bundle's copy is fed by the `loadouts_updated` websocket), so anything reading loadouts elsewhere saw nothing. Loadouts don't hold items — their gear is already counted as equipped or inventory — so this is not about adding loadout value; it's the features built _on_ loadouts:
    - **Net-worth loadout _exclusions_ silently did nothing.** If you excluded a loadout, its items were still counted (net worth over-stated), and the exclusion popup listed no loadouts to pick.
    - **Bulk-sell no longer protected loadout gear** — items saved in a loadout could appear in sell suggestions.
    - **The profit panel's "Loadout: …" label** showed "Equipped" instead of the active loadout's name (display only — profit numbers were never affected).
    - All now read the shared loadout store through the bundle bridge (the pattern the sim adopted in 2.92.0). The dev-standalone build was never affected.
- **New regression test** (`cross-bundle-globals`) fails the build if any bridge-backed stateful singleton is default-imported across a bundle boundary without also reading it through the bridge — the class of bug behind this, the treasure tracker, and the 2.92.0 combat-sim fix.

### Treasure tracker button in Settings opens the real ledger (packaged build)

- **The "Treasure" button in the Settings utility bar now opens the populated chest ledger instead of an empty one**: in the multi-bundle build, Settings direct-imported the treasure tracker and got its own empty copy (never subscribed to `loot_opened`), so that button showed "nothing opened yet" while the command-palette button showed the real history — and using the empty panel's reset/import could overwrite the real saved ledger. Settings now reads the shared, websocket-fed tracker through the bundle bridge (the same pattern the command palette and combat-stats calculator already use). The command-palette route and the dev-standalone build were never affected.

### Combat labyrinth clears fixed in the packaged (release) build

- **Combat rooms no longer sim at 0% — and skip-level recommendations no longer go negative — in the multi-bundle build**: the sim bundle carried its own empty copy of the loadout store, so applying a loadout to the combat DTO found nothing, the fight was simmed on a naked character, every combat room read 0% clear, and the Recommend search drove the threshold negative. The adapter now reads the shared, websocket-fed loadout store through the bundle bridge (the pattern the other cross-bundle consumers already use), so the real gear is applied. Skilling rooms and the dev-standalone build were never affected.

### On-demand health report

- **`Toolasha.debug.health()` and a Ctrl+K "Health report" command** now open (and copy/console-log) the diagnostic report anytime, instead of only when an error toast appears.

### What's-new popup reads cleanly, with a newcomer overview

- **The update popup now renders the changelog as formatted text** (no raw `##`/`**`/backticks), entries are condensed to one line each, and fresh installs or arrivals from upstream Toolasha get a "Toolasha — at a glance" overview above it.

### Labyrinth pathing reveals more of the floor on ties

- **Equal-cost routes now prefer the one that uncovers the most unknown rooms**.

### "Guild" is no longer turned into a /profile link

- **The guild-wide broadcast "Guild has reached level N!" stays plain text**.

### Selector canary stops false-alarming on alchemy and enhancing panels

- **The "Skill action panel (name)" canary no longer cries "game update?" on alchemy/enhancing screens**.

### First run: returning users can keep their settings

- **The welcome dialog for returning users now leads with "Keep my current settings"**.

### Preset renamed: "Everything on" → "Defaults"

- **The preset bar's "Everything on" button is now "Defaults"**.

### Portrait DPS extras are now opt-in

- **The seven Portrait DPS sub-readouts default OFF**.

### Undercut alerts stop missing undercuts you didn't watch happen

- **A configurable market refresh, on while undercut alerts are**.

### The combat profit panel leads with the live rate again

- **The sim's forecast moves out of the headline**.

### The combat sim's Guild Shrine gets per-shrine targets

- **A "Targets" grid on the Combat Simulator's Guild Shrine upgrade, matching the Lab Sim's**.

### The trial DPS split says how much of the party it actually covers

- **"Per player · 3 of 7 · watched" instead of implying three people did everything**.

### The per-player readout stays on its own tile, its panels stop drifting, and the panel does less work

- **A watched fight's per-player DPS no longer dresses every tile**.

### The startup freeze on an enhanced inventory is gone

- **Pricing a +20 inventory no longer stalls the main thread for a second**.

### Startup traces stop blaming the wrong feature

- **A feature that only parked in `await` is no longer named the slow one**.

### Damage totals stop swapping bodies at tier rollovers

- **Per-player totals are banked by name at every wave boundary**.

### The In Progress tab stops trusting stale answers — and combat trials learn their tier

- **A stated tier is only believed for the pool it was stated with**.

### The pace projection stops dying after one tier

- **"On pace for 13 tiers → T13" with twenty-six minutes left is gone**.

### The damage tracker keeps its names, heals honestly, and a fresh character knows the tier cold

- **A refresh no longer forgets who is fighting**.

### The battle-info button finds the real units — and becomes its own tool

- **The profile cycler matches the game's own unit boxes now**.

### The trials panel knows its tier immediately, and the pace projection stops lowballing

- **The In Progress tab now identifies the tier on its own**.

### Release housekeeping

- **GreasyFork's version history will show real release notes**.

### The silent failure modes get their alarms, and two calculators become one

- **The bundle-sharing rule is now executable**.

### Thin markets stop lying in the rankings

- **The liquidity cap the goal planner already obeyed now governs every profit surface**.

### The panels compare, lint, and remember

- **The profit panel quotes the sim on the zone you're in**.

### A ledger for flips, luck for foragers, and spreadsheets for everyone

- **A trading ledger measures what flipping actually earns**.

### The trial record remembers, the sim gets audited, and silence gets alarms

- **Past weeks return to the trials panel and guild report**.

### Live combat learns seven more things, each its own switch

- **Enemy tiles answer the questions a fight actually asks**.

### The portrait meters stop jostling the party

- **Every player's DPS meter is two lines, always**.

### Every player name opens a profile, and the dungeon knows its worth

- **Player names are clickable wherever a dungeon shows them**.

### A canceled battle start is not a run

- **The dungeon tracker no longer records phantom runs from failed ready-checks**.

### Hybrid attribution: thorns and DoT damage go to their owners

- **The damage attribution learned what the party recording proved**.

### Party lint ignores tools, and ability books answer three more questions

- **Tool slots are exempt from the skilling-gear warning**.

### The sim summary reads in the units a player plans in

- **XP/day → XP/hr**.

### Entry keys are consumables, and chests point at their keys

- **The consumables tracker now carries the dungeon's entry key**.

### Ability book counts respect the experience already earned

- **The Upgrade tab priced every ability level-up from the floor of its current level**.

### An attribution referee, ahead of any verdict on the presence method

- **`npm run compare <recording.json>` replays a combat recording through two attribution methods side by side**.

### Departed members stop haunting the roster

- **A member who left the guild no longer sits in "Gone quiet" forever**.

### The wire speaks: five trial message types the game was sending all along

- **`new_guild_battle` fires at every tier and states everything**.

### Mixed-bonus cards contribute their true base to the token sum

- A card banked across a Builder's Hall upgrade divides cleanly by neither bonus, so its base points now come from the exact ladder (1,100 at T10) instead of the slightly-low division (1,091)…

### The notice board is not a trial, and the ladders are theorems now

- **A guild notice board can no longer become a trial tile**.

### The watched fight knows its own name, and a wipe is an outcome

- **The spectated stream attaches to the encounter being watched, and only that one**.

### Spectating measures: the trial fight is on the wire after all

- **Per-player trial measurement is real**.

### The cycler clicks the people fighting beside you

- **A fight on screen outranks the roster walk**.

### Beacons cover the way out before they chase dark corners

- **A set beacon count is planned against the same objective the automatic one uses**.

### The arrow points at the count, completed means completed, and estimates say so

- **"On pace for 4 tiers → T5" is impossible output now**.

### Neither ladder has a wall, and a click is not a capture

- **The profile cycler counts replies, not clicks**.

### The badge means banked, and the skilling ladder is a rule now

- **Mid-trial, the stated tier badge counts tiers banked and the fight is on badge + 1**.

### The recorder survives its first real trial day

- **Auto-record actually arms now**.

### Release plumbing

- **Guild features moved from the ui library to the combat library**.

### A trial report your guild can actually read

- **Copy guild report**.

### A warning before the task board fills, and trials that predict themselves

- **Task-slot alert**.

### Path shows the way to the plan, not just the plan

- **The rooms between you and the first planned room are lit too**.

### Path stops planning a floor that has already moved on

- **Rooms you have already shrouded are no longer marked "Shroud" again**.

### Trial cards say what their phase can know, and stay off the notice board

- **No more trial card built out of the Overview tab**.

### Poisoned trial records heal themselves, and trials announce their own schedule

- **The stale record from before the switch fix cleans itself up**.

### Trials stop following you to your next guild, and the tab stops yanking you around

- **A character switch drops everything**.

### The bulk reroller now closes the door behind itself, and takes the free reroll on faith

- **Protected tasks get their green outline back after a bulk reroll**.

### The trial recorder grew hands, eyes, and a scoreboard

- **Auto-record**.

### The overlay's ⚙ popover no longer traps you, and keeps up with what it shows

- **It can never cover the panel's header again**.

### Trials round three: exact digits, honest captions, and a block that finally sits still

- **Payout figures in full digits**.

### The trial payout math is now exact, verified against four real payouts

- **Combat trial cards finally produce a rate**.

### The trial export was read, and it proved six defects — all fixed

- **Per-player DPS now arms during real trial fights**.

### Trials know who hit what, and why the payout was blank

- **Per-player DPS on combat trials**.

### Trials read the game as it actually is

- **The real structure, from live screenshots**.

### The trials feature existed on a guess

- **Why nothing trials-related ever rendered**.

### The lab sims the run you choose

- **Token buffs are settable from Configure**.

### Rates bounded by the market and your wallet

- **A rate is capped by how fast its output actually sells**.

### The reroll chooser is finally read as it is

- **The MooPass reroll failure's real cause**.

### The goal planner shares, navigates, and answers instantly

- **Goals share one resource ledger**.

### The sims finish their own homework

- **Skilling gear rows expand like combat rows**.

### Nine small debts paid

- **The lab supplies planner believes the server**.

### The goal planner stops promising billions

- **A rate is only a rate while its inputs last**.

### The lab sims what can actually win

- **Skilling rooms leave the lab combat list**.

### Task cards catch up after a reroll

- **The stale picture and the stuck free reroll were one bug**.

### eWatch learns houses too

- **House room levels are savings goals**.

### Ability swaps follow the guide

- **Swap candidates come from the community build guide now**.

### The lab reads the same buffs as the sim

- **The live clear-rate readout was scoring against buff levels frozen at page load**.

### The budget planner spends the money

- **The empty 500M plan is fixed**.

### Three more reasons to look up

- **Labyrinth run finished**.

### The listing says who built what

- **`docs/GREASYFORK.md`**.

### The session starts when combat does

- **The Combat Level session no longer waits for its panel**.

### Tokens per hour, finally measured

- **Task completions are now recorded**.

### Zones compared on even footing

- **"Max-tier Food" option for all-zones sims**.

### The skilling sim sims your skill

- **Tool candidates are scoped to the skill being simmed**.

### The buff tells you before it leaves

- **Community buff expiry alerts**.

### The sim comes home

- **The community buff cap is 20 after all**.

### The combat sim answers back

- **Community upgrades work**.

### The lab sim grows up

- **Task Fight is gone from the lab sim**.

### eWatch learns abilities

- **Ability levels are savings goals now**.

### The overlay fits the screen it's on

- **A floating launcher on mobile**.

### Panels behave on a phone

- **Floating panels stay on screen**.

### Sync works from a phone, and can't eat itself

- **`@connect gist.githubusercontent.com` added to the userscript header**.

### The manifest error says what it means

- **"Manifest is corrupt" now tells the truth**.

### Everything fits now

- **The sync payload is gzipped before upload**.

### The gist can keep a secret

- **Optional sync passphrase**.

### Console-dump fixes

- **The Shrine Upgrade Planner stays in its box**.

### The token knows its own price

- **Guild token value now uses real exchange rates**.

### The goal planner learns two more trades

- **Alchemy ranks without a DOM**.

### Housekeeping

- **The WebSocket prototype wrapper is gone**.

### The books balance: first swings were invisible

- **The Sim Accuracy undercount is fixed**.

### Iron Cow re-forces instantly, and one more clickable name

- **Applying a preset (or All Off / Restore) while Iron Cow Mode is on now re-forces the locked settings immediately**.

### Settings you can actually get to

- **Picking a setting in Ctrl+K now opens settings itself**.

### The recorder answers back

- **Record for a target**.

### The black box was ours

- **The black band at the foot of action panels is gone**.

### The recorder grows up

- **Recordings snapshot your loadout at record time**.

### Idle members are clickable

- **Names in the guild Overview's "Idle members" list fill `/profile Name` on click**.

### Mid-run restock honesty, and the tooltip that would not die

- **The lab planner stops suggesting purchases that cannot help**.

### Five new tiles and layouts that follow what you're doing

- **New overlay tiles**.

### Companion privacy, a Record button where it belongs, and mooket hygiene

- **Toolasha no longer names the companion script anywhere**.

### Build Score opens something now

- **New Build Score breakdown panel**.

### The watch card stops overcharging, and laddering becomes a mode

- **Real pricing bug fixed**.

### Iron Bell Farming

- **"Iron Cow Farm" is now "Iron Bell Farming"**.

### The overlay earns its screen space

- **Empty tiles stop shouting**.

### Overlay tiles open their panels

- **The Net Worth, Coins, Market Listings, and Inventory Value tiles now open the networth history chart**.

### Iron Cow Farm

- **New "Iron Cow Farm" panel**.

### Multi-target lab analysis gets the big swaps

- **Combined forced-armor swaps now appear under All targets / Chosen targets**.

### Dungeon keys cost whichever way is cheaper

- **Dungeon profit charges each entry/chest key at the cheaper of buying or crafting it**.

### Building levels cap at 20, trial tiers at 21 — and never each other

- **Guild building bonuses clamp at the real level-20 cap**.

### The task board stops fighting the game

- **The zone-index badge stops churning**.

### The lab planner reads the right bag

- **During a run, supply counts come from the run itself**.

### Dungeon run history stops lying

- **A run-start key count can no longer end a fresh run at wave 0**.

### Backups say whose they are, and adoption asks first

- **`Toolasha.debug.claimLegacyData(charId)`**.

### Labyrinth: split apart, supply-aware, and honest mid-fight

- **The 5,300-line labyrinth module splits into six**.

### Adoption accident: fixed, and repairable

- **The wrong character can no longer inherit your data**.

### The dungeon tracker earns its tests

- **252 new tests**.

### History stops rewriting itself on every event

- **The append-heavy history stores split into per-period records**.

### Tokens get a price, shrines get a debug command

- **Guild tokens are now priced through the guild shop's token→credit exchange**.

### Cross-tab sim exports can't lie about whose gear they are

- **The combat-sim export bridge stamps every payload with the writing character**.

### The variance math earns its tests

- **180 new tests**.

### Listing-age estimates get sharper over time

- **The anonymous id→time anchor pool now grows**.

### Missing-material tabs retire themselves

- **Pinned marketplace tabs now watch your inventory**.

### Guild Shrines series in the networth chart

- **The networth history chart gains a Guild Shrines line**.

### Guild trials get pace, ETA, and payout math

- **Trial cards on the In Progress tab now carry live info**.

### Guild shrines in your score and your net worth

- **The profile score panel gains "+ Guild Shrine" lines**.

### Goal Planner

- **New Goal Planner panel**.

### Sim state scoped, and honest enhancement numbers in the tooltip

- **The last cross-character leaks in the sims are closed**.

### Doubled profit line fixed, stuck marketplace tabs cleared

- **The action bar could show two "Profit: …/hr · remaining …" lines**.

### Market and inventory state stops leaking between characters

- **Ten market/inventory stores scoped per character**.

### Combat and labyrinth records stop leaking between characters

- **Eleven combat-side stores scoped per character**.

### Panels and task prefs stop leaking between characters

- **Panel open-state is per character now**.

### Lab sim catches up to combat sim

- **Comparison runs for single-target lab fights**.

### The sim sees your real abilities, and shrine levels finally arrive

- **Ability desync fixed**.

### Combat sim results that lead with the answer

- **Headline tiles at the top of the Results tab**.

### Clickable names everywhere chat shows one

- **The /profile click trick now covers every name Toolasha renders**.

### Per-character storage helper

- **New `characterKey` helper**.

### Official formulas, ladder costs, and the sim graded against reality

- **Lab math now follows the official formulas you supplied**.

### Upstream ports (verdict-gated) and honest task damage

- **Task damage only counts on task fights**.

### Advisors sharpened, your own rates guaranteed, and 1,200 new tests

- **Upgrade advisor fixes**.

### Sync, account view, honest philo math, and lab fixes

- **Cross-device sync**.

### Guild shrines, forecast calibration, roster intelligence, and storage that survives months

- **Guild shrines everywhere they matter**.

### The simulator models more, and breaks less

- **taskDamage now raises damage**.

### Ctrl+K, named layouts, and the features finally talk to each other

- **A command palette**.

### Notifications, provenance, and selectors that survive game updates

- **Opt-in notifications**.

### Panels remember where you put them, and stacking becomes predictable

- **Both simulator panels persist their geometry**.

### The product-review batch, wave one

- **Back Up Everything / Restore Backup**.

### The Combat Simulator panel catches up to the Lab Simulator

- **Stop no longer throws away finished work**.

### Sim accuracy: house rooms, guild buffs, and the Experience token

- **REVERTED (player-verified): house wisdom does apply to combat in the live game — the filter below was removed again**.

### Panels stay reachable and dialogs stay on top

- **Confirmation dialogs can no longer hide behind panels**.

### Every setting now does what it says — a full audit of all 346

- **Five checkboxes did nothing at all**.

### The Sell Queue is back

- Removed one commit ago on the belief it was dead; restored unchanged — module, feature registration, and the `sellQueue` setting.

### The mobile sweep, part three: gestures that had no touch equivalent

- **The Sell Queue feature is removed**.

### Panels can be dragged with a finger

- Every drag and resize in the script listened for mouse events, and `mousedown` never fires on a touchscreen — every panel was simply immovable on a phone, the dungeon tracker included.

### A mobile mode, auto-detected and overridable

- **Mobile mode**.

### Arriving from another build of Toolasha asks before anything new runs

- Someone switching to this fork for the first time — usually from upstream, whose settings live under the same storage keys…

### A what's-new popup, once per update — with the new settings live in it

- After an update, a popup shows what changed and lists every setting that did not exist in the build you had before, **with its real control**…

### New settings can be made to start off

- **"New settings start turned off"**.

### Guild joins get a clickable name too

- "Mazo has joined the guild!" now gets the same clickable name as level-up announcements — clicking fills `/profile Mazo` into the chat input.

### The treasure popup sizes itself to the chest it is showing

- Opening the per-chest popup already measured its content and sized to fit — and then the remembered height from a manual resize was applied on top…

### Moving the popup no longer flips "Popup follows the chest dialog"

- Dragging the popup used to silently pin it — one nudge and it stopped following the chest dialog, with nothing on screen saying why.

### The shared seed pairs the baseline again — no more phantom DPS from skilling rooms

- Yesterday's change gave every batched candidate one worker while the baseline kept splitting its hours across four.

### Six of the twelve "background" seconds were a timer, not work

- The new trace showed it plainly: the guild tracker's `save history` took 6013ms while loading the same data took 10ms.

### The thread-cap override renders now

- The new "Ignore the thread caps" setting declared itself as a type the settings panel doesn't know (`boolean` rather than `checkbox`) and drew as "Unknown type" instead of a switch.

### Two features were holding the whole start up for thirteen seconds

- **Guild XP tracker (6.5s)**.

### PFormance can now say _when_, not just _how long_

- **A Startup section**.

### Export the trace

- Two new buttons on the panel header: **⧉** copies the whole trace as text — environment, timeline, the gaps, the slowest features with their parts, and the busiest handlers…

### An option to take the thread setting literally

- Max threads is normally clamped to your core count, and an analysis runs at most six simulations at once…

### Fan out a single run, queue a batch — measured, not assumed

- The previous entry guessed that a long combat simulation, which already splits its hours across every worker, left no room to run candidates concurrently.

### Concurrency, with the sharp edges filed off

- **A failed simulation no longer leaves the queue running**.

### The budget plans for a whole run, not for one fight

- A labyrinth run is ten fights in ten loadouts, and a purchase only helps the rooms it reaches — so "one upgrade per slot" was answering a question about a single fight.

### Verify together says what it is wearing

- It always installed **every** pick that applies to a loadout, all at once — the tooltip just never said so.

### Fights simulate several at a time

- Every labyrinth fight is its own worker with its own seed and its own trial count, and they were being run one after another while the rest of the machine sat idle.

### The simulator is about four times quicker at rebuilding stats, and fury feels it most

- **Equipment totals are computed once**.

### One purchase now counts for every loadout it would improve

- A tier upgrade is one item that every loadout can share, but which rooms it was credited for was decided by matching the **exact piece it replaces**…

### ΔAttempts says how much of itself is noise

- Every win rate is a proportion measured over a finite number of simulated attempts, and the headline figure sums ten of them through `1/p`, which magnifies the error badly at low win rates.

### Budget mode: what to actually buy

- Type a budget — `500m`, `1.2b`, `750,000,000` — and the panel plans the best set that fits, rather than repeating that one item is the best single item.

### Verify together, because gains do not simply add up

- Every row is measured on its own against the same baseline.

### Per 1B is now Per 1M

- The value column reads in attempts saved per million coins.

### All Fights columns sort, and the panel opens big enough to read

- Every column in the All Fights table is a sort now — click Cost for the cheapest first, Rooms to see what reaches the whole run, Avg ΔWin for the biggest single-room gain.

### No more melee shields recommended to ranged builds

- Trading a two-hander for a main-hand plus off-hand offered two off-hands: the best one matching the weapon's style, and the highest-item-level one overall.

### Cached labyrinth sims notice when you enhance something

- The fingerprint that decides whether a cached room sim is still good was taken over the stored loadout contents.

### Loadouts are read at the enhancement levels they actually wear

- A loadout snapshot is parsed from the game's wearable hash, and that hash carries the enhancement level from the moment the loadout was last saved…

### Export any of the three Lab Simulator analyses to CSV

- The Upgrade table, the All Fights table and the Skilling Upgrade table each carry an **Export CSV** button now.

### Skilling gear was being offered to the wrong skill, or to none at all

- **Celestial tools and skill outfits were never offered at all**.

### All Fights only sims a piece against the loadouts that wear it

- The all-fights analysis pooled candidates from every fight and then measured each of them against every fight.

### Every sim says how long is left

- The progress bars said how far in a run was, which is not what anyone watching an upgrade analysis wants to know.

### Ability upgrades are priced in books, and credit nothing back

- An expanded "Fireball Lv48 → Lv53" row read `Buy fireball +53 — no price found` and `Sell fireball +48 — 0 back`.

### Bulk Sell read the wrong field off the watchlist

- `hrid` is what a watchlist entry calls the item; `itemHrid` is what an inventory item calls it.

### The Lab Simulator applies the default monster's loadout

- Picking a monster applies the labyrinth loadout assigned to it, but the monster the panel _opens_ on was never picked, so it opened on whatever gear happened to be equipped…

### Everything — All Fights, per gold

- A new Upgrade mode that walks **every labyrinth fight** at its skip level with its own assigned loadout, sims equipment, ability levels and combat levels against all of them…

### Skilling gear is offered at +5

- Nobody buys a celestial tool and leaves it at +0, so pricing and simulating one there answered a question nobody asked…

### The Upgrade tab's controls fit

- The shared select style is `flex: 1; min-width: 0`, which is right for a row of two and wrong for a row of seven: Player and Mode were squeezed down to a caret and nothing else.

### Skilling upgrades can suggest gear you do not own yet

- The skilling advisor could only ever offer to **enhance what was already on**, which meant it was silent about the two upgrades that actually move a labyrinth skilling room: a celestial…

### Bulk Sell never sells gear that is in a loadout

- A loadout is a claim on an item: you are still using it, just not right now, and you find out it is gone the next time you switch to that loadout.

### And the Watchlist source leaves enhanced gear alone

- Matching every enhancement level of a tracked item is right for stacks and wrong for equipment: the list tracks "Gobo Defender", and a +10 was swept into the queue at six million coins.

### And can weigh the Critical Aura as an upgrade

- A **Crit Aura** switch on the **Upgrade** tab adds the Critical Aura to the candidates, ranked beside your equipment and ability upgrades with its own cost…

### The Watchlist's switches moved to its top bar, and there is one more

- Both are in the header now: **Dots on/off** and **Menu button on/off**.

### Bulk Sell can sell the watchlist

- A **Watchlist** entry in the source picker, beside All items and your inventory tabs.

### And its rules are editable from its own panel

- A gear on the Bulk Sell panel opens the three insta-sell thresholds and the vendor switch.

### The headline figures come with a scale

- Two numbers on the summary card had no way of being read.

### Combat rooms can say something in ten fights

- Only skilling rooms recorded per-action data, so a combat room's entire signal was clears over attempts — which needs hundreds of fights to close an interval, and a room gives you ten.

### Mark a point to measure from, instead of throwing the record away

- Reset was the only way to answer "has it been right _since_ I changed something?", and it answers it by destroying everything that came before.

### And each room type opens on a click

- Closed to start with.

### The accuracy list is in the game's order

- It was sorted by how often each room happened to be fought, which is no order at all if you are looking for a particular room…

### Room timings are compared per clear, on both sides

- The calculator's `expectedSeconds` is **time per clear including the attempts you lose** — for a fight, the average fight length divided by the win rate; for a skilling room…

### The double rate was being divided by the wrong thing

- A double rolls on a **successful** action; the record counted them against every action.

### And the success rate is now measured per room rather than per action

- A skilling room ends the moment you clear it.

### The sim accuracy record can leave the browser

- An **Export** button on the Sim accuracy tab copies the whole record as text.

### And a reading per room type, across every level of it

- A per-level row is the honest unit — Crafting at 190 and Crafting at 202 are different fights — but it is also a small sample, and small samples say nothing.

### Consumables are coloured against the target you set

- A consumable lasting two days is fine if you asked for one and is the thing to go and fix if you asked for three.

### Swept the rest of the panels for the same start-up race

- **The Houses panel**.

### The chest popup says which side of the book it is pricing at

- TReasure always values loot at bid and labels the figure "bid".

### The target the Consumables panel was saving never came back

- The write was fine; the read was not.

### The Treasure header caught up with its settings

- The header is built once, and a panel reopened at start-up builds it before the settings arrive — so it sat there claiming "Token value / Cowbells counted / Luck" whatever you had actually…

### The Consumables panel remembers itself, and remembers the target

- It reopens if the page was left with it up, like the rest of them — and it keeps the duration you picked.

### The cost lines on the consumables tile are left-aligned

- The tile centres its text.

### The Treasure tile shows a chest

- The overlay's generic chest glyph, replaced with the Large Treasure Chest's own art.

### The Treasure panel had a second thing to wait for

- Its chest list arrives with the game's data; its **ledger** comes from storage, and that lands later still.

### The Treasure panel stopped waiting forever

- A panel reopened at start-up is drawn before the game has sent anything, so it drew "Waiting for the game to send its chest data…" — and nothing redrew it.

### Chest contents keep their order

- The item rows inside a chest were ordered by what each was worth, which meant they rearranged whenever a price moved and whenever the cape or cowbell valuation was changed…

### The chest popup closes on a click away again

- Pinning it used to switch that off, on the reasoning that a moved popup wants to stay.

### The consumables tile reads like CRack's

- **The item is named**.

### The marketplace badge is the game's badge, with our number in it

- Two things were wrong, and the first explains the second.

### A click is not a drag

- Dragging a panel by its header fires an "it was moved" callback on release — and it fired on a press that never moved, which for most panels means saving the position it already had…

### The unpin button no longer disappears when you press it

- It was only drawn while the popup was pinned, so pressing it removed the button — which reads as the button breaking rather than as the setting changing.

### Remembered panels actually reopen

- **The database was not open yet**.

### The treasure popup resizes in every direction again

- It was capped with `max-height`, and the resize grip writes `height` — so dragging the corner downwards changed a number nothing rendered, and the popup could be made wider but never taller.

### Sort the chest list

- The Treasure panel lists every chest in the game, ordered by how far each sits from expectation — which is the right answer to "which one let me down" and the worst possible one for "where…

### The marketplace badge counts the finished ones

- It said 2 for a filled sell order sitting beside a buy order that had taken 130 of 719 — and collecting those 130 does nothing except silence it until the next fill.

### Panels remember whether they were open

- **A feature being disabled does not count as closing a panel**.

### The treasure popup, closer to TReasure

- **Rows that say nothing are gone**.

### Portrait meters read like DPs, and the monsters get one too

- **Two lines per character**.

### No arrow on the time-to-level tile

- `Defense → 130:` ellipsised to `Defense → 1…` and lost the very number the arrow was introducing.

### Portrait DPS was drawing, and being cropped away

- The meter was positioned at `top: -14px`, outside the portrait tile's own box.

### Refinement chests are not completions

- A refinement chest takes a chest key to open like any other, and **no entry key**, because it is not what a completion pays.

### Why the marketplace badge is hidden, on demand

- `Toolasha.Debug.marketBadge()` in the console reports what the filter can see: whether the setting is on, how many listings it found and from where, which of them count as finished…

### Audited the rest of the codebase for the same start-up bug

- Sixteen features subscribe to `character_initialized`, and every one of them registers that listener from inside the handler for that same event…

### Fixed: the marketplace badge stayed down even for finished orders

- **It was subscribing to an event that had already fired**.

### Fixed: the time-to-level tile named the level you already have

- It read "Melee 135" beside a time, for a level long since earned.

### Past sessions in the loot panel

- **A picker across the top**.

### The game's own artwork, where the game has some

- **Any sprite sheet, not just the item one**.

### The houses grid reads like JHouse

- **Every room carries the skill it boosts**.

### Damage on the battle portraits

- **Matched by name, not by position**.

### Fixed: a party you left stayed in the DPS table, and your name appeared twice

- **Leave a party of five and slots 1 to 4 stop being anybody**.

### One set of glyphs for the overlay

- Emoji were chosen per file, so a coin was 🪙 in one row and 💰 in another and the overlay read as several tools stacked rather than one.

### Party Loot, behind the profit tile

- **A card per character**.

### Houses: rooms you can switch off, and the materials you are actually short of

- **A checkbox per room, as JHouse has**.

### The overlay filled in on the next wave; now it fills in on load

- **The snapshot was already being written, and only the popup read it back**.

### A restored run is dropped when it stops describing anything

- **Elapsed time is the wrong test, and it is the obvious one**.

### A refresh no longer throws the dungeon away, and Total Profit shows the party

- **The chest reading survives a reload now**.

### Counted keys, counted completions, and a level gap that was invisible

- **Keys are counted continuously, not sampled**.

### A dungeon is measured by its chests

- **The drop-quantity bonus is the whole of the randomness**.

### The Profit panel answers for the whole party

- **A row per character**.

### Party Luck cannot measure a dungeon, and should say so

- Written down as a known gap, and fixed by the chest reading above.

### Fixed: in a five-person party, whoever tanked collected everyone else's damage

- **The bottom rung was "only one character in this tick, so it was them"**.

### A recorded party, and what it settled

- **Two characters, twelve battles, two minutes**.

### A kill is priced from the tick, not from the screen

- **The DPs panel takes it from there**.

### The caster is identified by an attack counter

- **The caster is identified by that counter now**.

### The auto-record switch turns itself off

- It writes its file and puts the switch back, so the next load is an ordinary one.

### Fixed: a refresh named the first monster of the wave and no others

- **The panel is read on every tick until a battle is announced**.

### The recorder can catch the refresh

- **Auto-record combat on load**.

### Fixed: everything went to Unknown Enemy, and the fixture was why

- **`atkCounter` is what identifies the attacker**.

### The payload names the attacker after all

- **A monster in the delta with nothing changed is the one that swung**.

### Reloading mid-fight no longer costs you the monsters' names

- **The names are recovered from the battle panel**.

### Encounters & Kills, against what the zone owed you

- **Actual against expected, per monster, with the difference as a percentage**.

### Fixed: IHurt showed zeroes, and DPs was broken in the release build

- **The panel now imports the tracker instead of reaching for a global**.

### The Deaths panel is IHurt now

- **Damage taken and health regenerated, side by side and never netted**.

### Fixed: the Overlay switch was invisible

- **It is no longer copied from a tab the game has hidden**.

### Fixed: docking cut the bottom row of tiles off

- **The column is measured against the window rather than against its parent**.

### An Overlay switch in the character tabs, and somewhere for the overlay to live

- **An Overlay switch beside Inventory**.

### A tile with nothing to report says so

- **Every row can say what it would rather say when idle**.

### Fixed: a small tile could not be made bigger again

- **The grip is drawn above the buttons**.

### The DPS, Over Expected and Luck tiles line up

- **The lines of a tile share columns**.

### Drop Luck breaks out per player after all

- **A row per player, each against their own distribution**.

### Only-numbers options for the luck tiles

- **Luck: only numbers**.

### The DPS and luck tiles, in OPanel's shapes

- **DPS reads to a tenth**.

### A recorded fight, replayed as a test — and a second bug it found

- **Monsters were being named from a field the payload does not carry**.

### Fixed: every hit was credited to whatever was cast first

- **The field has two spellings**.

### Recording combat, so attribution can be settled rather than argued

- **A Record button in the DPs header**.

### The enemy rows belong to the player who fought them

- **Per-player, per-enemy tracking**.

### The enemy-HP card, laid out as DPs lays it out

- **The three figures are the headline**.

### The damage table reads at any width

- **Proportional columns instead of fixed pixels**.

### Per-enemy tracking, and DPs' second reading of the run

- **An enemy row per monster**.

### The Damage panel is DPs' table

- **A table with DPs' own columns**.

### Fixed: the blue box around Queue and Start

- **The strip is painted a dark literal**.

### The action panel fits on the screen again

- **The modal stops growing at the height of the window**.

### Sort the task board after reading new tasks

- **A new option: sort again once you press Read**.

### Crafts are priced with your tea, and open the marketplace on what they are short of

- **Artisan tea was not being counted**.

### The revenue tile reads profit the way the panel does

- **The tile follows the case you picked**.

### The MooPass is a cost you can count, and the fourth corner of the book

- **Tax On subtracts the MooPass from every case**.

### Enhancement costs follow your enhancing loadout, and Combat Profit shows its working

- **It was reading whatever is on your character right now**.

### The enhancement cost is your bench, and one luck panel instead of two

- **It was costing the run at somebody else's bench**.

### Fixed: the cape costing never fired, a layout came back rearranged, and the game drew over the panel

- **The anvil path was gated on the wrong question**.

### Capes are priced at the anvil, crafts go through the planner, and a layout survives the trip between characters

- **A cape has no ask, so it was unpriced forever**.

### EWatch: craft it yourself, sell per piece, and a bar on the tile

- **"I will craft it."**.

### Fixed: EWatch never had income data, and its tile omitted the enhancement

- **"No income data", always**.

### Fixed: EWatch counted coins it could not spend, and hid the slots by default

- **The coin figure was reading every coin row the game holds, not the one in your inventory**.

### EWatch gains Lock, Refresh, and the picker where it belongs

- **Lock and Edit are the panel's two shapes**.

### Fixed: an unpriced drop is a row, and a dropdown stops closing under you

- **Anything a chest drops now gets a row**.

### EWatch is laid out by slot

- **A section per equipment slot**.

### Treasure was dropping the scrolls, and EWatch gains its item picker

- **Scrolls were missing from the chest contents**.

### The Party Luck panel — LYuck's item table

- **Session Statistics**.

### Luck and Over Expected are a line per player

- **A line per player, then the total**.

### The combat simulator is its own bundle, and the combat bundle stops scraping its ceiling

- Combat has a megabyte of headroom instead of six kilobytes, which is what the per-player luck work needs.

### Equipment Savings — the gear you are saving for, and when you will have it

- **What an upgrade costs is not what it is priced at**.

### Fixed: the Drop Luck panel said `[object Object]`

- `describeLuck` returns `{text, tone}` and the whole object was handed to the line, so the verdict rendered as `[object Object]` where the words should be.

### The DPS tile is a line per player, then the total

- DPs' shape: **name, damage per second, hit rate** for each player, and a **Total DPS** line under them.

### Charm panel folds are remembered between sessions

- They survived a refresh but not a reload.

### Fixed: the Charms panel kept unfolding sections you folded away

- Each section's fold lived in the DOM, and the panel rebuilds its whole body every few seconds — so every refresh put all three sections back to the shape they open in.

### Fixed: the charm slot was read with the wrong kind of key, and the panel is QCharm's

- **It asked the equipment map for `/equipment_types/charm`**.

### Clicking a book fills the buy dialog in

- **The count is already typed in when the marketplace's Buy Listing dialog opens**.

### The Ability Books panel loses its labels, and tiles stop sitting an icon low

- **The heading row and the ability-name column are gone**.

### The Ability Books panel is BRead's panel now

- **BRead's columns, which are not the ones it had**.

### The Skill Books tile is centred, and the Combat Log says why it is empty

- The tile's icon, count and price are one phrase and now read as one, centred, rather than the price being pushed to the far edge of a resized tile with a gap in the middle.

### QCharm and MAna open, and the Skill Books tile is BRead's

- **Charms and Mana were tiles with nothing behind them**.

### Fixed: Combat Profit was a column of zeroes

- It read the **raw player** out of the collector.

### Fixed: the Watchlist and the target selection forgot everything on load

- Both read their saved state at module scope, which races the database: IndexedDB is opened **after** the libraries are evaluated…

### Damage attribution — DPs properly, and the combat text with it

- **`utils/damage-attribution.js`**.

### Rebuilt the combat panels against the actual source

- **Deaths is a party breakdown**.

### Panels behind DPs, IHurt, LYuck and HWhat

- **Damage**.

### Floating and Scrolling Combat Text

- **Damage numbers over the units taking them**.

### MAna and QCharm

- **Mana/fight**.

### Fixed: the Ability Book panel listed nothing at all

- It read the character out of `getInitClientData()`, which returns **static game data** — an `abilityDetailMap` describing every ability in the game and nothing about yours.

### Skill Books is BRead now, and Ability Books is gone

- One row, not two. **Skill Books** already existed and was already about books; it now also carries the cheapest next ability level and opens the panel on double-click.

### The Watchlist counts what is on the market

- Items sitting in your own **sell orders** and **unclaimed** from filled buy orders now count towards what you own.

### Ability Books — BRead

- **Every ability at once**.

### A Track button in the item menu, off by default

- Clicking an inventory item now offers **Track** / **Untrack** beside Sell, so an item goes on the Watchlist where you noticed it rather than by opening a panel and finding it again.

### Watchlist — NTally

- **A list of items you care about**.

### The MWI Combat Suite source is back in the tree while the port runs

- `third-party/mwi-combat-suite/mwi-combat-suite-0.9.36235.user.js` is restored.

### The combat level is a target you can aim at

- **The Target Selector offers Combat alongside the skills**.

### The Time to Level tile follows the Target Selector

- **Pick a skill and a level in the panel and the tile reports that**.

### The two copies of the sampling loop are now one

- The panel and the Time to Level row each had their own copy of "read every skill, keep ten minutes, work out a rate".

### Fixed: changing a dropdown appeared to do nothing

- **The refresh guard was blocking the redraws the user asked for**.

### Combat Revenue reads like MCS's

- One decimal and a plain hyphen: `95.1M - 13.2M = 82.0M/day`.

### Panels can now be tested, and testing this one found two more bugs

- **`happy-dom` is a dev dependency, opted into per file**.

### Fixed: the Combat Level panel stopped after the session bar

- `_busiest` was called and never written.

### GWhiz, part three: the bar was measuring the wrong thing

- **The progress bar was 30% when it should have been 79%**.

### GWhiz, part two: the session, targets, charms and the lookup

- **Corrected the combat level formula**.

### GWhiz, part one: combat level and what moves it

- **A Combat Level row and panel**.

### Every feature that adds marketplace tabs now finds the visible marketplace

- `visibleTabsContainer` moved into `utils/marketplace-tabs.js` beside the tab machinery it serves, and Missing Materials, the Crafting Plan…

### Fixed: the restock tabs went onto the marketplace you could not see

- **There is more than one marketplace**.

### Fixed: the restock heading duplicated, and a failed build stood until something else rebuilt the tabs

- The green **Restock: N items** heading was not marked as one of ours, so the tidy-up that removes the tabs left it behind — and every re-add stacked another heading beside the last.

### Fixed: Buy all showed the heading and no tabs

- The tab helper reads `itemName`, and the shopping list passed `name`.

### Fixed: the overlay sat above the game's own interface

- It used the floating-panel layer, which is meant for panels you open on purpose and dismiss.

### Fixed: Buy all opened the marketplace with no tabs on it

- The tabs went in immediately after navigating, and the marketplace tab bar is usually **already there** from a previous visit…

### Fixed: the Consumables panel sat on top of the marketplace it sent you to

- It is a floating panel and the marketplace opens underneath it, so pressing Buy or Buy all covered the thing you had just asked for — including the tabs.

### Buy the whole restock at once, as marketplace tabs

- The footer's total is now a **Buy all** button.

### The buy recommendation now measures the queue instead of assuming it

- The order-against-instant call used a flat six-hour guess at how long a buy order takes to fill.

### Buy the shortfall, in equipped order, with exact drink rates

- **Click the Buy figure to open the marketplace with the quantity already filled in**.

### Fixed: drinks were assumed to be drunk at maximum concentration

- Drink consumption was measured from observed use and then **capped at a hardcoded 345.6 a day** — 300 seconds at the maximum 20% drink concentration.

### The Consumables tile answers for you and for the party

- Reads `You: 1.2d   Party: --` the way MCS's does. **Two answers, because they are two different things to act on**: your own countdown is what you can do something about right now…

### The Consumables panel reads like CRack's, and items open the marketplace

- **Laid out the way MCS lays it out**.

### Double-clicking a tile closes the panel it opened

- Treasure, Houses and Consumables all toggle now.

### The dev build says which build it is

- The dev script and the published one carry the same `@name` and the same `@version`, so neither Tampermonkey nor you can tell them apart…

### A Consumables panel: what runs out, when, and what to buy

- The overlay row answers "what runs out first, and when".

### Tile text buttons moved to the bottom left

- They sat top right, which is where a tile's value sits — so hovering to resize the text covered the number you were sizing.

### The combat bundle had 19 KB left

- Adding the panel there would have left the next feature unable to build.

### Fixed: importing a layout wider than the panel folded it in half

- The layout was laid out against the width the panel **currently** was, and the panel is only resized to fit a moment later.

### Fixed: Time to Level tracked the total level

- The game keeps the total level in the same list as real skills, and it gains experience faster than any of them by definition — it is the sum of them all.

### Text size, per tile and for the panel at once

- **Every tile shows − and + when you hover it while the layout is unlocked**.

### Fixed: Ctrl+scroll zoomed the whole page

- Ctrl+wheel is the browser's own page-zoom gesture, and a page that zooms when you meant to resize one tile is worse than no shortcut at all.

### The settings popover moved out of the panel, and Autogrid can be undone

- **Settings open above the panel, not inside it**.

### Fixed: the panel was see-through

- At 90% opacity the game's inventory grid read straight through the tiles, and a figure you have to pick out of a background is not a glance.

### Fixed: an imported layout arrived as a scatter with holes in it

- Growing imported tiles to fit made them collide, and pushing the collisions down left the gaps the old smaller tiles used to sit in…

### Separators, and an import that arrives usable

- **Separators**.

### Build Score, and rows that fit their tiles

- **Build Score**.

### Fixed: Total Profit read NaN

- Session income had the two cost figures subtracted from it, but both are `{ask, bid}` objects rather than numbers, so the arithmetic produced NaN…

### Fixed: numbers above a trillion printed as thousands of billions

- `formatKMB` stopped at B, so a net worth of 985 trillion rendered `985663.62B`.

### Twelve more overlay rows

- **Session Timer / EPH**.

### The overlay is a layout, not a list

- **Rows are placed freely rather than stacked**.

### Panels remember their size and position, and can be resized

- Every floating panel opened at a hardcoded corner at a hardcoded width and forgot anything you did to it…

### Import asks Add, Replace or Cancel, in three buttons

- It was an OK/Cancel box with a paragraph explaining that OK meant add and Cancel meant replace — a sentence you have to read twice and can still read wrong…

### Treasure: choose what untradables are worth, and move your history in and out

- **Capes, quivers and cloaks can be valued three ways**.

### The Treasure panel lists every chest, and its columns line up

- **Every chest in the game is listed, not only the ones you have opened**.

### Double-click an overlay row to open the panel behind it

- A row is a summary; the detail it provokes a question about now lives one gesture away.

### The Treasure ledger reads across three columns

- Expanding a chest now shows **LAST**, **TOTAL** and **EXPECTED** side by side, one row per item, in a shared order…

### A Houses panel

- The overlay row says how many upgrades you can afford and the cheapest one.

### Fixed: the Houses row counted only rooms you had already bought

- `characterHouseRoomMap` holds the rooms you own, not every room in the game.

### Fixed: the treasure popup ignored the loot dialog and stayed in the corner

- The dialog is rendered by React from the same message that tells us about the loot, so it is reliably not on screen yet when we look for it.

### The treasure popup now sits beside the game's loot dialog

- It was pinned to the top-right corner while the game's Opened Loot dialog opens near the middle, so reading the two together meant looking back and forth across the whole window.

### Toolasha.Debug.houses()

- The Houses row draws nothing when it cannot price a single upgrade, and nothing is indistinguishable from the feature being off.

### Drop luck updates during a run, not only after it

- It was computed once, on leaving combat, because that is when the battle panel it writes into appears.

### Fixed: bundles were carrying private copies of shared utilities

- The released script is six bundles, and any `src/utils` module not declared shared in `rollup.config.js` is **copied into every bundle that imports it**.

### Five more overlay rows, from calculators Toolasha already had

- **Revenue**.

### Treasure pops up what an opening actually paid

- The game's dialog answers "what did I get" and leaves the only interesting question — was that good — to a feeling.

### Settings moved out of the wrong section

- **Overlay Panel**.

### The reference script is no longer carried in the repository

- Frotty's MWI Combat Suite was vendored while the ports were written.

## Unreleased — branch `claude/new-session-s8abcv`

### Fixed: the overlay would have shown nothing in the released build

Caught by CI, not by testing — the dev build is a single bundle where the mistake cannot happen.

- The released script is six bundles loaded in order (core, utils, market, actions, combat, ui), and a module not declared shared is **copied into every bundle that imports it, each copy with its own state**. The overlay's row list sat in the UI bundle, so combat features registered into one list, inventory features into a second, and the panel drew from a third — an empty one. Ui also loads last, so a combat feature registering at start-up was reaching for a bundle that did not exist yet.
- The list moved to `src/utils/overlay-rows.js` and is declared shared in `rollup.config.js`. Utils loads before every feature bundle, so there is now exactly one list and it exists before anyone registers into it. Verified against the built files: all three bundles reference the shared registry and none carries a private copy.
- **`dist/libraries/toolasha-combat.js` went over the 2 MB limit**, which is what made CI fail. Removing the duplicated overlay code brought it back under — but only by 8 KB. The next feature added to the combat bundle will break it again, and splitting that bundle is the real fix.

### Overlay Panel: one floating panel features add a row to

New setting, on by default, with an **Overlay** button on the settings page. The gear inside chooses which rows show and in what order; the panel remembers where you dragged it and whether it was open, so it comes back after a refresh.

- The shell knows nothing about what it shows. A feature calls `registerRow` with a key, a name and a function that draws into a container; the shell owns position, visibility, order and redrawing. Adding the twentieth row is then the same work as the second, which is the only way a panel of this shape stays maintainable.
- **Two rows to start**, both from features that already had the data: **Drop Luck** (the last combat session's percentile, which otherwise vanishes with the battle panel) and **Treasure** (the running chest total). More arrive as features gain them.
- Rows are redrawn on a timer rather than each feature pushing updates. Most rows show rates and counters that move on their own, so a push model would need nearly every row to own a timer — and a row that forgot would show a stale number with no sign anything was wrong.
- **A row that throws does not take the panel with it.** It renders as "unavailable" and everything around it keeps working, which matters when a game update breaks one row out of twenty.
- Two cases that would otherwise bite on every update are handled: a row added by a new version appears at the end rather than being silently dropped, and a saved key for a row that no longer exists leaves no hole in the order.
- A panel dragged off-screen and then reopened in a smaller window is pulled back to where you can grab it, rather than being stranded past the edge and looking broken.

### Treasure: a ledger of what your chests actually paid out

New setting, on by default, and a **Treasure** button on the settings page that opens a draggable panel.

- Toolasha already prices a chest before you open it, in tooltips and in net worth. That is a claim about the long run. This is the record of whether the long run has turned up: how many of each chest you have opened, what came out, and what the drop tables say they owed you — as a running total and per chest, worst first.
- **Expand a chest to see which item is responsible.** A chest sitting 30% down is usually one rare that has not come up rather than something wrong across the board, and the totals alone cannot tell those apart. Items that never dropped are listed too — the missing row is the whole story on an unlucky chest.
- Chests are ordered by how far from expectation they sit, not alphabetically. The reason to open the panel is to find out which one let you down.
- **Tracking runs whether or not the panel is open.** A ledger you have to remember to start is empty when you finally want to read it.
- Items with no market price sit out of both sides of the comparison, so a chest full of unsellable junk is not counted as a shortfall.
- A chest a percent or two off expectation is left uncoloured. Every chest is slightly off; colouring that would make the panel a wall of red and green saying nothing.

**Fixed on the way through: chest openings were being silently dropped.** `loot_opened` went through the WebSocket layer's content-hash dedup, which compares the first 100 characters — and opening the same chest twice in a row produces two messages identical that far in. The second was discarded before any handler saw it. Nothing used the message until now, so nothing noticed. It now takes the same short-TTL path `action_completed` uses, which still collapses genuine duplicates from the double-listener case.

### Drop luck now shows in the battle panel

New setting, on by default. Coming back from combat, a line appears beside Total revenue: **`Drop luck: 73rd percentile — 27 runs in 100 beat it`**, green when the session went well, red when it did not.

- Revenue on its own cannot answer "was that bad, or was that just Tuesday?". A zone's average says nothing about its spread, and the zones worth grinding are the ones where a rare drop carries most of the value — where the typical session is well under average and one lucky hour is worth a day. This says where the session actually sits.
- The tooltip carries the caveats so the line stays one glance wide: how many battles it covers, that unpriced drops are excluded, and — when the game did not hand over your drop stats — that the figure assumes none.
- **Dungeons are skipped rather than guessed at.** They pay from a reward table on completion instead of per monster, which is a different distribution; a number built from the wrong model would look exactly as convincing as a right one.
- Priced through your existing pricing-mode setting, and the session's takings are counted with the same prices as the distribution they are compared against — otherwise the figure would measure the bid/ask spread and call it luck.
- Drops with no market price are left out of both sides. Counting them as free would make every session containing one look unlucky.
- The transform takes about a tenth of a second on a busy zone, so it runs after the panel has drawn rather than before — the line says "working it out…" for a moment instead of freezing the panel.

**One assumption is worth knowing about**, because it is invisible when wrong: drop quantity bonuses produce fractional counts, and this takes the game to settle a count of 1.1 as one item nine times in ten and two the tenth, rather than throwing the fraction away. On a zone where a rare carries the value the two readings differ by about 5% of total income — the rare being exactly the drop whose count is small enough for the fraction to be most of the bonus. If your luck reads consistently low, this is the first thing to suspect.

- Checked end to end against a simulation of a realistic zone — two monsters on a strength cap, a boss every tenth battle, a rare worth a quarter million, drop-rate and quantity bonuses applied — matching at every quantile from the 2nd to the 98th to within 0.002.

### Drop luck and expected spawns, ported from MWI Combat Suite

Two analysis engines from Frotty's script, as pure utilities with tests. **Nothing calls them yet** — no setting, no panel, no change to how Toolasha behaves. Wiring them to something you can see is a separate decision.

- **Drop luck** (`src/utils/drop-luck.js`, `src/utils/complex-fft.js`) — where a session's takings sit in the distribution of takings it could have had. Toolasha already computes what a zone pays on average, but an average cannot say whether a run that came in 30% under is routine or remarkable: a zone whose income is mostly a common drop and a zone whose income is mostly one rare drop have the same mean and nothing else in common. This gives the percentile instead.
    - Income is a sum over every drop of every monster in every wave, and sums of distributions are convolutions — quadratic, and worse with every drop added. Each drop instead contributes one characteristic function, they multiply, and a single inverse FFT at the end turns the product back into a distribution. A thousand waves costs the same as one, because repetition is a power rather than a repeated convolution.
    - The transform needs a window and the answer's size is not known in advance, so it searches for one: a cheap 64-sample inversion reports where the mass actually ends, the window shrinks to fit, and the accurate inversion runs once at the end. Starting from a window five thousand times too wide, it settles within 0.3% of the true range.
    - Checked against an exact binomial across its whole range (worst error 1.4e-4), and against a Monte Carlo of the full process — multiple monsters, a strength cap, count ranges, a rare drop worth two million, and boss waves — matching to 0.0013 at every quantile from the 1st to the 99th.
- **Expected spawns** (`src/utils/spawn-expectation.js`) — how many of each monster a wave is expected to contain, which is what turns a drop rate into an expectation. A wave is not a fixed roster: the game draws monsters until the next one would break the strength budget, so a heavy monster is rarer than its weight suggests and a light one commoner. Solved exactly by walking every state rather than sampled; checked against Toolasha's own combat-sim sampler, which it matches to Monte Carlo noise.
- **Both fix the same bug in the original**, which read spawn `rate` as a probability. The game treats it as a weight and divides by the table's total when it draws — which the two agree on only when a table happens to sum to 1.

### Chest expected value was already here, and better — not ported

- The third piece of the plan turned out to be a duplicate. `src/features/market/expected-value-calculator.js` already runs the same four-round fixed point for chests that contain chests, but spread across a worker pool, with coins, cowbells and dungeon tokens handled as special cases. `src/utils/token-valuation.js` already picks the best value per token, reading the shop out of the game's own data rather than the hardcoded table the other version carries — one that goes stale the next time the shop changes.
- Recorded in `docs/THIRD-PARTY-LICENSES.md` and the vendored README so the next reader does not re-derive it.

### MWI Combat Suite is vendored as source material, with attribution

- Frotty's **MWI Combat Suite v0.9.36235** now sits verbatim in `third-party/mwi-combat-suite/`, under the MIT licence it declares. Nothing there is imported, bundled, linted or executed — the build reads `src/`, so the copy is inert and no behaviour changes.
- It is committed rather than read once and discarded because MIT attribution has to name something identifiable. "Adapted from a version of Frotty's script" is not attribution if nobody can say which version; the exact 42,155 lines make every later claim checkable against the original, and diffable against a future release.
- `docs/THIRD-PARTY-LICENSES.md` records it, and marks the difference from the Scaley Way Idle entry already there. Same author, but that script carries no licence and could only lend an idea; this one is MIT, so the code itself can be reused.
- The vendored README inventories all twenty-one tools and calls out the four pieces worth porting first — the drop-luck CDF analysis, the enhancement Markov chain, the expected-spawn DP and the chest EV fixed point. Those are pure computation and port cleanly with tests; the rest are panels.
- **Nothing has been ported yet.** Which of the twenty-one Toolasha should grow is a call worth making one feature at a time.

### Fixed: the alchemy pins never appeared

The picker could not be recognised at all, which also means the existing item dimming has been silently doing nothing — it shared the logic. Three things were wrong:

- **There is no "Alchemize Item" label.** The recognition looked for one. The alchemized-item slot is unlabelled; only the catalyst names itself, as "Consumed Item".
- **The menu's own "Remove" tile carries the label class.** So walking up from the menu for the nearest label found the menu's own contents and concluded the selector was called "Remove" — which then excluded it. This is why even the fallback failed.
- **The menu is portalled**, rendered outside the selector that owns it, so it cannot be identified by what it sits inside either.

It now watches **which selector was clicked**. A menu opens because something was clicked, and the thing clicked stays where it belongs in the DOM whatever the menu does afterwards. The structural check is kept for the case where the menu is not portalled, and the catalyst is excluded by its own label.

- **Only one tile was ever being found**, so a matched menu still only got one pin. Two versions assumed the tiles were siblings — first taking the parent of the first tile as the grid, then the parent holding the most — and both came back with exactly one, because **each tile is wrapped in a container of its own** and no two share a parent. The grid is now the deepest element containing every tile, and each tile is represented by whichever of its ancestors that grid can actually move.
- The **Remove** cell keeps the front of the grid rather than being swept along with the unpinned items, so pinning something does not push the way to clear the selection down behind it.
- **Pins would have vanished on the first keystroke in the filter box.** Typing replaces the tiles inside the menu without replacing the menu, so a watcher that only sees the menu appear decorates it once and never again. The menu's contents are watched now, with the decoration made idempotent so it cannot react to its own writes.
- `Toolasha.Debug.alchemyMenu()` now also dumps each menu's ancestry, its owning label, its tile count and which selector was last clicked — enough to correct a wrong answer rather than guess at it.

### Pin items in the alchemy picker

- New setting, on by default: a **📌** on each item in the Alchemize Item list moves it to the front. The picker lists everything you own in whatever order the game keeps it, and the handful of items anyone actually feeds it are scattered through that — the alternative is typing the same filter every time.
- **Kept per action.** Coinify, Decompose, Transmute and Unrefine each have their own list, because the same item means different things in each and one shared list would be the union of four unrelated shortlists.
- **Pins reorder, they do not exempt.** A pinned item that does not match what you typed in the filter box stays hidden — the filter has to keep meaning what it says, or it stops being usable for finding anything else.
- New pins go to the **end** of the list rather than the front, so adding one does not shuffle the one you reach for most.
- Catalysts are untouched: that selector is a separate menu and pinning it was not asked for.
- Finding the right menu is now shared with the item dimming feature rather than duplicated. The page carries several identical-looking item selectors — the catalyst and guild have their own — and the logic for telling them apart, including the portalled case and labels left mounted in hidden tabs, is fiddly enough to want exactly one copy of.
- While there: the dimming feature matched items by exact CSS-module class names like `Item_item__2De2O`. The game regenerates those suffixes on every build, so it would have stopped working at the next patch and looked merely broken. It matches on the class prefix now.

### The labyrinth room header says "Attempt #2" rather than "try 2"

- Matches how the room log and the tile badges already word it, and reads as a count rather than an instruction.

### EXP / Hour pays for the walk to a room, once, on every room type

- Combat rooms charged nothing for travel while skilling and enhancing rooms did, so the two figures sat in the same panel measuring different things. Both now go through one shared calculation and can be read side by side.
- The travel second is charged **once per room**, not once per attempt: back-to-back retries happen where you are already standing, so failing a room five times still only involves walking to it once. It was previously amortised over the attempts a clear takes, which charged a room cleared one time in twenty for twenty walks it never made.
- Net effect: combat figures drop by a hair, and hard skilling rooms go **up** — a room cleared one time in twenty was being charged twenty seconds of imaginary walking and is now charged one.

### Combat experience corrected, and the skip list's combat rows get the full card

- **A labyrinth room pays on completion, not per swing.** The combat tile's experience figures were totalled from what the simulated fights earned by landing hits, which credited losing attempts for damage they dealt and paid out for rooms that were never cleared. They are now the room's own level-based award, the same one a skilling room gives, granted on a clear.
- **EXP / Hour on a combat tile is therefore what clearing pays, amortised over the attempts you lose getting there** — it uses the expected time to a clear, so a room you never clear reads 0 however long you fight it, which is what an unreachable room is actually worth. The figures were also missing entirely before this, because the simulation's experience totals were empty for labyrinth runs.
- **Rooms you gave up on now count their time** toward measured experience per hour. Since a room pays only when completed, an abandoned one is time spent for nothing, and leaving it out raised the measured rate every time you walked away from a room — precisely backwards. Its duration is kept apart from the completed rooms' so it cannot distort what a room takes to finish, which is a different question.
- **Combat rows in the labyrinth skip settings now show the same full preview card the skilling rows do** — clear chance with its margin, fights simulated, combat style, damage type, accuracy, evasion, the monster's abilities at room-scaled levels, and the expected token and box drops. They used to fall back to a three-line tooltip, which was the wrong way round: a fight is the row where the detail is hardest to get at any other way, since its numbers come out of a simulation rather than off the screen.

### Fixed: rooms you completed showed no experience for the floor

- Every floor read `xp not measured`. A room's experience was measured by sampling your skill totals when the room opened and again when it closed — but a room closes the instant the floor says the path moved on, and the experience it earned arrives in its own message that need not have landed by then. The room was being closed before it had been paid.
- Experience is now **watched for as it lands** and credited to whichever room is open, against a rolling baseline rather than a snapshot per room. Experience arriving while no room is open still advances the baseline, so it cannot be mistaken for the next room's.
- A finished room stays **claimable for a few seconds** before going into the long-term record, so experience credited a moment after the room ends still counts toward it.
- New diagnostic: `Toolasha.Debug.watchLabXp()` watches your skill totals across every message type that could plausibly carry experience and prints which one actually moved them, so if the labyrinth credits experience some other way it says so rather than silently reporting nothing. `Toolasha.Debug.stopLabXp()` prints early.

### Combat rooms get experience figures, and the logs moved somewhere you can reach

- **Expected EXP / Room and EXP / Hour on the combat tile hover.** Taken from the simulation itself rather than a formula: a skilling room's experience is a closed-form function of its level, but a fight earns it by landing hits, so a room you usually lose still pays and one you lose at the two-minute mark pays more than one you lose in twenty seconds. Only the replayed fights know that, and they have already been run.
- Both figures are **per entry, not per clear**. Quoting only what a win is worth would make a room you clear 5% of the time look like it returns nothing at all.
- **Measured experience per hour on combat room cards** in the log, alongside the skilling ones — the hover tooltip sets the sim's expected rate beside what you actually gained.
- **The Logs button is now a ⧉ Room Logs tab beside Lab Sim**, matching the Bulk Sell tab: cloned from the game's own tabs, dimmed while the panel is closed. It used to sit on the calculate bar inside a run, which put the history of your last three floors behind having to be standing in a fourth — and reviewing a run is something you do after it.

### Skilling rooms get the same results check, and the log now shows what a floor is worth

- **Skilling and enhancing rooms join the accuracy record.** A skilling room is failed by running out of the two minutes rather than by dying, but it is still a room the calculator gave a chance of clearing and still a room you either cleared or did not — so the same entry counting answers the same question. They can be judged from the first room you walk into, too, because a skilling forecast is closed-form maths rather than a simulation that has to be run first.
- **Three numbers per action, not two.** The server states the success and double chance it is using with every action, so a skilling room can be checked twice over: **the calculator against the server's stated rate**, which needs no sample at all and is flagged `formula off` when they disagree by more than half a point, and **the stated rate against what the actions actually did**, which needs one. A formula that contradicts the server is a bug no amount of play will fix or reveal.
- **Expected time against actual.** Each finished room's duration is recorded against the calculator's estimate, per room on the card and averaged in the accuracy tab (`74s vs 61s est`).
- **Experience per hour, measured not derived.** Taken from the change in your skill totals across a room rather than from a formula — the formula is the thing being checked, and combat rooms have no formula here at all. Shown per room, and per floor.
- **The room list is grouped by floor**, each with a header: rooms, how many cleared, time spent, and experience per hour across the floor. A floor is the unit a run is actually planned in, and throughput over one room says far less than throughput over the thirty you have to get through. Rate is measured over the rooms, not the floor's wall-clock — the time between rooms is spent reading the map, and charging that to the rooms would make a floor you thought about look slower than the same floor rushed.
- **History length is now a setting**, default **120** rooms, up from a fixed 30. A floor is around thirty rooms, so the old cap showed barely one floor and nothing to compare it against; 120 keeps roughly three. The long-term accuracy record is separate and has never been trimmed.
- `Toolasha.Debug.labAccuracy()` gains columns for the calculator/server/observed rates, the timing comparison and experience per hour.

### Fixed: the sim accuracy record counted every defeat and no victory

- Every room read `0/N`. **Clearing a room strips it** — the server stops sending its monster, its skill and its type, leaving a cell that says only `isCleared` — and the scan that fed the record looked for rooms naming a monster. So it saw the room on every attempt you lost and never once on the attempt you won. Attempts piled up, clears never did, and the verdict could only ever be "sim too high".
- The scan now reads every room on the floor, and the fold credits a cleared square to the monster **last seen standing on it**. That memory is scoped to a run and floor, because coordinates repeat on every floor — without the scope, descending onto a floor whose corner room was already cleared would hand a free win to whatever was in the same corner one floor up.
- **A win can no longer outrun its own attempt.** A room cleared first try can go from unseen straight to cleared with no update in between showing it entered, which would have recorded 1 clear in 0 attempts — a rate above 100%.
- **Per-room state is now saved.** It was held in memory only, so every refresh made the record forget where each room stood and re-count its entire entry history from scratch — inflating attempts a little more every session.
- **Records written before this fix are discarded on load.** They are not a small sample of the truth; they are every loss and no win, so carrying them forward would poison every verdict from here on. The count starts again from your next fight.
- The room log itself was reading the same flag with the same blind spot and only got the right answer by falling back to the monster's health on the last tick. It now asks the floor properly.
- New console diagnostic: `Toolasha.Debug.labRooms()` prints the current floor exactly as the server describes it, including which fields each room still carries, so what a cleared room looks like can be read rather than inferred.

### Resize the battle panel, from settings, per character

- New setting, off by default: scale **your side** and the **enemy side** of the battle panel independently, choose how the two sit, and set the height of the character panel beside them. A ten-monster wave and a solo fight get the same slab of screen, so one is cramped and the other mostly empty — and the right answer differs per character, which is why every one of these is stored **per character** like the rest of Toolasha's settings.
- Lives in **UI & Appearance** in the settings page rather than a floating panel, and every number applies **as you change it**. Finding the right scale means nudging a number and looking at the result, so a reload between nudges would make it unusable.
- **How to resize** is configurable: `zoom` (the default) changes the layout size, so a side you shrink actually gives its space back; `transform` only redraws smaller and leaves the original box behind, with an anchor corner you can pick. The transform path reclaims the leftover space with a matching negative margin rather than needing a spacer element.
- **Layout** is opt-in — leave the game's own, or force side-by-side or stacked. Forcing one overrides how the game arranges the panel at your window width, so it is not the default.
- **Character panel height** takes a percentage of the window, with 0 meaning "leave the height the game picks". Taller shows more inventory at once; shorter gives the fight room.
- Idea and target selection from **Scaley Way Idle** by Frotty, credited in `docs/THIRD-PARTY-LICENSES.md`. That script carries no licence, so nothing was copied — this is written against Toolasha's own settings and style helpers. It also differs where the original had problems: one stylesheet instead of a `MutationObserver` sweep re-setting inline styles on every combat tick, and class-prefix selectors instead of pinned CSS-module hashes like `BattlePanel_playersArea__vvwlB`, which the game regenerates on every build — a script written that way stops working silently at the next patch. Not reproduced: dragging the two areas to fixed pixel positions, which does not survive a window resize.

### Combat rooms are in the room log, next to the clear chance the sim promised

- The Logs panel recorded skilling and enhancing rooms and ignored fights entirely — which left the one room type where the script makes a falsifiable prediction as the only one with no record of whether it came true. Combat rooms are now logged the same way, one entry per **attempt** rather than per swing.
- Each fight card reads `Sim 24% | Won 0/3 (0%) | 2 died, 1 timed out`. Deaths and timeouts are counted separately because they fail the same room for opposite reasons, and the fix for one makes the other worse: dying says you cannot survive the fight, timing out says you cannot finish it.
- Every attempt shows a number. A win shows **how long it took**; a loss shows **the health the monster had left**, because "lost with it on 4%" and "lost with it on 71%" are different problems — the first is worth another attempt, the second a different loadout.
- The outcome is taken from the floor, not from the last tick. `battle_updated` stops dead when a fight ends and the killing blow's update usually never arrives, so a won fight's final tick still shows the monster alive; the room's own cleared flag is the only reliable witness. A fight interrupted by a refresh is filed as unknown and left out of the counts rather than assumed lost.

### A Sim accuracy tab, for whether the clear chances are true over the long run

- Second tab on the Logs panel, totalling **every labyrinth fight ever recorded** against the rate the sim predicted for it — per monster and room level, most-fought first. Thirty rooms of history cannot settle this; a room that says 24% and loses three times running has said nothing, and the same room losing twenty-one times running has said plenty.
- Each row gives the sim's rate, the rate you actually cleared at, the range those fights support, and a verdict: **consistent**, **sim too high**, or **sim too low**. Rows the record genuinely contradicts also show how often the sim's own rate would produce a record that lopsided — a `p=0.4%` is the sim being told it is wrong.
- A summary at the top: how many fights, and how many clears the sim owed you against how many you got. Rooms that were never simmed are counted in the totals but left out of the expectation, so the sim is not credited with predicting nothing for fights it made no claim about.
- The prediction is now **stamped on each room as the fights land**, instead of being looked up when the record is read. Sim results live in a cache keyed by loadout and crates and do not survive a refresh, so a record read a week later used to say "not simmed" for almost everything — the one thing it exists to avoid. Comparing a fight to the number that was on screen when you walked in is also the honest comparison: that is the claim the sim actually made.
- `Reset` on that tab throws the record away, and asks twice, since it is the only copy of every fight you have had. `await Toolasha.Debug.labAccuracy()` still prints the same data as a console table.

### Fixed: the labyrinth fight record read as empty until you entered the labyrinth

- `Toolasha.Debug.labAccuracy()` reported "0 fights recorded" on a fresh session even with a full record stored. Loading only happened on the way _in_ — when a labyrinth message arrived to be folded — so anything that merely **read** the record saw nothing until then. The console table and a tile's "Actually Cleared" row both read it.
- It is now loaded on demand by whatever asks for it. Call it as `await Toolasha.Debug.labAccuracy()`, since it may have to fetch first.

### Price history panel, ingested from mooket II

- New setting, off by default: a floating chart of an item's ask, bid, traded price and volume over the last day to six months, following whatever the marketplace is showing. The game shows what an item costs now and nothing about what it cost before, which makes every price impossible to judge — 840,000 is cheap or dear only against what it has been.
- Pin items to a row of chips with the 📌 beside the item icon: price, percentage move since you pinned it, reorderable, right-click to unpin. One button cycles how much of each chip to show, because the right amount depends on how many are pinned.
- The volume line is split on hover into an estimate of how much was **bought at the ask** versus **sold into the bid**. The server reports how much traded and at what average price, never who crossed, so where in the spread that average landed is the evidence — it is an estimate and says so.
- Ranges past a week are grouped into one point per day using the **median**, not the mean. A single absurd listing — a 300-coin item at 40 million to see if anyone bites — moves a mean for the whole day and a median not at all.
- Adapted from **mooket II** by Q7, used under the MIT licence; see `docs/THIRD-PARTY-LICENSES.md`. Left behind deliberately: the second WebSocket hook (Toolasha has one, and two scripts patching `MessageEvent.data` is how a page silently drops messages), the bundled item-name dictionaries (the game's own are already loaded), the localStorage cache with its defensive pruning (this uses IndexedDB), and the crosshair plugin (the index-mode tooltip covers it without another dependency).
- Shown and hidden by a **⧉ History** tab at the end of the marketplace tab bar, and closed with the ✕ on the panel itself. It starts hidden — a panel that appears over the marketplace the moment you open it is in the way of the thing you opened.

### Panel tabs look like panel tabs

- **⧉ Bulk Sell** and **⧉ History** now carry a ⧉ and sit dimmed until their panel is up. Both borrow the game's own tab styling, so they read as two more places to navigate to — and a tab that does not change the page when clicked, then does nothing visible when clicked again, looks broken. The glyph says it opens a panel; the dimming says whether that panel is currently open.
- Reading and contributing are **one switch**, not two. A version that let you read without giving anything back would work perfectly and quietly drain a shared resource: the history is only as good as what people send, and a reader who contributes nothing is someone else's missing data point. The setting says plainly what each direction does.

### Bulk Sell panel is draggable, and closing it stops the run

- Drag the panel anywhere by its background; the position is remembered. It defaults to the top-right, which is where the game puts its own gold counter and controls, so on a narrow window it landed on top of them. It is clamped to the viewport — a panel dragged off the edge could not be dragged back.
- Dragging starts only on the panel's own background, so the tab select and the buttons still work.
- The ✕ now **stops** a run as well as closing the panel. The panel is the only thing showing what is being sold and how far through it is, so leaving a run going behind a closed panel would mean the next confirm click landing on a sale you could no longer see coming. Hiding it from the Bulk Sell tab still leaves it running — that gesture keeps the progress one click away.

### Bulk Sell panel can be closed from the panel

- An ✕ on the floating panel hides it. The panel is fixed over the game and follows you out of the marketplace, so dismissing it used to mean navigating back to a tab you had left.
- Hiding never stops a run — reopen from the Bulk Sell tab and the progress is still there.
- The stop button now reads **Stop** instead of ✕. Two identical glyphs a few pixels apart, one abandoning a run and one only hiding the panel, is a mis-click waiting to happen.
- The Bulk Sell tab's hover text now explains what the feature actually does — that it queues your tradable inventory, prefills each sell modal, and never confirms a sale itself — and recommends pointing it at a Toolasha inventory tab, so nothing outside that tab can be sold by a mis-click.

### The net worth chart button closes the chart

- Clicking 📈 again dismisses the chart instead of rebuilding it. The control is a switch, and any other reading left no way to close the chart from where you opened it.
- The click-outside-to-close handler now ignores that button. It fired on mousedown and the button's own click reopened the chart a moment later, so a toggle alone would have looked like nothing happening.

### Sidebar Marketplace badge can be limited to finished listings

- New setting, off by default. The game badges **Marketplace** in the left sidebar the moment anything is collectable, including a buy order that has taken 30 of 200 units and is still working — collecting those 30 does nothing except silence the badge until the next fill, which teaches you to ignore the badge.
- With it on, the sidebar badge appears only for listings that have finished: filled completely, or cancelled and holding a refund. Both are things you can actually close out.
- The badge on the **My Listings** tab is left alone. Once you are in the marketplace, knowing there is something to collect is useful; it is only the sidebar nag that isn't.
- Done with a stylesheet toggled by listing data, not by clearing the badge's text — React rewrites that node on every update, so anything written into it would be gone within the second.

### My Listings can carry other scripts' markers too

- The same marker column Market History has, on the live My Listings table. No setting guards it: nothing appears unless a script has registered a marker, so a switch would only ever be turned on by someone who had already installed the thing that draws it.
- Markers are now told which surface a row is on — `history` or `myListings` — because the two mean different things. A finished trade can be adopted with a real cost basis; a working order cannot, but it is exactly the one worth marking ahead of time so its fills are counted as they arrive.
- The column is appended past the last column rather than inserted among them: the Top Order Price cells are placed by index arithmetic, and a column inserted into the middle of that would silently misalign them.
- A marker registered after the table was built now redraws it, instead of appearing only the next time the table happened to rebuild.

### Market History items open in the marketplace when clicked

- Clicking an item in the Market History table closes the viewer and opens that item's marketplace page, at the row's own enhancement level. The row already names both, so retyping them into the search box was only ever busywork.

### Attempt badge moved off the ETA

- The `↻N` badge sits at the middle of the tile's left edge rather than the bottom-left corner, where it overlapped the clear-chance and ETA badge.

### Fixed: the attempt count vanished once you queued more than one room

- The battle counter read the **last** entry of the labyrinth's path data as the room you are in. That data is the queue, not the trail behind you — `[0]` is the room being run and the rest are what you lined up after it. With one room queued the two coincide, which is why it worked at first; queue a second and the counter looked up the far end of the queue instead, found an unrevealed room, and gave up before reading the count. The live clear chance and the `try N` readout keyed off the same wrong end.
- **The tile badge is just the number now**, without the `↻` in front of it, which was crowding the tile.

### Skip thresholds below the recommendation now read differently

- A threshold set **under** the recommendation used to be green, the same as sitting exactly on it — which hid the one case that costs you rooms rather than risking them. It is now blue, with the tooltip saying how far under and what that means: safe, but skipping fights that would have cleared.
- Green now means what it looks like: on the recommendation. Amber and red still grade being above it, where the mistake is fighting rooms below your target clear rate rather than passing on rooms you could take.
- The tooltip states the current setting alongside the recommendation, so the gap does not have to be worked out from two numbers in different places.

### Market History rows can carry other scripts' markers

- Another script can add a column of toggles to the Market History table:

    ```js
    Toolasha.Market.listingMarkers.register('my-script', {
        stateFor: (listing) => ({ glyph: '★', active: isFlip(listing), title: 'Count this as a flip' }),
        onToggle: (listing) => toggleFlip(listing),
    });
    ```

- Toolasha never learns what a mark means. It supplies a cell, a glyph and a click; the meaning stays with whoever registered it — which is what lets a marker defined in a private script appear in a public one without its reasons coming too.
- A malformed marker is refused at registration rather than throwing once per row, and one that fails while rendering loses only its own cell. The table is your trading record and is worth more than any annotation on it.
- **With no marker registered the table is exactly as it was** — no column, no empty cells, no shifted layout. The header and the rows are both built from the registered set, so an unused hook costs nothing.
- An open table redraws when a marker is registered. The scripts that register them load after this one does, so a marker arriving late is the ordinary case, not the exception.

### Bulk Sell can be told to hold items back

- Another script can now claim inventory the sell queue must skip:

    ```js
    const release = Toolasha.Market.bulkSellAssistant.addHoldProvider('my-script', () => [
        '/items/cheese',
        '/items/cheese_sword+3',
    ]);
    ```

- The assistant never learns **why** anything is held — a flip waiting to be relisted, a crafting reserve, something promised to a guildmate. It takes keys and gives them back, so nothing about the reason has to live in Toolasha, and a caller with a reason of its own does not have to either.
- Keys follow the convention the custom inventory tabs already use: bare hrid for an unenhanced item, `hrid+level` once enhanced, so a `+3` sword can be held while the plain one still sells.
- **Held items are counted, not silently dropped.** The panel says `3 items held back`, because an item vanishing from the sell queue with no explanation is indistinguishable from a bug.
- A provider that throws loses its own claim and nothing else. Failing to hold something back is bad; being unable to sell at all because someone else's list is broken is worse.

### Simulated clear rates are now checked against what actually happens

- Every labyrinth fight is recorded: the server counts entries per room and marks a room cleared, so a room beaten on the fifth try is one clear in five attempts, and a room walked away from is none in however many it took. Totals accumulate per monster and level, and persist.
- **A combat tile's hover now shows `Actually Cleared 0/21 (0%) — sim too high`** whenever the record contradicts the prediction. A simulation can converge on a precise wrong answer and no number of extra trials will say so; only the game can.
- **`Toolasha.Debug.labAccuracy()`** prints the whole comparison — predicted rate, observed clears, the observed range, and how often the sim's own rate would produce a record that lopsided. A likelihood of 0.28% means the sim is being contradicted, not that you were unlucky.
- Rooms given up on still count their attempts. Counting only the rooms you finished would quietly discard the losing half of the sample and make every rate look better than it is.

### Fixed: guild leaderboard XP/h columns were blank

- The guild leaderboard refreshes on its own 20-minute cycle, so opening the panel again inside that window hands back the **same snapshot**. Every one of those was being recorded, which left two identical readings at the end of each guild's history — and a rate measured across two identical readings is zero, so the column rendered blank. Clicking around the leaderboard actively made it worse. The own guild kept working because its history is fed by `guild_updated`, whose experience really does move.
- A reading that only repeats the one before it is now dropped. A flat reading is still kept once the refresh window has passed, where it means the guild genuinely earned nothing rather than that nothing new was asked for.
- **Existing histories are healed on load**, so the columns fill in without waiting for fresh samples to age out the bad ones.

### Fixed: the action bar stayed narrow in the labyrinth

- Deciding the bar's width rode on looking the running action up by the name in the header — and a labyrinth room's header reads `Labyrinth - Mimic Lv.252`, which is not the name of any action, so the lookup found nothing and the width was never applied. The bar then showed whatever width the previous action had left behind, which is why it seemed to come and go. Width is now decided from the action queue's own type rather than from the header text, so it no longer depends on a name match at all. The earlier fix — keeping script annotations out of that name — was needed too, but was not the whole story.

### Diagnostic for guild XP tracking

- **`Toolasha.Debug.guildXp()`** prints how many XP samples are held per guild and how far apart they are. An XP/h column needs two readings, the guild leaderboard refreshes only every 20 minutes, and samples are only taken while the panel is open — so a blank column can mean "not enough readings yet" or "the readings never arrived", and those need telling apart before anything is changed.

### The live combat clear chance now replays the fight instead of extrapolating it

- During a labyrinth fight, the readout is computed by **replaying that exact fight 400 times** through the combat engine — both sides rewound to their current health, the room timer already part-spent — and counting how many replays end in a clear. Each replay covers only the seconds the fight has left, so the whole thing costs a fraction of a tile badge's simulation.
- This replaces racing two rates of health loss, which knew nothing about abilities, procs, healing or what a monster does at low health. The extrapolation is still there: it carries the display between replays and covers the first seconds before one has finished, and the tooltip shows both figures so they can be compared.
- **What a replay still cannot see** is anything the server does not send: buff timers, ability cooldowns, food and drink remaining. Each replay starts those fresh, which flatters a fight whose cooldowns are actually spent — an error that shrinks as the fight goes on and the remaining window gets shorter.
- A replay is tagged with the fight it came from and discarded when that fight ends, so a result landing late never describes a moment that has passed. Off via **Labyrinth: Replay the live fight for a better clear chance** if the extrapolation is preferred.

### Skip-level recommendations are now conservative where they used to guess

- Measured against a 70% bar, the decision rule shipped an hour ago called a room clearable **39% of the time when its true rate was 69%**, and still 4.5% of the time at 66% — because a boundary re-tested after every fight is crossed far more often than its nominal confidence implies. That is the dangerous direction: it recommends auto-fighting a room that does not meet your bar.
- Two changes fix it. Decisions are now tested on a **growing schedule** rather than after every fight, and the confidence required to call a room **above** the bar is stricter than the confidence to rule it out — being wrong upward sends you to fight something you should not, while being wrong downward only forgoes a room you could have taken.
- The result, measured over 5,000 simulated searches per rate: a room at 65% or below is **never** recommended, one at 68% is never recommended, and only a room within about a point of the bar is still a coin toss — where the practical difference is negligible anyway. For comparison, the old hours-budgeted version wrongly recommended 68% rooms **30% of the time** and 66% rooms 6% of the time, because the time ceiling stopped it at a few hundred fights and it then simply compared the point estimate to the bar.

### Combat skip-level recommendations decide a side instead of measuring a rate

- The Automation tab's **Recommend** button binary-searches a skip threshold per monster, and every probe only asks whether that level clears above or below your target rate. Since sims began stopping on precision, each probe was measuring the level to ±1% to answer a yes/no question. Probes now stop as soon as the interval clears the bar: one that is decisively on a side settles in about 40 fights where measuring it takes hundreds to thousands, so most of a binary search runs roughly **ten times faster** — and the probes near the bar get _more_ dependable, since they keep going until genuinely decided rather than stopping at a fixed width.
- **Decided and measured results are cached separately.** A decided one is deliberately coarse — 40 fights can leave ±12 points — so letting a tile badge read it would present that as a measurement. A measured result already in hand is still reused for a decision when its interval clears the bar.
- Skilling and enhancing skip levels are unchanged: those are closed-form, with no simulation to budget.

### Fixed: the action bar started narrow whenever a labyrinth readout was showing

- With compact width off, the action bar is widened by re-applying a CSS override each time the action display updates — but that update first parses the action's name out of the header row and matches it against the queue, and gives up when nothing matches. The row is shared: the battle counter appends `· Attempt #3` and the labyrinth readouts append `[Clear ~85%]`, and both were being folded into the parsed name, so the match failed and the width override went with it. The bar then sat at the game's narrow default for as long as an annotation happened to be showing, which is why it came and went. Name parsing now skips every script-added element in the row rather than only this feature's own.
- **Fixed: the battle counter could read the wrong action.** It took the first unfinished entry from the action list, which arrives in insertion order, so an action queued behind the running one could be picked instead — suppressing the counter on a combat zone because something queued after it was not a fight. It now sorts by ordinal, as the rest of the codebase does.

### Lab Simulator tabs stop on the question they are actually asking

- **Max Level probes now test a side of the bar, not a rate.** Each step of the binary search only has to place a level above or below your target clear rate, which is a far cheaper question than measuring that level. A level clearing 90% against a 50% bar is settled in 40 fights; measuring the 90% to a percentage point would take nearly two thousand. Most probes now finish about **ten times faster**, the ones within a few points of the bar take longer, and a level sitting exactly on it runs to a cap — where the search is indifferent to which way it falls anyway.
- **Upgrade and all-fights comparisons now play every candidate over exactly the baseline's fight count.** The advisor ranks by the difference a loadout makes and shares one seed across the baseline and every candidate so their random draws cancel out of that difference — but the cancellation only holds if the runs line up fight for fight. A time budget quietly broke that: a candidate that kills faster fits more fights into the same hours, so the two runs covered different encounters. Taking the count from the baseline keeps the sample the time budget buys while making it identical across candidates. This is a correctness fix to the ranking, not a speed change.
- **The single-room sim stops on precision**, the same rule as the tile badges, with Hours as the ceiling. Its result now reports the band and whether the ceiling cut it short: `92.30% ±0.98%`, or `(capped)` when it did.
- Skilling is unaffected — it is closed-form maths, with no simulation to budget.

### Fixed: the labyrinth attempt count followed you out of the labyrinth

- Finishing a labyrinth room and starting something else left `Attempt #N` sitting beside the new action — an alchemy craft wearing the number from the fight before it. React swaps the header's text in place rather than replacing the element, so the observer watching for a new header never fired on an action switch and the counter was simply never re-evaluated. It now re-checks on every action change, and a battle number is suppressed outright while a non-combat action is running.

### Labyrinth sims stop when the answer is pinned down, not when a clock runs out

- **The `Sim Hours` control is now `Precision ±`**, in percentage points. A room's sim runs until its clear chance is measured that tightly and then stops, instead of always burning a fixed span of simulated time.
- **Simulated hours bought accuracy at a rate set by fight length**, so a room resolving in five seconds was measured twenty times more finely than one running the full 120-second timeout — and the slow rooms are the marginal ones, where the decision is closest. On a real floor the badges carried anywhere from ±0.7 to ±4.8 points at 95% confidence, with the widest band on the room hardest to call.
- **Hovering a combat tile now shows the band and the sample**: `44.1% ±1.0` over `2,400 fights`, marked `(capped)` when the time ceiling stopped the run before the target was met. A rate is only worth the number of fights behind it, and that number now varies room to room.
- **Sim Hours survives as a ceiling**, renamed and moved to settings. Precision can only end a run early, never extend it, so nothing got slower: settled rooms — the 0% and 100% ones that fill a hard floor — now finish in a couple of hundred fights instead of the whole budget, while a room near a coin toss still runs to the ceiling and says so. Pinning a 44% room to ±1% would take about 9,500 fights, which no sane time budget covers; the marker is there so you can see when raising the ceiling would actually buy something.
- **Fixed a small bias in every labyrinth sim.** The attempt in progress when a run ended was counted as a trial but could never be a win, since the attempt count rises when a monster spawns and a win is only recorded when one dies — worth about a third of a point at 300 trials, worst on the slowest rooms. Runs that stop on precision stop at a spawn, where nothing is half-fought, and the trailing attempt is dropped either way.
- Cached sim results are keyed by precision rather than by hours, so the first calculation after updating recomputes.

### Fixed: the live clear chance flickered and read ~0% on a retried room

- **Retrying a room kept the previous attempt's fight record.** Neither the battle id nor the monster's maximum health changes when you re-enter the same room, and if the first update of the new fight already carried damage there was nothing left to notice it by — so the estimate measured against a start time from minutes earlier and read as no chance at all. A new fight is now recognised by health that went up, which only a fresh monster can do, and by an attack counter that went down, which only a fresh battle can do.
- **The readout is drawn once a second** rather than on every combat tick. Ticks arrive several times a second and the estimate moves on all of them, which reads as flicker rather than as information.
- **It is quoted in steps of five.** Rates measured off two health bars do not support a figure to the percentage point, and a number wobbling between 71 and 73 as blows land is noise however accurate its average is. 0% and 100% stay exact, being claims worth making precisely.

### Live clear chance in labyrinth combat rooms

- Combat rooms now show a **live clear chance** in the action bar, beside the room name: `[Clear ~72% | 48s left]`. Until now the only number for a fight was the tile badge's win rate, simulated before you walked in — it says nothing about how the fight in front of you is going.
- It is measured, not simulated. `battle_updated` carries both sides' current and maximum hitpoints about three times a second; the two rates of health loss are extrapolated to three finish lines — the monster dies, you die, the 120-second timer expires — and the readout is the chance the monster's lands first. Hovering gives both times-to-die, which race is the binding one, and the raw hitpoints.
- **Early numbers are marked with `?`.** Damage arrives in lumps, so a rate read off six seconds is a guess and one read off a minute is a measurement. The spread narrows as the fight supplies evidence, and nothing is shown at all for the first six seconds.
- **A fight joined in progress still reports.** Rates are measured over the window actually watched rather than assumed to run back to a full health bar — an estimator that insisted on catching the start would simply never appear if the first update arrived with damage already done. What being late costs is the clock: the time already spent is invisible, so the timer drops out of the estimate instead of being guessed at, and the readout omits the `Ns left`.
- Abilities, procs, healing and monster mechanics are not modelled. What the number captures is whether the trade is going your way fast enough.

### Groundwork behind it

- **`Toolasha.Debug.captureLab()`** records every WebSocket message for a minute and prints a digest: which message types arrive and how often, every numeric field that changed between consecutive messages, and a full field inventory per message type. Nothing registers or schedules it — it runs only when typed.
- The first version searched for fields whose **names** looked like hitpoints and found nothing on a live fight — a name search can only find what you can already name. It now diffs consecutive payloads and reports whatever moved, so the field turns up whatever the server calls it. (It is `pMap`/`mMap` keyed by unit index, with `cHP` and `mHP`.)
- **`battle_updated` is now exempt from message deduplication.** Consecutive combat ticks can open with identical text — same type, same battle, same unit ids — differing only in hitpoints further in, and the 100-character content hash was dropping them. Measured on a real fight, the message rate went from 0.65/s to 3.17/s: four out of five combat updates were being discarded before any feature saw them.

### Room attempt counter

- Rooms entered **more than once** are marked on the map with a `↻N` badge in the bottom-left of the tile, and the room you are running now adds `try N` to the end of the action bar's clear readout. The map gave no sign of this before: a tile looks identical on your fourth attempt and your first.
- The count is the server's own `entryCount`, the same figure the battle counter already shows as `Attempt #N` on combat rooms — so nothing is inferred, and the badge covers skilling and enhancing rooms, where no attempt count was shown at all.

### Beacon plans stop chasing a corridor that was never required

- **A beacon count you set now plans for coverage**: the beacons go wherever they reveal the most rooms, with ties between equally dark spots settled toward the one on your way to the exit. Previously a set count was forced into a chain of reveal areas covering an unbroken revealed path from the entrance to the exit, which pinned every beacon onto the entrance-to-exit line and clustered them by the exit corner — the odd-looking placements.
- **That corridor was never a real constraint.** Unrevealed rooms are walkable — the path planner routes through them and says so — so a floor can always be crossed without beacons. It now shapes only the answer that asks for it (count 0: the fewest beacons that cover a revealed path), and the set-count mode reports whether the way out ended up covered instead of being ruled by it.
- **Fixed: asking for fewer beacons than a corridor needs planned nothing at all**, answering "Need at least 3 beacons for a covered path" when the question was where to put the two you have. A set count always gets a plan now.
- **Fixed: an already-revealed path to the exit suppressed the plan entirely.** Asking for four beacons on a floor whose corridor was open returned none, however much of the floor was still dark; the same floor now gets 48 rooms revealed.
- **Route redundancy no longer outranks coverage.** It counts unrevealed rooms as blocked, which they are not, so it decides ties between equal chains and is reported in the status line — it is no longer paid for in rooms.
- Beacon and path planning now share one test for whether a room is revealed. The beacon side ignored `skillHrid`/`monsterHrid`, so a room the path planner treated as known could be counted as newly revealed.

### Credit dakonglong for the labyrinth simulator

- The README's credits now thank dakonglong, author of [迷宫胜率计算器 — Labyrinth Win Rate Calculator](https://greasyfork.org/en/scripts/566829-%E8%BF%B7%E5%AE%AB%E8%83%9C%E7%8E%87%E8%AE%A1%E7%AE%97%E5%99%A8), for the code and inspiration behind the labyrinth simulator, and link to the script.

### Resize from either side, and Payback is now Time

- **The sim panel resizes from the left edge and bottom-left corner too**, alongside the right, bottom and bottom-right grips. Each grip now moves the side you grabbed: the panel opens anchored to its right edge, so widening it used to push the opposite side across the screen — resizing now pins the panel by whichever edge you are not dragging.
- **Payback is renamed Time.** Shorter, and it matches what the figure is: how long you grind to afford the upgrade.
- **Gold/0.01% EPH and DPH now count toward the Score by default**, joining DPS, EXP, Profit and Repay. ROI stays out, being repay time inverted.

### Easier panel resizing, tighter upgrade columns, and a Columns menu that stays put

- **The sim panel resizes from its right and bottom edges**, not just the corner grip — the whole side is a target instead of sixteen square pixels. Dragging no longer selects page text, and **the size is remembered**, clamped to the viewport on restore so a size saved on a bigger monitor cannot open the panel off-screen.
- **Upgrade columns are narrower.** Headers split across two lines, so "Gold/0.01% Profit" costs the width of "Gold/0.01%" rather than the whole phrase; numbers right-align and never wrap, and only the upgrade name may reflow.
- **The raw deltas and ROI are hidden by default.** The deltas restate what the gold-per columns already price and ROI is repay time inverted, so none of the six earns its width up front — showing all sixteen at once is what forced the panel wider. Every one is a checkbox away in ⚙ Columns.
- **Fixed: the Columns menu reopened on almost any click.** It now closes when you click outside it or sort a column, while staying open as you tick boxes inside it — configuring should not dismiss the thing you are configuring. The dismiss listener is added on open and removed on close rather than living permanently on the document.

### Sticky headers, eight more columns, and a configurable Score

- The upgrade table's **header row now sticks** to the top of the results pane, so the columns stay labelled however far you scroll.
- **New columns**: ΔDPS, ΔEXP/hr, ΔProfit/hr, ΔEPH and ΔDPH as raw per-hour changes, plus **Gold/0.01% EPH** and **Gold/0.01% DPH** — both already computed and previously thrown away — and **ROI (1yr)**, a year of the added profit against the outlay.
- **⚙ Columns** above the table chooses which of those are shown and, separately, which count toward the Score. Hiding a column is about screen width; dropping one from the score changes the ranking, so the two lists are independent — you can read a metric without scoring it. Choices persist.
- Changing what the score counts re-ranks instantly. Scoring is pure ranking over figures already measured, so nothing is re-simulated.
- **ROI is off by default in the score.** It is `profit gain / cost` while repay time is `cost / profit gain` — the same ratio inverted, ranking candidates identically — so counting both would weigh one signal twice. The popover says so, and a test pins the two orderings together.
- Raw deltas are shown but cannot be scored: ranking by ΔDPS alone rewards whatever is most expensive, which is the opposite of what a value score is for.

### Gold-per columns now quote 0.01% instead of 0.1%

- The three **Gold/0.01%** columns quote the cost of a ten-times-finer improvement step, so the figures are a tenth of what they were. The step is only a rescaling — it divides every row by the same constant — so nothing reorders and no ranking or score changes.
- The Payback tooltip claimed the column was "a property of your bankroll, not of the upgrade". Both halves were wrong: it is driven by your profit rate rather than by coins on hand, and it plainly does depend on the upgrade, being proportional to its cost. It now says the accurate thing — every row divides by the same baseline rate, so Payback orders candidates exactly as Cost does, which is the real reason it is not scored.

### Payback, repay time and a Score column in the upgrade advisor

- **Payback** is how long you grind at your current profit rate to afford an upgrade; **Repay** is how long its extra profit takes to earn that cost back. Gold per 0.01% ranks upgrades by efficiency, which is a different question from whether one is worth buying at all — an upgrade with a great gold-per-DPS figure and a nine-month repay is still a poor purchase while your bankroll is the constraint.
- Both are derived from the averaged profit figures rather than a single run. A profit delta thin enough to be noise would otherwise send the repay period asymptotic, and a cell reading "412 years" off RNG looks like a measurement when it isn't. An upgrade that doesn't raise profit shows a blank rather than ∞ — it never repays, which says nothing against it if you bought it for DPS.
- **Score** awards points for placing in the top 5 of each value metric (gold per 0.01% DPS, EXP and Profit, plus repay time) and sums them, surfacing all-rounders that never top any single column. Expanding a row lists exactly which placings made up its score. The scoring is ordinal — winning a metric narrowly counts the same as winning it outright — so it sorts on request rather than by default.
- Payback is deliberately left out of the score: it follows from cost alone, so scoring it would count the Cost column twice under another name. Combat levels are excluded too, having no gold cost to rank. Ties share a placing rather than being split by list order.

### Credit jigglymoose for JIGS

- The README's credits now thank jigglymoose, author of [JIGS — Jigglymoose's Intelligent Gear Simulator](https://greasyfork.org/en/scripts/550346-jigs-jigglymoose-s-intelligent-gear-simulator), for several of the ideas behind the upgrade advisor and the wider combat-sim tooling, and link to the script. The acknowledgement sits alongside the existing MWITools credit.

## Unreleased — branch `claude/code-review-improvements-q6i4d5`

### Panel sizes you drag are remembered across reloads

- The game's panel dividers resize by writing inline styles and forget the result on reload, so a panel dragged to a comfortable width resets every session. New **Layout: Remember panel sizes you drag** setting (on by default) records the resize and reapplies it next load, and reapplies it again when the game re-renders a panel and drops the inline style.
- It does not hardcode which element the divider touches — the game's class names are generated and change between builds. Instead it watches for inline size styles written **while you are dragging** and remembers whatever changed, so the only styles ever replayed are ones the game itself wrote in response to your own drag.
- The remembered element is located by a structural path (tag plus position among same-tag siblings) rather than by class, and is fingerprinted at capture. If a game update changes the layout enough that the path points somewhere else, the saved size is discarded instead of restyling the wrong element.

### Lab Sim gold rows expand to show their cost breakdown

- Clicking a Gold Upgrades row now expands it: each item bought with its price, what the swap sells or keeps, the total, and the win rate against the baseline.
- **A blank Cost is now explained.** It means one of the items has no market listing at that enhancement level and no priced path to reach it, so the total is unknown rather than zero — the expanded row names which item. The win-rate delta on those rows is unaffected and still accurate.

### Forced lab swaps price as an added purchase, not a trade-in

- The labyrinth needs every element set, so buying Fire robes doesn't mean selling your Nature ones. The forced Anchorbound / elemental-robe / weapon swaps now price as an **added purchase with no resale credit**, which is what they actually cost you.
- New setting **Lab Simulator: Keep gear the forced armor swaps replace** (on by default) controls this. Turn it off to price them as straight swaps that sell the replaced piece. Either way the expanded row shows the resale value, labelled as credited or deliberately not credited.

### Clear button for the labyrinth path and beacon overlays

- The labyrinth toolbar has a **Clear** button that removes the path highlight and the beacon plan together. Previously the only ways to get an unobstructed view of the map were to re-run a calculation or change floors.

### Cape swaps take the better of equal-level or what you own, and include refined

- The cape comparison level is now **the worn cape's level, or a better copy you already own, whichever is higher**. Matching the worn level keeps the result about the cape rather than its enhancement, but a +10 cloak sitting in the bank against a +5 worn cape is what you'd actually equip, so that wins. A worse owned copy never drags the comparison down.
- **Refined capes are simmed too**, alongside the plain version of each — refined back-slot gear is already exempt from the +10 floor other refined items have, so a refined cape at the compared level is a fair candidate. A refined variant the game doesn't have is skipped.

### Cape swaps go both ways, compared at equal enhancement

- The melee cape trades offence for defence, which on a labyrinth run can be worth more to a ranged or magic loadout than its own style's cape. Every loadout is now offered **both** the cape matching its style and the melee cape — so a magic run sees Sinister Cape alongside Enchanted Cloak, and a ranged run sees it alongside the quiver.
- The reverse holds too: a magic run **already wearing** Sinister Cape is offered Enchanted Cloak, rather than the swap only being visible in one direction. Whichever cape is equipped is skipped as a no-op and its counterpart is simmed.
- Both are simmed at **the enhancement level of the cape currently worn**, so the result reflects the cape and not its enhancement — owning a +10 cloak no longer settles a comparison against a +5 equipped cape. With no cape equipped, the usual equipped → owned → +7 rule applies.
- A melee loadout gets one cape rather than the same one twice, and a lower-tier cape is never picked over the top tier no matter how large its stats.

### Sim the weapon in your spells' element too

- When the spells cast an element the weapon doesn't deal — a Nature trident casting Fireball — the weapon's own element is dead weight. The Lab Sim now also sims **that element's weapon**, both on its own and wearing that element's robes, since the matched weapon and robes are the build those spells belong to.
- The replacement stays in the same weapon class: elemental variants share the weapon's last name word, so a Trident maps to a Trident rather than proposing a different playstyle. With no same-class match, the best top-tier weapon of that element in the same slot is used.
- The weapon's enhancement level follows the same rule as armor — equipped, else best owned copy, else +7 — and the swap credits the weapon it replaces. Loadouts whose spells already match the weapon's element get no weapon candidates.

### Magic armor is chosen per element, from both the weapon and the spells

- Magic loadouts always got Fire robes suggested. The style match only knew "magic", and every top-tier robe qualified equally, so the tie broke alphabetically and Fire won every time — regardless of what the loadout actually casts.
- Element now comes from **both** sources: the weapon's damage type (`combatStats.damageType`) and the damage type of every equipped ability's effects. A Nature trident cast alongside Fireball reports both, and **both robe sets are offered** — each alone, each as a pair, and crossed with Anchorbound and with each other. When the weapon and spells agree on one element, only that set is offered.
- Within an element, the piece with the highest matching `*Amplify` at the top item level wins — a lower-tier robe never gets picked just for a bigger amplify number.
- Elements are ordered weapon-first, then by how many equipped abilities use them, and capped at two sets, since every extra set multiplies the pair combinations. Two elements means 3 sets: 6 single swaps and 9 pairs.
- Melee, ranged and any weapon dealing physical damage are unaffected — with no elemental gear in play, the previous style-based pick still applies.

### Fixed: armor pairs never appeared, and single swaps appeared twice

- The forced Lab Sim armor candidates were deduplicated on `slot|upgradeHrid|upgradeLevel|type`, which for a two-piece swap only described its **first** piece. So "Anchorbound body alone", "Anchorbound body + Anchorbound legs" and "Anchorbound body + other legs" all shared one key and the pairs were silently dropped — every armor row simmed one slot at a time. The same key also failed to match a single-slot `cross_slot` candidate against the equivalent `tier` candidate, so those rendered as duplicate rows with identical numbers.
- Deduplication now keys on the **full slot assignment** the candidate results in (added slots with their enhancement levels, plus any cleared slots), so pairs are distinct from their pieces, two pairs sharing a body piece stay distinct, and a single-slot swap matches its tier-progression twin regardless of which generator produced it.
- Pair rows now read in the same shape as every other row — `Royal Nature Robe Top + Royal Nature Robe Bottoms → Anchorbound Plate Body + Anchorbound Plate Legs (+7)` — with per-piece levels shown as `(+7/+10)` when they differ.

### Lab Sim always evaluates Anchorbound and the matching top-tier armor

- Whenever the Lab Sim upgrade analysis includes equipment, it now always sims the **Anchorbound plate body and legs** and the **top-tier body/legs that suit the loadout's weapon style** — each piece alone, each set as a pair, and the cross-set pairs (Anchorbound body with the other set's legs and vice versa). Duplicates collapse when Anchorbound _is_ the style match, and any combination you already wear is skipped rather than simmed as a no-op.
- The tier progression only ever steps one rung from what's equipped, so a player in decent gear never saw these comparisons. They're forced in regardless of what's worn.
- **Enhancement levels come from what you own**: the level equipped in the analyzed loadout, else the best copy in your inventory, else **+7** so the comparison still runs for gear you haven't bought. Copies equipped elsewhere and empty stacks are ignored.
- Style matching reads the weapon from either the two-hand or main-hand slot, and "top tier" is the highest item level actually present rather than a hardcoded 95, so a future tier doesn't leave this pinned to old gear. Refined variants are skipped — they share their base item level but cost far more to reach a usable enhancement. When nothing at the top tier matches your style, style-neutral armor is used instead.
- Cost is the real delta: it buys the added pieces and credits the gear they replace, and an empty slot credits nothing.

### Combat levels get their own results box; Ability Swaps carries a warning

- **Combat level results moved into a separate box** below the gold-cost table, with their own columns (Skill, Level Time, Main Time, ΔDPS, ΔEXP/hr, ΔProfit/hr) and their own independent sorting. Previously, mixing Combat Lv with a gold-cost set flattened them into the gold table where their Cost cell was meaningless and the level-time column vanished entirely. The box states why they're ranked separately: levels cost grind time, not gold, so they can't share an axis with gear.
- Each table now sorts independently and expands its own detail rows — clicking a row in one no longer toggles a row in the other.
- **Ability Swaps hover now warns what it is**: it sims every style-compatible ability for every slot (far more sims than any other set, so expect a long run), and a swapped-in ability is simmed at the level of the ability it replaces using that book's default triggers — no trigger tuning, and its cost assumes leveling a fresh book from scratch. The ranking is a hint about what's worth trying by hand, not a verdict.

### Upgrade tab controls are grouped with the checkbox they belong to

- Each candidate set is now a bordered chip holding its own options, so it's visible which checkbox an option modifies: **Skip Back** sits inside Equipment, the **+Levels / Target Lv / Targets** controls inside Ability Lv, **Charm / Targets / Main time** inside Combat Lv, and **Lv / Targets** inside House. A checked set lights its chip and reveals its options; unchecked sets dim and collapse.
- The pop-out target grids now carry an accent stripe and name their owner ("**Ability Lv** target levels…", "**Combat Lv** target levels…", "**House** target levels…") so a grid can't be mistaken for belonging to another set.
- The +Levels box still feeds both Ability Lv and Combat Lv — one number drives both — so it stays visible when either is checked, and its tooltip says which sets it's currently driving.

### Per-room house target levels

- **House now has a Targets button**, mirroring Ability Lv and Combat Lv: it opens a grid with one input per combat-relevant house room, labelled with the room's current level, prefilled from the uniform Lv value. Set different targets per room and each is simmed to its own level, with cost summed across every level in its span.
- Per-room targets take precedence over the uniform Lv value while the grid is open, and — matching the ability and combat grids — a room left blank is skipped rather than falling back to +1. Rooms already at level 8 are shown disabled.

### House upgrades: fixed the empty list, added a target level

- **House produced no candidates at all.** The combat-relevance test read `usableInActionTypeMap` off each buff, one of several places the game exposes that tag — and not the one live data uses, so every room was filtered out and the tab reported "0 upgrades evaluated". Relevance now accepts **any** of three independent signals: the tag on the room, the tag on a buff, or a buff `typeHrid` the combat engine actually reads. Over-including a room only costs a sim that comes back at 0.00%; under-including hid the whole feature.
- **New House Lv input** (appears when House is checked): set a target level and every combat room below it is simmed at that level in one jump — "Dojo Lv3 → Lv6" — with the cost summed across every level in the span. Leave it blank for the previous behavior of one level up from wherever each room sits. A level above the cap clamps to 8, and rooms already at or above the target are skipped.
- An empty House result now **explains itself** instead of reading as "no upgrades available": it reports whether the house data was readable, whether any room looked combat-relevant, or whether the rooms are simply all maxed. A silent zero can't recur unnoticed.

### Food search now starts from your equipped tiers and steps down

- Instead of binary-searching each slot's whole pool from the bottom up, the search is **anchored at what you have equipped**: if your current setup survives, each slot walks down one tier at a time within its type until survival breaks, then settles on the last tier that held. The first trial is free — the analysis baseline already simmed your exact food on the same seed.
- If your current setup does _not_ survive, the failing dimension's slots climb instead: deaths raise the HP-type slots, running dry raises the mana-type slots, one tier at a time until it holds. Targets only relax when even the top tiers can't get there, same as before.
- This keeps recommendations local to your setup — a one-tier downgrade like "Star Fruit Gummy → Plum Gummy" — and makes the sim count proportional to how far your tiers can actually drop, not to the size of the food catalog.

### Food search minimizes slots sequentially so shared mana budgets hold

- The per-slot searches each ran with the _other_ slots held at their top tier. With two mana sources (a gummy and a yogurt), each got minimized against a top-tier partner it wasn't actually going to have — the two proven minima failed together, the confirming sim caught it, and the fallback then recommended the **top tier of every type at once** (the "upgrade all three, +90K/hr" card).
- Slots are now minimized **sequentially**: each slot is fixed at its proven minimum before the next slot is searched, so later searches see the real, already-shrunk earlier choices. The final combination is one the search itself simmed and passed — no more optimistic combinations, and the everything-at-top fallback is gone (a slot only stays at top tier when nothing below it passes _in context_).
- The cheapest-per-point swap after the search now guards itself: if the swapped combination fails its confirming sim, the result reverts to the proven tiers instead of escalating.
- Regression-tested on the failing shape: two mana slots whose minima each pass beside a top-tier partner but fail together must resolve to a one-slot tier bump, never to top tiers across the board.

### Food search keeps your food types and refuses out-of-mana picks

- The first version of the food search collapsed all three food slots down to one HP item plus one MP item. For setups that rely on more slots (two HP foods, or an extra mana source), even the "best available" probe ran out of mana — and since the search relaxes its targets to whatever the best probe achieves, a 49%-out-of-mana recommendation could "pass" while your real setup sat at 0%.
- The search is now slot-templated: **each equipped food slot keeps its exact food type** (HP instant only competes against HP instant, MP over-time against MP over-time), buff foods are never touched, and only the tier within each type is varied. A slot can also come back as "empty (not needed here)" when the zone doesn't require it.
- Out-of-mana and deaths are both hard requirements at every step — targets only relax when even the best tiers of _your own_ food types can't meet them, and the card says so explicitly per shortfall.
- **Keeping your current food is always a candidate**: if it's viable and no more expensive than the searched pick, the card now says to keep it instead of recommending a sidegrade. The card also shows per-slot changes as "current → replacement" lines.
- Regression-tested against the exact failure: a low-tier mana drink leaving 49% of the run out of mana must lose to the same-type higher tier, never be recommended for a 5K/hr saving.

### Upgrade tab: pick several candidate sets at once, plus house and food

- **Mode dropdown → checkboxes.** The Upgrade tab's single-choice Mode select is now a row of **Include** checkboxes (Equipment, Ability Lv, Ability Swaps, Combat Lv, House, Food), so several candidate sets sim together and land in one ranked list instead of forcing one analysis per set. The old "Equipment + Abilities" option is gone — it's just both boxes checked. The selection is remembered between sessions.
    - Combat levels have no gold cost, so in a mixed list their Cost cell reads "levels" with a tooltip pointing at the dedicated view. Checking only **Combat Lv** still gives the level-time table exactly as before.
    - Lab Sim keeps its own Mode dropdown: one of its options (all-fights) runs a different analysis entirely, so it isn't a set that can be unioned with the others.
- **House room upgrades.** Checking **House** adds one level of every combat-relevant house room as a candidate, costed at coin face value plus the market price of each material (unpriced material → unknown cost, which ranks last rather than as free). Rooms identify themselves as combat-relevant through the game's own per-buff action-type map, so a game update that adds a room doesn't need a code change.
- **Cheapest viable food.** Checking **Food** searches for the cheapest food-slot setup that still avoids deaths and running out of mana, shown as its own card above the table with the gold/hr saved against your current food. Rather than pricing every combination, it uses the fact that more restore per eat never makes survival worse: a binary search over restore amount finds the tier actually needed, then cost decides among everything at or above it, and a confirmation sim validates the pick (falling back to the best available setup if the cheaper equivalent doesn't hold up). Buff-only food you already had stays equipped, and the card is explicit about what isn't searched — buff drinks, and mixing an instant with an over-time food.
    - If no food setup reaches zero deaths at the zone, the target relaxes to the best achievable and the card says so instead of silently recommending the most expensive option.

### Seeded sim RNG is now a setting

- **Combat Simulator: Shared random seed for upgrade comparisons** (on by default) controls the common-random-numbers behavior below. Turning it off returns every sim to independent randomness. It's a setting because sharing a seed cuts the noise in a comparison but also freezes one sample's luck into the absolute numbers.

### Seeded sim RNG so upgrade comparisons stop measuring noise

- The engine drew every roll from `Math.random()`, so a baseline sim and a candidate sim were two **independent random samples**. An upgrade's reported delta was its real effect plus the gap between those samples, which is why near-zero upgrades (a +5 level on a long-cooldown ability) came back at −0.06% DPS and flipped sign between runs.
- Sims now draw from a seeded PRNG, and every sim inside one upgrade analysis shares a seed — **common random numbers**, so the shared randomness cancels out of the delta. A fresh seed is drawn per analysis, so re-running still resamples rather than reprinting.
- Draws are split into independent streams by purpose: monster spawn composition, per-encounter monster setup, and combat rolls. The spawn stream takes no player-dependent draws, so compared runs fight the **same monster sequence** even after their combat rolls diverge.
- The combat and setup streams restart at the top of every encounter, so encounter N begins from the same random state in both runs regardless of how encounter N-1 went — divergence can't compound across a whole sim.
- Applies to the Combat Sim Upgrade tab, the Lab Sim Upgrade tab, and the labyrinth all-fights analysis (per-fight seeds, matched across candidates). Plain Calculate runs, all-zones, and the task zone estimate pass no seed and stay on `Math.random()` — unchanged behavior.
- Expect more exact `0.00%` rows where a change genuinely does nothing. Note that shared seeds cut the noise in a comparison but don't remove sampling error from the absolute numbers, so sim hours still matter.

### Experience buff removed from the labyrinth upgrade comparison

- The **Experience** labyrinth buff was listed alongside real upgrades in Lab Sim's Upgrade tab, ranked by a token-cost-per-percent figure derived from a flat XP formula rather than a sim. Since XP gain does not affect labyrinth combat outcomes, it competed for a "best value" slot it can't earn on that metric. It's now excluded from the comparison (the buff itself is untouched and still editable in the token upgrade editor).

### No more paid sidegrade recommendations

- The "next tier" equipment candidate took the next entry in an item-level-sorted list without checking the level actually went **up** — so a same-tier sibling in the same slot and role was recommended as an upgrade, costing gold for no gain. It now walks forward to the first genuinely better item. A refined variant sharing its base item's level still counts as an upgrade (better stats); refined → another refined at the same level does not.
- **Consolidated the encounter counter**: the task zone-fight estimate now reads the sim's existing `encounters` field (fights cleared) instead of the duplicate `zoneEncounters` counter added earlier, which is removed.

### Recommender audit: unknown costs no longer rank as the best upgrade

- **Unpriceable enhancement paths reported as free.** `calculateEnhancementCost` returned `0` when an item had no enhancement recipe, and also when every protection strategy failed to compute — and `0` cost means gold-per-improvement `0`, i.e. the **top-ranked, best-value upgrade in the list**, highlighted as best. It now returns "unknown", which the ranking already maps to last place (Combat Sim shows `?`, Lab Sim shows `—`). This is the same rule the code states elsewhere: "unknown cost must rank as Infinity, never as free".
- **Enhanced-item buy prices no longer understate.** When a tier swap at +N has no market listing, the fallback is base price + enhance path; an unknown enhance path silently contributed `0`, pricing a +12 item as a bare +0 craft. That now reports unknown too.
- **Skilling analysis gold-per-clear-rate** divided by a `null` cost (JS coerces to `0`), producing a `0` = free reading for unpriceable upgrades. Now guarded (value is currently computed but not displayed).

### Philosopher's accessories recommended at +5

- Combat Sim and Lab Sim (combat **and** skilling analysis) now always offer the Philosopher's necklace / ring / earrings at **+5** for jewelry slots, no matter how enhanced the worn accessory is. Previously the tier path only ever proposed a swap at the _current_ enhancement level — so wearing +12 jewelry hid the cheap entry point behind a +12 rebuy. When a same-slot philo swap at a higher level is also generated, the +5 version supersedes it.

### Ability dictionary button now actually appears

- The first attempt matched menus by a class containing `actionMenu`, which the ability popup doesn't use. Detection is now fully class-free: it finds the popup's **Link to Chat** button, walks up to the container holding the `Lv.N` heading, and injects there. The book is also verified via `abilityBookDetail` so only real ability books get a button.

### Open Item Dictionary from ability menus

- Clicking an ability (Abilities panel, Loadouts, anywhere the "Lv.N Name / Link to Chat" popup appears) now offers **Open Item Dictionary**, jumping straight to that ability's book entry. Menus are matched by their heading content rather than a hardcoded class, so it survives the game's class-name churn, and item menus are left alone since they already have the button.

### Solo/Zone estimate choice is remembered

- The Solo/Zone toggle on task estimate cards is now a persisted preference: new cards start on your last-used mode instead of resetting to Solo, and **auto-estimates use it too** — previously the auto-estimate path always simmed Solo regardless of the toggle.

### Task estimates pick the zone your tasks share

- Monsters that spawn in more than one zone (e.g. Boomy in both its dedicated action and Gobo Planet) now resolve to the zone covering the **most of your active Defeat tasks**, so all co-located task cards sim the same zone and show one consistent summary. With no overlapping tasks, the dedicated zone still wins — it's the faster farm for that monster alone.

### Zone summary: shared sims, summed duplicate tasks, zone-membership grouping

- **All cards in a zone now agree**: full-zone sims are shared per zone+loadout (3-minute cache) instead of each card rolling its own RNG, so every Gobo Planet card reports the same fights/time.
- **Duplicate tasks sum**: one kill only progresses one task, so five Boomy tasks need the sum of their remainders — the bottleneck math now aggregates per monster across duplicate tasks and labels it (e.g. `bottleneck: Boomy ×5`).
- **Grouping by zone membership**: a task joins a zone's summary when its monster actually spawns there (regular or boss spawns), not by first-match zone lookup — shared monsters previously landed in the wrong group.

### Zone fight estimate counts fights, not kills

- The task zone summary ("~N fights") summed every monster **death** in the sim, but zone encounters spawn several monsters at once — so the fight count was inflated by the average wave size. The sim engine now tracks actual encounters spawned (`zoneEncounters`, bosses and dungeon waves included) and the summary uses that, so "fights" now means what the game means by it.

### Guild idle list includes hidden-status members

- Members hiding their online status now appear in the idle list when their action queue is empty — what matters is whether the character is doing an action, not their presence. Their entry never states online/offline (dimmed color, neutral tooltip), so the privacy setting still conceals what it's meant to conceal.

### Guild idle list fixed — wired to the real activity signal

- The correct field turned out to be `actionType` in the guild sharable data: it carries the running action's type (e.g. `/action_types/combat`) and is empty when a member has nothing running — the same signal behind the game's Activity column (confirmed by sampling an active member vs. two idle ones). The idle list now uses it and is **re-enabled by default**.
- Since actions keep running while offline, offline members with an empty queue count as idle too — they're shown dimmed after the online ones. `inactiveTime` turned out to update continuously for online members, confirming it was never usable for this.

### Guild idle list off by default pending correct data

- Even with the zero-time fix, `inactiveTime` turns out to be a historical "last went inactive" stamp — online members doing actions still carry one, so the list keeps flagging active players. The setting now defaults to **off** until the correct signal is wired up.
- New console helper `Toolasha.guild.memberSample('Name')` dumps a guild member's raw sharable data so the real activity field the game's own Activity column uses can be identified.

### Guild idle list no longer flags every online member

- The upstream idle-members feature treated `inactiveTime` as "set = idle", but the game sends Go's zero time (`0001-01-01T00:00:00Z`) — a truthy string — for members who are **not** idle, so every online member landed in the list. The timestamp is now normalized at ingestion (zero time → null), fixing the idle list and any other consumer of the field.

### Vendor check compares against the path actually taken; button placement

- **Vendor now wins over forced insta-sells**: the vendor comparison used the ask price, but a stack under the minimum listing value takes the insta path and only nets the bid — so e.g. Red Tea Leaf (bid 48 → 47 net vs vendor 48) wrongly insta-sold. The check now predicts the path (below the listing minimum → bid; otherwise → ask) and compares vendor against that.
- **Bulk Sell button stays to the right of Market History**: the Market History tab is injected by its own feature and could land after our button; the button now repositions itself to its right whenever that happens.

### Vendor check runs before marketplace navigation

- Fixed the vendor-sell item menu opening and instantly closing: the vendor decision now runs **before** any marketplace navigation (using the cached market price for the vendor-vs-net comparison), so the navigation's trailing clicks can no longer dismiss the menu. The menu open also retries once if something still closes it.

### Bulk Sell: vendor when the market is no better

- New **vendor check** (on by default): if the game vendor pays at least as much per item as the chosen market path would net after the 2% tax — e.g. Red Tea Leaf, vendor 48 vs ask 49 → 48 net — the assistant opens the item's inventory action menu with **All** preselected instead of a market modal, so one click on the game's "Sell For … Coins" button vendors the whole stack. The status line shows the comparison (`vendor 48 ≥ market net 48`). Unenhanced items only; falls back to the market flow if the inventory tile isn't visible.

### Bulk Sell: minimum value for a sell listing

- New **minimum stack value for a sell listing** setting (default 1.5M): stacks worth less than this at the ask price get insta-sold to the best bid instead of occupying one of your limited sell listing slots. 0 turns the rule off. The panel's status line shows when it fires (e.g. `stack 840K < 1.5M min`).

### Merged upstream (Celasha/Toolasha) commits since the fork

- **Guild Overview idle members list** (new setting `guildIdleDisplay`, on by default): shows guild members currently not performing any action.
- **Seek zone drop lookup includes boss spawns**, so items dropped only by zone bosses resolve correctly.
- **Task card min-height style is removed when the reroll tracker is disabled** instead of lingering.

### Bulk Sell off by default, native tab styling

- The **Bulk Sell Assistant setting now defaults to off** — enable it in Settings → Market to get the button back.
- The Bulk Sell tab-bar button is now a **clone of a native tab** (same approach as the Market History tab) instead of a gradient chip, so it matches Market Listings / My Listings / Market History; while the panel is open the tab shows a blue underline.

### Userscript renamed to "Toolasha (Millennium44)"

- The `@name` in the release entrypoint and the dev standalone headers now carries the fork owner, so the Greasy Fork listing and Tampermonkey entry are distinguishable from the upstream "Toolasha". Note: Tampermonkey treats the renamed script as new — remove/disable the old "Toolasha" entry after installing the renamed build so they don't both run.

### Fork installs no longer auto-update to the upstream Greasy Fork listing

- Removed the upstream `@downloadURL`/`@updateURL` (Greasy Fork script 562662) from the userscript and entrypoint headers — Tampermonkey could otherwise silently replace an installed fork build with the upstream listing's release. Fork releases go through the repo's own Release Please pipeline instead.

### Reroll stepper sunset

- The Reroll Tasks stepper button is disabled for now (unregistered, setting removed) — the discard flow wasn't reliable in practice. The source stays in the repo for a later revival. The per-character reroll limits and the zero-limit glow rule in reroll protection remain active.

### Reroll stepper discard fixed

- The trash can is an icon-only red button with no "trash" hint in its markup, so the discard step never found it. It's now located as the card's icon-only danger button (with icon-only and trash-hint fallbacks), and the confirmation click ("Confirm Discard") is scoped to the card with a retry while the view switches. MooPass Free Rerolls were already preferred over paid ones whenever a card offers them.

### Reroll stepper: one click per action; clickable names in announcements

- **The Reroll Tasks button is now a stepper** honoring the game's one-click-per-server-action rule: each click performs exactly one reroll (or one discard) on the first task that needs it, and the label previews what the next click will do — `🎲 Reroll 20K💰 (3)`, `🗑 Discard Task (1)`, or `✓ Tasks settled`. Menu-opening and confirm clicks stay UI-only; exactly one action reaches the server per click.
- **Discarding uses the real flow**: Back (when the reroll options view is open and hiding the trash can), then the trash can icon, then the "Discard Task" confirmation — all driven from the one button click, with only the confirmation reaching the server.
- **New: clickable names in chat announcements** — the player name in messages like "Az0r has reached level 150 Magic!" becomes a link that fills `/profile Az0r` into the chat input (setting: "Chat: Clickable names in announcements"). Regular messages keep the game's own name menu.

### Task bulk reroller, per-character reroll limits, smarter cap glow

- New **🎲 Reroll Tasks** button in the task panel header (next to the Claim Reward collector): one click rerolls every non-protected task — coins first, then cowbells — until it lands on a protected task or hits the reroll limits, and **deletes tasks at the limit for both categories**. Free rerolls are used when offered, completed tasks are never touched, and clicking again stops the pass mid-run. Progress shows on the button.
- **Reroll limits are now per character**: the cap-protection toggle and both thresholds in the 🛡️ popup save per character (existing global values carry over as the starting point for each character).
- **Cap glow respects zero-reroll categories**: a category whose limit allows zero rerolls (threshold at the minimum 10K/1) no longer lights the orange at-cap glow by itself — the card only glows once the other category's limit is actually hit.

### Collapsed tab values match expanded, Bulk Sell remembers its tab

- **Collapsed tab header value no longer overshoots**: enhanced item tiles are indexed under both their base and +N keys (and an item can sit in both a parent and child tab), and the collapsed rollup summed every key it touched — so tabs holding both references counted the same tile twice, showing a different net worth collapsed vs expanded. The rollup now counts each tile once, matching the expanded totals.
- **Bulk Sell remembers the last tab you sold from** (per character): the dropdown restores your previous selection when the panel opens, falling back to All items if the tab no longer exists.

### Bulk Sell respects the tabs above the selling tab

- When selling from a specific Toolasha inventory tab, any item that is also assigned to a tab shown **above** the selected one (in the panel's top-to-bottom order, including a child tab's parent) is kept, not sold — higher tabs act as keep-lists. Matching is by exact enhancement level, same as the tab filter itself.

### Bulk Sell button opens the floating panel; decision rules configurable

- The tab bar now holds just a **Bulk Sell** button (styled like the Lab Sim button, next to Market History) that shows/hides the original floating panel with all the controls. Hiding the panel mid-run doesn't stop the run — reopening shows live progress.
- The insta-sell decision is now configurable: the existing **queue age** setting gains "0 = off", and a new **supply ratio** setting controls the supply rule — insta-sell when sell-order supply exceeds buy-order demand × ratio (1 = whenever supply outnumbers demand, 2 = only at double, 0 = off).
- Removed the order-book-wait and advance-delay pacing settings added in the previous change (fixed sensible values instead), along with the floating-chip placement toggle the new button supersedes.

### Bulk Sell placement toggle, stack-value ordering, timing settings

- New **Bulk Sell as floating chip** setting (off by default): switches the controls back to the original fixed chip near the top-right of the screen; off keeps them inline in the marketplace tab bar. Flipping it takes effect immediately, no reload needed.
- Queue order now uses **stack value** (cached unit price × count) instead of unit price alone, so the most valuable stack sells first — 30K arrows at 20 gold now beat a single 100K sword.
- New timing settings: **order book wait** (seconds before an item is skipped as having no market data, default 3 — raise on a slow connection) and **advance delay** (pause in ms after a sale confirms before moving to the next item, default 400).

### Bulk Sell moves into the tab bar, sells most expensive first

- The Bulk Sell controls now live in the marketplace tab bar right next to Market History (falling back to the end of the bar when the Market History viewer is off) instead of floating over the panel — same spot across every subview, so the flow stays one-click-per-item.
- The queue is ordered by cached market unit price (ask, else bid) descending, so the most valuable items in the selection sell first; unpriced items go last, alphabetically.
- Fixed a latent crash in the Refresh Next button's cleanup path (it called `.disconnect()` on a watcher that is a plain unwatch function).

### Bulk sell a single Toolasha inventory tab

- The Bulk Sell chip gains a tab filter (shown whenever you have Toolasha custom inventory tabs): pick a tab and Start queues only the tradable items assigned to it — a parent tab includes its child tabs, and enhanced items match at their exact enhancement level, the same way tabs track them. "All items" keeps the original whole-inventory behavior. The list refreshes when you open the dropdown, so tabs edited mid-session show up.

### Bulk Sell Assistant

- New **Bulk Sell** button (fixed chip near the top-right of the marketplace) sells the whole inventory one item per click: Start queues every tradable inventory item, then for each item it opens its order book, decides insta-sell vs. sell listing, opens the matching modal with the full quantity prefilled, and waits — one click on the game's confirm button (always in the same place) completes the item and auto-advances to the next.
- **Decision rule**: insta-sell to the best bid when sell-order supply exceeds buy-order demand, or when the oldest ask has been queued longer than the configurable limit (`Market: Bulk sell insta-sell queue age`, default 2 days — the queue isn't moving); otherwise it posts a sell listing at the going ask.
- The chip shows progress, the chosen action/price/reason for the current item, plus Skip and Stop controls. Items with no market data or no orders are skipped automatically. The assistant never confirms a sale itself — every server action is your click.

### All Fights analysis defaults to skip levels

- "Combat Levels — All Fights" gains a **Use Skip Levels** checkbox (on by default): fights sim at their automation skip level (effective combat level + skip − 1) instead of the current run's live room levels, which mid-run could be far above the skip thresholds and drown the analysis in 0% fights. Uncheck it to analyze the active run's actual rooms.

### Beacon indicators clear themselves once used

- Coverage fills disappear room by room as rooms get revealed, and a numbered center marker (B1, B2, …) disappears once every room that beacon was planned to reveal is revealed — whether by using the beacon or by torches/other beacons making it redundant. Markers on already-revealed rooms are safe: clearing is keyed to each beacon's planned reveals, not the room under the marker.

### Per-ability targets, skilling tab scroll fix, analyzer tooltip

- **Ability Levels gets a Targets grid** in both Combat Sim and Lab Sim (also active in Equipment + Abilities mode), mirroring the Combat Levels one: a Targets button opens a per-ability grid built from the player's equipped abilities, prefilled with current level + the +Levels boost. While open, targets replace the uniform boost; blank or ≤-current entries skip that ability.
- **Player Setup no longer gets cut off**: the Lab Sim Skilling tab now scrolls as one page instead of clipping expanded sections inside tiny fixed-height scroll areas.
- **Analyze Upgrades explains itself**: hovering the button describes the tick-up behavior — each equipment piece sims at its next enhancement breakpoint, and when that doesn't move the clear rate the target keeps rising one level at a time until it has a positive impact.

### Loadout character cards keep your name, outfit, and real ability levels

- **Name and avatar/outfit fixed**: the sheet builder only knew where profile-share data keeps the character identity (`sharableCharacter`); your own character data nests it under `character`, so loadout cards rendered as a default "Player" with the default avatar. The builder now checks both.
- **Ability levels fixed**: loadout cards looked levels up in the _currently equipped_ ability list, so any loadout ability you don't have equipped right now (e.g. Insanity) showed as Lv 1. Levels now come from the full learned-abilities list, with the equipped list as an overlay.

### Beacon planner prefers multiple independent routes

- The planner now measures how many **vertex-disjoint routes** to the exit the revealed region offers (exact max-flow, so "2 routes" means no single blocked room can sever the way) and prefers placements with two independent routes: among equal-count minimum chains it picks redundant ones first, and extra beacons buy redundancy before raw coverage. The status line reports it (`… · 2 independent routes`).

### Labyrinth beacon planner

- New **Beacons** button (with a count input) in the tile controls bar plans optimal beacon placements: the fewest beacons — or exactly the amount you set (0 = minimum) — whose 13-room reveal diamonds chain into a walkable revealed corridor from the entrance to the floor exit, chosen to reveal as many new rooms as possible (beam search over minimal chains; extra beacons go wherever they add the most coverage).
- Already-revealed rooms count toward the corridor, so mid-run plans build on what's uncovered; if a revealed path already exists it says so, and if the requested count can't cover a path it reports the minimum needed.
- The plan renders as teal fills over every newly revealed room with outlined, numbered beacon centers (B1, B2, …); the status line reports beacons used and rooms revealed. Overlays clear on floor change.

### Labyrinth math aligned with the official formulas

- **Skilling success rate floors at 5%**: the game computes `MAX(5%, 0.80 × (1 + LevelBonus + Buffs))`, but every clear-chance calculation clamped at 0% instead — deep-underleveled rooms showed lower clear odds (and skip recommendations) than reality. All eight success-rate sites (tiles, what-ifs, editor-based analysis, enhancing) now use the 5% floor.
- **Gourmet no longer counts toward lab double progress**: the official formula is Crate + Gathering (Milking/Foraging/Woodcutting only) + Upgrade; cooking/brewing rooms were incorrectly crediting the gourmet buff as double-progress chance.
- Everything else audited against the published combat/lab formulas matches: HP/MP, attack interval, cast time, ability cooldown haste, accuracy/damage/evasion ratings, bulwark smash, hit chance (^1.4), ranged bonus crit, armor/resistance and damage-taken ratios (including the negative branch), thorns, retaliation (incl. the 5× premitigated cap), status tenacity scaling, threat targeting, labyrinth monster level/armor scaling, work power, room XP, and all reward expectations.

### Battle counter: labyrinth fights always show Attempt #, zones always show Battle

- The counter's labyrinth detection relied on state flags and an action HRID guess, and both go stale in opposite directions — a labyrinth run stays "active" between entries while you fight regular zones, and stale labyrinth messages arrive right after exiting — which is why every previous fix flipped the bug from one side to the other. The render decision now comes from the header title itself (labyrinth fights are titled "Labyrinth - <Monster>"), so lab fights show `· Attempt #N` (or nothing until the attempt count arrives — never `Battle #`), and regular zones/dungeons show `Battle #`/`Wave · Battle #` regardless of lingering labyrinth state.

### Labyrinth path planner: optimal route to the flag

- New **Path** button in the labyrinth tile controls bar computes and highlights the best route from your cleared rooms (or the entrance on a fresh floor) to the floor exit, using the same per-tile clear chances as the badges (combat tiles sim on demand, cached).
- **Priorities are lexicographic**: fewest **shrouds** first (a shroud instantly clears a room, spent on any tile whose clear chance is below the threshold), then most treasure rooms — every chest reachable without spending an extra shroud is grafted onto the route, even at extra torch cost — then fewest torches (uncleared rooms revealed).
- **"Clear ≥" threshold input** next to the button sets what counts as clearable (persisted as its own setting, default 70%, fully separate from the skip recommendation target).
- Route tiles get colored outlines: green = clearable, red "Shroud" tag = instant-clear needed, gold = treasure, blue "?" = unrevealed (routed as clearable — reveal to verify), purple ⚑ = floor exit; the status line summarizes rooms/shrouds/chests and flags unrevealed rooms on the route. Overlays clear on floor change.
- **Position anchors the route**: the labyrinth always starts top-left and exits bottom-right, and unrevealed rooms carry an empty room type (the exit/treasure types only appear once revealed) — so the planner keys the entrance and exit off grid position instead of room types and works on fully unrevealed floors.
- **No walls**: every cell is a room, so unrevealed rooms that appear as null entries in the room data are passable unknowns, never obstacles — previously they blocked the search and produced "No route to the floor exit" on partially revealed floors.
- **Unrevealed-room mode selector** next to the threshold input (persisted setting): `? Clear` routes through unknowns as clearable (optimistic, default), `? Shroud` costs each unknown a shroud so the route prefers revealed rooms and unknowns show a red "Shroud?" tag, `? Avoid` treats them as impassable and routes through revealed rooms only.
- **Route outlines disappear as you clear rooms**, so the highlight always shows what's left of the plan instead of lingering on finished tiles.
- Repository references updated from MHipp/Toolasha to Millennium44/Toolasha after the GitHub username change.
- The vendored mathjs bundle no longer points at a missing `math.js.map`, silencing the source map fetch error in the console.

### Labyrinth sims stop killing each other — recommendations finally survive lab runs

- The real interruption: every labyrinth simulation started by **terminating all in-flight sim workers**. During a lab run, each room switch queues tile-badge sims, and each one killed the skip-recommendation search's sim mid-flight (the killed sim read as a 0% result, corrupting or aborting the binary search). Labyrinth sims no longer preempt each other — each runs in its own worker, so tile badges, recommendation searches, and Lab Sim runs coexist; Stop buttons still cancel everything.
- An explicit Stop now cleanly aborts an in-progress recommendation search instead of recording the killed sim as a genuine 0%.

### Lab Sim Skilling tab cleanup and per-skill analysis

- **Tidier layout**: the Skill filter moved inline next to Use Skip Levels (it used to wrap to its own line), the Calculate/Analyze buttons are right-aligned, and the player setup editor (skill levels, house rooms, token upgrades, community buffs) is now a collapsed "Player Setup" section — expand it only when overriding live values.
- **Selecting a skill scopes everything to it**: Calculate shows just that skill's row, and Analyze Upgrades only sims equipment actually worn for that skill's room (its loadout, or base gear) instead of all 49 candidates across every loadout. Token-upgrade candidates still apply to any skill.

### Labyrinth recommendations survive lab runs too

- The loadout snapshot fingerprint excluded: snapshots are rebuilt with a fresh `savedAt` timestamp every time the game re-broadcasts loadouts — which happens when the lab equips the next room's loadout — so recommendations were still being wiped mid-run. The timestamp is now excluded from change detection; only genuine gear/enhancement changes invalidate.

### Right-click a labyrinth tile → Lab Sim opens preconfigured

- **Combat tiles**: right-clicking now opens the Lab Sim with that monster selected, its assigned labyrinth loadout applied to the editor, and the tile's room level filled in — no more re-picking everything after opening.
- **Skilling tiles** (including enhancing) gain the same right-click: the Lab Sim opens on the Skilling tab with the tile's room level set (Use Skip Levels unchecked so it applies) and the loadout table filtered to that skill. The skilling tooltip now shows the right-click hint too.

### Labyrinth automation rows: stable layout and autofilled skip editing

- **Badges get their own line.** The clear-rate text, Rec, and Best badges were injected inline next to the native "≥ N Edit" controls, so longer combinations made values wrap mid-number and rows jump to different heights — and in edit mode the −/+/input/Save buttons collided with the badges. All annotations now share one full-width line below the native controls in every row, so the value/buttons always have the whole first line to themselves.
- **Edit can autofill the recommended threshold.** With the new "Labyrinth: Autofill skip Edit input" setting enabled (off by default), clicking a row's Edit button fills the input with the row's recommended threshold from the last Recommend run (falling back to the current value when none exists), replacing whatever the input holds — run Recommend, click Edit, hit Save.

### Labyrinth recommendations survive setting edits and room switches

- Running Recommend and then touching any setting — including editing a skip threshold in the automation panel itself — no longer wipes every recommendation badge, and neither does the lab advancing rooms mid-run. The `setting_updated` / `loadouts_updated` / snapshot-update events fire constantly, and each unconditionally cleared minutes of recommendation work; invalidation is now fingerprint-based, clearing only when an input recommendations actually depend on changed: labyrinth loadout **assignments**, crate selections, or loadout **contents** (gear/enhancement levels).
- Cached combat sims also stop being wiped on setting changes — the cache key already includes loadout, room level, crates, and hours, so entries stay valid; only genuine loadout-content changes clear them.

### Lab Sim: per-skill targets and a meaningful all-fights metric

- **Targets button in the Lab Sim Upgrade tab** (both Combat Levels modes), matching Combat Sim: a per-skill target-level grid prefilled from current levels + the +Levels boost; while open, targets replace the uniform boost. In single-monster mode the grid hides skills the weapon style can't train; All Fights keeps every skill visible since assigned loadouts can differ in style.
- **All Fights now ranks by expected combat attempts instead of run-clear product.** The product of ten sub-50% win rates is astronomically small (≈0.0% for everyone), so it read as zero across the board. The labyrinth lets you retry failed rooms, so the new collective metric is Σ 1/win-rate — the expected number of combat attempts to clear every fight — with ΔAttempts (negative = better) as the ranking column. The per-fight breakdown also shows expected tries per fight (e.g. `4.2% → 6.5% | 23.8 → 15.4 tries`), which spotlights the fights actually costing you attempts.

### Lab Sim: "Combat Levels — All Fights" analysis across the whole labyrinth

- New upgrade mode that sims **every labyrinth combat room** — each monster with its **assigned labyrinth loadout** at its **skip-derived room level** (live room level while in a run) — once at current levels and once per +N combat level boost, then ranks the boosts by **whole-run impact**: the change in the chance to clear every fight in one run (product of all win rates).
- Results show Run Clear %, ΔRun Clear, and average per-fight Δwin; clicking a row expands the per-fight breakdown (monster, room level, loadout, baseline → boosted win rate).
- Candidates are the union of style-relevant skills across all assigned loadouts, so if one monster uses a ranged loadout and another melee, both Ranged and Melee rows appear. The regular per-monster Combat Levels mode in Lab Sim shares the same style filtering as Combat Sim (including Attack always showing).

### Combat Levels tab polish: no more squished controls, cleaner Main Time

- **Top controls no longer get cut off**: the Player, Mode, and Charm dropdowns previously inherited a flex style that let them shrink into slivers when the row got crowded; they now size to their content and the row wraps instead.
- **Main Time only tracks the weapon's offense skills** (attack/melee/ranged/magic from its style's XP map — e.g. Attack + Melee for a spear). Stamina/Intelligence/Defense appear in every style's XP split and were cluttering the column with "—" entries.
- Results table cells and headers no longer wrap mid-value ("Level Time", "+7.2K (+2.83%)" stay on one line); the Main Time column absorbs the remaining width.
- **The Targets grid hides style-irrelevant skills** (same filtering as the candidate rows), so a melee player no longer sees Ranged/Magic target inputs.

### Task protection highlight leaves the card's top edge clear

- The protected-task green highlight (and the orange reroll-cap highlight) now draws on the sides and bottom of the task card only, leaving the top edge unchanged so it no longer frames the card's header area. Drawn with inset edge shadows, so card layout is unaffected.

### Combat Levels mode only sims skills relevant to your weapon style

- Melee weapons no longer show Ranged/Magic rows, ranged weapons drop Melee/Magic, and magic weapons drop Melee/Ranged — Stamina, Intelligence, Attack, and Defense always remain (Attack trains under every style: directly with a spear, via the XP split otherwise). Unarmed counts as melee (the engine sims it as smash). Applies to both the Combat Sim and Lab Sim analyzers.

### Combat Levels mode: levels-first controls, charm tier dropdown, main-skill time

- **+Levels is the primary control**: the number input is always visible in Combat Levels mode and drives the simulated boost (and the Targets prefill) — it's no longer hidden behind a "Custom" charm option.
- **The Charm dropdown lists real charm tiers** found in game data (plus "Auto (equipped)" and "No charm") and picks which charm family gets swapped in per skill for the Level Time estimate: Auto matches the equipped charm's tier, a named tier forces that family (leveling Defense with "Expert" selected assumes an Expert Defense Charm), None estimates charm-less rates.
- **Main time option**: a checkbox adds a Main Time column showing how long the weapon's main training skill(s) — its primary training skill plus the combat style's XP skills, so a melee-only weapon tracks Melee while a spear tracks Attack and Melee — would take to reach their own targets while each other skill is being focused. Computed from the same charm-swapped XP-rate sim, so it costs no extra sim time; rows for a main skill itself show —.

### Combat Levels mode: per-skill charm swapping and target levels

- **Level Time now assumes the right charm**: for each skill, the XP-rate estimate runs a sim with the equivalent charm for that skill equipped (matched by tier from your current charm, e.g. Expert Melee Charm → Expert Defense Charm, keeping its enhancement level; highest available charm or none as fallback) — so leveling Defense no longer shows — just because your equipped melee charm redirects all XP. The tooltip names the charm each estimate assumes.
- **Per-skill target levels**: a Targets button (Combat Levels mode) opens a grid of desired levels per skill, prefilled from current levels + the charm boost. While open, targets replace the uniform boost — skills left blank or at/below current level are skipped.

### Combat Levels mode: relevant columns, charm selector, time-to-level

- Combat Levels results get their own table: Skill | **Level Time** | ΔDPS | ΔEXP/hr | ΔProfit/hr (all sortable), replacing the gold-per columns that don't apply to XP-cost upgrades. Deltas are color-coded with the best per column highlighted.
- **Level Time** estimates the grinding hours/days to actually earn those +N levels, using the baseline sim's per-skill XP rates at the selected zone and your real current skill XP. Skills that earn no XP with your current style show —.
- The Skip Back checkbox is replaced by a **Charm selector** in this mode: real charm items from game data (when they carry a detectable +level stat) or +3/+5/+8/+10 presets, plus Custom which reveals the number input.

### Combat Levels mode in the upgrade analyzers

- Combat Sim and Lab Sim gain a **Combat Levels** analysis mode: each combat skill (Stamina, Intelligence, Attack, Melee, Defense, Ranged, Magic) is simmed with a +N level boost — a simulated charm, N configurable, default +5 — and ranked by the resulting DPS/XP/profit (or lab win-rate) deltas, showing which skill is most effective to level next and in what order. Levels have no gold cost, so cost shows — and rankings default to raw improvement.

### Labyrinth tiles: reference-style previews with correct EXP and rich combat tooltips

- **Skilling preview matches the reference script**: separate Actions in 2m and Action Duration rows; "Efficiency for −1 Progress" and "Speed for +1 Action" requirement rows; Next Level / Efficiency Tier / Speed Tier Clear % rows; Token Expected and Skilling Box Expected labels.
- **EXP / Room and EXP / Hour are now correct**: room XP applies your experience multiplier (Wisdom buffs from gear/house/achievements/crates plus the labyrinth Experience upgrade) instead of showing base `roomLevel × 50`, and XP/hour amortizes the 1s room entry over expected runs per clear (reference formula).
- **Combat tiles get the full monster tooltip**: combat style, damage type, attack interval, cast speed, style accuracy/damage, max HP, evasion vs your style, armor/resistance vs your damage type — all at labyrinth-scaled values computed by the same engine that runs the sims — plus the monster's ability list at scaled levels, expected token/combat box, loadout, win rate, and a sim-derived Failure Reason (Insufficient Defense when deaths dominate, Insufficient Damage when fights time out).
- **Right-click a combat tile opens the Lab Sim panel** (hinted in the tooltip when Lab Sim is enabled).

### Labyrinth tiles: attempt counter and whole-tile hover previews

- The live header display appends the current attempt number: `[Clear 78.7% | 8 left | #12]`.
- Tile hover previews trigger from anywhere in the tile, not just the small corner badge, and combat tiles now use the rich preview panel (win rate, avg fight, loadout, expected token/box) instead of a plain browser tooltip. Cleared or reset tiles drop their tooltip bindings.

### Philo calculator: realistic acquisition costs

- **Bids are never used as acquisition cost anymore** — a bid is a buyer's offer, not a price you can buy at, and lowball bids (e.g. a 27M bid on a ~950M-to-craft refined crossbow) made rows absurdly profitable. Costs now use ask prices only.
- **Refined craft estimates include the base item**: crafting cost = base item (market ask → shop → production cost) + refinement materials, so refined boots price at their full ~190M make-cost instead of shards only. Bases with no resolvable price (skilling capes the player already owns) still contribute nothing, keeping cape rows stones-only as intended.
- Refined rows take the cheaper of the +0 ask and the craft estimate; low-enhancement listings remain a last resort.

### Philo calculator: game-matching drop percentages and self-return credit

- **Philo % and Return % now match the game's output panel**: they show the drop chances conditional on a successful transmute (e.g. 10% / 90% for refined capes) instead of being pre-multiplied by the success rate. The per-action math behind Acts/Philo and profit is unchanged.
- **Self-returns are credited in EV at the input's resolved cost** (replacement cost). Untradable inputs like refined capes previously contributed zero for the ~59%-per-action chance of returning your cape while the cost side charged a full cape every action, making cape profit wildly pessimistic. Tradable fodder self-returns are now valued at ask (replacement) instead of bid — cost and EV sides use the same price basis.

### Profit columns in coinify and decompose history

- Both viewers gain the same sortable, color-coded **Profit** column as transmute history: coins earned / recorded output value, minus consumed inputs (priced at the current buy price for the session's enhancement level), catalysts consumed (both trackers record catalyst usage), and the alchemy coin fee. Breakdown tooltip per session; included in CSV exports.

### Philo calculator: craft-cost pricing for untradable refined capes

- Refined capes are untradable, so market pricing can never resolve them. When no market price exists at any enhancement level, refined items are now priced at the market cost of the **refinement materials** (lab refinement stones) consumed by their upgrade action — the base cape you already own is excluded. Rows priced this way are marked with ⚒ next to the name.

### `4242286` — Philo calculator refined-cape pricing + transmute history profit

- **Philo Gamba calculator**: rows are no longer dropped when an item has no +0 ask listing — cost falls back to the bid price, and refined items additionally scan enhancement levels +1 to +5 for a listed price, so refined skilling capes with philosopher's stone drops appear despite thin markets.
- **Transmute history**: new sortable, color-coded Profit column (recorded output value − consumed inputs at current buy price − transmute coin fee) with a per-session breakdown tooltip; included in CSV export. Catalysts/teas are not tracked and are excluded.

### `0a8cebe` — Profit in loot log stats

- Loot log entries show a **Profit** line (drop revenue after 2% market tax minus consumed input costs, ask/bid) under Total Value and a **Daily Profit** extrapolation next to Daily Output.
- The expandable breakdown lists consumed inputs as negative rows.
- Gathering/combat entries (no inputs) show after-tax revenue; alchemy entries skip profit (inputs not resolvable from the action definition). Works for live and historical entries.

### `7b268d0` — Capes exempt from the refined +10 minimum

- The upgrade advisor no longer clamps refined **back-slot** acquisitions to +10 (capes are the one item type reasonably refined below +10).
- Equipped refined capes below +10 use the back-slot enhancement breakpoints (+3/+5/+7…) instead of the refined table that starts at +10.

### `096ea52` — Strongest-source buff stacking in the sim engine

- Models the game's updated rule: the **strongest source** of a buff applies regardless of cast order; when it expires, the next strongest still-active source takes over (its own strength and remaining duration).
- Same-strength reapplication refreshes in place; debuffs compare by magnitude; buff definitions are cloned on application so shared aura objects can't be cross-contaminated. Fury keeps its self-managed stacks. 8 new tests.

### `7dd493e` — Deep-dive fixes across all subsystems (104 verified findings)

Full audit of the codebase; every finding adversarially verified before fixing.

**Core framework & settings**

- `checkboxWithButton` settings (Simulate Scroll Effects) persist as booleans with a one-time migration — the panel showed the toggle off while the feature ran, and All Off/Restore could discard the saved state.
- Scroll simulator resets and reloads on character switch (previously served character A's scroll sets to character B and could overwrite B's saves).
- Feature registry always awaits initializers so async features without the `async` flag can't escape error handling or store a pending Promise as their teardown instance.
- XP-percentage feature listened on the wrong settings key — live toggle now works.
- Added `no-dupe-class-members` ESLint rule; it caught two shipped bugs: a duplicate `disable()` in quick-input-buttons that made teardown a no-op, and a duplicate `parsePrice()` in estimated-listing-age that lost K/M/B parsing.
- Deleted unreachable `src/main.js` bootstrap, the dead enhancement worker file, and the doubly-unreachable `migrateDisplayMode()` (the only writer of `actionBar_compactWidth`).

**Combat sim engine (accuracy)**

- Curse/weaken/enrage debuffs now expire (`addBuff` was called without a timestamp → they lasted forever).
- Party sims no longer compound shared buff objects across players (player 3 got ~3× the buff).
- The Promote effect actually initializes and swaps the promoted monster into the fight.
- Units that die to thorns/retaliation/parry stop auto-attacking.
- EventQueue `clear*` methods no longer skip events displaced by heap sifts (+ regression test).
- Labyrinth monster armor/resistances were scaled twice (defense-scaled then total-scaled) — high rooms sim correctly now.
- `maxWaveReached` reported 0 for failed dungeon runs (probed wave `#0` which never exists).
- Multi-worker result merge used nonexistent `hit` keys — attack breakdowns are complete.
- Deleted write-only drop tables and the unreachable `isWeakened` accuracy branch.

**Combat sim UI & upgrade advisor**

- Ability level-up costs computed from your current level, not level 0 (`levelExperienceTable` was missing from the game-data payload) — ability upgrades rank correctly in gold-per-improvement.
- Lab Sim simulates the self player, not party slot 0; deaths read for the simmed player.
- Seek/Simulate elapsed timer can't leak; concurrent runs blocked.
- Cross-slot upgrades (main+off ↔ two-hand) credit resale of all removed items.
- Skilling upgrade analysis yields to the UI — Stop button and progress bar work.
- History metrics cached per player tab (no more cross-player deltas).
- Lab sim sort listeners no longer accumulate per Analyze run.
- Multi-player import accepts exports whose slot 1 is empty.
- Deleted unused `runAllLabyrinths`/`getLabyrinthCrates` exports; `.then()` → async/await.

**Labyrinth & combat tracking**

- Dungeon tracker: phantom 0ms "validated" runs no longer saved; stale in-progress runs (>10 min) not restored on page load; hibernation label now reaches the UI; deleted a dead query API that could never match.
- Dungeon tracker UI: the 1 Hz tick no longer re-reads IndexedDB and rebuilds the run list/filter dropdown every second — heavy rebuilds are event-driven.
- Labyrinth clear rate: what-if metrics include gathering/gourmet buffs (skillId was dropped); combat sim cache invalidates when loadout snapshots change.
- Scroll simulator UI: scroll config saves to the loadout selected at click time, not injection time.
- Milkonomy export of other players uses their achievements, not yours.
- Combat summary rows render independently; zero durations can't produce Infinity/hour.

**Calculations & action panels**

- One-sided book/material markets no longer costed at half price (null-vs-`-1` sentinel bug) in ability book and house build costs.
- Drink Concentration divides drink duration instead of multiplying (drinks-remaining estimates were up to ~69% high).
- Scroll-simulation arming is exception-safe — early returns (e.g. untradable tailoring outputs) left phantom scroll buffs inflating action-time/tea/max-produceable/task-profit numbers app-wide.
- Profit-panel input listeners no longer accumulate per refresh; same for tea-recommendation drag handlers, enhancing-panel inputs, missing-materials watchers.
- Loot log stats refresh as ongoing logs grow (premature processed-guard removed); history entries update by `characterActionId`.
- Pinned actions page tears down fully on nav-away; output-totals prunes detached panels; `.then()` chains converted.

**Market features**

- CSV import understands its own export's Status column (re-imports were column-shifted/corrupted).
- Single re-syncing writer for `marketListingTimestamps` — deleted listings stop resurrecting.
- History viewer `disable()` disconnects its observer and removes the injected tab; import failures clear the progress overlay; date filters use local midnight.
- Listing price display: per-table observers pruned; sort reset can't inject stale detached rows.
- Consumable tooltips re-process when MUI reuses a popper for a different item.
- Expired-listing detection matches item identity and active status; dead diverged copy deleted.
- Philo calculator: Escape listener lifecycle fixed; explicit +0 Drink Concentration preserved.
- Marketplace shortcuts dropdown no longer leaks a document listener per open; removed a double percent sign in EV breakdowns; market price patches write debounced instead of per-WS-message.

**Alchemy, enhancement, house, skilling**

- History viewer row-deletes reload fresh sessions first (deleting a row could destroy sessions saved while the modal was open) — coinify, transmute, decompose.
- Input Item columns sort correctly; date filters parse local midnight.
- Alchemy panel per-panel observers/listeners torn down per panel, not only on disable; config popup backdrop removed on close.
- Five body-wide MutationObservers bail out early unless a tablist actually changed.
- Enhancement UI settings listeners actually unregister; dead session-resume path deleted; transmute tracker stops persisting empty sessions.
- House cost display updates can't interleave/duplicate; house modal observer no longer accumulates per open.

**Inventory, tasks, networth, guild**

- Stuck `isRendering`/`isCalculating` guard flags can't wedge the UI (try/finally + wait-loop deadline + empty-reduce guards).
- Custom tabs enhancement-swaps don't duplicate items.
- Task materials badge tracks live progress; task profit `disable()` clears pending timers.
- Networth parallel worker split respects bid pricing mode (no more UI freeze/ask substitution in bid mode).
- Networth chart moving average measures actual time, not data points; guild XP outlier cutoff uses the true median.
- Task reroll popup removes its backdrop; stack-price badges clear immediately when toggled off.

**Chat, profile, settings UI, misc**

- Crafting plan observers disconnect on disable (UI stopped resurrecting itself).
- Alchemy item dimming only dims the real Alchemize selector, not catalyst/guild menus.
- Queue monitor per-action countdowns consume elapsed time sequentially through the queue.
- Alt+click navigation ignores stale closed-tooltip items.
- Combat score export feedback colors render (quoted template literals fixed, 9×); same for ability book calculator error color.
- Chat commands register one character-switch listener total; chat history extender evicts only off-screen handlers.
- Settings: custom price override of 0 is preserved; character sheet equipment parses real `/item_locations/` hrids; XP tracker guards zero time deltas.

**Shared utils**

- One drink-concentration implementation (deleted diverged duplicate); deleted abandoned `calculateTaskTokenValue` stub and unused `setupAltClickNavigation`; enhancement bonus table deduplicated via shared `ENHANCEMENT_BONUSES`.

### `bfb3eb0` — Labyrinth bar placement, duplicate Logs button, loadout tab sync

- Removed the duplicate Logs button from the labyrinth tab bar (the calculate bar already has one).
- Calculate bar docks correctly when the game's Upgrade button shares the Entries/Max Path row (marker detection reads own text nodes, not only leaf nodes).
- Custom-tab loadout sync keeps items still referenced by another loadout bound to the same tab when a loadout replaces an item or changes enhancement level; no duplicate entries. New test suite.

## Merged to main — PR [#1](https://github.com/Millennium44/Toolasha/pull/1) (`05c7a9f`, 2026-07-28)

### `1d6b014` — Combat trigger editor in the sim loadout editor

- ⚡ button on every ability/food/drink row opens a trigger editor: add (up to 4), remove, or reset to game defaults; dependency/condition/comparator/value fields with condition lists filtered to what the dependency supports. Custom triggers highlighted with summary tooltips; trigger edits appear in sim labels.

### `fcaaeb9` — Ability swap mode in Lab Sim upgrade analyzer

- Lab Sim's upgrade Mode dropdown gains Ability Swaps (engine support already existed).

### `6e6d222` — Keep ability triggers when simming ability level upgrades

- Upgrade analysis preserves your configured combat triggers when leveling an equipped ability instead of resetting to defaults — fixes ability level upgrades wrongly simming as negative.

### `b901f5c` — Retry labyrinth combat tile sims that run before data is ready

- Initial auto-calc no longer shows 0% on combat tiles: failed/0% sims aren't cached and auto-retry up to 3 times while loadout snapshots load.

### `276a785` — Skip-level room levels, bump-to-improvement, collapsed loadouts

- Lab Sim skilling: "Use Skip Levels" calculates per-skill clear rates at each skill's automation skip level; upgrade candidates bump +1 level until an improvement shows; Skill Loadouts default collapsed.

### `54419d1` — Read labyrinth grid from React state so calc bar shows on load

- The calculate bar and auto-calc work immediately after refresh by reading `characterLabyrinth` from React fiber state instead of waiting for the first room completion.

### `d4e3b6b` — Lab sim ability upgrades; calc bar and auto-calc on load

- Ability Levels (and combined) modes in Lab Sim's upgrade analyzer; calc bar injected on labyrinth panel load; auto-calc recalculates whenever rooms are visible.

### `60c4de9` — Calc bar top-left; clear badges on cleared rooms

- Calculate bar docks in the Entries/Max Path row like the reference script; badges are pruned from cleared rooms (with a delayed re-sweep).

### `a10368f` — Sim Hours instead of trials

- Labyrinth tile controls use a Sim Hours input (1–100, default 3) wired to the `labyrinthRecommendSimHours` setting.

### `dc9be56` — Price enhanced tier targets like enhancement candidates

- Tier upgrades to enhanced items use the market ask at that level or base price + enhancement cost — no more 0-cost refined rows.

### `2881cd1` — Restyle labyrinth tile controls and badges

- Compact corner badges with 5-tier solid colors and plain-seconds ETA; dark control bar with blue Calculate button and green progress track, matching the reference script's look.

### `7e56eec` — Refined upgrade costs, sortable results, auto tile calc

- Refined items priced correctly in the advisor; upgrade results table sortable by every column; optional auto-calculation of newly revealed lab tiles (off by default).

### `a29afc0` — Per-tile clear chance overlays

- Calculate button computes and overlays clear chance + ETA badges on every uncleared labyrinth tile (skilling, enhancing, and combat via sim).

### `8eb8e5f` — Labyrinth what-if previews, max floor, room logs

- Rich hover previews on lab tiles: next-level/efficiency-tier/speed-tier/upgrade what-ifs and XP/hour; max-floor display; new Labyrinth Room Logs feature recording per-action outcomes with a draggable panel (ported from dakonglong's MIT-licensed Labyrinth Clear Rate Calculator, loan scroll excluded).

### `078b0fe` — Keep labyrinth live clear chance visible between actions

- Live display stale-timeout scales with action time (no more flicker); percent-scale chances normalized.

### `420a08d` — Refined +10 clamp, combined upgrade view, compact-width guard

- Refined recommendations clamp to +10 instead of being dropped; Combat Sim gains the Equipment + Abilities combined mode; guard against `actionBar_compactWidth` being enabled unexpectedly at load.

### `2eec924` — Second round of runtime fixes from code review

- Marketplace navigation fallbacks, tooltip and observer fixes, and other runtime corrections from the initial audit.

### `a7d53ad` — Skip refined equipment recommendations below +10

- First pass of the refined-equipment gating in the upgrade advisor (later refined to the +10 clamp).

### `85d14ea` — Crash guards, wrong-result bugs, and teardown fixes

- Broad fixes from the initial audit: crash guards on missing data, wrong-result calculation bugs, HTML escaping (XSS) in dungeon tracker history and combat score, blob URL lifetime in pop-out chat, initialization guards, and feature teardown.

### `a703f0c` — Feature cleanup teardown and settings accessors

- Feature registry wires `disable`/`cleanup` teardown with instance capture; `config.getSetting`/`setSetting` handle checkbox vs value settings correctly; `characterSettingsLoaded` flag; new config/settings-storage test suites.

---

## Upstream Changelog

## [2.102.0](https://github.com/Millennium44/Toolasha/compare/v2.101.0...v2.102.0) (2026-08-13)

### Features

- **settings:** copy first-run settings from another character, recoverably ([5281e30](https://github.com/Millennium44/Toolasha/commit/5281e30f80db7a423298e8b31bc55071cadcee28))
- **settings:** defaults-first welcome, a no-change option, safe dismissal ([f189596](https://github.com/Millennium44/Toolasha/commit/f189596e1df3829a0c4b60b5e70a085f30dcc9b0))

## [2.101.0](https://github.com/Millennium44/Toolasha/compare/v2.100.0...v2.101.0) (2026-08-13)

### Features

- gate 8/13 marketplace-patch behaviour to the test server ([f77edfd](https://github.com/Millennium44/Toolasha/commit/f77edfdb46735db077b141eb7f65066263e780c7))
- net-worth value-source setting (order book vs game's market value) ([7878930](https://github.com/Millennium44/Toolasha/commit/78789301489c6fee72cada4e31639269092b8787))
- **profile:** count shrine levels in gear score and combat sim ([93a0fad](https://github.com/Millennium44/Toolasha/commit/93a0fadb884c1307fa3570cc95b110e348167338))
- reconcile prices against the game's official market values ([59761e8](https://github.com/Millennium44/Toolasha/commit/59761e8df0b55c9e2ab60011069b81a506e655b2))

### Bug Fixes

- **market:** raise marketplace tax 2% → 5% (8/13/2026 game update) ([3ed9c3b](https://github.com/Millennium44/Toolasha/commit/3ed9c3be598cb42859b0ddf10ae85fe96cd00a79))
- **market:** restore marketplace autofill after typable-input update ([5fbd912](https://github.com/Millennium44/Toolasha/commit/5fbd91285f7f2a9dda06493817d416a9cfe4940b))

## [2.100.0](https://github.com/Millennium44/Toolasha/compare/v2.99.0...v2.100.0) (2026-08-13)

### Features

- **enhancement:** cost-vs-expected (luck) and worth-it lines in the tracker ([53f126e](https://github.com/Millennium44/Toolasha/commit/53f126ea62aa38a79a5ba29f718eb8dcf10f3ada))
- **enhancement:** expandable worth-it breakdown + command-palette toggle ([b563071](https://github.com/Millennium44/Toolasha/commit/b5630710b619c00081554dc3061c6b7c0e5fc53a))
- **enhancement:** idle-duration fix, session merge, on-screen toggle ([62a1430](https://github.com/Millennium44/Toolasha/commit/62a1430e9cfb3509a0d1fbaf7bb5b7aa401b6a87))
- **loot-log:** enhancing cost, luck and profit summary (opt-in) ([a5fa8fa](https://github.com/Millennium44/Toolasha/commit/a5fa8fabba84db1d2130d73d939202ee551ec342))
- **loot-log:** merge split enhancing runs + larger summary text ([230c0f3](https://github.com/Millennium44/Toolasha/commit/230c0f389cde5236a0d1579f5eecb2be9468782b))
- **notifications:** notify when a labyrinth entry regenerates (opt-in) ([3b3332c](https://github.com/Millennium44/Toolasha/commit/3b3332c095a61e825db0c7ca7ed6b1ffd2099738))

### Bug Fixes

- **loot-log:** price enhancing materials like the tracker does ([2afc626](https://github.com/Millennium44/Toolasha/commit/2afc6268690c00c766c29ab7216974fb88e789c6))

## [2.99.0](https://github.com/Millennium44/Toolasha/compare/v2.98.0...v2.99.0) (2026-08-13)

### Features

- **ui:** minimize any panel; remember Combat/Lab upgrade results (opt-in) ([79b05ee](https://github.com/Millennium44/Toolasha/commit/79b05ee969d816cc430880baea5a863737e894d1))

### Bug Fixes

- **ui:** default sims to Score sort, fix minimize placement, clickable quiet members ([9b88c54](https://github.com/Millennium44/Toolasha/commit/9b88c5447c169d2f7b881a88dbac02a72791729d))

## [2.98.0](https://github.com/Millennium44/Toolasha/compare/v2.97.0...v2.98.0) (2026-08-13)

### Features

- **combat-sim:** add a target button to each Results row ([8072c70](https://github.com/Millennium44/Toolasha/commit/8072c704b2a4205f060d5f82be6f81f4ed4b2d43))
- **combat-sim:** make the guide swap option aura-only instead of aura+signature ([7b4a6eb](https://github.com/Millennium44/Toolasha/commit/7b4a6eb24a2bb767949b2330b4cb707f74d3c5ef))
- **combat-sim:** sim proposed path boots at +7, not the worn level ([a5336c9](https://github.com/Millennium44/Toolasha/commit/a5336c9e8d72446114760899fe46bfa65d290d34))
- **enhancement:** make the pro/yours source toggle discoverable and mobile-friendly ([aa365e6](https://github.com/Millennium44/Toolasha/commit/aa365e698c41e2f8e380eeb74a1ffa3c71a1cc92))
- **enhancement:** route any item from the XP/hr panel, even unowned ([a764b85](https://github.com/Millennium44/Toolasha/commit/a764b853705b71b94b7c1e23763794131cbeaeb4))
- **sim:** offer refined path boots as upgrade candidates at +7 ([01c81ae](https://github.com/Millennium44/Toolasha/commit/01c81ae5ec7525f6a381f99568e37c66f9aec6af))
- **sim:** viewed-level ability fresh-cost, default score sort, path-boot swap test ([dc47759](https://github.com/Millennium44/Toolasha/commit/dc47759f6177e968ce34569a9f276fcdb6198441))
- **tooltips:** show fresh-to-level cost when hovering an ability itself ([bcd99b2](https://github.com/Millennium44/Toolasha/commit/bcd99b2ebd1b2f46a4227a20144ae724e4126dda))

### Bug Fixes

- **combat-sim:** offer the aura group's OR-alternative in Ability Swaps ([9614959](https://github.com/Millennium44/Toolasha/commit/961495996346abcde22ff18f0a353153a1801631))
- **tooltips:** detect the ability tooltip by name, not a sprite ([166e2b1](https://github.com/Millennium44/Toolasha/commit/166e2b1b2a17c6167d4cf93fafeaf142933ec5e7))

### Build System

- allowlist stateless loadout-scraper across the market bundle ([ef779a0](https://github.com/Millennium44/Toolasha/commit/ef779a0ce6031fc4fac7c3f5e45c454320a05661))

## [2.97.0](https://github.com/Millennium44/Toolasha/compare/v2.96.5...v2.97.0) (2026-08-12)

### Features

- **combat-sim:** add an Achievements section to toggle achievement combat buffs ([d9c184f](https://github.com/Millennium44/Toolasha/commit/d9c184f7c5010745ea3dce01a258bcc564bbe733))

### Bug Fixes

- **combat-sim:** restore the loadout picker in packaged builds ([d804c7a](https://github.com/Millennium44/Toolasha/commit/d804c7a059d82893b11ebef5d44846e789151588))

## [2.96.5](https://github.com/Millennium44/Toolasha/compare/v2.96.4...v2.96.5) (2026-08-12)

### Build System

- **userscript:** expand and tidy the author credit ([791f0ea](https://github.com/Millennium44/Toolasha/commit/791f0ea63cec53a47b8858c91ae2a0dd96f43659))
- **userscript:** expand and tidy the author credit ([03471d6](https://github.com/Millennium44/Toolasha/commit/03471d67a0b76d5bc52090a0e1c59adf4b38af5a))

## [2.96.4](https://github.com/Millennium44/Toolasha/compare/v2.96.3...v2.96.4) (2026-08-12)

### Build System

- **userscript:** lead the production author credit with Millennium44 ([d23f95f](https://github.com/Millennium44/Toolasha/commit/d23f95f8d51e923907981a3b7237b8e8eec3b3fb))
- **userscript:** lead the production author credit with Millennium44 ([21ad429](https://github.com/Millennium44/Toolasha/commit/21ad429f6a33da4108be680af4eea7907a1f2786))

## [2.96.3](https://github.com/Millennium44/Toolasha/compare/v2.96.2...v2.96.3) (2026-08-12)

### Build System

- **userscript:** lead the author credit with Millennium44 ([353ab06](https://github.com/Millennium44/Toolasha/commit/353ab064ddc6b48d1e928a505a42b5bc7836b88f))
- **userscript:** lead the author credit with Millennium44 ([ab57edc](https://github.com/Millennium44/Toolasha/commit/ab57edca0d5229c24fe6fc44a28f6db089139ede))

## [2.96.2](https://github.com/Millennium44/Toolasha/compare/v2.96.1...v2.96.2) (2026-08-12)

### Bug Fixes

- **settings:** remove stale experimental warning from task reroll tracker ([ec2060e](https://github.com/Millennium44/Toolasha/commit/ec2060ece0835914f6ead52d61673664bea8e069))
- **settings:** remove the stale experimental warning from the task reroll tracker ([1ad3296](https://github.com/Millennium44/Toolasha/commit/1ad329624a544d3cb2e71d5e2f68087b74c24197))

### Documentation

- **changelog:** condense fork changelog entries and require short ones ([cacf261](https://github.com/Millennium44/Toolasha/commit/cacf2617c304eeb7c4cc3c9a0a49d9822545cb54))

## [2.96.1](https://github.com/Millennium44/Toolasha/compare/v2.96.0...v2.96.1) (2026-08-12)

### Bug Fixes

- **market:** show a fresh undercut in My Listings without opening the item ([bae2de2](https://github.com/Millennium44/Toolasha/commit/bae2de26ffb5fd0279fce281299873b9777ee90d))
- **market:** show a fresh undercut in My Listings without opening the item ([732c5ea](https://github.com/Millennium44/Toolasha/commit/732c5eae72f19851aecf7384c245e73ede5dc49e))

## [2.96.0](https://github.com/Millennium44/Toolasha/compare/v2.95.1...v2.96.0) (2026-08-12)

### Features

- **labyrinth:** embed the replay comparison in the exported recording ([43d2dc7](https://github.com/Millennium44/Toolasha/commit/43d2dc7f06b86e1e350500df748300636190ec9b))
- **labyrinth:** fight recorder and calibration replay ([72c7924](https://github.com/Millennium44/Toolasha/commit/72c79249b936a15e9a897da2041df4c429663cf1))
- **labyrinth:** full-ability sim calibration setting, tooltip clear-time, panel bar polish ([d76926c](https://github.com/Millennium44/Toolasha/commit/d76926cd2100d74f71e2aec2814acbb967c86899))
- **labyrinth:** passive, persistent, gear-pooled fight recorder ([c47fbe5](https://github.com/Millennium44/Toolasha/commit/c47fbe5a1984f616e9d2b466f980f28848297d4a))
- **labyrinth:** raw tick capture as a Capture button ([91297b6](https://github.com/Millennium44/Toolasha/commit/91297b63e6fd6864e290c3a658731b535602b132))
- **labyrinth:** recompute button, server-count reconciliation, scroll preservation ([efeca69](https://github.com/Millennium44/Toolasha/commit/efeca6941a68bedc4fa109edc8a76d7a10ab5e05))
- **labyrinth:** self-label captures, drop partial-HP fights from replay ([98f0e0d](https://github.com/Millennium44/Toolasha/commit/98f0e0d8370f89de4810b04dea17ae1a6d0380d5))
- **market:** add "Check Mooket price" button to the marketplace item view ([a1cb04f](https://github.com/Millennium44/Toolasha/commit/a1cb04f56d750123e0e2699157d997b84baf7ef7))
- **market:** add mooket I as a selectable price-history source ([750b4fa](https://github.com/Millennium44/Toolasha/commit/750b4fad78f3e1bb9505fec188a32ab3896330ff))
- **market:** contribute order books to the selected mooket source ([c0ddf36](https://github.com/Millennium44/Toolasha/commit/c0ddf360e293609ea4316615a038db8bfca02feb))
- **market:** refresh My Listings Top Order Price on market-data updates ([bf9fb16](https://github.com/Millennium44/Toolasha/commit/bf9fb16ba6160fea41406572653d45a18dfb3a6d))
- **market:** replace item-view Mooket check with a My Listings bulk price refresh ([2bfc00c](https://github.com/Millennium44/Toolasha/commit/2bfc00c1f4e18460797d647e5c5d9f75a6b6e5da))
- **notifications:** back undercut alerts with fresh Mooket sightings ([a887f3f](https://github.com/Millennium44/Toolasha/commit/a887f3fdb6d7c4c7e18770564778c13f14fc1eea))

### Bug Fixes

- **labyrinth:** diagnose over-modelled monster damage, not just under ([1bc4711](https://github.com/Millennium44/Toolasha/commit/1bc471197fd63d7bb209ad737cb992c24ddf6242))
- **labyrinth:** measure observed damage gross, not net of regen ([4e84338](https://github.com/Millennium44/Toolasha/commit/4e843382c804129f1e582c483bbe3455132c829f))
- **labyrinth:** stop counting un-fought rooms as clears; add uncapped sim option ([144480e](https://github.com/Millennium44/Toolasha/commit/144480e2e7e2ccd1292f62cc54d862277a2090c2))
- **labyrinth:** stop self-healing monsters splitting one fight into many ([26138eb](https://github.com/Millennium44/Toolasha/commit/26138ebede9ad74b68c938655374c9930f37859e))

### Documentation

- **changelog:** apply prettier markdown formatting ([d710633](https://github.com/Millennium44/Toolasha/commit/d7106338ccf4b518482e030e27b6a27a93a1a7c0))

## [2.95.1](https://github.com/Millennium44/Toolasha/compare/v2.95.0...v2.95.1) (2026-08-11)

### Bug Fixes

- **actions:** disconnect the action-name observer before replacing it ([3c5d45e](https://github.com/Millennium44/Toolasha/commit/3c5d45e8807f37420f510e38576b67a992915275))
- **core:** port upstream character-switch and settings-cache fixes ([01e072e](https://github.com/Millennium44/Toolasha/commit/01e072e11553237b3947b77c63a6ec3800f9d820))
- **custom-tabs:** dedupe enhanced tiles in the Unorganized bucket ([497d553](https://github.com/Millennium44/Toolasha/commit/497d553e40a378f10656713944aa513f4b643fff))
- port upstream null-price guards and Custom Tabs button self-heal ([ab193ba](https://github.com/Millennium44/Toolasha/commit/ab193ba14a38dfe090f7d190ba1647eee6da587b))

### Documentation

- **changelog:** condense the new-session fork entries ([c3cdfeb](https://github.com/Millennium44/Toolasha/commit/c3cdfeb23e336571a2219ab138c7459c4f75752e))
- **changelog:** condense the new-session fork entries to one or two lines each ([f4ffc8d](https://github.com/Millennium44/Toolasha/commit/f4ffc8d55ccd48d61113e69aafe98d77dabc4b93))

## [2.95.0](https://github.com/Millennium44/Toolasha/compare/v2.94.0...v2.95.0) (2026-08-11)

### Features

- **tasks:** let a manual Sort Tasks press sort even with a reroll menu open ([82f8926](https://github.com/Millennium44/Toolasha/commit/82f89264f699fcac1f30d7b7f80faac29817723e))
- **tasks:** remove the bulk-reroll button ([dd52fc9](https://github.com/Millennium44/Toolasha/commit/dd52fc950aaeffdd9bb2a0045cd02b435fa5e408))
- **ws:** capture the game socket and log outgoing frames to replay a reroll ([714ba66](https://github.com/Millennium44/Toolasha/commit/714ba666a9c30ea16eb93b5c374ea0f7fa8ba711))

### Bug Fixes

- **tasks:** bulk reroll presses the menu instead of just opening it ([ecc16e0](https://github.com/Millennium44/Toolasha/commit/ecc16e09427f3aeba4bfb9969f4a06c00be31841))
- **tasks:** draw the protected task border synchronously when a card appears ([4cd7f29](https://github.com/Millennium44/Toolasha/commit/4cd7f29d0b3ecbc04307b42e5b053a56440c14f8))
- **tasks:** open the reroll chooser with a dispatched event so it works without a manual press ([ed02fcb](https://github.com/Millennium44/Toolasha/commit/ed02fcb7b465663f29cdcd1da559f3af9c1a414d))
- **tasks:** read the reroll chooser off the whole card so paid options are found ([9cbda23](https://github.com/Millennium44/Toolasha/commit/9cbda23650d5191324b8028957aefc68fc25d405))
- **tasks:** settle a just-opened reroll chooser, and silence the worker math.js source-map error ([d0dbebc](https://github.com/Millennium44/Toolasha/commit/d0dbebca15d4952fb1397a379e80297a59096cd0))
- **tasks:** update the protected border on a mid-flow card, and drop the diagnostics ([6f7afd3](https://github.com/Millennium44/Toolasha/commit/6f7afd3bba493d45a9b6148d7c1dea4fdc6736c8))

### Miscellaneous Chores

- **tasks:** temporary protection-repaint diagnostics ([2184bdc](https://github.com/Millennium44/Toolasha/commit/2184bdc86e9c585b7cb2cac296ffaa43542c4a9c))

## [2.94.0](https://github.com/Millennium44/Toolasha/compare/v2.93.0...v2.94.0) (2026-08-10)

### Features

- **combat-sim:** carry Labyrinth scrolls in the sim and upgrade advisor ([ae12aba](https://github.com/Millennium44/Toolasha/commit/ae12aba7d92a5fd69d80675757a886845c29bf98))
- **trials:** drop the flat tier projection once slowing is known; timestamp skilling readings ([1e005a3](https://github.com/Millennium44/Toolasha/commit/1e005a34a7b95b5a12507e1d8bb964b6405bc9ed))
- **trials:** trim the In Progress payout, add a Roster button, and finish the layout escape ([0b761e8](https://github.com/Millennium44/Toolasha/commit/0b761e83cd8a168fcbae26132ef5cf36b9806d75))

### Bug Fixes

- **combat-sim:** use the real combat scroll set, read from tooltips not the seal table ([e94f1bc](https://github.com/Millennium44/Toolasha/commit/e94f1bcfb775577e7de9d38c54ae6bedc67c19c9))
- **trials:** label damage-taken pre/post-mitigation and flag over-attributed splits ([c080a62](https://github.com/Millennium44/Toolasha/commit/c080a622b698fcd26edca59af3fc0d155e77f0b6))
- **trials:** stop injected blocks squashing the skilling In Progress card ([ee2bf2d](https://github.com/Millennium44/Toolasha/commit/ee2bf2d3ab939bc81472bbece5644b3495b89ec4))

### Build System

- **dev:** stamp the dev userscript version so a reinstall always takes ([eadad1a](https://github.com/Millennium44/Toolasha/commit/eadad1abf4fb09bca97bf93496e898c776ee23f4))

## [2.93.0](https://github.com/Millennium44/Toolasha/compare/v2.92.1...v2.93.0) (2026-08-07)

### Features

- **trials:** credit partial-tier progress in the pace projection (test server only) ([2b83326](https://github.com/Millennium44/Toolasha/commit/2b833268e7e3d510de46105ab8c3910ea743f62b))
- **trials:** prefer the game's post-trial stats in the per-player scoreboard ([2958221](https://github.com/Millennium44/Toolasha/commit/2958221fa95b534cf994fd3140a3c1dd1ed40637))
- **trials:** scrape the post-trial Combat Trial Stats modal (test server) ([7c43dea](https://github.com/Millennium44/Toolasha/commit/7c43dea185247ef93c6c7de822ccafa38493942e))
- **trials:** stand a tile in for a composite fight so Trial Swarm shows on In Progress ([92e30e3](https://github.com/Millennium44/Toolasha/commit/92e30e350bc3dc50ec9a5d0401b6d61f93f50f94))

### Bug Fixes

- **market:** harden marketplace parsing and selectors for the market rework ([e129feb](https://github.com/Millennium44/Toolasha/commit/e129feb09a2cbed62d28c62617f327853d4c63c7))
- **notifications:** stop undercut alerts forcing market fetches; surface rate-limits ([7a7b8b9](https://github.com/Millennium44/Toolasha/commit/7a7b8b9f2ced7c50813427920f9d181206ab5a0e))
- **trials:** read partial-tier card figures as valid, not a ladder disagreement (test server) ([28b6c74](https://github.com/Millennium44/Toolasha/commit/28b6c7484579b98bec9e595aa65b040be9ce90d1))
- **trials:** resolve composite-trial encounters so Trial Swarm anchors its tier ([cf90680](https://github.com/Millennium44/Toolasha/commit/cf906800d5899f4c2a04911bb3b37afe23056b8b))

### Code Refactoring

- **trials:** make the stats-modal scraper header-driven (combat + skilling) ([a4590ca](https://github.com/Millennium44/Toolasha/commit/a4590ca46a935976374d0e696b29720be4933799))

## [2.92.1](https://github.com/Millennium44/Toolasha/compare/v2.92.0...v2.92.1) (2026-08-07)

### Bug Fixes

- **bundles:** read expected-value calc and scroll sim through the bridge ([aa679dc](https://github.com/Millennium44/Toolasha/commit/aa679dcfa15d3cce06eab8cdf413a2733b89a8c1))
- **bundles:** route remaining cross-bundle singleton reads via the bridge ([f874955](https://github.com/Millennium44/Toolasha/commit/f8749555e553e98ebd7b8d632b230efd479bf17f))
- **bundles:** share action-panel sort/pin singleton via the bridge ([382a1b1](https://github.com/Millennium44/Toolasha/commit/382a1b1161e74bdd2f15064ab7ec9cf2b052ef17))
- **bundles:** share custom-price-overrides as one Toolasha.Utils global ([435c06d](https://github.com/Millennium44/Toolasha/commit/435c06d3c7648fd02cec7e286bf6a72390894b1e))
- **loadout:** read the shared loadout store via the bridge in net worth, profit, and bulk-sell ([71f6891](https://github.com/Millennium44/Toolasha/commit/71f6891ff9058152904e8fd5fe416f40c9042097))
- **settings:** open the real treasure ledger via the bundle bridge in packaged builds ([4071fce](https://github.com/Millennium44/Toolasha/commit/4071fceb54b74aeae6674a717604ecef8a5806d4))

### Documentation

- **changelog:** correct the loadout fix description ([8bf8cea](https://github.com/Millennium44/Toolasha/commit/8bf8cea5e7a92b19e2f3559be92d93b4cb9a8b23))

## [2.92.0](https://github.com/Millennium44/Toolasha/compare/v2.91.0...v2.92.0) (2026-08-07)

### Features

- **dev:** on-demand health report via Toolasha.debug.health() and a Ctrl+K command ([578484c](https://github.com/Millennium44/Toolasha/commit/578484c9b244c61e3fd886038cdde8a3152565af))
- **settings:** render the what's-new popup cleanly + add a newcomer overview ([f020db1](https://github.com/Millennium44/Toolasha/commit/f020db10b8f8419077f266e7832e7bc01dc8441f))

### Bug Fixes

- **combat-sim:** reach the shared loadout store via the bridge so packaged builds sim real gear ([62519c8](https://github.com/Millennium44/Toolasha/commit/62519c8c64550a423b946555526d84a19cafaed5))

## [2.91.0](https://github.com/Millennium44/Toolasha/compare/v2.90.0...v2.91.0) (2026-08-06)

### Features

- **combat-sim:** per-shrine Targets grid on the Guild Shrine upgrade ([f78ffdb](https://github.com/Millennium44/Toolasha/commit/f78ffdbf9d519dddaba9d707c6c1df3786849eaa))
- **labyrinth:** break equal-route ties toward revealing the most unknown rooms ([a55635e](https://github.com/Millennium44/Toolasha/commit/a55635ee2f2c3d134f71aa0dff7656e2b4c8afcc))
- **notifications:** active market-snapshot refresh so undercut alerts see current prices ([6592962](https://github.com/Millennium44/Toolasha/commit/659296225ceabb398ddf23458e11cac2bfa97a66))
- **settings:** default the seven Portrait DPS sub-readouts to off ([aaf715e](https://github.com/Millennium44/Toolasha/commit/aaf715ec64b23978b63576305d3c4dba8e3c67f7))
- **settings:** offer "Keep my current settings" to returning users at first run ([53615e5](https://github.com/Millennium44/Toolasha/commit/53615e58d0ac2f80ea9a6e046c0be681016434f9))
- **settings:** rename the "Everything on" preset to "Defaults" ([7447536](https://github.com/Millennium44/Toolasha/commit/744753677cc5a33287aa8e37e0ca21366d23adef))
- **settings:** safer defaults for new-settings-off and market dimming ([f694ac3](https://github.com/Millennium44/Toolasha/commit/f694ac319dbfc6597642eceb6d50ba36ab1847aa))

### Bug Fixes

- **canary:** stop the skill-action-name canary false-alarming on alchemy/enhancing panels ([749003e](https://github.com/Millennium44/Toolasha/commit/749003e5af4691da8019cd90915496bd3bfa4b74))
- **chat:** stop turning the guild-wide broadcast subject "Guild" into a /profile link ([bc35dea](https://github.com/Millennium44/Toolasha/commit/bc35deab55325a449cc56a80ba7c425fe3dded13))
- **combat-panels:** profit panel leads with the live rate, sim forecast to the foot ([6805486](https://github.com/Millennium44/Toolasha/commit/68054869b6c39c3af3f52d7d701ec3744c4579e6))
- **guild:** bank damage by name at wave boundaries; guild-scope loadout sightings ([212f496](https://github.com/Millennium44/Toolasha/commit/212f4968346ac862661d3d49622431f66232da3a))
- **guild:** battle units found via MiniUnit boxes; battle info split from the profile walk ([04019ef](https://github.com/Millennium44/Toolasha/commit/04019ef0e1dc4258100d8404b790c8f6e60cd4e3))
- **guild:** battle-unit clicker matches real CombatUnit boxes, not its own panel ([e745f9e](https://github.com/Millennium44/Toolasha/commit/e745f9e1d972f79c681486ebf3bf7d99b0946edb))
- **guild:** forecast ladder anchors on the live bar and stops dying after one tier ([aa73604](https://github.com/Millennium44/Toolasha/commit/aa73604c5e2cc80f36a4c9f9d73be1a5ec14187d))
- **guild:** identify trial tier on the in-progress tab and project pace on the exact ladder ([b3dedff](https://github.com/Millennium44/Toolasha/commit/b3dedffbe2fcf08a0be5b923bfb47a48c23c7101))
- **guild:** roster survives refresh, names stay injective, regen self-classifies, joint tier solve ([a9ab27a](https://github.com/Millennium44/Toolasha/commit/a9ab27aef10847fecf9192ad1dd9a1a3f4a0bc30))
- **guild:** say when every fighter's combat sheet is fresh instead of hiding the button ([9d7fb47](https://github.com/Millennium44/Toolasha/commit/9d7fb47725a4a5cb6981ce9498f65d24e4fc1620))
- **guild:** scope per-player DPS to its tile, re-anchor drifting panels, cut redundant work ([27b8f1a](https://github.com/Millennium44/Toolasha/commit/27b8f1a13420b5badee68226af32f562fe369939))
- **guild:** stale tiers die with their pool, combat learns its tier, clock guards everywhere ([71256a4](https://github.com/Millennium44/Toolasha/commit/71256a40707425ebd567a80e0178ab4c5ece1e17))
- **guild:** trial DPS split states how much of the party it covers ([f2eb847](https://github.com/Millennium44/Toolasha/commit/f2eb8473c033725729c60ddfe1efb1fb82fcc538))

### Performance Improvements

- **inventory:** time-slice badge pricing so an enhanced inventory doesn't freeze startup ([16a1f67](https://github.com/Millennium44/Toolasha/commit/16a1f67b9f733f27231a1f50bfff7d9f7267a201))
- **startup:** split feature init timing into own-work vs await-drain ([cf806f1](https://github.com/Millennium44/Toolasha/commit/cf806f1c6bf3162939a2bbda6b4a4ac629feb13a))

### Documentation

- **greasyfork:** drop Iron Cow mode from the fork's additions list ([8dccdf4](https://github.com/Millennium44/Toolasha/commit/8dccdf42737f173795aaea27924b94412a71c6f1))
- **greasyfork:** frame the fork as Toolasha + Combat Suite, add Ctrl+K and tweak count ([280901f](https://github.com/Millennium44/Toolasha/commit/280901fa6372de94017b2948c95d81bbc8c70131))
- **greasyfork:** lead with how the pieces integrate and how far market prices reach ([5c7662d](https://github.com/Millennium44/Toolasha/commit/5c7662d7b5445fa8600349c2e3fcbfbbe9619d26))
- **greasyfork:** reframe sim-upgrade and labyrinth bullets to fork-distinct angles ([19c2a50](https://github.com/Millennium44/Toolasha/commit/19c2a50a69909c021d1767ca56a353f6cb39a83f))
- **greasyfork:** reword per-character bullet, soften mobile claim ([e2a365f](https://github.com/Millennium44/Toolasha/commit/e2a365fa4bd8373892c8f474ab82f208767d559c))
- **greasyfork:** soften the mobile bullet to "Mobile-friendly touches" ([639c4f2](https://github.com/Millennium44/Toolasha/commit/639c4f2e0523b3fa9e50bd2b426b97ad83b3c13b))
- **greasyfork:** trim inherited clauses from labyrinth, guild, and task bullets ([a023830](https://github.com/Millennium44/Toolasha/commit/a023830170f848f6d0a929b93165ac3f4d5c286f))
- **greasyfork:** trim Iron Bell from the listing, refresh guild tools and test count ([d198ea9](https://github.com/Millennium44/Toolasha/commit/d198ea9b287bc357a226462a0a72cb23b31f53df))
- **greasyfork:** trim the upgrade-advisor bullet to its fork-new parts ([47f701c](https://github.com/Millennium44/Toolasha/commit/47f701c762f38be063c2714289e8563b2015c562))

### Continuous Integration

- allow manual dispatch of the release workflow ([0987431](https://github.com/Millennium44/Toolasha/commit/0987431ea4fc38020513040cb4d1f6e8b99e3686))

### Miscellaneous Chores

- format the release-please changelog section ([3bff84c](https://github.com/Millennium44/Toolasha/commit/3bff84cdcd9726e0bd1a8f152e6cb0fabc4e5b83))
- **release:** write real release notes into the greasyfork-facing commit ([66981d7](https://github.com/Millennium44/Toolasha/commit/66981d7724d43c1715124a384744bbc83cf5abef))
- stamp userscript headers at 2.90.0 ([d44aad3](https://github.com/Millennium44/Toolasha/commit/d44aad3b5353fa72ca1180101cddcc74e8a7112c))

## [2.90.0](https://github.com/Millennium44/Toolasha/compare/v2.89.0...v2.90.0) (2026-08-06)

### Features

- add attribution comparison harness with counter-based referee ([6bb9134](https://github.com/Millennium44/Toolasha/commit/6bb9134981df537a9e79827b35be186fac00372f))
- cycler clicks battle units first, skipping the dead ([f5a9072](https://github.com/Millennium44/Toolasha/commit/f5a9072b054aa02bfa27c5335b4d9ff59237d01c))
- executable bundle-sharing check, house-cost dedup, bundle bridge ([2f374bb](https://github.com/Millennium44/Toolasha/commit/2f374bb99e85471f0ac03e7d7784e2b833ddcf83))
- hybrid attribution, trial split measured, tool-slot lint fix, book tooltip ([6cefb28](https://github.com/Millennium44/Toolasha/commit/6cefb282d73fded2518c833440989d2b18b5d979))
- integrate the five guild-trial wire messages ([822ae88](https://github.com/Millennium44/Toolasha/commit/822ae883b6d32c253f80ae1bfba24dffc87cd06c))
- liquidity cap on alchemy, action, and all-zones profit displays ([ab99bea](https://github.com/Millennium44/Toolasha/commit/ab99beab94ecc27b17d1cc5ac0b93ba97ebfbda1))
- profile links, chest-luck profit option, warming-up tile, solo compare ([9188678](https://github.com/Millennium44/Toolasha/commit/9188678330688b9e3b9cd1422e3e31d246955c6f))
- read sim-accuracy exports in the attribution comparison ([198f3ed](https://github.com/Millennium44/Toolasha/commit/198f3ed428332424e67895c70b5a37ce6039afc2))
- seven optional live-combat readouts on portraits, tiles and the tracker ([9fef83b](https://github.com/Millennium44/Toolasha/commit/9fef83b91820541a99d5452c1a83f3165a75d47d))
- sim summary units, party lint, entry keys in tracker, chest key button ([e74aac7](https://github.com/Millennium44/Toolasha/commit/e74aac72a6da054bb15ad1c59c91ba123c544860))
- sim-vs-measured line, live party lint, archived session picker ([047769d](https://github.com/Millennium44/Toolasha/commit/047769d53615c9b7fb8cd628232f64f8158fb68a))
- spectated guild battles are measured via guild_battle_updated ([664c583](https://github.com/Millennium44/Toolasha/commit/664c583524df34ca01d7764efc11c4539c421aee))
- trade ledger, gathering drop luck, csv exports; panels work in flight ([9342b31](https://github.com/Millennium44/Toolasha/commit/9342b3124a9ecb28544ac2365e2a495ea9d33dbe))
- trial history, sim calibration, undercut alerts, canaries, golden run ([2cd8cb4](https://github.com/Millennium44/Toolasha/commit/2cd8cb49d1fcd61b0f6e064e071ca37929694629))

### Bug Fixes

- a canceled battle start no longer records a phantom dungeon run ([5f518cd](https://github.com/Millennium44/Toolasha/commit/5f518cd9091cb6b642502d3e9ecb16f618cec6e0))
- auto-record arms on live readings, manual sessions never self-stop, T1 by rule ([8e0a171](https://github.com/Millennium44/Toolasha/commit/8e0a1710a57ae585fc177e7168ab10ad1555adac))
- badge counts banked tiers, derived skilling ladder, forecast walks the hour ([d2177d8](https://github.com/Millennium44/Toolasha/commit/d2177d86e9d66152d713c3d91faa6653bbcc2bdd))
- battle units only match inside the fight's own subtree ([5cdbcd9](https://github.com/Millennium44/Toolasha/commit/5cdbcd965c04fbe7f121935ea75160e8a2edeb02))
- capture-confirmed cycler, measured success decline, per-kind phases, no walls ([f2d6326](https://github.com/Millennium44/Toolasha/commit/f2d6326c00c87d44086ed74c9f3e6f2bb5821d78))
- chest-value adjustment reads the treasure ledger, not drop counts ([88fb2f8](https://github.com/Millennium44/Toolasha/commit/88fb2f8d79b2391d6dbc0f9c602d638057b4a39f))
- dead units are clicked like anyone else ([44e973d](https://github.com/Millennium44/Toolasha/commit/44e973d402e7c13e9c02f928efbcde0839fc7db9))
- deaths ride the support table, pinned revive-at-tier test ([0f819c1](https://github.com/Millennium44/Toolasha/commit/0f819c1f1fb497885f781399a366de40abac7919))
- mid-trial-upgrade cards use the exact ladder base for tokens ([012eb12](https://github.com/Millennium44/Toolasha/commit/012eb120c2dc3ae23d38704c193804de0be43bc7))
- notice boards purge from records, ladders locked with mid-trial upgrades ([0870b12](https://github.com/Millennium44/Toolasha/commit/0870b123750adf2b00e084a75ddf1124a5b28158))
- pace arrow matches its count, completed overrides phase, split is an estimate ([17f48cc](https://github.com/Millennium44/Toolasha/commit/17f48ccdb789efe2f90c38e7edee07996690f5dc))
- portrait dps meters keep one height so party frames stop shifting ([9e964be](https://github.com/Millennium44/Toolasha/commit/9e964be9f47155281f4dc5ebfd3fac672a86c297))
- price ability level-ups from live experience, not the level floor ([cc8507a](https://github.com/Millennium44/Toolasha/commit/cc8507a3e42c63881fe9cfdbf021b2a79115a4b2))
- roster rows come from the current member list, not the XP history ([06c34d9](https://github.com/Millennium44/Toolasha/commit/06c34d92c034eece49ca22603b74566f1adf03ca))
- spectated pool attaches to the watched encounter, wipes are outcomes ([dc0153f](https://github.com/Millennium44/Toolasha/commit/dc0153fac54fbaa99f1e0a7bb009672b17a33eab))

### Miscellaneous Chores

- raise bundle ceiling to 3.5MiB now the sharing check guards duplication ([5b2fc5e](https://github.com/Millennium44/Toolasha/commit/5b2fc5eac1e20c68ee92197b4a67cfad3e480f93))

## [2.89.0](https://github.com/Millennium44/Toolasha/compare/v2.88.0...v2.89.0) (2026-08-05)

### Features

- **abilities:** ability book panel — every ability, cheapest first ([8de2c7d](https://github.com/Millennium44/Toolasha/commit/8de2c7d81a163292ffcdd1b7e0c8fb40c14881ce))
- ability-level goals in Equipment Savings ([86d5b22](https://github.com/Millennium44/Toolasha/commit/86d5b22b896cb0607204d5665f74f4a54d5e59cf))
- add an option to sort the task board after reading new tasks ([5e3946a](https://github.com/Millennium44/Toolasha/commit/5e3946a4798a19a05df055b357d71a7622ac8994))
- add EWatch's item picker, value labyrinth scrolls, drop the enhancement tile ([365714d](https://github.com/Millennium44/Toolasha/commit/365714db180c3e7d0cb7516626bfce2bdb2d42f4))
- add EWatch's lock, refresh, and per-slot picker ([6e0cd8c](https://github.com/Millennium44/Toolasha/commit/6e0cd8ca11a90193ccfb4845bd3822e6455d4429))
- advisor/task/enhancing fixes, craft adapter, alchemy fixes, test sweep ([870d2e6](https://github.com/Millennium44/Toolasha/commit/870d2e69c427ddbf5c08b61b54dab71320e3ceea))
- Build Score breakdown panel ([9a1452e](https://github.com/Millennium44/Toolasha/commit/9a1452e76fced3c2bf71d3c72280eaf739557d4f))
- build the Party Luck panel and rebuild EWatch from MCS's pane ([d0bf552](https://github.com/Millennium44/Toolasha/commit/d0bf552bce8bffb32e1f0fb73bb9cca5a9430506))
- **chat:** /profile click-to-fill on every name Toolasha renders ([fdb7e06](https://github.com/Millennium44/Toolasha/commit/fdb7e06cec163d23e3c05e43c042ed721d217f5c))
- **combat-sim:** panel parity — partial results, reachable Stop, CSV, budget planner ([295c55a](https://github.com/Millennium44/Toolasha/commit/295c55a8f00acad571ad59b9f96d608e251e5496))
- **combat-stats:** consumables panel — what runs out, when, what to buy ([6438d4a](https://github.com/Millennium44/Toolasha/commit/6438d4adbeb9577db9decd90cbf75c49727b1d73))
- **combat-stats:** consumables tile shows you and party separately ([0648dc5](https://github.com/Millennium44/Toolasha/commit/0648dc5e9f72c0d5963e0e2bfcb206590b129f4d))
- **combat:** a Party Loot panel behind the profit tile ([fe35f25](https://github.com/Millennium44/Toolasha/commit/fe35f25b568c0b904f8a32eb4096a4759e1280c0))
- **combat:** attribute damage per player and per ability ([a2958a3](https://github.com/Millennium44/Toolasha/commit/a2958a3264f9bdbf803bf04c0977dc838b4040db))
- **combat:** count dungeon keys, completions and the level gap ([141baa3](https://github.com/Millennium44/Toolasha/commit/141baa3d0ecaf9f17a1ce10272fc9a1176726ecc))
- **combat:** damage meters on the battle portraits ([00c4c20](https://github.com/Millennium44/Toolasha/commit/00c4c20162d5b797024279ec83e1967114b64498))
- **combat:** drop a restored run once it stops describing anything ([7f57734](https://github.com/Millennium44/Toolasha/commit/7f57734299dd78909c41f54935ec0b7dbaf73043))
- **combat:** encounters and kills against what the zone owed ([5ca7fc2](https://github.com/Millennium44/Toolasha/commit/5ca7fc244d6586d285c9cf0e86b6a9819b6d6e81))
- **combat:** let the recorder start itself on page load ([7d46b5e](https://github.com/Millennium44/Toolasha/commit/7d46b5e982a3b6fae57c9e85d867152719e790b7))
- **combat:** mana per fight, and charm value per coin ([77dc92a](https://github.com/Millennium44/Toolasha/commit/77dc92a7549514809ec2ab7baa6d9eb1a2901153))
- **combat:** measure a dungeon by the chests it pays ([0766bf4](https://github.com/Millennium44/Toolasha/commit/0766bf45895f0b439defebb46b4dd8214a42a6ce))
- **combat:** past sessions in the loot panel, and fix the time-to-level number ([350a39f](https://github.com/Millennium44/Toolasha/commit/350a39fd3e2758185715ad44f3a7ccb00dcf0e92))
- **combat:** portrait meters per fight, and a rate on each monster ([a94f52f](https://github.com/Millennium44/Toolasha/commit/a94f52fb90577daa125271daa9c8159a8bc02dbb))
- **combat:** recover monster names after a mid-fight reload ([f768643](https://github.com/Millennium44/Toolasha/commit/f7686433da9373ea431d5e0cab8099c4d055a562))
- **combat:** show drop luck in the battle panel on return from combat ([a53ee85](https://github.com/Millennium44/Toolasha/commit/a53ee85d44b168cfef5c829f670f42f6e1c3d09e))
- **combat:** show profit for every character in the party ([b8f208f](https://github.com/Millennium44/Toolasha/commit/b8f208fabf7d8fe6a20486663e63b8ec05a48ac5))
- **combat:** the Deaths panel becomes IHurt ([01a08d2](https://github.com/Millennium44/Toolasha/commit/01a08d217f4c2fc0931e64eb24063f4e80005856))
- community buff expiry alerts; live buff levels ([0a4a474](https://github.com/Millennium44/Toolasha/commit/0a4a474c7e0e134d1233b067e942e182c6333867))
- compute Drop Luck per player ([e26b593](https://github.com/Millennium44/Toolasha/commit/e26b59349d906df0484805b962dd2b59c87413e4))
- configurable token buffs, ability union targets, shrine grid ([3f9468d](https://github.com/Millennium44/Toolasha/commit/3f9468de3d5670340e57ab4fbdd3bdf68db12b36))
- consent dialog before data adoption; backups named per character ([35c8826](https://github.com/Millennium44/Toolasha/commit/35c88263e0e25941ee9b0ea5f827b81d3eb461aa))
- cost enhancement from the enhancing loadout, lay Combat Profit out like HWhat ([c043839](https://github.com/Millennium44/Toolasha/commit/c043839ac21f2b355a1415ad38fe39a28f26c368))
- count the MooPass tax in Combat Profit, and add the Ask - Ask case ([aae0c7d](https://github.com/Millennium44/Toolasha/commit/aae0c7defd82d44f2c604831057442ca401bae8e))
- dismissable marketplace tabs; lab-sim tabs clear on close ([def2230](https://github.com/Millennium44/Toolasha/commit/def2230d989875b20bb7628a34127dcb1d8d219e))
- draw the DPS tile per player, fix the luck verdict, persist charm folds ([e1702cd](https://github.com/Millennium44/Toolasha/commit/e1702cd93d12bc7ffaf2315f53b42a48d24d85d6))
- dungeon keys costed at the cheaper of craft vs buy ([f64b019](https://github.com/Millennium44/Toolasha/commit/f64b019e9b5aa9cebc8d7f4edf36ec19607787fb))
- enhancement tooltip labels its stats source, toggleable to pro rates ([22659a7](https://github.com/Millennium44/Toolasha/commit/22659a79b483497c8c5695ceb3a31b2ac37ab161))
- fill the buy dialog with the books an ability needs ([3e5e08c](https://github.com/Millennium44/Toolasha/commit/3e5e08c5326892e34c5627482be9a03dffeeb5a5))
- gist sync, account view, philo corrections, lab audit fixes, housekeeping ([b321f34](https://github.com/Millennium44/Toolasha/commit/b321f3496d8efc7d43dcfd4d7a2c325e4297a0e5))
- give an idle tile something to say instead of going blank ([2bead2d](https://github.com/Millennium44/Toolasha/commit/2bead2da4923d2edb561fc9e0e15474d03801160))
- goal planner — ordered steps from goal to done ([74b43ac](https://github.com/Millennium44/Toolasha/commit/74b43ac3a63a28339f8ca8676bca95eef7181faa))
- guide-based ability swaps, signature-only, crit aura retired ([0090ce9](https://github.com/Millennium44/Toolasha/commit/0090ce91a3bd4752dc4a0c68e687c1da67448720))
- guild shrines in advisors/editor/score, calibration, roster, storage hardening ([7926cd1](https://github.com/Millennium44/Toolasha/commit/7926cd1e801e13a7a09c306ee18129e043578e0f))
- guild shrines in profile scores and net worth ([3fed03f](https://github.com/Millennium44/Toolasha/commit/3fed03f7546058d95ea4b1ac92e814f0902b5a41))
- Guild Shrines series in the networth history chart ([4682dda](https://github.com/Millennium44/Toolasha/commit/4682ddac6409874432dc1342816f2bae348a918a))
- guild trials suite, trial recorder and forecasting, labyrinth path/beacon rework, sync encryption, mobile fixes ([de3de61](https://github.com/Millennium44/Toolasha/commit/de3de615b3818c7c03fdcb262154a43b33397fd9))
- guild-shareable trial report with shortfall, deaths, and mana depletion ([f57976d](https://github.com/Millennium44/Toolasha/commit/f57976d2bf3ef159dc3fa9a74c56ddba26b61172))
- **guild:** price tokens via credit exchange; 2%/level bonuses; /shrines ([62ad6d5](https://github.com/Millennium44/Toolasha/commit/62ad6d5f9ccbe584e9c65f7a5e9b8e77c754a227))
- **guild:** trial pace, ETA, and payout projection on In Progress tab ([c5849a9](https://github.com/Millennium44/Toolasha/commit/c5849a9aaaed6ba0ad22e00a06434bfb785e95c3))
- gzip the sync payload so Everything fits one gist ([1b29ae6](https://github.com/Millennium44/Toolasha/commit/1b29ae61b7d5fb70e3d3505a301ead65b0b74be5))
- house-level goals in Equipment Savings ([f76b67a](https://github.com/Millennium44/Toolasha/commit/f76b67a0cab7a8019e718514710fb42550a0617e))
- **house:** let rooms be switched off, and price the materials you lack ([259444d](https://github.com/Millennium44/Toolasha/commit/259444d58c0d6dec4c75f3aed66583981bd609f5))
- idle-member names fill /profile on click ([7650cc8](https://github.com/Millennium44/Toolasha/commit/7650cc8a6dc24de96c1f02f2278c58776e882310))
- **inventory:** list every chest in the ledger, and align its columns ([446e301](https://github.com/Millennium44/Toolasha/commit/446e3019ec2e88af62ce159c9228dd7f5ca6d840))
- **inventory:** pop up what a chest opening paid, and fix settings homes ([8d210fb](https://github.com/Millennium44/Toolasha/commit/8d210fbc5fe2e7c7f20ffda30f4bf8d444341137))
- **inventory:** tighten the treasure popup towards TReasure ([07f8461](https://github.com/Millennium44/Toolasha/commit/07f846183aecd070d11a523f55528e2b3e99578f))
- **inventory:** track button in the item menu, off by default ([8f723e8](https://github.com/Millennium44/Toolasha/commit/8f723e8237a197cc4485eb745ef9697d05477878))
- **inventory:** treasure tracker — ledger of what chests actually paid out ([14e691a](https://github.com/Millennium44/Toolasha/commit/14e691a5d36baeac260e9b39603014c1f6efff9b))
- **inventory:** value untradables, and move chest history in and out ([3970b0b](https://github.com/Millennium44/Toolasha/commit/3970b0bad062959e25004804dbcadce91b7e6d49))
- **inventory:** watchlist — track items, a zone's drops, or a chest ([ecab530](https://github.com/Millennium44/Toolasha/commit/ecab53009ec482d834fba7f7a9c79196103210c7))
- Iron Cow Farm panel — the cowbell loop, costed honestly ([4e69804](https://github.com/Millennium44/Toolasha/commit/4e6980413c3d745a337fe381e027b50474f602c8))
- keep the action panel on screen and pin its buttons ([3267a67](https://github.com/Millennium44/Toolasha/commit/3267a6755b2961912e53b8ad18c7746b1f09f810))
- lab house/token/community scopes, honest gear costing, per-column gradient ([9611581](https://github.com/Millennium44/Toolasha/commit/961158181fc7a3aa3d9ed8fa0b14d30dbd632059))
- lab sim task-fight removal, row actions, per-item labels, houses ([08585ae](https://github.com/Millennium44/Toolasha/commit/08585ae0c8aedcd6dffec0233e584cb5b3ac8eee))
- **lab-sim:** combined armor swaps and ability swaps across targets ([06f8754](https://github.com/Millennium44/Toolasha/commit/06f8754dda14798145daeeb96601faf132b3f7aa))
- **lab-sim:** comparison runs and multi-select upgrade dimensions ([9c21af6](https://github.com/Millennium44/Toolasha/commit/9c21af6b7ffbed042843bd1b7ea0627ee111334e))
- **labsim:** an all-fights mode ranked per gold, and fix the Upgrade controls ([50edcf1](https://github.com/Millennium44/Toolasha/commit/50edcf191d19206dc7a2b36fc8fc1b67bb4c8528))
- **labsim:** budget planning, noise bands, and a combination check ([750f47d](https://github.com/Millennium44/Toolasha/commit/750f47d017c96044abd1abbf9543f4da48de65c3))
- **labsim:** offer celestial tools and skilling outfits, scoped to their skill ([ddfa18f](https://github.com/Millennium44/Toolasha/commit/ddfa18f43714638d8b79c8f71e6c5d1fd0b9c941))
- **labsim:** plan by room coverage, and run fights concurrently ([2d38ff2](https://github.com/Millennium44/Toolasha/commit/2d38ff22aad8dea96dee98748c3dc84e508e2a9c))
- **labsim:** sortable All Fights columns, left-corner resize, style-fit off-hands ([75da9d8](https://github.com/Millennium44/Toolasha/commit/75da9d8b66a3ebe8ba87c65d9ec7a041f8f3cf98))
- labyrinth-finish, combat-death, enhancement-target alerts ([12b3294](https://github.com/Millennium44/Toolasha/commit/12b3294170a5863c79be68feb915243242396936))
- **labyrinth:** collapse the accuracy list by room type ([6365729](https://github.com/Millennium44/Toolasha/commit/6365729352495a60a2089d4bcb2969641487ef10))
- **labyrinth:** export the sim accuracy record, and pool it by room type ([1105540](https://github.com/Millennium44/Toolasha/commit/11055403b53c74bd9cb9cbb19e2784b1fd7e2e6a))
- **labyrinth:** list the accuracy record in the game's order ([1adcb33](https://github.com/Millennium44/Toolasha/commit/1adcb334b061f91a52f805d6a569f4791c9c8cc7))
- **labyrinth:** scale the headline figures, judge combat by fight length, and mark a baseline ([d5dffea](https://github.com/Millennium44/Toolasha/commit/d5dffead0da2acb67119e44382d3c1fca52c8fe3))
- lay the Damage panel out as DPs' table ([4a060f8](https://github.com/Millennium44/Toolasha/commit/4a060f891aa425381cda4ce1d59e009738a4a29f))
- lay the enemy-HP card out as DPs does, and open enemy rows ([88bbf9c](https://github.com/Millennium44/Toolasha/commit/88bbf9c0234df3d68a026302eed6d61f54048584))
- liquidity and capital bounds on planner gold rates ([62f960f](https://github.com/Millennium44/Toolasha/commit/62f960ff67e23f1182a26607d9468a72174b1b77))
- listing-age anchors grow from recorded and observed listings ([8a75620](https://github.com/Millennium44/Toolasha/commit/8a75620d673c310d8c8be278429e1ee7789b0946))
- make the revenue tile follow the panel's profit mode and tax toggle ([f5f8e33](https://github.com/Millennium44/Toolasha/commit/f5f8e33a5de67b132b88da3dbef325e7aa4f7e79))
- **market,labsim:** hold loadout gear back, and weigh the aura as an upgrade ([41c0300](https://github.com/Millennium44/Toolasha/commit/41c030059e1d1bad6e6bb41c9c18928c8dc78cf9))
- **market:** estimate order fill time from the real order book ([8b46fee](https://github.com/Millennium44/Toolasha/commit/8b46feeb7c148c8c783aa3601f21be780c669b0b))
- match the DPS and luck tiles to OPanel ([35664b0](https://github.com/Millennium44/Toolasha/commit/35664b032751e23ef69beb8c73fa9f7b4c2a0945))
- max-tier food option for all-zones sims ([b73eaca](https://github.com/Millennium44/Toolasha/commit/b73eaca2282ea8c7257b7fea4f3c1625335860fd))
- measure luck per player against each player's own drop gear ([72f2d2c](https://github.com/Millennium44/Toolasha/commit/72f2d2ca57dc664f8652c3ffdab424ac27a2a77a))
- missing-material tabs auto-retire on acquisition ([510c54a](https://github.com/Millennium44/Toolasha/commit/510c54a16dacb6647c371bd7abbf60d190e9159a))
- **mobile:** pointer-event drags everywhere, viewport clamps, mobile mode ([ea9d7c3](https://github.com/Millennium44/Toolasha/commit/ea9d7c34cfdd8765992e8d6d96c41090a7f29541))
- **mobile:** the phase-1 sweep — clamps, pointer drags, hidden-tab timers, worker teardown ([d719917](https://github.com/Millennium44/Toolasha/commit/d719917b2f45a4ca8cd92c5e2b3d166b987091a8))
- **mobile:** touch equivalents for gesture-only features; remove the dead Sell Queue ([c9c8e8a](https://github.com/Millennium44/Toolasha/commit/c9c8e8a93aa4f15ba488b79dbf25ff3a73e86b1f))
- nest the enemy rows under the player who fought them ([e8619ee](https://github.com/Millennium44/Toolasha/commit/e8619ee69549fa2c5dde6cff5a2390a4a2b1eb18))
- networth overlay tiles open the history chart ([b14f2d7](https://github.com/Millennium44/Toolasha/commit/b14f2d7e7f5aac3a8e83ff774c840438a30c3055))
- neutral companion wording, shared Record control, mooket guard ([e25efba](https://github.com/Millennium44/Toolasha/commit/e25efba6b80227f03309abcad912e17d9c256704))
- official lab formulas, ladder cost, replay check, alchemy rules, canary ([2038217](https://github.com/Millennium44/Toolasha/commit/2038217cb68d79b1d85da5c9990067ac3d831872))
- only-numbers options for the Luck and Over Expected tiles ([828bde4](https://github.com/Millennium44/Toolasha/commit/828bde4bc9b8558f3020d6b138c12882e9c942d1))
- open the charm and mana panels, and format the books tile as BRead's ([a3b3c1a](https://github.com/Millennium44/Toolasha/commit/a3b3c1a7109ca6b8276a02f7c8a1d012c1d7caeb))
- optional passphrase encryption for cross-device sync ([f159238](https://github.com/Millennium44/Toolasha/commit/f1592384192d89f6e0bf6c05ce696b584ecb8318))
- **overlay:** compact/hidden empty tiles and a curated default ([ad6d830](https://github.com/Millennium44/Toolasha/commit/ad6d830736ceb031b357f16c2effffd83be28cbf))
- **overlay:** five new tiles, layout presets, activity auto-switch ([e541120](https://github.com/Millennium44/Toolasha/commit/e54112070a2b964b8827d70cd1018159ac0186c7))
- **overlay:** overlay switch in the character tabs, and a dock for it ([cd5c5a7](https://github.com/Millennium44/Toolasha/commit/cd5c5a7934dcaa46dbaff8f2644f3c5d186edde5))
- palette opens settings to the row; Iron Cow preset chip; IC copy ([b1830df](https://github.com/Millennium44/Toolasha/commit/b1830dfc3710d366f6a8968457b36e1b6a388a62))
- path overlay lights the walk to the plan's first step ([33f2259](https://github.com/Millennium44/Toolasha/commit/33f2259c40393561076024f2fb302a44a65870c0))
- per-player trial DPS, seen loadouts, payout provenance ([42bb79c](https://github.com/Millennium44/Toolasha/commit/42bb79c66124eb028f99434984e643cfae7d778c))
- planner ledger, instant replan, step navigation, honest windfalls ([99a5968](https://github.com/Millennium44/Toolasha/commit/99a596807f767906b9294c9010d28ba3958c9609))
- port EWatch as Equipment Savings ([503a7de](https://github.com/Millennium44/Toolasha/commit/503a7dee876237783e1423a0450ce92748b36247))
- price capes at the anvil, crafts through the planner, layouts in full ([6d50f14](https://github.com/Millennium44/Toolasha/commit/6d50f14f0dc7cd11d9cb7e218e02c356f441a00e))
- price crafts with artisan tea and open missing mats from the watch card ([ad4bd0c](https://github.com/Millennium44/Toolasha/commit/ad4bd0c0f26871490e0c1abb696adad16083e8e0))
- price crafts, sell per piece, and put a bar on the savings tile ([c5f4397](https://github.com/Millennium44/Toolasha/commit/c5f439728b908ac3f50d67b45c9c7b8075d8b62a))
- product-review wave one — backup, presets, health checks, savings trend, cache persistence ([0f9edd5](https://github.com/Millennium44/Toolasha/commit/0f9edd5e7b1315b911eacb227006136096d4fe2f))
- rebuild the ability books panel to BRead's shape ([67095d7](https://github.com/Millennium44/Toolasha/commit/67095d7e36414db87ef99a03f116d5bea9134730))
- record targets, XP checking, DPS decomposition, check history ([e6d0d39](https://github.com/Millennium44/Toolasha/commit/e6d0d39fbf166589db78803c72fdb1383034781c))
- recorder loadout snapshots, checkpoints, rotation, noise bands ([5d9ed30](https://github.com/Millennium44/Toolasha/commit/5d9ed304497a3fa304f6d0f0ff3b817a61480554))
- rename to Iron Bell Farming; add next-step overlay tile ([1d8b446](https://github.com/Millennium44/Toolasha/commit/1d8b4463ad7c6fa59312a4892abb56f8b6728830))
- scope skilling sim to its skill, add community buffs ([279af7f](https://github.com/Millennium44/Toolasha/commit/279af7ffcf8683d6bdd3966917df28596d3aeba6))
- **settings:** first-arrival choice between fork defaults and keeping things as they were ([ddbfe94](https://github.com/Millennium44/Toolasha/commit/ddbfe94417b3ccff03cb4dc6e1b0642536efd939))
- **settings:** what's-new popup per update, and conservative new-setting defaults ([ccb0f24](https://github.com/Millennium44/Toolasha/commit/ccb0f244ef6def2c9adc23c4f1bcbdd5748a142b))
- shared per-character storage key helper ([90cafcd](https://github.com/Millennium44/Toolasha/commit/90cafcd21ea42b605c29b1c18db08ad1c453f977))
- **sim:** results summary tiles, clear-all baselines, shrine target level ([451f97f](https://github.com/Millennium44/Toolasha/commit/451f97f028d8015ac10e9ac119122bd29157b767))
- **sim:** show time remaining on every sim progress bar ([85d6fbf](https://github.com/Millennium44/Toolasha/commit/85d6fbf496d9b8da62b48d9ca2cf78bf1577b82c))
- **sim:** taskDamage, achievement buffs, graceful unknowns, sustain view ([0c1a12b](https://github.com/Millennium44/Toolasha/commit/0c1a12b40e08fbe5e5daaab1047c461322e554e6))
- task-slot fill alert, derived trial tier forecast, guildmate profile logger ([2510541](https://github.com/Millennium44/Toolasha/commit/25105414c25d336cc41f4a283abcb9c47ecd0e76))
- Toolasha.debug.exportTrialData() trial recorder export ([c2ec62c](https://github.com/Millennium44/Toolasha/commit/c2ec62c3e307032d5d2f5cd74ea85c5fc8cad681))
- track damage and kills per enemy, and read DPS off health bars ([7eac365](https://github.com/Millennium44/Toolasha/commit/7eac3658cf3946bbece6a83d7c17e2d0c2ef5a8c))
- trial auto-recorder, ranked scoreboard, and measured per-player support stats ([2376777](https://github.com/Millennium44/Toolasha/commit/23767779a5cc1d392648e2128bf1867ff886a824))
- **ui:** aim the target selector at the combat level itself ([2c1d25f](https://github.com/Millennium44/Toolasha/commit/2c1d25fd6abc6613a7062e443955a20d19715408))
- **ui:** build score row, OPanel layout import/export, row formatting ([eadaa48](https://github.com/Millennium44/Toolasha/commit/eadaa48652d05d6c17a2899f9c017eaba93e1bb0))
- **ui:** buy the consumable shortfall, and rate drinks exactly ([07e4ca9](https://github.com/Millennium44/Toolasha/commit/07e4ca91a6565a6557aec834c774181fbf891958))
- **ui:** buy the whole consumable restock as marketplace tabs ([a77321e](https://github.com/Millennium44/Toolasha/commit/a77321e1e5854281968535350dada0ac6c73f4bf))
- **ui:** consumables rows in CRack's shape, and marketplace links ([2ff8ef7](https://github.com/Millennium44/Toolasha/commit/2ff8ef740ce3aa55e2fb6dbb7f4d379f0e59471b))
- **ui:** count finished listings on the badge, and remember open panels ([0a8f2bc](https://github.com/Millennium44/Toolasha/commit/0a8f2bcc6c181e7025a4c8c3eb8894afcacd66e8))
- **ui:** double-click toggles a panel, and stamp the dev build ([184c7f5](https://github.com/Millennium44/Toolasha/commit/184c7f51d513423d690a08c62396a4fadca58101))
- **ui:** draw glyphs from the game's sprite sheets, and JHouse's room icons ([741260d](https://github.com/Millennium44/Toolasha/commit/741260d6f1f2b24d5cd2c4133c4699a45714d008))
- **ui:** five overlay rows from calculators that already existed ([14c6a90](https://github.com/Millennium44/Toolasha/commit/14c6a9087fcaed1f0db5d8396d5f1f895641c783))
- **ui:** floating and scrolling combat text ([4f1d5d6](https://github.com/Millennium44/Toolasha/commit/4f1d5d6a04df5fda96552fab350edf2a6c53de8c))
- **ui:** free-form overlay layout, resizable panels, three-way import ([35a09ea](https://github.com/Millennium44/Toolasha/commit/35a09ea859322caccc5b9350fb22d81e8bda319e))
- **ui:** gwhiz part one — combat level and what moves it ([276a3ba](https://github.com/Millennium44/Toolasha/commit/276a3ba502210fe986d8c0a8de29910307bfb829))
- **ui:** gwhiz part three — fractional progress and gwhiz's layout ([a19c1b1](https://github.com/Millennium44/Toolasha/commit/a19c1b11342956228be270670820a476c93e6158))
- **ui:** gwhiz part two — session, targets, charms and lookup ([9cf1374](https://github.com/Millennium44/Toolasha/commit/9cf13748ab092f4ac7b36573f5a43ab99c8f4c34))
- **ui:** overlay panel shell that features register rows on ([05aec3e](https://github.com/Millennium44/Toolasha/commit/05aec3e1d16633750c57e993cc8487902fda452d))
- **ui:** panels behind the four combat tiles ([7a27512](https://github.com/Millennium44/Toolasha/commit/7a275122cfba8a6f82fc1c7031960d8c4ddcb0f1))
- **ui:** panels behind the overlay rows, opened by double-click ([1640604](https://github.com/Millennium44/Toolasha/commit/1640604ef0c67fdf69e11a7e3b96d61b80280289))
- **ui:** per-tile and panel-wide text size, replacing Ctrl+scroll ([481a792](https://github.com/Millennium44/Toolasha/commit/481a79247ab0b61693afe1eaddb92e351c0b5fdc))
- **ui:** remember the houses and treasure panels too ([5058342](https://github.com/Millennium44/Toolasha/commit/50583424a11605150e06fa9fc254b5b16445059d))
- **ui:** settings popover above the panel, undo for bulk layout changes ([944307b](https://github.com/Millennium44/Toolasha/commit/944307b6087895edd0f18ad6e8b0e84215fed039))
- **ui:** sim panel geometry persistence, stable upgrade tables, z-index tiers ([aa1c923](https://github.com/Millennium44/Toolasha/commit/aa1c9236092452a54dbe765ca046a45cc22c5349))
- **ui:** the time to level tile follows the target selector ([7b44768](https://github.com/Millennium44/Toolasha/commit/7b4476840be79994f754eef4a421c6b0dace6a4e))
- **ui:** tile separators, and make an imported OPanel layout usable ([d94f26b](https://github.com/Millennium44/Toolasha/commit/d94f26b7dc09fb1aed1555f212881220998c8ec7))
- **ui:** twelve more overlay rows ([dfbeb86](https://github.com/Millennium44/Toolasha/commit/dfbeb86fa087b370251460bdc5b8a89ebb740d5e))
- **utils:** port drop-luck and expected-spawn analysis from MWI Combat Suite ([29dddd4](https://github.com/Millennium44/Toolasha/commit/29dddd4966de7604530178fcc0298f3c825a647f))
- verdict-gated upstream ports, task-damage gating, decompose fee helper ([94f510d](https://github.com/Millennium44/Toolasha/commit/94f510d19ea4dd9e1e686f6340d1932879372ed0))
- **watchlist,market:** header switches, a dots toggle, and the watchlist as a bulk-sell source ([416f7c0](https://github.com/Millennium44/Toolasha/commit/416f7c0cb035195d9f6e76d449a53e6226eb98c6))
- wave three — command palette, named layouts, zones in the ranked list, advisor handoffs ([ace1fb8](https://github.com/Millennium44/Toolasha/commit/ace1fb818283fbdebef255d88a5bea8f4714edab))
- wave two — notification service, price provenance, prefix selectors, canary ([841568a](https://github.com/Millennium44/Toolasha/commit/841568a99f679451623fb6d359cbd65951d86e1d))

### Bug Fixes

- **abilities:** show the equipped kit, and fold BRead into Skill Books ([081b69e](https://github.com/Millennium44/Toolasha/commit/081b69e56a8d9e22ae2a69cdb898086725d46c30))
- allow gist raw host, guard never-synced push ([abf61c2](https://github.com/Millennium44/Toolasha/commit/abf61c2c23f5d1995176c4bcdcd8f81c8bc4d90b))
- beacon plans cover the exit path first, count resets per floor, one-click auto mode ([54f487d](https://github.com/Millennium44/Toolasha/commit/54f487d2d3cb322963eddc671f1896abf1293534))
- budget planner estimates fallback, book autofill, score prefs ([2b26831](https://github.com/Millennium44/Toolasha/commit/2b268317b43ecb67adb6da76142a5a66e90b6ac8))
- **build:** share src/utils across bundles, and make drop luck live ([3820f87](https://github.com/Millennium44/Toolasha/commit/3820f87a944ba023b53ac7f0a0533051d6ff5d12))
- bulk reroll settles cards it touches and takes undiscovered free rerolls ([b964ffd](https://github.com/Millennium44/Toolasha/commit/b964ffdb12c5a98752067cd5491cea86cc119021))
- **chat,treasure:** clickable guild joins, content-fit popup, drag without pinning ([ed41b3a](https://github.com/Millennium44/Toolasha/commit/ed41b3a3f518f74594cc5b5a8ed9f1aa1fca58b5))
- claimLegacyData force-completes adoption after a restore ([790a1bb](https://github.com/Millennium44/Toolasha/commit/790a1bbea59a63774f6bec46f0563c2e130307ef))
- clamp floating panels to the viewport, mobile panel usability ([fb73e6c](https://github.com/Millennium44/Toolasha/commit/fb73e6c626f984d7b9972bd21dda98239fc26d80))
- close the wrong-character adoption hole; add scoped-data repair ([c739f5c](https://github.com/Millennium44/Toolasha/commit/c739f5c83643dbe47090f91e732e28315ad01141))
- combat, labyrinth, and dungeon records scoped per character ([f7405a0](https://github.com/Millennium44/Toolasha/commit/f7405a00d844bf747c0294e6850a8465103c93dc))
- **combat:** draw portrait meters inside the tile, and instrument the badge filter ([51808a4](https://github.com/Millennium44/Toolasha/commit/51808a4325a5dac58bd7c0539a77046c28aa8061))
- **combat:** identify the attacker by atkCounter, not by a trimmed fixture ([134f214](https://github.com/Millennium44/Toolasha/commit/134f21443256a7385b0031d81cfd0da465e2d529))
- **combat:** identify the attacker from the tick delta, not from who was hit ([217faf2](https://github.com/Millennium44/Toolasha/commit/217faf2295c436b6045b321164e231a59818d92f))
- **combat:** identify the caster by atkCounter, restoring party attribution ([42f1809](https://github.com/Millennium44/Toolasha/commit/42f1809e6bcdfe1ae7438a7ab4ed5eff16a80f96))
- **combat:** ihurt read a feature object where a module should be ([6a43ede](https://github.com/Millennium44/Toolasha/commit/6a43ede57f42e802ee5cfa09fa5b3dab27d4c014))
- **combat:** keep reading the panel until a battle is announced ([a4d1ff4](https://github.com/Millennium44/Toolasha/commit/a4d1ff4e8613fa7b19e4609e2a8b6ad81e8547c5))
- **combat:** keep the dungeon reading across a refresh, and profit for the party ([58f383e](https://github.com/Millennium44/Toolasha/commit/58f383eb37c97e989e92de9a9cd3f844a10712be))
- **combat:** put the level gap in the chest expectation, not in a refusal ([cfd19ea](https://github.com/Millennium44/Toolasha/commit/cfd19ea38916a4bf6e4c506c5d54e4d8e2ae3e78))
- **combat:** reset the damage tally when the party changes ([3bc5cb7](https://github.com/Millennium44/Toolasha/commit/3bc5cb7118f60fd59defb55365f7d56c534283ec))
- **combat:** restore the last run at start-up instead of waiting for a wave ([e3166ca](https://github.com/Millennium44/Toolasha/commit/e3166ca995ee80c1d67c4e3515322cdecdd163a6))
- **combat:** stop crediting the character a tick is about when they were hit ([5ce0df4](https://github.com/Millennium44/Toolasha/commit/5ce0df4c75ad41c84eda181a7e91c7aa360207db))
- community cap is 20; add Reset to Me / Reset to Party ([058cb44](https://github.com/Millennium44/Toolasha/commit/058cb44b2c2a5e4805ef44e6177505a99aee003c))
- community ceiling, popover, charms, market handoff, zone score ([1b21333](https://github.com/Millennium44/Toolasha/commit/1b21333f7dbf8926b1b0503e34473146e2437adf))
- **consumables,houses:** colour against the target, and end the module-scope storage race ([81c6852](https://github.com/Millennium44/Toolasha/commit/81c68529922f5fbe70f17019d8213ce73075a802))
- **consumables,treasure:** remember the panel and its target, and redraw when the ledger lands ([98c5bfd](https://github.com/Millennium44/Toolasha/commit/98c5bfd75a1cde3d82ad9b61341ed37dc2e077db))
- cost enhancement at your own bench, and fold Drop Luck into Party Luck ([92f5a9c](https://github.com/Millennium44/Toolasha/commit/92f5a9cb3c33b9ffac992bcd649e7e76cc9e405a))
- count only spendable coins, and open EWatch on the slots ([6289ad8](https://github.com/Millennium44/Toolasha/commit/6289ad8dd5081cdecbdcb449baefe62246b763ee))
- credit each hit to the ability actually cast, and record combat ([4ae6ca0](https://github.com/Millennium44/Toolasha/commit/4ae6ca01a53e377d1874004c1ecd408239a2b74a))
- dungeon run anchors, guards, and export slot naming ([1cd7551](https://github.com/Millennium44/Toolasha/commit/1cd75516ff47581af2ef2ae3a4476866f010a06c))
- e-watch searches all protection strategies; ladder mode button ([a47d163](https://github.com/Millennium44/Toolasha/commit/a47d16375bbb9e31bac5959b1d1c62f743815297))
- exact trial payout math and combat damage rates across tier clears ([001ac46](https://github.com/Millennium44/Toolasha/commit/001ac4689ce1aecd07efb92938863707cd7298f9))
- find the trials tab structurally; enabled tiles acknowledge ([98c054a](https://github.com/Millennium44/Toolasha/commit/98c054a2800be0e0bf3aca96535dc3611b9d171b))
- fire the anvil path for capes, keep imported layouts as written ([4c40fd3](https://github.com/Millennium44/Toolasha/commit/4c40fd3ed805f32aa83c45f0a5a8fa6761725f3a))
- **guild:** building levels clamp at 20, distinct from 21 trial tiers ([ef51d33](https://github.com/Millennium44/Toolasha/commit/ef51d33564974b7209bb8cf7c99bb0b31492d00e))
- honest classification when the sync manifest is not ours ([94ea79d](https://github.com/Millennium44/Toolasha/commit/94ea79d0e05c76f2b77564223f20933e05291773))
- houses row missed unbought rooms, popup missed the loot dialog ([773976b](https://github.com/Millennium44/Toolasha/commit/773976b806d3a78977382073e6345c9374e4d62e))
- **inventory:** place the treasure popup beside the loot dialog, probe houses ([5766955](https://github.com/Millennium44/Toolasha/commit/576695511a40a8ad34e4b24381160c314153a751))
- Iron Cow re-forces after bulk writes; buff announcers clickable ([1e6450f](https://github.com/Millennium44/Toolasha/commit/1e6450f2c792852c89fbb3b9da8388f87a005fde))
- keep a tile's resize grip above its text-size buttons ([db318de](https://github.com/Millennium44/Toolasha/commit/db318de7950b8946de6c9c9e6bc092d949b57a75))
- **lab:** next-run restock phrasing, tier-aware hints, tooltip watchdog ([cd06116](https://github.com/Millennium44/Toolasha/commit/cd0611616c97bae8f0fbcb92daee00c6f6b00313))
- **lab:** read run supply stock mid-run; game icons in the readout ([c8d5376](https://github.com/Millennium44/Toolasha/commit/c8d5376070406814dc0f118c5dc718cfe530e541))
- **labsim:** move the Crit Aura switch to the Upgrade tab ([bdea0a7](https://github.com/Millennium44/Toolasha/commit/bdea0a7b4af558ef83613044404848374cbb4362))
- **labsim:** price ability upgrades in books, with nothing credited back ([43f1275](https://github.com/Millennium44/Toolasha/commit/43f12756303acc6c32829e155e0c4d722259434c))
- **labsim:** scope skilling upgrades to their own skill, and export to CSV ([3cc227e](https://github.com/Millennium44/Toolasha/commit/3cc227ee5097c1b1d1601d03b397a66476a314a5))
- **labsim:** sim a piece only against the loadouts that wear it ([317df0c](https://github.com/Millennium44/Toolasha/commit/317df0c2ee04bb2fc5be27c96cdd82c28f717420))
- **labsim:** the Critical Aura is an ability, not a trinket ([5af8a21](https://github.com/Millennium44/Toolasha/commit/5af8a21af28539aa29892104ce772a931e7912ad))
- **labyrinth:** compare room timings per clear on both sides ([6abb4e9](https://github.com/Millennium44/Toolasha/commit/6abb4e97f72674c9f4085ac913b01d3b1876380c))
- **labyrinth:** count doubles against successes, and measure success per room ([4aba70c](https://github.com/Millennium44/Toolasha/commit/4aba70cfc69a8c139ffb8a889a53832e8b4ad1a7))
- legacy_ironcow characters never adopt legacy global data ([198c1c1](https://github.com/Millennium44/Toolasha/commit/198c1c121a7e92db1b8bd76b4ced179b9ce81458))
- let the action panel's grid items shrink ([65dda8a](https://github.com/Millennium44/Toolasha/commit/65dda8ab8b4939745a49d4e39383b961cc6071a7))
- line the DPS, Over Expected and Luck tiles up ([8846661](https://github.com/Millennium44/Toolasha/commit/88466612155911ba84e9697bd0f84e8589ad3975))
- listener snapshots, shrine planner overflow, profit view read ([bf400ea](https://github.com/Millennium44/Toolasha/commit/bf400eab6a63a7c104ede7da417a11fe51eac83b))
- live community buffs in lab readouts, house scopes, level source ([3addfb6](https://github.com/Millennium44/Toolasha/commit/3addfb691ac59e1fa5957d98a7c9cb478ae901a1))
- **loadouts:** read the enhancement levels a loadout actually wears ([d2b924f](https://github.com/Millennium44/Toolasha/commit/d2b924fca43c097092c66814262229debd5cded6))
- make the damage table readable at a narrow width ([5f40033](https://github.com/Millennium44/Toolasha/commit/5f4003334b1dfd0b170374de4fc5c4f8df29a06f))
- market and inventory state scoped per character ([60f8881](https://github.com/Millennium44/Toolasha/commit/60f8881619633b760bc48b087ee9e3cd8ac6bd80))
- **market,labsim:** read hrid off watchlist entries, and apply the default monster's loadout ([fb92c67](https://github.com/Millennium44/Toolasha/commit/fb92c6719c4217d07422460155e6de42fd2ff243))
- **market,treasure:** write the count into the game's badge, and stop clicks pinning the popup ([34305eb](https://github.com/Millennium44/Toolasha/commit/34305eb676c241805a205d18e7030430ce11b0df))
- **market:** badge finished listings that were there before start-up ([b827741](https://github.com/Millennium44/Toolasha/commit/b827741012d7082bf2ed5683d5f879d79ef746e7))
- **market:** last three features find the visible marketplace tab bar ([85fe85a](https://github.com/Millennium44/Toolasha/commit/85fe85a8c60d779d96bd220f264580575828c053))
- **market:** share the visible-tab-bar lookup across marketplace features ([521a9b2](https://github.com/Millennium44/Toolasha/commit/521a9b22a5782ff03c34a3f5a211aa3afbb5f7a9))
- measure EWatch's income, name the enhancement, use MCS's eye ([90e6540](https://github.com/Millennium44/Toolasha/commit/90e6540a0e832141f442b5d6101bb74bc0a948d1))
- nine cross-cutting debts from agent reports ([cb93289](https://github.com/Millennium44/Toolasha/commit/cb93289ea9a90cab5fc7bff7b84184ca11208cbb))
- overlay reachable and readable on mobile ([429a33e](https://github.com/Millennium44/Toolasha/commit/429a33e76f5be98bfbeefdf961a5bb2be2127c4d))
- overlay settings popover no longer traps or goes stale ([f3cefdb](https://github.com/Millennium44/Toolasha/commit/f3cefdbff5c382bbfb048e01214fb95b1c4a46ef))
- **overlay:** docked panel hung off the bottom with its tiles cut off ([4a0e7a1](https://github.com/Millennium44/Toolasha/commit/4a0e7a1ece792d657898b105181c232698512c0e))
- **overlay:** the Overlay switch was cloned from a hidden tab ([5df68c5](https://github.com/Millennium44/Toolasha/commit/5df68c5a2e55da40b002d18ea1b2f03e3d53f6f9))
- panel open-state, overlay, and task prefs scoped per character ([48e8f3b](https://github.com/Millennium44/Toolasha/commit/48e8f3b5dcdc78292a51a444b351fade2b093bd4))
- **panels:** reopen remembered panels, and fix the badge, popup and sort ([3c4403c](https://github.com/Millennium44/Toolasha/commit/3c4403c924bb3b2e5faff2acf84def93584daa8a))
- Path re-plans against the board as it stands, not the press-time snapshot ([0481b64](https://github.com/Millennium44/Toolasha/commit/0481b6480ec04af6c352e70e119677f08a7a6759))
- price trainee charms at the vendor's 250,000 ([b1924ed](https://github.com/Millennium44/Toolasha/commit/b1924edca37beabfe859900de78c29626ce78a4f))
- read the charm slot by item location, and rebuild the panel as QCharm ([22d9849](https://github.com/Millennium44/Toolasha/commit/22d984958cfeaa358084bf8d3f3e89f086d33dba))
- read the reroll chooser structurally; MooPass-aware labels ([fe78577](https://github.com/Millennium44/Toolasha/commit/fe785778a360e6195571e132442952e7245e77af))
- remove WebSocket prototype message wrapping ([ea41173](https://github.com/Millennium44/Toolasha/commit/ea411733f293e1c0fc36cd0cd165e28550e28646))
- reserve the scrollbar gutter and limit width at any depth ([ea66fa0](https://github.com/Millennium44/Toolasha/commit/ea66fa0a5bffebcecb592d6015eee53f0aeba4a7))
- seed wave baselines — first swings were invisible to the replay ([cb4156a](https://github.com/Millennium44/Toolasha/commit/cb4156ae6c4155b3c83119f509ff780c7cb712ec))
- self-healing trial records, lifecycle-aware panel, trial notifications ([c946478](https://github.com/Millennium44/Toolasha/commit/c946478c84d80ea1b06f9b19881395d67c02bf84))
- **settings:** file the combat trackers under Combat Features ([a1c6714](https://github.com/Millennium44/Toolasha/commit/a1c6714e1d3c701a09a131e5bed57a3c126ad653))
- **settings:** make every audited setting do what it says ([d440d77](https://github.com/Millennium44/Toolasha/commit/d440d770bf6bb2c1582761f6ca14a9fe75a80e88))
- show unpriced drops, lay EWatch out by slot, stop redrawing live controls ([d4b0565](https://github.com/Millennium44/Toolasha/commit/d4b0565c3588d242c442c0b43ca04b7eca1bee44))
- **sim:** apply ability updates live; capture and persist shrine levels ([8e51a14](https://github.com/Millennium44/Toolasha/commit/8e51a147a7ef599e7bc540d5c8b894ae511cf55f))
- **sim:** re-pair the baseline's chunking, stop awaiting debounce timers ([9cfc4f2](https://github.com/Millennium44/Toolasha/commit/9cfc4f2a48d33e9a894b35b7467f8eeb23dc905d))
- **sim:** scope all-zones snapshot, upgrade selections, and lab keys per character ([f80194b](https://github.com/Millennium44/Toolasha/commit/f80194bf48b1d2d9a7f666326dae983fcdf0ea31))
- **sim:** scope house buffs to combat, per-player guild buffs, live Experience token ([8aaae8f](https://github.com/Millennium44/Toolasha/commit/8aaae8f29044e4b1ca4f29398aba56dee5c1d858))
- size the cost summary, budget row and mats button to their column ([03e5fdd](https://github.com/Millennium44/Toolasha/commit/03e5fddd02616d391b690f0562a729ed748b48a6))
- skilling cost details, swap exclusivity, unpriced-never-free ([2cca3ec](https://github.com/Millennium44/Toolasha/commit/2cca3ec6eeb741eb03ad65e3323ac514d81b897c))
- **skills:** drop the arrow from the time-to-level tile ([d53e0f1](https://github.com/Millennium44/Toolasha/commit/d53e0f1418ff9ccfccedc0eafdaac13ce1ca2a2b))
- stamp sim-export bridge payloads with the writing character ([6f0ef7f](https://github.com/Millennium44/Toolasha/commit/6f0ef7f5bf264d34ba84e63395adc3435adfc1b9))
- stop the charms panel unfolding sections you folded away ([15f3e94](https://github.com/Millennium44/Toolasha/commit/15f3e94b1e3831d85b0d93a8e9b2910d1deefd0e))
- stop the pinned action buttons reading as a boxed-in group ([1bdc66a](https://github.com/Millennium44/Toolasha/commit/1bdc66a60159bf7ec84c64ede3ccf464c8e38117))
- style every scrollbar in the action modal, not just the panel's ([c1ee335](https://github.com/Millennium44/Toolasha/commit/c1ee33558201a907b455b347acf2f4cebf12c4fa))
- sustainable goal-planner rates, loadout staleness, buy handoffs ([81dac91](https://github.com/Millennium44/Toolasha/commit/81dac91c5feed66463506c030db0a1db35a98b4a))
- sweep stale action-bar profit nodes before reinjecting ([7bfe32a](https://github.com/Millennium44/Toolasha/commit/7bfe32a71fe8736f0a38276c545d2ed8725c9f1f))
- task cards settle after rerolls, free MooPass unstuck ([c7c10b7](https://github.com/Millennium44/Toolasha/commit/c7c10b7924db5097dbe10417072c69aa008df516))
- **tasks:** stop interfering with the game's reroll and discard flows ([bdcd07b](https://github.com/Millennium44/Toolasha/commit/bdcd07bd2b020c6632f28abab599e9900ed7dc36))
- the blue box was the pinned strip's own background ([d6ade4a](https://github.com/Millennium44/Toolasha/commit/d6ade4ac6cc1c2b98ef9fe5563fbb0bbe13358f0))
- **treasure,consumables:** late settings reach the header, and the target read waits for storage ([a771c96](https://github.com/Millennium44/Toolasha/commit/a771c960ae3ba63466c506ba6e1b8cb63d00b7b1))
- **treasure,overlay:** stable chest item order and a CRack-shaped consumables tile ([e411ad6](https://github.com/Millennium44/Toolasha/commit/e411ad6164493cde996835e0ffd8b23e286aeb1f))
- trial blocks stay off non-trial tabs, recorder needs a live phase, cards render per phase ([9482fd2](https://github.com/Millennium44/Toolasha/commit/9482fd20ff7f669ce83ec5d754342113d6350666))
- trial data re-keys on character switch, stable side-block layout, scroll preserved ([e0f1c87](https://github.com/Millennium44/Toolasha/commit/e0f1c8724921a4eedf02de3bed058634f5bc9d6e))
- trial export-proven defects — damage gate, sampler, tiers, guild name, stat kinds, overlap ([e919acb](https://github.com/Millennium44/Toolasha/commit/e919acbebd674ea5e0da935ee3cab9abf4c4a9ad))
- trials read both real tabs, structural clock, lazy guild key ([24f7bd9](https://github.com/Millennium44/Toolasha/commit/24f7bd9f5d1689bd203cc288207ea00db802afa5))
- trials round three — full payout digits, tab-scoped roster, measured placement, participation captions ([78ed8b5](https://github.com/Millennium44/Toolasha/commit/78ed8b5d5b9e066787a68bcff13d5510ac2b9af9))
- **ui:** changing a dropdown appeared to do nothing ([af5747f](https://github.com/Millennium44/Toolasha/commit/af5747f6630c630cef67a18bb0fc763a89e73993))
- **ui:** combat level panel stopped after the session bar ([7a5e6b7](https://github.com/Millennium44/Toolasha/commit/7a5e6b78f95c343f611bfe92d03f5dd7e6d2e853))
- **ui:** keep the shopping list tabs on the marketplace ([73040d6](https://github.com/Millennium44/Toolasha/commit/73040d678e82f08d52d1859b79890d0636ce3970))
- **ui:** lay an imported layout out at the width it asks for ([2c52d96](https://github.com/Millennium44/Toolasha/commit/2c52d9603a9c74e029bc66eea3a5b2538a1e254b))
- **ui:** profit panel showed zeroes, and saved state raced the database ([7181ba6](https://github.com/Millennium44/Toolasha/commit/7181ba6e88c9d302a3086b0f68d7c20cb225587e))
- **ui:** put the restock tabs on the marketplace being displayed ([5c9c259](https://github.com/Millennium44/Toolasha/commit/5c9c259775764b092ea58d2559620cefeee3ac8d))
- **ui:** rebuild the combat panels against the vendored source ([93ad45f](https://github.com/Millennium44/Toolasha/commit/93ad45f82c65d9f2904de408de0397edbffd1f13))
- **ui:** restock tabs duplicated their heading and accepted a failed build ([cb2ce08](https://github.com/Millennium44/Toolasha/commit/cb2ce089eced05eb6adc1e8859c7fe6175b97d96))
- **ui:** share the overlay row registry across bundles ([3291975](https://github.com/Millennium44/Toolasha/commit/3291975ce0d76696d6830b63bbcea4acd198db75))
- **ui:** shopping list tabs, and drop the overlay below game UI ([30da6fd](https://github.com/Millennium44/Toolasha/commit/30da6fd675970e5503d06ce3bd2f5b268c2068ee))
- unpaint the sticky action-button strip; untangle pin classes ([428ae72](https://github.com/Millennium44/Toolasha/commit/428ae72c7e75e79c95a5606029620fafd2798436))
- zone-index badge only touches the DOM on change ([c18eee9](https://github.com/Millennium44/Toolasha/commit/c18eee9e92c2b1d2499b528b709df3b3e9b13c79))

### Code Refactoring

- **combat:** price a kill from the tick's mHP ([16cc0a7](https://github.com/Millennium44/Toolasha/commit/16cc0a7742da3a1914780151c5b75c531fb88d67))
- **lab:** split clear-rate module; supply-aware planner; stable live readout ([3ca4767](https://github.com/Millennium44/Toolasha/commit/3ca47673285d21b30b0437ae18e445b3f0e0e9f3))

### Performance Improvements

- **sim:** cache equipment totals and index buffs once per stat rebuild ([287dbc0](https://github.com/Millennium44/Toolasha/commit/287dbc0cf541837c834476d77e4450b71f6a6ced))
- **sim:** concurrent lab upgrade candidates, adaptive fan-out for combat ([35dfb58](https://github.com/Millennium44/Toolasha/commit/35dfb58feec486a5bc7c6559916ffdd226590436))
- **sim:** give batched candidates one worker each, measured against fan-out ([869d73d](https://github.com/Millennium44/Toolasha/commit/869d73d27feac0cc09b113726999886f1d67212c))
- split append-heavy history into per-period records ([5346f36](https://github.com/Millennium44/Toolasha/commit/5346f36e2f33944b293672fd71a4c36c43fd8c63))
- split the combat simulator into its own bundle ([3b84f5e](https://github.com/Millennium44/Toolasha/commit/3b84f5e0e1d9fb3c83a8cfed5ad8701883717140))
- **startup:** move two slow features off the critical path, and trace the rest ([399c6c8](https://github.com/Millennium44/Toolasha/commit/399c6c8e434b31ccc386cd60667df67edcb9fdd8))

### Documentation

- greasyfork listing body with fork summary and visible credits ([f5f81a0](https://github.com/Millennium44/Toolasha/commit/f5f81a039228c440d276a8933775bb0b3f32736c))
- restore the vendored MWI Combat Suite source ([2c142c2](https://github.com/Millennium44/Toolasha/commit/2c142c2f742b4a7dff6af335e8475533679e3c4b))
- rollup comments name the real bundle ceiling ([24c394c](https://github.com/Millennium44/Toolasha/commit/24c394cfbc758aa0f64c998806b49ede83ce0c11))
- vendor MWI Combat Suite with attribution ([0968e3f](https://github.com/Millennium44/Toolasha/commit/0968e3f16b71e1b6d86f4a500c692f49251e2fd8))

### Styles

- format files that drifted past lint-staged ([697085e](https://github.com/Millennium44/Toolasha/commit/697085eeb82c3b9145081f209f1ecaf66757972e))
- strip the labels off the ability books panel and centre tile icons ([8f2306f](https://github.com/Millennium44/Toolasha/commit/8f2306f51fdc218a7361a78ad893a71f7ec341fe))

### Tests

- **combat:** a recorded two-character party, and a claim it corrects ([bfb7047](https://github.com/Millennium44/Toolasha/commit/bfb7047d78091fb5a87f5628c9610c92e029961a))
- dungeon tracker, chat annotations, collections, and exports ([44b71c0](https://github.com/Millennium44/Toolasha/commit/44b71c0819d0f7929473f57f242dec790a22b446))
- replay a recorded fight, and fix what it exposed ([e63996b](https://github.com/Millennium44/Toolasha/commit/e63996b79e13b66b31cea0b02b6f9474e0f82b4e))
- storage estimate suite provides its own navigator on Node 20 ([bfaac7e](https://github.com/Millennium44/Toolasha/commit/bfaac7e70d92660b3fd9ea7f9f8150c12a4627f7))
- **ui:** build the combat level panel in a test ([94a5bbb](https://github.com/Millennium44/Toolasha/commit/94a5bbb63b1f6a3db2c2c000a6f1fd17c1ce73ab))
- variance fixtures, alchemy wrappers, and core util coverage ([09cc02a](https://github.com/Millennium44/Toolasha/commit/09cc02aaaf5010bee70f36616811637027b465c7))

### Build System

- dev). ([790a1bb](https://github.com/Millennium44/Toolasha/commit/790a1bbea59a63774f6bec46f0563c2e130307ef))
- move guild features from the ui library to the combat library ([d936240](https://github.com/Millennium44/Toolasha/commit/d936240edb29cb214ea75c0fdc0c35e4b7969449))

### Miscellaneous Chores

- raise the bundle ceiling to 3 MiB ([a52a717](https://github.com/Millennium44/Toolasha/commit/a52a717833d996e2ec2a02438497a90ff06f4570))

### Reverts

- restore the Sell Queue feature unchanged ([2687e28](https://github.com/Millennium44/Toolasha/commit/2687e285fe304ba5be065d105ef40f02d94b4a15))
- **sim:** house action buffs apply to combat again — live game does this ([1ad55b6](https://github.com/Millennium44/Toolasha/commit/1ad55b615701fb26a68e788c0d2c6d00200cefc4))

## [2.88.0](https://github.com/Millennium44/Toolasha/compare/v2.87.0...v2.88.0) (2026-08-01)

### Features

- **alchemy:** pin items in the item picker, per action ([1c16bff](https://github.com/Millennium44/Toolasha/commit/1c16bff0337ff50420b9b381a2efba6237045f36))
- **labsim:** stop each tab on the question it is asking ([981f015](https://github.com/Millennium44/Toolasha/commit/981f015bb44fb70332bcb3ec4fa9ba8bcf3bf69f))
- labyrinth results tracking, market history panel, battle panel scaling, alchemy pins ([#5](https://github.com/Millennium44/Toolasha/issues/5)) ([4232920](https://github.com/Millennium44/Toolasha/commit/423292043db49005a484e7c1cc809145decb9cb1))
- **labyrinth:** check skilling rooms too, and show what a floor is worth ([793019c](https://github.com/Millennium44/Toolasha/commit/793019cb5b6ff2dd2750ac8bba1e087b1a199118))
- **labyrinth:** combat experience figures, and a reachable logs tab ([791e199](https://github.com/Millennium44/Toolasha/commit/791e199cade83849abd1af09ef5430df621fd59a))
- **labyrinth:** count room attempts, and fix the beacon coverage tie-break ([cf5e0e7](https://github.com/Millennium44/Toolasha/commit/cf5e0e767758426493f2afeccf620539f6fb7ffb))
- **labyrinth:** decide skip-level probes instead of measuring them ([69e15c1](https://github.com/Millennium44/Toolasha/commit/69e15c1b5c4601868b4b992c6578e8ada2a82db4))
- **labyrinth:** distinguish a skip threshold set below the recommendation ([375c77a](https://github.com/Millennium44/Toolasha/commit/375c77a3367f0f662efda5f0e80e87a25b057f7c))
- **labyrinth:** live clear chance during combat rooms ([903f603](https://github.com/Millennium44/Toolasha/commit/903f603968163e7e7c48bbfe2ef8aa0d4bd752c2))
- **labyrinth:** log combat rooms and judge the sim against them ([41aff64](https://github.com/Millennium44/Toolasha/commit/41aff64eaa7ae6cbb0d13156e1a3c0b42f84d7a1))
- **labyrinth:** record real fight outcomes and check the sim against them ([2a02a9c](https://github.com/Millennium44/Toolasha/commit/2a02a9c292f9421140b938add0964f7377d5a7c9))
- **labyrinth:** replay the live fight for the combat clear chance ([830a118](https://github.com/Millennium44/Toolasha/commit/830a118a24d6650ce0f366710f25e66ca00fa6da))
- **labyrinth:** socket capture tool and a live combat clear-chance estimator ([f3e6169](https://github.com/Millennium44/Toolasha/commit/f3e616992d2831317c005d54003f5c6b3475410b))
- **labyrinth:** stop combat sims on precision instead of simulated hours ([7690ccc](https://github.com/Millennium44/Toolasha/commit/7690ccc64e5c219e96de52d55f2e0d4d1e0d6d4f))
- **market:** drag the Bulk Sell panel, and stop the run when it closes ([0f095ae](https://github.com/Millennium44/Toolasha/commit/0f095ae384135c775bb43108c72da8ed1e5a773d))
- **market:** let other scripts hold items back from Bulk Sell ([30961bb](https://github.com/Millennium44/Toolasha/commit/30961bb1f277fef16c1afca16f29ffd6d0d108d6))
- **market:** let other scripts mark Market History rows ([cdabaa1](https://github.com/Millennium44/Toolasha/commit/cdabaa16c28bf34aa9781bada289d5df728e43ae))
- **market:** open an item's marketplace page from Market History ([98acb92](https://github.com/Millennium44/Toolasha/commit/98acb92880ed023c523d7f36a8af01914d092052))
- **market:** price history panel, adapted from mooket II ([a10db41](https://github.com/Millennium44/Toolasha/commit/a10db41617091b251b2086f965d05138a2a753e9))
- **market:** quieten the sidebar badge, and mark live listings ([c8aedde](https://github.com/Millennium44/Toolasha/commit/c8aedde56aae7d34edb7a1ae1704662b7086c766))
- **market:** toggle the history panel from a tab, and one switch for the pool ([1999f49](https://github.com/Millennium44/Toolasha/commit/1999f499fb76755cb8072214cea4f0ca252970e4))
- payback, repay time and rank scoring in the upgrade advisor ([5deaf86](https://github.com/Millennium44/Toolasha/commit/5deaf86bad3b579e2900601a300393606976a34b))
- resize from either side, rename Payback to Time, widen score default ([4e4bfe4](https://github.com/Millennium44/Toolasha/commit/4e4bfe494169799c89892c5f20f78f48c2d1fd41))
- sticky headers, more upgrade columns, configurable Score ([7b821c2](https://github.com/Millennium44/Toolasha/commit/7b821c2ebe40c136afe42b0a2437d9fd47a3425a))
- **ui:** close the Bulk Sell panel, and toggle the net worth chart ([a2dfe6c](https://github.com/Millennium44/Toolasha/commit/a2dfe6c0d5282bc1620927150fe5b3ad1201237b))
- **ui:** resize the battle panel from settings, per character ([f5fe328](https://github.com/Millennium44/Toolasha/commit/f5fe328af1e0ee54b11a5c848a36fc644bf5d266))

### Bug Fixes

- **actions:** decide bar width from the action queue, not the header text ([8e09615](https://github.com/Millennium44/Toolasha/commit/8e09615248d095502a039014adb16b386de62760))
- **actions:** keep annotations out of the parsed action name ([d5cf297](https://github.com/Millennium44/Toolasha/commit/d5cf2972ffd4dfa062ec61b1429a16bb08c9ab3a))
- **alchemy:** find the item picker by structure, not by a label ([a87191d](https://github.com/Millennium44/Toolasha/commit/a87191d4bf721834ef4c4e72060c4909a5f13a64))
- **alchemy:** identify the item picker by what was clicked ([802f5b2](https://github.com/Millennium44/Toolasha/commit/802f5b259e361215570b0a56399e455844a77594))
- **alchemy:** keep the Remove cell at the front of the grid ([3a65c0a](https://github.com/Millennium44/Toolasha/commit/3a65c0a2e56f61e81345fd19c43e8f8edc54aa3a))
- **alchemy:** pin every tile, not just the first ([31ed31f](https://github.com/Millennium44/Toolasha/commit/31ed31f1c626c9e26b645f80eaa8c4772fcf3431))
- **alchemy:** stop the reorder displacing the Remove cell ([c4b4bbf](https://github.com/Millennium44/Toolasha/commit/c4b4bbf95d1b9f92900803f4cfee4ab29c6ef1bc))
- **combat:** drop the battle counter when the action changes ([08150d1](https://github.com/Millennium44/Toolasha/commit/08150d10173f34b7f2aad0d25bf5901dc18d660b))
- easier panel resize, narrower upgrade columns, stable Columns menu ([4064228](https://github.com/Millennium44/Toolasha/commit/40642280a06b6965dd375736b56cb458899b272c))
- **guild:** drop leaderboard readings that repeat the last one ([97ff6f0](https://github.com/Millennium44/Toolasha/commit/97ff6f0a338d7b803b90d9b0ea6551f16c8b3b7b))
- **guild:** expose debugState through the module's feature interface ([dd99e82](https://github.com/Millennium44/Toolasha/commit/dd99e825044eee732f3c95d1fc483a50cf3f4950))
- **labyrinth:** charge combat rooms for the walk to them too ([6cea453](https://github.com/Millennium44/Toolasha/commit/6cea453566a264c0e7759614285c0c43b7ffe69c))
- **labyrinth:** charge room travel once, not once per attempt ([1712c95](https://github.com/Millennium44/Toolasha/commit/1712c9524f6ba487eaa1f9a741c9339c9e416573))
- **labyrinth:** count the wins the accuracy record was blind to ([36c1bd0](https://github.com/Millennium44/Toolasha/commit/36c1bd029599574dbb7a06bce7e09dab2f48c70f))
- **labyrinth:** credit a room's experience when it actually arrives ([54747d7](https://github.com/Millennium44/Toolasha/commit/54747d765fedc88934f9143d1aaa04590b12859b))
- **labyrinth:** detect a retried fight, and stop the clear chance flickering ([5cd21c4](https://github.com/Millennium44/Toolasha/commit/5cd21c45200d2900eceadbaaa82e321e21a8c56a))
- **labyrinth:** find combat fields by diffing payloads, not by guessing names ([e0fbffa](https://github.com/Millennium44/Toolasha/commit/e0fbffa04087b64a683f790a454c269d2f6227bf))
- **labyrinth:** load the fight record for anything that reads it ([9d57e7f](https://github.com/Millennium44/Toolasha/commit/9d57e7fa70e3e28ea4df21316108781a65a9197c))
- **labyrinth:** make skip-level decisions conservative, not just fast ([32cba6d](https://github.com/Millennium44/Toolasha/commit/32cba6dd48e1a11590a9b08474a3c0f7d64cc6db))
- **labyrinth:** move the attempt badge off the ETA, exempt battle_updated from dedup ([1702e12](https://github.com/Millennium44/Toolasha/commit/1702e12fd78031087829f60b7c48c033fe574573))
- **labyrinth:** pay combat rooms on completion, and show the full card ([ffdcb7d](https://github.com/Millennium44/Toolasha/commit/ffdcb7d16024bac7a1579388d1cab54c341c652d))
- **labyrinth:** plan a set beacon count for coverage, not a corridor ([748cb38](https://github.com/Millennium44/Toolasha/commit/748cb389e24673f54dc6418f4b5a1ee2d2f0eee9))
- **labyrinth:** read the current room from the head of the path queue ([2881d3e](https://github.com/Millennium44/Toolasha/commit/2881d3efe611af5377abdd13daefc3bd63c7133a))
- **market:** move the History tab last, and mark panel tabs as panels ([14e08eb](https://github.com/Millennium44/Toolasha/commit/14e08eb03f11e2f13880877d039110efab3a5bd9))
- **market:** redraw an open history table when a marker registers ([f8442ff](https://github.com/Millennium44/Toolasha/commit/f8442fff738fb8a5753f1bd8e2c0f07484216d45))
- quote gold-per at 0.01%, correct the Payback tooltip ([e965415](https://github.com/Millennium44/Toolasha/commit/e9654156ece0c3e5887667fc69af849a855136b5))

### Code Refactoring

- **labyrinth:** put skilling experience per hour on the same basis as combat ([1da9d7f](https://github.com/Millennium44/Toolasha/commit/1da9d7f78cb2c18a886864db743217683eea93ff))
- **market:** drop the My Listings marker setting ([e82da7f](https://github.com/Millennium44/Toolasha/commit/e82da7fc1d7423d9e5f1b2aea2e75939685a57d1))

### Documentation

- credit dakonglong for the labyrinth simulator ([6d5bd95](https://github.com/Millennium44/Toolasha/commit/6d5bd95a591ec0c03c68a415c824410060d12992))
- credit jigglymoose for JIGS ([28162e6](https://github.com/Millennium44/Toolasha/commit/28162e641d1375d11748ddb32c95f928586556a5))
- reword the JIGS credit to thank jigglymoose for ideas ([1a2d26f](https://github.com/Millennium44/Toolasha/commit/1a2d26fa385b798e91eba0f3cb9fe77f6703cc8d))
- track the third-party attribution file ([570de12](https://github.com/Millennium44/Toolasha/commit/570de12cb42041ac244851e4cb9c6db6caff20f6))

### Styles

- **labyrinth:** say "Attempt [#2](https://github.com/Millennium44/Toolasha/issues/2)" in the room header ([b62f162](https://github.com/Millennium44/Toolasha/commit/b62f16226e712e2be2066ddc674cab5ccfe54b43))

### Reverts

- "fix(alchemy): stop the reorder displacing the Remove cell" ([28aaea7](https://github.com/Millennium44/Toolasha/commit/28aaea74cb0de3c5dcdb6b920a2084826975d9e8))

## [2.87.0](https://github.com/Millennium44/Toolasha/compare/v2.86.0...v2.87.0) (2026-07-30)

### Features

- add a Clear button for the labyrinth path and beacon overlays ([e23efae](https://github.com/Millennium44/Toolasha/commit/e23efaea6effd374a0b91e23c847f0c3532c455d))
- always sim Anchorbound and style-matched top-tier armor in Lab Sim ([0439b52](https://github.com/Millennium44/Toolasha/commit/0439b5238bc9075edcfcf1193a7ab9c4ab1bce03))
- cape swaps take the better level and include refined variants ([9197ff2](https://github.com/Millennium44/Toolasha/commit/9197ff209a50d6658d13b7d44f23dc3d4fc67559))
- expandable lab cost breakdown; price forced swaps as additions ([248e095](https://github.com/Millennium44/Toolasha/commit/248e095bc7f99f0538d4d4003c3c1502d3b8a3ba))
- offer both the style cape and the melee cape, at equal enhancement ([986be4f](https://github.com/Millennium44/Toolasha/commit/986be4f320d8f0f213d2f39ae2c0d826ea128a65))
- pick magic armor per element from the weapon and the spells ([68a4ab5](https://github.com/Millennium44/Toolasha/commit/68a4ab5f2786cbe41895154f0f22f93b2dfc0a00))
- remember panel sizes dragged with the game's dividers ([b20b182](https://github.com/Millennium44/Toolasha/commit/b20b1820ae848e092bbf52f294e54323ba644cb4))
- sim the weapon in the spells' element alongside its robes ([74410a1](https://github.com/Millennium44/Toolasha/commit/74410a1e56187eca2c772172c83014498a45849b))

### Bug Fixes

- armor pairs were deduplicated away; single swaps duplicated ([7d868a3](https://github.com/Millennium44/Toolasha/commit/7d868a3fc926ca9733891b9f0d6fa49cdb3e459f))

## [2.86.0](https://github.com/Millennium44/Toolasha/compare/v2.85.0...v2.86.0) (2026-07-30)

### Features

- add Open Item Dictionary to ability action menus ([386b282](https://github.com/Millennium44/Toolasha/commit/386b28229dc40ede128f3363b1b6774884184511))
- always offer Philosopher's accessories at +5 in upgrade advisors ([aa3d07e](https://github.com/Millennium44/Toolasha/commit/aa3d07e4e6b6aa4d6006a51fc6ae6bcb44eb26a7))
- anchor the food search at equipped tiers and step down ([70fff27](https://github.com/Millennium44/Toolasha/commit/70fff27047f5ab087d7442ad117fb216e73a1491))
- bulk sell defaults off, tab-bar button styled as native tab ([82b4e36](https://github.com/Millennium44/Toolasha/commit/82b4e365deb38064046842c03c481733a51fa6b7))
- bulk sell minimum stack value for a sell listing ([3f8113c](https://github.com/Millennium44/Toolasha/commit/3f8113cc4cb326bd7197640d400f3285128c29b2))
- bulk sell vendors stacks when market nets no more than vendor ([4f3789f](https://github.com/Millennium44/Toolasha/commit/4f3789f672fadb645d2875fa4d5add9ae6c73e80))
- include hidden-status members in the guild idle list ([aa093eb](https://github.com/Millennium44/Toolasha/commit/aa093eb4aa1dc7dd87781f9e08d90f3dc8a51f12))
- multi-select upgrade sets, house and food candidates, seed toggle ([62ad44b](https://github.com/Millennium44/Toolasha/commit/62ad44bde6b14df2039c0d7cda84cbebdc53c981))
- per-room house targets; group controls with their checkbox ([08789a9](https://github.com/Millennium44/Toolasha/commit/08789a99346117bb5487fe936275a8b289a4b15f))
- remember the Solo/Zone estimate mode and honor it everywhere ([4266659](https://github.com/Millennium44/Toolasha/commit/42666598b2367bc32b0db82cc8a8c8bc17c0ac93))
- separate combat level results; warn about Ability Swaps ([ecb1bb0](https://github.com/Millennium44/Toolasha/commit/ecb1bb037514c0f6724ee63fac1358a9e5bee4c0))

### Bug Fixes

- count encounters, not kills, in the task zone fight estimate ([bf39a11](https://github.com/Millennium44/Toolasha/commit/bf39a1177c2684e5c94a4c8a7dcc8b6e4c2c89de))
- default guild idle list off, add raw member data sampler ([11d7f1e](https://github.com/Millennium44/Toolasha/commit/11d7f1eb7a655d1b7cd4941d60ea01470c94c9d8))
- detect ability menus without relying on class names ([1e93f32](https://github.com/Millennium44/Toolasha/commit/1e93f3209b23aeb318ce8b5cfd2559999f62c1ae))
- drop experience buff from labyrinth upgrade comparison ([1f9df60](https://github.com/Millennium44/Toolasha/commit/1f9df60d30a0d8a2e9fc64118d97702b6c17ccb6))
- expose getRawMemberSample on the guild tracker feature wrapper ([79e09a4](https://github.com/Millennium44/Toolasha/commit/79e09a4a93421eea54b4e18c74dd99a4e360bbc5))
- food search keeps food types per slot and treats mana as a hard rule ([fe174ee](https://github.com/Millennium44/Toolasha/commit/fe174eecfe00aa80078da3b78f36f352f2f829f9))
- house upgrades produced no candidates; add a target level ([cc82ace](https://github.com/Millennium44/Toolasha/commit/cc82ace034d598760b166ae02f50bf06b7fae10b))
- minimize food slots sequentially so shared mana budgets hold ([e330030](https://github.com/Millennium44/Toolasha/commit/e330030dc7fe4a904f969404b0c59d5b4e557ba5))
- normalize Go zero-time inactiveTime in guild member data ([53797d2](https://github.com/Millennium44/Toolasha/commit/53797d21000800916a5347904446fa46dff5d754))
- pick the estimate zone shared by the most active tasks ([d550cd6](https://github.com/Millennium44/Toolasha/commit/d550cd6b8e0568f87ca5d3540c2eb41f7e989918))
- run vendor check before marketplace navigation ([bb6a16e](https://github.com/Millennium44/Toolasha/commit/bb6a16ea37504334a0170705e92c11755e90f06a))
- skip same-tier sidegrades; drop duplicate encounter counter ([7bdb4da](https://github.com/Millennium44/Toolasha/commit/7bdb4dab420ae4fb41ec800bc5b2f44d372bcdb4))
- unknown upgrade costs no longer rank as the best-value upgrade ([43430bc](https://github.com/Millennium44/Toolasha/commit/43430bc7106d7aa7a0c0c23f548aee39bbcf1902))
- vendor check uses the market path the rules would take ([9dcf957](https://github.com/Millennium44/Toolasha/commit/9dcf95760288b272b313b8e3bc2cc02b916c2f3a))
- wire guild idle list to actionType, re-enable by default ([4cf46c0](https://github.com/Millennium44/Toolasha/commit/4cf46c0b194f7d4087d67e3332f62fd3d5828a76))
- zone summary shares sims, sums duplicate tasks, groups by spawns ([eed3401](https://github.com/Millennium44/Toolasha/commit/eed3401284a57b39da73eb5c2e34c0bf3d2a7d4c))

### Miscellaneous Chores

- merge upstream Celasha/Toolasha (guild idle list, drop fixes) ([3ff45d5](https://github.com/Millennium44/Toolasha/commit/3ff45d5b91454e6c4a52c514d00a7c1252b17a3a))

## [2.85.0](https://github.com/Millennium44/Toolasha/compare/v2.84.0...v2.85.0) (2026-07-29)

### Features

- **actions:** add profit to loot log stats ([0a8cebe](https://github.com/Millennium44/Toolasha/commit/0a8cebe7cf3a85c5f2386d7bac26f27240bf1f5a))
- add "Skip Back" toggle to combat sim upgrade analysis ([5375caf](https://github.com/Millennium44/Toolasha/commit/5375caf711e2bd61186ec64f6e13177c15f693ca))
- add Bulk Sell Assistant for one-click-per-item inventory selling ([621f337](https://github.com/Millennium44/Toolasha/commit/621f337c97164068d83dd536122fae3e81e9bbb5))
- add configurable number format mode and precision settings ([53349ba](https://github.com/Millennium44/Toolasha/commit/53349bacc7d4b84a56285ebf661382fbd45ce313))
- add configurable whisper template for guild trial unsigned members ([f8cd052](https://github.com/Millennium44/Toolasha/commit/f8cd052aa0252aa0fc6b7e07fb969f86a7b3709a))
- add Copy List button to guild trial signup modals ([c60b883](https://github.com/Millennium44/Toolasha/commit/c60b88345846320592a50a44f2b7b96e548199c9))
- add cost summary block to production action panels ([655dfd2](https://github.com/Millennium44/Toolasha/commit/655dfd2b2c3140db9efbebc1de8620505d00af59))
- add current action profit display to action bar ([9f4a5a4](https://github.com/Millennium44/Toolasha/commit/9f4a5a408619c8cda3e78391d0811df7e5910610))
- add default loadout setting for combat sim estimates ([7f7d2fa](https://github.com/Millennium44/Toolasha/commit/7f7d2fab6051d11d91ebe4cb180e3fec162d846c))
- add draggable modals with remembered position ([5d41e5a](https://github.com/Millennium44/Toolasha/commit/5d41e5a4e3d315d1e479908f2e26efa13dd7279f))
- add drink timer to skill panel consumables section ([08409f2](https://github.com/Millennium44/Toolasha/commit/08409f2ce281a7a00ec7cfbd4fb1b612f392f6d3))
- add exchange advisor to guild credit modal ([66d11b5](https://github.com/Millennium44/Toolasha/commit/66d11b5e5a09b261642df3b2ad14d3452ee2c259))
- add Expand All / Collapse All buttons to Custom Tabs ([8d4e367](https://github.com/Millennium44/Toolasha/commit/8d4e367c2fe1c31b42231e8379b7099246f7054c))
- add global reroll-at-cap protection to task reroll protection ([e0aef30](https://github.com/Millennium44/Toolasha/commit/e0aef30b3a19437f60a4356e8b3cf188985f0eb7))
- add gold cost per credit table to guild credit exchange modals ([5af726c](https://github.com/Millennium44/Toolasha/commit/5af726c4217ed0a5bef51119abe68caf8f92ea66))
- add guild activity calculator and simulator ([955c78e](https://github.com/Millennium44/Toolasha/commit/955c78e3242b550158934d98f1db2ab63d1354c6))
- add item icons to pinned actions overview tab ([e980a16](https://github.com/Millennium44/Toolasha/commit/e980a1618c6a392fb2273e69e8b4757eb1adc08d))
- add listing refresh navigator to My Listings page ([107c118](https://github.com/Millennium44/Toolasha/commit/107c11877a34cd2315e8a94255fc6d833a28a3c3))
- add mana run out, debuff on level gap, and wipe event log to combat sim results ([0a8fbd9](https://github.com/Millennium44/Toolasha/commit/0a8fbd9dc016720d351bd026217594ea249872a8))
- add max threads setting for combat simulator ([4f8105c](https://github.com/Millennium44/Toolasha/commit/4f8105c5931103258a29a3badb597ad27d18630e))
- add missing mats marketplace button to shrine upgrade cost table ([89f51bc](https://github.com/Millennium44/Toolasha/commit/89f51bc02fcd1d6684aa45f19f34eff7084f0043))
- add missing mats marketplace tabs to shrine upgrade modal ([3656e84](https://github.com/Millennium44/Toolasha/commit/3656e843fd44210d7fad91f86fcfe62b288f358d))
- add net worth pricing mode setting (ask/bid) ([4b0026e](https://github.com/Millennium44/Toolasha/commit/4b0026e9c15f7195ccd7e09a41326db40c974057))
- add option to hide Guild notification badge in sidebar ([a75e91f](https://github.com/Millennium44/Toolasha/commit/a75e91fe25f397773bf880aa71467719b7955234))
- add per-character selector to Copy Settings button ([507501b](https://github.com/Millennium44/Toolasha/commit/507501b14163781703be0fd73bb170fc2fc43841))
- add per-column toggles and tab routing for guild Members columns ([7841384](https://github.com/Millennium44/Toolasha/commit/78413843607b00404a4f2f3ff5c8a743c68ef12a))
- add per-player DPS to combat sim results ([65b564d](https://github.com/Millennium44/Toolasha/commit/65b564d91c68fa5640eb72829cb3300f8f810aea))
- add Protection sort mode to task sorter ([f160f54](https://github.com/Millennium44/Toolasha/commit/f160f548e66cda38d68c41b8313bcec3ee6aad36))
- add Sell Queue — Shift+RightClick inventory items to sell ([c38aa7b](https://github.com/Millennium44/Toolasha/commit/c38aa7b8ae918e6c070184e758f0cca9503d4afd))
- add shrine upgrade cost table and ask/bid columns to guild credit modals ([501cc92](https://github.com/Millennium44/Toolasha/commit/501cc92a0d94aa6258ae6357c200b1ac14c64d8e))
- add shrine upgrade planner to guild credit exchange panel ([783a04a](https://github.com/Millennium44/Toolasha/commit/783a04a0639c52931dc2c98c2b005e73c2ae0e82))
- add Skilling Simulator and Optimizer tab to character panel ([3318f48](https://github.com/Millennium44/Toolasha/commit/3318f48634cce30a4f3338deb999213128f2d4f8))
- add sortable Progress column header to My Listings table ([3b1191e](https://github.com/Millennium44/Toolasha/commit/3b1191ee06a15e3ef0987deeec51ff1b64b85a69))
- add zone mode for combat task estimates with multi-task aggregate ([91dc511](https://github.com/Millennium44/Toolasha/commit/91dc51114282402f130a9812b752813589ebc55f))
- **alchemy:** add profit columns to coinify and decompose history ([eaf5c79](https://github.com/Millennium44/Toolasha/commit/eaf5c79545db1883ef13d56857a20e60b7a66408))
- auto-advance to next sell queue tab when item sells out ([0ffb3e6](https://github.com/Millennium44/Toolasha/commit/0ffb3e6933a2621b4cdda17ebc77e54ecc55b715))
- auto-fill enhancement target level from settings ([54dfa65](https://github.com/Millennium44/Toolasha/commit/54dfa659813313e240f88550889af1ecefb9b16a))
- auto-fill optimal protect-from level when protection item is set ([7b44dba](https://github.com/Millennium44/Toolasha/commit/7b44dba83598026aa7121a6a35359c5f9273464e))
- auto-run combat estimates when task cards appear ([6727c0f](https://github.com/Millennium44/Toolasha/commit/6727c0fd6298f9571a7f013586c3164c3d10f049))
- bulk sell filter for a specific Toolasha inventory tab ([9bf1591](https://github.com/Millennium44/Toolasha/commit/9bf1591ae5624f93016e02fee1b8fd6bf57492f2))
- bulk sell in the tab bar, most expensive items first ([9b98be2](https://github.com/Millennium44/Toolasha/commit/9b98be2f1f9bc0edb86e850021128508a13e5070))
- bulk sell keeps items assigned to tabs above the selling tab ([9b4ed7a](https://github.com/Millennium44/Toolasha/commit/9b4ed7aa4dbb52faf90415ffe3ba742a4320ef23))
- bulk sell placement toggle, stack-value order, timing settings ([7d8d800](https://github.com/Millennium44/Toolasha/commit/7d8d8000b88047e973bd2c99320d1517caac61cc))
- bulk sell toggle button opens panel, decision rule settings ([b5d6ccc](https://github.com/Millennium44/Toolasha/commit/b5d6cccb0cd9f64120eb0a22ebc0d0d8e271f82a))
- **combat-sim:** add ability swap mode to lab sim upgrade analyzer ([fcaaeb9](https://github.com/Millennium44/Toolasha/commit/fcaaeb939a239d106756a8f4c71073ad64a1088e))
- **combat-sim:** add combat trigger editor to sim loadout editor ([1d6b014](https://github.com/Millennium44/Toolasha/commit/1d6b014999fff0db3775151ee24596cb8c8f0499))
- **combat-sim:** all-fights combat level analysis for the labyrinth ([5a205fe](https://github.com/Millennium44/Toolasha/commit/5a205fed3e5ed34d355ed7757c05ea63fd4ff1aa))
- **combat-sim:** charm tier dropdown, levels-first controls, main-skill time ([124219a](https://github.com/Millennium44/Toolasha/commit/124219af22b23cf9bda7992f6b7ec3c639f829b5))
- **combat-sim:** charm-swapped XP rates and per-skill targets ([2932fcc](https://github.com/Millennium44/Toolasha/commit/2932fcc4a7bddc8b0cfe1f592740c2424ce59238))
- **combat-sim:** combat level advisor mode ([fc01f38](https://github.com/Millennium44/Toolasha/commit/fc01f3846c0040b503304f10968ebf2461fa8309))
- **combat-sim:** combat level advisor time-to-level, charm selector, columns ([24100f3](https://github.com/Millennium44/Toolasha/commit/24100f3adb7e2c8f2aed62c9a0194f67562ed71e))
- **combat-sim:** lab sim ability upgrades; lab calc bar and auto-calc on load ([d4e3b6b](https://github.com/Millennium44/Toolasha/commit/d4e3b6bea87c7d33b31ad85d7e931cdb1bc5ff70))
- **combat-sim:** lab sim per-skill targets, attempts-based all-fights metric ([9662d63](https://github.com/Millennium44/Toolasha/commit/9662d63e91299787d1c1fe378bc719633dcc06ad))
- **combat-sim:** model strongest-source buff stacking with expiry fallback ([096ea52](https://github.com/Millennium44/Toolasha/commit/096ea524c54abdfe08b3b7ad99e9225413038977))
- **combat-sim:** per-ability targets, skilling tab scroll, analyzer tooltip ([954c9c9](https://github.com/Millennium44/Toolasha/commit/954c9c9c81fdc1dc6f464ed60001fec9ed95608e))
- **combat-sim:** refined upgrades at +10, combined upgrade view, compact-width guard ([420a08d](https://github.com/Millennium44/Toolasha/commit/420a08ddec42b75ce3fa7ba8100c50a4971f1d56))
- **combat-sim:** skip refined equipment recommendations below +10 ([a7d53ad](https://github.com/Millennium44/Toolasha/commit/a7d53ade83a5f6c64edd05b9d284d7b2756a7e93))
- **combat-sim:** skip-level room levels, bump-to-improvement, collapsed loadouts ([276a785](https://github.com/Millennium44/Toolasha/commit/276a7852218dabacdba5cca7bee0451dd6615419))
- **combat:** labyrinth attempt counter and whole-tile hover previews ([59d516e](https://github.com/Millennium44/Toolasha/commit/59d516eef25c07582413fc73248816e19613008c))
- **combat:** labyrinth tile controls use Sim Hours instead of trials ([a10368f](https://github.com/Millennium44/Toolasha/commit/a10368fa5a6ebeb2ce9e4711143755b0de5b57d3))
- **combat:** labyrinth what-if previews, max floor, and room action logs ([8eb8e5f](https://github.com/Millennium44/Toolasha/commit/8eb8e5f04a16665bc7f9a46194cd67aebce2e111))
- **combat:** per-tile clear chance overlays on the labyrinth run grid ([a29afc0](https://github.com/Millennium44/Toolasha/commit/a29afc0197b0bb9cb385dc6423731f7392ac87ff))
- **combat:** reference-style labyrinth tile previews with correct EXP ([8353997](https://github.com/Millennium44/Toolasha/commit/83539973653bd5e6d3c17c831d3c1af3ef895f4a))
- **combat:** restyle labyrinth tile controls and badges to match reference ([2881cd1](https://github.com/Millennium44/Toolasha/commit/2881cd12dc9b99f9157f3789b222422f422568ae))
- consolidate lab sim inputs into Configure tab with auto-loadout ([7cb624e](https://github.com/Millennium44/Toolasha/commit/7cb624e89db01aa0a6f43c33fa001932ef7b7631))
- **labyrinth:** all-fights analysis sims at skip levels by default ([7e512bc](https://github.com/Millennium44/Toolasha/commit/7e512bc268d585fbd79edbd79de47fd385ed2911))
- **labyrinth:** beacon placement planner ([194e2ca](https://github.com/Millennium44/Toolasha/commit/194e2ca9fdb6d12b615382a19f98c342c3a499e2))
- **labyrinth:** beacon planner prefers multiple independent routes ([e08611e](https://github.com/Millennium44/Toolasha/commit/e08611e37385016ad69cb19f57827a3f60e9474f))
- **labyrinth:** optimal path planner to the floor exit ([13eabcf](https://github.com/Millennium44/Toolasha/commit/13eabcfebcf0a5eb615573669d998440f275ffb8))
- **labyrinth:** preconfigured lab sim on tile right-click, recommended skip autofill ([c229903](https://github.com/Millennium44/Toolasha/commit/c229903e38764fde4178692a6dabbf67a2785f24))
- **labyrinth:** unrevealed-room mode for the path planner ([6b2c8a9](https://github.com/Millennium44/Toolasha/commit/6b2c8a9351c4f1c94a30f217ee3cf7ac5a555be7))
- make all My Listings table headers sortable ([81f1a54](https://github.com/Millennium44/Toolasha/commit/81f1a54e5817f60c25aae4f183a7355ab2db79a2))
- **market:** price untradable refined capes at refinement material cost ([7cbb7cd](https://github.com/Millennium44/Toolasha/commit/7cbb7cdee2038b4c7abf372d09816101bece78e2))
- overhaul skilling optimizer to show loadout-relative progression ([efb990f](https://github.com/Millennium44/Toolasha/commit/efb990f21a67ab5de8fe80f5454987b7bb1aa810))
- philo calculator refined-cape pricing + transmute history profit ([4242286](https://github.com/Millennium44/Toolasha/commit/4242286bb35ac60a01eb3980bdb8f1adf1b8793b))
- prefix queue completion times with date when not today ([ebab9d2](https://github.com/Millennium44/Toolasha/commit/ebab9d2c57590f97f5c8b1750ab2e6b28803e69e))
- reroll stepper one click per action, chat announcement names ([47e3c4f](https://github.com/Millennium44/Toolasha/commit/47e3c4f82f1ac01192f2313de0119b2966ab4710))
- show efficiency rating on combat task estimates ([d86a727](https://github.com/Millennium44/Toolasha/commit/d86a7273c2ac186e1fa8ce335a1534f5d98a9b75))
- show tier label on guild trial tiles ([5692a3e](https://github.com/Millennium44/Toolasha/commit/5692a3e0af918805c106cf94b5831773f73c726f))
- show unsigned trial members list in guild Trials tab ([2fc01ce](https://github.com/Millennium44/Toolasha/commit/2fc01ceb574df0fe311a3e6a13e283f4507e3dec))
- task bulk reroller, per-character limits, zero-limit glow rule ([8f9cbc2](https://github.com/Millennium44/Toolasha/commit/8f9cbc2d1ab6a0b923e8905752e77a68ccfb57ce))
- **tasks,combat-sim:** edge-only protection highlight, style-filtered combat levels ([8531bb9](https://github.com/Millennium44/Toolasha/commit/8531bb96132f65ad7b9d981e7b0b0a10f65f6d4b))
- use session-based XP/hr for combat skills ([2494e52](https://github.com/Millennium44/Toolasha/commit/2494e52d5cea024baf55a50b12157bb4cdf02afd))

### Bug Fixes

- action panel button labels resetting to defaults on page reload ([67ad2a3](https://github.com/Millennium44/Toolasha/commit/67ad2a3548871764bdca10591c090ce7a1c18a88))
- add "Move to bottom" button in custom tab editor ([e47b4cb](https://github.com/Millennium44/Toolasha/commit/e47b4cb396e80fc4ba5c119c931817765f94f904))
- add action speed & time breakdown to task profit display ([5ede675](https://github.com/Millennium44/Toolasha/commit/5ede675adba889f15c5c624e1d1e2e2b54453252))
- add Activity column to guild Contributions tab ([7c70384](https://github.com/Millennium44/Toolasha/commit/7c703843a88466bfeadb7321c72a274d29710539))
- add alchemy action profit to queue tooltip and action bar ([371c236](https://github.com/Millennium44/Toolasha/commit/371c236f15584ae21316158ac16568b60429b83e))
- add clickable ask/bid column sorting to guild credit modals ([739f516](https://github.com/Millennium44/Toolasha/commit/739f516a1516129fb99dcd2ec70ee3f8ef023ac4))
- add configurable thresholds to cap reroll protection ([1fb551c](https://github.com/Millennium44/Toolasha/commit/1fb551c4478e4238eae13e1668f16a1c501a9343))
- add diagnostic logging for listing N/A display bug ([f01aed3](https://github.com/Millennium44/Toolasha/commit/f01aed3cd99054d0ea9c260f013a7b734eef68a5))
- add effective (after-tax) price display to item tooltips ([10c1cf7](https://github.com/Millennium44/Toolasha/commit/10c1cf77eaf39234f8f4738fd1f74f4ef7d9022c))
- add expand button to abilities & triggers panel to avoid scrolling ([40e68c7](https://github.com/Millennium44/Toolasha/commit/40e68c747267ff93cce4c6e5d1ef69eeb54741b9))
- add marketplace links to alchemy best items breakdown ([1a83a5d](https://github.com/Millennium44/Toolasha/commit/1a83a5d74c22ebc7944a8b48d85fd1ecc858b44d))
- add marketplace navigation links to alchemy best items ([48f85ae](https://github.com/Millennium44/Toolasha/commit/48f85aee814d2b5780d7f7a06c3746fe93087b3e))
- add missing Help channel to pop-out chat ([b497147](https://github.com/Millennium44/Toolasha/commit/b49714755c57e2a603ee615e12b34c60e3dbc4af))
- add pricing mode toggle and XP/hr to best crafting plan ([55b1912](https://github.com/Millennium44/Toolasha/commit/55b19126df2637cc13191640e5fc599c729862c6))
- add setting to disable task speed & time breakdown ([363582e](https://github.com/Millennium44/Toolasha/commit/363582ed1efc77350fe0645d8c52623922e4dfe3))
- add setting to hide combat estimate on task cards ([569fcdb](https://github.com/Millennium44/Toolasha/commit/569fcdb95b00bae29f8b4f01a79ada307900a1b0))
- align move buttons in tab editor by rendering hidden placeholders ([e57d6aa](https://github.com/Millennium44/Toolasha/commit/e57d6aa6c660f5b75d33232bd74c44e951c8962b))
- always initialize max-produceable feature regardless of setting ([a4c0198](https://github.com/Millennium44/Toolasha/commit/a4c0198cce5bfddb875c436109c0212c1150d5fd))
- always show ×count in item tooltip price line ([17ed970](https://github.com/Millennium44/Toolasha/commit/17ed9701e475ab6a6e481e726b8043a55d74928f))
- apply correct dungeon chest quantity formula in combat sim ([3662b7c](https://github.com/Millennium44/Toolasha/commit/3662b7c9052a0b7fb2c074a95c0f41333bcd724e))
- apply Custom Tab drag-drop layout before debounced save ([cf80e06](https://github.com/Millennium44/Toolasha/commit/cf80e064d42c611a8ff1c6f287e8718defb2fa95))
- apply verified deep-dive fixes across all subsystems ([7dd493e](https://github.com/Millennium44/Toolasha/commit/7dd493e8e760a14fe5eb1d3f83cc5e426e446683))
- calculate enhancement time correctly when using Philosopher's Mirror ([60b1f2a](https://github.com/Millennium44/Toolasha/commit/60b1f2afb672a45e556b4421342b74195139dc6c))
- calculate task gold/hr using total task time instead of time remaining ([09a6168](https://github.com/Millennium44/Toolasha/commit/09a61687d0751dc4333a583c391977c9b4cf91ba))
- capitalize monster names and show recommended skip in lab sim results ([3a0a689](https://github.com/Millennium44/Toolasha/commit/3a0a689b70b8d2f9a86b0d2229731e5f17379a75))
- clean up history buffers and observers when chat extender is disabled ([53f8ce5](https://github.com/Millennium44/Toolasha/commit/53f8ce502491f6ebf0f21cc28af571d6ce21eb38))
- clear battle counter when switching from combat to skilling ([1047c0b](https://github.com/Millennium44/Toolasha/commit/1047c0bbb42c55d679e0368e9d21eeb024dd0e33))
- clear labyrinth attempt flag when entering regular combat ([6722bd8](https://github.com/Millennium44/Toolasha/commit/6722bd8ebdf912c891454e3026ae36c670185cad))
- **combat-sim:** exempt capes from the refined +10 minimum ([7b268d0](https://github.com/Millennium44/Toolasha/commit/7b268d0e1e4ed31e67e667dd0c6e0cca24e1daad))
- **combat-sim:** keep ability triggers when simming ability level upgrades ([6e6d222](https://github.com/Millennium44/Toolasha/commit/6e6d222c35f14b9dbdaf4795c61173a9fb0478bd))
- **combat-sim:** keep Attack in Combat Levels for all weapon styles ([b26c4ff](https://github.com/Millennium44/Toolasha/commit/b26c4ff5f07700d900c27dfdb0d4dde99b4efd22))
- **combat-sim:** price enhanced tier targets like enhancement candidates ([dc9be56](https://github.com/Millennium44/Toolasha/commit/dc9be568ddbdfbea988cfa4ba3d2313411460f20))
- **combat-sim:** refined upgrade costs, sortable results, auto tile calc ([7e56eec](https://github.com/Millennium44/Toolasha/commit/7e56eecf1ac96398aa5bba6e4c9a215f0dc5558d))
- **combat-sim:** unsquish upgrade controls, offense-only main time, cleaner table ([7bbefc9](https://github.com/Millennium44/Toolasha/commit/7bbefc9b17a460437d79db8d00ca3dc61b60a8c0))
- **combat:** battle counter picks Attempt vs Battle from the header title ([61fd1a9](https://github.com/Millennium44/Toolasha/commit/61fd1a934b09c1013e4229158839879e2a6988cf))
- **combat:** keep labyrinth live clear chance visible between actions ([078b0fe](https://github.com/Millennium44/Toolasha/commit/078b0feb430fd3259d91ccb9b8e27b380968fc5b))
- **combat:** place labyrinth calc bar top-left and clear badges on cleared rooms ([60c4de9](https://github.com/Millennium44/Toolasha/commit/60c4de915d94038624d5f33644080c3cc35b0e38))
- **combat:** read labyrinth grid from React state so calc bar shows on load ([54419d1](https://github.com/Millennium44/Toolasha/commit/54419d10f919bb003d73ffd4d05f1e31dc834214))
- **combat:** retry labyrinth combat tile sims that run before data is ready ([b901f5c](https://github.com/Millennium44/Toolasha/commit/b901f5cf749ff723b89b91549fb8308faeabc759))
- compute upgrade advisor DPS from actual damage dealt instead of XP/hr ([cf83826](https://github.com/Millennium44/Toolasha/commit/cf83826bc534adfb1629e9458942c3ed56ab5553))
- **core:** wire feature cleanup teardown and repair settings accessors ([a703f0c](https://github.com/Millennium44/Toolasha/commit/a703f0c29e5a11857b2a44e9d23622c4121cd48e))
- correct alchemy action type detection and missing level progress ([5f51513](https://github.com/Millennium44/Toolasha/commit/5f51513185e1d4ee9a12d4808a1286bd3b27eb1c))
- correct Chance Cape (R) HRID in enhancement auto-detect ([463352d](https://github.com/Millennium44/Toolasha/commit/463352dd74f58c24424074c470833da1e66f3e30))
- correct efficiency in level calculator and Total time display ([419c4c8](https://github.com/Millennium44/Toolasha/commit/419c4c822ade9ec6c18db078373aa6eb6c245c5a))
- correct Game Mode sort misalignment and Activity hidden-status ordering ([3fc4b2a](https://github.com/Millennium44/Toolasha/commit/3fc4b2a02fbb470edad6940f7bed66cea5e8882b))
- correct guild shrine costs and enhance protect-from race condition ([81796a1](https://github.com/Millennium44/Toolasha/commit/81796a1be4512436b92b1868a9928062b01216b4))
- correct labyrinth combat skip recommendations and add MooPass buffs ([b44dd1b](https://github.com/Millennium44/Toolasha/commit/b44dd1b3c7395d8f22accbe6c02b94ef41c40843))
- correct max produceable calculation for self-upgrade recipes ([9144a02](https://github.com/Millennium44/Toolasha/commit/9144a020e7c686c2eb2d1edef96ca9d73837c8f7))
- crash guards, wrong-result bugs, and teardown fixes across features ([85d14ea](https://github.com/Millennium44/Toolasha/commit/85d14ead8c635e0749dd33f6644db96d394f691d))
- crash in \_checkBindingEnhancements when cache is nulled mid-loop ([8b2155e](https://github.com/Millennium44/Toolasha/commit/8b2155eb13e839853fdef7dc82c1d83848dcf31f))
- decouple queue length estimation from listing age display setting ([41d29f4](https://github.com/Millennium44/Toolasha/commit/41d29f403cdabd0971ed06707215b3d0f3d89fd1))
- decrement and remove shrine missing mats tabs on purchase ([2a3032a](https://github.com/Millennium44/Toolasha/commit/2a3032a4bf13a6bb14564c208a1c8b8215632407))
- dedupe collapsed tab value rollup; bulk sell remembers tab ([0edb8d9](https://github.com/Millennium44/Toolasha/commit/0edb8d9c7ba72f552e63a22879d12ceced4954c3))
- defer skilling optimizer style injection until DOM is ready ([dba550b](https://github.com/Millennium44/Toolasha/commit/dba550ba4692b814f684c3ebf5375a5ce4f4e779))
- detect earrings and back slot in gear scanner, add per-item breakdowns ([3af542d](https://github.com/Millennium44/Toolasha/commit/3af542d9859f95ba9e16db5c7671b58062e0bf51))
- discard flow clicks Back before the trash can when needed ([613b0a5](https://github.com/Millennium44/Toolasha/commit/613b0a5b015933e92d6533c17f1d3d3c619849b1))
- drop upstream Greasy Fork update URLs from headers ([0000ec6](https://github.com/Millennium44/Toolasha/commit/0000ec68b9969692d8eac13c202396136d815606))
- enhancement calculator speed uses manual override params ([2d41428](https://github.com/Millennium44/Toolasha/commit/2d4142836b60a977870c3db5cf50e82c76f3d74a))
- exclude enhanced items from inventory count and add dynamic toggle ([6103c4f](https://github.com/Millennium44/Toolasha/commit/6103c4f01f08b3b24285eea6a4d31e742d0f74aa))
- exclude magic off-hands from melee upgrade recommendations ([9a11465](https://github.com/Millennium44/Toolasha/commit/9a114655f1c04b126d8fd1edaa22186fb974b1ca))
- exclude new members from unsigned trial list until next reset ([d128583](https://github.com/Millennium44/Toolasha/commit/d12858389805c8aaa66c0377e8fc5a47e38b3f9c))
- exclude out-of-stock drinks from artisan bonus calculations ([421f3db](https://github.com/Millennium44/Toolasha/commit/421f3db9fc012ce639b0685549b6bf24442a824e))
- exclude own listings from Top Order Price/Age on My Listings ([445f2ba](https://github.com/Millennium44/Toolasha/commit/445f2baee87866061e7ebe93cd95cc8e1c9f646e))
- give Lab Simulator its own independent setting ([33e405a](https://github.com/Millennium44/Toolasha/commit/33e405ad21e0847564726f8ae1c4bb94b9ec699d))
- handle DD/MM date format in dungeon tracker chat timestamp parser ([903c353](https://github.com/Millennium44/Toolasha/commit/903c3534705ae182d602e377cf38ef016b40a9e9))
- hide newly registered panels that don't match active filter ([8ff33ff](https://github.com/Millennium44/Toolasha/commit/8ff33ffccb6c8f4f8337cb23d120726946296184))
- hide pin icons on tiles when pinned actions page is disabled ([d238dc9](https://github.com/Millennium44/Toolasha/commit/d238dc9728cf32eb98c66d40a87932d8c7fc29a9))
- hide Scroll Simulation button when setting is disabled ([58c1ef7](https://github.com/Millennium44/Toolasha/commit/58c1ef7777b821066cf9c6e5d9db98fd3edfea6e))
- include coin costs in enhancement XPH calculator metrics ([bdf146e](https://github.com/Millennium44/Toolasha/commit/bdf146e5334d5f284c4ac46ab962fee2f1d35d4e))
- include gathering/gourmet buffs in labyrinth double progress chance ([99ef59e](https://github.com/Millennium44/Toolasha/commit/99ef59e3b1bf85aec1bc4e3e5c378d443bba1b49))
- include guild shrine buffs in all skilling calculations ([f2b444f](https://github.com/Millennium44/Toolasha/commit/f2b444f8bf89abd85103309ce00a55deac19cc5a))
- include guild shrine buffs in combat simulator ([667a2e7](https://github.com/Millennium44/Toolasha/commit/667a2e7ac6548bb39227ccbc6349cf75bc8ac5b5))
- include skillingRareFind in auto-detect gear calculations ([832ee94](https://github.com/Millennium44/Toolasha/commit/832ee94c02b25304c71517ee8010b3d038ba32d4))
- include task speed bonus in task completion time estimate ([2121c5d](https://github.com/Millennium44/Toolasha/commit/2121c5d40219fc3abc2dad93bbfe49d2612ee39b))
- initialize order book cache before listing price display ([ffb2779](https://github.com/Millennium44/Toolasha/commit/ffb2779e955e58a06b515cbb82c3a1a5f82ee1ae))
- keep action-bar time/icon line together on narrow screens ([96eda6a](https://github.com/Millennium44/Toolasha/commit/96eda6af4a1975e3d7143086a535cdd5042d292d))
- keep guild Joined date on a single line ([860b373](https://github.com/Millennium44/Toolasha/commit/860b3730dd21a7ac1aa8c142d7e8d02dca5395dc))
- key player leaderboard XP history by category to prevent cross-category contamination ([9090a6a](https://github.com/Millennium44/Toolasha/commit/9090a6aad1cd5f787e74ee65cde9dfb312256a74))
- labyrinth bar placement, duplicate Logs button, loadout tab sync ([bfb3eb0](https://github.com/Millennium44/Toolasha/commit/bfb3eb0cc2a1b5262d625617f1ad95772d4a5e5a))
- labyrinth recommendations allow negative thresholds and exclude tea from combat level ([0ffa5d1](https://github.com/Millennium44/Toolasha/commit/0ffa5d11f6ec37c1a4c408fa616f7e73652732e7))
- **labyrinth:** 5% success floor and gourmet exclusion per official formulas ([be72e52](https://github.com/Millennium44/Toolasha/commit/be72e52b16a2be7e6e7cb79e19526f7760ebe949))
- **labyrinth:** clear beacon indicators once their rooms are revealed ([b4d8a95](https://github.com/Millennium44/Toolasha/commit/b4d8a95286ec809322e730ee72be90554ade0a5f))
- **labyrinth:** keep recommendations across setting edits and room switches ([d24c98c](https://github.com/Millennium44/Toolasha/commit/d24c98c343b35222ee46a886ed0ab391b2377fef))
- **labyrinth:** path planner uses shrouds, routes from entrance and to flag rooms ([6a7bf64](https://github.com/Millennium44/Toolasha/commit/6a7bf6426f129f6a76ce3425bafdee0442198a54))
- **labyrinth:** position-anchored path planning, silence mathjs sourcemap error ([0ecbc91](https://github.com/Millennium44/Toolasha/commit/0ecbc911d83ad8ee2b0a71c9f44e869b6069c5fe))
- **labyrinth:** prune route outlines on cleared rooms, polish path controls ([853ede4](https://github.com/Millennium44/Toolasha/commit/853ede481f42597ddf83e7fc5edf6d603057081a))
- **labyrinth:** skilling tab cleanup, per-skill analysis scope, savedAt fingerprint ([fb3027a](https://github.com/Millennium44/Toolasha/commit/fb3027a15a45066980bc7d84441cca1e58a8a472))
- **labyrinth:** stable automation-row layout, prefilled skip edit input ([1aa2993](https://github.com/Millennium44/Toolasha/commit/1aa2993ae87b1f6b0745ebb5862744ae26c4cda0))
- **labyrinth:** stop lab sims from killing in-flight recommendation sims ([d7575a6](https://github.com/Millennium44/Toolasha/commit/d7575a6b51feaac6557bfe128540c0f22edd4b3d))
- **labyrinth:** unrevealed null rooms are passable, not walls ([0af2849](https://github.com/Millennium44/Toolasha/commit/0af28497301a1ddd8ae7b30ab3dbf24aabad58ef))
- locate the trash can as the card's icon-only danger button ([6312bec](https://github.com/Millennium44/Toolasha/commit/6312bec618d36985fe4391450eab9e237d03aea0))
- make action panel bottom section scrollable ([9708195](https://github.com/Millennium44/Toolasha/commit/9708195dd489e0c008eec0f707a8837e2003abf2))
- make enhancement stat breakdowns click-to-expand ([1683f25](https://github.com/Millennium44/Toolasha/commit/1683f25a81a6b52103576effaabcd242077c5992))
- make Marketplace "Count equipped items" setting actually toggle ([1dab506](https://github.com/Millennium44/Toolasha/commit/1dab50651af54a632d93a532b0ee53040b480c51))
- make skilling optimizer score alchemy equipment correctly ([400b148](https://github.com/Millennium44/Toolasha/commit/400b148715a6b908bf2da8375736d92e0da6d35a))
- **market:** philo calculator drop rates match the game; credit self-returns ([d50ca57](https://github.com/Millennium44/Toolasha/commit/d50ca57525f471c1bbfc70d502f129c60bbdfb1b))
- **market:** philo calculator uses realistic acquisition costs ([6953ec3](https://github.com/Millennium44/Toolasha/commit/6953ec3b1052dba788412946e8e8be1da6de063e))
- match enhanced items in queue by stripping +N level suffix ([11514be](https://github.com/Millennium44/Toolasha/commit/11514beab84ae8156f7fb03dd2fe225c9f78ef8b))
- parse K/M/B suffixes in listing quantity matching ([98400c9](https://github.com/Millennium44/Toolasha/commit/98400c92dfabc37e06f5de9cf3b2f0640c327bb6))
- persist custom tab drag/drop changes across page reload ([1d1ec72](https://github.com/Millennium44/Toolasha/commit/1d1ec726748e63fcf7eb8f6ff37e0ce751a10e74))
- preserve blue ocean badges when hiding guild and labyrinth badges ([5e026d8](https://github.com/Millennium44/Toolasha/commit/5e026d8dedd84534cd5c5f407032e376912fd6d1))
- preserve scroll position when removing items in tab editor ([d7e0f39](https://github.com/Millennium44/Toolasha/commit/d7e0f3957801d1ba99167350cd2241bd062ecef6))
- prevent action filter from clearing panels registered in same mutation batch ([67a706a](https://github.com/Millennium44/Toolasha/commit/67a706a5f5d29ded6463dec667b17e9fd0f56605))
- prevent Add to Tab dropdown from leaking document click listeners ([2682ca1](https://github.com/Millennium44/Toolasha/commit/2682ca15a38da2fb4f19c636f4c6f947bae891e7))
- prevent Build button collapse when cumulative section is tall ([4f6b0a3](https://github.com/Millennium44/Toolasha/commit/4f6b0a33e231650d09e998d2136cc98e11b6bfea))
- prevent claim reward button from resizing with count ([01656bc](https://github.com/Millennium44/Toolasha/commit/01656bcaebdf18e24280eaa33dba99867d4e1be0))
- prevent combat quick input buttons from duplicating ([5cc9cf1](https://github.com/Millennium44/Toolasha/commit/5cc9cf1a540a96e928bb0151722bb7e0612dd043))
- prevent drag listener accumulation on custom inventory tab tiles ([cae18f3](https://github.com/Millennium44/Toolasha/commit/cae18f370b9c3045748d63fee5bdc5bd55a3facf))
- prevent orphan outside-click listeners from deferred attachment race ([9500b1b](https://github.com/Millennium44/Toolasha/commit/9500b1b5461af1fe429f8fc6d236ad09ebe1b303))
- prevent stat line text from briefly shrinking during tab switch ([60b2e03](https://github.com/Millennium44/Toolasha/commit/60b2e039ff073bb145cfa934b24c858cb7eafd1b))
- **profile:** loadout cards keep name, outfit, and learned ability levels ([ccc990f](https://github.com/Millennium44/Toolasha/commit/ccc990f89b85ac46b3d605fbaebd1bdde3526dcb))
- re-sync action panel marginBottom after layout and tab changes ([c9b9644](https://github.com/Millennium44/Toolasha/commit/c9b964408d8d5d549e4bdeea35b67c81f34b52b4))
- rebuild equipment section when skill changes in simulator ([fd2d06a](https://github.com/Millennium44/Toolasha/commit/fd2d06a2a9425900f3daf405a3071ffaad0e8778))
- recognize short numeric character IDs during settings import ([4659c45](https://github.com/Millennium44/Toolasha/commit/4659c455c2fce56364d4911c126dda5341a80155))
- recover WebSocket hook when primary interception fails ([bd538c2](https://github.com/Millennium44/Toolasha/commit/bd538c29b2c408025b313c3695b3353a44c968ce))
- refresh action-bar profit when pricing mode changes ([4976742](https://github.com/Millennium44/Toolasha/commit/4976742fa86d7baade06425c4e58050a1adaf1a5))
- refresh production profit UI when drinks or equipment change ([e254edf](https://github.com/Millennium44/Toolasha/commit/e254edf9983ecd94132b6a320a9d109cee741658))
- register production panels with sort manager when pinned page is off ([f79a20c](https://github.com/Millennium44/Toolasha/commit/f79a20c5c55c0e09101069f6957f8b1f10eee3b3))
- register skillingOptimizer in config features map ([dc53b94](https://github.com/Millennium44/Toolasha/commit/dc53b94f8bc969df00de090106b3fa95452001f4))
- relocate Activity column and correct per-tab placement ([209577e](https://github.com/Millennium44/Toolasha/commit/209577e215924f00789ce03518322c00524a1522))
- remove parentheses from trial tier badge to prevent line wrap ([4f9f484](https://github.com/Millennium44/Toolasha/commit/4f9f4848b9ef1cd3de025d4a0dae58af7a7b9a4a))
- remove stale Rec badge when skip threshold is edited ([e2d5ad6](https://github.com/Millennium44/Toolasha/commit/e2d5ad68d880a5cec4ee0c10192c096343844c68))
- resolve [Unknown action] for items with mismatched display name and HRID ([3190702](https://github.com/Millennium44/Toolasha/commit/3190702ce5c704b94c3face20a1ad1a0c0d32137))
- resolve enhancement levels from all owned items in combat loadout ([e9d52ad](https://github.com/Millennium44/Toolasha/commit/e9d52ad0308ef026338857974215a34379684ecd))
- resolve hanging Promises from debounced storage writes ([8ed8cc9](https://github.com/Millennium44/Toolasha/commit/8ed8cc91996fc705eec24f665dd1a1ccb9e6b2cd))
- respect "Use highest enhancement level" setting in custom tab auto-sync ([da843dd](https://github.com/Millennium44/Toolasha/commit/da843dd6acbd5e60741f2aa654c2e4706eb6917c))
- respect 24-hour time format setting in action completion times ([1323558](https://github.com/Millennium44/Toolasha/commit/1323558f413f5b279c53d01c8b348357f4178994))
- restore click-to-view-details on comparison scenario rows ([f74420c](https://github.com/Millennium44/Toolasha/commit/f74420ccf64eafdb9279903804d73040b4f75127))
- restore year on guild Joined column ([ba2b5e1](https://github.com/Millennium44/Toolasha/commit/ba2b5e172ebfde77b69c5cc81dd53b89698b810c))
- return defaultValue from storage.get when stored value is null ([7e5ce1e](https://github.com/Millennium44/Toolasha/commit/7e5ce1eb0ceff763a5c92cf545e6ca29dfd4c6b9))
- second round of runtime fixes from code review ([2eec924](https://github.com/Millennium44/Toolasha/commit/2eec924f91845eb0ecde3b99c0389f620cf1409f))
- show ask total in tooltip even when bid is missing ([b74a82c](https://github.com/Millennium44/Toolasha/commit/b74a82c02ee1825759ad77e101eef08ceb066104))
- show drink timer on Alchemy and Enhancing panels ([2a3c25e](https://github.com/Millennium44/Toolasha/commit/2a3c25e467c4e63255ce158c91ec56155db2579d))
- show expandable speed breakdown on tasks without profit enabled ([7b71d99](https://github.com/Millennium44/Toolasha/commit/7b71d9953a1d8bdf819315cc1b0df04918d215f0))
- show expected time for repeat-∞ enhancement queue actions ([ab3f26f](https://github.com/Millennium44/Toolasha/commit/ab3f26f04869ac67d91c5afdcc4efd5815208d74))
- show guild shrine buffs in action breakdown displays ([93e47fc](https://github.com/Millennium44/Toolasha/commit/93e47fc268ddd4a5f3219daf2c0b3ea2deccb782))
- show labyrinth attempt number in battle counter ([5cbbcf3](https://github.com/Millennium44/Toolasha/commit/5cbbcf30160e9d23d8fdb5ca6f2a0d26c4ef47ca))
- show MooPass wisdom line in XP bonus breakdown ([95d5146](https://github.com/Millennium44/Toolasha/commit/95d5146a1e286a49671a949fe5593292a1f598cb))
- show top-3 conversion options in shrine upgrade cost table ([17eb9f4](https://github.com/Millennium44/Toolasha/commit/17eb9f4705270581507085af8c334938b100e98a))
- skip battle counter injection when no active combat action ([46db6ec](https://github.com/Millennium44/Toolasha/commit/46db6ecae50f76260dd2149525189b2dbe75e794))
- skip sort registration in max-produceable for gathering panels ([afbaa9a](https://github.com/Millennium44/Toolasha/commit/afbaa9a60d58815b929a640ea5746afa383f13c7))
- sort loadout dropdowns by server ordinal ([acfca19](https://github.com/Millennium44/Toolasha/commit/acfca19dd0a4227a2bc39bbad57afaa4d24d3264))
- sort Weekly XP column numerically with K/M suffix support ([6687524](https://github.com/Millennium44/Toolasha/commit/66875241f18e849289c65e47e2ef8906fe23cef7))
- stabilize task card heights and fix task reroll tracker display ([7c6aa23](https://github.com/Millennium44/Toolasha/commit/7c6aa230b9a906c4163e39886974a60bf78dbd5d))
- stop stale Attempt #N label from leaking into regular combat ([a85b867](https://github.com/Millennium44/Toolasha/commit/a85b867cf0201e44cf065d3be5247443520581c8))
- surface refined weapon as upgrade for offensive items ([4595d1c](https://github.com/Millennium44/Toolasha/commit/4595d1cf79d154f935ae151884ad922be670c5e6))
- surface T95 tier jumps and style-matched off-hands in upgrade advisor ([f31dbc1](https://github.com/Millennium44/Toolasha/commit/f31dbc1f10f73d84b29e66f47343cde8d0d0d294))
- sync per-loadout Custom Tab binding independently of mixed exact mode ([36f07d1](https://github.com/Millennium44/Toolasha/commit/36f07d1ced4b92d4a06489dffa84f20b02620b09))
- sync pop-out chat channel list with visible game tabs ([f03fd2b](https://github.com/Millennium44/Toolasha/commit/f03fd2bd0111025d9dc9524d1310c2d08fcc9044))
- sync Settings UI disabled state and checkboxWithButton after All Off ([424bca0](https://github.com/Millennium44/Toolasha/commit/424bca018f554ca1cd0cf75d9f5b365a2adf0e84))
- unify action panel into a single scroll container ([1139933](https://github.com/Millennium44/Toolasha/commit/1139933f0e218e21cfdd0180fc7228f1289ea21e))
- update market item counts when inventory changes ([c460c9c](https://github.com/Millennium44/Toolasha/commit/c460c9c44cb0a469dce5846563d72e2f9fe46e81))
- use 2-digit year in formatDateTime to keep guild Joined column on one line ([ced1d5c](https://github.com/Millennium44/Toolasha/commit/ced1d5c52ee50e502d3de60cd7878702f6bd4ae6))
- use approximate quantity matching for K/M/B abbreviated listings ([2bb092e](https://github.com/Millennium44/Toolasha/commit/2bb092e86d0db816eca4680f586cabe50c6af9a8))
- use base + tea crate only for labyrinth room-assignment effective level ([832da33](https://github.com/Millennium44/Toolasha/commit/832da336fab14fddbe91f6b8b5dda1ebb79354f8))
- use correct config method for labyrinth number settings ([94b0802](https://github.com/Millennium44/Toolasha/commit/94b08028b1351a5ae3b8dd8184e14dcb587b564e))
- use DOM observer for chat commands input attachment ([a7a120b](https://github.com/Millennium44/Toolasha/commit/a7a120b84af9e25c3e027e91d9ca2cd5aeea90f0))
- use full zone data for boss task sim estimates ([8794215](https://github.com/Millennium44/Toolasha/commit/8794215ab14b5b9cb66322d36ac389f051b865d3))
- use handleChangeNavTarget for enhancement return navigation ([0e8e6b8](https://github.com/Millennium44/Toolasha/commit/0e8e6b8d9918e3f24b4ab6458a618af0062ab635))
- use inline-flex to force action-bar time line to one row ([e4b6260](https://github.com/Millennium44/Toolasha/commit/e4b62603fe1bc58525065227f205f2faf7f836cb))
- use labyrinth loadout equipment for skilling clear rate ([a220eb9](https://github.com/Millennium44/Toolasha/commit/a220eb998fbaa00f75dca567bff0461752685dcc))
- use live networth for rate/hr calculation instead of last snapshot ([ef61b79](https://github.com/Millennium44/Toolasha/commit/ef61b79ee40c3e8f3764b392a40f1896a4fb63d4))
- use matchCurrentActionFromText for queue ETA current action detection ([993bbd1](https://github.com/Millennium44/Toolasha/commit/993bbd1247c1b87469e8d67d73b0670c92535b3e))
- use profit as secondary sort when sorting Best Items by XP, and vice versa ([bb6b66e](https://github.com/Millennium44/Toolasha/commit/bb6b66e83ce6b9be1f36cc0f2d0570c669cf166b))
- use refined item costs for mirror path instead of non-refined base item ([9dd1941](https://github.com/Millennium44/Toolasha/commit/9dd1941bebad166edf33cdafe008fe9c5c143cbc))
- use ResizeObserver to sync stats layout on hidden→visible tab switches ([84d29fd](https://github.com/Millennium44/Toolasha/commit/84d29fd7b4cf9df0d95bb6b00d6bec5f9ef2b403))
- use saved loadout snapshot for XP, time, and material predictions ([1722782](https://github.com/Millennium44/Toolasha/commit/17227821b0f0eac052ae513baecadc705bfc2f82))
- wire combatStats setting to feature gate ([5f63226](https://github.com/Millennium44/Toolasha/commit/5f63226220a71d02b8ce5bb1ac959eefa3c01939))

### Code Refactoring

- reorganize settings into 25 focused groups ([3117c91](https://github.com/Millennium44/Toolasha/commit/3117c910ed6ea70071da9ba49716763413ffba73))
- split leaderboard XP tracking into independent feature ([4d2fc58](https://github.com/Millennium44/Toolasha/commit/4d2fc58defa8dbe45fe067ea449be39117d828dd))
- split profit/hr and exp/hr tile settings by action type ([6b6d533](https://github.com/Millennium44/Toolasha/commit/6b6d533d203822fa16245bbb42568dc5ed1273df))
- unify date/time and number formatting across all features ([a4a609e](https://github.com/Millennium44/Toolasha/commit/a4a609ea25674412a3c1bf7bdceffe6dbbb2ffa3))

### Performance Improvements

- also gate badge fallback enhancement-cost calc on networth feature ([9d62d61](https://github.com/Millennium44/Toolasha/commit/9d62d614a5e71aedc7de18e377e5a2ebdcf6389b))
- make combatStats and chatCommands initialize non-blocking ([304b742](https://github.com/Millennium44/Toolasha/commit/304b742e9935fafe1beef07055d825cca02eda22))
- skip enhancement-cost badge calc when networth is disabled ([e95445f](https://github.com/Millennium44/Toolasha/commit/e95445f6dfe19b5e9c3d0fac63bd0a0a74202bca))

### Documentation

- add fork changelog covering all changes since upstream v2.84.0 ([f3da20f](https://github.com/Millennium44/Toolasha/commit/f3da20fcc1f784fb7ad9a74b2cf1a062e3f2158c))
- clarify networth setting labels to match actual behavior ([eb833aa](https://github.com/Millennium44/Toolasha/commit/eb833aaaa3dddefc094b039396fa4e21aa41647e))

### Continuous Integration

- run format workflow on bot pushes to release-please PRs ([eed699d](https://github.com/Millennium44/Toolasha/commit/eed699dcbeece9c6bef6104e5c9748fa2816fc66))

### Miscellaneous Chores

- add diagnostics for custom tab items disappearing on auto-switch ([885d42b](https://github.com/Millennium44/Toolasha/commit/885d42b6ded0d978d2629136dc1d10be5a6d33b7))
- add Paradoxian to userscript header acknowledgements ([16378aa](https://github.com/Millennium44/Toolasha/commit/16378aa3e35fbeca556636e1a7537c2e19ed2000))
- **combat:** drop unused roomLevel param from appendTileBadge ([00f2e65](https://github.com/Millennium44/Toolasha/commit/00f2e654f20323c23964cbfed74313b446f980bd))
- display version number in settings tab title ([c3128f6](https://github.com/Millennium44/Toolasha/commit/c3128f649d05dc55f65a0d490e4a77ed6afececc))
- format release notes ([38444c6](https://github.com/Millennium44/Toolasha/commit/38444c65a6185dd42824b6388baa0ec41b7f284f))
- **main:** release 2.59.1 ([e78f8ad](https://github.com/Millennium44/Toolasha/commit/e78f8adf46e2d3486b7ef7d32be76cb16d5b70d1))
- **main:** release 2.59.1 ([8052a19](https://github.com/Millennium44/Toolasha/commit/8052a19fd50a42e5e75b920941abf38358a56848))
- **main:** release 2.59.2 ([cc52fb5](https://github.com/Millennium44/Toolasha/commit/cc52fb51db5bed2e44fa42baf07f9e0a1f4eb040))
- **main:** release 2.59.2 ([07b11ae](https://github.com/Millennium44/Toolasha/commit/07b11ae2c7f492e978d45d5941d1ddb2bcdf5497))
- **main:** release 2.59.3 ([ac430f2](https://github.com/Millennium44/Toolasha/commit/ac430f25d46f62a9883fae67618fc9e8ba9710ab))
- **main:** release 2.59.3 ([e20728f](https://github.com/Millennium44/Toolasha/commit/e20728fc4cbbdb61b40948fa30f881312e5fc680))
- **main:** release 2.59.4 ([e486757](https://github.com/Millennium44/Toolasha/commit/e4867574b2124e5951fcb7bbba0a52fbc9701391))
- **main:** release 2.59.4 ([13596b0](https://github.com/Millennium44/Toolasha/commit/13596b0aee9f8e08e551c01ebb7c4ca9776cb7a3))
- **main:** release 2.59.5 ([16b7b59](https://github.com/Millennium44/Toolasha/commit/16b7b595b49acc7d848b22f3140ca31c55998a59))
- **main:** release 2.59.5 ([99bf070](https://github.com/Millennium44/Toolasha/commit/99bf070467b8e9183995b127a2ce4295825cc6c9))
- **main:** release 2.60.0 ([8b1bda2](https://github.com/Millennium44/Toolasha/commit/8b1bda2fd86379da089e4cf33e8807eea088e07c))
- **main:** release 2.60.0 ([9bf3b91](https://github.com/Millennium44/Toolasha/commit/9bf3b9187e4efa4261e6c66fb2bded0f4b8b750d))
- **main:** release 2.61.0 ([b561ceb](https://github.com/Millennium44/Toolasha/commit/b561ceb32afac92adfb0dd75d37d976ea4691fec))
- **main:** release 2.61.0 ([7c5a604](https://github.com/Millennium44/Toolasha/commit/7c5a604b8bf7b31c3be81ab0876c66ab2cade511))
- **main:** release 2.61.1 ([cac3150](https://github.com/Millennium44/Toolasha/commit/cac31501fc3ed79aa61009ba4a9e1f5e22cc0402))
- **main:** release 2.61.1 ([ec571a5](https://github.com/Millennium44/Toolasha/commit/ec571a55c179b1fa7c4e077df2337cca1f941794))
- **main:** release 2.61.2 ([b7ba4d8](https://github.com/Millennium44/Toolasha/commit/b7ba4d8d11a9559f6a1e6b04540319ca7d58c9a9))
- **main:** release 2.61.2 ([2432262](https://github.com/Millennium44/Toolasha/commit/2432262b6fd65e208ac82a8832f31f75abb0003d))
- **main:** release 2.61.3 ([f2dbb1b](https://github.com/Millennium44/Toolasha/commit/f2dbb1be322edfe1e0265774c6e2a915972f8335))
- **main:** release 2.61.3 ([38ee22d](https://github.com/Millennium44/Toolasha/commit/38ee22dc19f52a08024ede3872fbde95aad652b9))
- **main:** release 2.61.4 ([7255ac8](https://github.com/Millennium44/Toolasha/commit/7255ac8129cde7e3c84cdec76fa8f1206586fa63))
- **main:** release 2.61.4 ([d7c3920](https://github.com/Millennium44/Toolasha/commit/d7c3920b36d81dc6715c6e672100a3aaeaa2e502))
- **main:** release 2.61.5 ([e7deb6c](https://github.com/Millennium44/Toolasha/commit/e7deb6c703d45f72c324c185138f4093c3f2727a))
- **main:** release 2.61.5 ([2fe92ac](https://github.com/Millennium44/Toolasha/commit/2fe92ac6359103583f8617b1e123f0569327d4d0))
- **main:** release 2.62.0 ([3e920d5](https://github.com/Millennium44/Toolasha/commit/3e920d555e8e4bae893e33d2b929dc05fa2d50d0))
- **main:** release 2.62.0 ([4d4a5b8](https://github.com/Millennium44/Toolasha/commit/4d4a5b89dddcbe8d385901a33eae0b2281cfc4d0))
- **main:** release 2.62.1 ([cc4b89b](https://github.com/Millennium44/Toolasha/commit/cc4b89bd4e4454e11535dbad46037e6c4e3e7c08))
- **main:** release 2.62.1 ([a506b8a](https://github.com/Millennium44/Toolasha/commit/a506b8a5cf15fc19c4bbbc813b231d7bb17ef01e))
- **main:** release 2.62.10 ([ba8eb57](https://github.com/Millennium44/Toolasha/commit/ba8eb57d2c8b0e4935f6d13d5463534195d389bb))
- **main:** release 2.62.10 ([0eb23b0](https://github.com/Millennium44/Toolasha/commit/0eb23b0911fe082324f42d69c49b03ce0740d2d4))
- **main:** release 2.62.11 ([90e4b70](https://github.com/Millennium44/Toolasha/commit/90e4b70a07c8f18db0e55581438bffcb90ff15fe))
- **main:** release 2.62.11 ([5a50a3c](https://github.com/Millennium44/Toolasha/commit/5a50a3c30fab2ccae320b4484c7b48537d3f15c2))
- **main:** release 2.62.12 ([724964f](https://github.com/Millennium44/Toolasha/commit/724964f6257d706c6c485293d09b7e5759a4db89))
- **main:** release 2.62.12 ([e292d29](https://github.com/Millennium44/Toolasha/commit/e292d298726f8152e1d1a3d5e71a661e1edc00a8))
- **main:** release 2.62.13 ([950a2e3](https://github.com/Millennium44/Toolasha/commit/950a2e34297cdde7dc72d510cded5414c947c5c6))
- **main:** release 2.62.13 ([82f1b36](https://github.com/Millennium44/Toolasha/commit/82f1b36487f959d878c757c777af87e544a12ebc))
- **main:** release 2.62.14 ([b8c1cdc](https://github.com/Millennium44/Toolasha/commit/b8c1cdc8941b28b5a88cf3fd9d866e2ac9c149d5))
- **main:** release 2.62.14 ([0e81238](https://github.com/Millennium44/Toolasha/commit/0e812380de7eb244d2c0eec25d5e5fa4670c5af1))
- **main:** release 2.62.2 ([38838bc](https://github.com/Millennium44/Toolasha/commit/38838bc900ef2d3d9b60fee25b17a0fd918663a8))
- **main:** release 2.62.2 ([16f4250](https://github.com/Millennium44/Toolasha/commit/16f4250f2ecd1a24f9dbf5c6d52e863a09882886))
- **main:** release 2.62.3 ([2325215](https://github.com/Millennium44/Toolasha/commit/23252152075ee0fd5442c11576460b956cfe2f51))
- **main:** release 2.62.3 ([c6592ff](https://github.com/Millennium44/Toolasha/commit/c6592ffb61850b7c4d2dfd470e85f8de4eb3138b))
- **main:** release 2.62.4 ([95fa78c](https://github.com/Millennium44/Toolasha/commit/95fa78c0c0c0aa668c3c4c21af89742043b4efa3))
- **main:** release 2.62.4 ([35425bb](https://github.com/Millennium44/Toolasha/commit/35425bbf2f6a6f61c12fb9285ee336dda543d254))
- **main:** release 2.62.5 ([8a1484f](https://github.com/Millennium44/Toolasha/commit/8a1484fd045b79ad4b44bb4c7e24bac592094026))
- **main:** release 2.62.5 ([767a70b](https://github.com/Millennium44/Toolasha/commit/767a70b4b853edbf00f39bc612edbc64ccca98cf))
- **main:** release 2.62.6 ([f529d7e](https://github.com/Millennium44/Toolasha/commit/f529d7edb9c6b6c3f9461d36ea36abd6ea15100c))
- **main:** release 2.62.6 ([0f12df4](https://github.com/Millennium44/Toolasha/commit/0f12df4f9bae3aa7db413e9a9404fefd6833600d))
- **main:** release 2.62.7 ([31709cc](https://github.com/Millennium44/Toolasha/commit/31709cc8d21cb9f597a3836e5f071797b15e7b78))
- **main:** release 2.62.7 ([7427b42](https://github.com/Millennium44/Toolasha/commit/7427b429bf1912b8b7d6fba7d15f8073af77172b))
- **main:** release 2.62.8 ([1d439fc](https://github.com/Millennium44/Toolasha/commit/1d439fc3245680b340c7c9b5e90e9f47221a5634))
- **main:** release 2.62.8 ([225fad6](https://github.com/Millennium44/Toolasha/commit/225fad6b84f79fc9a0f912052cfa26f008300029))
- **main:** release 2.62.9 ([e4a005f](https://github.com/Millennium44/Toolasha/commit/e4a005f7d5820e56d38ebcf4e73ec518510674de))
- **main:** release 2.62.9 ([b45b48d](https://github.com/Millennium44/Toolasha/commit/b45b48d8001a5def8613d3cddd68d8df55b4fe05))
- **main:** release 2.63.0 ([d212223](https://github.com/Millennium44/Toolasha/commit/d212223009bff27141ac67b293f2ebb28bc055ea))
- **main:** release 2.63.0 ([fa9ef2c](https://github.com/Millennium44/Toolasha/commit/fa9ef2c654217361966e77307cce7bdb24513a0c))
- **main:** release 2.64.0 ([24fe5a2](https://github.com/Millennium44/Toolasha/commit/24fe5a297307265e5fe898720023af6eed2bf9d1))
- **main:** release 2.64.0 ([3c98946](https://github.com/Millennium44/Toolasha/commit/3c989468efed9abf03f2a7ab7123ed50e55d6b43))
- **main:** release 2.64.1 ([0bd4e64](https://github.com/Millennium44/Toolasha/commit/0bd4e6454aa1cba9be0f6c5d87da837f0324c144))
- **main:** release 2.64.1 ([6928ec1](https://github.com/Millennium44/Toolasha/commit/6928ec1755eeb93c48805b8a0403a53469cd441e))
- **main:** release 2.64.2 ([ffd60de](https://github.com/Millennium44/Toolasha/commit/ffd60de073f4c28326604e1554a31694fc286375))
- **main:** release 2.64.2 ([87dae54](https://github.com/Millennium44/Toolasha/commit/87dae548c78ca6777cdfef6d2b7e23ef405f1bf9))
- **main:** release 2.64.3 ([f9d1b3a](https://github.com/Millennium44/Toolasha/commit/f9d1b3a5a7a4a5c5f81575fffef5e547d52f3c62))
- **main:** release 2.64.3 ([8abf904](https://github.com/Millennium44/Toolasha/commit/8abf9049dc8fe1f12e92ce845628a4f2cd67e8bc))
- **main:** release 2.64.4 ([bd6fc21](https://github.com/Millennium44/Toolasha/commit/bd6fc21b451a8012df7d00b060630381ce4c2c97))
- **main:** release 2.64.4 ([5cd1397](https://github.com/Millennium44/Toolasha/commit/5cd13978f7235dbc93081e422e4e5efe57622387))
- **main:** release 2.64.5 ([7ff3b10](https://github.com/Millennium44/Toolasha/commit/7ff3b109a397a238638b2908f28ec36ba825d2e7))
- **main:** release 2.64.5 ([465cac2](https://github.com/Millennium44/Toolasha/commit/465cac226e39e8c4638201bd9aef136fc65e9fd3))
- **main:** release 2.65.0 ([e8b53c7](https://github.com/Millennium44/Toolasha/commit/e8b53c7998756d3b70e931440266ce19f73d5154))
- **main:** release 2.65.0 ([b73d995](https://github.com/Millennium44/Toolasha/commit/b73d99544c9bc6be08eff0b7b854ae612c0759f9))
- **main:** release 2.66.0 ([ddb6353](https://github.com/Millennium44/Toolasha/commit/ddb63535c899af81f2c3128e29e9a0fc0a8d91a8))
- **main:** release 2.66.0 ([0dd53ce](https://github.com/Millennium44/Toolasha/commit/0dd53cec24cac58c9962696f28ac734ddfe545a5))
- **main:** release 2.67.0 ([e0ef933](https://github.com/Millennium44/Toolasha/commit/e0ef933cc5b5aba9e1b8d7a0c511b1d207a78861))
- **main:** release 2.67.0 ([ce0817f](https://github.com/Millennium44/Toolasha/commit/ce0817f0b2cecc2b2c638e0c979fa24ced9686a1))
- **main:** release 2.67.1 ([b6cc809](https://github.com/Millennium44/Toolasha/commit/b6cc809e9092c3330148c8e0dfaa4f0823367855))
- **main:** release 2.67.1 ([2f841d2](https://github.com/Millennium44/Toolasha/commit/2f841d29167aab0132fdfdd6694087fe7791a9d1))
- **main:** release 2.67.2 ([ff1ebdc](https://github.com/Millennium44/Toolasha/commit/ff1ebdc9fd89270a7e60487a896bf506cd661928))
- **main:** release 2.67.2 ([bb1e955](https://github.com/Millennium44/Toolasha/commit/bb1e955f22739ca9d06ca67a63ec68856487fb7e))
- **main:** release 2.67.3 ([99a9953](https://github.com/Millennium44/Toolasha/commit/99a9953eb7bbe7f1eca9936f3d2e402b1c1c4b66))
- **main:** release 2.67.3 ([c46b15c](https://github.com/Millennium44/Toolasha/commit/c46b15c1a9d2d19fe5dc9e8d28550e1b5b282be9))
- **main:** release 2.67.4 ([a5566ae](https://github.com/Millennium44/Toolasha/commit/a5566aec6ff29ac88dbea3b706cf203838c2569f))
- **main:** release 2.67.4 ([eb6840c](https://github.com/Millennium44/Toolasha/commit/eb6840c7a6bedabc51f16e18a532bfa238fb69d1))
- **main:** release 2.67.5 ([e6cfaf4](https://github.com/Millennium44/Toolasha/commit/e6cfaf4c2938eb209cca5f8dd82a9bfed0c9428e))
- **main:** release 2.67.5 ([8c73ceb](https://github.com/Millennium44/Toolasha/commit/8c73ceb41d84eb7645d74dc2a59a9a1fc33e7347))
- **main:** release 2.67.6 ([aae8b9a](https://github.com/Millennium44/Toolasha/commit/aae8b9a796e464c5102fb8ccf3b0185540447c94))
- **main:** release 2.67.6 ([0a70c07](https://github.com/Millennium44/Toolasha/commit/0a70c0773905d03ac90cc09e4fc2974844b3dce1))
- **main:** release 2.67.7 ([b570a91](https://github.com/Millennium44/Toolasha/commit/b570a9138bdf5a8bbc7a7c9e9727f90972d2e636))
- **main:** release 2.67.7 ([d555d99](https://github.com/Millennium44/Toolasha/commit/d555d998e1dd51d2a9db9246226f8a2e4d7ce881))
- **main:** release 2.68.0 ([d0a22a1](https://github.com/Millennium44/Toolasha/commit/d0a22a1a484b17fd430b8c2481816aec127bee89))
- **main:** release 2.68.0 ([49dc233](https://github.com/Millennium44/Toolasha/commit/49dc233f2b8ebd202ad3f9a623df44acd5bd812d))
- **main:** release 2.68.1 ([5bd259d](https://github.com/Millennium44/Toolasha/commit/5bd259d47d1e1051573f038c8df6e7b465c7d46c))
- **main:** release 2.68.1 ([2b6f4ea](https://github.com/Millennium44/Toolasha/commit/2b6f4ea0eab939fcb78b7d219af12ca1a0205c0e))
- **main:** release 2.69.0 ([ec7f8e5](https://github.com/Millennium44/Toolasha/commit/ec7f8e54f02562e9545383e714aacb563a0005d2))
- **main:** release 2.69.0 ([6de5853](https://github.com/Millennium44/Toolasha/commit/6de585374cd0b59d3ceee4a9a0bd4dcdb44ec0d8))
- **main:** release 2.69.1 ([3591cbf](https://github.com/Millennium44/Toolasha/commit/3591cbf3dde637b5d0978e000bfdaa417652669b))
- **main:** release 2.69.1 ([18cc463](https://github.com/Millennium44/Toolasha/commit/18cc463f2421cc43b5e3d76e0bc1ab349f8088e5))
- **main:** release 2.69.2 ([66305a4](https://github.com/Millennium44/Toolasha/commit/66305a4d187326b18b51c88ad3e1ff98aa65ddbc))
- **main:** release 2.69.2 ([469a1ea](https://github.com/Millennium44/Toolasha/commit/469a1eaa1f82817fd4f7a602b3f1c8d7ac6df779))
- **main:** release 2.70.0 ([a20320d](https://github.com/Millennium44/Toolasha/commit/a20320d45649750a18d30377f92e6d7dc91b940b))
- **main:** release 2.70.0 ([e88a298](https://github.com/Millennium44/Toolasha/commit/e88a2984b2665062d71f3b615cd69005b93b81b5))
- **main:** release 2.70.1 ([c2e2263](https://github.com/Millennium44/Toolasha/commit/c2e2263371561c784bcdb2cdabd72fa2a5b0b835))
- **main:** release 2.70.1 ([750e9a1](https://github.com/Millennium44/Toolasha/commit/750e9a17257714c9ddcc9c093bbfee1e799e59e3))
- **main:** release 2.70.2 ([617a670](https://github.com/Millennium44/Toolasha/commit/617a67084ed2132450f5ba6f0a04656e05e14a02))
- **main:** release 2.70.2 ([653406c](https://github.com/Millennium44/Toolasha/commit/653406cbf9d7f976acbc82e87a4d37a48ddca51c))
- **main:** release 2.71.0 ([48728da](https://github.com/Millennium44/Toolasha/commit/48728dae6bad290804fbab3a0b8fe81c431f8eb9))
- **main:** release 2.71.0 ([5a3ecf1](https://github.com/Millennium44/Toolasha/commit/5a3ecf19aa201478f4758ce2956f95099bb00624))
- **main:** release 2.71.1 ([b996872](https://github.com/Millennium44/Toolasha/commit/b996872ee430ff90e4538f188847b88432f65804))
- **main:** release 2.71.1 ([8de13ac](https://github.com/Millennium44/Toolasha/commit/8de13ac7a131f2ecb38875817315a48771c0539d))
- **main:** release 2.72.0 ([5f03b21](https://github.com/Millennium44/Toolasha/commit/5f03b21afe8efe51514b592d429d9c79571ee737))
- **main:** release 2.72.0 ([44c0261](https://github.com/Millennium44/Toolasha/commit/44c0261aacefbe8e2dfe40057489729bd4240187))
- **main:** release 2.72.1 ([428a3a2](https://github.com/Millennium44/Toolasha/commit/428a3a2199adf3381843485267c58e561a4ff167))
- **main:** release 2.72.1 ([e4c1008](https://github.com/Millennium44/Toolasha/commit/e4c1008c406fc70ec4ba6a028e1229413e09a1eb))
- **main:** release 2.72.2 ([35d2d6a](https://github.com/Millennium44/Toolasha/commit/35d2d6a146074917197cd530752063be1fcb4b14))
- **main:** release 2.72.2 ([f860e9e](https://github.com/Millennium44/Toolasha/commit/f860e9e9d122fdb108ada913ffd96342c04232e8))
- **main:** release 2.73.0 ([19c2735](https://github.com/Millennium44/Toolasha/commit/19c2735f205af2c6c57cdfbf4574a04b386385cf))
- **main:** release 2.73.0 ([dd6cbdf](https://github.com/Millennium44/Toolasha/commit/dd6cbdfbbdf4a50551a70331b8b44a438a8c1c3d))
- **main:** release 2.74.0 ([9366189](https://github.com/Millennium44/Toolasha/commit/9366189beda3a2aebc2eb43058d4427db16c1f5f))
- **main:** release 2.74.0 ([b1990f2](https://github.com/Millennium44/Toolasha/commit/b1990f2282463bd208fcc328c1a6bd3fff2d7e80))
- **main:** release 2.74.1 ([12a514d](https://github.com/Millennium44/Toolasha/commit/12a514da69c36c331db456329a1cf702fec4cb95))
- **main:** release 2.74.1 ([9b1a95f](https://github.com/Millennium44/Toolasha/commit/9b1a95fce869692a175a4799f07f498fce43864f))
- **main:** release 2.74.2 ([08459dc](https://github.com/Millennium44/Toolasha/commit/08459dc228a22dd334eae77cf34b0c75912c29d3))
- **main:** release 2.74.2 ([8230963](https://github.com/Millennium44/Toolasha/commit/82309637820c920416703e837631c710a7acb861))
- **main:** release 2.75.0 ([6677a51](https://github.com/Millennium44/Toolasha/commit/6677a517a2e05c173cbfbdb2e8264d5964537e57))
- **main:** release 2.75.0 ([732456e](https://github.com/Millennium44/Toolasha/commit/732456e8e04cd77029b3f542ede95bd1aa8456bb))
- **main:** release 2.76.0 ([579eb67](https://github.com/Millennium44/Toolasha/commit/579eb674dfb9aa24573afcc6ff8095e7b75a1952))
- **main:** release 2.76.0 ([8c16118](https://github.com/Millennium44/Toolasha/commit/8c1611818caae05cfc4985fed89b742b528b4fdb))
- **main:** release 2.77.0 ([7b65bb9](https://github.com/Millennium44/Toolasha/commit/7b65bb96bb988512bf00cb04fbe29419c9d6e05d))
- **main:** release 2.77.0 ([1c560a6](https://github.com/Millennium44/Toolasha/commit/1c560a60fa40a32124f9284433b95c12d99c1440))
- **main:** release 2.77.1 ([a3170dc](https://github.com/Millennium44/Toolasha/commit/a3170dca101fbe03eabe1ca36cbfe304733c0ba4))
- **main:** release 2.77.1 ([14a107b](https://github.com/Millennium44/Toolasha/commit/14a107b481ec6bb7b19bffa73bbc657486773a3c))
- **main:** release 2.77.2 ([03f7024](https://github.com/Millennium44/Toolasha/commit/03f7024ac2aace2c78da99c0ee99716ad326d789))
- **main:** release 2.77.2 ([bc96ce7](https://github.com/Millennium44/Toolasha/commit/bc96ce7c2a9fe7a14fc3fe2eb3ceca1d84777b27))
- **main:** release 2.78.0 ([02a618a](https://github.com/Millennium44/Toolasha/commit/02a618aeb052009c80525919f798627df7cb85fc))
- **main:** release 2.78.0 ([19e446b](https://github.com/Millennium44/Toolasha/commit/19e446b196a9d8291db70739e881e4eb18a3ab64))
- **main:** release 2.79.0 ([d9a8c15](https://github.com/Millennium44/Toolasha/commit/d9a8c150acea8a623cd70d36c97796d43399e832))
- **main:** release 2.79.0 ([926b54b](https://github.com/Millennium44/Toolasha/commit/926b54beb01799d5a547c224e0ec6eb52a529fe6))
- **main:** release 2.80.0 ([02a1efd](https://github.com/Millennium44/Toolasha/commit/02a1efdb75feedd55ff2c35e01be8c1957b30513))
- **main:** release 2.80.0 ([7be3b0f](https://github.com/Millennium44/Toolasha/commit/7be3b0fb2ab0def760f3380d6f1e2c7f43166a4b))
- **main:** release 2.80.1 ([2b109b5](https://github.com/Millennium44/Toolasha/commit/2b109b518e3510ace0f9b1e26d43e4c249a5cd37))
- **main:** release 2.80.1 ([4c5ddfd](https://github.com/Millennium44/Toolasha/commit/4c5ddfdb58ba8e8ca5e984b20bbd3a7dcfea0aae))
- **main:** release 2.80.2 ([03517b0](https://github.com/Millennium44/Toolasha/commit/03517b09437148b69106b646f5b0617a34910401))
- **main:** release 2.80.2 ([f112d55](https://github.com/Millennium44/Toolasha/commit/f112d5511631b04be9ecb6d34a9532fde2b700ab))
- **main:** release 2.81.0 ([e28c835](https://github.com/Millennium44/Toolasha/commit/e28c835438898e1e3f80bc4a9d703e74aba78f93))
- **main:** release 2.81.0 ([fd52d1b](https://github.com/Millennium44/Toolasha/commit/fd52d1bfa77e641d799b5bd1f175f8af7e47a39f))
- **main:** release 2.82.0 ([2ad4963](https://github.com/Millennium44/Toolasha/commit/2ad4963eed7a8c8eabc6ee245096afc2b2e0d1b0))
- **main:** release 2.82.0 ([ca923f6](https://github.com/Millennium44/Toolasha/commit/ca923f654c61e7dacb5070b0a7c844972a77bebe))
- **main:** release 2.82.1 ([fac675a](https://github.com/Millennium44/Toolasha/commit/fac675afc8f828698280d40a16245fb7af5e0fcd))
- **main:** release 2.82.1 ([2c41327](https://github.com/Millennium44/Toolasha/commit/2c413278d025a20f35c842db21de6df023d8ef38))
- **main:** release 2.83.0 ([c8f2ca7](https://github.com/Millennium44/Toolasha/commit/c8f2ca7fde0f02f6c854dadd10321e7f24ce10e4))
- **main:** release 2.83.0 ([83eda7a](https://github.com/Millennium44/Toolasha/commit/83eda7a68cb9f389451c3cce5c3ee64261a59dc6))
- **main:** release 2.84.0 ([77e9ddb](https://github.com/Millennium44/Toolasha/commit/77e9ddb8a0120c84bfbae7b530e4b7e02df78fd9))
- **main:** release 2.84.0 ([fe22bdf](https://github.com/Millennium44/Toolasha/commit/fe22bdfc6046b6f495d9d3abcc0c883c68fef093))
- remove guild activity calculator (pending game redesign) ([2250ef1](https://github.com/Millennium44/Toolasha/commit/2250ef1b4bea777d4423f49342608830a060220c))
- remove loadoutSort feature superseded by native game drag-and-drop ([b44502c](https://github.com/Millennium44/Toolasha/commit/b44502cff80e8a0d863ccb706f6249850f1607c6))
- rename userscript to Toolasha (Millennium44) ([77f3e1b](https://github.com/Millennium44/Toolasha/commit/77f3e1ba0572d0cbda6d9c9993a5e508d0196d22))
- sunset the reroll stepper for now ([e317150](https://github.com/Millennium44/Toolasha/commit/e317150c97f7fa6c5b113cc8991f8ed2643d0365))
- sync version and format release notes ([9e7c1e1](https://github.com/Millennium44/Toolasha/commit/9e7c1e1a103a15e86118955082e086448474b97f))
- sync version and format release notes ([c5971dc](https://github.com/Millennium44/Toolasha/commit/c5971dc9fef3d6feb116b0ccd73d54904f59f4b4))
- sync version and format release notes ([ff629a8](https://github.com/Millennium44/Toolasha/commit/ff629a84cc3568f9c5d50da23ee8e537c5b43926))
- sync version and format release notes ([5fb163a](https://github.com/Millennium44/Toolasha/commit/5fb163a50f669087d4cf5ede0a5c5bdd4ba4bcaf))
- sync version and format release notes ([11d1b2c](https://github.com/Millennium44/Toolasha/commit/11d1b2ca7ae0ea48b71c82af008d375baa383bd6))
- sync version and format release notes ([fc253bb](https://github.com/Millennium44/Toolasha/commit/fc253bb1322ae273ec8d69196b9779023f7845a0))
- sync version and format release notes ([55326ad](https://github.com/Millennium44/Toolasha/commit/55326adcfae21f4e74f79081d52513f9833c9f5d))
- sync version and format release notes ([76337d6](https://github.com/Millennium44/Toolasha/commit/76337d65d5fe364a210c22b2cfc0362a506fe67c))
- sync version and format release notes ([e690b8c](https://github.com/Millennium44/Toolasha/commit/e690b8cecfe5c6f3607ab7cb70262e0074833240))
- sync version and format release notes ([1da5317](https://github.com/Millennium44/Toolasha/commit/1da53172d28882796efe13251c65ca58adbb1bab))
- sync version and format release notes ([b4133de](https://github.com/Millennium44/Toolasha/commit/b4133de4ec9f5b8d07602f6cd09979cb46ae04b4))
- sync version and format release notes ([630dc92](https://github.com/Millennium44/Toolasha/commit/630dc92c35410bb4c82300ab9945a0e7ecd205a9))
- sync version and format release notes ([fced384](https://github.com/Millennium44/Toolasha/commit/fced38440aedbab7e9081fa94d98a949921f188a))
- sync version and format release notes ([625b2d0](https://github.com/Millennium44/Toolasha/commit/625b2d010776013212c9e6742ff8a37a2d9f81ce))
- sync version and format release notes ([f37852e](https://github.com/Millennium44/Toolasha/commit/f37852e8741ac779943b77b375ab8a4723a3fc37))
- sync version and format release notes ([61931d9](https://github.com/Millennium44/Toolasha/commit/61931d94ac1fd209d3ea339f56b48d98186bbfce))
- sync version and format release notes ([2f8a2c8](https://github.com/Millennium44/Toolasha/commit/2f8a2c8af054f0d9ad80a5ceb375a5169a26d710))
- sync version and format release notes ([72852d0](https://github.com/Millennium44/Toolasha/commit/72852d0c7161bf6d3ae9d1cf1e244854ab262d84))
- sync version and format release notes ([fb02fd7](https://github.com/Millennium44/Toolasha/commit/fb02fd7b2aeb0fa5579feb121d1d0ce8b07a2e67))
- sync version and format release notes ([11a42e4](https://github.com/Millennium44/Toolasha/commit/11a42e4726d0f3c19422525d877d0440acd188a5))
- sync version and format release notes ([ae31ec0](https://github.com/Millennium44/Toolasha/commit/ae31ec061353016a9dd97e56ab1698a2725b135d))
- sync version and format release notes ([1a2d93f](https://github.com/Millennium44/Toolasha/commit/1a2d93fd3dbe6b32f5e16aa19ee663fb2a804f15))
- sync version and format release notes ([0898e16](https://github.com/Millennium44/Toolasha/commit/0898e1693dfaf8ade929d4901b4f666ee70d63e1))
- sync version and format release notes ([adca1d9](https://github.com/Millennium44/Toolasha/commit/adca1d92fb387628a2ba91191980d11de1b5f180))
- sync version and format release notes ([1c8fabf](https://github.com/Millennium44/Toolasha/commit/1c8fabf649b3795a157ba94e33ce85b854a4656f))
- sync version and format release notes ([9f92a18](https://github.com/Millennium44/Toolasha/commit/9f92a18e988c2073eb686fafc7297569fedd3030))
- sync version and format release notes ([9904f00](https://github.com/Millennium44/Toolasha/commit/9904f0036d87f35ba90f94e56a2e97a8b5e5d499))
- sync version and format release notes ([c061463](https://github.com/Millennium44/Toolasha/commit/c061463591105f3b1c7f227e04d84ed33b1a1cdf))
- sync version and format release notes ([c3771dc](https://github.com/Millennium44/Toolasha/commit/c3771dc4edcc3daa86be8d6c7f8b9064283f7028))
- sync version and format release notes ([56a3421](https://github.com/Millennium44/Toolasha/commit/56a34215d30e5a74cbdc61f129f2330641159efd))
- sync version and format release notes ([edba626](https://github.com/Millennium44/Toolasha/commit/edba626e0e798cfe1edaaccb8165ddd0e46656da))
- sync version and format release notes ([1aac023](https://github.com/Millennium44/Toolasha/commit/1aac023230d5cfbc345208c589cd45ada600116d))
- sync version and format release notes ([a732a5f](https://github.com/Millennium44/Toolasha/commit/a732a5f49c04c1cf551968982a6a4d9824d330f9))
- sync version and format release notes ([a242b24](https://github.com/Millennium44/Toolasha/commit/a242b241c260ba0b6642478ae251de89421ba4b2))
- sync version and format release notes ([2b2385b](https://github.com/Millennium44/Toolasha/commit/2b2385b547fbfca510154733fa17dfe7179c63cf))
- sync version and format release notes ([d711729](https://github.com/Millennium44/Toolasha/commit/d711729bf008183f97d75037d85ae8cae5f067aa))
- sync version and format release notes ([904ab7d](https://github.com/Millennium44/Toolasha/commit/904ab7d2388295963349e849efc9d3f6f9148c2c))
- sync version and format release notes ([2cc91ed](https://github.com/Millennium44/Toolasha/commit/2cc91ed5a54735b53dcda0dd4501b30a1ad65926))
- sync version and format release notes ([6665acf](https://github.com/Millennium44/Toolasha/commit/6665acfc072597a853f9ecbae3f46af7138a5dbd))
- sync version and format release notes ([9490d27](https://github.com/Millennium44/Toolasha/commit/9490d27fd0eab1b7472511dbb718ff3449dca961))
- sync version and format release notes ([7f303b9](https://github.com/Millennium44/Toolasha/commit/7f303b93734a5012dcee08fa22709d0c1408c432))
- sync version and format release notes ([a80b86f](https://github.com/Millennium44/Toolasha/commit/a80b86f4a050370d4d6715156ac6dfadcf97d27f))
- sync version and format release notes ([d34ce25](https://github.com/Millennium44/Toolasha/commit/d34ce256472386145cf1478853deb0c79a9abd4b))
- sync version and format release notes ([97e54b8](https://github.com/Millennium44/Toolasha/commit/97e54b8b16ca0e7431b5e9bf2ccf10701711f81a))
- sync version and format release notes ([1270a1b](https://github.com/Millennium44/Toolasha/commit/1270a1bcfe1887f5b4ca12bd2d883d8549e378a5))
- sync version and format release notes ([5303575](https://github.com/Millennium44/Toolasha/commit/5303575d2151453c0bfe3804ba196796f7cee85b))
- sync version and format release notes ([93e5025](https://github.com/Millennium44/Toolasha/commit/93e5025d511657b3f6a80185c062f9d4d969f84a))
- sync version and format release notes ([5ad24c0](https://github.com/Millennium44/Toolasha/commit/5ad24c04cac69f831e5059c6eabf2554c3464de8))
- sync version and format release notes ([5486887](https://github.com/Millennium44/Toolasha/commit/548688774ab110cbf995f3a24087edb04c4ff44b))
- sync version and format release notes ([757d5d5](https://github.com/Millennium44/Toolasha/commit/757d5d5ddd4ae3b3fc9fa8108bd066050067f3e6))
- sync version and format release notes ([9e7ca0b](https://github.com/Millennium44/Toolasha/commit/9e7ca0b989f30cd48ec172722d14e31d1585fcc7))
- sync version and format release notes ([638e02a](https://github.com/Millennium44/Toolasha/commit/638e02ac26e44452d2f17cbb10e038666c38d308))
- sync version and format release notes ([d8d207a](https://github.com/Millennium44/Toolasha/commit/d8d207ac6d9c70441ecf39d8623856df0b7510d6))
- sync version and format release notes ([3520a58](https://github.com/Millennium44/Toolasha/commit/3520a588c9038202460c054125c637113fe35dd5))
- sync version and format release notes ([e549011](https://github.com/Millennium44/Toolasha/commit/e549011393c5557687e4f7c801cc2edd446d033d))
- sync version and format release notes ([570f1e6](https://github.com/Millennium44/Toolasha/commit/570f1e663c9933703b4af8382e103facdc11dbfe))
- sync version and format release notes ([0dc5d05](https://github.com/Millennium44/Toolasha/commit/0dc5d056653c8ffe7e4738d155509befc3fcbb2a))
- sync version and format release notes ([72d3840](https://github.com/Millennium44/Toolasha/commit/72d384096f09792cf88b4db5211c1366ddf1b169))
- sync version and format release notes ([3703a79](https://github.com/Millennium44/Toolasha/commit/3703a79a62a84c0d41ef8173bbe1c567056f44dd))
- sync version and format release notes ([8742dc6](https://github.com/Millennium44/Toolasha/commit/8742dc6a973160251d3ed369b56b40fa551888a4))
- sync version and format release notes ([ca2eaa9](https://github.com/Millennium44/Toolasha/commit/ca2eaa9ff2af7413827b37ff987355d5115f5d9b))
- sync version and format release notes ([a5565d6](https://github.com/Millennium44/Toolasha/commit/a5565d61ecd407bca82f665789504770e3c86784))
- sync version and format release notes ([5962c5a](https://github.com/Millennium44/Toolasha/commit/5962c5a954b126391637a9e5fffb1c846ee8f54c))
- sync version and format release notes ([868a7e9](https://github.com/Millennium44/Toolasha/commit/868a7e98874b1eba44a8ab0d518a63a142b1db4d))
- sync version and format release notes ([c3a048e](https://github.com/Millennium44/Toolasha/commit/c3a048e009737214be4c8f000dd3e87d5363dbab))
- sync version and format release notes ([aacceca](https://github.com/Millennium44/Toolasha/commit/aaccecad7ce8fb897f170749349a4e3d87e42b36))
- sync version and format release notes ([d1b0548](https://github.com/Millennium44/Toolasha/commit/d1b0548995405270d9f2f29f800f5e5f6bef8ec4))
- sync version and format release notes ([424b02a](https://github.com/Millennium44/Toolasha/commit/424b02a6a69f6d4a39ce5308e343460244685724))
- sync version and format release notes ([65c4246](https://github.com/Millennium44/Toolasha/commit/65c42462e120ef38f369bebe9a8c93734058d986))
- sync version and format release notes ([d5efe94](https://github.com/Millennium44/Toolasha/commit/d5efe94ec0403de8044c98765ee40a61169c2390))
- sync version and format release notes ([04ec4a4](https://github.com/Millennium44/Toolasha/commit/04ec4a42cef8da4282afe044ca6bfc3f6720dd28))
- sync version and format release notes ([4f2e049](https://github.com/Millennium44/Toolasha/commit/4f2e0496f7501f091f5f1f12c4eb2b02a6bfd17e))
- sync version and format release notes ([8b715fa](https://github.com/Millennium44/Toolasha/commit/8b715fa8ee88e9e3d0ba9a7fda87a17e5ec0ff18))
- sync version and format release notes ([7b57b9a](https://github.com/Millennium44/Toolasha/commit/7b57b9a22425ad81517d8da3e82e2a4ac426f586))
- sync version and format release notes ([0b78899](https://github.com/Millennium44/Toolasha/commit/0b788996cb216f3d4d2a9edf86964ee6b463c09f))
- trigger release pipeline ([861e17a](https://github.com/Millennium44/Toolasha/commit/861e17ad84c053fbf695ef58bcb7f74be967330b))

## [2.84.0](https://github.com/Celasha/Toolasha/compare/v2.83.0...v2.84.0) (2026-07-27)

### Features

- add Protection sort mode to task sorter ([f160f54](https://github.com/Celasha/Toolasha/commit/f160f548e66cda38d68c41b8313bcec3ee6aad36))

### Bug Fixes

- remove stale Rec badge when skip threshold is edited ([e2d5ad6](https://github.com/Celasha/Toolasha/commit/e2d5ad68d880a5cec4ee0c10192c096343844c68))
- skip battle counter injection when no active combat action ([46db6ec](https://github.com/Celasha/Toolasha/commit/46db6ecae50f76260dd2149525189b2dbe75e794))

## [2.83.0](https://github.com/Celasha/Toolasha/compare/v2.82.1...v2.83.0) (2026-07-26)

### Features

- add draggable modals with remembered position ([5d41e5a](https://github.com/Celasha/Toolasha/commit/5d41e5a4e3d315d1e479908f2e26efa13dd7279f))
- consolidate lab sim inputs into Configure tab with auto-loadout ([7cb624e](https://github.com/Celasha/Toolasha/commit/7cb624e89db01aa0a6f43c33fa001932ef7b7631))
- overhaul skilling optimizer to show loadout-relative progression ([efb990f](https://github.com/Celasha/Toolasha/commit/efb990f21a67ab5de8fe80f5454987b7bb1aa810))

### Bug Fixes

- give Lab Simulator its own independent setting ([33e405a](https://github.com/Celasha/Toolasha/commit/33e405ad21e0847564726f8ae1c4bb94b9ec699d))
- make skilling optimizer score alchemy equipment correctly ([400b148](https://github.com/Celasha/Toolasha/commit/400b148715a6b908bf2da8375736d92e0da6d35a))
- register skillingOptimizer in config features map ([dc53b94](https://github.com/Celasha/Toolasha/commit/dc53b94f8bc969df00de090106b3fa95452001f4))
- sort loadout dropdowns by server ordinal ([acfca19](https://github.com/Celasha/Toolasha/commit/acfca19dd0a4227a2bc39bbad57afaa4d24d3264))

## [2.82.1](https://github.com/Celasha/Toolasha/compare/v2.82.0...v2.82.1) (2026-07-24)

### Bug Fixes

- defer skilling optimizer style injection until DOM is ready ([dba550b](https://github.com/Celasha/Toolasha/commit/dba550ba4692b814f684c3ebf5375a5ce4f4e779))
- rebuild equipment section when skill changes in simulator ([fd2d06a](https://github.com/Celasha/Toolasha/commit/fd2d06a2a9425900f3daf405a3071ffaad0e8778))

### Code Refactoring

- split leaderboard XP tracking into independent feature ([4d2fc58](https://github.com/Celasha/Toolasha/commit/4d2fc58defa8dbe45fe067ea449be39117d828dd))

## [2.82.0](https://github.com/Celasha/Toolasha/compare/v2.81.0...v2.82.0) (2026-07-24)

### Features

- add Skilling Simulator and Optimizer tab to character panel ([3318f48](https://github.com/Celasha/Toolasha/commit/3318f48634cce30a4f3338deb999213128f2d4f8))
- make all My Listings table headers sortable ([81f1a54](https://github.com/Celasha/Toolasha/commit/81f1a54e5817f60c25aae4f183a7355ab2db79a2))

### Bug Fixes

- show drink timer on Alchemy and Enhancing panels ([2a3c25e](https://github.com/Celasha/Toolasha/commit/2a3c25e467c4e63255ce158c91ec56155db2579d))
- use profit as secondary sort when sorting Best Items by XP, and vice versa ([bb6b66e](https://github.com/Celasha/Toolasha/commit/bb6b66e83ce6b9be1f36cc0f2d0570c669cf166b))

## [2.81.0](https://github.com/Celasha/Toolasha/compare/v2.80.2...v2.81.0) (2026-07-23)

### Features

- add listing refresh navigator to My Listings page ([107c118](https://github.com/Celasha/Toolasha/commit/107c11877a34cd2315e8a94255fc6d833a28a3c3))

## [2.80.2](https://github.com/Celasha/Toolasha/compare/v2.80.1...v2.80.2) (2026-07-22)

### Bug Fixes

- compute upgrade advisor DPS from actual damage dealt instead of XP/hr ([cf83826](https://github.com/Celasha/Toolasha/commit/cf83826bc534adfb1629e9458942c3ed56ab5553))
- key player leaderboard XP history by category to prevent cross-category contamination ([9090a6a](https://github.com/Celasha/Toolasha/commit/9090a6aad1cd5f787e74ee65cde9dfb312256a74))
- use refined item costs for mirror path instead of non-refined base item ([9dd1941](https://github.com/Celasha/Toolasha/commit/9dd1941bebad166edf33cdafe008fe9c5c143cbc))

## [2.80.1](https://github.com/Celasha/Toolasha/compare/v2.80.0...v2.80.1) (2026-07-22)

### Bug Fixes

- skip sort registration in max-produceable for gathering panels ([afbaa9a](https://github.com/Celasha/Toolasha/commit/afbaa9a60d58815b929a640ea5746afa383f13c7))

## [2.80.0](https://github.com/Celasha/Toolasha/compare/v2.79.0...v2.80.0) (2026-07-22)

### Features

- use session-based XP/hr for combat skills ([2494e52](https://github.com/Celasha/Toolasha/commit/2494e52d5cea024baf55a50b12157bb4cdf02afd))

### Bug Fixes

- register production panels with sort manager when pinned page is off ([f79a20c](https://github.com/Celasha/Toolasha/commit/f79a20c5c55c0e09101069f6957f8b1f10eee3b3))

## [2.79.0](https://github.com/Celasha/Toolasha/compare/v2.78.0...v2.79.0) (2026-07-22)

### Features

- add configurable whisper template for guild trial unsigned members ([f8cd052](https://github.com/Celasha/Toolasha/commit/f8cd052aa0252aa0fc6b7e07fb969f86a7b3709a))
- add per-player DPS to combat sim results ([65b564d](https://github.com/Celasha/Toolasha/commit/65b564d91c68fa5640eb72829cb3300f8f810aea))

### Bug Fixes

- correct guild shrine costs and enhance protect-from race condition ([81796a1](https://github.com/Celasha/Toolasha/commit/81796a1be4512436b92b1868a9928062b01216b4))
- stabilize task card heights and fix task reroll tracker display ([7c6aa23](https://github.com/Celasha/Toolasha/commit/7c6aa230b9a906c4163e39886974a60bf78dbd5d))

## [2.78.0](https://github.com/Celasha/Toolasha/compare/v2.77.2...v2.78.0) (2026-07-21)

### Features

- add exchange advisor to guild credit modal ([66d11b5](https://github.com/Celasha/Toolasha/commit/66d11b5e5a09b261642df3b2ad14d3452ee2c259))
- add mana run out, debuff on level gap, and wipe event log to combat sim results ([0a8fbd9](https://github.com/Celasha/Toolasha/commit/0a8fbd9dc016720d351bd026217594ea249872a8))
- add shrine upgrade planner to guild credit exchange panel ([783a04a](https://github.com/Celasha/Toolasha/commit/783a04a0639c52931dc2c98c2b005e73c2ae0e82))

### Bug Fixes

- return defaultValue from storage.get when stored value is null ([7e5ce1e](https://github.com/Celasha/Toolasha/commit/7e5ce1eb0ceff763a5c92cf545e6ca29dfd4c6b9))

## [2.77.2](https://github.com/Celasha/Toolasha/compare/v2.77.1...v2.77.2) (2026-07-19)

### Bug Fixes

- resolve [Unknown action] for items with mismatched display name and HRID ([3190702](https://github.com/Celasha/Toolasha/commit/3190702ce5c704b94c3face20a1ad1a0c0d32137))

## [2.77.1](https://github.com/Celasha/Toolasha/compare/v2.77.0...v2.77.1) (2026-07-19)

### Bug Fixes

- remove parentheses from trial tier badge to prevent line wrap ([4f9f484](https://github.com/Celasha/Toolasha/commit/4f9f4848b9ef1cd3de025d4a0dae58af7a7b9a4a))

## [2.77.0](https://github.com/Celasha/Toolasha/compare/v2.76.0...v2.77.0) (2026-07-19)

### Features

- show tier label on guild trial tiles ([5692a3e](https://github.com/Celasha/Toolasha/commit/5692a3e0af918805c106cf94b5831773f73c726f))

## [2.76.0](https://github.com/Celasha/Toolasha/compare/v2.75.0...v2.76.0) (2026-07-19)

### Features

- add Copy List button to guild trial signup modals ([c60b883](https://github.com/Celasha/Toolasha/commit/c60b88345846320592a50a44f2b7b96e548199c9))
- auto-fill enhancement target level from settings ([54dfa65](https://github.com/Celasha/Toolasha/commit/54dfa659813313e240f88550889af1ecefb9b16a))
- auto-fill optimal protect-from level when protection item is set ([7b44dba](https://github.com/Celasha/Toolasha/commit/7b44dba83598026aa7121a6a35359c5f9273464e))

### Bug Fixes

- decrement and remove shrine missing mats tabs on purchase ([2a3032a](https://github.com/Celasha/Toolasha/commit/2a3032a4bf13a6bb14564c208a1c8b8215632407))

## [2.75.0](https://github.com/Celasha/Toolasha/compare/v2.74.2...v2.75.0) (2026-07-18)

### Features

- add missing mats marketplace button to shrine upgrade cost table ([89f51bc](https://github.com/Celasha/Toolasha/commit/89f51bc02fcd1d6684aa45f19f34eff7084f0043))
- add missing mats marketplace tabs to shrine upgrade modal ([3656e84](https://github.com/Celasha/Toolasha/commit/3656e843fd44210d7fad91f86fcfe62b288f358d))

### Bug Fixes

- include guild shrine buffs in combat simulator ([667a2e7](https://github.com/Celasha/Toolasha/commit/667a2e7ac6548bb39227ccbc6349cf75bc8ac5b5))
- show guild shrine buffs in action breakdown displays ([93e47fc](https://github.com/Celasha/Toolasha/commit/93e47fc268ddd4a5f3219daf2c0b3ea2deccb782))

## [2.74.2](https://github.com/Celasha/Toolasha/compare/v2.74.1...v2.74.2) (2026-07-18)

### Bug Fixes

- add expand button to abilities & triggers panel to avoid scrolling ([40e68c7](https://github.com/Celasha/Toolasha/commit/40e68c747267ff93cce4c6e5d1ef69eeb54741b9))

## [2.74.1](https://github.com/Celasha/Toolasha/compare/v2.74.0...v2.74.1) (2026-07-18)

### Bug Fixes

- include guild shrine buffs in all skilling calculations ([f2b444f](https://github.com/Celasha/Toolasha/commit/f2b444f8bf89abd85103309ce00a55deac19cc5a))

## [2.74.0](https://github.com/Celasha/Toolasha/compare/v2.73.0...v2.74.0) (2026-07-17)

### Features

- add option to hide Guild notification badge in sidebar ([a75e91f](https://github.com/Celasha/Toolasha/commit/a75e91fe25f397773bf880aa71467719b7955234))
- auto-advance to next sell queue tab when item sells out ([0ffb3e6](https://github.com/Celasha/Toolasha/commit/0ffb3e6933a2621b4cdda17ebc77e54ecc55b715))

### Bug Fixes

- correct Game Mode sort misalignment and Activity hidden-status ordering ([3fc4b2a](https://github.com/Celasha/Toolasha/commit/3fc4b2a02fbb470edad6940f7bed66cea5e8882b))
- handle DD/MM date format in dungeon tracker chat timestamp parser ([903c353](https://github.com/Celasha/Toolasha/commit/903c3534705ae182d602e377cf38ef016b40a9e9))
- preserve blue ocean badges when hiding guild and labyrinth badges ([5e026d8](https://github.com/Celasha/Toolasha/commit/5e026d8dedd84534cd5c5f407032e376912fd6d1))

## [2.73.0](https://github.com/Celasha/Toolasha/compare/v2.72.2...v2.73.0) (2026-07-15)

### Features

- add Sell Queue — Shift+RightClick inventory items to sell ([c38aa7b](https://github.com/Celasha/Toolasha/commit/c38aa7b8ae918e6c070184e758f0cca9503d4afd))

## [2.72.2](https://github.com/Celasha/Toolasha/compare/v2.72.1...v2.72.2) (2026-07-15)

### Bug Fixes

- add clickable ask/bid column sorting to guild credit modals ([739f516](https://github.com/Celasha/Toolasha/commit/739f516a1516129fb99dcd2ec70ee3f8ef023ac4))
- show top-3 conversion options in shrine upgrade cost table ([17eb9f4](https://github.com/Celasha/Toolasha/commit/17eb9f4705270581507085af8c334938b100e98a))

## [2.72.1](https://github.com/Celasha/Toolasha/compare/v2.72.0...v2.72.1) (2026-07-15)

### Bug Fixes

- hide pin icons on tiles when pinned actions page is disabled ([d238dc9](https://github.com/Celasha/Toolasha/commit/d238dc9728cf32eb98c66d40a87932d8c7fc29a9))
- relocate Activity column and correct per-tab placement ([209577e](https://github.com/Celasha/Toolasha/commit/209577e215924f00789ce03518322c00524a1522))

### Code Refactoring

- reorganize settings into 25 focused groups ([3117c91](https://github.com/Celasha/Toolasha/commit/3117c910ed6ea70071da9ba49716763413ffba73))
- split profit/hr and exp/hr tile settings by action type ([6b6d533](https://github.com/Celasha/Toolasha/commit/6b6d533d203822fa16245bbb42568dc5ed1273df))

## [2.72.0](https://github.com/Celasha/Toolasha/compare/v2.71.1...v2.72.0) (2026-07-15)

### Features

- add gold cost per credit table to guild credit exchange modals ([5af726c](https://github.com/Celasha/Toolasha/commit/5af726c4217ed0a5bef51119abe68caf8f92ea66))
- add per-character selector to Copy Settings button ([507501b](https://github.com/Celasha/Toolasha/commit/507501b14163781703be0fd73bb170fc2fc43841))
- add per-column toggles and tab routing for guild Members columns ([7841384](https://github.com/Celasha/Toolasha/commit/78413843607b00404a4f2f3ff5c8a743c68ef12a))
- add shrine upgrade cost table and ask/bid columns to guild credit modals ([501cc92](https://github.com/Celasha/Toolasha/commit/501cc92a0d94aa6258ae6357c200b1ac14c64d8e))

### Bug Fixes

- always initialize max-produceable feature regardless of setting ([a4c0198](https://github.com/Celasha/Toolasha/commit/a4c0198cce5bfddb875c436109c0212c1150d5fd))
- exclude new members from unsigned trial list until next reset ([d128583](https://github.com/Celasha/Toolasha/commit/d12858389805c8aaa66c0377e8fc5a47e38b3f9c))

## [2.71.1](https://github.com/Celasha/Toolasha/compare/v2.71.0...v2.71.1) (2026-07-14)

### Bug Fixes

- unify action panel into a single scroll container ([1139933](https://github.com/Celasha/Toolasha/commit/1139933f0e218e21cfdd0180fc7228f1289ea21e))

## [2.71.0](https://github.com/Celasha/Toolasha/compare/v2.70.2...v2.71.0) (2026-07-14)

### Features

- show unsigned trial members list in guild Trials tab ([2fc01ce](https://github.com/Celasha/Toolasha/commit/2fc01ceb574df0fe311a3e6a13e283f4507e3dec))

### Bug Fixes

- add Activity column to guild Contributions tab ([7c70384](https://github.com/Celasha/Toolasha/commit/7c703843a88466bfeadb7321c72a274d29710539))
- sort Weekly XP column numerically with K/M suffix support ([6687524](https://github.com/Celasha/Toolasha/commit/66875241f18e849289c65e47e2ef8906fe23cef7))

### Miscellaneous Chores

- remove loadoutSort feature superseded by native game drag-and-drop ([b44502c](https://github.com/Celasha/Toolasha/commit/b44502cff80e8a0d863ccb706f6249850f1607c6))

## [2.70.2](https://github.com/Celasha/Toolasha/compare/v2.70.1...v2.70.2) (2026-07-13)

### Bug Fixes

- make action panel bottom section scrollable ([9708195](https://github.com/Celasha/Toolasha/commit/9708195dd489e0c008eec0f707a8837e2003abf2))
- prevent Build button collapse when cumulative section is tall ([4f6b0a3](https://github.com/Celasha/Toolasha/commit/4f6b0a33e231650d09e998d2136cc98e11b6bfea))

## [2.70.1](https://github.com/Celasha/Toolasha/compare/v2.70.0...v2.70.1) (2026-07-10)

### Bug Fixes

- show ask total in tooltip even when bid is missing ([b74a82c](https://github.com/Celasha/Toolasha/commit/b74a82c02ee1825759ad77e101eef08ceb066104))

## [2.70.0](https://github.com/Celasha/Toolasha/compare/v2.69.2...v2.70.0) (2026-07-10)

### Features

- add drink timer to skill panel consumables section ([08409f2](https://github.com/Celasha/Toolasha/commit/08409f2ce281a7a00ec7cfbd4fb1b612f392f6d3))

### Bug Fixes

- always show ×count in item tooltip price line ([17ed970](https://github.com/Celasha/Toolasha/commit/17ed9701e475ab6a6e481e726b8043a55d74928f))

## [2.69.2](https://github.com/Celasha/Toolasha/compare/v2.69.1...v2.69.2) (2026-07-06)

### Bug Fixes

- exclude out-of-stock drinks from artisan bonus calculations ([421f3db](https://github.com/Celasha/Toolasha/commit/421f3db9fc012ce639b0685549b6bf24442a824e))

## [2.69.1](https://github.com/Celasha/Toolasha/compare/v2.69.0...v2.69.1) (2026-07-06)

### Bug Fixes

- add configurable thresholds to cap reroll protection ([1fb551c](https://github.com/Celasha/Toolasha/commit/1fb551c4478e4238eae13e1668f16a1c501a9343))

## [2.69.0](https://github.com/Celasha/Toolasha/compare/v2.68.1...v2.69.0) (2026-07-06)

### Features

- add global reroll-at-cap protection to task reroll protection ([e0aef30](https://github.com/Celasha/Toolasha/commit/e0aef30b3a19437f60a4356e8b3cf188985f0eb7))

## [2.68.1](https://github.com/Celasha/Toolasha/compare/v2.68.0...v2.68.1) (2026-07-01)

### Bug Fixes

- correct efficiency in level calculator and Total time display ([419c4c8](https://github.com/Celasha/Toolasha/commit/419c4c822ade9ec6c18db078373aa6eb6c245c5a))
- keep guild Joined date on a single line ([860b373](https://github.com/Celasha/Toolasha/commit/860b3730dd21a7ac1aa8c142d7e8d02dca5395dc))
- use saved loadout snapshot for XP, time, and material predictions ([1722782](https://github.com/Celasha/Toolasha/commit/17227821b0f0eac052ae513baecadc705bfc2f82))

## [2.68.0](https://github.com/Celasha/Toolasha/compare/v2.67.7...v2.68.0) (2026-06-27)

### Features

- add Expand All / Collapse All buttons to Custom Tabs ([8d4e367](https://github.com/Celasha/Toolasha/commit/8d4e367c2fe1c31b42231e8379b7099246f7054c))
- prefix queue completion times with date when not today ([ebab9d2](https://github.com/Celasha/Toolasha/commit/ebab9d2c57590f97f5c8b1750ab2e6b28803e69e))

### Bug Fixes

- show MooPass wisdom line in XP bonus breakdown ([95d5146](https://github.com/Celasha/Toolasha/commit/95d5146a1e286a49671a949fe5593292a1f598cb))

## [2.67.7](https://github.com/Celasha/Toolasha/compare/v2.67.6...v2.67.7) (2026-06-26)

### Bug Fixes

- use inline-flex to force action-bar time line to one row ([e4b6260](https://github.com/Celasha/Toolasha/commit/e4b62603fe1bc58525065227f205f2faf7f836cb))

## [2.67.6](https://github.com/Celasha/Toolasha/compare/v2.67.5...v2.67.6) (2026-06-26)

### Bug Fixes

- keep action-bar time/icon line together on narrow screens ([96eda6a](https://github.com/Celasha/Toolasha/commit/96eda6af4a1975e3d7143086a535cdd5042d292d))
- use 2-digit year in formatDateTime to keep guild Joined column on one line ([ced1d5c](https://github.com/Celasha/Toolasha/commit/ced1d5c52ee50e502d3de60cd7878702f6bd4ae6))

## [2.67.5](https://github.com/Celasha/Toolasha/compare/v2.67.4...v2.67.5) (2026-06-24)

### Bug Fixes

- restore year on guild Joined column ([ba2b5e1](https://github.com/Celasha/Toolasha/commit/ba2b5e172ebfde77b69c5cc81dd53b89698b810c))

### Documentation

- clarify networth setting labels to match actual behavior ([eb833aa](https://github.com/Celasha/Toolasha/commit/eb833aaaa3dddefc094b039396fa4e21aa41647e))

## [2.67.4](https://github.com/Celasha/Toolasha/compare/v2.67.3...v2.67.4) (2026-06-21)

### Performance Improvements

- also gate badge fallback enhancement-cost calc on networth feature ([9d62d61](https://github.com/Celasha/Toolasha/commit/9d62d614a5e71aedc7de18e377e5a2ebdcf6389b))

## [2.67.3](https://github.com/Celasha/Toolasha/compare/v2.67.2...v2.67.3) (2026-06-21)

### Performance Improvements

- skip enhancement-cost badge calc when networth is disabled ([e95445f](https://github.com/Celasha/Toolasha/commit/e95445f6dfe19b5e9c3d0fac63bd0a0a74202bca))

### Continuous Integration

- run format workflow on bot pushes to release-please PRs ([eed699d](https://github.com/Celasha/Toolasha/commit/eed699dcbeece9c6bef6104e5c9748fa2816fc66))

## [2.67.2](https://github.com/Celasha/Toolasha/compare/v2.67.1...v2.67.2) (2026-06-21)

### Miscellaneous Chores

- format release notes ([38444c6](https://github.com/Celasha/Toolasha/commit/38444c65a6185dd42824b6388baa0ec41b7f284f))

## [2.67.1](https://github.com/Celasha/Toolasha/compare/v2.67.0...v2.67.1) (2026-06-21)

### Bug Fixes

- stop stale Attempt #N label from leaking into regular combat ([a85b867](https://github.com/Celasha/Toolasha/commit/a85b867cf0201e44cf065d3be5247443520581c8))
- surface refined weapon as upgrade for offensive items ([4595d1c](https://github.com/Celasha/Toolasha/commit/4595d1cf79d154f935ae151884ad922be670c5e6))
- surface T95 tier jumps and style-matched off-hands in upgrade advisor ([f31dbc1](https://github.com/Celasha/Toolasha/commit/f31dbc1f10f73d84b29e66f47343cde8d0d0d294))
- wire combatStats setting to feature gate ([5f63226](https://github.com/Celasha/Toolasha/commit/5f63226220a71d02b8ce5bb1ac959eefa3c01939))

## [2.67.0](https://github.com/Celasha/Toolasha/compare/v2.66.0...v2.67.0) (2026-06-20)

### Features

- add cost summary block to production action panels ([655dfd2](https://github.com/Celasha/Toolasha/commit/655dfd2b2c3140db9efbebc1de8620505d00af59))
- add sortable Progress column header to My Listings table ([3b1191e](https://github.com/Celasha/Toolasha/commit/3b1191ee06a15e3ef0987deeec51ff1b64b85a69))

### Bug Fixes

- apply correct dungeon chest quantity formula in combat sim ([3662b7c](https://github.com/Celasha/Toolasha/commit/3662b7c9052a0b7fb2c074a95c0f41333bcd724e))
- apply Custom Tab drag-drop layout before debounced save ([cf80e06](https://github.com/Celasha/Toolasha/commit/cf80e064d42c611a8ff1c6f287e8718defb2fa95))
- exclude own listings from Top Order Price/Age on My Listings ([445f2ba](https://github.com/Celasha/Toolasha/commit/445f2baee87866061e7ebe93cd95cc8e1c9f646e))
- make Marketplace "Count equipped items" setting actually toggle ([1dab506](https://github.com/Celasha/Toolasha/commit/1dab50651af54a632d93a532b0ee53040b480c51))
- prevent orphan outside-click listeners from deferred attachment race ([9500b1b](https://github.com/Celasha/Toolasha/commit/9500b1b5461af1fe429f8fc6d236ad09ebe1b303))
- refresh action-bar profit when pricing mode changes ([4976742](https://github.com/Celasha/Toolasha/commit/4976742fa86d7baade06425c4e58050a1adaf1a5))
- sync per-loadout Custom Tab binding independently of mixed exact mode ([36f07d1](https://github.com/Celasha/Toolasha/commit/36f07d1ced4b92d4a06489dffa84f20b02620b09))

### Miscellaneous Chores

- add Paradoxian to userscript header acknowledgements ([16378aa](https://github.com/Celasha/Toolasha/commit/16378aa3e35fbeca556636e1a7537c2e19ed2000))

## [2.66.0](https://github.com/Celasha/Toolasha/compare/v2.65.0...v2.66.0) (2026-06-18)

### Features

- add current action profit display to action bar ([9f4a5a4](https://github.com/Celasha/Toolasha/commit/9f4a5a408619c8cda3e78391d0811df7e5910610))

### Bug Fixes

- add alchemy action profit to queue tooltip and action bar ([371c236](https://github.com/Celasha/Toolasha/commit/371c236f15584ae21316158ac16568b60429b83e))
- capitalize monster names and show recommended skip in lab sim results ([3a0a689](https://github.com/Celasha/Toolasha/commit/3a0a689b70b8d2f9a86b0d2229731e5f17379a75))
- clean up history buffers and observers when chat extender is disabled ([53f8ce5](https://github.com/Celasha/Toolasha/commit/53f8ce502491f6ebf0f21cc28af571d6ce21eb38))
- include coin costs in enhancement XPH calculator metrics ([bdf146e](https://github.com/Celasha/Toolasha/commit/bdf146e5334d5f284c4ac46ab962fee2f1d35d4e))
- recognize short numeric character IDs during settings import ([4659c45](https://github.com/Celasha/Toolasha/commit/4659c455c2fce56364d4911c126dda5341a80155))
- resolve hanging Promises from debounced storage writes ([8ed8cc9](https://github.com/Celasha/Toolasha/commit/8ed8cc91996fc705eec24f665dd1a1ccb9e6b2cd))
- sync pop-out chat channel list with visible game tabs ([f03fd2b](https://github.com/Celasha/Toolasha/commit/f03fd2bd0111025d9dc9524d1310c2d08fcc9044))
- sync Settings UI disabled state and checkboxWithButton after All Off ([424bca0](https://github.com/Celasha/Toolasha/commit/424bca018f554ca1cd0cf75d9f5b365a2adf0e84))
- use DOM observer for chat commands input attachment ([a7a120b](https://github.com/Celasha/Toolasha/commit/a7a120b84af9e25c3e027e91d9ca2cd5aeea90f0))

### Miscellaneous Chores

- remove guild activity calculator (pending game redesign) ([2250ef1](https://github.com/Celasha/Toolasha/commit/2250ef1b4bea777d4423f49342608830a060220c))

## [2.65.0](https://github.com/Celasha/Toolasha/compare/v2.64.5...v2.65.0) (2026-06-16)

### Features

- add max threads setting for combat simulator ([4f8105c](https://github.com/Celasha/Toolasha/commit/4f8105c5931103258a29a3badb597ad27d18630e))

### Bug Fixes

- clear labyrinth attempt flag when entering regular combat ([6722bd8](https://github.com/Celasha/Toolasha/commit/6722bd8ebdf912c891454e3026ae36c670185cad))
- use handleChangeNavTarget for enhancement return navigation ([0e8e6b8](https://github.com/Celasha/Toolasha/commit/0e8e6b8d9918e3f24b4ab6458a618af0062ab635))

## [2.64.5](https://github.com/Celasha/Toolasha/compare/v2.64.4...v2.64.5) (2026-06-15)

### Bug Fixes

- restore click-to-view-details on comparison scenario rows ([f74420c](https://github.com/Celasha/Toolasha/commit/f74420ccf64eafdb9279903804d73040b4f75127))

## [2.64.4](https://github.com/Celasha/Toolasha/compare/v2.64.3...v2.64.4) (2026-06-15)

### Bug Fixes

- resolve enhancement levels from all owned items in combat loadout ([e9d52ad](https://github.com/Celasha/Toolasha/commit/e9d52ad0308ef026338857974215a34379684ecd))

## [2.64.3](https://github.com/Celasha/Toolasha/compare/v2.64.2...v2.64.3) (2026-06-15)

### Bug Fixes

- include gathering/gourmet buffs in labyrinth double progress chance ([99ef59e](https://github.com/Celasha/Toolasha/commit/99ef59e3b1bf85aec1bc4e3e5c378d443bba1b49))

## [2.64.2](https://github.com/Celasha/Toolasha/compare/v2.64.1...v2.64.2) (2026-06-15)

### Bug Fixes

- use labyrinth loadout equipment for skilling clear rate ([a220eb9](https://github.com/Celasha/Toolasha/commit/a220eb998fbaa00f75dca567bff0461752685dcc))

### Performance Improvements

- make combatStats and chatCommands initialize non-blocking ([304b742](https://github.com/Celasha/Toolasha/commit/304b742e9935fafe1beef07055d825cca02eda22))

## [2.64.1](https://github.com/Celasha/Toolasha/compare/v2.64.0...v2.64.1) (2026-06-14)

### Bug Fixes

- use base + tea crate only for labyrinth room-assignment effective level ([832da33](https://github.com/Celasha/Toolasha/commit/832da336fab14fddbe91f6b8b5dda1ebb79354f8))

## [2.64.0](https://github.com/Celasha/Toolasha/compare/v2.63.0...v2.64.0) (2026-06-14)

### Features

- add net worth pricing mode setting (ask/bid) ([4b0026e](https://github.com/Celasha/Toolasha/commit/4b0026e9c15f7195ccd7e09a41326db40c974057))

### Bug Fixes

- correct max produceable calculation for self-upgrade recipes ([9144a02](https://github.com/Celasha/Toolasha/commit/9144a020e7c686c2eb2d1edef96ca9d73837c8f7))
- decouple queue length estimation from listing age display setting ([41d29f4](https://github.com/Celasha/Toolasha/commit/41d29f403cdabd0971ed06707215b3d0f3d89fd1))
- labyrinth recommendations allow negative thresholds and exclude tea from combat level ([0ffa5d1](https://github.com/Celasha/Toolasha/commit/0ffa5d11f6ec37c1a4c408fa616f7e73652732e7))
- persist custom tab drag/drop changes across page reload ([1d1ec72](https://github.com/Celasha/Toolasha/commit/1d1ec726748e63fcf7eb8f6ff37e0ce751a10e74))
- prevent Add to Tab dropdown from leaking document click listeners ([2682ca1](https://github.com/Celasha/Toolasha/commit/2682ca15a38da2fb4f19c636f4c6f947bae891e7))
- refresh production profit UI when drinks or equipment change ([e254edf](https://github.com/Celasha/Toolasha/commit/e254edf9983ecd94132b6a320a9d109cee741658))
- respect "Use highest enhancement level" setting in custom tab auto-sync ([da843dd](https://github.com/Celasha/Toolasha/commit/da843dd6acbd5e60741f2aa654c2e4706eb6917c))

## [2.63.0](https://github.com/Celasha/Toolasha/compare/v2.62.14...v2.63.0) (2026-06-13)

### Features

- add configurable number format mode and precision settings ([53349ba](https://github.com/Celasha/Toolasha/commit/53349bacc7d4b84a56285ebf661382fbd45ce313))
- add guild activity calculator and simulator ([955c78e](https://github.com/Celasha/Toolasha/commit/955c78e3242b550158934d98f1db2ab63d1354c6))

### Bug Fixes

- add missing Help channel to pop-out chat ([b497147](https://github.com/Celasha/Toolasha/commit/b49714755c57e2a603ee615e12b34c60e3dbc4af))
- calculate task gold/hr using total task time instead of time remaining ([09a6168](https://github.com/Celasha/Toolasha/commit/09a61687d0751dc4333a583c391977c9b4cf91ba))
- correct labyrinth combat skip recommendations and add MooPass buffs ([b44dd1b](https://github.com/Celasha/Toolasha/commit/b44dd1b3c7395d8f22accbe6c02b94ef41c40843))
- use matchCurrentActionFromText for queue ETA current action detection ([993bbd1](https://github.com/Celasha/Toolasha/commit/993bbd1247c1b87469e8d67d73b0670c92535b3e))

## [2.62.14](https://github.com/Celasha/Toolasha/compare/v2.62.13...v2.62.14) (2026-06-11)

### Code Refactoring

- unify date/time and number formatting across all features ([a4a609e](https://github.com/Celasha/Toolasha/commit/a4a609ea25674412a3c1bf7bdceffe6dbbb2ffa3))

## [2.62.13](https://github.com/Celasha/Toolasha/compare/v2.62.12...v2.62.13) (2026-06-11)

### Bug Fixes

- exclude enhanced items from inventory count and add dynamic toggle ([6103c4f](https://github.com/Celasha/Toolasha/commit/6103c4f01f08b3b24285eea6a4d31e742d0f74aa))

## [2.62.12](https://github.com/Celasha/Toolasha/compare/v2.62.11...v2.62.12) (2026-06-10)

### Bug Fixes

- prevent action filter from clearing panels registered in same mutation batch ([67a706a](https://github.com/Celasha/Toolasha/commit/67a706a5f5d29ded6463dec667b17e9fd0f56605))

## [2.62.11](https://github.com/Celasha/Toolasha/compare/v2.62.10...v2.62.11) (2026-06-09)

### Bug Fixes

- hide newly registered panels that don't match active filter ([8ff33ff](https://github.com/Celasha/Toolasha/commit/8ff33ffccb6c8f4f8337cb23d120726946296184))

## [2.62.10](https://github.com/Celasha/Toolasha/compare/v2.62.9...v2.62.10) (2026-06-08)

### Bug Fixes

- align move buttons in tab editor by rendering hidden placeholders ([e57d6aa](https://github.com/Celasha/Toolasha/commit/e57d6aa6c660f5b75d33232bd74c44e951c8962b))
- crash in \_checkBindingEnhancements when cache is nulled mid-loop ([8b2155e](https://github.com/Celasha/Toolasha/commit/8b2155eb13e839853fdef7dc82c1d83848dcf31f))

## [2.62.9](https://github.com/Celasha/Toolasha/compare/v2.62.8...v2.62.9) (2026-06-08)

### Bug Fixes

- add "Move to bottom" button in custom tab editor ([e47b4cb](https://github.com/Celasha/Toolasha/commit/e47b4cb396e80fc4ba5c119c931817765f94f904))
- preserve scroll position when removing items in tab editor ([d7e0f39](https://github.com/Celasha/Toolasha/commit/d7e0f3957801d1ba99167350cd2241bd062ecef6))
- prevent drag listener accumulation on custom inventory tab tiles ([cae18f3](https://github.com/Celasha/Toolasha/commit/cae18f370b9c3045748d63fee5bdc5bd55a3facf))

## [2.62.8](https://github.com/Celasha/Toolasha/compare/v2.62.7...v2.62.8) (2026-06-07)

### Bug Fixes

- action panel button labels resetting to defaults on page reload ([67ad2a3](https://github.com/Celasha/Toolasha/commit/67ad2a3548871764bdca10591c090ce7a1c18a88))
- hide Scroll Simulation button when setting is disabled ([58c1ef7](https://github.com/Celasha/Toolasha/commit/58c1ef7777b821066cf9c6e5d9db98fd3edfea6e))
- use live networth for rate/hr calculation instead of last snapshot ([ef61b79](https://github.com/Celasha/Toolasha/commit/ef61b79ee40c3e8f3764b392a40f1896a4fb63d4))

## [2.62.7](https://github.com/Celasha/Toolasha/compare/v2.62.6...v2.62.7) (2026-06-07)

### Bug Fixes

- add setting to disable task speed & time breakdown ([363582e](https://github.com/Celasha/Toolasha/commit/363582ed1efc77350fe0645d8c52623922e4dfe3))

## [2.62.6](https://github.com/Celasha/Toolasha/compare/v2.62.5...v2.62.6) (2026-06-07)

### Bug Fixes

- calculate enhancement time correctly when using Philosopher's Mirror ([60b1f2a](https://github.com/Celasha/Toolasha/commit/60b1f2afb672a45e556b4421342b74195139dc6c))
- show expandable speed breakdown on tasks without profit enabled ([7b71d99](https://github.com/Celasha/Toolasha/commit/7b71d9953a1d8bdf819315cc1b0df04918d215f0))

## [2.62.5](https://github.com/Celasha/Toolasha/compare/v2.62.4...v2.62.5) (2026-06-06)

### Bug Fixes

- use ResizeObserver to sync stats layout on hidden→visible tab switches ([84d29fd](https://github.com/Celasha/Toolasha/commit/84d29fd7b4cf9df0d95bb6b00d6bec5f9ef2b403))

## [2.62.4](https://github.com/Celasha/Toolasha/compare/v2.62.3...v2.62.4) (2026-06-06)

### Bug Fixes

- match enhanced items in queue by stripping +N level suffix ([11514be](https://github.com/Celasha/Toolasha/commit/11514beab84ae8156f7fb03dd2fe225c9f78ef8b))
- re-sync action panel marginBottom after layout and tab changes ([c9b9644](https://github.com/Celasha/Toolasha/commit/c9b964408d8d5d549e4bdeea35b67c81f34b52b4))

## [2.62.3](https://github.com/Celasha/Toolasha/compare/v2.62.2...v2.62.3) (2026-06-06)

### Bug Fixes

- add action speed & time breakdown to task profit display ([5ede675](https://github.com/Celasha/Toolasha/commit/5ede675adba889f15c5c624e1d1e2e2b54453252))
- prevent stat line text from briefly shrinking during tab switch ([60b2e03](https://github.com/Celasha/Toolasha/commit/60b2e039ff073bb145cfa934b24c858cb7eafd1b))
- show expected time for repeat-∞ enhancement queue actions ([ab3f26f](https://github.com/Celasha/Toolasha/commit/ab3f26f04869ac67d91c5afdcc4efd5815208d74))

## [2.62.2](https://github.com/Celasha/Toolasha/compare/v2.62.1...v2.62.2) (2026-06-06)

### Bug Fixes

- include task speed bonus in task completion time estimate ([2121c5d](https://github.com/Celasha/Toolasha/commit/2121c5d40219fc3abc2dad93bbfe49d2612ee39b))

## [2.62.1](https://github.com/Celasha/Toolasha/compare/v2.62.0...v2.62.1) (2026-06-06)

### Bug Fixes

- enhancement calculator speed uses manual override params ([2d41428](https://github.com/Celasha/Toolasha/commit/2d4142836b60a977870c3db5cf50e82c76f3d74a))
- respect 24-hour time format setting in action completion times ([1323558](https://github.com/Celasha/Toolasha/commit/1323558f413f5b279c53d01c8b348357f4178994))

## [2.62.0](https://github.com/Celasha/Toolasha/compare/v2.61.5...v2.62.0) (2026-06-06)

### Features

- add "Skip Back" toggle to combat sim upgrade analysis ([5375caf](https://github.com/Celasha/Toolasha/commit/5375caf711e2bd61186ec64f6e13177c15f693ca))

### Bug Fixes

- add effective (after-tax) price display to item tooltips ([10c1cf7](https://github.com/Celasha/Toolasha/commit/10c1cf77eaf39234f8f4738fd1f74f4ef7d9022c))
- exclude magic off-hands from melee upgrade recommendations ([9a11465](https://github.com/Celasha/Toolasha/commit/9a114655f1c04b126d8fd1edaa22186fb974b1ca))
- show labyrinth attempt number in battle counter ([5cbbcf3](https://github.com/Celasha/Toolasha/commit/5cbbcf30160e9d23d8fdb5ca6f2a0d26c4ef47ca))
- use correct config method for labyrinth number settings ([94b0802](https://github.com/Celasha/Toolasha/commit/94b08028b1351a5ae3b8dd8184e14dcb587b564e))
- use full zone data for boss task sim estimates ([8794215](https://github.com/Celasha/Toolasha/commit/8794215ab14b5b9cb66322d36ac389f051b865d3))

## [2.61.5](https://github.com/Celasha/Toolasha/compare/v2.61.4...v2.61.5) (2026-06-04)

### Bug Fixes

- add pricing mode toggle and XP/hr to best crafting plan ([55b1912](https://github.com/Celasha/Toolasha/commit/55b19126df2637cc13191640e5fc599c729862c6))

## [2.61.4](https://github.com/Celasha/Toolasha/compare/v2.61.3...v2.61.4) (2026-06-04)

### Bug Fixes

- initialize order book cache before listing price display ([ffb2779](https://github.com/Celasha/Toolasha/commit/ffb2779e955e58a06b515cbb82c3a1a5f82ee1ae))

## [2.61.3](https://github.com/Celasha/Toolasha/compare/v2.61.2...v2.61.3) (2026-06-04)

### Bug Fixes

- use approximate quantity matching for K/M/B abbreviated listings ([2bb092e](https://github.com/Celasha/Toolasha/commit/2bb092e86d0db816eca4680f586cabe50c6af9a8))

## [2.61.2](https://github.com/Celasha/Toolasha/compare/v2.61.1...v2.61.2) (2026-06-04)

### Bug Fixes

- add diagnostic logging for listing N/A display bug ([f01aed3](https://github.com/Celasha/Toolasha/commit/f01aed3cd99054d0ea9c260f013a7b734eef68a5))

## [2.61.1](https://github.com/Celasha/Toolasha/compare/v2.61.0...v2.61.1) (2026-06-04)

### Bug Fixes

- parse K/M/B suffixes in listing quantity matching ([98400c9](https://github.com/Celasha/Toolasha/commit/98400c92dfabc37e06f5de9cf3b2f0640c327bb6))

## [2.61.0](https://github.com/Celasha/Toolasha/compare/v2.60.0...v2.61.0) (2026-06-03)

### Features

- add item icons to pinned actions overview tab ([e980a16](https://github.com/Celasha/Toolasha/commit/e980a1618c6a392fb2273e69e8b4757eb1adc08d))
- add zone mode for combat task estimates with multi-task aggregate ([91dc511](https://github.com/Celasha/Toolasha/commit/91dc51114282402f130a9812b752813589ebc55f))
- auto-run combat estimates when task cards appear ([6727c0f](https://github.com/Celasha/Toolasha/commit/6727c0fd6298f9571a7f013586c3164c3d10f049))

### Bug Fixes

- add marketplace links to alchemy best items breakdown ([1a83a5d](https://github.com/Celasha/Toolasha/commit/1a83a5d74c22ebc7944a8b48d85fd1ecc858b44d))
- correct Chance Cape (R) HRID in enhancement auto-detect ([463352d](https://github.com/Celasha/Toolasha/commit/463352dd74f58c24424074c470833da1e66f3e30))
- prevent claim reward button from resizing with count ([01656bc](https://github.com/Celasha/Toolasha/commit/01656bcaebdf18e24280eaa33dba99867d4e1be0))

### Miscellaneous Chores

- add diagnostics for custom tab items disappearing on auto-switch ([885d42b](https://github.com/Celasha/Toolasha/commit/885d42b6ded0d978d2629136dc1d10be5a6d33b7))

## [2.60.0](https://github.com/Celasha/Toolasha/compare/v2.59.5...v2.60.0) (2026-06-03)

### Features

- add default loadout setting for combat sim estimates ([7f7d2fa](https://github.com/Celasha/Toolasha/commit/7f7d2fab6051d11d91ebe4cb180e3fec162d846c))
- show efficiency rating on combat task estimates ([d86a727](https://github.com/Celasha/Toolasha/commit/d86a7273c2ac186e1fa8ce335a1534f5d98a9b75))

### Bug Fixes

- detect earrings and back slot in gear scanner, add per-item breakdowns ([3af542d](https://github.com/Celasha/Toolasha/commit/3af542d9859f95ba9e16db5c7671b58062e0bf51))
- prevent combat quick input buttons from duplicating ([5cc9cf1](https://github.com/Celasha/Toolasha/commit/5cc9cf1a540a96e928bb0151722bb7e0612dd043))
- update market item counts when inventory changes ([c460c9c](https://github.com/Celasha/Toolasha/commit/c460c9c44cb0a469dce5846563d72e2f9fe46e81))

## [2.59.5](https://github.com/Celasha/Toolasha/compare/v2.59.4...v2.59.5) (2026-06-02)

### Bug Fixes

- add setting to hide combat estimate on task cards ([569fcdb](https://github.com/Celasha/Toolasha/commit/569fcdb95b00bae29f8b4f01a79ada307900a1b0))
- make enhancement stat breakdowns click-to-expand ([1683f25](https://github.com/Celasha/Toolasha/commit/1683f25a81a6b52103576effaabcd242077c5992))

## [2.59.4](https://github.com/Celasha/Toolasha/compare/v2.59.3...v2.59.4) (2026-06-02)

### Bug Fixes

- add marketplace navigation links to alchemy best items ([48f85ae](https://github.com/Celasha/Toolasha/commit/48f85aee814d2b5780d7f7a06c3746fe93087b3e))
- clear battle counter when switching from combat to skilling ([1047c0b](https://github.com/Celasha/Toolasha/commit/1047c0bbb42c55d679e0368e9d21eeb024dd0e33))
- include skillingRareFind in auto-detect gear calculations ([832ee94](https://github.com/Celasha/Toolasha/commit/832ee94c02b25304c71517ee8010b3d038ba32d4))

### Miscellaneous Chores

- display version number in settings tab title ([c3128f6](https://github.com/Celasha/Toolasha/commit/c3128f649d05dc55f65a0d490e4a77ed6afececc))

## [2.59.3](https://github.com/Celasha/Toolasha/compare/v2.59.2...v2.59.3) (2026-06-02)

### Bug Fixes

- recover WebSocket hook when primary interception fails ([bd538c2](https://github.com/Celasha/Toolasha/commit/bd538c29b2c408025b313c3695b3353a44c968ce))

## [2.59.2](https://github.com/Celasha/Toolasha/compare/v2.59.1...v2.59.2) (2026-06-01)

### Bug Fixes

- correct alchemy action type detection and missing level progress ([5f51513](https://github.com/Celasha/Toolasha/commit/5f51513185e1d4ee9a12d4808a1286bd3b27eb1c))

## [2.59.1](https://github.com/Celasha/Toolasha/compare/v2.59.0...v2.59.1) (2026-05-31)

### Bug Fixes

- action time display flickering due to missing space in parsed action name ([9c158eb](https://github.com/Celasha/Toolasha/commit/9c158eb9156d76e9cb28f30e75518efcf6d2db48))
- preserve alchemy target level calculator input across updates ([35d9409](https://github.com/Celasha/Toolasha/commit/35d9409059bff79226e0a71b0292e9a8b7e85455))

## [2.59.0](https://github.com/Celasha/Toolasha/compare/v2.58.5...v2.59.0) (2026-05-31)

### Features

- add gold-neutral effective XP/hr ranking for best overall action ([7bfa90b](https://github.com/Celasha/Toolasha/commit/7bfa90ba2cb9f7d41ff856a7f467b6f2699b1802))

## [2.58.5](https://github.com/Celasha/Toolasha/compare/v2.58.4...v2.58.5) (2026-05-31)

### Bug Fixes

- decouple action speed/time section from profit detail setting ([8e3793a](https://github.com/Celasha/Toolasha/commit/8e3793a1ed6b8ad98182a64100086cae1221473a))
- preserve target level calculator input across action completions ([a9661fa](https://github.com/Celasha/Toolasha/commit/a9661faa003b8d4804dbd0e96ec269a2ccdd7fea))

## [2.58.4](https://github.com/Celasha/Toolasha/compare/v2.58.3...v2.58.4) (2026-05-30)

### Bug Fixes

- always show all categories in net worth chart tooltip ([9c19648](https://github.com/Celasha/Toolasha/commit/9c1964845ad1043b25fc3fae3fda243a5247449a))

## [2.58.3](https://github.com/Celasha/Toolasha/compare/v2.58.2...v2.58.3) (2026-05-29)

### Bug Fixes

- add cross-slot weapon upgrade suggestions to combat advisor ([1b92f8e](https://github.com/Celasha/Toolasha/commit/1b92f8e12aa15ee14bc6c3f852f3f1eafbcc00cf))
- add quick input count presets to combat action modals ([df5fe78](https://github.com/Celasha/Toolasha/commit/df5fe78ad596a495880851334c1363ff048df00d))
- classify defensiveDamage-only items as defensive in upgrade advisor ([3ba942c](https://github.com/Celasha/Toolasha/commit/3ba942c8d72ec058d5f0be723f1799b26f8bd6ad))
- recommend tooltip now reflects actual target rate used ([e063be5](https://github.com/Celasha/Toolasha/commit/e063be51cf4f8ec8ac6576889754823e1bf6f358))
- sync recommend inputs with saved settings on re-inject ([6e1ec07](https://github.com/Celasha/Toolasha/commit/6e1ec0777e61328e21d550dc9cf394d72609c2da))

### Code Refactoring

- remove skilling buff candidates from combat upgrade analysis ([5446f6a](https://github.com/Celasha/Toolasha/commit/5446f6a451eddc6209352011928f7adf0901b67a))

## [2.58.2](https://github.com/Celasha/Toolasha/compare/v2.58.1...v2.58.2) (2026-05-29)

### Bug Fixes

- clear history now persists across page refresh ([af9a9f1](https://github.com/Celasha/Toolasha/commit/af9a9f154e7b4d198aa40d530fce19e63f4d46c1))

## [2.58.1](https://github.com/Celasha/Toolasha/compare/v2.58.0...v2.58.1) (2026-05-28)

### Bug Fixes

- add resizable lab sim panel and collapsible loadout section ([e1178f5](https://github.com/Celasha/Toolasha/commit/e1178f5d5f13942cde1d61b18ea346e0feb8de89))

## [2.58.0](https://github.com/Celasha/Toolasha/compare/v2.57.1...v2.58.0) (2026-05-28)

### Features

- add per-skill filter for skilling upgrade analysis ([c9091f0](https://github.com/Celasha/Toolasha/commit/c9091f015a3ec8b50e8b13c0d2297769a19387c9))
- add resizable combat simulator panel ([d30d0b8](https://github.com/Celasha/Toolasha/commit/d30d0b86731ee415d841a6990e0331efc55d08d2))
- add transmute recycle time estimate to action timer ([f1bfb84](https://github.com/Celasha/Toolasha/commit/f1bfb849d3c088bb9d8393be1a7e529348d5ebc9))

### Bug Fixes

- prevent skilling editor overlap when upgrade results display ([88b8a54](https://github.com/Celasha/Toolasha/commit/88b8a54b49cbd460ffd025565d6d5f0b712b4827))
- pull skilling loadouts from game lab automation settings ([b212e47](https://github.com/Celasha/Toolasha/commit/b212e473cae738556286a228296ad66e684e4eb7))
- sort upgrade tables by cost efficiency and skip irrelevant slots ([1b4a4b8](https://github.com/Celasha/Toolasha/commit/1b4a4b88441aa60d18238f21d4fa04a3b6749365))

## [2.57.1](https://github.com/Celasha/Toolasha/compare/v2.57.0...v2.57.1) (2026-05-28)

### Bug Fixes

- collection tiles displaced when unfavoriting an item ([ca97fb1](https://github.com/Celasha/Toolasha/commit/ca97fb1aac35a11776881322ff7723aaa85fb928))

## [2.57.0](https://github.com/Celasha/Toolasha/compare/v2.56.0...v2.57.0) (2026-05-28)

### Features

- add skilling room simulation tab to Lab Simulator ([3e85838](https://github.com/Celasha/Toolasha/commit/3e858385c3f68c37ec3650c165885f500687c85c))

### Bug Fixes

- show remaining/total time in live countdown timer ([1606675](https://github.com/Celasha/Toolasha/commit/160667521e33da4b60912e6c53f8b3cf2355ecee))

## [2.56.0](https://github.com/Celasha/Toolasha/compare/v2.55.1...v2.56.0) (2026-05-28)

### Features

- add inline target win rate and sim hours to recommend controls ([63bc8b9](https://github.com/Celasha/Toolasha/commit/63bc8b9dba8232bbf3701a0522a2bb68643f5dff))
- add Tokens/1% column and sortable headers to upgrade tables ([2df1c7a](https://github.com/Celasha/Toolasha/commit/2df1c7a8e27ef0f8ec2339f3298cc19310d7db32))
- use custom loadout order in sim editor dropdowns ([28d0867](https://github.com/Celasha/Toolasha/commit/28d086790848e1160fa8395c3ffae06885c8672d))

### Bug Fixes

- include bulkMultiplier in alchemy coin cost formulas ([4e6d9e2](https://github.com/Celasha/Toolasha/commit/4e6d9e233926c33144677f27c39317ea26e38f69))
- use correct dev-confirmed coin cost formulas for alchemy ([f29d1f4](https://github.com/Celasha/Toolasha/commit/f29d1f46e8fe72c19bb48c37575247b8420436df))

## [2.55.1](https://github.com/Celasha/Toolasha/compare/v2.55.0...v2.55.1) (2026-05-27)

### Bug Fixes

- match action bar display against front action by ordinal ([7149e1a](https://github.com/Celasha/Toolasha/commit/7149e1a202a6a337c2e9896f4e4b9fb8fcf8ebce))

## [2.55.0](https://github.com/Celasha/Toolasha/compare/v2.54.0...v2.55.0) (2026-05-27)

### Features

- add favorites section to collection panel ([65f9b0c](https://github.com/Celasha/Toolasha/commit/65f9b0c29acdbf7f41c358dc3427fd3b2449f2a1))

### Bug Fixes

- correct lab sim win rate to use attempt count ([735d34d](https://github.com/Celasha/Toolasha/commit/735d34d60b8b9cfdeadc45d3379bae549d5a9fc6))
- decouple task timing and materials from profit display setting ([5b09b73](https://github.com/Celasha/Toolasha/commit/5b09b73d2ad996e8c2e0d0b91313d85d67ef953c))
- improve action bar info reliability and alchemy cost calculation ([dded17b](https://github.com/Celasha/Toolasha/commit/dded17ba0992f0575060b18f8e1ba5c056d6928c))
- prevent queue monitor race from showing stale snapshots ([e03375b](https://github.com/Celasha/Toolasha/commit/e03375bcf883699ceba12f3d5907a9dd6da2a878))
- scale labyrinth token upgrade costs by level ([9875ca8](https://github.com/Celasha/Toolasha/commit/9875ca8d03c24e281294bd1143c5e8f8e27ab9d9))
- strip equipped food and drinks from labyrinth simulations ([457f75e](https://github.com/Celasha/Toolasha/commit/457f75e1dd75de310152e7d62abf5b3754d23a41))

## [2.54.0](https://github.com/Celasha/Toolasha/compare/v2.53.1...v2.54.0) (2026-05-26)

### Features

- add task auto-reroll reminder ([4bd3267](https://github.com/Celasha/Toolasha/commit/4bd326792cada05301f416ac530dbcf2540690a4))
- persist and display historical loot log entries ([0739f97](https://github.com/Celasha/Toolasha/commit/0739f97a8d6f6442c485c275fc0df604d7e191e3))

### Bug Fixes

- correct parameter passing in lab simulator max level search ([aedc6c5](https://github.com/Celasha/Toolasha/commit/aedc6c5940362001c739a79c79c4cd1afd334df1))
- refresh action bar stats when actions_updated arrives ([a8f7da9](https://github.com/Celasha/Toolasha/commit/a8f7da95d8416e8fd058934020715764817e220f))
- write queue snapshots immediately to prevent stale data on re-init ([640ba90](https://github.com/Celasha/Toolasha/commit/640ba900207626eff56371ef82d0ee78fec3160d))

## [2.53.1](https://github.com/Celasha/Toolasha/compare/v2.53.0...v2.53.1) (2026-05-25)

### Bug Fixes

- use additive formula for alchemy success rate with catalyst and tea ([4fd39f9](https://github.com/Celasha/Toolasha/commit/4fd39f91362861f329ffac745851d177493fc3d2))

## [2.53.0](https://github.com/Celasha/Toolasha/compare/v2.52.1...v2.53.0) (2026-05-25)

### Features

- add ÷2 and ×2 multiplier buttons to marketplace order dialogs ([d2c288f](https://github.com/Celasha/Toolasha/commit/d2c288f8071f5cd41174b8120009dcc04a264090))
- add labyrinth clear rate calculator with tooltips, recommendations, and live progress ([15eefb8](https://github.com/Celasha/Toolasha/commit/15eefb8fc774411abe8dfda40b6969b4bfe5be54))
- adjust tooltip prices for Artisan Tea material reduction ([ed3ade8](https://github.com/Celasha/Toolasha/commit/ed3ade872856def0b0a6a10e54f482489ff6f8c3))
- show owned item count in buy marketplace dialogs ([c4295cf](https://github.com/Celasha/Toolasha/commit/c4295cfbb747e4ada0864988783451054bdfbd8d))
- split combat sim into separate Combat Sim and Lab Sim dialogs ([0fc8ecd](https://github.com/Celasha/Toolasha/commit/0fc8ecdc000c8d9146e6639d16a38d12c56a1b9c))

### Bug Fixes

- alchemy tooltip per-action profit now includes tea costs and bonus drops ([c0157e9](https://github.com/Celasha/Toolasha/commit/c0157e9ad23123545e33b8a0bfc42fb719ce6777))
- restore action bar display when starting new actions after character switch ([3b2a9b0](https://github.com/Celasha/Toolasha/commit/3b2a9b0665dfb3ea671631462cb4346426de8b1c))
- update item level overlay when enhancement selector changes items ([987728e](https://github.com/Celasha/Toolasha/commit/987728e20c9119a9524d320f248e6fbf6a5dd7a6))
- use itemLevel instead of equip requirement for enhancement calculations ([27a6a36](https://github.com/Celasha/Toolasha/commit/27a6a36441bc162238a91f1b84f7cc734884a8fe))

## [2.52.1](https://github.com/Celasha/Toolasha/compare/v2.52.0...v2.52.1) (2026-05-23)

### Bug Fixes

- add individual toggles for skill page filter bar elements ([64fa177](https://github.com/Celasha/Toolasha/commit/64fa177d237e83f8770e25ff44ed191735234e54))

## [2.52.0](https://github.com/Celasha/Toolasha/compare/v2.51.3...v2.52.0) (2026-05-23)

### Features

- add option to hide item tooltips in enhance selector ([41ec17f](https://github.com/Celasha/Toolasha/commit/41ec17f62efa8239752a2d66b268a1a68c006744))

## [2.51.3](https://github.com/Celasha/Toolasha/compare/v2.51.2...v2.51.3) (2026-05-23)

### Bug Fixes

- remove double-counted catalyst cost from alchemy profit/hr ([00f7fdf](https://github.com/Celasha/Toolasha/commit/00f7fdfab8a0870ea43e1e81a2af6d741479ffce))

## [2.51.2](https://github.com/Celasha/Toolasha/compare/v2.51.1...v2.51.2) (2026-05-22)

### Bug Fixes

- include boss drops in combat sim Seek item list ([67ae395](https://github.com/Celasha/Toolasha/commit/67ae395c333a7023093778be781e922ede17d387))

## [2.51.1](https://github.com/Celasha/Toolasha/compare/v2.51.0...v2.51.1) (2026-05-22)

### Bug Fixes

- restore total action time when countdown is disabled ([a87f195](https://github.com/Celasha/Toolasha/commit/a87f195445947cd190601c8c210055e4019000dc))

### Code Refactoring

- replace action bar preset modes with granular toggles ([c95f106](https://github.com/Celasha/Toolasha/commit/c95f10623611436209145567bb5d777c095294e1))

## [2.51.0](https://github.com/Celasha/Toolasha/compare/v2.50.2...v2.51.0) (2026-05-21)

### Features

- add "Return to Action" tab in missing materials marketplace ([4d3fc7d](https://github.com/Celasha/Toolasha/commit/4d3fc7dd5ad57b73634ee9a5f476b27f392e9b9d))
- add expandable profit breakdown to alchemy Best Items rows ([bc2c0a6](https://github.com/Celasha/Toolasha/commit/bc2c0a63a6ed3f812455822373642761a75490ed))

### Bug Fixes

- use precise formatting for listing price columns ([80c497b](https://github.com/Celasha/Toolasha/commit/80c497b89259268909235351adfd9da797e0b106))

## [2.50.2](https://github.com/Celasha/Toolasha/compare/v2.50.1...v2.50.2) (2026-05-21)

### Bug Fixes

- refresh pinned actions page immediately when pins change ([5d8b11c](https://github.com/Celasha/Toolasha/commit/5d8b11c88dae336648ba64db8f9215e232742aa6))

### Performance Improvements

- memoize craft chain calculations and replace recursive fibonacci ([d047c54](https://github.com/Celasha/Toolasha/commit/d047c54c969d61fbc858b163dcf658048cd61f29))

## [2.50.1](https://github.com/Celasha/Toolasha/compare/v2.50.0...v2.50.1) (2026-05-20)

### Bug Fixes

- avoid double-wrapping WebSocket when other userscripts are present ([f966430](https://github.com/Celasha/Toolasha/commit/f966430b98d183273e1638895ca5ff0f99779bbc))
- show limiting material icon on active action timer ([3ed1db6](https://github.com/Celasha/Toolasha/commit/3ed1db6eb6279a37ddaf2636f3e95cd0a7a32e28))

## [2.50.0](https://github.com/Celasha/Toolasha/compare/v2.49.3...v2.50.0) (2026-05-20)

### Features

- add pin icon to alchemy actions for item-specific pinning ([eb77a5e](https://github.com/Celasha/Toolasha/commit/eb77a5e7b1057c205d00780517bccbd07a5a35ee))

### Bug Fixes

- check gold and catalyst limits in alchemy depletion timer ([420bec3](https://github.com/Celasha/Toolasha/commit/420bec3f1c6ed226a8718460d53685cfd88eabc0))

## [2.49.3](https://github.com/Celasha/Toolasha/compare/v2.49.2...v2.49.3) (2026-05-20)

### Bug Fixes

- include enhancement level in badge manager inventory lookup key ([f6a3832](https://github.com/Celasha/Toolasha/commit/f6a38323cff5d7fce8750105d1fbb7634d25b7a2))
- replace own-property anti-loop with WeakSet guard in WS hook ([cce3f2b](https://github.com/Celasha/Toolasha/commit/cce3f2be30e6e44074deac4153b6a2edde9ddd5c))
- use setSetting for craft toggle button ([107f943](https://github.com/Celasha/Toolasha/commit/107f943b93a087d5c7c8e26d1f30f5dc99e5771a))

## [2.49.2](https://github.com/Celasha/Toolasha/compare/v2.49.1...v2.49.2) (2026-05-19)

### Bug Fixes

- deduct key cost from chest badge values ([33f6de2](https://github.com/Celasha/Toolasha/commit/33f6de27b67f5d9bba7c1ca7d2dd8e0810e401e0))

### Code Refactoring

- add craft toggle button to action panel ([bd77461](https://github.com/Celasha/Toolasha/commit/bd774618be0c26540dad000b67657967b36a74f8))

## [2.49.1](https://github.com/Celasha/Toolasha/compare/v2.49.0...v2.49.1) (2026-05-19)

### Bug Fixes

- include crafting chain time in profit/hr for upgrade items ([0f656d6](https://github.com/Celasha/Toolasha/commit/0f656d69542d8002832dc6a7470a0705ca385181))

## [2.49.0](https://github.com/Celasha/Toolasha/compare/v2.48.3...v2.49.0) (2026-05-19)

### Features

- add colored delta indicators to net worth chart tooltip ([4638dd5](https://github.com/Celasha/Toolasha/commit/4638dd5e3d114ac841482286b0875d5dfbd590c0))
- auto-calculate optimal protection for enhancement missing mats ([a423a44](https://github.com/Celasha/Toolasha/commit/a423a44f53f7bcc47ed8fdab9d8e926695202333))

### Bug Fixes

- guard against null skills in auto-detected enhancement params ([6c7ad15](https://github.com/Celasha/Toolasha/commit/6c7ad15f39d1d1afdb9d2dc487edd43956fcd40f))
- improve enhancement tooltip protection labels ([eb8843d](https://github.com/Celasha/Toolasha/commit/eb8843dad53a9d3f6a5dbb2c28c65d65a62434a2))

## [2.48.3](https://github.com/Celasha/Toolasha/compare/v2.48.2...v2.48.3) (2026-05-18)

### Bug Fixes

- add ring, earring, and speed necklace to enhancement simulator ([a182d46](https://github.com/Celasha/Toolasha/commit/a182d46ea32e6e14d449ff628717c3ca219fb64e))
- protect Add to Queue button in alchemy action protection ([1794bb6](https://github.com/Celasha/Toolasha/commit/1794bb6295bb4083574cbdccb78ffded2245f1df))
- reposition alchemy protection shield above item icon box ([b6f95cb](https://github.com/Celasha/Toolasha/commit/b6f95cbb6f41689a8fba12efdf47978573ec6d95))
- update housing missing mats display when room level changes ([e375cff](https://github.com/Celasha/Toolasha/commit/e375cff2cec5e779dc0cd26ee8a265ae44ab6ac4))
- use correct property name for item tradeability checks ([bb6bcd3](https://github.com/Celasha/Toolasha/commit/bb6bcd3cae283c4daac6ff108de88bc3a889b886))

### Styles

- reduce alchemy protection popup spacing to avoid scrolling ([75d9342](https://github.com/Celasha/Toolasha/commit/75d934237811833044fadceb92d1bc6daaefe25d))

## [2.48.2](https://github.com/Celasha/Toolasha/compare/v2.48.1...v2.48.2) (2026-05-18)

### Bug Fixes

- show buy vs craft label on upgrade items in tooltip ([a3039c9](https://github.com/Celasha/Toolasha/commit/a3039c945d388b646d2f429cb15326e60debc793))

## [2.48.1](https://github.com/Celasha/Toolasha/compare/v2.48.0...v2.48.1) (2026-05-18)

### Bug Fixes

- use blob URL for popout chat to prevent Firefox game disconnect ([7c6230f](https://github.com/Celasha/Toolasha/commit/7c6230fcb4b984bcab44d3f5f812cb2bbb07f5bc))
- use min(market, craft) for upgrade items in tooltip material cost ([0fba5bb](https://github.com/Celasha/Toolasha/commit/0fba5bbf50a6024fbafdfb1ec02534ec92b23952))

## [2.48.0](https://github.com/Celasha/Toolasha/compare/v2.47.5...v2.48.0) (2026-05-17)

### Features

- add alchemy action protection for item categories ([b5abb5f](https://github.com/Celasha/Toolasha/commit/b5abb5fd97222ea14aceaa25e3474a36f1203279))

### Bug Fixes

- hide action queue profit display in iron cow mode ([5b9f86e](https://github.com/Celasha/Toolasha/commit/5b9f86ed26ba29051be278942c08a653f28a5712))

### Miscellaneous Chores

- add comprehensive debugging to chat popout for Firefox issue ([19bcb1d](https://github.com/Celasha/Toolasha/commit/19bcb1da22bfa4278ec41c2ebf258ef97621438d))

## [2.47.5](https://github.com/Celasha/Toolasha/compare/v2.47.4...v2.47.5) (2026-05-17)

### Bug Fixes

- include houses, abilities, and listings in 24h networth breakdown ([f8c33ce](https://github.com/Celasha/Toolasha/commit/f8c33ce5f876e322d389e376c2d0118740474a5e))

## [2.47.4](https://github.com/Celasha/Toolasha/compare/v2.47.3...v2.47.4) (2026-05-17)

### Bug Fixes

- clear combat sim cached state on destroy to prevent stale data after character switch ([1e74b18](https://github.com/Celasha/Toolasha/commit/1e74b182adcaa0f158f07bfc5f454c460bdf25de))
- separate gold from inventory in chart breakdown and prevent popout from closing chart ([7bba3c9](https://github.com/Celasha/Toolasha/commit/7bba3c92aa04b13317fb47e116a9c492beee23d9))
- use cheaper of market vs craft cost for upgrade items in production cost ([e5febe3](https://github.com/Celasha/Toolasha/commit/e5febe33fb74c70153bb20f52de949877375d1ec))

## [2.47.3](https://github.com/Celasha/Toolasha/compare/v2.47.2...v2.47.3) (2026-05-17)

### Bug Fixes

- remove orphaned timer element before creating new display panel ([40146c6](https://github.com/Celasha/Toolasha/commit/40146c6d62ad96a4fde390b45070e8fca043fbd7))

## [2.47.2](https://github.com/Celasha/Toolasha/compare/v2.47.1...v2.47.2) (2026-05-17)

### Bug Fixes

- exclude filter flags from buildFlags when filters setting is disabled ([a501f12](https://github.com/Celasha/Toolasha/commit/a501f12b4e402fe516f3b83918fcb0903bc4372d))
- use standard enhancement multiplier for XP bonus calculations ([06c2fd7](https://github.com/Celasha/Toolasha/commit/06c2fd70b0a7ecaa59693c2ec8c6b444943a6465))

## [2.47.1](https://github.com/Celasha/Toolasha/compare/v2.47.0...v2.47.1) (2026-05-16)

### Bug Fixes

- add charm slot and missing wisdom sources to enhancement sim ([c9bc783](https://github.com/Celasha/Toolasha/commit/c9bc783ee70f26d3f8dc0b7d4569d419cef81478))
- use auto-detected stats for untradeable item enhancement paths ([91a41eb](https://github.com/Celasha/Toolasha/commit/91a41ebfa9792f724350e1cac963b6dabb987f02))
- use live tab data for missing mats buy quantity autofill ([c8cb565](https://github.com/Celasha/Toolasha/commit/c8cb565f6648faebecd3982b3f87539c1d683ba7))

## [2.47.0](https://github.com/Celasha/Toolasha/compare/v2.46.1...v2.47.0) (2026-05-16)

### Features

- add custom quick input presets for marketplace dialogs ([6625952](https://github.com/Celasha/Toolasha/commit/66259523701fe0a8d2e4d7d13fb14651fa3bb681))

### Bug Fixes

- add toggle to exclude cowbell value from EV calculations ([b41bdde](https://github.com/Celasha/Toolasha/commit/b41bdde53d7b2b5a4c8fc89ab986e66a847c2d25))
- split collection filters and favorites into independent settings ([347c288](https://github.com/Celasha/Toolasha/commit/347c28827494f71415abba9a0cc0259e1966ba11))

## [2.46.1](https://github.com/Celasha/Toolasha/compare/v2.46.0...v2.46.1) (2026-05-15)

### Bug Fixes

- resolve PFormance empty data in library-split production build ([273b997](https://github.com/Celasha/Toolasha/commit/273b997214dbf9719541b6d2447285adbd4e0829))

## [2.46.0](https://github.com/Celasha/Toolasha/compare/v2.45.1...v2.46.0) (2026-05-15)

### Features

- add increment-based ability level targeting to upgrade advisor ([cdb0677](https://github.com/Celasha/Toolasha/commit/cdb0677f42d65ee15fe99c7483dee0f1e5131722))
- add PFormance panel and fix ability book cost calculation ([a23127d](https://github.com/Celasha/Toolasha/commit/a23127d3d6ee1a2f39a4fda95b9d7e4fc8cda021))

### Performance Improvements

- gate PFormance monitoring to only run when panel is open ([f7ad9f6](https://github.com/Celasha/Toolasha/commit/f7ad9f659dbc37be4e774a5b28f2498f86988937))

## [2.45.1](https://github.com/Celasha/Toolasha/compare/v2.45.0...v2.45.1) (2026-05-15)

### Bug Fixes

- populate auto-detected enhancement values on settings panel open ([24ff25c](https://github.com/Celasha/Toolasha/commit/24ff25cfc1ffb7db59e651c73716df7c9fbfa30d))

## [2.45.0](https://github.com/Celasha/Toolasha/compare/v2.44.1...v2.45.0) (2026-05-15)

### Features

- add live countdown timer to action progress bar ([a01b93d](https://github.com/Celasha/Toolasha/commit/a01b93d2a90d832ffc90c86802816a1046a172c5))

### Bug Fixes

- add equipment and ability picker dropdowns to combat sim ([bd4dcde](https://github.com/Celasha/Toolasha/commit/bd4dcde231918e0c3d5b795cba154042ca4a963a))
- detect achievement and community buff in enhancement auto-detect ([6bdebde](https://github.com/Celasha/Toolasha/commit/6bdebde1f9623d249186e18e85ccb7664c084042))
- prevent chat popout from loading full game URL in Firefox ([4c6ff67](https://github.com/Celasha/Toolasha/commit/4c6ff67ed9830968d29cc4324b70afceb8a82df0))
- update housing missing mats marketplace tabs on inventory change ([0d3888a](https://github.com/Celasha/Toolasha/commit/0d3888a0972797787cbe04c56fdcd3b713ce2812))
- use centered moving average for networth chart ([444bf8f](https://github.com/Celasha/Toolasha/commit/444bf8fb8e2692a204b9ef41bc43652e968c3726))

## [2.44.1](https://github.com/Celasha/Toolasha/compare/v2.44.0...v2.44.1) (2026-05-14)

### Bug Fixes

- recreate action timer display when React re-renders orphan it ([c5215de](https://github.com/Celasha/Toolasha/commit/c5215de2cdb6b0e92d4c34724d56e66a0b19cf07))

## [2.44.0](https://github.com/Celasha/Toolasha/compare/v2.43.0...v2.44.0) (2026-05-12)

### Features

- auto-sync custom tab items when loadout equipment changes ([2aea8f9](https://github.com/Celasha/Toolasha/commit/2aea8f9418dc1ab58794274d038b6a0ad1ab6467))
- auto-update bindings and snapshots when higher enhancement is acquired ([e51274a](https://github.com/Celasha/Toolasha/commit/e51274a91e39bc07597a1632b48eff72c1e50525))

### Bug Fixes

- export all Toolasha settings and filter imports by character ID ([7852573](https://github.com/Celasha/Toolasha/commit/7852573ce96459b44e645fd13073bf2d25141662))
- floating point precision in enhancement calculator level display ([577b8fa](https://github.com/Celasha/Toolasha/commit/577b8fabf2bbba95650a3e16e30a7cdda22ff14c))
- handle enhancement downgrades when higher version is sold ([e18ef23](https://github.com/Celasha/Toolasha/commit/e18ef23b0021c2b801f72705287d16b42c2fbe2f))
- update housing missing mats display when inventory changes ([99f0e54](https://github.com/Celasha/Toolasha/commit/99f0e54ebc81db2fd3689b941c495d57fbae0cf9))
- use all learned ability levels when applying loadout ([10cd391](https://github.com/Celasha/Toolasha/commit/10cd3914967324ef8c54d04d9048675f64b45bad))

### Code Refactoring

- replace raw enhancement sim inputs with gear-based settings ([8a15d64](https://github.com/Celasha/Toolasha/commit/8a15d64df657a7ea8d95bb50636437309e74af58))

## [2.43.0](https://github.com/Celasha/Toolasha/compare/v2.42.3...v2.43.0) (2026-05-11)

### Features

- add labyrinth combat simulator ([68ada69](https://github.com/Celasha/Toolasha/commit/68ada69e9bfd9dbb6b565b5b35efdb9cb7a2b50a))

## [2.42.3](https://github.com/Celasha/Toolasha/compare/v2.42.2...v2.42.3) (2026-05-11)

### Performance Improvements

- optimize fury stack calculations in combat sim ([ca2ebe3](https://github.com/Celasha/Toolasha/commit/ca2ebe371ed45a894efedcb90e96565c3d03d89b))

## [2.42.2](https://github.com/Celasha/Toolasha/compare/v2.42.1...v2.42.2) (2026-05-10)

### Bug Fixes

- exclude enhanced items when counting enhancement protection materials ([853f416](https://github.com/Celasha/Toolasha/commit/853f41675ca73002489704ec5c8ae3406bef52f3))
- show each enhancement level separately in exclude list ([7ba4a46](https://github.com/Celasha/Toolasha/commit/7ba4a4626b3e5ef37d3bbedb7b0f078e19f41e11))

## [2.42.1](https://github.com/Celasha/Toolasha/compare/v2.42.0...v2.42.1) (2026-05-10)

### Bug Fixes

- use auto-detected enhancing stats for back slot upgrade costs ([f3b4803](https://github.com/Celasha/Toolasha/commit/f3b480372f2a8c12c7badb0ef1070e62879bc3c3))

## [2.42.0](https://github.com/Celasha/Toolasha/compare/v2.41.6...v2.42.0) (2026-05-10)

### Features

- add ability upgrade testing and revamp results display in combat sim ([1fbf4c3](https://github.com/Celasha/Toolasha/commit/1fbf4c3c7546115e3d19dc732c9cfa3a5cba49ba))
- add search and price/profit filters to alchemy best items ([c689870](https://github.com/Celasha/Toolasha/commit/c689870b2a4aefa4adf3c26194c2cae4f4f87bce))
- add slot-specific enhancement breakpoints for upgrade advisor ([7d745ce](https://github.com/Celasha/Toolasha/commit/7d745ce678b9fb82affd92c7b5e4f812f620675b))

### Bug Fixes

- prevent chart from closing when clicking delete point popup ([4c1840a](https://github.com/Celasha/Toolasha/commit/4c1840a5c0c6228e874bd57279e3d8c54d8d593e))
- use crafting chain for defensive equipment tier upgrades in combat sim ([9341c99](https://github.com/Celasha/Toolasha/commit/9341c9972a89ee0b6e60e154b65c72efaa65dae9))

## [2.41.6](https://github.com/Celasha/Toolasha/compare/v2.41.5...v2.41.6) (2026-05-10)

### Bug Fixes

- add 48h, 7d, and custom duration options to chart moving average ([443a21f](https://github.com/Celasha/Toolasha/commit/443a21f36de68d8fff29832c774138b181ddfa56))
- factor alchemy success rate into estimated output totals ([81cb107](https://github.com/Celasha/Toolasha/commit/81cb107e6c837b35a42efe9cf9fc5ca86c838913))
- prevent bar chart whitespace and y-axis starting at zero ([4052653](https://github.com/Celasha/Toolasha/commit/4052653db99016dfa037a9308c2eaa701bc9b85b))
- prioritize selected tab over queued action in tea optimizer ([df92d56](https://github.com/Celasha/Toolasha/commit/df92d56c45371e15b95d3bbea6b79e2d68cfe693))

## [2.41.5](https://github.com/Celasha/Toolasha/compare/v2.41.4...v2.41.5) (2026-05-09)

### Bug Fixes

- use action category to identify processing instead of input count ([400ea88](https://github.com/Celasha/Toolasha/commit/400ea887fcaf01ac33c75bd51da2591dc156b466))

## [2.41.4](https://github.com/Celasha/Toolasha/compare/v2.41.3...v2.41.4) (2026-05-09)

### Bug Fixes

- open marketplace with material tabs instead of just first item ([9ff7daf](https://github.com/Celasha/Toolasha/commit/9ff7daf9efda3042a67dae417c6416aa03fad366))

## [2.41.3](https://github.com/Celasha/Toolasha/compare/v2.41.2...v2.41.3) (2026-05-09)

### Bug Fixes

- use game shop price in crafting plan when cheaper than market ([f0e95bf](https://github.com/Celasha/Toolasha/commit/f0e95bfb22ad12dba49d3b75512128cd61057def))

## [2.41.2](https://github.com/Celasha/Toolasha/compare/v2.41.1...v2.41.2) (2026-05-09)

### Bug Fixes

- use action-based filter for no-processing instead of depth limit ([61369d7](https://github.com/Celasha/Toolasha/commit/61369d738f80a4b9f116ee9a20eff05ebe36a86f))

## [2.41.1](https://github.com/Celasha/Toolasha/compare/v2.41.0...v2.41.1) (2026-05-09)

### Bug Fixes

- prioritize maxActionCountInput over generic number input lookup ([8b7e8fa](https://github.com/Celasha/Toolasha/commit/8b7e8fa67c372236aa0b4a69a5e52c506bca7e4d))

## [2.41.0](https://github.com/Celasha/Toolasha/compare/v2.40.7...v2.41.0) (2026-05-09)

### Features

- add task mode, no processing, and missing mats button to crafting plan ([8a8f96a](https://github.com/Celasha/Toolasha/commit/8a8f96a1a86521a8dd8200bb528dfa1e9d8c4639))
- add time cost factor to crafting plan buy-vs-craft decisions ([51e0966](https://github.com/Celasha/Toolasha/commit/51e096633e36b71bbe95e4b413d5d57b4e8ec90b))

### Bug Fixes

- add setting to hide green highlight on protected tasks ([1f322ae](https://github.com/Celasha/Toolasha/commit/1f322ae40816272d9ce6b280ef392bb9935ec7c7))
- clear autofill quantity after single use in buy modals ([8c99961](https://github.com/Celasha/Toolasha/commit/8c99961c16fb8478c296de255a72a331e2f7f71f))
- restrict action header match to current action only ([b5671c7](https://github.com/Celasha/Toolasha/commit/b5671c78fbec5c7c0e06ff8b0bd692a3f13ce0f9))

## [2.40.7](https://github.com/Celasha/Toolasha/compare/v2.40.6...v2.40.7) (2026-05-08)

### Bug Fixes

- correct combat level formula for party level gap debuff ([7a51549](https://github.com/Celasha/Toolasha/commit/7a515498e6698971150c1f56b98cf0ab2f87dba9))

## [2.40.6](https://github.com/Celasha/Toolasha/compare/v2.40.5...v2.40.6) (2026-05-07)

### Bug Fixes

- use incremental cost approach for upgrade advisor enhancement pricing ([0fa2275](https://github.com/Celasha/Toolasha/commit/0fa22753e2f57489fbd50408e1d30a9501feadd5))

## [2.40.5](https://github.com/Celasha/Toolasha/compare/v2.40.4...v2.40.5) (2026-05-07)

### Bug Fixes

- use direct market lookups for upgrade advisor cost to prevent false zero costs ([56d7281](https://github.com/Celasha/Toolasha/commit/56d72818a42c1c753f9945ef5863ba56e3b386a2))

## [2.40.4](https://github.com/Celasha/Toolasha/compare/v2.40.3...v2.40.4) (2026-05-07)

### Bug Fixes

- handle null market prices in upgrade advisor fallback and add debug logging ([0691b78](https://github.com/Celasha/Toolasha/commit/0691b781e3a2877a6345579ec3c85f817e96168f))

## [2.40.3](https://github.com/Celasha/Toolasha/compare/v2.40.2...v2.40.3) (2026-05-07)

### Bug Fixes

- correct upgrade advisor enhancement cost fallback pricing ([4635e80](https://github.com/Celasha/Toolasha/commit/4635e806e3e383d71e0e2ab6948e332e3e30e4e4))

## [2.40.2](https://github.com/Celasha/Toolasha/compare/v2.40.1...v2.40.2) (2026-05-07)

### Bug Fixes

- use market price deltas for upgrade advisor cost calculation ([6b9cc7d](https://github.com/Celasha/Toolasha/commit/6b9cc7da4769af04d176b8718c989c6d6795bd03))

## [2.40.1](https://github.com/Celasha/Toolasha/compare/v2.40.0...v2.40.1) (2026-05-07)

### Bug Fixes

- distinguish magic elements in upgrade advisor tier comparisons ([d4892f9](https://github.com/Celasha/Toolasha/commit/d4892f90637ae08b9849808bcf2c1b80249cf0ea))

## [2.40.0](https://github.com/Celasha/Toolasha/compare/v2.39.5...v2.40.0) (2026-05-07)

### Features

- add combat sim upgrade advisor tab ([a3fe6a4](https://github.com/Celasha/Toolasha/commit/a3fe6a4f849ccff0cc1843bf82469dd71644905b))
- add setting to show dungeon completion time as decimal minutes ([064d645](https://github.com/Celasha/Toolasha/commit/064d6454ad0283f66173f7a8b23965adbfd668e0))

### Bug Fixes

- allow disabling currency token tooltips setting ([c4a2941](https://github.com/Celasha/Toolasha/commit/c4a29415ca506f72bc579f1e1676e22e0b78a911))
- correct dungeon sim profit calculation and comparison deltas ([4aa724e](https://github.com/Celasha/Toolasha/commit/4aa724e764f6f421171073bf966862f386345cc8))
- use correct storage method and key in settings reset ([6fcc73e](https://github.com/Celasha/Toolasha/commit/6fcc73e4e8b669317bc05151df5451ed243e82d4))
- use index 0 for best bid in listing price display ([cf864be](https://github.com/Celasha/Toolasha/commit/cf864bece8e9e7c456ed4561ee7b9bea947e35bf))

## [2.39.5](https://github.com/Celasha/Toolasha/compare/v2.39.4...v2.39.5) (2026-05-07)

### Bug Fixes

- correct 11 combat sim engine discrepancies vs reference implementation ([8e6bbc3](https://github.com/Celasha/Toolasha/commit/8e6bbc36a7c3d56cfe6fa82529cfdb373fbf0a20))
- remove premature storage read in networth chart constructor ([3c8c485](https://github.com/Celasha/Toolasha/commit/3c8c485a705fc94c009fabd339a68b9972d43af2))

## [2.39.4](https://github.com/Celasha/Toolasha/compare/v2.39.3...v2.39.4) (2026-05-07)

### Bug Fixes

- aggregate healingAmplify from buffs in combat sim ([7620a76](https://github.com/Celasha/Toolasha/commit/7620a764955bef03b1defc0305b200f7d74c870b))

## [2.39.3](https://github.com/Celasha/Toolasha/compare/v2.39.2...v2.39.3) (2026-05-06)

### Bug Fixes

- close net worth chart on click outside ([e90306b](https://github.com/Celasha/Toolasha/commit/e90306bd176035bf5b837098522be889712cf4e0))
- limit gear score setting scope to only hide score display ([63d8aaa](https://github.com/Celasha/Toolasha/commit/63d8aaaa66886899c51f9acce179ca9e72e27f12))
- resolve intermittent time-to-level tooltip not appearing ([86bdd20](https://github.com/Celasha/Toolasha/commit/86bdd204934efe459573c594249f987c31545c73))

## [2.39.2](https://github.com/Celasha/Toolasha/compare/v2.39.1...v2.39.2) (2026-05-06)

### Bug Fixes

- force full rebuild after drag-and-drop tile operations ([eb42a34](https://github.com/Celasha/Toolasha/commit/eb42a34a59aab942ed4a29d8340ec345f3c39877))
- limit pin-to-top positioning to item and collection tooltips only ([1df6dae](https://github.com/Celasha/Toolasha/commit/1df6dae167aed72b96aa65401318088fffe84922))
- prevent chest EV display from being blocked by disabled price setting ([690726b](https://github.com/Celasha/Toolasha/commit/690726b22a8b750ca5c917807c203a832f8cbb68))
- restore skill calculator on Shykai page via GM storage fallback ([4522ae6](https://github.com/Celasha/Toolasha/commit/4522ae60e9b0df754954901c27a7e6336199c362))
- show unclaimed enhanced items in Unorganized bucket ([d47a649](https://github.com/Celasha/Toolasha/commit/d47a649174f07fae6c61fbdc1528e6e82520d73e))

## [2.39.1](https://github.com/Celasha/Toolasha/compare/v2.39.0...v2.39.1) (2026-05-06)

### Bug Fixes

- resolve missing enhancement levels in loadout-based combat sim export ([fcb3c4e](https://github.com/Celasha/Toolasha/commit/fcb3c4ed9975bfab3d44a273508f435040dd9cee))

## [2.39.0](https://github.com/Celasha/Toolasha/compare/v2.38.5...v2.39.0) (2026-05-06)

### Features

- add drag and drop for custom inventory tab items ([3af3d37](https://github.com/Celasha/Toolasha/commit/3af3d37e673f872a283f9193f1899b091020d692))

### Bug Fixes

- ceil books needed calculation and guard null trigger dependencies ([3fec882](https://github.com/Celasha/Toolasha/commit/3fec882aaeb3b552cb7018729bf969f3ec019d89))
- correct custom tab tile claiming order for collapsed tabs ([1ea9817](https://github.com/Celasha/Toolasha/commit/1ea9817ec5d99a80797a163c389ac21c6a3f1707))
- decouple listing total price colors from shared color settings ([43e3c1c](https://github.com/Celasha/Toolasha/commit/43e3c1c85e1cb413113efb1608b0cd93d24615ff))
- display house rooms in combat sim Configure tab ([678d547](https://github.com/Celasha/Toolasha/commit/678d547ad859766029d2e4084844140b7cbf4af8))
- pin-top tooltip positioning at low browser zoom levels ([a1f22fe](https://github.com/Celasha/Toolasha/commit/a1f22fe2dab6c4d92782a0f510f77f718bd02e40))
- use live equipment Map to preserve enhancement levels in sim export ([12dd6f7](https://github.com/Celasha/Toolasha/commit/12dd6f7770af2deecf4d5cb2c6b5414693c29902))
- use stored duration when loading combat stats from previous session ([d93411f](https://github.com/Celasha/Toolasha/commit/d93411f43599242673b9e052fa6cca8f7ce1084a))

## [2.38.5](https://github.com/Celasha/Toolasha/compare/v2.38.4...v2.38.5) (2026-05-05)

### Bug Fixes

- guard null friendlies/enemies in combat trigger evaluation ([5743b64](https://github.com/Celasha/Toolasha/commit/5743b64cbfe1e84ce4366a7b0b8f657d42e405dc))

## [2.38.4](https://github.com/Celasha/Toolasha/compare/v2.38.3...v2.38.4) (2026-05-05)

### Bug Fixes

- add comprehensive debug logging to all zone spawn paths ([45dd705](https://github.com/Celasha/Toolasha/commit/45dd705be7607977800c8f8733c4ab098a02ad8e))

## [2.38.3](https://github.com/Celasha/Toolasha/compare/v2.38.2...v2.38.3) (2026-05-05)

### Bug Fixes

- add debug logging and defensive guard for dungeon wave spawn crash ([873449d](https://github.com/Celasha/Toolasha/commit/873449d6c356d5991c4f2a6b4bd2a6503ce9a837))

## [2.38.2](https://github.com/Celasha/Toolasha/compare/v2.38.1...v2.38.2) (2026-05-05)

### Bug Fixes

- guard against null fixedSpawnsMap entries in dungeon waves ([f8c8762](https://github.com/Celasha/Toolasha/commit/f8c8762634a802c738d5183c008b94c55407275b))

## [2.38.1](https://github.com/Celasha/Toolasha/compare/v2.38.0...v2.38.1) (2026-05-05)

### Bug Fixes

- handle unmatched dungeon wave ranges in spawn lookup ([594a483](https://github.com/Celasha/Toolasha/commit/594a483246b3a6d7463bd230d28c79e0b54e3194))
- reset to defaults now uses actual schema default values ([65cc577](https://github.com/Celasha/Toolasha/commit/65cc57751eae58750817ed4b1e2c5975b8fdd50f))

## [2.38.0](https://github.com/Celasha/Toolasha/compare/v2.37.0...v2.38.0) (2026-05-05)

### Features

- add avg completion time and totals to dungeon sim results ([68df358](https://github.com/Celasha/Toolasha/commit/68df358fe96c6a727c5ad7bccfed7f1ebbc2a0dd))

### Bug Fixes

- resolve dungeon sim crash on exact wave key boundary ([d99b792](https://github.com/Celasha/Toolasha/commit/d99b7927f4c47a3e5514483b527d0b98155b9343))

## [2.37.0](https://github.com/Celasha/Toolasha/compare/v2.36.1...v2.37.0) (2026-05-05)

### Features

- change "Buy intermediates" to only buy uncraftable raw materials ([36eea27](https://github.com/Celasha/Toolasha/commit/36eea27aa9e017e7d1b2899a922acc3f0079b357))

### Bug Fixes

- use combatAbilities with positional aura detection for sim export ([d576c25](https://github.com/Celasha/Toolasha/commit/d576c25c4cd99328224550c3ad11b08d19835076))

## [2.36.1](https://github.com/Celasha/Toolasha/compare/v2.36.0...v2.36.1) (2026-05-05)

### Miscellaneous Chores

- add debug logging for self ability import diagnosis ([ca6dc96](https://github.com/Celasha/Toolasha/commit/ca6dc96ec6d701e2689f0b5a0cec27e6e733f36d))

## [2.36.0](https://github.com/Celasha/Toolasha/compare/v2.35.0...v2.36.0) (2026-05-04)

### Features

- add configurable default hours settings for combat sim modes ([ec4fc4d](https://github.com/Celasha/Toolasha/commit/ec4fc4db596bd35bb2b9d327fcb1bf1a10e05cbf))

### Bug Fixes

- add Profit/day column, two-decimal Deaths/hr, and base-item click in inventory search ([6e77e66](https://github.com/Celasha/Toolasha/commit/6e77e664a6d4062b4698ebb2d6b94f83a5aa2433))
- use characterLoadoutMap for ability slot assignment in sim export ([fad3e8c](https://github.com/Celasha/Toolasha/commit/fad3e8c2c1aa3fb421d655733d92923eb7912be4))

## [2.35.0](https://github.com/Celasha/Toolasha/compare/v2.34.0...v2.35.0) (2026-05-03)

### Features

- add early exit and seek best source to all zones combat sim ([473299d](https://github.com/Celasha/Toolasha/commit/473299d61487317cba48f9d498a335842033c666))

### Bug Fixes

- restore GM storage for cross-domain Import from Toolasha on Shykai ([1f5f1ff](https://github.com/Celasha/Toolasha/commit/1f5f1ff57f6b782979c56c35c85a67498c3dcd9f))

## [2.34.0](https://github.com/Celasha/Toolasha/compare/v2.33.1...v2.34.0) (2026-05-03)

### Features

- add topmost-tab priority for custom inventory tabs ([b5f3b4c](https://github.com/Celasha/Toolasha/commit/b5f3b4cc33d75860bfad61b5635bbd8fdb3c73ba))

### Bug Fixes

- resolve history.some is not a function in combat sim comparison panel ([c41bec4](https://github.com/Celasha/Toolasha/commit/c41bec4e70fa778dc548ed87e61fc87cd1186626))

## [2.33.1](https://github.com/Celasha/Toolasha/compare/v2.33.0...v2.33.1) (2026-05-03)

### Bug Fixes

- catch async WS handler rejections and guard action_completed null characterItems ([e65a5fb](https://github.com/Celasha/Toolasha/commit/e65a5fb65076584ce178163a3a9c12e3a7bdb7a4))

## [2.33.0](https://github.com/Celasha/Toolasha/compare/v2.32.4...v2.33.0) (2026-05-03)

### Features

- fix custom tab tile-stealing and add "Add all levels" shortcut for equipment items ([95ea23c](https://github.com/Celasha/Toolasha/commit/95ea23c3cfb9a8ffdbe6b693d2eb82cd942463ce))
- fix preset consumable trigger calculation and add delete result buttons ([506dec4](https://github.com/Celasha/Toolasha/commit/506dec49c96adadc086e42122d0e6b2c6348998a))

### Bug Fixes

- force full layout rebuild when config item count changes to prevent tile cascading ([ec207fb](https://github.com/Celasha/Toolasha/commit/ec207fb4aaccffe42ccc2922d5bfe77dd6f7b92d))
- use equipment presence instead of missing maxEnhancementLevel field to detect expandable items ([741b3c1](https://github.com/Celasha/Toolasha/commit/741b3c1393d8152d96f664cd86b762100845fbe7))

## [2.32.4](https://github.com/Celasha/Toolasha/compare/v2.32.3...v2.32.4) (2026-05-03)

### Bug Fixes

- show all enhancement levels in custom tab item picker, mark owned with indicator ([eea2cce](https://github.com/Celasha/Toolasha/commit/eea2cced159a26e079da4fa04b03a31fdac4d340))
- write profile list to IndexedDB immediately on profile_shared ([3fbdb96](https://github.com/Celasha/Toolasha/commit/3fbdb962a9571d932facee6051195385eca44546))

## [2.32.3](https://github.com/Celasha/Toolasha/compare/v2.32.2...v2.32.3) (2026-05-03)

### Bug Fixes

- replace GM storage with IndexedDB for profile list and dataManager for character/battle data ([e92e0a9](https://github.com/Celasha/Toolasha/commit/e92e0a9e836b987adc2e25ec4732e22341332d71))

## [2.32.2](https://github.com/Celasha/Toolasha/compare/v2.32.1...v2.32.2) (2026-05-03)

### Bug Fixes

- fall back to characterLoadoutMap from init_character_data for Steam users ([c53c2b3](https://github.com/Celasha/Toolasha/commit/c53c2b3828db2100365f11c28b4dcd53de57d41d))

## [2.32.1](https://github.com/Celasha/Toolasha/compare/v2.32.0...v2.32.1) (2026-05-03)

### Miscellaneous Chores

- add diagnostic logging to loadout snapshot pipeline ([7078324](https://github.com/Celasha/Toolasha/commit/70783248d15e18b4caf6e2a3364d74583a8e9d18))

## [2.32.0](https://github.com/Celasha/Toolasha/compare/v2.31.2...v2.32.0) (2026-05-03)

### Features

- add all-zones combat simulation with player import and sortable results ([4e1df65](https://github.com/Celasha/Toolasha/commit/4e1df65d20c8af35da4695f1b11d5c28504a134c))

### Bug Fixes

- register loadouts_updated handler at module load time ([aad1dd1](https://github.com/Celasha/Toolasha/commit/aad1dd18bc97d4d82a71e62681f8d2c6f65e822f))

## [2.31.2](https://github.com/Celasha/Toolasha/compare/v2.31.1...v2.31.2) (2026-05-02)

### Bug Fixes

- guard GM storage calls for environments without GM APIs ([6a519df](https://github.com/Celasha/Toolasha/commit/6a519dfbaa046a2c9e6b0100846fcbf14c93f1d3))

## [2.31.1](https://github.com/Celasha/Toolasha/compare/v2.31.0...v2.31.1) (2026-05-02)

### Bug Fixes

- add "buy intermediates" toggle to crafting plan ([c60c216](https://github.com/Celasha/Toolasha/commit/c60c21688e9c7d3eada8941d1e85f70de2ce02fb))
- add catalytic tea and remove artisan tea from alchemy optimizer ([9f88c2e](https://github.com/Celasha/Toolasha/commit/9f88c2ec6b1e98b611739d1902d660ae0d36aa42))
- add IndexedDB auto-reconnection and storage diagnostics ([39d87e5](https://github.com/Celasha/Toolasha/commit/39d87e52b959332b964395f41272e524f48ba9e9))
- correct double /items/ prefix in milkyway market link URL ([7161bdb](https://github.com/Celasha/Toolasha/commit/7161bdb6a44d72df7d6f674c42388c08fb602218))
- split XP color into separate rate and hours-to-level settings ([ef80baa](https://github.com/Celasha/Toolasha/commit/ef80baa7992c22a07dfc24b76a03cd5ee2273682))

### Miscellaneous Chores

- deprecate Steam build and remove all Steam-specific code ([3a72bbe](https://github.com/Celasha/Toolasha/commit/3a72bbe574484891de7e7461f347f30e70a382fd))

## [2.31.0](https://github.com/Celasha/Toolasha/compare/v2.30.2...v2.31.0) (2026-05-01)

### Features

- add best crafting plan to action panels ([a2dec28](https://github.com/Celasha/Toolasha/commit/a2dec281900d7dde899404cb40b595294f6a28bd))
- add milkyway market link to marketplace order books ([e43abfa](https://github.com/Celasha/Toolasha/commit/e43abfa17c59299121af4b3761ce8d3b2271e644))
- add seals, achievement buffs, and back slot to milkonomy export ([68405c2](https://github.com/Celasha/Toolasha/commit/68405c2c92ba728cf27a2a8d31fe81f999c08135))

### Bug Fixes

- default all collection filters to checked for new users ([2a066ec](https://github.com/Celasha/Toolasha/commit/2a066ec3e0425f343828957c045f60f26e0a2b48))

## [2.30.2](https://github.com/Celasha/Toolasha/compare/v2.30.1...v2.30.2) (2026-05-01)

### Bug Fixes

- hook page MessageEvent prototype and remove instanceof guard ([e8490a5](https://github.com/Celasha/Toolasha/commit/e8490a5255735267ff9427e3af73c34ecc83296e))

## [2.30.1](https://github.com/Celasha/Toolasha/compare/v2.30.0...v2.30.1) (2026-05-01)

### Bug Fixes

- use correct setting key for inventory networth panel ([5fcbea0](https://github.com/Celasha/Toolasha/commit/5fcbea0663323380cd9247d51d9a52b6e1e81c11))

## [2.30.0](https://github.com/Celasha/Toolasha/compare/v2.29.0...v2.30.0) (2026-05-01)

### Features

- add alchemy best items ranking by profit and XP ([1250222](https://github.com/Celasha/Toolasha/commit/12502220111895c604f8c20d3a081941ba3d89eb))

## [2.29.0](https://github.com/Celasha/Toolasha/compare/v2.28.2...v2.29.0) (2026-05-01)

### Features

- add materials availability indicator on production task cards ([89b5a92](https://github.com/Celasha/Toolasha/commit/89b5a92b61465d2a2dacae345fb38b8f3ee20d47))

## [2.28.2](https://github.com/Celasha/Toolasha/compare/v2.28.1...v2.28.2) (2026-05-01)

### Bug Fixes

- use getSetting for sub-settings incorrectly using isFeatureEnabled ([0d455e9](https://github.com/Celasha/Toolasha/commit/0d455e9023f34412e952ad86a1485a41ea13079f))

## [2.28.1](https://github.com/Celasha/Toolasha/compare/v2.28.0...v2.28.1) (2026-05-01)

### Bug Fixes

- decouple tooltip pin-to-top from market prices setting ([97c59a8](https://github.com/Celasha/Toolasha/commit/97c59a80622ceafad06e0082f684df6a7c98568f))

## [2.28.0](https://github.com/Celasha/Toolasha/compare/v2.27.0...v2.28.0) (2026-04-30)

### Features

- add alchemy tea recommendation support ([1596c7d](https://github.com/Celasha/Toolasha/commit/1596c7db8903c4c481031ac3a91321c2611dcaf4))
- add timing display to queue hover tooltip ([7e57ba3](https://github.com/Celasha/Toolasha/commit/7e57ba3455c4fa1dab74d5dc3064261a2610b4d7))

### Bug Fixes

- collection badge setting not persisting after refresh ([d3c036d](https://github.com/Celasha/Toolasha/commit/d3c036da3b4f66051551d8fe493e6eb813d74a38))
- labyrinth best-level badge position shifting after edit/save ([ea80a49](https://github.com/Celasha/Toolasha/commit/ea80a4902416322d7803cf8dbcbe702c5cd0753c))
- preserve customCheck when converting features to registry format ([51cb2a4](https://github.com/Celasha/Toolasha/commit/51cb2a46ccc1219cb3c882e28c978998a2f87c5d))
- re-render trade history display when DOM element is removed ([3177897](https://github.com/Celasha/Toolasha/commit/3177897a73ca5100e9d96b57c09254ad28e2e34e))
- show trade history when order book has only one side ([c785da8](https://github.com/Celasha/Toolasha/commit/c785da8b45e20930f60aaccefe6f082db7bb5999))

### Miscellaneous Chores

- remove stale debug console.log statements ([cad180c](https://github.com/Celasha/Toolasha/commit/cad180ccad7705024d8b4c7674914b120d5d98c0))

## [2.27.0](https://github.com/Celasha/Toolasha/compare/v2.26.0...v2.27.0) (2026-04-30)

### Features

- add staleness indicator to collection skilling badges ([fabe9ab](https://github.com/Celasha/Toolasha/commit/fabe9abaebb867cbc0d222b9208aad49ac06bcd0))

### Bug Fixes

- count failed attempts in alchemy history trackers ([8b97a9b](https://github.com/Celasha/Toolasha/commit/8b97a9b73c1c9bf5d761c6f8e5b24f577247cf00))
- decouple level progress from profit detail toggle ([d877757](https://github.com/Celasha/Toolasha/commit/d8777574ceae58f89a3560eb0ba7548182c3d1d2))

### Miscellaneous Chores

- add diagnostic logging for alchemy coinify display ([2e5cee2](https://github.com/Celasha/Toolasha/commit/2e5cee267bbaf12a93ad0b85b42db9ae4eeadcb0))

## [2.26.0](https://github.com/Celasha/Toolasha/compare/v2.25.1...v2.26.0) (2026-04-29)

### Features

- add Sim Character button to profile page ([81dbbf2](https://github.com/Celasha/Toolasha/commit/81dbbf2e8b63df65b1201f61345b588c7634e5af))

### Bug Fixes

- anchor abilities panel to bottom of screen and make it draggable ([b4cd9d7](https://github.com/Celasha/Toolasha/commit/b4cd9d750929088c8150a59199632a2d6d4efe12))
- initialize task Go merge when profit calculator is disabled ([7e52bd0](https://github.com/Celasha/Toolasha/commit/7e52bd030c2dfa4445114e3825391a22a61c81e4))
- reload pinned actions using correct character ID after switch ([ae586c7](https://github.com/Celasha/Toolasha/commit/ae586c7f75a90d779cb97774ae29a643be0be02d))

## [2.25.1](https://github.com/Celasha/Toolasha/compare/v2.25.0...v2.25.1) (2026-04-29)

### Bug Fixes

- exclude Toolasha zone-index span from task description text in profit display ([1363340](https://github.com/Celasha/Toolasha/commit/13633401830ef36cca5f46a31a90f8057fa621ac))

## [2.25.0](https://github.com/Celasha/Toolasha/compare/v2.24.8...v2.25.0) (2026-04-29)

### Features

- add inline Auto/Manual mode toggle to enhancement calculator ([eed0222](https://github.com/Celasha/Toolasha/commit/eed0222bd41f4a8eba941eb0621f8363c61f5190))

### Bug Fixes

- strip zone suffix from monster name before lookup in combat task estimate ([6184df0](https://github.com/Celasha/Toolasha/commit/6184df0a14821bb780ce605f8122a76907c65dd4))

## [2.24.8](https://github.com/Celasha/Toolasha/compare/v2.24.7...v2.24.8) (2026-04-29)

### Miscellaneous Chores

- add diagnostic logging for task identification failures ([7abc65c](https://github.com/Celasha/Toolasha/commit/7abc65ccee73a740d597945f9ef3653f1a0ec078))

## [2.24.7](https://github.com/Celasha/Toolasha/compare/v2.24.6...v2.24.7) (2026-04-29)

### Bug Fixes

- use lazy runtime accessor for loadout-snapshot in task display ([da169b3](https://github.com/Celasha/Toolasha/commit/da169b3301a0e6b942f4023515e83a6d6a54c3c5))

## [2.24.6](https://github.com/Celasha/Toolasha/compare/v2.24.5...v2.24.6) (2026-04-29)

### Bug Fixes

- deduplicate loadout-snapshot instance across split bundles ([3c48a4f](https://github.com/Celasha/Toolasha/commit/3c48a4fef1843163d9bee57f1dcf86d51a44ea1a))

## [2.24.5](https://github.com/Celasha/Toolasha/compare/v2.24.4...v2.24.5) (2026-04-29)

### Bug Fixes

- load loadout snapshots after character ID is available ([1841289](https://github.com/Celasha/Toolasha/commit/1841289c5ed01a6d8d2f48728bab274d6c975d11))

## [2.24.4](https://github.com/Celasha/Toolasha/compare/v2.24.3...v2.24.4) (2026-04-29)

### Bug Fixes

- refresh task combat loadout dropdown when loadouts_updated fires ([966a4dc](https://github.com/Celasha/Toolasha/commit/966a4dc17ebdcbfd6417dae5267f4c479b72569c))

## [2.24.3](https://github.com/Celasha/Toolasha/compare/v2.24.2...v2.24.3) (2026-04-29)

### Bug Fixes

- await loadout snapshot initialization to prevent race condition ([4f515eb](https://github.com/Celasha/Toolasha/commit/4f515ebd8c48b5f2915ba9252afb9eb30b224b22))
- re-query input and action details at click time in quick input buttons ([4a23387](https://github.com/Celasha/Toolasha/commit/4a2338770b828c778a08ab794f09f351d9fb87b5))

## [2.24.2](https://github.com/Celasha/Toolasha/compare/v2.24.1...v2.24.2) (2026-04-29)

### Bug Fixes

- make action sort mode per-character instead of global ([5f1c9fd](https://github.com/Celasha/Toolasha/commit/5f1c9fd6cb90b149de9a5df61fb9bc998e821fe9))
- prevent empty alchemy history sessions from queue changes ([52a9fa5](https://github.com/Celasha/Toolasha/commit/52a9fa53c7d8567f8d9ff460516a5e1841b88649))
- prevent labyrinth best-level badge from breaking extension ([8ce4ee6](https://github.com/Celasha/Toolasha/commit/8ce4ee68dcc9cc2f94b675a736fdd0028d5ef9d3))
- target correct CSS class for labyrinth panel width override ([bfd5284](https://github.com/Celasha/Toolasha/commit/bfd5284b368795f2a70f7ff5ecdf10c20ff223a6))

## [2.24.1](https://github.com/Celasha/Toolasha/compare/v2.24.0...v2.24.1) (2026-04-28)

### Bug Fixes

- support live setting toggle for queue monitor ([08f13e6](https://github.com/Celasha/Toolasha/commit/08f13e65bf25d70ed9662e19e03bd24cc302f7de))

## [2.24.0](https://github.com/Celasha/Toolasha/compare/v2.23.0...v2.24.0) (2026-04-28)

### Features

- add combat task time and profit estimator ([cc425d2](https://github.com/Celasha/Toolasha/commit/cc425d2b1f26d289012c620d52ad37f9d640ddee))
- add cross-character queue monitor ([325eba4](https://github.com/Celasha/Toolasha/commit/325eba43544ad1a14b453c0b63b7520606480df5))
- add decompose session history tracking and viewer ([9e456d1](https://github.com/Celasha/Toolasha/commit/9e456d1d694f4d5620f5f1e9adb82c5791c102bb))
- add per-pane message filters to pop-out chat ([059d73d](https://github.com/Celasha/Toolasha/commit/059d73ddf61f4a28031cdae6d3f89c222a9c162c))

## [2.23.0](https://github.com/Celasha/Toolasha/compare/v2.22.2...v2.23.0) (2026-04-27)

### Features

- add All Off / Restore buttons to settings panel ([95291c5](https://github.com/Celasha/Toolasha/commit/95291c5c5184312427e07435c8b0b10ac88932ba))

### Bug Fixes

- correct actionPanel_showExpPerHour label and help text ([9a9f4ae](https://github.com/Celasha/Toolasha/commit/9a9f4aea46be579141554dfcd8e26e8c6b5fa3e9))

## [2.22.2](https://github.com/Celasha/Toolasha/compare/v2.22.1...v2.22.2) (2026-04-27)

### Bug Fixes

- restore querySelectorAll descent in DOMObserver.onClass for container nodes ([620caff](https://github.com/Celasha/Toolasha/commit/620caffa964e3a1f260075e75706465bc6fe6449))
- sort combat statistics drop list by total value descending ([49ea6f3](https://github.com/Celasha/Toolasha/commit/49ea6f3073a14f5a06dbf8a62153f351456c15a8))
- split action panel profit setting into tile and detail controls ([0eeee58](https://github.com/Celasha/Toolasha/commit/0eeee5801f3703c1450107e512e2c9be422420e3))
- use substring class selector for missing mats badge to survive game updates ([87e7691](https://github.com/Celasha/Toolasha/commit/87e7691d6ff6df3e24992b496d36897e03d8211e))
- use top bid (bids[0]) instead of lowest bid when reading order books ([4f5cac8](https://github.com/Celasha/Toolasha/commit/4f5cac89ea02adcf8d7da0e4652588e3210ac1db))

### Code Refactoring

- remove diagnostic logs from alchemy profit display ([ce314ea](https://github.com/Celasha/Toolasha/commit/ce314ea0399a4d1837562d2c2ad06dac70f02d81))

## [2.22.1](https://github.com/Celasha/Toolasha/compare/v2.22.0...v2.22.1) (2026-04-27)

### Bug Fixes

- remove redundant querySelectorAll descent in DOMObserver.onClass ([0203a8d](https://github.com/Celasha/Toolasha/commit/0203a8d2403b6b389bdeb9b3b21a6bb3af36c809))

### Code Refactoring

- exclude taskDamage from player damage roll in combat sim ([af25935](https://github.com/Celasha/Toolasha/commit/af259355e66de26e0c3dd9e9db9e0e01e221fe99))
- remove leftover debug logging from combat sim ([5d636c6](https://github.com/Celasha/Toolasha/commit/5d636c6ddfd1de2692afba138f241576dbf30d38))

## [2.22.0](https://github.com/Celasha/Toolasha/compare/v2.21.0...v2.22.0) (2026-04-26)

### Features

- add consumable editing and comparison table to combat sim ([0cdbe7c](https://github.com/Celasha/Toolasha/commit/0cdbe7c030e55266958aa8f52554728c038e2ab3))

### Bug Fixes

- use loose equality when resetting absent monster combat stats to zero ([7d61522](https://github.com/Celasha/Toolasha/commit/7d61522610983ef540f023a5b07613b05354bcd6))

## [2.21.0](https://github.com/Celasha/Toolasha/compare/v2.20.1...v2.21.0) (2026-04-25)

### Features

- add drag-and-drop tab reordering for character panel ([6367cbb](https://github.com/Celasha/Toolasha/commit/6367cbb11b72edafacda5972d43aed75ccfe5509))
- add setting to toggle protection items in enhancement material limit ([ebbe621](https://github.com/Celasha/Toolasha/commit/ebbe621307e902d09bbd69be364a6b76735797cc))
- add zone-level protection toggle to task reroll protection ([41921ff](https://github.com/Celasha/Toolasha/commit/41921ffc640db88e5df19cbf3dca2e31a71565de))

### Bug Fixes

- include gathering dropTable items in collection time-to-tier sort ([9077a6a](https://github.com/Celasha/Toolasha/commit/9077a6a53715c73cbf4b527b293a989199731164))

## [2.20.1](https://github.com/Celasha/Toolasha/compare/v2.20.0...v2.20.1) (2026-04-24)

### Bug Fixes

- add 3-second lockdown to task reroll protection ([2f78f28](https://github.com/Celasha/Toolasha/commit/2f78f289dd070841a792b5a4020b318ccf7dad33))

## [2.20.0](https://github.com/Celasha/Toolasha/compare/v2.19.2...v2.20.0) (2026-04-24)

### Features

- add task reroll protection with configurable protected zones ([f5cc111](https://github.com/Celasha/Toolasha/commit/f5cc111aa134ee32ec48cfe1e868e8e7ae1849fa))

### Bug Fixes

- correct combat sim trigger handling and null enemies crash ([ea01ff5](https://github.com/Celasha/Toolasha/commit/ea01ff593295b0a71ccacbc33b0de995fb8288dc))

## [2.19.2](https://github.com/Celasha/Toolasha/compare/v2.19.1...v2.19.2) (2026-04-23)

### Bug Fixes

- add dungeon key costs to combat sim profit calculations ([1aed228](https://github.com/Celasha/Toolasha/commit/1aed228d2f7d1b201893ea23c35d44493d333b1e))

## [2.19.1](https://github.com/Celasha/Toolasha/compare/v2.19.0...v2.19.1) (2026-04-23)

### Bug Fixes

- limit combat sim tier dropdown to T0-T5 for zones and T0-T2 for dungeons ([1a7af0f](https://github.com/Celasha/Toolasha/commit/1a7af0f6207333388b88edfee417fcb4c4ddb2e5))
- use dungeon completion rewards instead of monster drops for dungeon sims ([79affc5](https://github.com/Celasha/Toolasha/commit/79affc54f2d5b1c96454c1f7a1a7ba21bedcf47c))

## [2.19.0](https://github.com/Celasha/Toolasha/compare/v2.18.2...v2.19.0) (2026-04-23)

### Features

- add session history, loadout selection, and auto-labeled comparisons to combat sim ([7e427f3](https://github.com/Celasha/Toolasha/commit/7e427f3390a65877f9e0d6e92e843b9767c5bc02))
- add tooltip valuations for task tokens, labyrinth tokens, seals, and cowbells ([6c5b7c1](https://github.com/Celasha/Toolasha/commit/6c5b7c1661b0dd9fd7d990f752f9cfd33e5b67f9))

### Bug Fixes

- add deltas to per-day columns in combat sim results ([de7ad59](https://github.com/Celasha/Toolasha/commit/de7ad598b4160c6c1610cdf5b715cf1c63f4b969))
- clear stale action stats and battle counter on action switch ([2ee57cb](https://github.com/Celasha/Toolasha/commit/2ee57cb44d7b3d7140338425bf9b6d945da3686c))
- scope pinned actions storage per character ([7a90c65](https://github.com/Celasha/Toolasha/commit/7a90c658e16c8fbbea08a471a1efc083d28fd365))
- use highest bid for top order price in trade history display ([05fc3f6](https://github.com/Celasha/Toolasha/commit/05fc3f66241951afc358297a3d39eeab0a228d39))

## [2.18.2](https://github.com/Celasha/Toolasha/compare/v2.18.1...v2.18.2) (2026-04-22)

### Bug Fixes

- add quantity/day columns and fix overlapping text in combat sim ([935538d](https://github.com/Celasha/Toolasha/commit/935538d5384b4c9ed1195fe0f350182bee4ee53a))

## [2.18.1](https://github.com/Celasha/Toolasha/compare/v2.18.0...v2.18.1) (2026-04-22)

### Bug Fixes

- add per-day gold columns to combat sim results ([33aca03](https://github.com/Celasha/Toolasha/commit/33aca030d50296a8a2dc47fd7a189bb6b4059be6))

## [2.18.0](https://github.com/Celasha/Toolasha/compare/v2.17.2...v2.18.0) (2026-04-22)

### Features

- add loadout editor and comparison deltas to combat sim ([3236ff6](https://github.com/Celasha/Toolasha/commit/3236ff68a44ce5b7a83e4355a57d50b23b0aaf4d))

## [2.17.2](https://github.com/Celasha/Toolasha/compare/v2.17.1...v2.17.2) (2026-04-22)

### Bug Fixes

- show per-player data in combat sim results for party sims ([dc03026](https://github.com/Celasha/Toolasha/commit/dc03026f6cdd405c69d203e7f8db2634915ee2e6))

## [2.17.1](https://github.com/Celasha/Toolasha/compare/v2.17.0...v2.17.1) (2026-04-21)

### Bug Fixes

- show only self XP/hr in combat sim results ([43ce37a](https://github.com/Celasha/Toolasha/commit/43ce37a5fc6a7779a35f44010dee02179540c59b))

## [2.17.0](https://github.com/Celasha/Toolasha/compare/v2.16.0...v2.17.0) (2026-04-21)

### Features

- add in-game Combat Simulator ([84d9763](https://github.com/Celasha/Toolasha/commit/84d9763fe14dbcb8cf584ba4c91226220bb97825))

### Bug Fixes

- add missing daily profit rate to gathering tooltip ([9818e86](https://github.com/Celasha/Toolasha/commit/9818e860e3a770597ac9cae3287b779041258dba))

### Miscellaneous Chores

- bump Steam bundle size limit to 6MB for combat sim engine ([478414e](https://github.com/Celasha/Toolasha/commit/478414e8bc3639ea823b4f7ed76c634fff83bf11))

## [2.16.0](https://github.com/Celasha/Toolasha/compare/v2.15.0...v2.16.0) (2026-04-20)

### Features

- add Enhancement XPH Calculator ([22bf42e](https://github.com/Celasha/Toolasha/commit/22bf42e863fd66353c1249a1b0fd52dfa2f67b56))

### Bug Fixes

- raise dungeon tracker z-index to floating panel level when expanded ([b992489](https://github.com/Celasha/Toolasha/commit/b992489914ad7ced619dc01911302fd37687bbd1))
- use highest bid (last element) for top order price on buy listings ([9984e68](https://github.com/Celasha/Toolasha/commit/9984e6829b192d2b315227de80cce0e238d6abb7))

## [2.15.0](https://github.com/Celasha/Toolasha/compare/v2.14.0...v2.15.0) (2026-04-19)

### Features

- add budget calculator to production action panels ([9f22477](https://github.com/Celasha/Toolasha/commit/9f22477450ebdf00963becc2c3e191f47e75bde9))

## [2.14.0](https://github.com/Celasha/Toolasha/compare/v2.13.3...v2.14.0) (2026-04-19)

### Features

- add chat history extender to preserve evicted messages ([24a0a3b](https://github.com/Celasha/Toolasha/commit/24a0a3b86b0ab30ab8c31e814590a47559eab9ad))
- add customizable quick input presets for action panels ([7ed4ac1](https://github.com/Celasha/Toolasha/commit/7ed4ac1f198b2646a829e61a6e40992ada8f2a40))
- add option to hide Labyrinth ping badge in nav sidebar ([66c2ce7](https://github.com/Celasha/Toolasha/commit/66c2ce7257a827b6a49ea71f193defef5770db60))

### Bug Fixes

- preserve market listings expand state across net worth re-renders ([fd4b240](https://github.com/Celasha/Toolasha/commit/fd4b240b61d4c88a56f591b61fdebbdc8500a2d3))
- prevent negative count and focus input after View Action navigation ([1f2d448](https://github.com/Celasha/Toolasha/commit/1f2d448bc8e40e6e10da96d33d67e81485f4ba15))
- show limiting material icon in enhancing time display ([5851deb](https://github.com/Celasha/Toolasha/commit/5851deb9f829ee9294817622ac3bdfa8bd74d688))

## [2.13.3](https://github.com/Celasha/Toolasha/compare/v2.13.2...v2.13.3) (2026-04-18)

### Bug Fixes

- reconcile stale active listings against myMarketListings snapshots ([f4688b3](https://github.com/Celasha/Toolasha/commit/f4688b30d8ee37d4d567cd188d4f6c2c33393bf1))

## [2.13.2](https://github.com/Celasha/Toolasha/compare/v2.13.1...v2.13.2) (2026-04-18)

### Code Refactoring

- replace volatile target-based time with stable material time in enhancing display ([3165a39](https://github.com/Celasha/Toolasha/commit/3165a39429b981c772e742d0a26129f44e98deee))

## [2.13.1](https://github.com/Celasha/Toolasha/compare/v2.13.0...v2.13.1) (2026-04-18)

### Bug Fixes

- export correct ability levels and triggers for non-equipped loadout abilities ([60fafae](https://github.com/Celasha/Toolasha/commit/60fafae972c74a8baffcfa6c4de131aff1554c4c))
- guard against null characterItems in items_updated handler ([e6739c2](https://github.com/Celasha/Toolasha/commit/e6739c2eb5257513f3ba3addb10fde1a5d3086bf))
- lower dungeon tracker z-index below game countdown overlays ([12acb27](https://github.com/Celasha/Toolasha/commit/12acb27c2d0b6dfdbddec711abe2d48468ea660c))
- populate market listings breakdown in net worth calculator ([22e47fc](https://github.com/Celasha/Toolasha/commit/22e47fc2b5e4a84186f188e90ab8a9fc66f33243))
- use repeat count for enhancement missing mats when repeat is finite ([bb6a286](https://github.com/Celasha/Toolasha/commit/bb6a286e6c076883aa8bb9d3f5e972493b343033))

## [2.13.0](https://github.com/Celasha/Toolasha/compare/v2.12.1...v2.13.0) (2026-04-17)

### Features

- add material-based countdown timer for enhancement actions ([9c80cd7](https://github.com/Celasha/Toolasha/commit/9c80cd764e1028971dd6258a1566d18c65448b55))

### Bug Fixes

- detect marketplace navigation via CSS visibility instead of DOM mutations ([9b4f086](https://github.com/Celasha/Toolasha/commit/9b4f0863c7c3142637b0e19fa15089cd3b42a878))
- persist net worth chart range selection across sessions ([fe6b630](https://github.com/Celasha/Toolasha/commit/fe6b63081e3a09bf046ad4748ff9388000349c3d))

## [2.12.1](https://github.com/Celasha/Toolasha/compare/v2.12.0...v2.12.1) (2026-04-17)

### Bug Fixes

- add per-row delete button to market history ([a84dc6b](https://github.com/Celasha/Toolasha/commit/a84dc6bd4b6d35a1e5c42459855fa4483f39b71b))
- clear battle counter on combat exit and hide scroll sim for combat loadouts ([d8cd43a](https://github.com/Celasha/Toolasha/commit/d8cd43aa04c53322bbbbaac6cbfc42c255c231be))
- eliminate custom tab flicker when enhancing items ([482b9bc](https://github.com/Celasha/Toolasha/commit/482b9bc53847675674ea07f6d1d25e574ddbcc5d))
- resolve view action button failing for refined items ([4f8a972](https://github.com/Celasha/Toolasha/commit/4f8a972b9f6c6656e324803835e0e13ab0bbfe0f))

### Code Refactoring

- move combat sim loadout export from loadout page to score panel dropdown ([384741f](https://github.com/Celasha/Toolasha/commit/384741f6bbe5110eda7deba1a43a3cc4702f041a))

## [2.12.0](https://github.com/Celasha/Toolasha/compare/v2.11.0...v2.12.0) (2026-04-17)

### Features

- add battle/wave counter to combat action bar ([89471be](https://github.com/Celasha/Toolasha/commit/89471bef9395a5ace516b62edec3dad48fecc8b3))
- add per-loadout scroll simulation for profit/XP calculations ([49648bd](https://github.com/Celasha/Toolasha/commit/49648bd189eccf82b7105b4c913194fffb3381bd))

### Bug Fixes

- correct three row-matching bugs in My Listings price display ([aa7da12](https://github.com/Celasha/Toolasha/commit/aa7da1270c4d23a52ce811ced1da0a922b371b80))
- remove redundant quantity from coin line in net worth breakdown ([ea6d6c1](https://github.com/Celasha/Toolasha/commit/ea6d6c12f264ee24525f7330ea9a7821fd1d58e8))
- rename "Seal of" to "Scroll of" following game update ([ead6bf5](https://github.com/Celasha/Toolasha/commit/ead6bf5d92a7674a44b7a694d353f6836a5e8e53))
- update Milkonomy external link URL ([753658a](https://github.com/Celasha/Toolasha/commit/753658a7f642600d7bb0daf5cc0561092d768c1f))

## [2.11.0](https://github.com/Celasha/Toolasha/compare/v2.10.1...v2.11.0) (2026-04-16)

### Features

- add Claim Reward proxy button to task panel header ([0061b3e](https://github.com/Celasha/Toolasha/commit/0061b3ef59a22c30b3f30da86b9c1940ca03d2aa))
- generate Tib character sheet from a saved loadout snapshot ([b72d009](https://github.com/Celasha/Toolasha/commit/b72d0099d65632b20c147cd7935d4392be1e1f7b))

### Bug Fixes

- guard loadout enhancement overlays against mid-render and stale inventory ([ea1c9aa](https://github.com/Celasha/Toolasha/commit/ea1c9aaa83e24894371e03027d2fb37136649d89))
- populate XP/h columns on main player leaderboard ([0b2b684](https://github.com/Celasha/Toolasha/commit/0b2b6849d28665b2aca8bc7f6d09b0ac0c7bd360))
- show + prefix on net worth toggle from initial render ([0c18fe2](https://github.com/Celasha/Toolasha/commit/0c18fe2dfc73f8fc6cd37d6c14e25106161277db))
- show Coin as explicit line item in inventory breakdown ([d6b061f](https://github.com/Celasha/Toolasha/commit/d6b061fb8de1149005eedafb7cf33df8a7d31106))
- use direct index lookup for enhanced item order books in Top Order Price ([5d6ae04](https://github.com/Celasha/Toolasha/commit/5d6ae04b51f7bdf81af0c31de6d29bd3bc66e497))

## [2.10.1](https://github.com/Celasha/Toolasha/compare/v2.10.0...v2.10.1) (2026-04-15)

### Bug Fixes

- resolve exclusion chip names from game data instead of search list ([1e08a4b](https://github.com/Celasha/Toolasha/commit/1e08a4b9c97ed7f785c24086ce6817ed1880ed1e))

## [2.10.0](https://github.com/Celasha/Toolasha/compare/v2.9.2...v2.10.0) (2026-04-14)

### Features

- add Clear All button to exclusion popup and fix double-exclusion ([20ce818](https://github.com/Celasha/Toolasha/commit/20ce8182e18c725f8c04fd74210fcc050b4f3bb8))

### Bug Fixes

- exclude Coin from currency category grouping in net worth ([6ab4118](https://github.com/Celasha/Toolasha/commit/6ab41182bbac5c258e9c9ad4c0ce602f2c274b98))
- restore correct amounts for excluded items in exclusion popup ([84df111](https://github.com/Celasha/Toolasha/commit/84df111329513dae00d224ca995997710a6119e2))

### Styles

- center tab names and right-align count/value in custom tab headers ([7846de3](https://github.com/Celasha/Toolasha/commit/7846de3b05a39d3cfc12ab955a0f46bfa2f11392))

## [2.9.2](https://github.com/Celasha/Toolasha/compare/v2.9.1...v2.9.2) (2026-04-14)

### Bug Fixes

- add expandable detail view for multi-item exclusions ([65943bf](https://github.com/Celasha/Toolasha/commit/65943bfaa0034e9a5b1e3e141d0373179c71a7b8))

## [2.9.1](https://github.com/Celasha/Toolasha/compare/v2.9.0...v2.9.1) (2026-04-14)

### Bug Fixes

- eliminate blank padding on chart x-axis edges ([75d78d8](https://github.com/Celasha/Toolasha/commit/75d78d8df8efb67f34e8b051cbac44af6c15a09e))

### Performance Improvements

- avoid blocking on 3s debounced save in exclusion toggles ([9f1f957](https://github.com/Celasha/Toolasha/commit/9f1f9571b4332d8737f26ff28505730c76c2e78b))

## [2.9.0](https://github.com/Celasha/Toolasha/compare/v2.8.1...v2.9.0) (2026-04-14)

### Features

- add net worth exclusions and Non-Excluded history chart line ([90fe8d7](https://github.com/Celasha/Toolasha/commit/90fe8d73a64401c483e24f37d53d29346a99e9c9))

### Bug Fixes

- show wisdom tea on gold tab and gourmet tea on XP tab for cooking/brewing ([2a2f2bf](https://github.com/Celasha/Toolasha/commit/2a2f2bf80106b0b536d96491bf5ea2b654a5ff9f))

### Styles

- rename "Networth" to "Net Worth" in all user-facing text ([01d427e](https://github.com/Celasha/Toolasha/commit/01d427e18c6a6c27d17dac635f4d1acf4282dae6))

## [2.8.1](https://github.com/Celasha/Toolasha/compare/v2.8.0...v2.8.1) (2026-04-12)

### Bug Fixes

- make action panel display settings take effect without page reload ([c346437](https://github.com/Celasha/Toolasha/commit/c346437db308af221e4ec1115cec0e1c2f27b252))

## [2.8.0](https://github.com/Celasha/Toolasha/compare/v2.7.3...v2.8.0) (2026-04-12)

### Features

- add click-to-delete datapoints from networth history chart ([0dbaef6](https://github.com/Celasha/Toolasha/commit/0dbaef6fdb1fcde6269966a24a35bc25a1b4a198))
- add pin/ban tea constraints to tea recommendation popup ([8321ccf](https://github.com/Celasha/Toolasha/commit/8321ccfed5575ab5be2652f93bf7ef3a154a0685))

### Bug Fixes

- divide tooltip per-action profit by effective actions rate ([7b5f310](https://github.com/Celasha/Toolasha/commit/7b5f31070f956da0ccb2ea60e51fcb6ec516be1d))
- force full layout rebuild when inventory tile count changes ([ccaec79](https://github.com/Celasha/Toolasha/commit/ccaec79ff9b818b2b3bd6de45b05aacbeb58c91c))
- prevent duplicate action entries inflating queued material counts ([cfea250](https://github.com/Celasha/Toolasha/commit/cfea2504de2aae1577ffa4a4c4427bf7a43a4304))

## [2.7.3](https://github.com/Celasha/Toolasha/compare/v2.7.2...v2.7.3) (2026-04-12)

### Styles

- reduce inventory tab category header size for compactness ([4b61244](https://github.com/Celasha/Toolasha/commit/4b61244973f4be10e15386be3f3376553369d570))

## [2.7.2](https://github.com/Celasha/Toolasha/compare/v2.7.1...v2.7.2) (2026-04-12)

### Bug Fixes

- prevent duplicate reroll cost display for identical tasks ([07694ff](https://github.com/Celasha/Toolasha/commit/07694ffe5ba62b4ae74d26e06b2a80c87fdbc786))

## [2.7.1](https://github.com/Celasha/Toolasha/compare/v2.7.0...v2.7.1) (2026-04-11)

### Bug Fixes

- apply KMB formatting to Profit and Primary Outputs labels in action panel ([9e7a6e7](https://github.com/Celasha/Toolasha/commit/9e7a6e7758001a8442e8af43ec7c2a6fe53fedec))
- correct double-counted efficiency in production action totals ([0fc6738](https://github.com/Celasha/Toolasha/commit/0fc6738c2433b393f1e74ffb4a3d12d7727a8956))
- show average in parentheses alongside output range totals ([0d64bd2](https://github.com/Celasha/Toolasha/commit/0d64bd240142ff764a84f4d69126108b5d6a5e97))

### Performance Improvements

- debounce order books cache saves and evict stale entries on load ([d7fbecd](https://github.com/Celasha/Toolasha/commit/d7fbecd2210520a3ee2e06a135de675eacc05f42))

## [2.7.0](https://github.com/Celasha/Toolasha/compare/v2.6.2...v2.7.0) (2026-04-11)

### Features

- add custom price overrides for profit calculations ([93d7f77](https://github.com/Celasha/Toolasha/commit/93d7f775c3fa22cf12f066a4d886962a9f5ce7f3))
- use shop prices as cost floor for production material costs ([2cb98b0](https://github.com/Celasha/Toolasha/commit/2cb98b0795557bac8def675ecfa954f9441d099d))

### Code Refactoring

- unify price resolution and fix tooltip accuracy for refined items ([afb5510](https://github.com/Celasha/Toolasha/commit/afb55107e7a8e64a0f3276bf515cd9cccd22439a))

## [2.6.2](https://github.com/Celasha/Toolasha/compare/v2.6.1...v2.6.2) (2026-04-11)

### Bug Fixes

- handle ★ ↔ (R) refined item name resolution and skip profit for untradable items ([75f90d8](https://github.com/Celasha/Toolasha/commit/75f90d8835fae82d6ed8a8a4a8e330275abb8b92))

### Miscellaneous Chores

- remove diagnostic log from loadout snapshot rendering ([743d77d](https://github.com/Celasha/Toolasha/commit/743d77d93749aab37bf09cee1525d253dee8dac9))
- retrigger release-please ([fbe2842](https://github.com/Celasha/Toolasha/commit/fbe28424d91131197f80d056fe61180a5de52e6e))

## [2.6.1](https://github.com/Celasha/Toolasha/compare/v2.6.0...v2.6.1) (2026-04-11)

### Miscellaneous Chores

- format CHANGELOG.md after release-please update ([9d5ae7d](https://github.com/Celasha/Toolasha/commit/9d5ae7dce3a7ea091dc81b7b5cb17859bd61814c))

## [2.6.0](https://github.com/Celasha/Toolasha/compare/v2.5.1...v2.6.0) (2026-04-11)

### Features

- add "Filled or Active" status filter to market history ([48df8dc](https://github.com/Celasha/Toolasha/commit/48df8dcfb89b2ea8334f22aca70c489d50f0a7bc))
- show rolled-up value on collapsed custom inventory tab headers ([2ca8947](https://github.com/Celasha/Toolasha/commit/2ca8947f73e9e01dcab106e0f04ad641b6adea2c))

### Bug Fixes

- make custom tabs import apply layout immediately ([5e32ce2](https://github.com/Celasha/Toolasha/commit/5e32ce2012deb5ccd98874e3722bed40a36e8216))
- resolve loadout snapshots not showing in custom tab editor on production builds ([644043f](https://github.com/Celasha/Toolasha/commit/644043f8b6094574c4864dadceb3614a482cca08))
- show partially-filled cancelled orders as filled in market history ([d58697d](https://github.com/Celasha/Toolasha/commit/d58697dfef0397e0ccbd80f5e58023d01e97f6b9))

## [2.5.1](https://github.com/Celasha/Toolasha/compare/v2.5.0...v2.5.1) (2026-04-10)

### Bug Fixes

- allow time-till-level tooltip to work without XP/hr sidebar enabled ([368e2d0](https://github.com/Celasha/Toolasha/commit/368e2d044bb8acdf47baa156f14dcdb36121ad2e))
- disable collection filters and skilling badges when toggled off ([feb43ac](https://github.com/Celasha/Toolasha/commit/feb43acfa23398e09630a4311d9db8410c89273a))
- remove duplicate Iron Cow Mode checkbox from settings UI ([989ea99](https://github.com/Celasha/Toolasha/commit/989ea996cdb51fe184aa4e522e73e6355de835ce))
- restore task Go merge and queued indicator in Iron Cow mode ([cfb0959](https://github.com/Celasha/Toolasha/commit/cfb0959f9553fecf1dc1f6ca8ad3218f8405c003))

## [2.5.0](https://github.com/Celasha/Toolasha/compare/v2.4.0...v2.5.0) (2026-04-10)

### Features

- add line breaks and move-to-top to custom tab item editor ([9c6ce2c](https://github.com/Celasha/Toolasha/commit/9c6ce2ccdb5bd98c99861c65edf5fc7cc120ef0c))

## [2.4.0](https://github.com/Celasha/Toolasha/compare/v2.3.1...v2.4.0) (2026-04-10)

### Features

- pre-fill action count when navigating via "View Action" from missing materials ([ac40f58](https://github.com/Celasha/Toolasha/commit/ac40f58c14c0a136adbd8686925cef924e77d73a))
- show level gap and tooltip on Automations best-level badges ([140f827](https://github.com/Celasha/Toolasha/commit/140f82746bb4eb35891a4aa7a1b094f719cf6d61))

## [2.3.1](https://github.com/Celasha/Toolasha/compare/v2.3.0...v2.3.1) (2026-04-09)

### Code Refactoring

- move "add all items" toggle into tab editor ([4016d10](https://github.com/Celasha/Toolasha/commit/4016d104c1403d948ea076d275fbc00daf47bf65))

## [2.3.0](https://github.com/Celasha/Toolasha/compare/v2.2.2...v2.3.0) (2026-04-09)

### Features

- add configurable tile spacing setting for Toolasha tab ([eb39e5e](https://github.com/Celasha/Toolasha/commit/eb39e5e896b76ff5193f40a47b11da8203ddd900))

### Bug Fixes

- exclude collapsed-tab enhanced items from Unorganized bucket ([902ed44](https://github.com/Celasha/Toolasha/commit/902ed44fcd3a46f042c78d96ccc4f9f93e94539f))
- only show hidden-items warning when owned items are absent from DOM ([5e25f99](https://github.com/Celasha/Toolasha/commit/5e25f9960e2184e3f9281e5fac73ba065f7d6976))
- prevent concurrent layout calls and update layout on editor item changes ([1bacc33](https://github.com/Celasha/Toolasha/commit/1bacc33d98e358afb4da04675a20b6df741af50f))
- update Unorganized chevron immediately on toggle ([2845a25](https://github.com/Celasha/Toolasha/commit/2845a253994ec2f07c3c49da510d750e369238f7))

### Styles

- compact inventory panel header rows and unify button styles ([ca3e209](https://github.com/Celasha/Toolasha/commit/ca3e209b99bd0ada2187e655d3fa1bfdb43d66e9))

## [2.2.2](https://github.com/Celasha/Toolasha/compare/v2.2.1...v2.2.2) (2026-04-09)

### Bug Fixes

- remove ownership filter from item search; increase tab header color opacity ([8e64979](https://github.com/Celasha/Toolasha/commit/8e64979da78c566bfed11f546cbfb8b1bdaa337b))

## [2.2.1](https://github.com/Celasha/Toolasha/compare/v2.2.0...v2.2.1) (2026-04-09)

### Bug Fixes

- sort category items and category list by game sortIndex ([6057eff](https://github.com/Celasha/Toolasha/commit/6057effdf30efd65132e5bd2e6a3d833feacb087))

## [2.2.0](https://github.com/Celasha/Toolasha/compare/v2.1.0...v2.2.0) (2026-04-09)

### Features

- add "Add to Tab" button to item action menu ([53d8c27](https://github.com/Celasha/Toolasha/commit/53d8c279fb15f14f4c65172c2d59d15ab3f19f77))
- add "From Loadout" section in tab editor to bulk-add loadout items ([5061283](https://github.com/Celasha/Toolasha/commit/50612830d27250fd457665422faafe2a8a0e5b38))
- add color picker and hex input to custom tab color selector ([1b83c2c](https://github.com/Celasha/Toolasha/commit/1b83c2c52b6cd6e059248ab95f16c8a038e6b55c))
- add drag-and-drop item reordering in tab editor ([a9e5e60](https://github.com/Celasha/Toolasha/commit/a9e5e60fd699ca2539fae0071b1dd92b3482fbed))
- add export/import for custom inventory tab layouts ([8fcc6db](https://github.com/Celasha/Toolasha/commit/8fcc6db7b69c8eb93c4d33e6fa57f54581ef20c9))

### Bug Fixes

- pin tab editor footer buttons outside the scrollable modal body ([cfd2b7b](https://github.com/Celasha/Toolasha/commit/cfd2b7b31f2f5562cb4c929bd929d2b89ba76919))
- show summed badge value in custom tab section headers ([4bb15a2](https://github.com/Celasha/Toolasha/commit/4bb15a299dde6833765c95f488535f8b2f591b6d))
- show warning indicator when custom tab items are hidden by collapsed inventory category ([e6cc182](https://github.com/Celasha/Toolasha/commit/e6cc1829bdfd3afe9ed2a67e6544ce11657b6f05))
- sort Unorganized section by game sortIndex ([b3d97be](https://github.com/Celasha/Toolasha/commit/b3d97be8311366c4263fc468ef92670eae6af04b))
- support per-enhancement-level item assignment in custom tabs ([c1924b1](https://github.com/Celasha/Toolasha/commit/c1924b1cb65740421f24c16b3e123fda2c95c140))

### Code Refactoring

- move material tab click handler outside loop to fix no-loop-func lint warning ([cdb8fce](https://github.com/Celasha/Toolasha/commit/cdb8fcefd4fc81f58d55f6544d290451f1cd37b8))

### Styles

- fix Prettier formatting ([b56443b](https://github.com/Celasha/Toolasha/commit/b56443bcb43e073d2d95067322cacf1cb35d26e9))

## [2.1.0](https://github.com/Celasha/Toolasha/compare/v2.0.0...v2.1.0) (2026-04-08)

### Features

- add Clear All button and category remove in tab editor; fix layout order collision ([363120d](https://github.com/Celasha/Toolasha/commit/363120d96ff39ee3a421bfc6698678bdcf4b51e6))

### Bug Fixes

- re-sort custom tabs layout when inventory sort mode changes ([a44da6f](https://github.com/Celasha/Toolasha/commit/a44da6f71e2510c4750e50bcc08c6e87087f8b36))

## [2.0.0](https://github.com/Celasha/Toolasha/compare/v1.67.0...v2.0.0) (2026-04-08)

### ⚠ BREAKING CHANGES

- add Custom Inventory Tabs with drag-and-drop reordering

### Features

- add Custom Inventory Tabs with drag-and-drop reordering ([9d03ca5](https://github.com/Celasha/Toolasha/commit/9d03ca541b5e00470fb1f7610eff849d52fb13ce))

## [1.67.0](https://github.com/Celasha/Toolasha/compare/v1.66.0...v1.67.0) (2026-04-05)

### Features

- add "time to next tier" sort to Collections panel ([ae8d4a3](https://github.com/Celasha/Toolasha/commit/ae8d4a3a1e10a03b5367c7c07650f5870cb6c292))

### Code Refactoring

- decouple queue length estimator from estimated listing age ([2c38628](https://github.com/Celasha/Toolasha/commit/2c38628f45a20a2c7f7b3020af8e1a25e1c70129))
- move and rename combatStats_keyPricing to profitCalc_keyPricingMode ([6d2cbc5](https://github.com/Celasha/Toolasha/commit/6d2cbc56086c8c3c8f1facdb0d7a39b83b7b0323))

## [1.66.0](https://github.com/Celasha/Toolasha/compare/v1.65.5...v1.66.0) (2026-04-05)

### Features

- add Iron Cow mode to disable market and profit settings ([b0f038d](https://github.com/Celasha/Toolasha/commit/b0f038d5673b916e714d2f7d8d2d0647feb93437))

### Bug Fixes

- add mwilinks to external navigation links ([93b3dc8](https://github.com/Celasha/Toolasha/commit/93b3dc8146653c00e5ff96b93368a61fd3bf4e7a))

## [1.65.5](https://github.com/Celasha/Toolasha/compare/v1.65.4...v1.65.5) (2026-04-04)

### Bug Fixes

- restrict mirror path base item lookup to refined items only ([9b8853e](https://github.com/Celasha/Toolasha/commit/9b8853eb55f56e4204fde6815ff427809093f349))
- use same-item costs to determine mirror optimization trigger level ([187095a](https://github.com/Celasha/Toolasha/commit/187095a9ed73fec07917878bcfb6f29f23f4ef60))

## [1.65.4](https://github.com/Celasha/Toolasha/compare/v1.65.3...v1.65.4) (2026-04-04)

### Bug Fixes

- revert erroneous refined item exclusion from protection pricing ([9a3aa6a](https://github.com/Celasha/Toolasha/commit/9a3aa6a09900fb1a2116949c540adb5ebaa66aac))

## [1.65.3](https://github.com/Celasha/Toolasha/compare/v1.65.2...v1.65.3) (2026-04-04)

### Bug Fixes

- exclude refined items from enhancement protection and mirror path costs ([214b050](https://github.com/Celasha/Toolasha/commit/214b050086b7aad671d9e4c02b726c884627031f))
- skip dedup for actions_updated to process isDone:true removals ([08b38c4](https://github.com/Celasha/Toolasha/commit/08b38c4d9981ecb37b9fbc97b6563fec9e061bb1))

## [1.65.2](https://github.com/Celasha/Toolasha/compare/v1.65.1...v1.65.2) (2026-04-02)

### Bug Fixes

- break enhancement panel mutation watcher feedback loop ([ac534cb](https://github.com/Celasha/Toolasha/commit/ac534cbf87ca9d2284948c7d0b8539ba8e343fb8))

## [1.65.1](https://github.com/Celasha/Toolasha/compare/v1.65.0...v1.65.1) (2026-04-02)

### Bug Fixes

- autofill missing mats quantity from live inventory on each buy modal ([4bbb2c2](https://github.com/Celasha/Toolasha/commit/4bbb2c2b52444d455b448eef9c628936f788ea2e))

## [1.65.0](https://github.com/Celasha/Toolasha/compare/v1.64.0...v1.65.0) (2026-04-02)

### Features

- add option to pin item tooltips to top-center of screen ([41bfee3](https://github.com/Celasha/Toolasha/commit/41bfee35a540d058a793ff2eb3c693481bdfed40))

## [1.64.0](https://github.com/Celasha/Toolasha/compare/v1.63.1...v1.64.0) (2026-04-02)

### Features

- add expandable chest rows in net worth inventory panel ([7e2f171](https://github.com/Celasha/Toolasha/commit/7e2f171a1f96597738a606560d4c44d9586aeee4))
- deduct chest key cost from dungeon chest EV in net worth and tooltips ([2d8609f](https://github.com/Celasha/Toolasha/commit/2d8609f6c3a30393f5ddc77728f5ac565745700b))

### Code Refactoring

- eliminate top 5 duplications across profit and market modules ([25cd3d0](https://github.com/Celasha/Toolasha/commit/25cd3d0360b1381030b51f9d8c8f967815177467))

## [1.63.1](https://github.com/Celasha/Toolasha/compare/v1.63.0...v1.63.1) (2026-04-01)

### Bug Fixes

- update alchemy profit display to reflect live catalyst selection ([0282ef7](https://github.com/Celasha/Toolasha/commit/0282ef7f8159edde043de99d6369124eb070351c))

## [1.63.0](https://github.com/Celasha/Toolasha/compare/v1.62.0...v1.63.0) (2026-04-01)

### Features

- add pricing mode naming convention setting ([36efea9](https://github.com/Celasha/Toolasha/commit/36efea9e516d4f37093fcad99e866f1b45838e81))

## [1.62.0](https://github.com/Celasha/Toolasha/compare/v1.61.1...v1.62.0) (2026-03-31)

### Features

- add Buy on Marketplace button to ability book calculator ([154c59a](https://github.com/Celasha/Toolasha/commit/154c59aad4014a5f7838f340f812382606626048))

### Bug Fixes

- split collection filter 10k+ into 10k-100k and 100k+ ([4f824a8](https://github.com/Celasha/Toolasha/commit/4f824a8d69074bba956f940b119427ed6758cc5b))

## [1.61.1](https://github.com/Celasha/Toolasha/compare/v1.61.0...v1.61.1) (2026-03-30)

### Bug Fixes

- include coin costs in crafting cost calculation ([121c021](https://github.com/Celasha/Toolasha/commit/121c021c2af40156830d33e2d47fee1ad5f9cd13))

## [1.61.0](https://github.com/Celasha/Toolasha/compare/v1.60.5...v1.61.0) (2026-03-30)

### Features

- store character gameMode in dataManager ([20801e3](https://github.com/Celasha/Toolasha/commit/20801e39d696c33ccb0902ea2401507c14395e05))

### Bug Fixes

- harden dungeon tracker scrubbing, debounce, and deduplication ([1003dc9](https://github.com/Celasha/Toolasha/commit/1003dc93e4bda4b42a0c2878af370946f1f12507))
- use border-right on chart bars to ensure visible separator ([8103197](https://github.com/Celasha/Toolasha/commit/8103197de1431dff3e1d68c2107a788e1e4e1d25))

## [1.60.5](https://github.com/Celasha/Toolasha/compare/v1.60.4...v1.60.5) (2026-03-29)

### Bug Fixes

- color task profit and efficiency rating by profit/loss ([9fcc247](https://github.com/Celasha/Toolasha/commit/9fcc2470ef7196980f8e1b5d20ea110b6d1c3db6))

## [1.60.4](https://github.com/Celasha/Toolasha/compare/v1.60.3...v1.60.4) (2026-03-29)

### Bug Fixes

- apply collection filters when catsEl is replaced on first load ([ea94ec8](https://github.com/Celasha/Toolasha/commit/ea94ec8b34ea530a2ce84052a57813cec1b63c4c))
- use KMB formatting for task efficiency rating value ([3ea9090](https://github.com/Celasha/Toolasha/commit/3ea9090c8138edf6016d358e03636c8c0f444cef))

## [1.60.3](https://github.com/Celasha/Toolasha/compare/v1.60.2...v1.60.3) (2026-03-29)

### Bug Fixes

- correct per-action and N-actions breakdowns to handle efficiency consistently ([9e1b7d1](https://github.com/Celasha/Toolasha/commit/9e1b7d1bf80f80028c6af26d676489f12f157d96))

### Code Refactoring

- make ask the sole driver for base item crafting cost in enhancement path ([4326459](https://github.com/Celasha/Toolasha/commit/43264595aa1ae912dc107285c5b02f4a047865f7))
- rename pricing modes to Buy/Sell ask/bid labels throughout UI ([d0e94b0](https://github.com/Celasha/Toolasha/commit/d0e94b0e0e04c23af4d8ed1f487a1b88ae85eb7a))

## [1.60.2](https://github.com/Celasha/Toolasha/compare/v1.60.1...v1.60.2) (2026-03-29)

### Bug Fixes

- fall back to production cost when only ask or bid is missing in crafting path tooltip ([8c4e7ba](https://github.com/Celasha/Toolasha/commit/8c4e7ba29510d131d301e9afc049f843455efb4b))

## [1.60.1](https://github.com/Celasha/Toolasha/compare/v1.60.0...v1.60.1) (2026-03-29)

### Bug Fixes

- fix config shadowing and add crafting cost option for enhancement path base item ([f37b621](https://github.com/Celasha/Toolasha/commit/f37b621f3cfe78ea5e69b27aef20fe42bc0bc48f))

## [1.60.0](https://github.com/Celasha/Toolasha/compare/v1.59.2...v1.60.0) (2026-03-29)

### Features

- add setting to use crafting cost for base item in enhancement path ([4c975c5](https://github.com/Celasha/Toolasha/commit/4c975c5b2171fa82f825f979ad7b5447c9b3e364))

## [1.59.2](https://github.com/Celasha/Toolasha/compare/v1.59.1...v1.59.2) (2026-03-29)

### Miscellaneous Chores

- trigger release-please regeneration ([c1de77f](https://github.com/Celasha/Toolasha/commit/c1de77f69ceb14df919aec18198e9450e7f29741))

## [1.59.1](https://github.com/Celasha/Toolasha/compare/v1.59.0...v1.59.1) (2026-03-29)

### Bug Fixes

- prevent Show Uncollected toggle from getting stuck checked ([e39cd66](https://github.com/Celasha/Toolasha/commit/e39cd66a2c8be82499d22adc0ad192ccb6923a90))

## [1.59.0](https://github.com/Celasha/Toolasha/compare/v1.58.0...v1.59.0) (2026-03-29)

### Features

- add sort by items/gold cost to next tier in collection filters ([e216160](https://github.com/Celasha/Toolasha/commit/e216160c1e8aafac779b46f572e2c286243a201a))

## [1.58.0](https://github.com/Celasha/Toolasha/compare/v1.57.1...v1.58.0) (2026-03-29)

### Features

- add Collection Filters feature ([6802499](https://github.com/Celasha/Toolasha/commit/6802499e9a1e58cbae77ba0e99973fc93f0983ef))

## [1.57.1](https://github.com/Celasha/Toolasha/compare/v1.57.0...v1.57.1) (2026-03-28)

### Bug Fixes

- fall back to production cost for unpriced crafting materials ([c2f575c](https://github.com/Celasha/Toolasha/commit/c2f575c914b0f6ce1e8dadef6d87098116989c2f))

### Code Refactoring

- make Philosopher's Mirror color configurable ([1c21e2b](https://github.com/Celasha/Toolasha/commit/1c21e2b5dec49ade06da844140eee1d136d96f2d))

## [1.57.0](https://github.com/Celasha/Toolasha/compare/v1.56.0...v1.57.0) (2026-03-28)

### Features

- improve networth history chart with category lines and UX fixes ([8e8c4c4](https://github.com/Celasha/Toolasha/commit/8e8c4c4480e8de0389ee347d3722e75068852546))

## [1.56.0](https://github.com/Celasha/Toolasha/compare/v1.55.1...v1.56.0) (2026-03-28)

### Features

- show per-category rate stats in networth history chart stats row ([a48db9b](https://github.com/Celasha/Toolasha/commit/a48db9b1de27f5254b3731958dde526ae95db17e))

## [1.55.1](https://github.com/Celasha/Toolasha/compare/v1.55.0...v1.55.1) (2026-03-28)

### Bug Fixes

- use dynamic artisan tea and correct pricing mode in base item production cost ([163ee28](https://github.com/Celasha/Toolasha/commit/163ee2816eee84611adc80b72522ea2338941ade))
- use KMB formatting for all coin and profit values ([b59f25b](https://github.com/Celasha/Toolasha/commit/b59f25bb77f3c42b176f4abd946da73fb92ad243))

## [1.55.0](https://github.com/Celasha/Toolasha/compare/v1.54.0...v1.55.0) (2026-03-28)

### Features

- add per-category line toggles to networth history chart ([230e870](https://github.com/Celasha/Toolasha/commit/230e8700291f1df28fec450ae101067fa12125d0))

### Bug Fixes

- show correct session number in tracker header on load ([c4c6147](https://github.com/Celasha/Toolasha/commit/c4c6147d2bb1319c699e7ddfad8c49916eaacdeb))

## [1.54.0](https://github.com/Celasha/Toolasha/compare/v1.53.3...v1.54.0) (2026-03-28)

### Features

- sort completed tasks to top when using Sort Tasks button ([d72f308](https://github.com/Celasha/Toolasha/commit/d72f308f6d9d7475204129f13b56b0a0458402cb))

### Bug Fixes

- clean up tooltip display when output item has no market data ([6ab8509](https://github.com/Celasha/Toolasha/commit/6ab8509c793aa847989c52cfeda8b5700677707f))
- exclude enhanced items from material requirement inventory count ([dcf8de0](https://github.com/Celasha/Toolasha/commit/dcf8de07d4074a33c756206d38800a25734f8371))

## [1.53.3](https://github.com/Celasha/Toolasha/compare/v1.53.2...v1.53.3) (2026-03-28)

### Bug Fixes

- remove efficiency multiplier from per-action material cost display ([3e4178b](https://github.com/Celasha/Toolasha/commit/3e4178bed6df6b90225a190fb8e5b1b4c00e5df5))
- reserve upgrade item from input count when same item is used for both ([0021e22](https://github.com/Celasha/Toolasha/commit/0021e2294aed9d1030be242c59d797ebd05a1c89))

## [1.53.2](https://github.com/Celasha/Toolasha/compare/v1.53.1...v1.53.2) (2026-03-27)

### Bug Fixes

- apply disabledBy state after settings panel is in the document ([63798a6](https://github.com/Celasha/Toolasha/commit/63798a6a8e28dfc381bacdc4d2670b194194b3c2))

## [1.53.1](https://github.com/Celasha/Toolasha/compare/v1.53.0...v1.53.1) (2026-03-27)

### Bug Fixes

- default enhancement tracker to latest session on load ([7234db4](https://github.com/Celasha/Toolasha/commit/7234db49b40571f4805fde09317f92aa52dc27f2))
- read disabledBy state from currentSettings on panel open ([b32e488](https://github.com/Celasha/Toolasha/commit/b32e488e5b4a0dac12e4463e2bfbbf7e2643c734))

### Miscellaneous Chores

- add [@icon](https://github.com/icon) to userscript header ([b7179de](https://github.com/Celasha/Toolasha/commit/b7179de276c9ce9c200d96a7f4614a876a948378))

## [1.53.0](https://github.com/Celasha/Toolasha/compare/v1.52.0...v1.53.0) (2026-03-27)

### Features

- add loadout snapshot system for accurate profit calculations ([149fcbe](https://github.com/Celasha/Toolasha/commit/149fcbe0fc9960bfb3431083bec8cb3e84b4bf11))

## [1.52.0](https://github.com/Celasha/Toolasha/compare/v1.51.1...v1.52.0) (2026-03-26)

### Features

- add profit mode toggle button to action panel title bar ([0c4b4ba](https://github.com/Celasha/Toolasha/commit/0c4b4baa3b8a67bc262cedb0ef0bff7c39deaa65))

### Miscellaneous Chores

- **main:** release 1.51.1 ([778e102](https://github.com/Celasha/Toolasha/commit/778e102222e28216396ec4915ab76d417ae9255d))
- sync version and format release notes ([461f1a5](https://github.com/Celasha/Toolasha/commit/461f1a5f4367b4474d39cf7a88c5f34e4383c37a))
- trigger release-please re-run ([77644bc](https://github.com/Celasha/Toolasha/commit/77644bc1af7a4c8b26279910d9fd64195235fa48))
- trigger release-please re-run after tag fix ([8d68a42](https://github.com/Celasha/Toolasha/commit/8d68a426569a692b0a5eceeacfa8b8637d009645))
- trim CHANGELOG to last 10 releases ([1f6958e](https://github.com/Celasha/Toolasha/commit/1f6958ee6a8ae74f6189ab11001c60b3e9d40065))

## [1.51.1](https://github.com/Celasha/Toolasha/compare/v1.51.0...v1.51.1) (2026-03-26)

### Bug Fixes

- call disable() on all features during character switch ([20b89ae](https://github.com/Celasha/Toolasha/commit/20b89aedbd5f133d656eb33d3e4caff3f68f8831))

## [1.51.0](https://github.com/Celasha/Toolasha/compare/v1.50.0...v1.51.0) (2026-03-26)

### Features

- add ask/bid prices to Labyrinth Shop tab ([04f91d6](https://github.com/Celasha/Toolasha/commit/04f91d621ab13c314b151005b3226ddfff7b9ceb))

## [1.50.0](https://github.com/Celasha/Toolasha/compare/v1.49.5...v1.50.0) (2026-03-26)

### Features

- add Materials tab to pinned actions page ([286691c](https://github.com/Celasha/Toolasha/commit/286691c1c2833532d661aa665da2e05243796f9e))
- add z-index tier system and bring-to-front for floating panels ([644aef3](https://github.com/Celasha/Toolasha/commit/644aef32c65304c7e39a68a25a914184599626f6))

## [1.49.5](https://github.com/Celasha/Toolasha/compare/v1.49.4...v1.49.5) (2026-03-25)

### Bug Fixes

- correct milkonomy export equipment handling for non-self profiles ([71c1bf2](https://github.com/Celasha/Toolasha/commit/71c1bf286a1953507969fab24d76aa9ac21c96b3))

## [1.49.4](https://github.com/Celasha/Toolasha/compare/v1.49.3...v1.49.4) (2026-03-25)

### Bug Fixes

- always include enhanceLevel in milkonomy export for other profiles ([5a76675](https://github.com/Celasha/Toolasha/commit/5a76675b651002acf9007ca10ce04f6314f7f6a2))

## [1.49.3](https://github.com/Celasha/Toolasha/compare/v1.49.2...v1.49.3) (2026-03-25)

### Bug Fixes

- improve missing mats accuracy and enhancement display polish ([c363b42](https://github.com/Celasha/Toolasha/commit/c363b424da880a5d3fea2d8a92a89c79df32dca0))
- persist collapsed state of settings groups ([6cb7304](https://github.com/Celasha/Toolasha/commit/6cb730455939fb36e66552ef24538ba45e1e772e))

## [1.49.2](https://github.com/Celasha/Toolasha/compare/v1.49.1...v1.49.2) (2026-03-25)

### Code Refactoring

- convert enhancement tooltip costs to table format ([e2cacc2](https://github.com/Celasha/Toolasha/commit/e2cacc23c24bdb4a9f0fcf8470e67750205772d8))

## [1.49.1](https://github.com/Celasha/Toolasha/compare/v1.49.0...v1.49.1) (2026-03-25)

### Bug Fixes

- use tooltip color settings for enhancement total cost ([5c8a1f6](https://github.com/Celasha/Toolasha/commit/5c8a1f694b5c7783e542e7f0a9349d674fd19e30))

## [1.49.0](https://github.com/Celasha/Toolasha/compare/v1.48.1...v1.49.0) (2026-03-25)

### Features

- add missing mats marketplace button to enhancement panels ([ba55e1a](https://github.com/Celasha/Toolasha/commit/ba55e1aeda0aaae5168e3bff1f906142277825ac))

---

_Older entries have been trimmed. Full history is available in the [git log](https://github.com/Celasha/Toolasha/commits/main)._
