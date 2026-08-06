This is the **Millennium44 fork of Toolasha**. It folds MWI Combat Suite into Toolasha — live DPS tracking, loot and drop tracking, drop-luck analysis, and a full labyrinth simulator — so one script gives you both halves of the game instead of two userscripts.

### Combat & simulators

- Live DPS, hit/crit rate, damage-taken and net-sustain read off your own fights.
- Loot and drop tracking with drop-luck analysis that judges combat, gathering and production.
- A combat recorder: record real fights, replay them against the simulator, get a verdict with honest noise bands.
- A combat simulator whose upgrade picks are costed and ranked on real market and credit costs.
- Per-character combat stats, sim state and histories — no character reads another's books.

### Market & profit

- One market price API prices almost everything: upgrades, net worth, drop income, guild tokens, every action.
- Prices capped by the volume the market has actually absorbed, so thin markets stop inflating rankings.
- Profit lines on the action bar, pinned pages, alchemy rankings and the combat profit panel.
- Market-history viewer with a live undercut alert that re-checks against a refreshed snapshot.
- An upgrade advisor that costs and ranks gear and ability candidates against live prices.

### Labyrinth

- A labyrinth simulator with auto-pathing and auto-beaconing planned from the actual run.
- Multi-target analysis with combined armour swaps and supply-aware torch/shroud/beacon planning.
- Skilling-sim candidates scoped to the skill you are simming, with the skip level set for you.
- Upgrade, All-Fights and Skilling analyses, each exportable to CSV.

### Guild

- Live trial measurement: per-player DPS and damage/healing attribution from the fight you watch.
- Tier read straight off the boss bar, with pace, ETA and payout maths.
- A trial report your guild can actually read, with honest coverage caveats.

### Quality of life

- A curated overlay of tiles with bundled presets, activity auto-switching, and tiles that open their panels.
- A Ctrl+K (Cmd+K) command palette over every panel, overlay row, saved layout and setting.
- Mobile-friendly panels: viewport clamping, reachable close buttons, finger-sized targets, a floating launcher.
- Notifications for empty queues, community-buff expiry, and finished labyrinth runs.
- Task tools: measured tokens/hour, net task income, and reroll handling that takes the free MooPass reroll.
- Equipment Savings ("eWatch"): savings goals for gear and ability levels, fed from the simulators.
- A goal planner that turns "get me X gold / level N" into a ranked plan from your real measured rates.

### Data & sync

- Cross-device sync of your whole database through one private GitHub gist you own.
- Gzip-compressed, optionally AES-256 encrypted, conflict-aware, guarded against overwriting a year of data.
- Chunked per-period history that survives months, with honest quota handling and per-character backups.
- Hundreds of bug fixes and a test suite grown from ~2,300 to over 8,500 tests.
