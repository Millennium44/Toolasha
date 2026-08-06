# Changelog

## Fork Changelog (Millennium44/Toolasha)

All changes to this fork since diverging from upstream (Celasha/Toolasha at v2.84.0, commit `77e9ddb`). Newest first. Every pushed change must be recorded here in the same commit that makes it. Upstream release history is preserved below.

## Unreleased — branch `claude/mcs-ingest`

### Live combat learns seven more things, each its own switch

- **Enemy tiles answer the questions a fight actually asks** (all optional, all default on, riding the Portrait DPS toggle): "dead ~8s" from remaining HP over the party's measured rate on that enemy; one "wave ~19s" countdown on the topmost tile summing the living wave (voided honestly if any enemy's HP is unknown); a red "hits for 210/s" — the enemy's own outgoing damage, which answers "can I show DPS for enemies" with a measurement; and "enrage 1:42" counting down where the monster's sheet carries a timer, amber under thirty seconds.
- **Player meters carry survival, not just output**: "taken 220/s · net −35/s" (red when bleeding), "94% hit · 31% crit" once twenty swings back it, and "mana ~40s" only when actually draining toward empty within the minute — measured net of refills over a rolling window, because the mana tracker's per-cast costs are a different question.
- **The dungeon tracker paces the run**: "pace +6% vs your avg" against your stored runs of the same dungeon and tier, only after three completed waves, colored by which way it's going.
- The equal-height rule holds throughout: any line one tile has earned renders dashed on the rest, so the party frames never shuffle. Attribution stays honest — a hit that could belong to either of two identical monsters counts in the session total and shows on neither tile.

### The portrait meters stop jostling the party

- **Every player's DPS meter is two lines, always** — the current-fight line is reserved and reads "— cur" until that player acts, instead of appearing when they do. Five portraits used to sit at three different heights and re-shuffle at every fight boundary; now the frames hold still.

### Every player name opens a profile, and the dungeon knows its worth

- **Player names are clickable wherever a dungeon shows them**: the key-counts chat line, the party system messages ("has joined", "has left", "is ready", "is not ready" — end-anchored, so the phrase mid-sentence never matches), the run history's team headers (a name click doesn't toggle the group), and the overlay DPS rows (double-click still opens the panel). One click fills `/profile <name>` in chat, ready to send — the same trick the guild cycler uses, now a shared util.
- **Your measured treasure rate can price your chests** (default off): with the new setting on, dungeon profit estimates value the regular chest at your own treasure rate — what your recorded openings actually returned against the drop table's expectation, both at today's prices, straight from the treasure tracker's ledger. Never silently (every adjusted figure carries a `*` and names the measurement: "Chimerical Chest EV adjusted by your measured −7.4% return (5,490 opened)"), never on thin evidence (under 300 openings the estimate stays unadjusted), and never beyond scope (refinement chests, net worth, and tooltips keep the table value). First shipped reading chest-drop *counts* instead — corrected the same day to the opening ledger, which is what "my treasure rate" meant.
- **A dungeon run's first minutes stop screaming red**: until the first chest drops, the profit tile dims instead of alarming and says "no chest yet" — keys are charged when chests drop and revenue arrives the same way, so the early loss is consumable burn, not a verdict.
- **The profit panel compares the dungeon to your best solo zone**: a "vs best solo (sim)" line under the per-player card, from the last all-zones sim run — named, dated, and marked simulated, so a measured number never stands beside an unmarked guess.

### A canceled battle start is not a run

- **The dungeon tracker no longer records phantom runs from failed ready-checks.** The game posts "Key counts" and then "Battle ended" a second apart when a start is canceled; the tracker heard the first and not the second, so the canceled start stayed armed as a run's beginning and the next key count — minutes of party-forming later — read as its completion (one recorded "15:47 run" was two canceled starts with a member swap in between). A Battle-ended message now disarms any run with zero waves completed; fights with waves banked stay with the action feed, which already tells an early exit from a completion.

### Hybrid attribution: thorns and DoT damage go to their owners

- **The damage attribution learned what the party recording proved**: the server groups each battle tick by actor, so a lone player in a tick owns its damage — their reflect when the monster struck them in the same breath, their damage-over-time effect when nothing about them moved at all. The counter rungs stay first (they carry misses, crits and the per-ability split), the "last swinger" fallback now only catches multi-player ticks nothing can split, and a mana drop must be unique to name a caster. Replaying the five-player recording that exposed it: misattributed damage falls from 22,789 (5.7%, stolen from the tank and the DoT caster) to zero — 100% of counter-decidable damage lands on the right row.
- **The trial scoreboard measures every player now, not just you.** The spectated stream runs through the same attribution, so a watched trial fills a measured per-player damage table for all thirty — the boss's own counters gate the hits and mark the crits for everybody, and your own unit's counters confirm its rows directly. The "no attack counters, split estimated from builds" era is over; captions across the trial panel, scoreboard and report now say so. The 1,405-health tick the module once refused as unattributable is credited for what it was: the tank's thorns.

### Party lint ignores tools, and ability books answer three more questions

- **Tool slots are exempt from the skilling-gear warning** — a Holy Alembic has no combat equivalent and displaces nothing; the lint now only flags skilling pieces sitting in real combat slots.
- **The ability book tooltip now answers what you'd actually ask holding one**: which saved loadouts slot the ability (by name — the "can I coinify these" check), what level the books on hand would reach ("Books held: 7 → Lv 39"), and what the level already reached would cost to buy fresh today, in books and coin.

### The sim summary reads in the units a player plans in

- **XP/day → XP/hr** — the same unit the XP section and every zone ranking already use, so the tile reads against them directly. **Dungeons/hr → Avg clear** — the pace a session is planned around is how long one run takes, not a fractional rate. Success, Profit/day and Deaths/day stay as they were.
- **A loaded party gets linted before its numbers are read**: an amber block right under the Summary calls out members wearing skilling gear ("Mazo has skilling gear equipped: Foraging Shears" — detected from the item's own stats, so hybrid pieces are never flagged) and duplicated auras ("Fierce Aura is equipped by Irokez and Tib — auras do not stack" — detected from the ability data's party-wide buff shape, not a name list). Solo runs are never linted, and the warnings travel with each history entry.

### Entry keys are consumables, and chests point at their keys

- **The consumables tracker now carries the dungeon's entry key** for the tracked character: held count from inventory, per-day burn measured from the session's own chest drops (one key per regular chest — the same arithmetic the combat stats price keys with), two-sided cost/day, buy-for-target and a "lasts" countdown, competing for the limiting-consumable highlight like any coffee. Outside a dungeon, or before the first chest has dropped, the panel is honest: no row, or a row with "—" rates and the held count.
- **Keyed chests offer their key**: the chest popup ("Open 0 (Keys: 0)") gains a "Buy Keys on Marketplace" button that jumps straight to the key's listing — driven by the game data (an item whose `_key` sibling exists), so every keyed chest gets it and nothing else does.

### Ability book counts respect the experience already earned

- **The Upgrade tab priced every ability level-up from the floor of its current level**, re-buying the books already read: an ability 57% into its level was quoted a level's worth of extra books (Berserk 65→70 read 140.6M where the true remainder was 128.5M — the Ability Books panel had it right all along). Level-ups now price from the equipped ability's live experience, exactly as swaps already priced from the owned book's, and the ranking, repay time, and every Gold/0.01% column tighten with it. The floor remains the fallback for a book with no experience recorded or one that disagrees about its level.

### An attribution referee, ahead of any verdict on the presence method

- **`npm run compare <recording.json>` replays a combat recording through two attribution methods side by side**: Toolasha's counter-pairing engine and a faithful reimplementation of KikiMeter's presence method (being in `pMap` is the attribution; ambiguous ticks split equally). Totals can never separate them — both conserve the team total by construction — so every disagreement tick is adjudicated from signals neither verdict used: a credited player who provably swung confirms their method, a credited player who was only being hit refutes it, and bleed ticks are set apart as unarbitrable. The report also tests the presence method's foundational claim directly — on every tick where a hit landed, was a provable swinger actually present? Accepts Toolasha combat recordings, sim-accuracy exports (the segments carry the raw payloads), and raw websocket captures alike. Analysis tooling only; nothing in the userscript changes.

### Departed members stop haunting the roster

- **A member who left the guild no longer sits in "Gone quiet" forever**: the roster walked the XP _history_ — every character ever sampled, never pruned — so someone who left kept their weekly rate, earned nothing (being gone), and read as permanently idle, headed by a bare "#9349" since their name left with them. The current member list now decides who gets a row; history is consulted only for people on it; an empty list means "not known yet", not "nobody's here". Stored history self-heals on login (an early or empty roster message prunes nothing — a message that arrived early must not delete the guild), live roster messages shed departures only when they carry most of the known guild, and a member the roster doesn't name renders as "Unnamed member", never a numeric tag.

### The wire speaks: five trial message types the game was sending all along

- **`new_guild_battle` fires at every tier and states everything** this feature spent three rounds inferring: the full roster with names (the tick indexes map straight into it — 30 of 30 named, no placeholders), the tier boundary (baselines drop on the stated boundary, and exact per-tier durations record), the encounter (from the monster hrids, no fight view needed), and the tier-scaled boss sheet filed automatically — which confirms the HP rule on arrival: 330,000 × 1.30 = 429,000 with 30 players.
- **Your own damage is measured** — the game streams action counters for your own character only, and the scoreboard now says so per row: your figure is real, the rest of the party stays estimated from builds.
- **Skilling goes socket-fed**: `guild_skilling_updated` carries the pool (76,000 × 1.17 = 88,920, the rule again), the stated tier, participation by character ID, and your personal success rate/efficiency/action time — recorded per tier with no DOM footer needed. Cards the game draws a bar on keep their own numbers.
- **The game announces trial ends**: `end_guild_skilling` states the final banked tier outright (9 while 10 was running — confirming the semantics this feature reasoned its way to), `end_guild_battle` marks the combat hour's end, and the recorder treats the hour as done only when every card on screen has been declared over.
- All five types join the dedup skip-list — the skilling tick's first 100 characters end exactly where its progress figure begins, so an hour would have collapsed to one tick. Whether these messages are broadcast or view-scoped is unknowable from the capture, so each is a bonus signal and every DOM path remains as fallback. The recording's roster, ticks, and end messages are fixtured verbatim.

### Mixed-bonus cards contribute their true base to the token sum

- A card banked across a Builder's Hall upgrade divides cleanly by neither bonus, so its base points now come from the exact ladder (1,100 at T10) instead of the slightly-low division (1,091) — the token estimate gains the difference, the card's own Guild Points figure stays authoritative, and the sourcing note names the second cause. Treasury needs no such handling — tokens pay once at the round's end against the summed base, one moment, one level — with the one untestable assumption (payout-time vs round-start snapshot) documented rather than guessed at.

### The notice board is not a trial, and the ladders are theorems now

- **A guild notice board can no longer become a trial tile**: an older build had stored one guild's entire welcome notice — braille art, Discord links and all — as a "skilling trial", with the Discord channel IDs read as pool bars and the Overview stats attached as personal figures. Names now must be one short line before any matching, readings must be plausible (a nineteen-digit channel ID is not a progress bar; an 8.4M boss bar is), personal stats and the recorder only consume real tiles, and stored records self-heal on load — history included, since an archived notice board is a payout error a week later. The exact 987-character string is a fixture.
- **Both points ladders are exact and locked**: skilling cumulative base = 100×(tier+1), combat = 200×(tier+1) — verified against ten observations across three guilds and three Builder's Hall levels. And the one apparent exception dissolved into a discovery: **points bank live at the bonus in effect per tier**, so a Builder's Hall upgrade mid-trial makes the total a mixture of two bonuses (the user's three high-tier cards decompose exactly: 500×1.10 + 600×1.12 = 1,222). A stated total inside that upgrade envelope gets a calm explanatory note instead of a warning; outside it, the genuine warning stands. The game's stated figures still win for payout, as ever.

### The watched fight knows its own name, and a wipe is an outcome

- **The spectated stream attaches to the encounter being watched, and only that one**: the Chameleon fight's pool had been injected into the Hedgehog card (both barless, both claimed it) and the report narrated the wrong trial. Identity now travels with the stream — the fight view's own boss tile first, a clicked boss sheet second — is dropped on a new battle and kept across tier changes, and an unidentified pool is claimed by _no_ card ("click the boss to identify") rather than all of them. The report context is rank-gated the same way.
- **The cycler only offers people in the fight's own subtree** (anchored by the boss's "Trial …" name — the skilling panel beside it draws members too, and those boxes are inert; that's how someone off foraging got offered mid-fight), and **dead units are clicked like anyone else** — death hides nothing; a unit without abilities simply has none.
- **Per-tier personal stats actually record now**: the footer only ever attached to a card with a live bar (none exists between tiers or after the hour) and the tier join rode a live-only field — both fixed, so the success-decline model gets its per-tier inputs next trial.
- **The stats reader no longer swallows session logs**: "59m": "5s" pairs are not stats — labels need a real word, aren't number+unit, and a tiny denylist catches bare generic headings, while the open-ended capture keeps working for real stats.
- **A party that wipes before tier 1 gets an outcome, not a promise**: a stated 0 outranks the Completed badge (absent stays absent — no points seen is not zero), and the banked row says "0 tiers — fell before tier 1" instead of the live "tier 1 in progress" line; zero-point tiles survive merges and archiving, because a failed trial belongs in the record.

### Spectating measures: the trial fight is on the wire after all

- **Per-player trial measurement is real** — the user's wire capture proved the fight view streams `guild_battle_updated`: the same tick shape as ordinary battles plus `battleId` and the tier stated outright. The trial damage machinery now consumes it: damage taken, healing, mana, and deaths fill from every tick; the damage split fills when the stream carries attack counters (the first capture carried none for players — the scoreboard says "watched, but the stream carried no attack counters" instead of guessing, and the export's `spectator.playerActionTicks` answers it from the next watch). The message joins the dedup skip-list — byte-identical consecutive ticks would otherwise collapse an entire trial to one.
- **The solo-attribution fallback is off for spectated streams**: "only one character is known, so it was them" is sound in your own fights (the party was stated) and a trap here (one unit having appeared means one unit _moved_) — the capture contained the exact tick where the tank would have been credited the boss's whole health bar.
- **Units get names three ways**: fight-view portraits in slot order, then max-HP/MP signature against captured sheets (2,612/2,180 names ICMeow uniquely), then an honest "Player N". Ambiguity resolves to nobody; placeholders don't survive the view opening.
- **The spectated pool feeds cards with no bar of their own** (the Trials tab measured nothing all hour; now a fresh spectated reading stands in, never overriding a bar the game itself draws), the payload's tier replaces badge-inference while watching, and a fresh tick arms the recorder.
- **The boss is a boss everywhere**: clicking it no longer stores it as a member loadout (monster units refused and purged; it would have joined the damage-split estimate), its stats popup no longer gets our info block injected into it (cards are not allowed inside dialogs — no card-shape filter could catch a popup literally titled like a card), and its per-tier sheet is filed as `bossSheets[tier]` — two tiers side by side settle whether accuracy and damage scale the way health does.
- The wrong "simulated, not fought" note is replaced: the fight is real and server-run, and watching it is measuring it.

### The cycler clicks the people fighting beside you

- **A fight on screen outranks the roster walk**: the profile button now finds your guildmates' unit boxes in the spectated trial fight and clicks those first — that's the Battle Info popup, the only source of a combat stat sheet (`/profile` carries skills but no sheet). The boss can never be offered (only roster names match), a sheet older than 15 minutes is worth re-clicking mid-fight, and ⟲ Redo covers battle sheets too.
- **Dead units are skipped and said**: a dead unit's popup hides its abilities, so the button skips them, counts them ("2 dead skipped — abilities hide on death"), and tells you to ask again after a revive rather than half-capturing.

### Beacons cover the way out before they chase dark corners

- **A set beacon count is planned against the same objective the automatic one uses**: cover a revealed path to the exit first, a second independent route next, and only then reveal as many rooms as the count allows. Set counts used to maximise rooms and nothing else, which is how four beacons could be planned onto the fattest dark pockets of a floor while the plan's own caption admitted "a covered path to the exit needs 3". A count too small to cover a path now spends itself getting as close as it can — and still says what it would take.
- **The count is a per-floor override again**: a number chosen because one map was worth four beacons no longer follows you onto every floor after it. Each new floor starts back on the automatic minimum.
- **A ⟲ button beside the count** puts it back to the fewest that cover a path, without spinning the field down a step at a time.

### The arrow points at the count, completed means completed, and estimates say so

- **"On pace for 4 tiers → T5" is impossible output now**: the count and the arrow's target were computed from different numbers (tiers finished vs tier being fought); both now derive from one figure, and a tier the walk enters but can't finish moves neither.
- **A Completed card is completed everywhere**: the game's own badge overrides the kind-level phase, so skilling blocks stop showing "On pace for" (or "scheduled") after their trial ends while combat runs — final rate and banked, nothing live.
- **Per-player trial damage is presented as what it currently is — an estimate from builds**: headlined "Estimated from builds" in the scoreboard, the report ("ESTIMATED FROM BUILDS" as line two where a chat skimmer reads it), and the card line ("simulated, not fought"), with per-member auto-attack shares, build coverage ("2/3 builds"), and unestimated members named. The pool-bar party rate stays labelled measured. (A spectator battle feed was discovered moments after this shipped — real measurement lands next.)

### Neither ladder has a wall, and a click is not a capture

- **The profile cycler counts replies, not clicks**: a hidden chat box could mark members as logged without any profile ever opening — now a click is a timestamped request, re-offered after 20 seconds if no capture lands, the progress count derives from actual captures (wrong states self-correct), a member in flight shows as "Waiting for…", and a missing/hidden chat input says "Open the chat panel first" instead of silently doing nothing. Inert skilling units on the In Progress tab are never clicked — the chat route is the only one that works there. **⟲ Redo all** marks everyone due again without discarding stored levels; one click still equals one profile.
- **Skilling success decline is measured and modeled**: personal stats are stored per tier, the drop is fitted (the live data reads exactly −8.0 points per tier), and future tiers scale their effective fill rate down to the game's **5% floor** — deep tiers are slow, not impossible. One observation means no trend: walk flat and say so.
- **Enrage is a buff, not a timer**: monsters stack +10% accuracy/damage per minute to +100%/+100% at ten — fights don't end. The combat walk no longer stops at ten minutes; it carries on at DPS and captions the escalation ("fully enraged — expect deaths to slow this beyond the projection"). No forecast has a hard wall now; the hour is what ends both walks.
- **The lifecycle phase is per trial kind**: "Skilling Trial - In Progress" no longer makes combat cards claim "measuring…" or "Banked: 1 tier" — and banked now requires stated points, since Lv.100/0 pts/T1 is tier one _in progress_ while Lv.100/236 pts/T1 is tier one _banked_.
- **The payout block states the week's total on every tab** (it summed only visible cards on In Progress — 472 beside the Trials tab's 2,714), and **"On pace" and "Expected" are one walk**: a single row when no slowdown is measured, two clearly-labelled rows ("flat" / "slowing") when one is.
- Anchored to live figures: pools T1–T5 exact (40,800 → 57,120, +4,080 each; T6 = 61,200 where the old fit said 63.3K), success 73.6/65.6/57.6/49.6.

### The badge means banked, and the skilling ladder is a rule now

- **Mid-trial, the stated tier badge counts tiers banked and the fight is on badge + 1** — proven by the live sequence (a T2 badge while the third pool ran). "Banked 1 tier" under a T2 badge now says 2, and live pool readings file under the tier actually being fought — two tiers' pool sizes were quietly filing under one number and corrupting the ladder.
- **Skilling pool sizes are derived, exact on all three observed tiers**: T_n = base × (1 + 0.1×(n−1)) × (1 + 1% per participant) — linear, not geometric (a ratio fit would have drifted 400 work by T3). One reading anywhere gives the whole ladder; observed readings still win.
- **The forecast walks the whole hour**: no more "Expected ~T2" while four tiers were on pace — it walks the derived ladder, adds the banked tiers (returning only its own walk was impossible output), and "Next tier work" appears from the first minute.
- **Labels wrap at spaces only** ("Expecte/d" is gone — `overflow-wrap:anywhere` removed outright), long labels stack above their value.
- **Cards stating 0 points state nothing**: zero no longer reaches the disagreement warning or the stated-points path.

### The recorder survives its first real trial day

- **Auto-record actually arms now**: the status header carries the trial kind ("Skilling Trial - In Progress") which the reader didn't recognize — and worse, the header lives on the Trials tab while the readings live on In Progress, so requiring both at once meant auto-record almost never armed. A live reading on a real trial card now arms it; the panel can only veto with an explicit Scheduled/Completed, and silence blocks nothing.
- **Manual recordings stop only by your hand**: the ten-minute silence rule and the one-hour cap were killing sessions whose player had simply closed the guild panel to go play. Silence is now recorded as a visible gap in the session (`{from, to, ms}`) instead of acted on, with a six-hour backstop; the silence rule for automatic sessions no longer fires while a trial is live. Between the skilling and combat hours, automatic sessions roll over by themselves and manual ones simply span both.
- **The first tier is tier 1**: a live trial with no points and no badge is on T1 by game rule, so pace and forecast light up from the first minute and pool readings anchor the growth fit; the mid-trial-join case (points already showing) keeps the honest unknown.
- **The start notification listens to guild chat**: the game's own "guild trials have begun" line fires it even with the guild panel closed, sharing a key with the phase trigger so whichever notices first speaks once.
- **Labels wrap instead of vanishing**: "C… | 0 tiers → T1" is gone — the ellipsis machinery is removed outright, long values take the full width with their label above, and short figures keep their two-column row.

### Release plumbing

- **Guild features moved from the ui library to the combat library**: the trials suite had pushed `toolasha-ui.js` past the 3MB bundle ceiling; the guild modules already lean on combat machinery (damage attribution, battle payloads), so they now ship in `toolasha-combat.js` (2.3MB) and `toolasha-ui.js` is back under the limit. No behavior change — the entrypoint wires the same features from their new home.
- Repo-wide prettier drift (11 test files and one doc that slipped past the staged-files hook) formatted; the storage-estimate test suite provides its own `navigator` so it runs on CI's Node 20.

### A trial report your guild can actually read

- **Copy guild report**: one click produces a Discord-pasteable summary — trial name and tiers cleared, party damage and rate, ranked player lines that only mention what happened (no zero-fields reading as failures), attributed and unattributed healing, and the line nothing has ever shown: **how close the party came** — "Stopped 83% into T4 — 112,000 of 669,500 HP left" states it both ways because a guild asks both "was it close?" and "how much more DPS did we need?". No markup, no padded columns (Discord renders proportionally), every line under 120 characters.
- **Deaths are explicit** ("died 2×") and **mana depletion is tracked**: dry _spells_, not dry ticks — hitting zero counts once however long it lasts, with the empty time accumulated ("ran dry 3× (~4m)") — in the scoreboard, the report, and the export.

### A warning before the task board fills, and trials that predict themselves

- **Task-slot alert**: opt-in notification when your last open task slot is projected to fill within a configurable lead (default 8 hours) — computed from the server's own slot cap, arrival cadence, and last-task time (no panel needs to be open), keyed to the projected minute so re-checks can't spam, re-armed automatically when completing or rerolling a task moves the projection. A board already full is its own once-per latched message. Help text says plainly that it's a projection. Fixed en route: the trial-starting alert announced "6 days 22 hours" for a 10-minute lead — milliseconds fed to a seconds formatter.
- **Expected-tier forecast**: live trial cards gain "Expected ~T6" and the per-player panel says what the hour should yield. The tier ladder is now _derived, not fitted_: a tier's boss health is base × (10 + tier level)/110 × (1 + 1% per signed-up participant) — reproducing both recorded tiers (618,000 and 669,500) to the digit, with panel readings still preferred where they exist. Combat forecasts rank their damage source honestly: measured off the boss bar, else summed from captured loadouts ("based on 3 of 8 members"), else unavailable — and a tier that can't die inside the 10-minute enrage is reported as a wall, not a slow climb. Skilling forecasts only walk measured pool sizes at measured fill rates; no invented level-to-work conversion, and before data exists they say so.
- **A profile-logging button on the guild roster**: "Open Ada's profile · logged 5/28" — one click opens one guildmate's profile (their Members-tab row when visible; otherwise it fills `/profile Ada` into the chat box and leaves Enter to you), and the `profile_shared` reply carries every skill level, which feeds the skilling side of the recording and the export (`memberSkills`, additive). Captures go stale after a week and are offered again.

### Path shows the way to the plan, not just the plan

- **The rooms between you and the first planned room are lit too**: a route only names rooms that cost something, so on a floor whose first rooms are already cleared it began out at the frontier with nothing drawn in between — leaving the map silent about which way round to walk. The shortest walk over already-cleared ground is now drawn as well, starting from the room the game says you are standing in (the entrance when it does not say). It reads as the same highlight turned down — dashed, faded, no label — so "walk through here" cannot be mistaken for "fight or shroud here", and it survives the clearing-progress sweep that strips the plan off rooms as they are cleared.
- **The caption counts it separately and honestly**: "Path: 5 rooms (+3 walked) · 0 shrouds · 4 chests". Walked rooms are already cleared, so they cost neither a torch nor a shroud and are kept out of both numbers.

### Path stops planning a floor that has already moved on

- **Rooms you have already shrouded are no longer marked "Shroud" again**: the route planner classified the board the moment the button went down, then spent seconds running fight sims, and drew its answer against that snapshot. A run does not stop for the sims — a shroud clears its room outright — so pressing Path during a run could come back demanding shrouds for rooms that had been shrouded while it was thinking. The plan is now classified twice: once to find the fights worth simulating, once against the board as it stands when the plan is actually drawn (grid cells included, so a plan can no longer be drawn into a grid React has since rebuilt). Pressing Path twice on an unchanged board gives the same answer; pressing it after spending shrouds re-plans from what is revealed now.
- **A room that comes into view mid-sim is costed like any other room nothing is known about**, taking the `?` mode's posture instead of defaulting to "free" because it happened to be looked at after the sims had moved past it.
- **A floor that changes shape mid-sim says so** rather than drawing a route for a floor you have already left.

### Trial cards say what their phase can know, and stay off the notice board

- **No more trial card built out of the Overview tab**: the name test was a substring match, so a notice-board paragraph containing "milking" passed it, and the guild XP bar (4,120 / 20,000) read exactly like a progress bar and anchored the card. Names now match whole strings after stripping the game's real decorations, a positive tab gate refuses pages legibly showing another tab (permissive when the tab strip can't be read — failing closed on an unverified class name is how this feature went dark twice before), and stale blocks are reaped document-wide on every pass.
- **The recorder no longer records nothing**: "any tile with a bar" counted as trial activity — including the phantom Overview card — and a lifecycle phase that had never been read was treated as permission. Auto-record now requires the panel to say live (or the damage gate to be genuinely armed); scheduled or completed stops a self-armed session immediately. A session you pressed Record for is still yours to stop.
- **One row set per phase**: scheduled cards collapse to "scheduled — starts in 2h 24m" instead of stacking three variations of "nothing yet"; completed cards show results only (final rate if ever measured, points, banked) and drop next-tier/pace/absence rows; live keeps the full readout. A completed trial you never joined shows the facts the tab states and skips the two rows that both said "no data".
- **Numbers keep their units**: "522 dmg/s" can no longer split mid-unit — values are non-breaking and the label truncates instead, since the unit is what makes the number mean anything.

### Poisoned trial records heal themselves, and trials announce their own schedule

- **The stale record from before the switch fix cleans itself up**: records now carry the guild they were recorded under and are refused when it names a different guild — and since the reported copy had been adopted onto the new guild's own key and looked native, the page is the final arbiter: when the game says **Scheduled** and every card states nothing while the record claims tiers and points, that contradiction archives the cycle (into a four-cycle history, not deleted). A live trial showing "0 pts" before its first tier clears never triggers it — all three conditions are required. The legacy shared fallback key is purged at startup. Belt-and-braces: `await Toolasha.debug.clearTrialData()` wipes trial records (and leaves guild XP history alone) — it shouldn't be needed.
- **The panel knows Scheduled from Live from Completed**: the game's own status header is read structurally. Scheduled says "nothing running yet"; Completed stops pretending ("Final fill rate", "Final party DPS" — the last rate measured while it ran — instead of "Tier clears in 11m" for a trial that's over); the recorder ends its session on any non-live phase so auto-record arms cleanly for the next start.
- **Two new notifications** (both default off, in the notifications settings): **trial starting** — fires at a configurable lead time before the scheduled start (default 10 min) and again when it actually begins — and **trial results** — fires on completion with points banked and both token figures, captured while they're still on screen. Honest limitation, documented: the schedule only advances while the guild panel is open — no socket message carries it.
- Found en route: recording a sample was silently stripping every field off the record except the week and tiles — it would have deleted the provenance stamp and the archive on the next tick.

### Trials stop following you to your next guild, and the tab stops yanking you around

- **A character switch drops everything**: switching accounts in the same tab showed the old guild's 2,880 points, banked tiers, and payout in the new guild — two causes, both fixed. The unnamed-guild fallback bucket was shared (`guildTrials_default`), so both characters read and wrote one record; it's now per character. And every in-memory cache — record, guild name, trial names in the damage gate, recorder session, injected blocks, scoreboard — resets on the switch event, with guild-name adoption held off until the arriving character's own data has landed (the switch fires _before_ it, so adopting early would have re-filed the new character's readings under the guild they just left).
- **Side blocks read like text, not noodles**: a long caption ("no data — only trials you join can be measured") now takes its own full-width line under its label instead of wrapping down a squeezed value column; genuine figures keep their two-column rows; the block has sane min/max widths.
- **The Trials tab keeps your scroll position**: blocks are updated in place and only re-rendered when their markup actually changed (compared against what we last drew, not against live DOM that stops matching once listeners attach); when insertion is unavoidable, every scrolled ancestor's position is saved and restored. Reading the bottom of the page no longer means being yanked to the top every five seconds.

### The bulk reroller now closes the door behind itself, and takes the free reroll on faith

- **Protected tasks get their green outline back after a bulk reroll**: the reroller left the game's chooser standing open on the card it had just rerolled, which kept that card permanently "mid-flow" — and every decoration pass (protection outline, profit rows, reroll-spend line, icons) rightly refuses to touch a mid-flow card, so nothing ever repainted. The reroller now settles every card it touches: reads the chooser, presses Back, and arms the repaint watch unconditionally instead of hoping another feature does.
- **The first click takes the MooPass free reroll even when nobody knew it was there**: the old flow read the chooser once after a fixed 300 ms — long enough for an already-open chooser, too short for the MooPass row on one it had just opened, so the unknown case paid coins. It now polls, takes a free row the instant it appears, grants the MooPass row a short grace only while a free offer is still plausible, and remembers the chooser's answer for a minute so the button label stops downgrading "FREE" to "10.0K\*" when the menu closes.

### The trial recorder grew hands, eyes, and a scoreboard

- **Auto-record**: trials record themselves — starting when the damage gate arms or a live In Progress reading appears, stopping after the trial's hour or ten minutes of silence (and saying which), snapshotting every 15 seconds to IndexedDB so a reload loses nothing. Opt-out via the new Guild Trial Auto Record setting.
- **In-game controls**: Record / Stop, Export, and Per-player buttons on the payout block — no more console command (though `Toolasha.debug.exportTrialData()` still works and shares the same code, so the two can't drift).
- **A ranked damage scoreboard** ("Trial Damage" in Ctrl+K): party rate and total up top, Damage and Healing tabs, ranked rows with totals, per-second rates, and share bars coloured by each player's damage type from their captured loadout. Copy-stats button; End & start new record is the recorder's own restart, not a second mechanism. Both tabs carry the estimate disclaimer.
- **Per-player support stats, measured not modelled**: healing received (and healing _done_, credited only when exactly one player cast a heal that tick — the rest stays honestly unattributed), damage taken with each player's closest brush with death, mana spent/restored, and casts per ability. Surveyed against 6,700 recorded battle ticks. Mitigation and live threat are **refused, with the reason shipped in the export's new `coverage` object**: no payload states pre-mitigation hits or who the boss is targeting, and a simulation wearing a measurement's name helps nobody. Skilling trials capture the In Progress footer's personal figures (work time, success rate) as generic pairs, so new stats appear the day the game adds them.
- **Archives wired in as the counterfactual it is**: guild XP figures are measurements that already include the bonus, so the panel now says so — "Archives Lv.N · +X% — already included; Lv.N+1 would add ~Y XP/h" — with the per-level rate read from client data. Skill buildings stay out of all sims (they only act during trials).

### The overlay's ⚙ popover no longer traps you, and keeps up with what it shows

- **It can never cover the panel's header again**: the popover used to pick above-or-below and then clamp itself into the window, which on a tall panel — a phone, or a desktop panel dragged low — slid it _up over its own anchor_ until it sat on the header. Since the popover draws above the panel, that put the ⚙ that closes it and the ✕ that closes the overlay both underneath it, with no other way out. It now fits itself to the room instead: whichever side it fits on, else the roomier side with its height capped so it scrolls, and on a panel taller than the window it stands over its own tiles starting _below_ the header.
- **Escape and a press outside now close it**, the two gestures everybody already tries. A press on the panel itself doesn't — the popover exists to arrange those tiles.
- **The delete-a-layout dialog is no longer asked underneath it**: the popover stands down for the question and comes back around whatever layouts are left.
- **It redraws when the layout changes under it**: locking or unlocking now updates its hint instead of going on telling you to do the thing you just did, a window narrowed until the tiles flow into columns says so while the popover is open, and docking from the popover puts it back rather than dropping it on the floor.

### Trials round three: exact digits, honest captions, and a block that finally sits still

- **Payout figures in full digits**: the payout block now says "2,880" and "1,320 (≈14,652,000g via credit exchange)" instead of "2.9K" and "1.3K (≈14.9Mg)" — the whole point of exact math is the exact digits. Tiles elsewhere keep abbreviating.
- **The sign-up roster renders only on the Trials tab**: it had been migrating onto the In Progress tab after a tier advanced, because both tabs answer to the same panel finder and a stale block was never removed across the switch. The setup tab is now recognised by what its cards carry (sign-ups without progress bars), and stale blocks are removed document-wide on redraw.
- **The injected block takes a real full row**: `grid-column: 1/-1` collapses to a single cell on a grid with no explicit column template — the 126px-wide overlap in the devtools shot. Placement now measures the actual container (grid with/without template, wrapping/non-wrapping flex, plain flow) and picks a spanning technique that works there, labelling the block with its trial's name when it can't sit beside its card.
- **Trials you're not in say so**: progress and damage only exist for trials your character joins, so other cards now say "no data — only trials you join can be measured" instead of "measuring…" forever. Tier, points, and sign-ups still show for every trial — those are visible to everyone.
- **The tier badge is settled**: on a completed card the badge counts tiers earned (960 pts at T3 is the three-tier ladder total), so "Banked" now says "3 tiers · finished" instead of stopping one short; a running card keeps the cautious tier − 1 and its tooltip says it's an inference.
- **Building bonuses read from the game's own data**: Builder's Hall and Treasury per-level rates and level caps now come from the client's building detail map (user-extracted, `guildPointsBonusPerLevel`/`guildTokenBonusPerLevel` both 0.02) with the constants as fallback — a game rebalance moves the panel's math automatically.

### The trial payout math is now exact, verified against four real payouts

- **Combat trial cards finally produce a rate**: the two bars are the boss's HP and mana (user-confirmed), so the first is always the boss and mana is excluded from rate math — the old "whichever bar falls" rule could never classify a pair of samples straddling a tier clear, which is why the card measured nothing all hour. Damage now accumulates across tier boundaries (remaining HP of the old boss + damage into the new one), captions itself as a lower bound when the gap could span more than one tier, and a "Split disagrees" row appears when the bar-derived rate and the per-player damage split diverge past 1.4× — they measure different windows and the row says so.
- **Card points are post-Builder's-Hall, and the payout is the cards' sum**: the game's stated "840 pts" already includes the guild's Builder's Hall bonus (+2%/level, confirmed by the upgrade popup), so the old math double-counted it — and the banked lookup missed by one tier on every trial, which is why the panel said 2.4K the day the game announced 2,880. Guild Points now sum the cards' own figures to the digit; tokens run off recovered base × half × Treasury bonus (+2%/level, also popup-confirmed) — the formula reproduces all four of the guild chat's announced payouts exactly (990/880/1,375/1,320 tokens, participants +50%).
- **Building levels come from real guild data** when the payload carries them; with none seen, the Builder's Hall bonus is recovered from the cards themselves (840/700 = 1.2, strict whole-2%-steps check) and captioned as card-derived, while the Treasury line honestly says no level has been seen rather than guessing.
- **The mis-framed ladder warning is gone**: it blamed the ladder on every card of every week; with the bonus understood, the game's numbers and the ladder agree, and the warning now fires only on a genuine post-bonus mismatch.

### The trial export was read, and it proved six defects — all fixed

- **Per-player DPS now arms during real trial fights**: the gate compared only the payload's display names against the trial card, but live payloads name monsters by hrid too (`/monsters/trial_chameleon`), and the old reader threw the hrid away — so a party visibly fighting Trial Chameleon measured nothing. Every spelling is now collected (name, character name, the hrid itself, the client's name for the hrid) and matched with separators flattened; and the verdict on a fight already in progress is re-taken when the trials record learns the week's card, since the panel is routinely opened _after_ the party starts swinging. When the gate still says no, its reason now lists what the payload called the monsters, so the next export answers the question instead of repeating it.
- **The 5-second sampler actually runs**: it was armed after two awaits (behind the record load), and the DOM fallback debounce starves under a bar that redraws every second — the export showed two samples seven minutes apart. The sampler is now armed before anything can fail ahead of it, a tab event revives it if ticks stop, and an early tick no longer loses to the record load.
- **Stated tiers and points persist**: a card saying "840 pts" and "T6" but showing no level recorded neither — tier was only ever derived from `Lv.`, and a card without a level marker wasn't even read as a card. A stated `T6`/`Tier 8` now beats the derived tier and anchors the card, as does a points line.
- **The record learns your guild name** from the `guild_updated` payload the feature already receives and from character data — not just the XP tracker, which is null whenever it's off. Exports read the feature's record, not a parallel guess.
- **Tenacity and Threat are flat ratings, not ratios** — no more "Tenacity 16579%" in seen loadouts; every other stat row was audited against the export and zero-valued gear bonuses are dropped.
- **Trial annotations no longer overlap the game's cards**: the game's tiles are fixed 126×126 grid cells and our block was injected inside them; it now renders as its own full-width row after the card.

### Trials know who hit what, and why the payout was blank

- **Per-player DPS on combat trials**: one line per player under the trial card — DPS, share of party damage, deaths — using the exact same damage attribution as the DPS panel, gated so only real trial fights count (a mid-trial reload measures nothing rather than the wrong thing, and the next zone can't inherit the tally). Spans the trial's tiers; prints its reason when nothing is measured.
- **Seen loadouts**: clicking a player's popup (and every trial battle you're in) captures their stat sheet and abilities — armor, resistances, evasions, crit, regen, drop stats, the lot — stored per character and shown in the guild roster as dated snapshots ("seen 2h ago"), because a snapshot is a photograph. Works whether the popup is socket-fed or not; the DOM fallback stands down whenever real data arrives.
- **The blank payout block had two causes, both fixed**: the tier only exists on the Trials tab (an In Progress-only viewer had no tier → every line zero — the three states now say "open the Trials tab", "tier 1 in progress", or a figure), and the record merge on every session's first render was silently erasing the points and signups the Trials tab had reported. "On pace" now always draws with its reason instead of vanishing.
- **The game's own points figures now check the tier ladder**: per-tier "N pts" values are stored and preferred over the derived ladder where they disagree, with the source captioned and a warning naming any tier whose figure matches neither reading — so the next trial settles whose math is right.

### Trials read the game as it actually is

- **The real structure, from live screenshots**: the Trials tab carries setup (tier, points, signups, countdown) and the separate In Progress tab carries the pool readings — no card anywhere holds both a level and a progress bar, which the old reader required, so nothing could ever record. Cards are now found by shape (a level marker or an n/m reading) and kept by name (the five encounters + ten skills), sign-up counts parse as participants instead of masquerading as progress, the In Progress total pairs with the Trials tier in one record, and the panel no longer misreads levels off its own injected badges.
- **The clock works**: the countdown is found structurally on either tab with guards drawn from the real page ("Work Time 3.14s", "Thu 09:00 AM" and percent lines can't win), and "On pace for — no clock visible" appears instead of the row silently vanishing.
- **Sign-up lists render without the phantom classes**, trial records adopt the guild's real name once it's known (sessions that started under the default key merge in), and the tile hint + Ctrl+K entry point at the In Progress tab — the one that feeds the pace.

### The trials feature existed on a guess

- **Why nothing trials-related ever rendered**: the whole feature — observer, refresh, sampler — hung off a single unverified class name that the game evidently doesn't use, so no reading was ever taken and both the panel block and the tile stayed silently dark through live trials. The trials container is now _found_ (three candidate names, then any guild panel showing a trial card), with junk guards so buildings and sign-up cards can't pollute the record. Also fixed en route: a card whose first line was its numbers got named "1.2M / 4M" and misclassified, and a one-reading trial showed the same "—" as no trial at all — it now says "T7 · measuring…".
- **Switching a tile on always shows something now**: an explicitly-enabled tile renders dim with "waiting for data — …" until it first draws something real, instead of hiding as if the click did nothing. The passive auto-hide default is unchanged (fresh characters still aren't buried); ⚙ chips carry a ◌ badge saying "shows when it has data" so the contract is visible before clicking. Applies to every measurement/watch tile.
- **"Guild Trials" is in Ctrl+K**: navigates to the guild's trial tab, scrolls to and flashes the injected figures — the analysis renders under the game's own trial cards, which is why no panel existed to find — and says so when there's nothing drawn yet.

### The lab sims the run you choose

- **Token buffs are settable from Configure**: the four combat token buffs take inputs (defaulting to live levels, orange with "live N" beside them when overridden, Reset-to-live one click away, remembered per character), and every sim path honours them — Configure/Max Level sims, Find Max, both Upgrade scopes, and the combination check. The Token Upgrades rows step up from the level being simulated, so a run under Damage 8 offers Lv8→9, not a purchase the table already assumed. Skilling tokens stay a readout here — nothing in a combat sim reads them, and the Skilling tab's own setup owns those.
- **All-fights ability targets show every checked loadout's abilities** — the union, labelled by loadout where they differ ("Fireball (48) [Fire Lab]"), levels shown as a range when loadouts disagree, targets prefilled off the highest so a boost is real everywhere. Was silently showing only the Configure loadout's five.
- **Guild shrines get a per-shrine Targets grid** like houses — set Force to 4 and Scholar to 2 in one run instead of one +Lv for all, combat shrines only (a skilling shrine has no win-rate column to move).

### Rates bounded by the market and your wallet

- **A rate is capped by how fast its output actually sells**: using the market history Toolasha already fetches, any method that depends on selling an item is throttled to a conservative quarter-share of its observed 30-day sale velocity — so a charm that trades once a week collapses from "134.3B/hr" to its honest few hundred K and loses to milking naturally, labelled "limited by market volume (~1/week)". History showing no trades bounds to zero; history being _unavailable_ bounds nothing and the panel says the check is off (absence of data is not data of absence).
- **You can't be told to start what you can't afford**: a method whose first action's inputs cost more than your available gold (after earlier goals' claims) is excluded with "needs ~X upfront — you have Y", and returns the moment gold suffices. Decomposing what's already in your bag needs no capital and stays available.
- Thin _input_ markets get a warning note rather than a cap, and every reduction is printed beside the number it reduced.

### The reroll chooser is finally read as it is

- **The MooPass reroll failure's real cause**: the code assumed paid reroll buttons say "Pay …" — they never have; they're a currency icon plus a bare number. So the chooser reader recognised _only_ the free button, silently did nothing when free wasn't choosable, and a stall latch (armed by a confirmation check that accepted any task progress as "the reroll worked") could permanently kill free rerolls for the session — all while the bulk button kept quoting a 10.0K reroll it would never make. A new structural chooser reader identifies options by their sprite icon and number, the stall latch became a 10-minute cooldown, reroll confirmation now requires _this_ task to actually change, and a card that can't be rerolled says so instead of wedging the queue.
- **Bonus bug**: the same wrong "Pay" assumption meant reroll cap protection had been guarding nothing and per-task protection let paid rerolls straight through — only free rerolls were ever intercepted. Both now read the chooser correctly, with the cap measured in the option's own currency.
- **Reroll labels are MooPass-aware**: "Reroll FREE (1)" when the free option is provably available, split labels ("2 free, 1×10.0K") when the allowance is known, and an asterisked cost with tooltip when MooPass exists but availability can't be known without opening the chooser — never a FREE that isn't proven.

### The goal planner shares, navigates, and answers instantly

- **Goals share one resource ledger**: two goals can no longer both plan to spend the same crossbow or the same coins — earlier goals claim first (display order), later ones plan against what's left, with dim notes saying exactly who took what ("Sundering Crossbow ★ already spent by 'Cheesesmithing 108'"). Removing a goal gives its claims back to the goals below it, instantly.
- **Adding or removing a goal plans and renders immediately** — no Refresh needed; already-fetched prices are reused (Refresh still owns re-pricing), and a failed refresh no longer masquerades as an empty successful one.
- **Click a step to go there**: production, earn, and enhance steps navigate to their game action (dotted underline marks what's clickable); buy and house steps aren't destinations and don't pretend to be.
- **Windfalls never wear per-hour clothing**: any method whose remaining stock is gone inside an hour reads as a one-off ("Decompose 22 Master Tailoring Charm (+877.9M one-off)") whether or not a fallback follows — the leak your screenshot caught is pinned by tests.
- **Enhance steps carry an expected-materials bill** with a Buy handoff (labelled "enhancing is random"); the shopping list is one shared module across bundles now (two open lists no longer fight over the tab bar, and the autofill observer leak is fixed at the source); profit is attributed to the right recipe when two actions make the same item.

### The sims finish their own homework

- **Skilling gear rows expand like combat rows**: click for the full cost breakdown — clear-rate baseline, per-piece cost basis ("enhancing a piece you already wear" vs "a piece you don't own yet"), and the kept-gear reason where combat gear was displaced.
- **Unpriced never reads as free, anywhere**: the old ability-cost helpers that returned 0 for an unlisted book are deleted outright (a test pins them gone); Build Score and networth now say "no price" and exclude the figure rather than counting zero — and an owned-but-unslotted book's genuinely free fill says why with a "book owned" chip.
- **The budget planner understands swap rivalry properly**: candidates carry key _sets_, so two swaps into one slot, a fill and a displacement of the same book, and levelling-vs-swapping-away an ability all correctly exclude each other — with a distinct "a pick already uses what this needs" skip reason instead of a misleading one.
- **The lab names each loadout's archetype** after a swaps run ("Fire Lab → Fire, Old Setup → no archetype (all abilities offered)"), so a fallback is visible instead of inferred.
- Plus: the analyze progress bar can no longer stick on an early throw, and a pre-existing formatting failure in the engine is cleaned up.

### Nine small debts paid

- **The lab supplies planner believes the server**: a just-ended run no longer reads as active off a stale grid — the game's own isActive flag wins, with the grid test kept only as fallback.
- **One house cost basis**: build costs price at the ask everywhere now (they were quoted at the midpoint in the Houses panel but at ask in the advisor and eWatch — same room, two figures). Houses-panel costs, networth's house valuation and the combat score's house cost all move up by the half-spread to the honest buy-side number.
- **Auto-sort keeps its promise**: with auto-sort on, the task board re-sorts itself when a reroll chooser closes; without it, nothing reorders under you.
- **Autogrid can't overlap tiles anymore** — advances round up to the grid in both axes (the vertical had the same bug).
- **The treasure chest popup's ✕ got the same pinned treatment as the main header**, one shared item-hash parser replaces two copies, one shared room→skill map replaces two copies, a drift test pins the notification permission keys to the schema, and a dead contradicted clamp was deleted.

### The goal planner stops promising billions

- **A rate is only a rate while its inputs last**: every gold method now carries a sustainable cap — alchemy is capped at your own stock (decomposing one crossbow is a +851M _one-off_, not "437.9B/hr"), and the plan spends methods greedily: windfall first, then the next honest rate for the remainder, shown as indented sub-steps with their own durations. A method you can't run for an hour is never described per-hour; a target no method can cover says so instead of inventing a duration.
- **Fantasy production margins fixed**: a material with no market listing was billed at zero cost, turning modest crafts into eight-figure hourly incomes. Rates with unpriceable costs are dropped (and counted); missing _output_ prices still understate conservatively. Training steps now print the rate behind their gold figure, so a broken number is attributable at a glance.
- **"Gear changed" means your combat loadout changed** — not that you put on a chef's hat. The snapshot is judged against your combat loadout (explicit pick wins, then the combat default), with a picker when you have several and an honest fallback note when you have none.
- **Buy-steps hand off to the marketplace**: house material steps open the shopping-list tabs with quantities armed, craft steps use the missing-materials machinery, single purchases go straight to the item.
- **Less clunk**: step labels wrap instead of hiding behind tooltips, the pricing note appears once at the panel foot, the totals row says "Left to do — earn X, spend Y", and steps show thin progress bars where the fraction means something.

### The lab sims what can actually win

- **Skilling rooms leave the lab combat list**: every house room grants global experience+rare-find just for existing, which the old filter read as "affects combat" — so all seventeen rooms qualified and Mystical Study's +1.02% was sampling noise wearing a room's name. The lab now only offers rooms whose buffs can change a fight's outcome; the combat sim's own tab keeps the wider set (its profit/XP columns make those rooms legitimate there).
- **Token buffs rank in whole-run scope** — their own "Labyrinth Token Buffs" section with per-fight breakdowns; the blocker was that a token buff is an argument to the sim, not a change to the character, so the pooled path needed a buff override. The "Configure fight only" tooltip claim is gone.
- **Your combat gear is never sold for skilling gear**: the -410M "cost" credited the Maelstrom plate's resale; combat-only pieces displaced by skilling gear are now kept (star marker, hover note, footnote) with no setting — loadouts mean you keep both, and there's no judgement call to toggle. Same-purpose swaps unchanged.
- **Target levels everywhere**: houses (lab gains the Lv box + per-room Targets grid the combat sim had), guild shrines (summed credits+tokens), and community buffs (all three surfaces), each capped at its real max.
- **Community buffs in lab combat** (Configure fight): ranked on XP per attempt with win-rate columns honestly blank; Combat Drop excluded because the lab table prices no drops — the footnote says so.
- **House rows get "Save for this"** (feeding the new house goals) **and "Market"** — one click opens the dominant-cost material with the full count armed, the tooltip naming the rest.
- **The gradient colors every scored column** in its own direction (cheapest-first for Gold/0.01% and Repay), missing values never place, and the skilling tables pick up the combat side's wrapping and row actions.

### Task cards catch up after a reroll

- **The stale picture and the stuck free reroll were one bug**: the game leaves the reroll chooser open after rerolling, and Toolasha's "never touch a mid-flow card" rule had no way back — every redraw pass skipped the card and nothing re-ran when the chooser closed, so the picture, profit rows, spend line and highlights all stayed on the old task. There's now a settle watch: any skipped card arms a poll that redraws everything the moment the chooser closes, and the task icon (a click-proof background layer) updates even mid-flow, while you're looking at it.
- **Free MooPass rerolls are recognised however the game words them** ("Free", "Free Reroll (2)", with or without counts), never mistaken for the cowbell option, and the bulk reroller now notices a free button that silently stopped working (spent pass) after two tries and pays from then on instead of clicking forever.

### eWatch learns houses too

- **House room levels are savings goals**: a "House Levels" card set beside Ability Levels — "Mystical Study Lv5" with the summed build cost across the level span (coins at face value, materials at buy price; any unpriced material makes the goal honestly unpriced, never a partial total), progress from your gold, Reached when the room gets there. Manual add from Edit mode with rooms and current levels listed, capped at the room max of 8. House goals join the headline candidates, the overlay tile, and the Everything total. The sims' house rows hand goals over via the same one-writer record the gear and ability goals use.

### Ability swaps follow the guide

- **Swap candidates come from the community build guide now**: each loadout's archetype is detected from its weapon (spear/sword/mace/wark/bow/crossbow/fire/water/nature — any bulwark reads as wark, staff element from the weapon or robes), and only that archetype's guide abilities are offered — replacing off-guide abilities or filling empty slots, never touching an on-guide one except for its OR-alternative (Critical ↔ Fierce/Mystic Aura). A fire mage's ~100+ swap rows become ~7. Unknown weapons fall back to the old behaviour rather than guessing.
- **"Signature swaps only"** sub-toggle in both sims: restrict to the archetype-defining ability (Puncture, Maim, Shield Bash/Retribution, Pestilent Shot, Steady/Silencing Shot, Fireball, Water Strike, Entangle) plus the aura choice.
- **The lab's Crit Aura option is retired** — subsumed by guide-based aura swaps that respect each fight's own loadout; the estimated sims-per-fight for swaps drops an order of magnitude with it.
- **Found and fixed underneath**: the style detector read only the main-hand slot, so every two-handed build (bows, staves, tridents, bulwarks) was silently offered universal abilities only — no elemental or ranged swaps at all.

### The lab reads the same buffs as the sim

- **The live clear-rate readout was scoring against buff levels frozen at page load** — its community buffs came from a map written once at login, so tiles and hovers drifted from the Lab Sim (which reads live levels) for the whole session. Both now build community buffs through the same code, so they cannot diverge. Combat XP readouts also gained the community Experience bonus they'd always ignored, and the sim baseline for Moo Pass subscribers no longer understates XP.
- **House rooms work in every lab scope now** — and the old separate Configure-only pass is gone entirely: house rows used to be measured against their own baseline on their own seed (not comparable with the rest of the table); they now share the analysis's baseline and paired trials, and a whole-run candidate is simmed against each fight at that fight's own level.
- **The Configure-fight enemy level finally defaults sensibly**: a level-source picker (Sim max / Skip level / Configure value) shows the resolved level inline. Default is Sim max — unless you've typed something other than 100 into the Level box, which is read as intent and respected. Skip level prefers a Recommend run's set-percent threshold, falling back to your configured skip; every fallback is shown, never silent.

### The budget planner spends the money

- **The empty 500M plan is fixed**: the planner demanded every gain clear the run's 1.96σ noise bar, and on the profit axis a real 0.4% improvement never can — so everything was skipped as "within noise" and the plan came back empty. It now prefers statistically-measured rows exactly as before, and only when that buys nothing re-plans on the estimates with an amber "Ranked on estimates" note, so you always see the best affordable set. Multiple ability upgrades can share one plan (each ability is its own key; two targets for the same ability still pick the better one).
- **Market on an ability row pre-fills the book count**: the Buy Listing quantity arrives set to the books the upgrade actually needs (the button's tooltip names the count); gear rows still fill 1.
- **Score is configurable**: choose the scoring depth (Top 5/10/15/All, default 5 — the header says which is active), and optionally paint the top nine scores in a green→yellow→red gradient ranked by score, not table order. Both live in the ⚙ Columns popover.

### Three more reasons to look up

- **Labyrinth run finished**: fires once per run when a run stops being active, reporting the deepest floor reached. The game's payload carries no outcome field, so the alert honestly covers all three endings — cleared, lost, or exited — and the help text says it can't tell which.
- **Combat death**: your own death count rising (party deaths ignored), edge-triggered with the running total, capped to one message per killing zone.
- **Enhancement target reached**: when an enhance-until-+N action hits its target, read from the game's own action data rather than the switchable tracker.
- All three are off by default; the "market listing filled" idea was skipped because it already ships.

### The listing says who built what

- **`docs/GREASYFORK.md`**: a paste-ready "Additional info" body for the GreasyFork listing — the fork's biggest changes since diverging from upstream, and a Credits section that makes every attributed script visible from the listing itself (bot7420's MWITools, Celasha's Toolasha, Frotty's MWI Combat Suite/Scaley Way Idle/OPanel, Q7's market history, jigglymoose's JIGS, dakonglong's labyrinth calculator, and the combat-sim team), linking the full per-file licence record.
- **The `@description` header** now identifies the fork, its major additions, and the credited authors in one line, so the recognition rides with the script itself.

### The session starts when combat does

- **The Combat Level session no longer waits for its panel**: tracking now arms on the first battle and joins every later battle to the same run, so opening the panel an hour into a grind shows the run's duration and exp — not `5s` and `measuring…`. Leaving combat marks the next battle as a new session; figures stay readable after a run, and Reset still re-baselines from now. The Start value says whose clock it is.
- **Drop Luck and Over Expected % are one tile** ("Drop Luck & Expected", under Drop Luck's key): each row shows the percentile and the ±% over expected side by side — per player in a party with a TOTAL row, chest percentile plus chests-against-owed in dungeons, and `—` for a half not yet measured. Both tiles' display options still apply. A layout that only had Over Expected on needs one click in overlay ⚙ to re-enable the merged tile.

### Tokens per hour, finally measured

- **Task completions are now recorded** — from the same quest stream everything else reads, on the claim itself. Rerolls replace the pending snapshot instead of booking it, discarded or vanished tasks are never counted, re-delivered claims dedupe, and a login's whole-board state is baseline, not payday. Stored per character in rolling 8-week ISO-week records.
- **The Task Tokens tile earns its rate line**: `tokens/hr this week` beneath the board value, on wall-clock time between your first and last claim (the tooltip names the sample and the basis; under two claims shows no rate rather than a fake one).
- **Task statistics gains "Claimed Tasks (last 7 days)"**: tasks, tokens, coins, both hourly rates, the measured span — and reroll spend over the same window tied in for a **Net Task Income** figure, plus your last five completions.

### Zones compared on even footing

- **"Max-tier Food" option for all-zones sims**: substitute each equipped food slot with the strongest same-purpose food on the market (never a downgrade, never an unpriced item, your eat-triggers kept) so weak food dying in hard zones stops distorting the comparison. Sim-only — your real loadout is untouched. The headline badges the run (hover names the swaps), the CSV gains a Food column, and the stored all-zones snapshot carries the flag so the goal planner can tell a max-food comparison from your real earnings. Drinks are left alone on purpose: in this game every restoring consumable is food; drinks are buff coffees and have nothing to do with dying.

### The skilling sim sims your skill

- **Tool candidates are scoped to the skill being simmed**: a Cooking run no longer evaluates chisels. The rule reads item stats, not a list — a piece qualifies only if it carries the simmed skill's speed/efficiency or all-skilling speed/efficiency, which also stops rare-find charms from outranking real speed tools in "best per slot". All-skills runs are untouched.
- **Community buffs join the skilling sim**: Production Efficiency, Enhancing Speed, Gathering Quantity and Experience appear as candidates exactly where each one actually moves the simmed skill, in their own table — priced honestly as donated cowbells per minute (there is no per-player gold cost for a community level), capped at Lv20.
- **The XP baseline was missing the Experience buff entirely** — the level rode on the player data and the metrics had a wisdom branch waiting, but nothing connected them, so every XP/room figure (and everything ranked against it) was computed with the server's biggest permanent buff off. Fixed, with buff values read from game data.

### The buff tells you before it leaves

- **Community buff expiry alerts**: get notified a selectable lead time (default 15 minutes, 5–120) before a community buff's _actual_ expiry — read from the game's own expireTime, never guessed from a last-seen duration. Master toggle plus per-buff toggles for all five buff types, off by default. A buff extended by new donations re-arms automatically; one expiry never double-fires.
- **Two core staleness bugs found en route, fixed**: the `community_buffs_updated` message could be silently dropped as a duplicate when two donations opened identically (the changed expiry sits past the dedup hash window), and community buff levels were only ever read at login — the tea optimizer, efficiency and profit calculators all quietly used launch-time levels as the server buff moved. Levels now track the live message.

### The sim comes home

- **The community buff cap is 20 after all** — the earlier raise to 30 was a misdiagnosis (the real fix was the at-cap "what the buff is worth" row, which stays). The advisor, the sim editor's inputs, and the tooltip all agree on Lv20 now.
- **Reset to Me / Reset to Party**: after importing other players, one click restores your own live character, or your current party — party members' loadouts come from their shared profiles (real plumbing, not guesses), and anyone whose card you've never opened is named in an amber note telling you to open it once and reset again. "Reset to Party" greys out when you're not in one. Zone/tier/hours stay put. The lab sim shares the editor, so it gets both buttons too.

### The combat sim answers back

- **Community upgrades work**: the candidate generator capped community buffs at level 20, and the live buffs sit at or above it — so "Community" alone always evaluated nothing. Ceiling raised to 30, and a buff already at the ceiling now shows what the buff is _worth_ (Lv30 → off) instead of showing nothing. Also fixed: community and drink rows were silently dropped from multi-fight lab analyses by a loadout check that treated them as equipment.
- **The Columns popover stays closed**: a duplicate `display` declaration meant every re-render (sort, tick, replan, new analysis) rebuilt it open. One declaration now, and a new analysis closes it.
- **"within noise" leaves the collapsed row title** — the per-metric annotations in the expanded detail are untouched.
- **Charms are simmable**: the charm slot was skipped entirely because a pure-focus charm read as "no combat stats" (its one stat is a skill hrid, not a number). Charm enhancement levels and next-tier steps now rank like any equipment; changing the focused skill is deliberately not a candidate.
- **Every buyable row gets a Market button** — equipment at its level, ability rows jump to their book — and ability rows gain "Save for this" straight into eWatch. Lab sim rows inherit all of it.
- **The all-zones Results table reads better**: per-skill XP columns that are zero everywhere are hidden, numbers right-align with row striping, a sortable Score column rank-blends XP/hr and profit (same scoring philosophy as the Upgrade tab), the best-XP and best-profit zones are badged with a headline line above the table, and Score exports to CSV.
- **Single-item swap labels carry both sides' levels** ("Old Tunic +4 → Kraken Tunic +7"), matching the lab sim's multi-piece labels; the refined-clamp path rebuilds labels instead of regex-patching them.
- **House candidates apply correctly everywhere**: the shared candidate applier had no house branch and simulated the unchanged character (a confident +0.00%); the branch exists now.

### The lab sim grows up

- **Task Fight is gone from the lab sim** — lab targets can never be tasks; the sim now passes a hard "no" and runs recorded with the old flag still say so in their labels rather than passing as ordinary runs.
- **Lab upgrade rows read like combat sim rows**: names wrap instead of running one line, and every row carries the same handoff buttons — "Save for this" (Equipment Savings), "Watch" (watchlist), and the shared builder's newer buttons ride along automatically.
- **Multi-item swaps name every piece's level**: "Royal Nature Robe Top +7 + Royal Nature Robe Bottoms +7 → Royal Fire Robe Top +7 + Royal Fire Robe Bottoms +7" — no more trailing "(+7)" covering the set.
- **House Rooms join the lab sim's Upgrade tab**: one-level-up candidates for every combat-relevant room, costed at build cost (coins + materials at buy price), ranked on the same Win Rate / Gold-per-1% as everything else. Configure-fight scope for now — the analysis says why when unavailable.

### eWatch learns abilities

- **Ability levels are savings goals now**: an "Ability Levels" card in Equipment Savings tracks "Fierce Aura Lv46"-style targets — book cost at market (unpriced stays unpriced, never free), progress bar and ETA from your gold, green "Reached" when you get there, ✕ to remove. Add them by hand from Edit mode (learned abilities first, next level pre-filled), or hand them over from the sims. Ability goals join the headline candidates, the overlay tile's "what's next", and the Everything total.
- Under the hood the savings record has one writer now — the panel and the goals API go through the same door, so neither can drop the other's edits.

### The overlay fits the screen it's on

- **A floating launcher on mobile**: the overlay switch lived in the character column's tab strip, which a phone only shows on the inventory screen — so the overlay was unreachable everywhere else. Mobile mode now gets a small draggable round launcher pinned above the game UI on every screen (position remembered); the desktop tab switch is unchanged.
- **No more jumble**: a desktop tile layout wider than the phone's canvas used to be clamped tile-by-tile into the same space — columns dragged on top of columns. When the saved layout doesn't fit, tiles now re-flow into as many columns as the width actually holds (one below 500px), in the desktop layout's reading order, with overlap impossible by construction. The saved desktop layout is never written to — editing is disabled while flowed (the gear says why), and a wide screen gets the exact desktop arrangement back.
- **It scales when resized**: the panel clamps to the viewport (display-time only) and re-flows on window resize, rotation, or the panel's own width changing; the gear popover clamps too.

### Panels behave on a phone

- **Floating panels stay on screen**: every remembered panel clamps to the viewport on open and again on resize/rotation — a desktop-saved position restored on a phone no longer hangs off the edge, and the clamp now insists the whole panel (close button included) is visible, not a grabbable strip. A panel's minimum size also caps at the viewport, which is what actually pushed Treasure off a 400px screen. Nothing is written back — the desktop layout is untouched on the next big screen.
- **Treasure's ✕ is always reachable**: the header wraps on narrow screens and the close button sits pinned top-right out of the flow, with a bigger touch target in mobile mode.
- **Treasure and PFormance buttons toggle**: a second click closes the panel, matching the Overlay button.
- **The mobile-mode setting shows its detection**: the Auto option now reads "Auto-detect (currently: mobile/desktop)" — the hardware reading, so an override's effect stays distinguishable from what was detected.

### Sync works from a phone, and can't eat itself

- **`@connect gist.githubusercontent.com` added to the userscript header**: reading a truncated gist file refetches it from GitHub's raw host, which mobile userscript managers silently block when undeclared — the phone's "Could not reach GitHub" pull failure. Reinstall the userscript to pick the header up.
- **A device that has never synced now confirms before Push overwrites an existing gist** — a fresh phone pushing before its first Pull would have replaced the account's whole gist with an empty database. The dialog says to Pull first; automatic pushes on a never-synced device simply decline.

### The manifest error says what it means

- **"Manifest is corrupt" now tells the truth**: a manifest file that was replaced by hand (e.g. a backup pasted over `toolasha-sync.json`) is called that, with the gist id in the message; a network failure while reading the manifest keeps its own classification instead of masquerading as corruption. Either way the remedy is unchanged and real: pushing from a good device rewrites the manifest and repairs the gist.

### Everything fits now

- **The sync payload is gzipped before upload** (and before encryption — ciphertext doesn't compress). Real numbers from a played-in account: a 7.8 MB "Everything" payload that failed the 9 MB gist ceiling once base64-inflated now stores at 1.6 MB encrypted, with 5× headroom. Old uncompressed gists still pull fine; the manifest says which format each gist holds.

### The gist can keep a secret

- **Optional sync passphrase** (Settings → Cross-Device Sync): when set, the sync gist holds AES-256-GCM ciphertext instead of readable JSON — useless to anyone holding the gist URL, the token, or the GitHub account. Same passphrase on every device; a wrong or missing one is a clean, named error with the fix in the toast, never garbage fed to the importer. No passphrase = exactly the old behaviour, and old unencrypted gists still pull fine. The passphrase is stored locally like the token (the help text says precisely what that means) and is never uploaded.

### Console-dump fixes

- **The Shrine Upgrade Planner stays in its box**: the exchange modal doesn't grow for injected content, so the expanded planner now scrolls within a bounded area (like the ranking table above it) instead of rendering past the modal's bottom edge.
- **Self-removing listeners no longer skip their neighbours** (upstream port, 03204a5): a cleanup handler that unregistered itself during character-switch dispatch shifted the listener array under the loop and deterministically dropped the next handler — ten feature modules do exactly that. Dispatch now iterates a snapshot; pinned by tests in both data-manager and websocket.
- **The combat profit view remembers itself again**: its saved mode was read at module scope before the database opened, so every load got the default back (the `[Storage] Database not available… combatProfitView` warning). The read now waits for storage to be ready.

### The token knows its own price

- **Guild token value now uses real exchange rates**: read from client data when the game exposes them, otherwise captured automatically from the exchange dialog as you open it (per credit colour, ratio-based so batch amounts don't distort it), with the manual setting demoted to last resort — and marked "assumed" when it's all we have. The valuation picks the credit colour worth the most gold per token, not just the biggest credit multiplier.
- **`Toolasha.debug.tokenExchange()`** dumps the full table — every known colour, its rate, its source, and which conversion won — so a rate the capture hasn't seen yet is visible at a glance. Takes `'bid'`/`'average'` for the pricing side.
- **`/shrines` ends with the token's worth** (`Guild token ≈ 1.0Kg via Green Guild Credit`), including how many exchange rates are known.

### The goal planner learns two more trades

- **Alchemy ranks without a DOM**: the best-items enumeration moved into a pure module the planner calls directly — every figure is the real calculator's, fees and under-level penalties included (an under-levelled item is offered with its penalty priced in; an action you can't do yet is dropped). Memoised on your alchemy level, gear, teas and price freshness, capped at the top 12.
- **Combat income joins gold goals** — from your all-zones sim snapshot, labelled with its age (`from your all-zones run 3d ago`) and flagged `(stale)` past 7 days or `(gear changed)` when your equipment no longer matches the run. Never silently withheld; no snapshot at all becomes a note under the add form telling you an all-zones sim would add combat rates. Combat XP is deliberately not quoted against skill goals — the snapshot only keeps a cross-skill total.

### Housekeeping

- **The WebSocket prototype wrapper is gone** (upstream port, 5824eca): it was a redundant third interception path that broke `removeEventListener` for message listeners on _every_ WebSocket on the page and made duplicate registrations fire twice. The two guarded paths that remain intercept everything they did; native listener semantics are restored and pinned by tests.
- **The dungeon chest→key maps live in one place now** (`src/utils/dungeon-keys.js`): combat-stats and the combat-sim adapter each kept their own copy — with the two names swapped between them — and four more modules imported the constant through the stats calculator. Everyone now reads the same table under one pair of names. Pure extraction, no behavior change.
- **The CI bundle ceiling moves 2.5 → 3 MiB** with the reasoning in the workflow: the ui bundle grew honestly to ~60KB under the old line; the guard exists to catch sudden duplication jumps, which still trip it.

### The books balance: first swings were invisible

- **The Sim Accuracy undercount is fixed**: the battle feed only reports monsters that changed, and the replay refused to score a monster's first appearance — so the opening swing on every monster of every wave went unrecorded (12–19% of swings, ~21% of damage on real fixtures). Wave baselines now seed from the battle-open message; the reported swings/damage deficit should vanish without changing anything about how you fight. The clock, task damage, and spear multi-hit were all ruled out and pinned by tests. The check sims 12 hours of the zone's own encounter mix — that's now stated on the panel.
- **Recordings no longer stop themselves during sim runs**: a stale persisted record-target could restore late (main-thread contention while a sim launches) and stop a longer recording at the next boundary; target restore is now explicit and never touches a live recording.
- **Record to ±%**: a third target unit stops recording when the measured noise band reaches your figure; the suggestion button now reads "Record to ±5%".
- **Saving works again and covers everything**: the DPS-panel download carries every segment of the session (oldest keep per-fight summaries past the tick-retention cap, and the file says what's included); Sim Accuracy gains a "Save recording" button exporting the full check bundle — observations, loadout snapshots, clocks, comparison, history — for sharing.

### Iron Cow re-forces instantly, and one more clickable name

- **Applying a preset (or All Off / Restore) while Iron Cow Mode is on now re-forces the locked settings immediately** — previously the stored values changed underneath and only got forced back on the mode's next apply. The mode's snapshot of your real pre-IC values is never touched by the re-force.
- **Community-buff announcements are /profile-clickable** ("KimNG has added 31 minutes of community buff…").

### Settings you can actually get to

- **Picking a setting in Ctrl+K now opens settings itself**, expands the group it lives in (temporarily), scrolls to the row, and flashes it — composing with the search pre-fill.
- **Presets lead the settings page**, and **Iron Cow Mode is now a chip among them** — a pressed-state toggle that stacks with the one-shot presets ("select it and others"); the old dedicated card is gone, mechanics unchanged.
- **"Copy Settings to IC Characters"** beside the all-characters copy: game modes are recorded at each login, the copy targets known iron cows only, and characters whose mode is not yet known are skipped and named rather than guessed.

### The recorder answers back

- **Record for a target**: set N fights or M minutes on the Sim Accuracy panel; recording stops at the fight boundary after the target (never mid-fight), the label counts progress, the last target persists per character.
- **XP is now recorded and checked**: per-fight XP gains come exactly from the battle totals (no new plumbing), compared with proper noise bands and a per-skill split; **drops are recorded and shown but deliberately not verdict-ed** — the sim carries no drop table to band against, and Drop Luck already answers that question properly.
- **More to argue with**: a one-click sample-size suggestion ("≈85 more fights for ±5%"), DPS decomposed into swings × hit rate × damage-per-hit with individual bands, beyond-noise deviation hints ordered by what is actually known, and a small history of past checks to spot drift.

### The black box was ours

- **The black band at the foot of action panels is gone**: the sticky Queue/Start strip painted itself near-black, and against the game's dashed catalyst slot on alchemy tabs it read as a "black Consumed Item box". The strip stays sticky but now renders in the game's own colors — no invented paint in either direction; the catalyst slot was confirmed fully native and untouched.
- Also found en route: the alchemy action pin shared a CSS class with the picker-tile pins, rendering as an invisible-on-desktop, black-square-on-touch artifact over the catalyst slot. Renamed and fixed.

### The recorder grows up

- **Recordings snapshot your loadout at record time** (gear, levels, abilities, food/drink slots, house, shrines) and the 12h check sims against the snapshot — the "gear is read as worn now" caveat is retired for new recordings; mixed-gear samples say so.
- **Recordings survive refresh**: summarized checkpoints at every fight boundary, recovered on startup ("Recovered N fights from an interrupted recording"), cleared on clean stop, standing down when the disk is full.
- **Record as long as you like**: hitting the buffer cap now banks the segment at the next fight boundary and keeps going (no fight lost at the cut); the label counts cumulative fights, and the observation window widened to ~4 hours of continuous combat.
- **Small samples stop lying**: the panel shows the measured noise band ("24 fights — ±3.1% noise; differences inside that band are not findings"), computed from the actual per-fight variance, and deviations inside the band render dim/inconclusive instead of red or green.

### Idle members are clickable

- **Names in the guild Overview's "Idle members" list fill `/profile Name` on click**, same as chat names.

### Mid-run restock honesty, and the tooltip that would not die

- **The lab planner stops suggesting purchases that cannot help**: mid-run, the shortfall line reads "4 shrouds needed · 0 left this run — restock applies to your NEXT run", priced against inventory and the tier you actually use. Turns out tiers matter: a Basic shroud caps at room level 50 and fails 2%/level above it, so the old cheapest-tier hint could suggest an item that would outright fail on your floor. Beacons and torches differ by tier too (reveal radius, preserve chance) — preferences follow what you hold.
- **The room-forecast hover panel can no longer outlive the labyrinth**: a watchdog kills it the moment its anchor leaves the DOM, grid rebuilds and scrolling hide it immediately — no more refresh to dismiss a stuck tooltip.

### Five new tiles and layouts that follow what you're doing

- **New overlay tiles** (all off by default): Queue Time Left (when do I go idle, ∞-aware), Enhancement Session (live attempts/spend), Next Goal Step, Task Tokens (board tokens + coin value — labeled as what the board pays, since no completion history exists to make a true rate), and Guild Trials pace (with honest data-age: "T7 · eta · 2h ago", going "stale" past the hour).
- **Bundled layout presets** — Combat, Skilling, Labyrinth, Market — appear in the picker as read-only "· preset" entries; Save-as under the same name makes your own shadowing copy.
- **Optional "Switch layout with activity"** (off by default): maps layouts to combat/skilling/lab/market, detects what you're doing (10s stability before switching, never while unlocked), and a hand-picked layout pauses auto-switch until the activity actually changes.

### Companion privacy, a Record button where it belongs, and mooket hygiene

- **Toolasha no longer names the companion script anywhere** — registry examples, marker strings, hold-provider docs, and old changelog entries now use neutral wording; the public registries the companion calls are unchanged.
- **The Sim Accuracy panel gains its own Record button**, driving the same recorder as the Damage panel (labels reflect a recording started anywhere; stopping here feeds the accuracy check instead of downloading).
- **Mooket never receives test-server data**: the one outbound path (the order-book WebSocket) is suppressed on test.milkywayidle.com with a one-time console note; fetching/display unaffected.

### Build Score opens something now

- **New Build Score breakdown panel**: the tile double-clicks (and an own-profile "breakdown" link on the score popup) into the full tree — Combat and Skiller scores with Equipment / Abilities / House / Guild Shrine sections sorted largest-first, each unfolding to its per-item, per-ability, per-room, per-buff lines, a top-5 contributors list, and the header finally saying what the number means: what the kit would cost to buy, in millions.

### The watch card stops overcharging, and laddering becomes a mode

- **Real pricing bug fixed**: the equipment-watch cost search refused protection strategies below your start level, so a +5→+7 run was quoted at 214M when the genuinely cheapest protected run (protect from +2) costs 84M — a ~2.5× overquote that also made laddering from a lower copy look cheaper than it is. Every path now searches the full strategy set; starting higher is never dearer.
- **A Direct / Ladder button on each watch target**: pick which run the headline cost, progress bar, and ETA track (per target, persisted); the other path stays visible as the secondary line, and a vanished spare falls back to direct while remembering your choice.

### Iron Bell Farming

- **"Iron Cow Farm" is now "Iron Bell Farming"** everywhere you can see it (panel, settings, command palette); stored data and settings survive the rename untouched.
- **New "Iron Bell next step" overlay tile** (off by default): one line showing the current plan stage ("Foraging 62/80") or "Loop ready — N bells/week", opening the panel on double-click.

### The overlay earns its screen space

- **Empty tiles stop shouting**: a tile with nothing to say renders as a dim 20px name strip (value/watch tiles) or hides until its first data (measurement tiles like DPS and drop luck), instead of a full-size "Nothing tracked yet" wall. A gear-menu dropdown (By tile / Compact / Hide / Full) overrides globally, and unlocking the layout always shows everything so you can still place tiles.
- **Fresh characters get a curated 8-tile default** (net worth, coins, build score, status, session/EPH, XP/hr, profit, time to level) instead of everything at once; existing saved layouts are untouched and keep the old behavior.

### Overlay tiles open their panels

- **The Net Worth, Coins, Market Listings, and Inventory Value tiles now open the networth history chart** on double-click (single tap on touch), with the hint in the tooltip — matching the 26 tiles that already opened their feature's panel.

### Iron Cow Farm

- **New "Iron Cow Farm" panel** for cowbell-farming characters: the standard plan as a self-ticking checklist (skill levels, jewelry, house rooms read from your character; the loop stage unlocks when prerequisites are met), the starfruit → decompose → coinify loop costed on the iron cow rule that nothing is ever sold (coinify's vendor coins are the only income, decompose fees the only outflow, no catalysts), and the payoff in bells: bells/hour, bells/day, a week's projection, whether loose bells or the bag of ten is the better buy, plus low-gold-buffer, queue-slot, and offline-window warnings.

### Multi-target lab analysis gets the big swaps

- **Combined forced-armor swaps now appear under All targets / Chosen targets** — the multi-fight analysis never generated them before. Same keep-gear costing note as single-fight, pooled per fight with the standard win-rate aggregation; sets that also swap the weapon only apply to loadouts holding that weapon.
- **Ability swaps are allowed in multi-fight scopes too**: swaps only weigh in loadouts that actually cast the replaced ability, one decision is one row, and a big run shortens each simulation rather than leaving fights out — the status line says how many simulations it comes to before starting.

### Dungeon keys cost whichever way is cheaper

- **Dungeon profit charges each entry/chest key at the cheaper of buying or crafting it** (craft cost through the real crafting calculators at your efficiency; craft time shown separately, never priced as gold). Every key row says which side won and the saving — and a key with no market listing but a valid recipe now counts its craft cost instead of being silently dropped.

### Building levels cap at 20, trial tiers at 21 — and never each other

- **Guild building bonuses clamp at the real level-20 cap** (the Buildings tab's "Lv. x / 20") instead of trusting and extrapolating any higher figure; the trial tier ladder keeps its separate 21 tiers (levels 100→300), and the trial badge was confirmed to never touch building tiles.

### The task board stops fighting the game

- **The zone-index badge stops churning**: it removed and re-inserted its own span on every observer tick — a permanent 100ms mutation loop on React-owned task cards that also destabilized the profit rows' task keys. It now touches the DOM only when the index actually changed.

- **The free MooPass reroll works again**: the reroll-cap protection was reading the pass count in the button label as a coin cost and cancelling the click. Cap checks now only ever fire on "Pay …" buttons, and per-task protection still covers free rerolls (they destroy the task the same).
- **Confirm Discard actually discards, and buttons stop flashing**: while a card is showing a confirm step (reroll chooser or discard), every Toolasha injector now leaves it completely alone — previously the sorters/badges/profit rows rebuilt the card mid-flow, wiping the game's pending confirm state. The outline flicker was two features alternately stripping and redrawing the same style; resolved.

### The lab planner reads the right bag

- **During a run, supply counts come from the run itself** (what the game's Supplies row shows), not your inventory — the game moves torches/shrouds/beacons into the run at start, so the old inventory readout was counting supplies you couldn't use. Between runs it still reads inventory for planning the next entry, and the readout labels which it's showing ("this run:" vs "held:").
- **The readout uses the game's item icons** (best tier held) instead of emoji.

### Dungeon run history stops lying

- **A run-start key count can no longer end a fresh run at wave 0**: the completion fallback now requires the run to have progressed (or been restored mid-run), so the pre-scan race banks a start anchor instead of a seconds-long fake run.
- **A websocket-detected completion no longer hands its start anchor to the next run** — two runs can't merge into one duration anymore.
- Player names with dashes parse in key counts, the milkonomy export names the back slot like every other slot, and page-load run pickup applies the same battleId/staleness guards as live restore (keeping the hibernation flag).

### Backups say whose they are, and adoption asks first

- **`Toolasha.debug.claimLegacyData(charId)`** force-completes adoption after a backup restore: it hands every bare legacy value to the chosen character, overwriting the stale scoped copies that would otherwise shadow the restored data (the market listing log merges instead, so recent entries survive). `{dryRun: true}` previews.

- **"Back Up Everything" filenames now carry the character and game mode** — `toolasha-backup-2026-08-04-millennium44-MC.json` — matching the hand-renamed convention; MC/IC/LC for standard, iron cow, legacy iron cow.
- **Adoption is consent-gated**: the first time pre-scoping data is found, a dialog asks which character should inherit it (heuristics only preselect the recommendation) — nothing moves until you confirm. Reopen anytime with `Toolasha.debug.chooseDataOwner()`.

### Labyrinth: split apart, supply-aware, and honest mid-fight

- **The 5,300-line labyrinth module splits into six** (formulas, pathing, outcomes, sim cache, recommendation, live readout) with byte-identical behavior, guarded by seam tests.
- **The shroud/beacon planner reads your bag**: beacons clamp to owned ("4 set / 3 owned"), the summary splits confirmed vs assumed shroud needs ("13 needed · 2 owned — 2 confirmed, 11 assumed for unrevealed rooms"), torches are checked against the route, a cheapest-tier restock hint prices the shortfall, and the toolbar shows live held counts.
- **The live clear-chance no longer swings wildly before the lab tab is opened**: the sim replay could not identify the room on a mid-run reload (path never seeded, and a fight joined in progress never replayed due to a zero-clock gate), so a noisy health extrapolation was quoted as a point figure. The replay now works from the first tick via battle data, and an unearned extrapolation displays as a damped range ("Clear 50–75%?") instead of a jumping number — same math as the room tab, now reachable.

### Adoption accident: fixed, and repairable

- **The wrong character can no longer inherit your data**: characters with "test" in their name never adopt legacy values, and neither does a character with no networth history while another character on the account has some — the hole that let a freshly logged-in alt claim everything by being first.
- **`Toolasha.debug.moveScopedData(fromId, toId)`** moves every adopt-class store (watchlist, savings targets, treasure tally, enhancement sessions, reroll data, panel state, …) from the character that wrongly claimed it to the right one, skipping anything the destination already owns; `{dryRun: true}` previews the moves.

### The dungeon tracker earns its tests

- **252 new tests** for the dungeon tracker core (run lifecycle, restore guards, key-count parsing, per-character scoping), the chat-annotation parser (all six timestamp formats, run numbering, team attribution), collection filters (ranges, sorts, badges, favourites), and the milkonomy/profile export shaping. Four latent dungeon-tracker/export bugs were pinned by tests and documented for a future fix.

### History stops rewriting itself on every event

- **The append-heavy history stores split into per-period records**: networth snapshots (monthly), the loot log (hourly), and alchemy sessions (daily — previously rewritten in full on every ~2s action, unbounded). Saves now write only the chunk that changed; pruning deletes old record keys instead of rewriting the survivors. One-time migration splits existing data lazily and falls back to the old key untouched if the disk is full — nothing bricks or half-migrates.
- The account view, sync, backup, and the market-cow adoption check all read both shapes; networth snapshots now also carry the Guild Shrines value so the new chart series gets data.

### Tokens get a price, shrines get a debug command

- **Guild tokens are now priced through the guild shop's token→credit exchange** (live client data when present, else a settable rate defaulting to 1 credit/token, 0 to turn it off). Shrine upgrade rows rank on credits _plus_ tokens — token-heavy top levels sink, credit-cheap levels rise — with the valuation labeled "via credit exchange" everywhere it appears, including trial token payouts.
- **Builders Hall and Treasury bonuses use the confirmed 2%/level formula** (checked against the Build dialog: Lv10→11 = +20%→+22%), so trial payout projections apply your guild's real +20%/+10% instead of "base figures"; manual overrides remain as a last resort.
- **Trial tiers cap at 21** (level 300), fixing the old hard-coded 20.
- **`/shrines` in chat** prints a local-only report of your shrine buff levels, guild building levels, and when they were captured; `Toolasha.debug.shrines()` returns the same from the console.

### Cross-tab sim exports can't lie about whose gear they are

- **The combat-sim export bridge stamps every payload with the writing character**; per-character reads (character data, battles) refuse a mismatched stamp with a clear message instead of exporting another tab's gear, stale payloads warn, and legacy unstamped values still work. Shared data (client data, profile list) is deliberately exempt.

### The variance math earns its tests

- **180 new tests**: the enhancement variance formula and gamma percentiles now have hand-solved exact-rational fixtures (derived by an independent second-moment recursion — they agree to nine decimals) plus a seeded Monte Carlo cross-check and a worker-blob serialization guard; the alchemy Best Items and profit display wrappers get full coverage; and the action-speed, drink-coverage, and scroll-buff utils are pinned down.

### Listing-age estimates get sharper over time

- **The anonymous id→time anchor pool now grows**: every listing you record, import, or observe with a real timestamp in the order book adds an anchor (deduped, capped at 3,000 with eviction that thins dense clusters and never gives up the range endpoints). Clear History keeps the anonymous anchors — the dialog says so — so wiping your personal log no longer degrades age estimates.

### Missing-material tabs retire themselves

- **Pinned marketplace tabs now watch your inventory**: partial acquisitions update the "Missing: N" badge, and when the needed count (at the exact enhancement level) is reached the tab flashes "✓ Acquired" and removes itself. Manual dismiss, "✕ All", and marketplace close all unsubscribe cleanly.

### Guild Shrines series in the networth chart

- **The networth history chart gains a Guild Shrines line** with its own legend chip, tooltip row, and summary stats. Snapshots recorded before the field existed draw a gap, never a fake zero. (The snapshot recorder picks the field up in the storage-migration change alongside this one.)

### Guild trials get pace, ETA, and payout math

- **Trial cards on the In Progress tab now carry live info**: measured party DPS (combat) or pool fill rate (skilling) read from the cards themselves, ETA to clear the current tier against the trial clock, how many tiers the hour is on pace for, and the next tier's projected size (+1% per participant applied exactly; the tier growth curve is fitted from observed tiers, never invented — it says so until a second tier gives it a curve).
- **A payout block shows what the week is worth**: Guild Points banked vs on pace and tokens per eligible member (plus the 50% participant bonus), using the official formulas, with Builders Hall and Treasury bonuses read from captured guild building levels — or manual overrides in settings, with an honest "base figures" note until either arrives.
- Trial state persists per guild, resetting with the Friday week; the official trial rules are pinned in the module docs.

### Guild shrines in your score and your net worth

- **The profile score panel gains "+ Guild Shrine" lines** under both Combat Score and Skiller Score — each buff sorted into its bucket by the game's own combat flag, tokens in the tooltip, same coin-cost-per-million convention as House and Ability. Only shown when shrine data has actually reached the client; other players' profiles never show a fake zero.
- **Net worth gains a Guild Shrines row** under Fixed Assets: the cumulative credit cost of every shrine buff level you've bought, priced at your networth pricing mode, with per-buff breakdown rows and the same exclusion toggles Houses and Abilities have. Tokens are counted and shown, never priced into gold.

### Goal Planner

- **New Goal Planner panel**: state a goal — a gold amount, an item at an enhancement level, a skill level, or a house room — and get the ordered steps to it with gold and time on each: earn (best of your gathering/production rates), buy vs craft (whichever current prices favor), the enhancement run costed through the real Markov chain with your own stats, training steps inserted before crafts that need levels, and a funding step whenever the plan spends more than you hold. Steps strike through as they're satisfied; plans reprice on refresh; goals are per character.

### Sim state scoped, and honest enhancement numbers in the tooltip

- **The last cross-character leaks in the sims are closed**: the all-zones snapshot, upgrade-tab selections (both sims), lab skilling loadouts, and the new lab comparison runs are all per character now. Snapshots and loadout maps from another character are discarded rather than inherited — a sim result against someone else's gear is worse than none.
- **The marketplace ENHANCEMENT PATH says whose stats it used**: a chip on the header reads Yours, Manual, or Pro — Pro filled amber so it can't be mistaken — and clicking it (or pressing P while a tooltip is open) flips between your detected stats and the pro kit (enhancing 140, +13 Celestial, ultra + blessed tea, +10 gear), rebuilding the visible numbers in place. Persisted as a normal setting; untradeable items always use your own stats.

### Doubled profit line fixed, stuck marketplace tabs cleared

- **The action bar could show two "Profit: …/hr · remaining …" lines** with different remaining values: a game re-render orphaned the old profit node while only the time node got cleaned up, leaving a stale copy behind. Injection is now idempotent — every stale widget is swept before a fresh one is placed. The remaining basis itself was always correct (material-and-gold-limited actions, not raw inventory).
- **Pinned missing-material marketplace tabs can finally be dismissed**: every pinned tab (lab-sim budget picks, house costs, crafting plans, shopping lists) gets a hover ✕, an "✕ All" control sits at the end of the strip, and the lab-sim budget tabs — the ones that got stuck — now also clear themselves when the marketplace closes, which every sibling feature already did.

### Market and inventory state stops leaking between characters

- **Ten market/inventory stores scoped per character**: watchlist, equipment savings targets, house untracking, alchemy pins, inventory sort, philo calculator settings, consumable planning horizon, market history filters, and the mooket follow list (display prefs stay shared). Your iron cow starts clean; the market cow inherits the existing data.
- **The personal listing log and the shared listing-age anchors were living under one key** — split apart: your own listings are yours per character, while the anonymous id→time anchors every character uses to date other people's listings stay global, so age estimates keep working on characters that never listed anything.

### Combat and labyrinth records stop leaking between characters

- **Eleven combat-side stores scoped per character**: enhancement tracker sessions, consumable trackers and the last combat run, combat session history, labyrinth fight outcomes / sim cache / room logs, sim-accuracy observations, in-progress dungeon runs, dungeon panel UI state, task reroll data, and the treasure tally. Keep-worthy history migrates to the main character; gear-derived data (fight outcomes, sim caches, live trackers) starts clean instead of inheriting another character's numbers.
- **Dungeon runs stay one shared list** (team dedupe across your characters is a feature) but every new run is stamped with who recorded it, and the panel gains a "This character / All characters" filter defaulting to yours — legacy unstamped runs match by roster name.

### Panels and task prefs stop leaking between characters

- **Panel open-state is per character now** — the market cow's panels no longer auto-reopen on the iron cow. Positions and sizes stay shared (panels sit where you put them on every character); only who-had-what-open splits, with the old flags migrating to the main character.
- **Overlay panel layout, task estimate mode, and task-board icon filters** are per character too (the six separate filter keys also collapsed into one record per character). Collection filters move to the standard key format so account-view tooling can parse them.

### Lab sim catches up to combat sim

- **Comparison runs for single-target lab fights**: each fixed-level run is recorded (settings + win rate, tries, deaths per 100), with a pinnable baseline, per-metric green/red deltas, per-row delete and Clear All — and unlike combat sim's history it survives reloads, since lab comparisons usually span sittings.
- **The Upgrade tab's mode dropdown becomes multi-select chips** (Equipment, Ability Lv, Ability Swaps, Combat Lv, Guild Shrine) with a separate target scope: configure fight, all targets, or a chosen subset of labyrinth fights — so "just the fights I'm not already strong enough for" is now expressible. Old mode choices migrate to the equivalent selection; genuinely impossible combinations are disabled with the reason shown instead of silently ignored, and a multi-set single-fight selection runs as one analysis with one shared baseline.

### The sim sees your real abilities, and shrine levels finally arrive

- **Ability desync fixed**: the client never applied the game's ability-update messages — your equipped abilities were read once at login and never again, which is why the sim showed a stale kit after labyrinth loadout swaps. Equips, unequips, displacements, and level-ups now all land (with battle data as a backstop), and a message-dedup window that could swallow quick equip/unequip pairs is bypassed for ability traffic.
- **Guild shrine levels now reach the advisor**: shrine/building levels ride on guild traffic that only arrives when someone opens the guild panel — so they're now captured whenever any message carries them (matched by shape, not by name), persisted per character, and restored at login with a captured-at timestamp. The "no guild shrine levels reached the client" row should retire itself after one visit to the guild page.

### Combat sim results that lead with the answer

- **Headline tiles at the top of the Results tab**: Profit/day, XP/day, Kills/hr (Dungeons/hr + success rate for dungeons), DPS, and Deaths/day — read from the same numbers the detail tables print, with baseline deltas, plus a sub-line of revenue/costs/top-skill XP so the headline is auditable without scrolling.
- **Clear all baselines** in one click beside Export CSV; per-row delete unchanged.
- **Guild shrine upgrades take a target level**: type the shrine level you're aiming for and the advisor prices every level between here and there (credits ranked, tokens shown as info), still warning when the guild's building can't support it yet.

### Clickable names everywhere chat shows one

- **The /profile click trick now covers every name Toolasha renders**: mention-popup sender names, pop-out chat names (including announcements relayed into the pop-out window, which previously had no link at all), and names in the extended chat history buffer (previously looked clickable but did nothing after cloning). One delegated listener and one shared helper replace the per-span wiring.

### Per-character storage helper

- **New `characterKey` helper** (`src/utils/character-key.js`): one shared way to scope stored state per character, with one-time migration of legacy global values — adopted by the main character (never an iron cow; identified by longest networth history) or discarded where inheriting another character's data would be wrong. Groundwork for de-leaking all cross-character state.
- Market-cow detection reads the same `gameMode` field MCS uses, and now recognizes `legacy_ironcow` too — no ironcow variant ever inherits the market character's data.

### Official formulas, ladder costs, and the sim graded against reality

- **Lab math now follows the official formulas you supplied**: exact challenge/treasure/floor-exit reward tables (tokens, Purdora's boxes, refinement chests — no more approximations), grid size, and confirmation our success/work/XP math already matched. The unrevealed-rooms path default becomes pessimistic (needing a shroud), live fight replay defaults off, and a run-once migration delivers both defaults to existing users; the precision setting's help finally describes what it governs.
- **Ladder cost on the enhancement watch**: every watched enhancement now also shows what it costs to enhance your second-best copy (or a fresh base) instead of risking the equipped piece.
- **Ability swaps cost from your actual book level** when owned ("from Lv12" chip), fresh-book pricing only for unowned.
- **Sim panels remember being open** across reloads.
- **Alchemy verified against the official rules**: most math confirmed correct; fixed the under-level penalty missing from coinify/decompose and the coinify fee inconsistency; all fee formulas share one helper.
- **Sim accuracy panel**: replay your recorded fights against the simulator's prediction, deviations flagged only beyond statistical noise.
- **Welcome Back gains a value row** (net gold, coins/hr, XP/hr at your pricing mode); account/sync failures surface as actionable toasts; gist errors classify by status code; and a data-shape canary catches game updates that restructure client data.
- Enhancement cost variance (validated against Monte Carlo) now feeds a companion script's enhance-to-sell rows.

### Upstream ports (verdict-gated) and honest task damage

- **Task damage only counts on task fights.** Sims launched from a task card carry an is-task-fight flag; everything else — zone sims, lab rankings, the upgrade advisor — excludes taskDamage, so task badges and trinkets no longer rank on damage they only deal against your task monster (their on-task value shows as row detail). Both sim panels gain an explicit "Task Fight" toggle.
- **Six upstream fixes ported after verifying each applied to our diverged code**: the page-freezing sort loop in max produceable, storage writes requeued instead of lost on a failed save (adapted to our quota handling), six undefined color constants, real alchemy coin costs in material limits, an O(1) DOM observer buffer, and the enhancement tooltip's target-hourly-rate / minimum-sell-price feature. One item was superseded by our own storage rework (evidence recorded); the melee stab/slash/smash tier split ported separately so weapon candidates only compare within their style.
- **Decompose fee standardized** on (10+level)×5 via one shared helper — two of our files disagreed and no recorded data could settle it, so the upstream-agreeing formula won, with the reasoning documented.

### Advisors sharpened, your own rates guaranteed, and 1,200 new tests

- **Upgrade advisor fixes**: real noise estimates on combat rows (the budget planner's significance guard finally works), profitable swaps rank as "pays for itself" instead of dividing by zero, every row shows its cost basis, unpriced items get their own box, drinks/teas and community buffs and trinkets are now rankable, and combat-level time accounts for the levels raising your rate.
- **Task system fixes**: auto-reroll badges on a real rule (board-median rating vs amortized reroll cost), bulk reroll can't destroy above-median tasks and matches protection's cap semantics exactly, retired tasks feed a payoff history instead of being deleted, statistics show net-of-reroll spend, partial tasks advertise remaining value, token EV reads the actual task shop.
- **Enhancing: your rates, not pro rates.** The shipped manual defaults (level 140, +13 Celestial enhancer, ultra tea, full +10 gear) no longer stand in for you — every field seeds from your detected stats unless you edited it, unearned achievement bonuses are gone, and a "manual params" tag shows wherever overrides apply. Plus: resumed sessions count attempts correctly, earrings get their 5× multiplier, the Chance Cape's success bonus counts in manual mode, mirror breakdowns follow the real optimal path, one shared price rule across tooltip/XPH/tracker, prediction and measurement share one time base, and the worker copies share the one Markov implementation (fixing a level-19 crash and negative failure probabilities).
- **Craft-to-sell**: a Toolasha adapter serves your true per-character craft costs to a companion script's craft rows.
- **Alchemy fixes**: equipment rare/essence find counted (was silently always zero), tea speed bonus applied (six TODO stubs unified).
- **~1,200 new tests** across previously untested modules — gathering/production/alchemy profit math with hand-computed fixtures, networth valuation, listing-age interpolation, dungeon statistics, chat parsing, worker pool, websocket dedup, and more. Suite now 4,044 tests.

### Sync, account view, honest philo math, and lab fixes

- **Cross-device sync** (Settings → Sync): push/pull your data to a private GitHub Gist with a personal access token (settings-only or everything, optional auto-sync, newest-wins with a confirm, chunked uploads, soft failures). The token is stored locally and never uploaded — the payload redacts it.
- **Account view**: combined networth across characters with per-character shares, last-seen, and queue state, from data each character already recorded.
- **Philo gamba calculator corrected**: market tax on sold drops, the under-level success penalty, real action time with your speed/efficiency gear, catalyst tea cost charged, bulk symmetry, enhanced-listing fallbacks flagged, a pricing-mode dropdown (defaults conservative) with an instant | patient profit column, and bonus essence/rare drops.
- **Labyrinth fixes**: expected tokens/boxes weighted by clear chance, equipment wisdom finally reaching lab XP, enhancing rooms carrying XP figures, Find Max unified with the recommendation search (real bounds, the 70% setting, no negative skips — the skip objective stays your set percent), effective combat level from the game's formula instead of a guess, recommend runs no longer wiping the sim cache, consistent knob persistence, and one denominator for measured vs forecast XP/hr.
- Housekeeping: bundle duplication fixed and the CI size limit raised honestly; the bulk task reroll feature is now properly wired (off by default — it spends real rerolls).

### Guild shrines, forecast calibration, roster intelligence, and storage that survives months

- **Guild shrines everywhere they matter.** The combat and lab sim advisors can now rank "+1 shrine level" purchases (credits priced to gold, token counts shown but never priced — stated on each row), the sim editor gets an editable Guild Shrines section, skilling shrines join the skilling advisor (clear-rate and XP metrics), and the build score shows the gold value invested in shrines as its own line. All driven by the game's own guildBuffDetailMap at runtime — no hardcoded tables.
- **Forecast calibration**: the script now grades its own profit predictions against what your runs actually produced, per skill, with a persistent-gap flag — the only way to catch silent balance changes. Ctrl+K → Calibration.
- **Guild roster view**: contribution shares (7d/30d), gone-quiet flags measured against each member's own pace, and a guild-level projection, from data already recorded. Ctrl+K → Guild roster.
- **Storage hardening**: quota monitoring with a one-time alert instead of silent data loss, debounced writes replacing per-message full-history rewrites, per-snapshot networth detail keys, year-plus-downsampling retention, and a streaming backup export that cannot OOM on big histories.

### The simulator models more, and breaks less

- **taskDamage now raises damage** in sims (deliberate divergence from reference sims — the stat is real; it already applied to thorns).
- **Achievement combat buffs are simulated**, wired per player like guild buffs; empty data changes nothing.
- **Unknown game mechanics no longer crash whole sims**: unknown ability effects, target types, styles, and damage types are skipped with a once-per-type warning, surfaced as a banner on results ("results may understate").
- An item with 0 base stat but an enhancement bonus no longer loses the bonus.
- **Healing/mana breakdown**: HP/MP gained and HP spent per source (food, regen, abilities), collapsed under the results — the engine always computed it; now you can see it.
- **The Experience token is ranked in the skilling advisor** by XP/room per token, with XP/Room and Tokens/XP columns.

### Ctrl+K, named layouts, and the features finally talk to each other

- **A command palette.** Ctrl+K (Cmd+K) opens a fuzzy-searchable launcher for every panel, every overlay row, every setting (deep-linked into the settings search), and every saved layout. Keyboard-first, never fires while you're typing in chat, and can be switched off (`Command palette` setting).
- **Named overlay layouts.** Save the current overlay arrangement under a name, switch between layouts from the gear popover or the palette, delete with confirmation. Switching is undoable.
- **Combat zones join the ranked action list.** All-zones sim results persist (with a gear fingerprint) and appear as rows in the Pinned page's Profit/hr / XP/hr table — marked with when they were simulated and flagged "gear changed since" when your gear no longer matches. "What should I be doing right now" finally has one answer covering skilling and combat.
- **"Save for this" and "Watch" on advisor results.** Equipment rows in the upgrade advisor add straight to the savings-ETA targets or the watchlist; ability rows can be watched; the lab budget plan gains "Open all in marketplace" (one tab per planned purchase).

### Notifications, provenance, and selectors that survive game updates

- **Opt-in notifications** (all off by default): consumables running low, a market listing filling, another character's queue going idle, plus the existing empty-queue alert — one service behind them all. Hidden tab → browser notification and a ❗ title flash; visible tab → toast; 10-minute cooldown per event so nothing nags. The browser-permission prompt now appears when you enable a notification, never at page load.
- **Profit figures say where their prices came from**: pricing mode and price age on the profit line, and a ✱ marker wherever your own custom price override is feeding a number.
- **Actual vs expected for gathering**: loot log stats now show expected run value beside the actual, phrased like the combat drop-luck line.
- **Game-update armor**: the selectors that hardcoded build-hashed class names (guaranteed to break on any game rebuild) are prefix matches now, and a conservative four-anchor canary reports "selector missing — game update?" through the health system instead of features just silently vanishing.
- The market history viewer joins the shared navy panel chrome and the z-index tiers.

### Panels remember where you put them, and stacking becomes predictable

- **Both simulator panels persist their geometry.** The Lab Simulator forgot its position and size every reload (reposition it every session); the Combat Simulator remembered size but snapped back to the corner. Both now use the shared geometry store, and both drags run through the shared utility (touch support and the click-isn't-a-drag guard included). Deliberately not persisted: open state — a sim panel should not reopen itself on reload.
- **Sorting the upgrade table no longer wipes your place.** Open detail rows and scroll position survive header sorts, column toggles, and score changes — the comparison you were building stays built.
- **Every overlay joins the z-index tiers.** Twenty-odd hardcoded 10000–100002 values across settings dialogs, the sim editors, the networth chart stack, tea popups, task dialogs, and custom-tab menus now derive from the documented panel cap — so what covers what follows the rules, and nothing of ours paints over a game modal it shouldn't.

### The product-review batch, wave one

- **Back Up Everything / Restore Backup** (settings panel): one versioned JSON covering every data store — dungeon runs, networth history, loot logs, trade history, all of it — not just settings. Restore confirms what it is about to overwrite, restores store-by-store, and asks for a reload. Months of tracked history stop being one cleared browser away from gone.
- **Setting presets**: Essentials / Combat / Market & trading / Everything on, offered once on a fresh install and available afterwards as buttons. Presets only touch on/off switches (never your numbers or colors), and Restore undoes a preset the same way it undoes All Off. A "changed only" filter beside the settings search shows just the settings you have moved off their defaults.
- **The refresh notice stops crying wolf.** Settings that genuinely need a reload (seven, each verified to have no live-apply path) carry an amber "reload" tag; the blanket "some settings require a refresh" notice now points at exactly those.
- **Failures get a face.** A dozen features now carry real health checks (anchor drawn but injection missing = broken; panel not open = no evidence), and when startup leaves something down you get one toast — "N features failed to start" — that opens a status view with a copyable diagnostic report (version, fork, browser, failures, startup timeline). Previously the health pass checked nothing and failures lived in the console.
- **The savings ETA works for skillers.** "When can I afford it" used to need a live combat session; it now falls back to your networth trend (a robust 48-hour slope that a one-off sell-off cannot drag), and the panel says which estimate it is using.
- **Labyrinth sim results survive reloads.** The combat clear-rate cache persists (7-day expiry, capped, invalidated by the same gear-change rules as the in-memory cache) and previews note the age of a cached figure.
- **Dungeon tracker housekeeping**: the delete-all-history button no longer wears the close glyph (now 🗑 with a proper confirmation dialog instead of a frozen browser box), a "🔍 Filtered" chip on the header shows when saved filters are narrowing the run list (click to clear), and the Ctrl+Shift+D shortcut that hijacked a browser binding is replaced by a reset button in the header.
- **What's-new dialogs** use the shared choice dialog (Escape closes, focus lands correctly) instead of a hand-rolled copy.

### The Combat Simulator panel catches up to the Lab Simulator

- **Stop no longer throws away finished work.** Cancelling an upgrade analysis now renders every candidate that completed before you pressed Stop ("Analysis cancelled — showing N completed candidates"), matching what the Lab Simulator always did. The run you cancel is the one that took long enough to cancel — it is exactly the one whose partials you want.
- **The progress bar and Stop button survive tab switches.** They lived inside the Results tab, so switching to Configure mid-run hid the only cancel control while the status line claimed "Select a zone and click Simulate." The progress area now sits outside the tabs, and the status line no longer overwrites itself while a sim or analysis is running.
- **The ⚙ Columns menu is legible.** Five checkboxes all read "Gold/0.01%"; they now carry their metric (DPS / EXP / Profit / EPH / DPH) like the table header does.
- **CSV export everywhere.** All Zones, Seek, the session comparison, and the Upgrade results each get the same Save-CSV control the Lab Simulator's tables have; exports carry raw numbers.
- **A budget planner on the Upgrade tab.** Enter a gold budget (k/m/b shorthand works), pick the axis to optimize (profit/hr, DPS, or XP/hr), and get the best set of purchases within it — one per slot, superseded steps handled — using the same planning engine as the labyrinth budget planner.

### Sim accuracy: house rooms, guild buffs, and the Experience token

Fixes from the combat-sim implementation review, all affecting numbers people act on:

- **REVERTED (player-verified): house wisdom does apply to combat in the live game — the filter below was removed again.** ~~Skilling house rooms no longer inflate combat sims.~~ House-room action buffs are scoped per action type in the game data, but the engine applied every buff from every owned room — a Library's wisdom (the same `/buff_types/wisdom` string combat uses) quietly raised simulated combat XP and rare-find for anyone with developed non-combat housing. The engine now keeps only combat-scoped action buffs; genuinely global room buffs still apply. Tested.
- **Party members keep their own guild's buffs.** Sims used to read guild combat buffs from the first player and hand them to the whole party, so teammates in a different (or no) guild simmed with yours. Each player's buffs now come from their own data. Solo sims were always correct.
- **The labyrinth Experience token exists again.** It was dropped when loading a character into the sim, invisible in the sim editor, and its bonus computed as zero in the editor-driven skilling calculator. It now loads with the other four tokens, has its own editable row in the sim editor, and its XP effect flows through — visible in the skilling clear-rate table's new **XP/Room** column. (Ranking it in the upgrade advisor still needs an XP-based metric; the advisor ranks by clear rate, which the token does not move.)
- **Peak enrage stack merges correctly** across multi-worker runs (maximum of chunks, not chunk 0's value).

### Panels stay reachable and dialogs stay on top

- **Confirmation dialogs can no longer hide behind panels.** Clicking panels raises them toward a z-index cap that sat above the choice dialog's fixed level, so after enough raises the delete-history and import confirmations could render invisibly behind the panel that opened them. The dialog now derives its level from the cap itself and always outranks every panel. Tested, including the exact raise-count scenario that used to fail.
- **Shrinking the window no longer strands panels off-screen.** A debounced resize listener walks the open floating panels and nudges any that ended up out of bounds back into view; panels that still fit are untouched, and the saved position still wins in a larger window later.
- **Lab Simulator polish:** the dense all-fights table keeps its column headers while you scroll (same sticky treatment the combat sim table documents), and a skilling-tab load failure now says so in the status line instead of leaving a silently blank tab.

### Every setting now does what it says — a full audit of all 346

Four auditors swept every setting in the schema against the code that consumes it. Most were clean; fourteen were not, and all fourteen are fixed:

- **Five checkboxes did nothing at all.** `Queued actions: Show total time and completion time`, `Mana Tracker`, `Watchlist`, `Dungeon tracker HUD`, and `Dungeon tracker chat annotations` rendered and saved but were never consulted — features behind them ran unconditionally (the enable check fell through to "on" for any key missing from an internal legacy map). Each now actually gates its feature. If you had one of these unchecked expecting it to do something, it now does.
- **Two features could never be turned off.** The task sorter and the drink timer had internal switches that were never exposed in the settings panel; they now appear there (`Task sorter`, `Drink timer`), both on by default so nothing changes until you say so.
- **Two settings promised things the code never did**, and are removed rather than left lying: `Action panel: Total time…` (superseded by the live `Show speed/time section` and `Show level progress section` switches) and `Enhancement tooltips: Show detailed breakdown for consumed items` (the detail view it described was never ported).
- **`Market: Listing price decimal precision` existed but nothing read it.** It now controls the decimals on the Top Order and Total columns of My Listings; its default is set to match what the display always did, so nothing shifts on update.
- **Two Lab Simulator inputs disagreed with their settings**: the Hours field opened at 10 and the Find Max ≥ threshold at 95 when the settings (and every other consumer) say 3 and 70. They now honor the settings.
- **`Lab Simulator: Critical Aura` sat in the Marketplace section** of the settings panel; it now lives with the other labyrinth settings under Combat Features.
- The net worth master switch's label and help now say what was always true but undocumented: the inventory breakdown, history chart, and overlay rows all depend on it.

One decision deliberately not made: a fully built but never-registered bulk task reroll feature reads a `taskBulkReroll` setting that doesn't exist. Because it automates spending task rerolls, it stays unwired pending an explicit call on whether to activate or delete it.

### The Sell Queue is back

Removed one commit ago on the belief it was dead; restored unchanged — module, feature registration, and the `sellQueue` setting. It keeps its Shift+RightClick entry point and gets no touch adaptation.

### The mobile sweep, part three: gestures that had no touch equivalent

The Phase 2 items from the mobile audit — the ones where a mouse gesture had to be redesigned rather than translated:

- **The Sell Queue feature is removed.** Its entry point was Shift+RightClick, and the feature no longer worked anyway. The `sellQueue` setting is gone from the schema; the marketplace tab utilities it shared with other features are untouched.
- **Overlay tiles open with a single tap on touch.** Double-click stays on desktop, where it guards against accidental opens while reading; on a touchscreen that guard is unnecessary — a tap that follows a scroll gesture never fires a click — and double-tap fights the browser's tap-to-zoom. Taps while the layout is unlocked still arrange rather than open.
- **Labyrinth tile previews exist on touch now.** Tapping a clear-rate badge shows the preview that hover shows on desktop, and the preview carries an "Open in sim →" button standing in for right-click; tapping anywhere else dismisses it. The "Right-click to open simulator" hint only renders for mouse users, where it is true.
- **Mooket watchlist chips are workable by finger.** The reorder arrows grow from 8px to a tappable size on coarse pointers, and each chip gains a visible × for removal — explicitly, rather than a long-press that could silently delete a watch mid-scroll. Desktop keeps right-click removal and the compact arrows.

Also: `CLAUDE.md` notes that Opus/Sonnet subagents may be used at the assistant's discretion for research and sweeps.

The remaining mechanical fixes from the four-agent mobile audit, in one pass:

- **Every remaining drag works by finger.** The thirteen panels still listening for mouse events — combat score abilities, queue monitor, networth exclusions, enhancement tracker, XP/h calculator, scroll simulator, mention popup, Mooket chart, labyrinth room logs, tea recommendation, bulk sell, and the overlay panel's dock bar, tile drag, and tile resize — now use pointer events with `touch-action: none` on their handles and release cleanly when a touch is interrupted. The Mooket panel drags by its toolbar on touch, so its chip row keeps scrolling.
- **No panel opens wider than the screen.** First-open sizes are clamped (`min(Npx, 92vw)` wide, `min(Npx, 80vh)` tall) across fourteen panels — consumables, combat levels, treasure, the shared combat panels, combat sim, watchlist, house affordability, ability books, the overlay panel, mention popup, PFormance, enhancement tracker, custom-tabs modals, and the networth 24h breakdown, which also pulls itself back from the right edge instead of overflowing past it.
- **The dungeon tracker fits a phone.** Its 480px minimum width — which pushed half the panel permanently off a 390px screen — is clamped to the viewport, a saved drag position from a wider window is pulled back on screen, and the content area scrolls within the window height instead of growing past it. The keys list also stops rebuilding its rows every second while collapsed.
- **Hover-only controls exist on touch now.** Alchemy pin buttons and custom-tab section actions were revealed by hover, which a touchscreen does not have; on a coarse pointer they are always visible, and the pins grow to a 32px finger-sized target.
- **Background tabs stop burning battery.** Nine once-a-second panel refreshers (portrait DPS, enhancement tracker, dungeon tracker, combat panels, combat levels, consumables, watchlist, ability books, house affordability) skip their tick while the tab is hidden. The action countdown throttles from every-frame to the ten redraws a second its tenths-of-a-second readout can actually show, and portrait DPS coalesces its observer-triggered redraws to one per frame.
- **Worker pools are torn off with their features.** The EV, networth, and enhancement worker pools each had a terminate function nobody called; disabling those features now shuts the workers down instead of leaving them resident, and they recreate themselves on next use.
- **Mobile mode caps simulation workers at two.** A phone reporting eight cores does not have eight cores of thermal headroom, and each worker holds its own clone of the game data. The all-zones simulator also now uses the same worker budget as every other sim path — it was reading raw `hardwareConcurrency` and spawning up to sixteen.

### Panels can be dragged with a finger

Every drag and resize in the script listened for mouse events, and `mousedown` never fires on a touchscreen — every panel was simply immovable on a phone, the dungeon tracker included. All of it now runs on pointer events, which fire for mouse and finger alike: the shared drag/resize utility (Treasure, overlay panels, combat panels, consumables, combat level), the dungeon tracker, both simulator panels, PFormance, and the game-modal dragger. Each handle sets `touch-action: none`, without which the browser claims the gesture for scrolling after a few pixels, and an interrupted touch (a notification landing mid-drag) releases the panel instead of gluing it to a pointer that no longer exists.

The Lab Simulator's default size is clamped to the viewport — `900px` is wider than every phone — and resize grips grow from 14px to 26px on touch devices, since a mouse-sized target is unhittable with a finger.

### A mobile mode, auto-detected and overridable

**Mobile mode** (General Settings): Auto-detect / On / Off. Auto keys on `pointer: coarse` — whether the primary pointer is a finger — rather than user-agent sniffing, which lies for compatibility. The override exists for the touchscreen laptop that wants desktop layouts, and for testing the mobile layout from a desk. Features consult it through one shared utility, so future mobile adjustments have a single switch to key on.

### Arriving from another build of Toolasha asks before anything new runs

Someone switching to this fork for the first time — usually from upstream, whose settings live under the same storage keys — now gets a one-time choice before any feature initialises: **"Turn the new things on"** or **"Keep everything as it was"**. Keeping things as they were forces every fork-added on-by-default switch off and enables "New settings start turned off" for the future; either way, the full what's-new popup follows with a live switch per setting, so the wholesale choice can be refined item by item.

What the fork _added_ is computed without upstream's cooperation: the settings store saves its whole map, so the keys of the saved settings are a fingerprint of whichever script wrote them, and the fork's additions are the schema entries missing from that map. A genuinely fresh install — no saved settings at all — sees no dialog. The choice is awaited before features initialise, because "keep everything as it was" is only true if the new features never run, not even once; closing the dialog without choosing counts as keeping things as they were.

### A what's-new popup, once per update — with the new settings live in it

After an update, a popup shows what changed and lists every setting that did not exist in the build you had before, **with its real control** — flip a switch there and it is flipped, no trip to the settings panel. The changelog it shows is embedded from this file at build time, so it cannot drift from what actually shipped.

What counts as "new" is decided by the settings schema, not the version number: the script remembers which setting IDs you have already been shown and diffs them against the schema that just loaded. Version numbers only decide _when_ to speak — and they are compared as a **(fork, version) pair**, because this fork shares numbering with upstream and `2.88.0 → 2.88.0` across forks is different code wearing the same badge. A fork switch is announced as one ("Switched from Celasha/Toolasha 2.88.0") rather than hidden behind a matching number. Skip three versions and you see three versions' worth of new settings, since the diff is against what you were last shown, not against the previous release.

The popup can be turned off — from the popup itself, which is where you are standing when you decide that, or in General Settings.

### New settings can be made to start off

**"New settings start turned off"** (off by default): when an update introduces a new on-by-default switch, it is forced off before any feature reads it — so the new behaviour never runs, not even once, until you enable it. Numbers and dropdowns keep their defaults, since a value is not a feature switching itself on, and the policy never applies on a fresh install, where "everything is new" would mean turning the whole script off. Paired with the popup, an update becomes: nothing changed, and here is the list of what you could turn on.

### Guild joins get a clickable name too

"Mazo has joined the guild!" now gets the same clickable name as level-up announcements — clicking fills `/profile Mazo` into the chat input. Leaving the guild is covered too, since it is the same sentence pointed the other way. The settings help text also stops using a real player's name as its example.

### The treasure popup sizes itself to the chest it is showing

Opening the per-chest popup already measured its content and sized to fit — and then the remembered height from a manual resize was applied on top, clipping every chest with more rows than the one the resize happened on. The height now always fits the chest being shown (capped to the window); the width half of a resize is still remembered, and the height is re-fitted after the width lands since width changes how rows wrap.

### Moving the popup no longer flips "Popup follows the chest dialog"

Dragging the popup used to silently pin it — one nudge and it stopped following the chest dialog, with nothing on screen saying why. A drag now just puts it where you dragged it; whether it follows the dialog is decided by the settings gear alone. The dragged position is still saved, so a popup that _is_ pinned keeps opening where it was last put.

### The shared seed pairs the baseline again — no more phantom DPS from skilling rooms

Yesterday's change gave every batched candidate one worker while the baseline kept splitting its hours across four. The shared seed only cancels sampling noise while both runs draw the same random streams, and the chunking decides the streams — so the baseline and every candidate became independent samples, and every combat-inert candidate wore the same deterministic phantom delta against the baseline. The visible symptom: Laboratory and Observatory each "improving" DPS by an identical +0.06%.

The baseline now runs one worker like the candidates, so a candidate that changes nothing combat-visible is bit-identical to the baseline and its DPS delta is exactly zero. What remains on a skilling room is real: Wisdom moves EXP/hr, and Rare Find moves profit slightly — rare drops sell, and that part is computed analytically, not sampled.

### Six of the twelve "background" seconds were a timer, not work

The new trace showed it plainly: the guild tracker's `save history` took 6013ms while loading the same data took 10ms. `storage.set` is debounced, and its promise resolves only when the 3-second timer fires — so awaiting two saves in series was six seconds of waiting for timers whose entire purpose is to postpone the write. The guild tracker and networth history now queue their saves without awaiting them; the actual writes are milliseconds, and the existing flush-on-unload covers a tab closing before the timer lands. This was also part of the original 13 seconds of blocking startup.

### The thread-cap override renders now

The new "Ignore the thread caps" setting declared itself as a type the settings panel doesn't know (`boolean` rather than `checkbox`) and drew as "Unknown type" instead of a switch.

### Two features were holding the whole start up for thirteen seconds

Features are initialised one after another and each one is awaited, so anything a feature does inside `initialize()` is time every feature behind it spends waiting. That is right for wiring up listeners. It is wrong for what these two were doing:

- **Guild XP tracker (6.5s)** — read a guild's entire XP history out of IndexedDB, added a reading to every member's series and wrote the lot back.
- **Networth (6.3s)** — priced every item in the inventory and loaded the history chart's snapshots.

Neither result was on screen yet, and the hundred-odd features after them in the registry were queued behind both. They now register their listeners and hand the heavy part to a background pass that runs once the page has drawn. The guild tracker's update handlers wait on that pass before touching the history, so an update arriving mid-load cannot be overwritten by it.

### PFormance can now say _when_, not just _how long_

A list of durations cannot show the two things that actually locate a slow start: when each feature began, and what the page was waiting for in between. Half of a slow start is usually waiting — for IndexedDB, for the game's own data — and waiting is in nobody's duration.

- **A Startup section**, listing the marks on the way up (`script:start`, `storage:open`, `config:loaded`, `character:data`, `features:start`, `startup:complete`) with the moment each was reached, and calling out the longest stretches where nothing was being timed at all.
- **Feature rows now carry a Started column**, so a six-second feature can be read as "and everything after it waited" rather than just "six seconds".
- **Background work shows separately**, dimmed and marked `⤵`, because time spent after the page is usable is not time anybody waited.
- **Slow features break into parts.** The two above are instrumented, so their rows now show _which call_ was the six seconds — `load history`, `save history`, `first calculation`, `history`.

### Export the trace

Two new buttons on the panel header: **⧉** copies the whole trace as text — environment, timeline, the gaps, the slowest features with their parts, and the busiest handlers — and **⭳** saves it as a text file plus a JSON one. Text because the point is that a person reads it, in a chat window, without tooling; JSON alongside for anyone who would rather sort it.

### An option to take the thread setting literally

Max threads is normally clamped to your core count, and an analysis runs at most six simulations at once — each holds its own copy of the game data, and the tab running the game needs a core too. **Combat Simulator: Ignore the thread caps** turns both clamps off for anyone who wants the number they typed.

### Fan out a single run, queue a batch — measured, not assumed

The previous entry guessed that a long combat simulation, which already splits its hours across every worker, left no room to run candidates concurrently. That guess was wrong, and a benchmark with real workers and a game-data-sized payload says so plainly. On four workers, eight candidates:

| Candidate length | One at a time, split 4 ways | One worker each, 4 at a time |
| ---------------- | --------------------------- | ---------------------------- |
| 100 h            | 3081 ms                     | **924 ms** (3.3× faster)     |
| 200 h            | 3285 ms                     | **1304 ms** (2.5×)           |

Both simulate the same total hours on the same cores, so it reads like a wash. It is not. Splitting makes every candidate pay the worker startup and the game-data clone **once per chunk** rather than once — 168 ms apiece here — and it cannot start the next candidate until its own slowest chunk lands. Raising the work per candidate narrows the gap without ever closing it: at five seconds of simulation per candidate, queueing was still 1.14× ahead.

So a batch now gives each candidate **one worker** and keeps as many candidates in flight as the budget allows, at any Hours setting. A **lone** run still fans out, because there is no queue to keep the cores busy — one 600-hour simulation measured 1378 ms in a single worker against 648 ms split four ways.

### Concurrency, with the sharp edges filed off

Reviewing the concurrent fight sims turned up two things worth fixing and one that decides how far this can be taken.

- **A failed simulation no longer leaves the queue running.** If one worker died, the other lanes kept pulling fights and starting simulations for an analysis whose result had already been thrown away. The first failure now stops the queue.
- **The fan-out is capped at six**, whatever the thread setting says. Each simulation is a Worker holding its own structured clone of the entire game data, so the fleet costs memory in proportion to its width — and it is competing with the tab running the game. An analysis that takes every core makes the thing you are playing stutter.

The single-monster **Upgrade** analysis in the Lab Simulator now runs its candidates concurrently as well; every candidate there is one worker against a shared baseline, so it had the same idle machine behind it.

The **combat simulator's** upgrade analysis is a different case, and gets a different rule. A long run already splits itself across the whole worker budget, so four candidates at four workers apiece would be sixteen workers competing for four cores — slower than a queue. It now runs `workers ÷ workers-per-simulation` candidates at once: several when the Hours setting is low enough that each run is a single worker, and strictly one at a time when each already saturates the budget.

That path also needed `runSimulation` to stop preempting. It cancels whatever is running when it starts — right for a Simulate button, fatal for a batch, where each candidate would kill the one before it. Batches now opt out; the button keeps its behaviour.

### The budget plans for a whole run, not for one fight

A labyrinth run is ten fights in ten loadouts, and a purchase only helps the rooms it reaches — so "one upgrade per slot" was answering a question about a single fight. The plan now buys **two chestpieces where they serve different rooms**: one for the melee loadouts, one for the casters, which is two purchases doing two jobs.

What it still refuses is two pieces for the _same_ rooms, where the second is gold spent on something that never gets worn. Every candidate is valued at what it adds **beyond what is already picked**: within a slot a room wears whichever picked piece is best for it, so a second piece is worth exactly the rooms it improves on the first — no more. Each row says how many rooms it is there for, and the saving beside it is its own marginal contribution rather than a total that counts shared rooms twice.

If a cheap early pick is later beaten in every room it covered, it is taken back out of the plan and its gold returned to the budget. Skill levels, ability levels and house rooms stay one-per-group, because there is no second copy of those to wear somewhere else.

### Verify together says what it is wearing

It always installed **every** pick that applies to a loadout, all at once — the tooltip just never said so. It now spells that out, and the result line reports how many were worn together. Where two picks share a slot, the room wears whichever is better _there_, which is exactly what the plan valued the second one at.

### Fights simulate several at a time

Every labyrinth fight is its own worker with its own seed and its own trial count, and they were being run one after another while the rest of the machine sat idle. The baseline pass and each candidate's pass now run up to `combatSim_maxThreads` (or core count) fights at once. Results are still collected in fight order, so every downstream figure is unchanged — this is wall-clock only.

### The simulator is about four times quicker at rebuilding stats, and fury feels it most

Fury was the slowest damage type to simulate, and nothing about it was slow — it was just the only one that triggered a full stat rebuild on nearly every swing. Measured, one rebuild cost ~92 µs, and **72% of it was re-aggregating what the equipment contributes**: seventy stats, each an `Object.values` plus a filter, a map and a reduce over thirteen slots, arriving at numbers that cannot change during a fight. It is now ~23 µs.

Three changes, none of which alters a single figure:

- **Equipment totals are computed once** and reused until what is worn changes, keyed on the gear itself rather than on a flag somebody has to remember to clear.
- **Buffs are indexed in one pass** per rebuild instead of thirty-five separate scans of the same object, each allocating two throwaway arrays.
- **Buff copies use a spread instead of `structuredClone`** — every field of a buff is a primitive, so the copy is identical and about fifty times cheaper. This runs on every drink tick, every aura and every curse, so it was not only fury paying for it.

Fury also stopped rewriting the event queue on every swing. A landed hit pushes the 15-second timer back, which used to mean scanning the queue, removing the old expiry and queuing a new one each time. One event now lives across the whole streak and re-arms itself if it fires while the timer has moved on.

Checked by running the old and new stat rebuild side by side over 120 configurations — full gear, sparse gear, two-handers, no gear at all, with zero to thirty buffs, called repeatedly — and comparing every field. Identical throughout. The comparison also caught a real mistake while it was being written: two stats whose names end in digits were being dropped from the equipment list, which no unit test noticed.

### One purchase now counts for every loadout it would improve

A tier upgrade is one item that every loadout can share, but which rooms it was credited for was decided by matching the **exact piece it replaces** — and each candidate carries whichever piece the first loadout to generate it happened to wear. Buy the Magician's Hat and the loadouts wearing some _other_ hat were never asked whether it would beat theirs: one price, a fraction of the benefit, and a `1 / 10` in the Rooms column that looked like a considered answer.

A tier upgrade now applies wherever it would actually be an upgrade — same slot, not a step down in tier, not a style the loadout does not fight in, and not a damage piece dropped into a defensive slot. Enhancements are unchanged: enhancing your boots only helps loadouts wearing _those_ boots. An empty slot counts as improvable, except a hand a two-hander is already using, where installing a one-hander beside it would build a kit the game would never wear — trading between the two is what the cross-slot candidates are for. The per-room breakdown names what the piece displaces in each room, since with one purchase serving several loadouts that is no longer the same answer everywhere.

### ΔAttempts says how much of itself is noise

Every win rate is a proportion measured over a finite number of simulated attempts, and the headline figure sums ten of them through `1/p`, which magnifies the error badly at low win rates. A run of luck on one 30% room could read as a 1.6B item being worth buying, and nothing in the table said otherwise.

Each row now carries `±` one standard error of its own change, and a change smaller than about twice that is drawn grey rather than green — it has not been measured. Both sims are counted in the error, which overstates it slightly since they share a seed and their errors partly cancel: colouring an honest row grey costs nothing, while the other way round recommends a purchase that did nothing.

### Budget mode: what to actually buy

Type a budget — `500m`, `1.2b`, `750,000,000` — and the panel plans the best set that fits, rather than repeating that one item is the best single item. It walks the table in value order taking what fits, **one upgrade per slot** (two upgrades to the same boots are alternatives, and buying both spends the second one's gold on nothing), and skips anything inside the noise band above.

Greedy rather than an exact knapsack, deliberately: the values are estimates with real error bars, an optimum computed from them is false precision, and a list you can read off the table beats one that is a percent better and inexplicable.

### Verify together, because gains do not simply add up

Every row is measured on its own against the same baseline. That is the right way to rank them and the wrong way to total them: two upgrades that both rescue the same failing room are each credited with rescuing it, and the sum promises a saving neither will deliver.

**Verify together** runs one more pass with the whole plan installed at once — same seed, same trial counts, each piece going only where it belongs — and reports what the set is really worth beside what the parts promised, with the overlap as a percentage. If the difference is inside the noise it says so instead: the sum holds.

### Per 1B is now Per 1M

The value column reads in attempts saved per million coins. Small figures get more decimal places so a modest value does not print as `0.00`.

### All Fights columns sort, and the panel opens big enough to read

Every column in the All Fights table is a sort now — click Cost for the cheapest first, Rooms to see what reaches the whole run, Avg ΔWin for the biggest single-room gain. A second click reverses it; a new column starts at whichever end of it is the good news. Candidates with no coin price sort last either way rather than pretending to be free. The CSV export follows whatever order is on screen.

The panel opens at 900×700 rather than 560×600, which is what a seven-column table needs, and it now has a grip in the **bottom-left** corner as well as the bottom-right. A panel sitting against the right edge of the screen could only be widened by pushing it further off-screen.

### No more melee shields recommended to ranged builds

Trading a two-hander for a main-hand plus off-hand offered two off-hands: the best one matching the weapon's style, and the highest-item-level one overall. That second rule was style-blind — "Cursed Bow → Sundering Crossbow + Knight's Aegis" put a melee shield on a ranged build because it had the higher item level, and every point of its melee accuracy is dead weight there.

An off-hand carrying offensive stats for another style is no longer offered at all, whatever its item level says. One with no offensive stats — pure armour and evasion — is still offered to everybody, which is what made the rule worth having.

### Cached labyrinth sims notice when you enhance something

The fingerprint that decides whether a cached room sim is still good was taken over the stored loadout contents. For a loadout wearing the highest copy you own, enhancing an item changes what it puts on without changing anything stored — so the sim cached against the old level outlived the upgrade that made it wrong. The fingerprint now covers the levels actually worn.

### Loadouts are read at the enhancement levels they actually wear

A loadout snapshot is parsed from the game's wearable hash, and that hash carries the enhancement level from the moment the loadout was last saved — for a loadout using "Use highest enhancement level" (the default) it is usually 0, because the level is not part of what the loadout stores. The game resolves it at equip time by putting on the best copy you own. Reading the stored number back reported a Refined Gatherer Cape at +0 while the character was standing there wearing it at +10, and every number computed from that loadout was wrong in the same direction.

The old fallback only helped in one case: it filled a stored 0 from whatever was equipped **right now**, so the active loadout looked right and every other one read +0. A stale non-zero level — the loadout saved at +10, the cape enhanced to +14 since — was never corrected at all.

Levels now come from the loadout's own rule: a loadout pinned to an exact enhancement wears exactly what it says, and every other loadout wears the highest copy you own, counting worn pieces as well as inventory. It never resolves _downward_ from a known level, so an inventory that has not loaded yet leaves a stored +10 alone rather than reporting +0.

This runs through everything reading a loadout: the Skilling analysis and its per-skill loadouts, the labyrinth combat fights and All Fights, the Lab and Combat simulators' loadout dropdown, the combat score export and the character card.

### Export any of the three Lab Simulator analyses to CSV

The Upgrade table, the All Fights table and the Skilling Upgrade table each carry an **Export CSV** button now. The file holds raw numbers rather than the panel's formatting — `1200000000` and `0.0032`, not `1.2B` and `+0.32%` — because a spreadsheet cannot sort or sum a display string, and a CSV of them is a screenshot with extra steps. Filenames carry the date and time, since exporting the same table before and after buying something is the normal case.

### Skilling gear was being offered to the wrong skill, or to none at all

Auditing the skilling side for the same fault as All Fights turned up four, three of them silent:

- **Celestial tools and skill outfits were never offered at all.** The candidate builder wanted a bare skill name (`milking`) and the panel hands it a skill hrid (`/skills/milking`), so it looked for a stat called `/skills/milkingSpeed`, matched nothing, and missed the tool slot entirely. It returned an empty list without ever erroring — the feature has been inert since it shipped. It takes either form now.
- **Skills with no assigned loadout got no gear candidates.** Only skills with a loadout were swept, which excludes exactly the skill most likely to still be missing its tool. Every labyrinth skill is swept now, falling back to the base kit.
- **A piece bought for a skill with no loadout was applied nowhere** — simulated, ranked, and reported as a flat +0.00%. It now gets a kit of its own, copied from the one it was running, so the change lands on that skill and no other.
- **Enhancing an item downgraded a second copy of it.** The application matched on item alone, so a "+3 → +5" candidate also rewrote a second copy worn at +7 in another skill's loadout down to +5 — an upgrade that made things worse. It matches the enhancement level too, and in single-skill mode leaves the other skills' kits alone.

### All Fights only sims a piece against the loadouts that wear it

The all-fights analysis pooled candidates from every fight and then measured each of them against every fight. That is right for a combat level — one number the whole character carries into every room — and wrong for a piece of gear. A sword upgrade generated from the melee loadout, installed into the magic loadout, replaced the staff with a sword: not an upgrade, a costume change, and it came back as a large negative win-rate delta for a room nobody would ever have applied it to. Those deltas went straight into the aggregate the ranking is built on, so a good weapon could be pushed down the list by rooms it has nothing to do with.

A candidate is now measured only against the fights it is about: gear where the loadout wears the piece it replaces, an ability level where the loadout actually casts that ability, a cross-slot swap where every piece it removes is worn, an enhancement only where the piece is not already at that level. Combat levels and house rooms still apply everywhere, because they are not held in a loadout. Rooms it does not reach keep their baseline exactly and are not simulated at all — which is both the honest answer and a good deal less work, so the runs are shorter as well.

A new **Rooms** column says how many fights each upgrade reaches, the expanded breakdown marks the others "not in this loadout" rather than showing them as a flat 0.00%, and **Avg ΔWin** is now averaged over the rooms an upgrade reaches — a weapon that goes in two of eight loadouts is not a quarter as good at its job.

Levelling an ability also now follows the ability rather than its slot number, so a loadout that keeps the same ability in a different slot is no longer given the upgrade in the wrong place.

### Every sim says how long is left

The progress bars said how far in a run was, which is not what anyone watching an upgrade analysis wants to know. They now also carry a time remaining — `47 / 132 · ~3m 15s left` — on every sim in both panels: the single labyrinth run and the max-level finder, the labyrinth upgrade, all-fights and skilling analyses, and the combat panel's single sim, all-zones, item seek and upgrade analysis.

The estimate comes from the run's own pace, since nothing else could know it — the same analysis varies by an order of magnitude with the mode, the candidate count and the machine. It averages the whole run's average with the pace of the last few updates: the first is stable but slow to notice that a run has slowed down, the second notices at once and lurches on every expensive candidate. It stays quiet for the first second and the first couple of percent, where the only thing being measured is workers starting up, and it rounds — an estimate that ticks 2m14s, 2m11s, 2m16s claims a precision it does not have.

Sims that stop early once the win rate is pinned down will beat their estimate, which is measured against the full hours.

### Ability upgrades are priced in books, and credit nothing back

An expanded "Fireball Lv48 → Lv53" row read `Buy fireball +53 — no price found` and `Sell fireball +48 — 0 back`. Both were the equipment breakdown talking about something that is not equipment: it asked the market for a listing of the ability at an enhancement level, which does not exist for anything anyone can buy books for today, and then credited the resale of the level being left behind, which cannot happen — an ability is not an item and cannot be sold back.

Ability rows now show the actual purchase — how many of which book, at what the book is going for — and say plainly that nothing is credited against it. A level-up is priced from where the ability is now; a swap is priced from scratch, including the one book that learns it. An ability whose book has no listing costs _unknown_ rather than zero, so it can no longer sit at the top of a list sorted by gold.

### Bulk Sell read the wrong field off the watchlist

`hrid` is what a watchlist entry calls the item; `itemHrid` is what an inventory item calls it. Reading the latter off the former produced a set of `undefined`, an empty source, and "No tradable items in Watchlist" against a list of seventy. The test fixture invented its own shape, so it passed for the wrong reason — it uses the real one now.

### The Lab Simulator applies the default monster's loadout

Picking a monster applies the labyrinth loadout assigned to it, but the monster the panel _opens_ on was never picked, so it opened on whatever gear happened to be equipped — the one case where the panel silently disagreed with every other monster in the list. It now applies it on the first open, and only then: reapplying on every open would throw away gear changed by hand since.

### Everything — All Fights, per gold

A new Upgrade mode that walks **every labyrinth fight** at its skip level with its own assigned loadout, sims equipment, ability levels and combat levels against all of them, and ranks by what each buys per coin.

The figure is **attempts saved across a whole run per billion coins**. Ranking by raw gain answers the wrong question: a cheap thing that helps a little routinely beats an expensive thing that helps a lot, and a list sorted by gain never says so. Candidates with no coin price — a combat level is paid for in experience — show a dash and are ranked after the priced ones by raw gain, because burying them under a zero would be worse than admitting they cannot be compared in coins.

Candidates are the **union** across every fight's loadout rather than per-fight, since the question is what to buy once for all of them. Each is applied through the same code path the single-room analysis uses, so a candidate means the same thing in both views.

It is a long run: roughly every fight × every candidate, against one room × every candidate for the ordinary mode. Progress and Stop work throughout.

### Skilling gear is offered at +5

Nobody buys a celestial tool and leaves it at +0, so pricing and simulating one there answered a question nobody asked — and understated both its cost and its gain against every other candidate, which are judged at the level they would actually be run at. The same +5 the philosopher's accessories already use.

### The Upgrade tab's controls fit

The shared select style is `flex: 1; min-width: 0`, which is right for a row of two and wrong for a row of seven: Player and Mode were squeezed down to a caret and nothing else. Those selects size to their content with a floor now, and the row wraps instead of crushing.

### Skilling upgrades can suggest gear you do not own yet

The skilling advisor could only ever offer to **enhance what was already on**, which meant it was silent about the two upgrades that actually move a labyrinth skilling room: a celestial tool, and the skill's own outfit. Neither is on the character, so neither was ever a candidate — an analysis that can only say "+1 on what you have" cannot say "buy the brush".

Each slot now also offers the best piece you are not wearing, at +0, priced as a purchase net of selling what it replaces. One per slot rather than every tier of the same tool: the analysis simulates each candidate, and six tiers would spend the run proving the best one is the best one. Gear you cannot equip yet is left out, since it would sit at the top of a ranked list pushing down what you could buy today.

**Each piece only counts for its own skill.** A Milking outfit does nothing in a Crafting room, and the analysis runs over every skill at once — a candidate with no skill attached is applied to all of them, so an outfit would appear to help rooms it cannot affect, which is the kind of wrong that reads as right. Every candidate carries the skill it belongs to and is installed in that skill's kit alone. Generic skilling gear, whose stats say `skillingSpeed` rather than `milkingSpeed`, is still offered to everybody — which is what generic means.

What counts as "for this skill" comes from the stats rather than a list of names: an item is for Milking if its `noncombatStats` carry a milking stat. That is exactly what a celestial milking tool and a milking outfit have in common, and what a name list would need updating for on every content patch.

### Bulk Sell never sells gear that is in a loadout

A loadout is a claim on an item: you are still using it, just not right now, and you find out it is gone the next time you switch to that loadout. It goes through the same hold mechanism other scripts use, so it is counted and reported rather than silently filtered — the panel says how many were held back and why.

Keyed by item **and** enhancement level, so a +10 in a loadout does not protect the +0 you keep for melting.

### And the Watchlist source leaves enhanced gear alone

Matching every enhancement level of a tracked item is right for stacks and wrong for equipment: the list tracks "Gobo Defender", and a +10 was swept into the queue at six million coins. The Watchlist source now sells unenhanced items only, and says how many it skipped. A tab names the level it means, so a tab is still trusted to mean it.

### And can weigh the Critical Aura as an upgrade

A **Crit Aura** switch on the **Upgrade** tab adds the Critical Aura to the candidates, ranked beside your equipment and ability upgrades with its own cost, at the level you have learned it to.

Not applied to the others, which is what the first version did — that measured every upgrade against a build already wearing it, and answered a different question. What you want to know is what the aura is worth _compared with_ what you were already considering.

Already running it at that level is not offered, since there would be nothing to measure. Not learned it? It is offered at level 1, which is what buying the book would get you.

### The Watchlist's switches moved to its top bar, and there is one more

Both are in the header now: **Dots on/off** and **Menu button on/off**. The Track-button switch used to be a tick box under the table, which on a list of seventy items is a row nobody scrolls to — and these are settings about the panel's reach into the rest of the game rather than about any one item on it.

The new one turns off the dot the Watchlist puts on inventory tiles. Knowing what is on the list while you are looking at your inventory is the point of having one, but it is another mark on an already busy grid.

Turning the dots off clears the ones already drawn rather than waiting for the game to rebuild each tile. Both switches write the same settings the settings page does — not copies, so the two can never disagree.

### Bulk Sell can sell the watchlist

A **Watchlist** entry in the source picker, beside All items and your inventory tabs. It is offered only when the list has something in it, since an empty source would build an empty run and look like a broken button.

Matched on the item rather than the item-at-a-level, unlike a tab: the watchlist tracks Cheese, not Cheese +3, so every level of a tracked item is in scope. Holds still apply — another script's claim on an item is not overruled by a source choosing it.

### And its rules are editable from its own panel

A gear on the Bulk Sell panel opens the three insta-sell thresholds and the vendor switch. The moment you want to change one of these is the moment you are watching it make the wrong call, which is not the moment you want to be looking for the settings page.

They write the settings the decision already reads, so this is the same switch rather than a copy — there is no third place for them to disagree in. Values are taken on change rather than on every keystroke, since half a typed number is also a number.

### The headline figures come with a scale

Two numbers on the summary card had no way of being read.

**"10.7 below expectation"** — a shortfall of ten is a shrug over one record and a finding over another, and the figure alone cannot say which. It now carries the spread: how far the total is allowed to wander if every prediction is right, `sqrt(Σ nᵢpᵢ(1−pᵢ))` over the judged rooms. Nearly all of that comes from the handful of genuinely uncertain rooms — a hundred near-certain ones contribute almost nothing — which is why the answer is not obvious by eye.

**"11 rooms the record contradicts"** — a 95% interval is wrong one room in twenty by construction, so a record of two hundred rooms is _expected_ to contradict a few and the raw count is not news. It now says how many this particular record would flag anyway. Computed rather than assumed at one in twenty, because most rooms cannot be flagged at all: a room entered twice has an interval so wide nothing falls outside it, and counting it as a test would overstate the chance level several times over.

On one real record: 5 rooms flagged against about 1.5 expected by chance, and a shortfall of 3 sd. Both were findings, and neither was legible before.

### Combat rooms can say something in ten fights

Only skilling rooms recorded per-action data, so a combat room's entire signal was clears over attempts — which needs hundreds of fights to close an interval, and a room gives you ten. Half the room types in a record could therefore never say anything at all.

Fight duration is recorded now, and set against the `avgFightSeconds` the sim already predicts. Nothing is conditioned on: the sim's figure averages its losses in, and so does this, so a model that has the fight itself wrong shows up in a handful of attempts rather than in a season of them. The spread is the sample's own, so two fights make a reading and not a verdict.

### Mark a point to measure from, instead of throwing the record away

Reset was the only way to answer "has it been right _since_ I changed something?", and it answers it by destroying everything that came before.

The summary card now offers a mark. The buckets are running totals with no timestamps in them, so a period cannot be filtered out of them — but it can be subtracted, because every figure in a bucket is a sum, and a baseline is a copy of the totals at the moment it was marked. Switch between the whole record and the period since, re-mark, or forget the mark; the record itself is untouched by all three.

Reset is still there. It answers a different question — "throw this away" — and sometimes that is the one being asked.

A record that has gone backwards since the mark, from an import or a wipe, treats the mark as stale for that room rather than subtracting a history it never had.

### And each room type opens on a click

Closed to start with. The record runs to a couple of hundred rooms and opening on all of them is a wall rather than a list — the pooled reading is the one to read first, and the levels are what you open when it says something. A caret and "click to open" say there is more behind it, and one room type opening leaves the others alone.

### The accuracy list is in the game's order

It was sorted by how often each room happened to be fought, which is no order at all if you are looking for a particular room — and it put every pooled row first and every per-level row after them, reading as two unrelated lists.

Each room type's pooled reading is now followed by its own levels, indented under it, with room types in the game's own order and levels ascending inside each. The order comes from the client data's `sortIndex` rather than a list here, so a monster added by an update lands where the game puts it; one the data has never heard of sorts last rather than first, which is where an undefined would otherwise put it.

### Room timings are compared per clear, on both sides

The calculator's `expectedSeconds` is **time per clear including the attempts you lose** — for a fight, the average fight length divided by the win rate; for a skilling room, the expected time of an attempt divided by the clear chance. A room you clear one visit in five is predicted to cost about five visits' worth of seconds.

It was being compared against the mean duration of the visits that ended in a clear, which differs in two compounding ways: it threw away every second spent on visits that ended in defeat — the term the prediction is mostly made of — and then selected on the outcome, keeping the visits that happened to go well. The two errors do not cancel. They point opposite ways depending on how the room went, which is why one record showed first-try clears finishing in a third of the predicted time and multi-attempt rooms taking three times it, and neither figure meant anything.

The measurement is now every second spent in the room, whatever came of the visit, over the clears those seconds bought. Nothing conditioned on, nothing discarded, so it estimates the same ratio the prediction is. The old per-visit figure is kept beside it — the gap between the two is the time a room has cost you in attempts that came to nothing.

A room never cleared has no figure rather than a zero: what a clear costs when you have not had one is unknown, and the calculator's own prediction for such a room is infinite.

### The double rate was being divided by the wrong thing

A double rolls on a **successful** action; the record counted them against every action. Every skilling room therefore reported about a quarter of the rate the server states — Crafting Lv.202 read "18.0% calc, 18.0% server, 2.3% seen" — which looked like the loudest fault in the whole record and was a denominator.

Over the twenty largest samples in one real record, 1,438 actions: 102.7 doubles observed against 385.6 expected per action (−18.6 sd) and 100.7 expected per success (+0.1 sd). The rate was never wrong.

### And the success rate is now measured per room rather than per action

A skilling room ends the moment you clear it. A lucky room therefore contributes four actions and an unlucky one contributes the full two minutes of them, so pooling every action across rooms builds a sample made mostly of the rooms that went badly — and reads several points below the rate the server states for no reason but the stopping rule. In that same record it came out 3.6 sd low, which is exactly the sort of thing that starts a hunt for a bug that is not there.

Each room's own rate is now recorded, and the reading is the mean across rooms with an interval taken from how much the rooms actually differed. The pooled figure is kept beside it, because the gap between the two _is_ the size of the effect. Rooms that happen to agree exactly do not pin the rate to a point: the interval never narrows past the ordinary binomial error over the same draws.

Records written before this hold no per-room sums, so they fall back to the pooled figure and say so.

### The sim accuracy record can leave the browser

An **Export** button on the Sim accuracy tab copies the whole record as text. The record is the only thing that can say whether the model is wrong, and until now it sat in one browser's IndexedDB where nobody could look at it.

Text rather than JSON, because the point of handing it over is that a person reads it. Three tables: pooled by room type, per room and level, and the per-action rates. Counts as well as rates — the rates can be recomputed from the counts and not the other way round, and anybody checking the arithmetic needs the counts.

### And a reading per room type, across every level of it

A per-level row is the honest unit — Crafting at 190 and Crafting at 202 are different fights — but it is also a small sample, and small samples say nothing. Twenty rooms of Crafting spread over six levels can be six rows of "consistent" while the sim is ten points high on every one of them, because no single level ever gathers enough fights to prove it.

Each room type now gets a pooled row above the per-level ones: what the sim owed you over everything you have ever done in that kind of room, against what you got. The pooled prediction is weighted by how often each level was fought, so it is "expected clears ÷ attempts" rather than an average of rates — a level fought a hundred times says more about the total than one fought twice.

### Consumables are coloured against the target you set

A consumable lasting two days is fine if you asked for one and is the thing to go and fix if you asked for three. The tile and the panel both used a fixed one-hour threshold, so with "3 days" chosen the tile called Dragon Fruit Yogurt green while the panel's own Buy column said to buy 1.15K of it — two halves of one feature disagreeing.

Both now colour against the target. The setting moved into `utils/consumable-target.js` and is declared shared in the bundler config, because the panel that sets it and the tile that reads it are in different bundles and two copies would mean the tile never hearing about a change.

### Swept the rest of the panels for the same start-up race

Three separate bugs this week were one mistake: reading stored state at module scope, which runs long before IndexedDB is open, and getting the default back with no way to tell that from nothing having been stored.

- **The Houses panel** read which rooms you had switched off that way, so every room counted towards "affordable" until something happened to redraw it — with a "Database not available" line in the console saying exactly that. It waits now, and redraws when the answer lands.
- **`loadWhenReady`**, the shared helper for this, polled for about five seconds guessing when the database had opened, because a shut database and an empty one look the same from outside. Storage now says when it has finished starting up, so there is one thing to wait on. That covers its four users: the combat-level panel's target selection, the charm panel's folds, the watchlist, and the equipment-savings list.

The rest came out clean. The overlay reads its layout inside `initialize()`, which runs after storage is up; the DPs, IHurt and Profit panels rebuild their header controls on every redraw, so late state catches up on its own; and the panels built on the shared shell redraw their whole body every few seconds and keep no settings in their headers.

### The chest popup says which side of the book it is pricing at

TReasure always values loot at bid and labels the figure "bid". Toolasha values it through the profit pricing mode instead, which for most settings means ask — so the same chest reads 45.44K here and 43.1K there, and neither is wrong. Without the word there was no way to tell that apart from one of them being broken. The basis is now printed beside the figure, with the setting that controls it in the tooltip.

### The target the Consumables panel was saving never came back

The write was fine; the read was not. It happens at module scope, long before the database is open, so it came back with the default and there was no way to tell that from nothing having been stored — the same mistimed-read that stopped panels reopening. It waits for storage now.

### The Treasure header caught up with its settings

The header is built once, and a panel reopened at start-up builds it before the settings arrive — so it sat there claiming "Token value / Cowbells counted / Luck" whatever you had actually chosen, until it was closed and opened again. All three controls are refreshed on every redraw, and the sort picker is left alone while the pointer is in it.

### The Consumables panel remembers itself, and remembers the target

It reopens if the page was left with it up, like the rest of them — and it keeps the duration you picked. That one matters more than a preference usually does: every figure in the panel is measured against it, so a panel that forgets shows you a day's shortfall when you asked for a week's, and looks perfectly right doing it.

Going to the marketplace does not count as closing it. The panel gets out of the way because the marketplace opens underneath it; you went shopping, you did not put the panel away.

### The cost lines on the consumables tile are left-aligned

The tile centres its text. A flex line is unaffected by that and a plain `div` is not, so the two cost lines sat in the middle while everything above them started at the edge.

### The Treasure tile shows a chest

The overlay's generic chest glyph, replaced with the Large Treasure Chest's own art. The tile is about chests specifically, and item art says so at a glance where a symbol has to be learned first.

### The Treasure panel had a second thing to wait for

Its chest list arrives with the game's data; its **ledger** comes from storage, and that lands later still. A panel reopened at start-up drew the whole chest list against an empty ledger — "Nothing opened yet", against a real history — until it was closed and opened again. It redraws when the ledger arrives.

### The Treasure panel stopped waiting forever

A panel reopened at start-up is drawn before the game has sent anything, so it drew "Waiting for the game to send its chest data…" — and nothing redrew it. The message stayed up for the rest of the session, which reads as a panel that has stopped working rather than one that is early. It now looks again until there is something to draw.

### Chest contents keep their order

The item rows inside a chest were ordered by what each was worth, which meant they rearranged whenever a price moved and whenever the cape or cowbell valuation was changed — a list you had learned the shape of reordering itself for reasons that had nothing to do with the chest.

They are now ordered by how much of each the chest owes you, commonest first, and by nothing else. A drop table does not change, so neither does the order. This is unrelated to the sort picker, which only ever ordered the chests in the main list, and it is also the order TReasure lists them in.

### The chest popup closes on a click away again

Pinning it used to switch that off, on the reasoning that a moved popup wants to stay. But pinning says where the popup opens, not that it should stay on screen — and while a single click on its header was enough to pin it, that quietly took the dismissal away too.

### The consumables tile reads like CRack's

- **The item is named.** "3.17K remaining" never said _which_ consumable, which is the one thing the tile is for — you cannot top up a number.
- **The count is exact.** It is a stock figure, not a sum of money: `3,170`, not `3.17K`.
- **Count, icon, name, in that order**, with the count bold and coloured by how soon it runs out.
- **`Total Cost/Day:` gets its own line** above the two sides of the book. On a tile this narrow they never fitted on one line anyway; they ran together instead of admitting it.

### The marketplace badge is the game's badge, with our number in it

Two things were wrong, and the first explains the second.

The selector matched `NavigationBar_badge` as a _prefix_, so it also caught the element sitting beside the badge in the same sidebar item — the count was written into both, and the badge read "2 2". It now matches `NavigationBar_badge__`, with the two underscores that begin the CSS-module hash, which is the whole class name rather than a prefix of it.

And the count no longer comes through CSS at all. A number printed in a pseudo-element is a bare digit sitting where a styled badge should be; blanking the real text to make room for it meant hiding whatever was carrying the badge's shape and colour. The digits are rewritten in place instead, and put back whenever React writes its own over them — so the badge stays exactly the badge, and only the number differs. Hiding it outright is still a stylesheet, which is the one case where a rule the game does not know about is the right tool.

### A click is not a drag

Dragging a panel by its header fires an "it was moved" callback on release — and it fired on a press that never moved, which for most panels means saving the position it already had, and for the Treasure popup means being told to stay put. So **one click on the popup's header silently pinned it**, and it stopped appearing beside the chest dialog with nothing to say why.

The other half of that: the popup asked for its remembered position back on every opening whether or not it was pinned. A stale position was reapplied each time, and if the dialog was not found within the retries the popup simply stayed there. It now restores its size only unless it has been pinned.

### The unpin button no longer disappears when you press it

It was only drawn while the popup was pinned, so pressing it removed the button — which reads as the button breaking rather than as the setting changing. It is always there now, saying which way it is set: _Popup follows the chest dialog_ or _Popup stays where you put it_. Unpinning forgets where the popup was put and keeps how big it was, since only the position is what pinning is about.

### Remembered panels actually reopen

They recorded being open and then never came back, which is the more annoying half of the bug. Two things were wrong, and both are about _when_ a panel asks:

- **The database was not open yet.** Panels ask at module scope, which runs long before storage is initialised, so the read came back with the default — indistinguishable from having been closed. The storage module now hands out a promise that resolves once it has finished starting up, and the geometry store waits on it before its first read.
- **There was nothing to draw into.** The script runs at `document-start`, so at that moment there is no `<body>` to append a panel to. Reopening now waits for one.

Both waits live in a single `reopenIfLeftOpen`, which is what each panel calls, so there is one place for this rather than five.

### The treasure popup resizes in every direction again

It was capped with `max-height`, and the resize grip writes `height` — so dragging the corner downwards changed a number nothing rendered, and the popup could be made wider but never taller. It is measured once when it opens and given a plain height instead, which caps it just the same and leaves `height` as the only thing deciding how tall it is.

### Sort the chest list

The Treasure panel lists every chest in the game, ordered by how far each sits from expectation — which is the right answer to "which one let me down" and the worst possible one for "where is the chest I am looking for". A picker in the header offers luck, name, most opened, chest value, and coins up or down, and remembers which you chose.

It is a `<select>` in the header rather than above the list because the header is built once; a control rebuilt by the panel's redraw would shut its own dropdown under the pointer.

### The marketplace badge counts the finished ones

It said 2 for a filled sell order sitting beside a buy order that had taken 130 of 719 — and collecting those 130 does nothing except silence it until the next fill. It says 1.

The number has to come through CSS for the same reason the hiding did: React owns that node and rewrites its text on every update, so anything written into it is gone within the second. A generated rule blanks the real text and prints ours in a pseudo-element, which survives every re-render because the game does not know the rule is there. None finished still hides the badge outright rather than showing a zero.

### Panels remember whether they were open

Every panel built from MCS — DPs, IHurt, Profit, Party Luck, Party Loot, and the rest — reopens itself if the page was left with it up. A panel that has to be found and reopened after every refresh is a panel that gets opened once and then not bothered with.

Stored beside the geometry, because it is the same question: where a panel was, and whether it was anywhere at all. The read is fired off at module scope rather than awaited, so a panel appears a moment after the page — which is what a remembered panel looks like anyway.

The Houses and Treasure panels roll their own show/hide rather than using either shared base, so they were brought in by hand. Two details there worth naming:

- **A feature being disabled does not count as closing a panel.** The Treasure panel's teardown and its close button used the same method; only the button should stop it reopening, so they are now separate.
- **The chest popup is deliberately not restored.** It is a reaction to opening something, and a popup about a chest opened yesterday reappearing on load would be a stale answer to a question nobody asked.

### The treasure popup, closer to TReasure

- **Rows that say nothing are gone.** A chest's drop table runs to thirty-odd entries, most of them equipment at rates so long that a lifetime of opening owes you a hundredth of one. Listed, they read "0, 0.00 expected, −100%" — three figures agreeing that nothing happened, pushing the rows that did happen off the bottom. Anything that actually dropped is kept however unlikely it was, because that is exactly the row worth seeing.
- **Smaller**, and capped against the window rather than left to grow past the bottom of the screen.
- **Clicking away closes it**, as the game's own loot dialog does. Armed a tick late so the click that opened it does not immediately close it, and skipped once the popup has been dragged — moving it is how you say "stay".
- **Opening the full stats no longer closes it.** It is the thing you were reading when you decided you wanted more; taking it away answers the question by removing it.
- **An unpriced drop gets a real percentage now.** It used to read "no price" where the verdict goes. But an item nothing will price still has a drop rate, and "four when you were owed two and a quarter" is the same fact whether or not the market has an opinion — it is only the _total_ it cannot join, which the row still says.

### Portrait meters read like DPs, and the monsters get one too

- **Two lines per character**, this fight above the run: `1,052 DPS 1.9k cur` over `374 DPS 88.5k total`. The order is the point — the fight in front of you is the one you can still change, and the run is what you read it against.
- **The rate in full, the damage abbreviated.** They are read differently: a rate is compared against another rate, where `1,052` against `1.1K` _is_ the comparison, while a running total only has to convey a size.
- **A rate under every monster**, showing how fast that one is coming down.
- **Monsters are joined by slot, players by name** — opposite rules, for opposite reasons. Two Veyes side by side are two different fights that their names cannot tell apart, so a name-keyed rate would appear on both tiles and be true of neither. A slot is stable for the length of a battle, which is exactly how long the figure lives. Players keep the name join, because a slot stops meaning the same person the moment somebody leaves the party.
- **A per-fight tally now sits beside the per-run one** in the damage tracker, cleared when the next battle starts. The run's tally keys enemies by name, which is right for a run and cannot answer "which of these two", so the fight keeps its own.

### No arrow on the time-to-level tile

`Defense → 130:` ellipsised to `Defense → 1…` and lost the very number the arrow was introducing. The tile has no width to spare, so the arrow is gone in every case and the label is simply the level being worked towards. The starting level and where the target came from are in the tooltip.

### Portrait DPS was drawing, and being cropped away

The meter was positioned at `top: -14px`, outside the portrait tile's own box. The battle panel clips its children, so it was present in the DOM and invisible. It sits **in the flow** of the tile now, as MCS's does — the tile simply gets taller — and is re-seated on every draw, since React rebuilding the tile puts its children back in whatever order it likes.

### Refinement chests are not completions

A refinement chest takes a chest key to open like any other, and **no entry key**, because it is not what a completion pays. The dungeon key costing already had this right; the chest-luck reading did not — it took the guaranteed entries from the zone's reward table, and a refinement chest listed there would have counted as a completion that never happened, inflating both the chest tally and what it was owed. Excluded by name, so a refinement chest for a dungeon added later needs no list edit.

### Why the marketplace badge is hidden, on demand

`Toolasha.Debug.marketBadge()` in the console reports what the filter can see: whether the setting is on, how many listings it found and from where, which of them count as finished, and whether the hiding style is actually in the document. The feature's only output is the _absence_ of a badge, which looks identical to the setting being off, to the game not badging at all, and to every listing genuinely still working — there was no way to tell those apart from the outside.

It also now falls back to the last listing payload it saw when the character's book comes back empty, rather than treating an empty book as "nothing is finished".

### Audited the rest of the codebase for the same start-up bug

Sixteen features subscribe to `character_initialized`, and every one of them registers that listener from inside the handler for that same event — so none of them will ever receive its first firing.

Only the marketplace badge filter was actually broken by it. The rest either seed themselves at start-up (`remaining-xp`, `xp-tracker`, `guild-xp-tracker`, `collection-filters`, `queue-monitor-ui`, `task-reroll-tracker`), are explicitly only interested in character _switches_ — which do fire the event again (`action-panel-sort`) — or are driven by a DOM observer and do not depend on the event at all (`market-order-totals`, `estimated-listing-age`, `listing-price-display`, `action-time-display`, `settings-ui`, `task-profit-display`, `expected-value-calculator`).

One stale comment in `loadout-snapshot` claims its handler corrects a character id that was null when storage was first read. It cannot — the event has already gone — but the id is not null at that point either, so nothing is wrong beyond the comment.

### Fixed: the marketplace badge stayed down even for finished orders

The filter that quietens the sidebar badge for still-working orders was quietening everything, including a fully filled order with coins waiting to be collected.

- **It was subscribing to an event that had already fired.** Features are initialized from _inside_ the `character_initialized` handler, so a feature that registers its own listener for that event never receives it. The filter hid the badge on start-up and then waited to be told otherwise — and the telling had already happened. A filled order that survived a page reload stayed unbadged until some unrelated listing happened to change and trigger a `market_listings_updated`.
- **It now reads what is already known** at start-up instead of waiting.
- **And reads it from the data manager** rather than from a copy it accumulated itself. The data manager already merges every listing update into the character's book; a private copy could only drift from it, and would keep badging for a listing that had left the book entirely — the opposite failure, and one nobody would have connected to this.
- **The rule about which orders count has not changed.** A partly filled order that is still working is still not a reason to badge the sidebar.

### Fixed: the time-to-level tile named the level you already have

It read "Melee 135" beside a time, for a level long since earned. The number is now the level being worked _towards_, in both the automatic case and a chosen target one level ahead.

The old reasoning was that "135 → 136" gains an arrow saying nothing, so the arrow was dropped and the current level kept — which quietly swapped the number for the wrong one. The duration is the giveaway: it is time until the number, so the number has to be the one you do not have yet. A target further off still gets its arrow, because "→ 140" and "136" are different claims.

### Past sessions in the loot panel

FLoot's top bar, on our drop list. The panel answered "how is this run going"; the question people come back with is "what did last night earn", and that needs the run to be choosable.

- **A picker across the top**: the live run, every stored run by start time and length, and a combined view of the lot.
- **A run is archived when a different one starts**, because that is the first moment it is knowable to be over — nothing on the wire announces an ending, and a timer would be guessing. So the newest finished run appears as the next one begins, and the run in progress is never in the list. It does not need to be: it is the live session.
- **A session is its roster and its start time together**, the same identity the damage tally uses. Twenty are kept.
- **The combined view merges on the item, not on the game's slot key.** Two sessions number their loot slots independently, so merging on the raw key would put the same item in two rows — the same trap the per-player item table fell into once. Characters are followed by name for the same reason: position means nothing between runs.
- **The session timer / EPH tile opens it** on a double-click, since what a session timer raises is what the session produced. Total Profit still opens it too.
- **A chosen run that has since fallen off the list falls back to live**, rather than leaving the panel pointing at nothing.

### The game's own artwork, where the game has some

Emoji beside the game's UI look pasted on: an emoji is whatever font the browser picked, at whatever weight, in whatever palette its designer chose. The game's coin is _the_ coin.

- **Any sprite sheet, not just the item one.** `spriteUrl(sheet)` finds `skills`, `actions` and `combat_monsters` the same way the item sheet was already found — off an icon the game has drawn, because the URL carries a build hash that changes every update. Row segments take a `sheet` alongside `icon`.
- **`glyph(name)` returns artwork or text**, deciding for itself. Coin, chests, books, food, mana, damage dealt and taken have sprites; a bid order and a market trend are concepts rather than objects, so they stay emoji — which is what OPanel does with them too.
- **It falls back rather than failing.** The sheet can only be found once the game has drawn from it, so a glyph asked for too early is the emoji, and the row is never an empty box.

### The houses grid reads like JHouse

- **Every room carries the skill it boosts**, from the game's skill sheet — a milk bottle says Dairy Barn before the words have been read, which is what makes a grid of seventeen scannable. The room-to-skill map is JHouse's; a room nobody has mapped falls back to its own name, finds no sprite and draws a spacer, so an added room is a missing icon rather than somebody else's.
- **Materials are priced at both sides of the book**, as JHouse shows them, and they are genuinely different answers: ask is finishing the level today, bid is waiting for your own buy orders to fill. On a level wanting six thousand milk the gap between them is the decision.
- **Coins in a material list count at face value** rather than being looked up — a coin has no bid and no ask, and dropping it would understate the level by exactly the coin part.

### Damage on the battle portraits

Each character's DPS and total damage, drawn on their own portrait. The DPS tile already ranks the party, and a ranked list is the wrong shape for the question asked mid-fight, which is "is _that_ one pulling their weight" while looking straight at them.

- **Matched by name, not by position.** The obvious join is index — the payload's player 0 is the leftmost portrait — and it is exactly the join that produced the bug fixed above. A portrait whose name is not in the tally gets nothing rather than getting somebody else's damage.
- **Off by default**, since the portraits already carry health, mana and an ability bar. Settings → Combat, with a choice of above or below the portrait.
- **The rate reads first**, because it is the comparable figure: total damage rewards whoever has been in the fight longest, which after a death is not a measure of anything. Too early for a rate shows a dash rather than a zero.
- **This is the most fragile thing in the script**, and worth saying so: it reaches into the game's own DOM rather than into the payload, and the class names carry a build hash that changes with every game update. Every selector is a prefix match, the meters are re-attached on a `MutationObserver` because the game rebuilds the panel from under them, and the failure mode is drawing nothing.

### Fixed: a party you left stayed in the DPS table, and your name appeared twice

Both symptoms, one cause. The damage tally is keyed by **battle slot**, which is a position in this fight rather than an identity — fine while the fight keeps its shape, wrong the moment it does not.

- **Leave a party of five and slots 1 to 4 stop being anybody**, but they were never cleared, so four people who had gone kept their rows.
- **And slot 0 stops being who it was.** Alone you are slot 0; in that party you were slot 3. Both rows survived, both labelled with your name, which is the duplicate in the screenshot.
- **A run is now identified by its roster and its start time together**, the way MCS names one. Either half alone is not enough: the same party in a new zone is a new run, and the same zone with somebody gone is a different run measuring different people. When the key changes the tally resets, because a slot-keyed tally genuinely cannot survive a reshuffle — carrying it over would hand one person's damage to whoever inherited their slot.
- **Names are rebuilt every battle** rather than merged, for the same reason the monster map already was.

### One set of glyphs for the overlay

Emoji were chosen per file, so a coin was 🪙 in one row and 💰 in another and the overlay read as several tools stacked rather than one. They now come from a single `GLYPHS` vocabulary in `overlay-format.js`, following OPanel's choices where OPanel has an opinion — the two sit side by side on the same screen, and a reader should not have to learn two alphabets.

### Party Loot, behind the profit tile

The Total Profit tile now carries a coin figure per character, and the question that raises is _what_ — a party does not split a dungeon evenly, because loot is rolled per character against their own drop gear. FLoot's answer, as a panel.

- **A card per character**: what they banked, what that is per day, and every drop with its value and count, biggest first. Yours first and in gold whatever order the party arrived in.
- **The party total sits above them**, because "did we do well" is asked before "who got what" — and it is the party against the party rather than an average of the characters, which would weight somebody who looted one item the same as somebody who looted a hundred.
- **Item rows link to the marketplace**, icon and name both.
- **An unpriced drop reads as unpriced, not as worthless.** Zero is a claim about what something is worth; the market has simply not said.
- **Nothing is recomputed here.** Every figure comes from `calculatePlayerStats`, the same function the Combat Statistics popup and the overlay rows call — a third opinion about a run's income is a third number to reconcile when they disagree.
- **Double-clicking Total Profit opens it.** Combat Revenue still opens the Profit panel, which answers the other question: which pricing, and what the costs were.

### Houses: rooms you can switch off, and the materials you are actually short of

- **A checkbox per room, as JHouse has.** A room nobody intends to buy — a skill you do not train — sat in the denominator forever, so "14 of 17 affordable" was answering a question about somebody else's character. An unchecked room leaves _both_ halves of the count and stops being eligible as "cheapest"; it stays in the grid, dimmed, because you have to be able to switch it back on. Remembered across sessions.
- **Materials say what is missing, not just what is needed.** Each row now carries the item's icon and a `−N` shortfall beside the have/need pair, and a line underneath totals what those missing materials would cost to buy at ask. That is a different number from the upgrade cost, which prices every material including the ones already in your bags.
- **The material rows link through to the marketplace**, icon and name both, since going to buy the thing you are short of is the next move anyway. Coins are exempt — there is nowhere to click to.

### The overlay filled in on the next wave; now it fills in on load

After a refresh every combat tile read "No loot tracked yet", "No combat yet", "Not in combat" until the next battle started. In a dungeon a battle is a wave, so that is tens of seconds of a blank overlay — and MCS has no such gap.

- **The snapshot was already being written, and only the popup read it back.** `combat-stats-data-collector` saves the run to IndexedDB on every battle and has a `loadLatestData` to restore it, which `initialize` never called — the Combat Statistics popup was the only caller. That is exactly why the popup survived a reload and the overlay beside it did not. It is called at start-up now.
- **Safe to restore unconditionally**, because the rows date the run from `combatStartTime` rather than from when it was stored, and the next `new_battle` replaces it outright.
- **The DPS table borrows the party's names too.** Damage arrives on `battle_updated`, which is constant, but names arrive on `new_battle`, which is a wave apart — so a reload drew real numbers against "Player 1" through "Player 5". The names come from the restored snapshot, which is built from the same player list in the same order.
- **A test that fails without the fix**, since nothing here throws: the failure is a tile quietly saying it has nothing.

### A restored run is dropped when it stops describing anything

The other half of restoring a snapshot: knowing when to stop. A finished run left on the overlay is worse than a blank one, because its per-day rates keep dividing by a clock nobody stopped — they decay toward zero and read as a run going badly rather than as a run that is not happening.

- **Elapsed time is the wrong test, and it is the obvious one.** A snapshot can be twelve hours old for two opposite reasons: the character has been fighting all night with the tab shut, or combat stopped last night. The first is the correct run, slightly behind, and blanking it reintroduces the very gap this was meant to close. The second is history. The clock cannot tell them apart.
- **The current action decides it.** A combat action in progress means the run is live and the snapshot is shown whatever its age. No combat action means it is over.
- **A different zone in progress means it is somebody else's run**, and it is dropped even if it is a minute old — the clock would have called that fresh.
- **The clock is only the fallback**, for when combat has stopped or the character's actions have not loaded yet. Ten minutes, so the run you just finished stays up while you read it, then it belongs to the popup — which still shows it on demand, because the popup falls back to reading storage directly.
- **Snapshots now record the zone they were fought in.** One written by an earlier version has none, so it falls back to the clock rather than crashing or silently passing.

Both degraded versions were checked against the tests: removing the cutoff fails three, and a naive time-only cutoff fails two — including the overnight run, which is the case that matters.

### A refresh no longer throws the dungeon away, and Total Profit shows the party

Two unrelated faults, both visible in the same screenshot.

- **The chest reading survives a reload now.** It did not, and MCS's equivalent does — because MCS stores nothing for it. `totalLootMap` is the loot for the **combat session**, not the character's inventory, and the server accumulates it and re-sends the whole thing on every `new_battle` along with `combatStartTime`. Nothing needs keeping; the server keeps it. The tally was treating a first sighting as a baseline, which is the right rule for an inventory — somebody may walk in holding a hundred chests from yesterday — and quite wrong for session loot. Every refresh reset the run to zero.
- **The completions behind those chests are recovered too.** A chest total with no completion count cannot be placed, and that part genuinely is lost on reload. The dungeon tracker has been writing every finished run to storage all along, so they are counted from there — runs of this dungeon stamped at or after the session began. The panel says how many were read back.
- **A session is now identified by its start time** rather than by the battle counter, which is what makes a reload continue a session instead of starting one. A falling battle id stays as the fallback for a payload without a start time.
- **Total Profit is a row per character.** It only ever asked the calculator about the current player, so a five-person party showed one line — the spread between five people splitting a zone is exactly what the tile is for. Yours is first and in gold whatever order the party arrived in, and the tile's default height now fits a party rather than clipping it.

### Counted keys, counted completions, and a level gap that was invisible

Three things the chest reading was guessing at, all now measured.

- **Keys are counted continuously, not sampled.** The obvious measurement is the count at the start of a run against the count at the end, and it breaks the moment somebody buys keys mid-run: start at 10, spend 3, buy 20, and the difference says you _gained_ 17. Two samples cannot tell one number changing twice from one number changing once. So `items_updated` is watched instead and the two directions are added up separately — a fall is spending, a rise is acquiring, and a mid-run restock lands in the second and never touches the first.
- **Party members are only visible twice a run**, through the key-count chat message, so their figure is trusted only while it falls. A rise is marked unmeasurable rather than counted as zero spent, which would quietly drag the average down every time somebody restocked.
- **Completions come from the dungeon tracker** where it has them, which it does in a party. It counts a run that paid somebody _nothing_ — something watching the chest count can never do, because nothing is exactly what such a run looks like. The chest-rise inference stays as the solo fallback, and the panel says which one is in use.
- **The level gap is no longer invisible.** A character far enough below the top of the party has their drops cut, and the formula existed only inside the simulator, applied to per-monster drops. The live model had no notion of it at all, so the simulator would predict a level-gapped player taking a fraction of the loot and Party Luck would then call that same player unlucky for it. The formula now lives in `utils/dungeon-level-gap.js` and the simulator imports it, so the two cannot drift.
- **The gap is in the expectation, and a mean below one chest is a chance.** A party of five with no quantity bonus is a mean of 1 chest each; at a 90% penalty that is 0.1, and a tenth of a chest is not something the game can hand over. It is realised the way 1.295 is — as a probability. Nine completions in ten pay that character nothing and the tenth pays one, which is why a level-gapped player sees zero _sometimes_ rather than always. Below one chest a completion there is no guaranteed part at all and the wording says so, since "0 guaranteed" reads as "you get nothing".
- **So the percentile is about their luck again**, not about their party. One chest against an owed 0.375 is a good run, and it now reads as one instead of as the catastrophe a full-share expectation called it.
- **The size of the cut is still borrowed**, not measured: it is the debuff the simulator applies to monster drops, and nothing has confirmed a dungeon uses the same number. So the observed rate is shown beside the modelled one — if the multiplier is wrong for chests, the two diverge on screen rather than quietly.

### A dungeon is measured by its chests

Party Luck and the Luck and Over Expected tiles showed nothing at all in a dungeon, for everybody, with no explanation. The drop model declines dungeons on purpose — they pay from a reward table on completion rather than per monster — but there is a question a dungeon _can_ answer, and it is the one people ask: how many chests came, against how many were owed.

- **The drop-quantity bonus is the whole of the randomness.** A completion pays five chests split across the party, scaled by Combat Drop Quantity. Five people at +29.5% is a mean of 1.295 each: one chest guaranteed and a 29.5% chance of a second — the buff people describe as "double chests sometimes". Everything else about a dungeon payout is fixed, so the extras are the only thing luck can be measured on.
- **Completions are counted, not assumed.** The game never states how many dungeons finished; only the simulator has ever had that number, and only for runs it simulated. So each player's chest count is watched, and every rise is one completion that paid what it rose by. The first sighting starts the count rather than paying out, so somebody who walked in holding yesterday's chests is not a windfall.
- **Which item is the chest comes from the zone**, not from a list: the reward table's guaranteed entries are the chests, which is the same test the simulator applies. A named list is the fallback for when the zone data has not loaded.
- **The percentile is over the extras**, from an exactly-summed binomial. A hundred completions that each paid their guaranteed chest and nothing more is not a hundred pieces of bad luck.
- **Where it shows.** The Luck tile carries the percentile per player, Over Expected carries chests against chests owed, and the Party Luck panel gets a Dungeon chests card with the completions, the split, and each run's payout. A player with no completion yet says so instead of reading as a disaster.
- **A whole-number mean says there is no luck in it**, rather than inventing a percentile for something that never varied.

### The Profit panel answers for the whole party

It only ever asked the calculator about one character. Loot is rolled per character against their own drop gear, so five people splitting a zone do not split it evenly — and who is actually being paid is a coarser question than which price to sell at.

- **A row per character**, revenue and profit per day, in whichever of the four cases is selected. Yours is first and in gold whatever order the party arrived in.
- **Revenue beside profit, not profit alone.** In a dungeon the two are far apart: the key is charged the moment the chest drops and the chest only pays when it is opened, so a run reads as a loss until it does not.
- **Chests are already counted at their expected value** — what opening one is worth, rather than what it sells for. The panel now says so when a dungeon is detected, since a revenue figure built from unopened chests is worth explaining.
- **Solo the section is not drawn at all**, because a party of one is the rest of the panel.

### Party Luck cannot measure a dungeon, and should say so

Written down as a known gap, and fixed by the chest reading above. Kept here because the reason still holds: the drop model declines dungeons deliberately — they pay from a reward table on completion rather than per monster, so a spawn table is the wrong model rather than an imprecise one.

### Fixed: in a five-person party, whoever tanked collected everyone else's damage

Two characters was enough to show that the old rule was not losing anything. Five was enough to show what it _was_ getting wrong, and two could not: with one person holding aggro and four hitting, the character a tick is about is very often the one being **hit**.

- **The bottom rung was "only one character in this tick, so it was them".** On 82 of 440 damage ticks that lone character was in the tick because their own health and damage counter had moved. They had not attacked. Crediting them handed about 8,500 points of other people's damage to whoever was tanking.
- **It is now "the last character to swing".** A swing and the damage it does are not always in the same tick: 76 of those 82 had somebody else swinging one real tick earlier.
- **Every payload arrives twice** — 757 of 1,465 combat messages in that recording are byte-identical to the one before. Nothing has to care, since a duplicate diffs to no change, but it is why the swing behind a hit looked two ticks back rather than one.
- **Two characters swinging on the same tick is rare but real**: three times in fourteen hundred ticks, one of which dealt damage. That falls to mana, and failing that to whoever swung last, rather than being pretended away.
- **The recording is a fixture**, names replaced with Player One through Player Five, and one of its tests replays the old rung to check the fault reappears.

### A recorded party, and what it settled

Every recording until now was solo, and solo cannot exercise the question attribution exists to answer: when a monster loses health, which of the party did it. A rule that always names the same character passes every solo test there is.

- **Two characters, twelve battles, two minutes**, now a fixture. The names in it are replaced with Player One and Player Two.
- **Damage dealt is split between them**, damage taken is kept per character, and every hit taken is attributed to one of eleven named monsters with the per-player split inside each enemy card — the thing solo can never produce.
- **The enemy breakdown adds up to what the party took**, 1,515 across both of them.
- **It corrected a claim rather than confirming one**, which is the main reason it was worth taking; see the entry below.
- **A guard on the fixture** asserts the attack counter is still in it, so trimming it later fails loudly rather than quietly weakening the attribution — the same trap an earlier fixture fell into.

### A kill is priced from the tick, not from the screen

Every monster a tick mentions states its own full health as `mHP` — on all 292 monster entries across two recorded runs, agreeing with what the battle said each time.

- **The DPs panel takes it from there.** It prices a kill by the health bar it took to empty, and previously had that only from the start of a battle — so a monster first met after a reload had no figure at all until the battle-panel reading supplied one.
- **The battle-panel reading gives up trying.** It only ever needed the current health, to match a tile against a monster; the maximum was a second and worse source for a number the payload already gives. Reading it also meant untangling two health bars that flatten into one string, which is a hazard now gone.
- **`isActive` was measured and left alone.** It looked like a cleaner death signal than health crossing zero, and it is not: across both recordings the two always fire on the same tick — five times and thirteen times, neither ever alone. Nothing to gain.

### The caster is identified by an attack counter

Every player carries `atkCounter` and it goes up when they attack. Across three recorded runs it rose on every tick that dealt damage, and on a recorded two-character party it named one character and never both.

- **The caster is identified by that counter now**, not by mana. Only an ability costs mana, so `cMP` falling named the actor on eight of sixty-nine solo damage ticks.
- **Correcting what was claimed here first.** The entry that shipped with this change said a party was losing nine hits in ten. That was measured by splicing a bystander into _every_ tick of a solo recording, and a real party does not look like that: `pMap` is a delta exactly as `mMap` is, so a character who did nothing is not in the tick at all. On a genuine two-character recording — twelve battles, a hundred and thirty-seven damage ticks — the old rule and the new one pick the _same_ character every single time, including the eight ticks that carried both.
- **So this is a better-founded answer, not a rescue.** The actor is named because a counter of attacks went up, rather than inferred from being the only one the payload mentioned. The inference was right here; nothing guarantees it stays right.
- **Mana is kept below the counter**, for the tick where two people act at once and one of them cast, and for a payload that carries no counter at all.

### The auto-record switch turns itself off

It writes its file and puts the switch back, so the next load is an ordinary one. A switch that downloads something on every page load until somebody remembers it is a switch left on by accident, and collecting one recording is finished the moment the file exists. It stays armed if there was nothing to save — loading outside combat is not the recording anybody was after.

### Fixed: a refresh named the first monster of the wave and no others

The battle panel is read for the monsters' names after a reload, because the client never receives the message that names them. That reading stopped as soon as it had found anything — and `mMap` is a delta, so a wave of two arrives across several ticks: the first monster reported on the very first tick, the second not for another two. The first got a name, the second never did, and every hit it landed went to Unknown Enemy for the rest of the fight.

- **The panel is read on every tick until a battle is announced**, not merely while nothing is known, so a wave that arrives a monster at a time is named all the way through.
- **A name once read is never overwritten.** The earlier reading was taken while that monster was actually on screen; a later health match could be a coincidence.
- **The same fix applies to the kill tally**, which had the same guard and lost the same monsters.
- **Confirmed against a recorded refresh** that had been reproducing the fault: nineteen points of damage sitting under Unknown Enemy move to the Eye that dealt them, and nothing is left unattributed. That recording is now a fixture, along with the snapshots of the battle panel it carries — so this is tested against the screen the browser actually had, not a reconstruction of it.
- **The selectors were fine all along.** The snapshots show the monster area, the unit grid and every tile parsing correctly. It was the guard.

### The recorder can catch the refresh

The Record button in the Damage panel can only start once a session is already running, which means it can never capture the seconds that matter most: reload mid-fight and the client never sees the message that names what you are fighting, and what arrives instead is not something to reason about from the outside.

- **Auto-record combat on load**, off by default, starts the recorder the moment the page does and writes the file out on its own after a set number of seconds (sixty by default, ten to six hundred). Nobody is watching a recording that started itself, so it hands over the file without being asked.
- **It snapshots the battle panel on every tick until the first battle is announced.** Whether the monsters' names can be read off the screen during that window is the other half of the same question, and a recording made during a refresh can now carry the answer rather than leaving it to be guessed at.
- **The snapshots stop once the payload names the wave**, because from that point the screen has nothing to add.
- **Both damage trackers move out of Loot Log and into Combat Features**, along with the new switches. They had been filed under Loot Log, which is where nobody would look for them and where I could not find them either.

### Fixed: everything went to Unknown Enemy, and the fixture was why

The previous change sent every hit of a live session to Unknown Enemy while three replay tests passed. It had been measured against a recording that was **hand-trimmed to five fields per monster** when it became a fixture, and the rung derived from it — "a monster in the delta with nothing changed is the one that swung" — held on thirty-seven of that recording's forty-two hits only because the trimming had removed everything that changes. Against a real payload it fires never.

- **`atkCounter` is what identifies the attacker**, and it was there the whole time — a counter that goes up when a monster attacks, sitting in a field the old fixture had thrown away. On an untrimmed dungeon recording it names the attacker on thirty-two of the thirty-eight ticks the character was hit; the other six are a monster's first appearance in the delta, alone, which is now its own rung.
- **Thirteen hits, thirteen named, no Unknown Enemy** on that recording — against Veyes, Eye and Eyes, in waves of two and three.
- **The fixture keeps every field a tick carries.** That is the whole point of the new one, and a test asserts `atkCounter` is still in it, so trimming it later would fail loudly rather than quietly weaken the attribution.
- **The old recording is kept and labelled.** It is still a good check that the arithmetic holds on a thin payload, and it now says in as many words that nothing may be derived from it.

### The payload names the attacker after all

Unknown Enemy kept turning up in waves even after the reload fix, because that fix was for a different cause. Going back to the recorded run to measure rather than reason turned up something better: **`mMap` is a delta**. A tick does not carry the wave, it carries the units the server touched — nought or one entry per tick against rosters of three.

- **A monster in the delta with nothing changed is the one that swung.** Same health, same mana, same counters, and there anyway. Across the recording that held on every one of the forty-two ticks the character was hit, and the wave was still three strong for thirty-six of them. That is the attacker, stated by the payload.
- **The old rung 2 was right by accident.** It said "there is only one monster in the tick, so there is no ambiguity" — but the ambiguity it was dodging was in the delta, not in the fight. Believing the wrong reason is what left it crediting the monster you were attacking whenever two units reported on the same tick, which in a wave is most of the time.
- **Being hit is now the last rung, not the second.** A monster whose own damage counter rose is one _you_ hit. That is evidence about your target and says nothing about theirs.
- **Two monsters of the same kind are no longer ambiguous.** "An Eyes hit you for 41" is true whichever of the two it was. Only candidates that disagree fall through to Unknown Enemy, and a wrong name would be worse than none — it would move damage from one monster of a wave onto another and then read as evidence about which is dangerous.
- **Some Unknown Enemy remains, and it is honest.** A tick where you were hit and the server mentioned no monster at all cannot name one, and neither can two different monsters swinging together.

### Reloading mid-fight no longer costs you the monsters' names

A combat tick carries each monster's health, mana and two counters — and nothing that says what the monster is. Identity arrives once, in the message that starts a battle, and a page reloaded mid-fight never sees it. So everything that hit you for the rest of that battle went to "Unknown Enemy", and everything you killed in it went nowhere at all. MCS has the same hole for the same reason.

- **The names are recovered from the battle panel**, which is drawing them the whole time.
- **Matched on health, not on position.** The obvious join is that the first tile is monster 0, which is an assumption about how the panel handles a dead monster — the kind that holds until a game update and then silently mis-attributes everything. Health is a number both sides state.
- **Two monsters at the same health resolve themselves.** If they have the same name it does not matter which is which, and if they do not, nothing is claimed. A wave of three Eyes at full health is the common case and it is the harmless one.
- **The kill counts stop coming up short too.** An unnamed enemy was dropped from the DPs panel's kill tally rather than shown, so a reload quietly lost a fight's worth of kills. The monster's full health bar comes back with the name, which is what a kill is priced by.
- **The half-battle is not filed as a wave.** Part of an encounter is not the composition that was fought, and counting it as one would make that wave's per-encounter average wrong from then on.
- **Every part of it fails closed.** A missing panel, a renamed class, a tile whose shape changed — each produces nothing, and nothing means "Unknown Enemy" exactly as before. It cannot put a wrong name where a right one would have been.

### Encounters & Kills, against what the zone owed you

IHurt's last section. A kill count on its own is not a fact about a run — seven Eyes is a lot or a little depending entirely on how often the zone spawns them, and that is not a number anybody carries around.

- **Actual against expected, per monster, with the difference as a percentage.** The same reading Drop Luck gives for coins, applied to the spawns that produced them.
- **The expectation is solved rather than sampled.** A wave is drawn from a weighted table until the next draw would break its strength budget, so a heavy monster turns up less often than its weight suggests and a light one more. The arithmetic for that was already here for Drop Luck; this is the layer that turns per-wave expectations into per-run ones.
- **The battle in progress is not counted.** Its monsters are partly dead and partly not, and counting it in full makes every zone look unlucky by about one wave — which at seven battles is fifteen per cent of the reading.
- **A boss wave replaces an ordinary one rather than joining it**, so twenty battles with a boss every ten is eighteen ordinary waves and two bosses, not twenty and two.
- **A monster the zone owes you and has not produced is listed at zero**, dimmed. A rare spawn you have not seen once is exactly what somebody checking this is looking for, and a row that is simply absent reads as "not in this zone".
- **A zone that cannot be modelled shows counts and no comparison** — a dungeon runs a script and pays out at the end, so a spawn table would be the wrong model rather than an imprecise one. Comparing against nothing would call every kill infinitely lucky.

### Fixed: IHurt showed zeroes, and DPs was broken in the release build

IHurt reported nothing at all — no damage taken, no regeneration, no enemies, and "nothing has hit the party yet" through a fight that was plainly hitting the party. The tracker was working; the panel could not reach it.

- **The panel now imports the tracker instead of reaching for a global.** It was reading `Toolasha.Combat.damageTakenTracker.takenBreakdown`, and what sits at that global is the tracker's _feature_ object — the thing with `initialize` and `cleanup` on it. So the lookup was `undefined`, the optional call returned nothing, and every figure defaulted to zero.
- **The same mistake had already broken the DPs panel in the release build**, which is the more serious half of this. A module in rollup's externals map is not bundled into the libraries that import it — every import compiles to a property read off one global. The Combat library was publishing `damage-tracker.js`'s default export there, so `damageBreakdown` and its neighbours resolved to `undefined` in the production bundles. It never showed up in testing because the dev standalone build has no externals: it bundles everything, imports resolve normally, and it works. Both trackers are now published as modules.
- **A test reads the rollup config, walks the real import graph, and checks every cross-bundle named import against what its library actually publishes.** Sixty-nine of them. It accepts any shape that works — a namespace import, a hand-built object, a top-level re-export — because several are already written each of those ways and all of them are correct. What it rejects is a default export sitting where a module should be.

### The Deaths panel is IHurt now

It showed a death count and a rate, which is the tile with more decimal places. The question a deaths panel exists to answer is not "how many" but "can this zone be idled overnight", and a count cannot answer it — you find out by dying.

- **Damage taken and health regenerated, side by side and never netted.** A net figure of −200 describes both a comfortable zone and one you barely survive. 3,400 taken against 3,600 healed is sustainable; 3,400 against 200 is a run that ends while you are asleep.
- **Broken out by what is dealing it**, with the hit range for each. A wave whose average hit is forty is comfortable until one of its members hits for two hundred, and only the maximum says so. In a party, each monster's damage is split by who it landed on.
- **And by wave composition** — `Eye x2 + Veyes` — with encounters, total and average per encounter. Sorted and counted rather than taken in spawn order, so the same three monsters handed over in a different order are recognised as the same wave rather than filed under six names that never accumulate enough encounters to average.
- **Deaths still come from the server.** This can see a health bar cross zero and does, but two sources for one number is two numbers that eventually disagree, and the server's is the one that is right. Each source supplies only what it knows.
- **A hit is the damage counter rising, not health falling.** Health moves for regeneration, for bleeds and for food. The counter also gives the one event a health diff can never express: a **miss** is the counter rising with the health unchanged.
- **Which monster hit you is a guess above a certain party size, and it says so.** A monster casting is identified by its mana, exactly as the outgoing side identifies a caster — but an auto-attack spends none, and most of what hits you is auto-attacks. So there is a ladder: a monster that cast, then a lone monster, then the weak proxy IHurt uses, then nobody. Unattributed damage is shown as **Unknown Enemy** rather than credited to a guess, and the enemy totals still add up to the party total.
- **Verified against a real recorded fight**, the same sixty-eight seconds on Planet of the Eyes the outgoing side replays, read from the other end: 703 taken against 936 healed, the enemy breakdown adding up to the total, and the shortfall in the wave breakdown being exactly the ticks recorded before the first battle started.

### Fixed: the Overlay switch was invisible

It was added to the strip, positioned, kept in place, and could not be seen. The switch is a clone of one of the game's own tabs, so that it looks like whatever the game currently thinks a tab looks like — and it was cloning a hidden one.

- **It is no longer copied from a tab the game has hidden.** With "show Toolasha tab by default" on, the game's own Inventory tab is set to `display: none` — and it is the first tab in the strip, so it was exactly what the search picked. The clone brought that inline style along with it.
- **It no longer inherits its model's position.** Tab Reorder lays the strip out with CSS `order`, and a clone carries that number, which would park the switch on top of the very tab it was copied from.
- **Nor its model's drag handle**, which survived cloning without the handlers that gave it meaning.
- **Injected tabs are not used as the model.** Toolasha and Optimizer are added by this script; cloning one would copy whatever that feature had done to itself.

### Fixed: docking cut the bottom row of tiles off

The column did not shrink to make room — it grew, so the docked panel hung off the bottom of the window with its last row of tiles sliced in half.

- **The column is measured against the window rather than against its parent.** The rule that was supposed to constrain it said `max-height: 100%`, which quietly does nothing: a percentage resolves against the parent's height, that height is not definite, so there was no constraint at all and the column grew to fit whatever was in it. From the column's own top to the bottom of the screen is a real number, and once the column has one the flex rules divide it as intended.
- **It re-measures when the window changes shape**, and once a second, so a wrapping tab strip or a resized window does not leave it stale.
- **The panel starts as tall as its tiles**, instead of at a fixed 220 pixels. A fixed starting height is a guess about a layout it has never seen, and a guess that is too small is precisely what cut the tiles off. Drag the top edge once and that height is what it keeps.
- **It will not take so much of the column that the inventory has nowhere to draw.** A height remembered from a tall window and reopened in a short one would otherwise leave a column that is entirely overlay.

### An Overlay switch in the character tabs, and somewhere for the overlay to live

The overlay was opened from a button inside the settings dialog. That is two clicks and a scroll away from something people turn on and off several times an hour, and the cost of that is not the clicks — it is that everybody leaves it up permanently and works around whatever it covers.

- **An Overlay switch beside Inventory**, before Optimizer, drawn the way Room Logs is: a clone of a real tab, so it inherits whatever the game currently thinks a tab looks like rather than a copy that drifts at the next patch. Dim when the overlay is down, lit when it is up — a button that does nothing visible on the second click reads as broken.
- **It never highlights as a selected tab.** It opens a panel rather than choosing what the column shows, and a column showing Inventory with Overlay highlighted would be saying something untrue.
- **The switch follows the panel**, including when the panel is closed by its own ✕, so it never claims a state the overlay is not in.
- **⇲ docks the overlay below the character tabs**, in the column's own flow, and the inventory gives up the height rather than being covered — which is the point. Floating over the game is the wrong resting place for a panel that is always up: whatever it covers is covered permanently, and moving it out of the way only means moving it somewhere else that is also in the way.
- **Nothing measures anything.** Docked, the panel is a sibling of the tab body and the column becomes a flex column, so the game's own layout hands the body the leftover height. It survives the window changing, the column being resized, and the combat panel's own height setting without a single recalculation.
- **Drag its top edge to trade height with the inventory.** That edge is the boundary being moved, so it is where the handle belongs; a corner grip would be the wrong gesture for something that only has a height to choose.
- **It puts itself back after the game rebuilds the column**, which switching tabs does.
- **Asked to dock before the column exists, it opens floating instead of not at all** — which is what a reload looks like, since the setting is read back before the game has drawn the column it names.

### A tile with nothing to report says so

Tiles went blank when their feature had nothing yet, which looks broken rather than idle — you cannot tell a feature waiting for its first measurement from one that has fallen over, and on an overlay of a dozen tiles the empty ones are exactly the ones your eye keeps returning to, because there is nothing there to finish reading.

- **Every row can say what it would rather say when idle**, and twenty-six of them now do: "Not in combat", "No run measured yet", "Nothing watched", "No chests opened". Naming the condition rather than the absence is what tells idle apart from broken.
- **A row that says nothing names itself** — "No drop luck data" — which at least identifies which tile is which while a layout is being arranged.
- **A tile drawing only an icon is left alone.** A tile showing a coin and no words has drawn exactly what it meant to.

### Fixed: a small tile could not be made bigger again

The text-size buttons sit in a tile's bottom-left corner and the resize grip in its bottom-right, which is fine until the tile is narrower than two buttons — a tile may be forty pixels wide, and two buttons are wider than that. The buttons then covered the grip, and the grip is the only thing that would have made the tile bigger again, so the tile was stuck at exactly the size that caused it.

- **The grip is drawn above the buttons.** Whichever is on top takes the mouse, and it has to be the one that gets you out.
- **It carries its own backdrop and is a little larger**, because on a small tile it is now drawn over a button, and a bare triangle on top of one reads as neither.
- **The buttons keep clear of the corner where there is room**, so on a tile with space nothing overlaps at all.

### The DPS, Over Expected and Luck tiles line up

They sit in a row beside each other and were laid out as if each were alone, so nothing agreed with anything: columns within a tile, and lines across the three of them.

- **The lines of a tile share columns.** Each line used to be laid out independently — right for an income line above a cost line, which are different facts, and wrong for a player row above a total, which is the same measurement twice. A total sitting a few pixels off the figure it totals makes a reader check whether it is even the same kind of number. They are a grid now: the name column takes the slack and every figure lands against the right edge, whether or not each line has the same number of them.
- **Only a name may be truncated, never a figure.** `1.2…` reads as a number rather than as a truncation.
- **Digits are one width**, so a column of figures stops shifting as it counts.
- **Lines start at the top of a tile rather than centred.** This is what stopped the three tiles agreeing: they carry different numbers of lines — DPS has a player and a total, Luck has one — and centring put the single line of one halfway down the two lines of the next. Aligned to the top, the first line of every tile is at the same height, so tiles whose tops agree have figures that agree.

### Drop Luck breaks out per player after all

Last change said a percentile could not be split between a party. That was wrong: it cannot be _divided_, but it can be computed again for each player, and doing so gives a genuinely different number for each of them.

- **A row per player, each against their own distribution.** Everybody's drop gear differs, so everybody's distribution differs — the same haul is a remarkable run for one of them and an ordinary one for another. The party's percentile repeated under two names would have said nothing; these are separate figures.
- **It is the better per-player reading**, and better than Over Expected's. Takings against expectation say how far off the mean somebody landed; they cannot say whether that is unusual. On a zone whose value rides on one rare, −20% is an entirely ordinary run, and on a zone of small steady drops it is a bad one. Only the distribution knows which.
- **Computed when a session is analysed, not while drawing.** Inverting a distribution costs about ten milliseconds — nothing once a session, and a frozen overlay if it ran per player on a tile that redraws every second.
- **Solo is still one row**, deliberately: the session percentile already _is_ that player's, since the model was built from their bonuses. A second one would be the same number arrived at twice.
- **Luck: only you** joins the other tile options, now that there is more than one row for it to narrow.

### Only-numbers options for the luck tiles

Three checkboxes beside the row list in the overlay's settings, where OPanel keeps the same ones — somebody arranging an overlay is already looking there and would not think to open a settings dialog for it.

- **Luck: only numbers** and **Expected: only numbers** drop the names and leave the figures. On a tile narrowed to sit beside five others, the name is the part you already know.
- **Expected: only you** shows your row alone. The total goes with it: a total of one row is that row again, printed twice.
- The checkboxes share one builder now rather than a dozen lines each, so the next one is three lines.

### The DPS and luck tiles, in OPanel's shapes

- **DPS reads to a tenth.** OPanel writes `347.6` rather than `348`, and at these magnitudes the tenth is the figure people watch move as they change a rotation. Past ten thousand it is noise on a number that no longer fits, so the compact form takes over there.
- **Drop Luck is your name and the figure**, which is the shape Lucky's tile has, rather than the word "Luck" and a number. Still one row in a party: the percentile is a property of the session — how unusual this run was against the zone's own distribution — and there is no honest way to split it between the people who were in it.
- **Over Expected is a row per player and a total, whether or not there is a party.** It had a separate solo layout carrying the coins the percentage came from; those are three times as wide as the tile and are the tooltip now. One shape rather than two is also one fewer thing to keep matching.
- The two tiles sit side by side and would look equally plausible showing each other's number, so there are now tests that each shows its own: the percentile on one, takings against expectation on the other.

### A recorded fight, replayed as a test — and a second bug it found

A real sixty-eight-second run confirms the attribution fix: the split is now 79.8% auto-attack, 11.0% penetrating strike, 9.3% puncture, against the 34%/23%/42% the same code produced before it. The recording is kept as a fixture and replayed on every test run, so this cannot quietly come back.

- **Monsters were being named from a field the payload does not carry.** It looked for `combatMonsterHrid` or `monsterHrid`; a real battle carries `name` and `hrid`. The fallback happened to work, but only by accident — `name` is checked first now, with the hrid behind it.
- **The replay script carried its monster map between battles.** The indices are reused every fight and mean different monsters each time — slot 0 is an Eye in one and an Eyes in the next — so a stale entry credits one monster's damage to the other. The tracker already rebuilt it; the script did not.
- **Seven assertions on the real run**, including the one that matters: an ability cast twice may not be credited with a third of a run. Reverting either half of the attribution fix fails four of them.

### Fixed: every hit was credited to whatever was cast first

The ability attached to a hit was read once, from `new_battle`, and never again. So the label was frozen at whatever the character happened to be preparing when the fight began, and the entire fight was credited to that one ability — which is why the per-ability split disagreed with DPs so badly.

Two things were wrong at once:

- **The field has two spellings.** `new_battle` writes `preparingAbilityHrid` and `isPreparingAutoAttack`; a `battle_updated` tick abbreviates them to `abilityHrid` and `isAutoAtk`. Only the long pair was being read, so a tick never had anything to say. Both are read now.
- **It has to be read after attributing, not before.** The hit that lands on a tick was cast by what was prepared _before_ it — by the time the payload arrives the character has already begun the next thing. Updating first would swap one wrong answer for another, crediting every hit to its successor. The tracker now attributes the tick and then records what is being prepared next, which is the order DPs uses.

### Recording combat, so attribution can be settled rather than argued

Attribution is inferred — mana falling identifies the caster, a counter rising identifies a hit — and every inference is somewhere to be wrong. Two panels disagreeing cannot be settled from two screenshots: both are summaries of a fight that is over.

- **A Record button in the DPs header** captures the raw feed and writes it to a file. It keeps `new_battle` whole, because that is one payload per fight and carries the names and health bars, and from each tick only `pMap` and `mMap` — everything attribution reads and none of the rest. No character name, no chat.
- **It stops itself.** Ticks arrive several times a second, so an unbounded recording is a tab that quietly grows until it falls over. It caps and says so in the file.
- **`npm run replay -- recording.json`** feeds a recording back through the attribution and prints what the panel would have made of it. That is what turns a disagreement into a comparison, and a fight into a fixture that fails when a change breaks it.

### The enemy rows belong to the player who fought them

They sat at the top of the table as a party-wide total, which is the wrong shape and the wrong arithmetic. They nest under the player now, as DPs nests them: collapse a player and their enemies go with them.

- **Per-player, per-enemy tracking.** One player kiting while another burns the boss is two different fights, and a party-wide enemy row averages them into neither. The attribution fold now splits a player's damage by what it was aimed at, and by ability within that.
- **Three levels, each closed by default** — the player, then the abilities and the enemies they fought, then what was used against each enemy. Every one of them remembers whether it was open across the panel's repaint.
- **The enemy-HP card stays party-level**, which is right: a health bar is emptied by the party, and kills are not attributable to one person the way a hit is.

### The enemy-HP card, laid out as DPs lays it out

- **The three figures are the headline**, side by side above the detail with the caption that tells them apart underneath each — total time, battle time, and the loss between them. As a column of labelled rows they read as three findings of equal weight; they are one finding read three ways.
- **The inputs are a strip, not four more rows.** Time logging, time in battle, health destroyed and enemies killed are what the figures were computed from, and stacking them under the figures made them look like findings themselves.
- **A tile per kind of monster, two to a row.** `7 kills × 2.40K HP = 16.77K` four times in a flat list is read one line at a time; as a grid it is read at a glance.
- **DPS carries its accuracy**, as DPs pairs them — the figure and how much of it landed — and every DPS reads to one decimal rather than rounded to nothing.
- **Enemy rows open too.** A monster taking a long time is either tanky or the wrong thing is being pointed at it, and only the per-ability breakdown behind that row can say which.

### The damage table reads at any width

- **Proportional columns instead of fixed pixels.** Fixed widths add up to more than a panel somebody has narrowed, and the column that pays for it is the first — so the name, the one cell you cannot infer from the others, became "Mi…". Proportions share the squeeze out, and each column has a floor it cannot collapse past.
- **The character row shows its damage bare**, as DPs does. A share of the party total says something on an ability row and on an enemy row; on the only player in a solo run it says 100% and costs the width that was making everything else truncate.
- **A panel remembered at a width from before it held a table is widened to fit one.** It was 440 wide as a stack of cards, which is a column of ellipses as a table, and nothing else would ever have widened it again.
- **Tabular figures**, so a column of numbers reads as a column rather than shifting every time one of them changes, and every cell carries its full text as a tooltip for when it does have to truncate.

### Per-enemy tracking, and DPs' second reading of the run

The tracker attributed hits to players and abilities and stopped there — it never recorded which monster took the hit, and nothing counted kills. Both now exist, which is what the last two pieces of DPs needed.

- **An enemy row per monster.** The player table answers "who is doing the damage"; this answers "to what". A run that reads as slow is often one zone's worth of a single tanky monster rather than a rotation problem, and no per-ability figure can say so. Keyed by the kind of monster rather than by the spawn, since a zone cycles through dozens of them.
- **A death is its own event, separate from the hit that caused it.** Merging them would lose every kill landed by a bleed — the health reaches zero on a tick where no counter moved — and that undercounts exactly the long fights worth measuring. It is also not a swing, so it adds no phantom hit to whoever happened to be casting.
- **DPS based off enemy HPs.** The same run measured a second way: not from attributed hits but from full health bars emptied. Attribution has holes — a bleed, a tick before the counters were known, two people casting together — and a corpse does not: the monster is dead, and its bar was worth what it was worth. Where the two figures disagree, the difference is what attribution could not see.
- **Quoted against battle time and against total time**, as DPs quotes it. The first says how hard the party hits, the second says what the run actually produced, and the gap between them is time spent walking rather than fighting — which no rotation fixes and a shorter respawn does.
- **A kill is priced at the largest health bar that monster has been seen with**, since a weakened spawn would understate what killing one is worth.

### The Damage panel is DPs' table

It was a stack of cards — a Party card, then a card per player with the abilities as lines underneath. That reads fine for one player and badly for a party, because nothing lines up: comparing two players' crit rates meant reading two cards and holding one in your head.

- **A table with DPs' own columns** — Character / Ability, DPS, Damage, Atks, Hit, Crit, Miss — so a party reads down a column instead of across a stack. Counts are written as DPs writes them, `193 (78.8%)`, because the bare count says nothing without the attempts behind it and the bare percentage hides how few swings it came from.
- **Abilities are behind the player row.** Every ability of every player at once is a wall; the row opens to show its own. An open row stays open when the panel repaints, which it does every couple of seconds — a row that shuts while you are reading it is worse than one that never opened.
- **The header carries the run and the two buttons**, where DPs has them: the DPS figure, the total damage it came from, the elapsed time, and **Filter Nondamage** and **Reset**.
- **The exchange stays**, below the table. A party doing well on paper is still losing if it takes more than it deals, and no per-ability column can say that.

Not yet matched: DPs' per-enemy rows and its "DPS based off enemy HPs" card. Both need damage tracked per monster and kills counted per monster type, which this script does not collect — the tracker attributes hits to players and abilities and stops there. That is a change to the tracker rather than to the panel.

### Fixed: the blue box around Queue and Start

The box was never a border. It was the pinned strip's own background, painted with one of the game's themed colour variables — the one whose name reads like a dark background is not one; that scale is a set of visible tints. So the strip painted itself blue, and the blue showing above and below the buttons was the box. Two earlier attempts went looking for a border and a scrollbar instead.

- **The strip is painted a dark literal**, so it reads as the panel continuing behind the buttons rather than as a coloured band around them.
- **The horizontal scrollbar is gone, at its source.** Three of this script's own blocks — the Cost Summary card, the budget row and the Missing Mats button — were built full-width with padding and a border and no `box-sizing`, so each rendered about thirty pixels wider than the column holding it. That is what pushed the Calculate button past the edge and put a scrollbar under the whole panel. They are sized correctly now, which fixes them everywhere they appear rather than only inside a clipped panel.
- **The overflow was the grid, not any of the blocks in it.** The panel's body is a two-column grid — a label like "Requires" beside a value — and everything this script adds goes into the value column. A grid item will not go narrower than its own longest unbreakable content unless told it may, so the column took whatever "Missing Mats Marketplace" and "Direct recipe cost 5.7M" asked for, the grid outgrew the panel, and the panel scrolled sideways. Every block inside measured exactly the column's width, which is why each one looked innocent under inspection: correctly sized, to a column that was itself too wide. The grid items may shrink now.
- **The scrollbar gutter is reserved.** Without it the vertical bar appears _after_ the layout has been worked out and takes its width out of the column, so every row that was exactly as wide as the column becomes wider than it — a horizontal scrollbar caused by the vertical one.
- **The width limit applies at any depth.** It was written for the panel's direct children, which walked straight past the Cost Summary card: that is inserted beside the item requirements rather than at the top level, and it is the widest thing in the panel.
- **The scrollbar is the game's own again.** Recolouring it was chasing the wrong thing: the bar was a width problem, not a styling one.
- **The divider is a plain hairline with no drop shadow**, so the row reads as the edge of the content sliding underneath.

### The action panel fits on the screen again

The game's panel was built for the game's contents — a name, the inputs, the outputs, two buttons. This script adds most of a second panel on top of that, and the modal grows to hold all of it. Past a certain recipe it grows taller than the window, and the first thing to fall off the bottom is **Start Now**, which is the one thing the panel exists to press.

- **The modal stops growing at the height of the window**, and the panel scrolls instead of the page. The title and the close button stay where they are rather than drifting off the top.
- **Queue and Start are pinned to the bottom.** They are the panel's verbs, and having to scroll to reach a verb is the failure everything else here is downstream of. A hairline and the panel's own background separate them from the content sliding underneath.
- **Overscroll is contained**, so reaching the bottom of the panel stops there instead of handing the scroll to the page behind the modal — which was most of what made the scrolling feel wrong.
- **A scrollbar you can actually grab**, and the added sections are tightened: eight pixels above and below seven collapsible sections is over a hundred pixels of nothing.
- All of it is CSS, scoped with `:has()` to modals that actually contain an action panel — the marketplace and the settings dialogs share the same class names and want none of it. Under Missing Materials & Crafting Plan, on by default; turning it off restores the panel exactly as it was.

### Sort the task board after reading new tasks

- **A new option: sort again once you press Read.** Reading is the one moment the board is guaranteed to come apart — new tasks arrive at the end however the rest was arranged. Auto-sort-on-open does not cover it, because the panel is already open, so a sorted board falls out of order every few hours and has to be sorted by hand again. Off by default, under Tasks.
- **It waits for the tasks to land rather than guessing how long they take.** A fixed delay is a guess about how long the game needs to draw several cards, and on a slower machine the guess fires first — which shows as a board that sorted everything except the tasks that were just read. It sorts what is there immediately, then again as the new cards settle.
- **The listener is delegated rather than bound to the button.** The card holding Read is drawn and thrown away by the game every time the unread count changes, so anything attached to one instance of it would work once and then silently stop.

### Crafts are priced with your tea, and open the marketplace on what they are short of

- **Artisan tea was not being counted.** The card priced a craft at the recipe's printed cost, so a Corsair Helmet read 100 Pirate Refinement Shards where the game's own panel said 88.9 — an eleven per cent overcharge on every craft the panel quoted, and worse the better your tea. It goes through the same artisan calculation the action panel uses, which resolves the loadout for that skill, so it is the tea you would actually be brewing under rather than whatever is in the slots while you are out fighting.
- **The saving is shown rather than silently applied.** The ingredient line carries one decimal once the tea has taken its cut — `26.7 × Shard` — because rounding it back to a whole number hides the very thing that changed, and a count that quietly disagrees with the game's panel reads as a bug. An **Artisan tea −11.1% materials** line names where the difference came from.
- **Missing Mats Marketplace, on the card.** The button the action panel carries, on the card that is saving towards the craft — which is where "what am I actually missing" gets asked. It calls the action feature's own handler rather than rebuilding the marketplace tabs, so the two cannot drift apart, and says so plainly if that feature is switched off.

### The revenue tile reads profit the way the panel does

- **The tile follows the case you picked.** It was hard-wired to bid revenue less every cost — one of four readings, and not the one somebody who has chosen Patient in the panel is thinking in. A tile that disagrees with the panel behind it is a tile nobody trusts, so the panel now says which reading is on screen and the tile draws that one. Its tooltip names the case.
- **The MooPass shows on the tile when it is being counted**, between revenue and consumables and in its own colour, because it is a standing bill rather than a cost of this run: `68.6M - 2.0M - 12.6M = 54.0M/day`. With Costs Off or Tax Off those terms disappear from the sum rather than showing as zero.
- **The three settings survive a reload.** They were held for the session only. That was tolerable while they affected one panel; now that the tile follows them, a tile that silently reverts to a different reading of profit on every page load would be worse than one that never followed at all.

### The MooPass is a cost you can count, and the fourth corner of the book

- **Tax On subtracts the MooPass from every case.** A profit figure that ignores a standing weekly bill is a profit figure that has not paid the rent, so it is now a header toggle beside Costs On, and every box and the summary line carry it when it is on. Off by default, and remembered.
- **It charges for the bags you still need, not twenty-five.** Cowbells accumulate — dailies, drops, bags bought and not yet spent — and the panel was quoting the full 25-bag price regardless, which overstated the tax by whatever you were already holding and made runs look like they were not covering something they covered comfortably. Loose cowbells and bagged ones count the same at ten to one, and the card says "13 of 25 bags" so the credit is visible rather than assumed.
- **Ask - Ask is back in the set.** There are four ways round the order book and only three of them have names: Lazy is Bid - Ask, Mid is Bid - Bid, Patient is Ask - Bid, and the fourth corner — everything at the asking price — had no box. Each named case now says which corner it is, so the set reads as a set rather than as three unrelated opinions.

### Enhancement costs follow your enhancing loadout, and Combat Profit shows its working

- **It was reading whatever is on your character right now.** A cape costed while you are in combat kit is costed off a battleaxe — no enhancer, no philosopher's anything — which quotes a run nobody would make. It goes through the loadout resolver now, so it uses the gear you would auto-equip to enhance: skill-specific default first, then the all-skills default, then any saved enhancing loadout, then what is worn. Same order the profit calculators already use.
- **The loadout resolver was answering "no loadout" in most bundles.** Each bundle that imports it gets its own copy of the snapshot store, and only the Combat one ever has `initialize` called — so the others never read storage and every caller quietly fell back to currently-equipped gear. It reaches for the shared instance first now, which fixes this everywhere it is used, not only in enhancing.
- **Combat Profit is laid out like HWhat.** Each case is a box with the figure large, the rule under it, and the arithmetic beneath that — `67.6M - 12.0M = 55.6M`. The conclusion alone cannot say whether a bad number is a revenue problem or a cost problem; the sum can.
- **A header line and two buttons, also HWhat's.** The sum across the top reads revenue, cost and what is left in the case you have chosen. **Costs On** drops the cost side entirely rather than zeroing it, and the mode button cycles Lazy → Mid → Patient for which case the header reads. Both are remembered.

### The enhancement cost is your bench, and one luck panel instead of two

- **It was costing the run at somebody else's bench.** The parameters came from `getEnhancingParams`, which hands back the enhancement simulator's _manual_ settings unless auto-detect happens to be switched on — and those default to a fully kitted enhancer: celestial tool at +13, every accessory at +10. So the quote was what a fully geared player would pay, which is not a number you can save towards. It reads the character's own gear, skill, house and teas now.
- **"expected cost at the anvil" is "Enhancement Cost"**, in the card and in the picker preview.
- **The Drop Luck panel is gone, and both luck tiles open Party Luck.** Splitting one question across two panels — a percentile in one, the item table that explains it in the other — meant the answer was always in the half you had not opened. The verdict, the percentile and the coins it is about are a card at the top of Party Luck, so nothing is lost and the drop that caused it is directly underneath.

### Fixed: the cape costing never fired, a layout came back rearranged, and the game drew over the panel

- **The anvil path was gated on the wrong question.** It asked whether the item was untradable, and a cape is not — capes are perfectly tradable, they are simply never listed above +0. So the check never passed and a +7 cape read "nobody is selling this one" exactly as before. It now asks the question that actually matters: is anybody selling **this level**. If not, and you own one, the cost is the run from the level you already hold.
- **The picker was pricing the choice separately from the panel.** It read the ask directly rather than going through the same costing the watched cards use, so a cape previewed as unbuyable and then watched perfectly well — a preview contradicting the thing it was previewing.
- **A cape is priced through the shop that sells it.** Capes drop or are bought with tokens and never appear on the market, so a market-only reading says one cannot be had at any price — which made "buy a base and enhance it" impossible for the pieces that path exists for. A token is worth the best line its own shop converts to, the same rule the scrolls already use.
- **Enhancing the piece you are wearing no longer trades it in.** It is the same cape; subtracting what it would fetch has you sell the thing you are about to enhance.
- **An exported layout re-imported on the same character came back rearranged.** Import grew every tile to fit and then repacked the columns — right for an OPanel file, whose sizes measure OPanel's rendering, and wrong for one of ours, which already holds this overlay's own coordinates. Correcting what needed no correcting moved tiles that were exactly where they had been put. Our own files are now applied as written, frame included; OPanel's still get refitted.
- **The panel rises while it is being arranged.** It sits below the game's interface on purpose — it is always up, and a permanent readout covering the tabs is worse than one occasionally covered. But that is a readout's rule, not a workbench's, and the ability cooldowns counting down through the tile you are dragging made the settings unusable. It now lifts above while the settings are open or the layout is unlocked, and drops back when you are done.

### Capes are priced at the anvil, crafts go through the planner, and a layout survives the trip between characters

- **A cape has no ask, so it was unpriced forever.** Capes, quivers and the rest of the untradable gear cannot be bought at any enhancement level, so "save up for a +7 cape" is not a purchase — it is a run at the anvil, and reading it at a market price that does not exist reported nothing at all. Untradable targets are now costed through Toolasha's own enhancing calculator: expected attempts × materials, plus the protections the run expects to burn, counted from the level you are already wearing rather than from +0. The card says **Untradable** and names the run — `Enhance +5 → +7` — so nobody reads it as a price tag.
- **It prices the run a player would actually make.** Failing all the way back to +0 every time is what going unprotected means, and past about +5 it is ruinous — so costing it that way would quote a number nobody would ever pay. It searches the protect-from choices and quotes the cheapest, which is the same search the enhancement display makes, using the Mirror of Protection or whatever cheaper protection the piece names. With no protection on the market it quotes the unprotected run, because a protected run at a protection nobody sells is a run that cannot be made.
- **Crafting costs go through the crafting planner now**, rather than the flat market ask of each ingredient. The planner already knows when an ingredient is cheaper to make than to buy, and pricing a craft at retail throws that away — which for a deep recipe is most of the reason to craft it. It falls back to the flat pricing if the planner cannot answer.
- **An exported layout no longer arrives jumbled on another character.** The export was written in MCS's OPanel format, which names twenty rows; Toolasha has half as many again. Everything without an OPanel name — every row this fork added — came back with no position and no size and piled up in the corner. The file now carries a `toolasha` section alongside the OPanel one, holding the layout in full: order, visibility, positions, sizes, zoom, and the panel's own settings. Toolasha reads that section when it is there and falls back to the OPanel half when it is not, so files exported before this still import, and MCS still reads the file because it ignores keys it does not know.

### EWatch: craft it yourself, sell per piece, and a bar on the tile

- **"I will craft it."** A Furious Spear you already hold becomes a Refined one for the price of the shards, not the nine hundred million the finished one asks — a completely different decision, and the panel could not express it. Any target the game has a recipe for gains a **Buying / Crafting** switch. Crafting prices the **materials**, itemised, because the reason to craft is usually that one ingredient is the expensive one and a total hides which. The piece being upgraded is counted in only when you do not already own it, and the panel says which of those it assumed.
- **One unpriced ingredient makes the whole craft unpriced.** A recipe totalled from the ingredients it could price reports a cheaper craft than is possible, which is worse than saying nothing.
- **Selling is per piece now.** The sword being replaced gets sold; the second ring replaces nothing you would part with. Each target cycles between following the panel switch, always selling, and always keeping — starting on "follows", since one differing is the exception.
- **The list is ordered by how far along it is** — affordable first, then nearest to done, then unpriced. Insertion order said nothing, and ordering by cost buries the piece you are two days from behind one you are two months from.
- **The tile grows a progress bar and a percentage**, which is what a savings tile is for: a figure says where you are, a bar says it at a glance.

### Fixed: EWatch never had income data, and its tile omitted the enhancement

- **"No income data", always.** Two bugs stacked. The duration was read from `startTime`/`endTime`, which the collector does not publish — it publishes `durationSeconds` — so the sum was `Date.now() − Date.now()` and every run was zero seconds long. And `dailyProfit` is `{ask, bid}`, two figures rather than one, so comparing it as a number was NaN and would have failed even with a correct duration. Both fixed; the bar now reads **Lazy** or **Mid** for which side of the book it is using, as HWhat's does, and No Sell switches it to the ask side since that is the assumption No Sell already makes.
- **The tile names the enhancement**, because a Plate Body and a Plate Body +10 are different purchases at very different prices, and naming only the first names the wrong one.
- **A pinned target you can already afford says "Affordable"** rather than `0` and `0s`, which read as broken rather than as done.
- **MCS's own eye glyphs.** The open one is the emoji it uses; the closed one is drawn as a path, because there is no crossed-out-eye emoji that renders the same everywhere — the nearest candidates are sunglasses and a monkey covering its face, and the sunglasses is what was showing.

### Fixed: EWatch counted coins it could not spend, and hid the slots by default

- **The coin figure was reading every coin row the game holds, not the one in your inventory.** `getInventory` returns every character item — equipped pieces, listings, all of it — and coins appear under more than one, so an unfiltered lookup reported fifty-one trillion where the character had two hundred and sixty-eight million. Everything was affordable, every bar sat at 100%. It filters to `/item_locations/inventory` now, which is what every other reader of that list already did.
- **The slot list is what the panel opens on again.** Locking it away by default hid the only way to add a target, which is most of what the panel is for. Locked is still there as the compact reading view; it is just no longer the resting state.

### EWatch gains Lock, Refresh, and the picker where it belongs

- **Lock and Edit are the panel's two shapes.** Locked is a reading list — what you are saving for, how far along, and the Everything row — which is what the panel is for almost all of the time. Edit opens every slot so targets can be changed. Locked is the resting state because the editing view is several times longer and only wanted while changing something.
- **The picker opens under the slot that asked for it**, not at the top of the panel. The question is "what is going in this slot", and a picker somewhere else makes you carry the slot in your head. Clicking the same slot again closes it. It offers only pieces that fill that slot, so reaching a helmet never means scrolling past every charm in the game.
- **A list box rather than a dropdown**, as EWatch uses. A dropdown over three hundred items is a scroll whose shape you cannot see — and it was the thing closing under the pointer on every redraw.
- **Enhancement buttons are tinted where the market has one.** Most levels of most items have never been listed, and knowing which exist is half of choosing a target. Picking one previews the whole thing before it is committed to: lowest ask, the difference after the trade-in, and how long that takes.
- **Refresh, with the age of the prices beside it.** Every figure in the panel is only as current as the prices behind it, and a saving that has not moved in a day is usually a price that has not moved rather than a run of bad luck. It says "Refreshing…" while the fetch is in flight, because a button that does nothing visible for a second is a button people press four times.
- **The eye pins the tile.** Not just the panel header — the overlay tile's own answer is "the nearest one", and the thing somebody is actually saving for is often not the cheapest. The eye is how you say so; pressing it again gives the tile its own judgement back.

### Fixed: an unpriced drop is a row, and a dropdown stops closing under you

- **Anything a chest drops now gets a row**, priced or not. Valuing the scrolls through the labyrinth shop was the wrong half of the fix — the rule underneath it was that an item with no price contributes to neither side of a chest's verdict _and gets no row_, so anything the script cannot value simply vanished and read as a chest that never contained it. Unpriced rows show the count with a dash and `no price`, sort last so they cannot lead the verdict, and still count towards nothing. A zero would have been a different and wrong claim: that the chest gave you something worthless.
- **A panel no longer rebuilds a control you are using.** The refresh redraws the whole body every few seconds, and redrawing a `<select>` closes its dropdown — scroll a long equipment list for more than a moment and it shut under the pointer, which reads as the panel refusing to be used. Any panel with a focused input, select or textarea now skips its timed redraw.

### EWatch is laid out by slot

- **A section per equipment slot**, as EWatch has: the slot, what is in it, and what selling that would fetch — then either what is being saved for or **Click to watch**. A slot with nothing on it is still worth a line; a list of only your targets cannot say "this slot is empty and here is what it would cost to fill".
- **Clicking an empty slot opens the picker on that slot alone**, because scrolling past every charm in the game to reach a helmet is exactly what the invitation is there to avoid. It widens back to everything with one click.
- Watched targets gain EWatch's **Ask Price** and **Difference** lines and an **ETA**, and take its colouring — blue for the one the header carries, gold for the rest.

### Treasure was dropping the scrolls, and EWatch gains its item picker

- **Scrolls were missing from the chest contents.** They are bought from the labyrinth shop and used, never sold, so a market-only reading prices them at nothing — and an item worth nothing contributes to neither side of a chest's verdict and gets no row at all. The valuation already existed for the tooltip; the treasure tracker was looking only in `shopItemDetailMap`, and the labyrinth keeps its own shop under `labyrinthShopItemDetailMap`. A scroll is worth the tokens it costs, and a token is worth the best thing its shop converts to.
- **An unsellable shop line cannot set the token price.** Otherwise a token prices at nothing and every reward follows it down — which is the same "unpriced is not free" rule the ability books and the charms already run on.
- **EWatch has its Edit picker.** The item menu can only offer what you are holding, which is exactly the wrong set: the thing you are saving for is by definition something you do not have. Edit opens a list of every piece of equipment in the game, grouped by the slot it fills, with a button per enhancement level — greyed where nobody is selling — and a live reading of what the swap would cost before you commit to it.
- **The Enhancement Run tile is gone**, along with the row it drew. It was the readout that used to sit under the Equipment Watch name.

### The Party Luck panel — LYuck's item table

Behind the Drop Luck tile. The tile carries one figure and the panel behind it carried the run in coins; neither answers the question a long session actually raises, which is **which drop is the reason**. A run reads as unlucky because one rare did not come, and no total can say that.

- **Session Statistics** — battles, party size, zone and difficulty tier. Every figure below is built from these, so they are visible rather than assumed.
- **Revenue** — expected against actual per player and for the party, with each player's own drop-rate, rare-find and quantity bonuses in the tooltip, since those are why two people in the same fight are owed different amounts.
- **A table per player** — item, quantity, value, what was owed, and how far off it landed, biggest haul first. A drop that was owed and never came is still a row: those are the interesting ones.
- MCS draws these as separate draggable panes; they are sections of one panel here, because six panes that each need positioning is six panes that end up on top of each other.

**A bug the panel test caught:** the loot map is keyed by the game's own slot key, not by item hrid, so matching it against the expectation on the raw key produced **two rows for every item that dropped** — one with the haul and one stuck at −100%. Resolved through each entry now.

### Luck and Over Expected are a line per player

LYuck's answer to a question a single figure cannot answer. A party shares a zone and a battle count and **nothing else** — drop rate, rare find and drop quantity are each somebody's own gear, so five people fighting the same monsters are owed five different amounts, and one number for the party is an average over people who are not comparable.

- **A line per player, then the total**, in both tiles. The total is the party's takings against the party's expectation, not an average of the percentages: an average weights somebody who looted one item the same as somebody who looted a hundred.
- **One model per player.** MCS computes a base expectation and multiplies each player's share by their own bonuses; this builds the whole session per player with their own bonuses instead. Same arithmetic — the bonuses enter as multipliers either way — but it cannot drift from the single-player model, because it _is_ the single-player model. A version that split one expectation evenly would report the player with the drop-rate build as permanently lucky, which is the exact failure the model already carries a warning about.
- **Solo is unchanged.** One player means one line, as before.
- Worth knowing what the figure means: a player with no drop gear is owed less, so par for them is a smaller haul. "Am I unlucky" is a different question from "am I contributing", and this answers the first.
- `expectedItemCounts` is new alongside `sessionMean` — the same walk over the same priced drops, one summing coins and one summing counts, with a test that they agree when the counts are priced back up.

### The combat simulator is its own bundle, and the combat bundle stops scraping its ceiling

The engine under `features/combat-sim/` is a megabyte of source and the largest thing in the script by a wide margin. Four features across three bundles reach into it — the labyrinth clear-rate model, task profit, the build score, and the simulator's own interface — and because it was never declared shared, **it was copied into each of them**. Both the combat and the UI bundle carried their own `class Monster` while sitting a few kilobytes under the 2 MB ceiling.

It is now `toolasha-sim.js`, loaded once and referenced.

| Bundle | Before    | After         |
| ------ | --------- | ------------- |
| combat | 2,090,702 | **1,068,270** |
| ui     | 2,064,758 | **1,795,494** |
| sim    | —         | 1,394,937     |

- Combat has a megabyte of headroom instead of six kilobytes, which is what the per-player luck work needs.
- The new bundle loads after utils and before market, because market declares the engine external too. CI's size gate globs `dist/libraries/*.js`, so it covers the new one without being told.
- One subtlety worth recording: a **default** import of an external compiles to the global value itself, so `Toolasha.Sim.monster` has to _be_ the class. Wrapping it in a namespace would have handed a `{default}` object to every `new Monster(...)` in the script — and only at runtime.

### Equipment Savings — the gear you are saving for, and when you will have it

MCS's EWatch, ported. Wanting a piece of equipment is a savings problem and the game helps with none of it: the price is on one screen, your coins on another, and what you earn per day nowhere. So the question people actually ask — "can I afford it yet, and if not, when" — gets answered by opening the market and subtracting in your head, several times a day, for weeks.

It takes over the **Equipment Watch** tile, which is what that tile was named for. The enhancement-run readout that was sitting there keeps working under its own name, **Enhancement Run** — it is a different thing that had borrowed the name.

- **What an upgrade costs is not what it is priced at.** You sell the piece it replaces, so the cost is the target's ask **less the bid on what you are wearing** — for a late-game slot that is most of the price, and reading the ask alone can double the figure. Finding the piece it replaces means turning the target's **equipment type** into an **item location**, two different strings that look interchangeable; getting it wrong throws nothing and silently charges full price for everything.
- **Keep old gear** turns the trade-in off, for a piece you are keeping for a second loadout.
- **A progress bar per target**, with what is still to find and how long that takes at your measured daily profit. **Everything** does the same for the whole list, because one slot at a time answers the wrong question when you want three pieces.
- **No income measured means no arrival time**, not "never" — a figure there would be a claim about the future. Likewise an unpriced target is unknown rather than free: costing it at nothing would report it as already bought, which is the most misleading thing this could say.
- Targets are added with a **Save for** button on the game's item menu, off by default like the Watchlist's, since it changes a menu you use for other things. Equipment only — saving up for a cheese is not a plan.
- Coins are read off the character rather than out of net worth, which is recalculated on a schedule: a savings bar has to move when you spend, not when a worker next runs.

Rebuilt against EWatch's own pane rather than from its idea:

- **The eye.** With several things on the list, one of them is the one you are actually saving for; clicking its eye puts it at the top of the panel with its own bar, as EWatch's header does.
- **The purse bar** carries coins, what is tied up in market orders, and income per day — the three numbers that decide everything below.
- **Market Value** decides whether coins in market orders count as money you have. Sell orders at what they will pay after tax, buy orders at what was already handed over, plus anything unclaimed.
- **No Sell**, under its own name, for the trade-in switch.
- **The percentage runs to five decimals**, which looks absurd until the target is a two-billion-coin spear — at which point the bar and a rounded figure both sit still for an entire evening and the fifth decimal is the only thing saying you are getting anywhere.

### Fixed: the Drop Luck panel said `[object Object]`

- `describeLuck` returns `{text, tone}` and the whole object was handed to the line, so the verdict rendered as `[object Object]` where the words should be. It reads the text now, and takes the colour from the tone — lucky green, unlucky red — which is what the tone was there for.

### The DPS tile is a line per player, then the total

- DPs' shape: **name, damage per second, hit rate** for each player, and a **Total DPS** line under them. A party figure says the group is doing damage and not who is doing it, and "who" is the whole question when somebody is under-geared for the zone.
- **The total is the sum of the lines**, taken from attribution rather than from this module's own health-diff figure. The two measure different things — health lost includes bleeds nobody cast — and a total that did not add up to the lines above it would read as an arithmetic bug.
- **It falls back to the party figure** when the Damage Tracker is off, still labelled `Party DPS ×N` so it cannot be read as yours, and the tooltip says which switch turns the per-player lines on.
- No swings seen reads `--` rather than `0.0%`: an unmeasured hit rate is not a missed swing.

### Charm panel folds are remembered between sessions

- They survived a refresh but not a reload. Stored now, through the same deferred read the Watchlist uses, since IndexedDB opens after the libraries evaluate and a read at module scope reliably returns the default.

### Fixed: the Charms panel kept unfolding sections you folded away

- Each section's fold lived in the DOM, and the panel rebuilds its whole body every few seconds — so every refresh put all three sections back to the shape they open in. Collapse the upgrades, watch them reappear three seconds later, over and over. The folds are held outside the draw now, so a redraw finds what you chose rather than the default.
- Remembered under a stable key rather than under the heading, because the headings carry the equipped bonus and change when you swap charms.

### Fixed: the charm slot was read with the wrong kind of key, and the panel is QCharm's

- **It asked the equipment map for `/equipment_types/charm`.** The map is keyed by **item locations** — `/item_locations/charm` — so every lookup returned undefined, the panel reported an empty charm slot with a Grandmaster Melee Charm sitting in it, and "over what you are wearing" was computed against nothing. Nothing threw; the wrong key is simply a miss. A panel test now states the key the game actually uses, because no arithmetic test can catch this.
- **Scoped to the charm you are wearing**, as QCharm is. It was ranking every charm in the game together and opening on Basic Brewing, Basic Tailoring and Basic Cooking — a melee charm and a brewing charm are not alternatives to each other, so that list was things you do not want with the one you do want somewhere in it. Now it is the same focus at every tier.
- **A row per enhancement level the market is selling**, not one per charm. A Master +3 and a Master +5 are different purchases at different prices, and which of them is worth it is the whole question.
- **Charm Upgrades and Charm Downgrades**, each headed with what you are wearing. Downgrades are not there to be bought — seeing that a charm two tiers down is a fraction of the price is how you decide the top tier is not worth it. Equal counts as an upgrade, because the same bonus for less money is the trade people are looking for.
- **Exp/M**, the bonus per million coins, sortable along with every other column. Per coin the ratio is 0.000000052, which no column can show; per million it is 0.05 against 0.03, the same ordering in a form you can read.
- **The Charm EXP Guide**, folded away by default: the six tier percentages and the twenty enhancement multipliers. Every figure in the panel comes out of those two tables and neither is visible anywhere in the game.
- Enhancement scaling is now stated as the charm slot's rather than looked up per item. A lookup that misses does not fail — it returns the 1× default and reports a +20 charm as scaling like a sword.
- **The trainee tier is priced at the vendor's 250,000**, as QCharm prices it. Nobody lists trainee charms — there is no profit in reselling something the shop stocks at a fixed price — so a market-only reading shows the bottom tier as unpriced, and it is not unpriced. It is the floor every other tier's value per coin is judged against. Only unenhanced: a trainee at +5 is somebody's enhancement work and is priced by the market like anything else. Every other tier with no listings stays genuinely unpriced, since calling one free would put it top of the ranking.

### Clicking a book fills the buy dialog in

- **The count is already typed in when the marketplace's Buy Listing dialog opens.** The number of books is the point of the panel, and retyping it into the dialog is where it gets rounded to something convenient — 2,800 rather than 2,809 is one book short of a level, found out a fortnight later.
- It follows the **target the row is aimed at**, not the next level, so setting a row to 150 and clicking its book buys the books for 150.
- **One-shot rather than standing.** The dialog does not say which item it is for, so a quantity left armed would be filled into the next thing you buy. An ability that needs no books arms nothing rather than leaving the last count sitting there.
- The observer that fills it in registers on the first click and stays. The dialog is reached by navigating to the marketplace and then clicking + New Buy Listing, which can be a while later and with the panel shut in between — an observer that lived only as long as the panel would miss exactly that.

### The Ability Books panel loses its labels, and tiles stop sitting an icon low

- **The heading row and the ability-name column are gone.** They were what made the panel look cramped beside BRead: the labels were the widest thing in three columns — a third of the width spent writing "Books" above a column of book counts — and the name was ellipsed to `Pen…` at any width that left room for the figures. The book's icon is the name, as it is in BRead, with the ability named in its tooltip. Every cell keeps a tooltip, so nothing that was labelled is now unexplained.
- **The figures are the size of figures.** Level and books at 17px, the icon at 28, and rows breathing at 7px rather than 2. Books get their own orange: side by side with the cost in gold, two figures in one colour read as one figure.
- **An icon on an overlay tile no longer sits low.** Text on a line is aligned on its baseline, which is what makes a row of figures read as a row — but an icon is a box with no baseline, so it sat below the numbers and dragged the line's height about. A line carrying an icon is centred instead, aligning the box and the numbers on the only thing they share.

### The Ability Books panel is BRead's panel now

- **BRead's columns, which are not the ones it had**: level, book, **experience still owed with the rate it is coming in at**, **time to get there**, books, cost, and a target level **per ability**. The old table had books and cost against a single shared target, which cannot answer the question anybody has — an ability at 41 and one at 70 are different purchases, and "how long" was not on the table at all.
- **The rate is measured over the last ten minutes**, not from when you opened the panel, so it is sampled whether the panel is open or shut. A rate that only starts measuring when you look at it says nothing for ten minutes, every time you look.
- **An ability nobody is training reads `—`, not `never`.** No rate is unmeasurable; infinity would be a claim about the future.
- The header carries the same phrase the tile does — icon, books, cost — so the panel opens showing the figure you opened it for. **Reset** puts every ability back to its next level.
- The shared "take everything to level" bar stays and now clears the per-ability targets when used, or "everything" would quietly mean "everything else". Its total counts each ability where **it** is aimed, which needs `aimedTotals` rather than a single column — `costToTarget` is null on the rows with no target and `costToNext` ignores the ones that have one.
- **Not ported: MCS's range calculator.** It answers "books from level 1 to 100" at a hardcoded 50 and 500 experience per book. The target column does the same job against each book's real experience, so the two would disagree and the hardcoded one would be the wrong one.

### The Skill Books tile is centred, and the Combat Log says why it is empty

- The tile's icon, count and price are one phrase and now read as one, centred, rather than the price being pushed to the far edge of a resized tile with a gap in the middle.
- **The Combat Log tile was blank because the feature behind it is off by default.** Blank reads as broken, so it now names the switch it wants — Settings › Combat › Scrolling Combat Text — and says "waiting for a fight" once it is on and nothing has happened yet.
- It opens a panel too, with the last eighty events rather than the six a tile holds. Six is fine for a glance and no use for "what actually killed me".

### QCharm and MAna open, and the Skill Books tile is BRead's

- **Charms and Mana were tiles with nothing behind them.** Both now open on double-click. **Charms** lists the whole field ranked by experience per coin — icon, name, bonus, price — with each one's **gain over the charm you are wearing**, which is the number to pay against; the charm's own bonus is what you already have plus what you would gain, and paying for the whole of it is how people overpay. **Mana** breaks the run down by ability with each one's share, because the tile's per-fight figure does not say which ability moves when the rotation changes, and carries a Reset.
- **The Skill Books tile is BRead's tile now**: the cheapest ability's **own book icon**, how many books that level takes, and what they come to. It was carrying four figures — inventory count, inventory worth, ability name, cost — and the name was ellipsed to `Pen…` to fit. The icon names the ability in the width a truncation was costing, and the books you already hold moved to the tooltip: a pile of unread books is a figure, the cheapest next level is a purchase.
- `utils/simple-panel.js` is the shell all of these share, now declared shared in the build — it was about to be copied into both the combat and market bundles. 8 tests, including that a `draw` which throws says so rather than leaving an empty panel.

### Fixed: Combat Profit was a column of zeroes

- It read the **raw player** out of the collector. `dailyIncome`, `dailyProfit` and the cost figures are produced by `calculatePlayerStats`, which the panel never called — so every branch defaulted to nought and the panel reported a confident zero for all three scenarios. It goes through the calculator now, the same one the Combat Revenue tile uses, so the two cannot disagree.

### Fixed: the Watchlist and the target selection forgot everything on load

- Both read their saved state at module scope, which races the database: IndexedDB is opened **after** the libraries are evaluated, so the read reliably returned the default and reliably logged `Database not available`. The feature then ran on defaults for the whole session and looked like it had simply forgotten.
- `utils/deferred-load.js` keeps asking until the database answers, front-loaded so the usual case costs nothing, and gives up after a few seconds rather than polling for the rest of the session. Loading later was not an option — the overlay reads that state on its first paint.

**Damage attribution is confirmed working against the live game.** The per-ability breakdown, accuracy and crit rate are all real, so `cMP`, `dmgCounter`, `critCounter` and `preparingAbilityHrid` are current in the payload.

### Damage attribution — DPs properly, and the combat text with it

The gap behind three half-ports closed at once. The game attributes nothing, and MCS's trick is that **it does not need it to**: only the casting player's mana falls on a cast, so whoever's `cMP` went down this tick is who acted. That one join is what DPs, the floating text and a party mana tally were all missing.

- **`utils/damage-attribution.js`**, 23 tests. The caster from the mana drop; a hit from `dmgCounter` **rising** rather than health falling, so a bleed is not credited to whatever was mid-cast; a crit from `critCounter`; and the case a health diff can never express — a counter rising with health unchanged is a **miss**, not a non-event. Solo skips the mana check entirely, or an auto-attacking character would never register a hit at all.
- **The Damage panel is DPs now**: per player, per ability, with damage, share, DPS, **accuracy** and **crit rate**, and the **Filter non-damaging** toggle. Accuracy with no swings is `—` rather than 0%, which is not the same claim.
- **Floating text gained what it was missing**: a colour per **attacker** so a party's numbers are separable, **misses** drawn as `miss` where the game's own bar cannot show them at all, and crits drawn larger — the thing you want to notice without reading.
- **`combat-dps.js` is untouched and still feeds the tile.** The two measure different things and would disagree: it counts every point of health a side lost including bleeds nobody cast, this counts only attributable hits. The tile's total is the honest "output"; the panel is honest for "who and what". Merging them would force one to be wrong.

`damage-attribution.js` is declared shared — it was being copied into both bundles, which took combat to 7 KB under its ceiling.

**Unverified against the live game.** The field names come from MCS v0.9.36235 (`cMP`, `dmgCounter`, `critCounter`, `preparingAbilityHrid`, `isPreparingAutoAttack`) and have not been seen on a real payload.

### Rebuilt the combat panels against the actual source

The four panels shipped a moment ago were my own design wearing MCS's names — I did not open the vendored script for any of them. Read properly, three were wrong in shape.

- **Deaths is a party breakdown**, as IHurt is (line 11614): session deaths and deaths/hr **per player**, plus the party totals and the session clock. A party figure says the group is dying and not who, and "who" is the whole question when one member is under-geared for the zone. My previous version was solo-only and invented _one death every X_ and _encounters per death_, neither of which IHurt has. It also no longer implies it knows what killed anybody — the third-party notes said "broken down by what killed you" and the code does no such thing.
- **Profit names the three cases HWhat names** (line 29211), which are not "at ask" and "at bid": each mixes a revenue side with a cost side, because you sell and buy on opposite sides of the book. **Lazy** is `Revenue (Bid) − Cost (Ask)`, **Mid** is `Revenue (Bid) − Cost (Bid)`, **Patient** is `Revenue (Ask) − Cost (Bid)`, and the Difference block prices what patience is worth. It also gains HWhat's **tax section** — 25 Bags of 10 Cowbells a week, costed from the market — and says whether the run covers it, because a profit that does not clear the weekly tax is a slower way of running down.
- **Damage is unchanged and still does not match.** DPs attributes damage per player per ability from `dmgCounter`, `critCounter` and the casting player, and has a Filter Nondamage toggle. Toolasha's collector only diffs total health per side, so matching it needs the **collector** extended, not the panel redrawn. Left as it is rather than faked.

### Panels behind DPs, IHurt, LYuck and HWhat

Four tiles that were one number each now open on double-click. Each panel reads the collector its tile already reads and computes nothing of its own — if a panel and its tile ever disagree, the disagreement is in the collector.

- **Damage.** Dealt and taken, each per second and in total, and the **exchange ratio** between them — which is the thing a DPS figure alone cannot tell you: whether you are winning the fight or merely surviving it. Party size and your own share, marked as the estimate it is, since the game does not attribute hits.
- **Deaths.** Deaths, per hour, run length and encounters — plus **one death every `X`** and encounters per death, because a rate of 0.7/hr is not a thing anybody pictures. No deaths is rated as nothing rather than as infinity. The game does not say what killed you, and the panel says so instead of implying it knows.
- **Drop Luck.** The percentile, and then **how many coins the verdict is about** — income against expected, and the difference. A percentile alone cannot distinguish a fortune from a rounding error. It says when drop-rate bonuses were folded into the expectation, since that changes what the number means.
- **Combat Profit.** Both pricing sides, because which is honest depends on whether you sell into the bids or wait at the asks, and the gap between them is frequently the whole profit. Costs split into consumables and keys rather than presented as one figure to subtract.

All four panels share one shell — header, drag, resize, remembered position — so a panel cannot open somewhere unreachable in one place and not another. 13 tests build them, including with nothing loaded, which is the state every one of them is in for the first minute of a session.

`combat-dps.js` and `combat-drop-luck.js` are now declared shared: they are stateful singletons fed by the websocket, so a second copy in the UI bundle would have sat there receiving nothing and reporting zeroes.

### Floating and Scrolling Combat Text

- **Damage numbers over the units taking them**, and a **Combat Log** overlay row of the same events. A health bar tells you the state and not the event — "did that hit for 400 or 4,000" is a question a number answers and a bar does not.
- **Both off by default**, and each can be turned on alone. With both off nothing subscribes to the websocket at all, so the feature costs nothing when unused.
- **The game sends no events.** It sends every unit's health every tick, and a hit is the difference between two of those. `utils/combat-events.js` derives it, with the three ways to get it wrong pinned by tests: health going **up** is a heal rather than negative damage, or a healer cancels the party's output; a unit seen for the **first** time has not been hit for its entire health bar; and a unit that has **gone** did not take its remaining health as damage, because it died or the wave ended and the state cannot tell those apart.
- The floating text draws the largest event per unit per tick. A tick carries a dozen events and ticks come several a second, and a number per event is a great deal of DOM for something nobody can read.

### MAna and QCharm

- **Mana/fight.** Mana is the constraint nobody watches — damage is in the combat log, mana shows up only as the moment an ability does not fire, by which point the fight has gone differently. The row reports mana and casts **per fight** rather than the running total, because a total only says how long you have been playing.
- The game announces a cast but not what it cost, so a cast is a message and its mana is a lookup in `abilityDetailMap`. An ability the game has never described contributes casts and no mana, and the row carries a ⚠ saying the total is a lower bound rather than letting a short figure read as a measurement.
- **Charm Value.** A charm's bonus scales with tier and enhancement; its price scales with neither in any orderly way. So the best charm to buy is neither the highest tier nor the cheapest — it is the most bonus per coin, which is a division across six tiers and twenty enhancement levels. Ranking by bonus alone recommends the grandmaster every time, which is true and useless.
- The tooltip says what the **upgrade** buys rather than what the charm is worth: swapping a 5% charm for a 6.5% one buys 1.5%, and paying for it as though it bought 6.5% is how people overpay.
- An unpriced charm is unknown rather than free, and sorts last — the same rule the ability books needed, for the same reason.

`utils/mana-spend.js` (8 tests) and `utils/charm-value.js` (14 tests) hold the arithmetic. Charms are found by looking for the charm slot in the item map and reading the tier out of the hrid, so one added by a game update is priced rather than missed.

### Fixed: the Ability Book panel listed nothing at all

- It read the character out of `getInitClientData()`, which returns **static game data** — an `abilityDetailMap` describing every ability in the game and nothing about yours. So the list was always empty, and "No abilities learned yet" was the panel faithfully reporting a lookup that could never succeed.
- **It now shows the equipped kit**, which is the right question anyway: what to buy next for the build you are running, not for every ability you have ever touched. That needs **two** sources — `combatUnit.combatAbilities` is the only place that says which abilities are slotted, and `characterAbilities` is the only place that carries experience. Joined, because with the level alone every ability reads as freshly levelled and every plan costs a whole level too much.

### Skill Books is BRead now, and Ability Books is gone

- One row, not two. **Skill Books** already existed and was already about books; it now also carries the cheapest next ability level and opens the panel on double-click. The separate **Ability Books** row I added last time has been removed — two rows about books, one of which you had to know to enable, is worse than one that was already there.

### The Watchlist counts what is on the market

- Items sitting in your own **sell orders** and **unclaimed** from filled buy orders now count towards what you own. A checklist that reads only the inventory says you have none of something you have two hundred of — the difference between "go farm this" and "wait", which is exactly the distinction a collection list exists to make.
- The count is starred and the tooltip breaks it down — in the bag, listed for sale, unclaimed — because where they are is the actionable part. A buy order's unfilled remainder is coin rather than items and is not counted.

Every item icon and name in the new panels opens the marketplace; checked across all four.

### Ability Books — BRead

- **Every ability at once**, with the books its next level costs and what those books cost in coin. The Item Dictionary already answered this for the one ability whose book you happened to be looking at, which is the wrong shape for the question people actually ask — not "what does this cost" but "what should I buy", and you cannot answer the second by opening the first eighteen times.
- **Sorted by cost, because cheapest is not nearest.** Books differ in the experience they grant and by orders of magnitude in price, so the ability two hundred experience from a level routinely costs more than one four thousand away. An **Ability Books** overlay row carries the winner; double-click opens the panel.
- **An unpriced book is unknown, not free.** Treating a missing price as zero would make whatever nobody is selling win every time, which is exactly backwards. Those rows say `no price`, sort last, and are excluded from the cheapest.
- **One target level for everything**, with the total books and coin to get every ability there — and a count of how many it could not price, so a lower bound is not read as a total.
- **The maths now lives in one place.** `utils/ability-books.js` holds it, and the dictionary calculator was rewired onto it. Both need the rule that an unlearned ability costs one book more — the book teaches the ability rather than levelling it — and two copies of that rule is two places for it to go missing.

20 tests on the arithmetic and 13 that build the panel. The panel ships in the UI bundle rather than the combat one: put beside the dictionary calculator it took the combat bundle to 2,093,537 bytes, 3.6 KB under the ceiling.

### A Track button in the item menu, off by default

- Clicking an inventory item now offers **Track** / **Untrack** beside Sell, so an item goes on the Watchlist where you noticed it rather than by opening a panel and finding it again. It says which of the two it will do, so the menu reports the item's state as well as changing it.
- **Off by default.** This adds a button to a menu you open for other reasons, next to Sell, and a misclick there is a sale — nobody who does not use the Watchlist should find that menu rearranged by a feature they did not ask for.
- **The switch is in two places and is one setting.** It is on the settings page under Loot Log and on the Watchlist panel itself, which is where you are when you decide you want it. Neither is a copy: both write the same setting, and flipping it from either attaches or removes the buttons immediately rather than at the next reload.
- It borrows the game's own button styling from a button already in that menu, so it does not read as something bolted on.

### Watchlist — NTally

- **A list of items you care about**, with what you hold, the unit ask and bid, and what the pile is worth. Inventory Value says what the whole bag is worth, which is a number that moves when anything moves; this one answers something narrower and actionable — _these thirty things, how many have I got, and which of them should I not be selling on the market._
- **Tick a combat zone and its whole drop table goes on the list.** Read from the game's own data: both `dropTable` and `rareDropTable` of every ordinary spawn **and every boss**, or the completion reward table if it is a dungeon. Reading only the common table would omit precisely the drops anybody tracks a zone for, and reading a dungeon as an ordinary zone finds nothing at all. Chests work the same way, and include the unopened chest itself.
- **The zones come from the action map rather than a list**, so a zone added by a game update appears on its own — where MCS's hardcoded fifteen would not.
- **Un-ticking a set does not take items another set still wants.** Zones share drops, so every row remembers which set put it there, and un-ticking re-homes any row a still-ticked set also contains instead of deleting it. Items added by hand belong to no set and survive everything. This is the part with the most tests, because getting it wrong looks like the list losing things at random.
- **A green dot on tracked items in the inventory**, so the list is readable where you are actually looking rather than only when the panel is open.
- **The vendor warning.** A market bid below what the vendor pays flat is not a price, and reporting it as the item's value quietly advises the worse of two sales. Those rows show the vendor price with a ⚠ and say why. Items with no market at all report the vendor price too — a bid of zero is the absence of a price, not a value of nothing. Toolasha already made this comparison inside the bulk-sell flow; here it stands as a property of the item rather than as a step in selling one.
- A **Watchlist** overlay row carries `held / tracked`, the total at ask, and the count of rows the vendor would pay more for. Double-click opens the panel.
- One tick can add thirty rows, so there is one gesture to empty the list again — which unticks every set at the same time, since a ticked box over an empty list is a box claiming something untrue.

`utils/watchlist.js` (26 tests) and `utils/drop-sources.js` (16 tests) hold the set algebra and the drop-table walking; 14 more build the panel and read it back.

### The MWI Combat Suite source is back in the tree while the port runs

- `third-party/mwi-combat-suite/mwi-combat-suite-0.9.36235.user.js` is restored. It was removed because 2 MB and 42,155 lines cost every clone for a file nothing builds against — which is true, and was the wrong trade while the port is still in progress. Without it, every question about what a panel actually does gets answered from screenshots, and at least one port went in wrong that way.
- Nothing in the toolchain reads it: `eslint` and the test runner only look at `src/`, `prettier` is scoped to `src`, `*.config.js` and `**/*.md`, and CI's 2 MB check only measures `dist/`. It is added to `.prettierignore` anyway, so a repo-wide `prettier --write` cannot reformat somebody else's script. The notes and licence beside it stay formatted.
- It can go again once nothing is being read out of it.

### The combat level is a target you can aim at

- **The Target Selector offers Combat alongside the skills**, so "when do I hit 151?" is answerable directly rather than by picking a skill and doing the last step in your head. It drives the Time to Level tile like any other target: `Combat → 130`.
- **Combat level has no experience table of its own** — it moves because two skills underneath it are moving, at different rates and different weights — so this is not a division. The clock is run forward at the projected rates and the formula is asked when it crosses, found by doubling until it passes and then bisecting, which is exact to the second. A closed form would need the weights to hold still, and they do not: a skill overtaking another changes what a level of it is worth partway through, and the answer has to be right across that crossover.
- A target the current rates can never reach — everything caps out — declines rather than reporting a century.
- Combat is offered on the Target Selector only. Primary and Focus are shares of experience, and combat level does not receive experience.

`fractionalLevelOf` and `timeToCombatLevel` are in `utils/combat-level.js` with 11 more tests, one of which checks the table inverts cleanly at all 150 levels rather than only at the ones anybody would try by hand.

### The Time to Level tile follows the Target Selector

- **Pick a skill and a level in the panel and the tile reports that**, instead of going on about whichever skill happens to be going up fastest. A selector that drives nothing you can see is indistinguishable from a selector that does not work. A target beyond the next level reads `Defense → 130`; the next level reads as it always did, since the arrow would be saying nothing.
- **The choice is kept**, so a tile you set once still says the same thing next week. It also lives outside the panel now — it has to, since the tile is on screen while the panel is closed, which is most of the time.
- The time comes from the same projected rate the panel shows, so the tile and the Target Selector cannot disagree.

### The two copies of the sampling loop are now one

- The panel and the Time to Level row each had their own copy of "read every skill, keep ten minutes, work out a rate". Both had the clock-going-backwards bug and the different-character bug; **only one copy had been fixed**, so the overlay row was still going quiet after a resume from sleep and still measuring the gap between two characters as a rate.
- Both now use `utils/skill-history.js`, with 12 tests. Each still keeps its own instance, so opening or closing the panel cannot reset the row's measurement — which was the reason for two copies in the first place, and did not require two copies.
- Writing its tests found a third: the very first reading was refused whenever the clock started near zero, because "never sampled" was stored as time zero and zero is a real time. Invisible under a real clock, which is how it survived.

### Fixed: changing a dropdown appeared to do nothing

- **The refresh guard was blocking the redraws the user asked for.** The panel skips its five-second redraw while a field has focus, so a half-typed level is not swept away — but `change` fires on a dropdown while that dropdown still has focus, so the redraw it asked for was skipped too. The new figures then turned up whenever focus next moved and the clock came round, which is what "takes ages to show the new exp rate" was.
- The two are now separate: the periodic redraw still leaves a field alone, and a redraw the user asked for always happens. **The control also keeps its focus across it**, so changing Focus twice in a row does not mean clicking back into the dropdown between.
- **The Target Selector reads the same rates as the table below it.** It used the measured rate while the table used the projected one, so choosing a skill you are not training answered `—` with the answer two inches beneath it. Both now come from one `projectedRates`, which also fixes the case nobody had hit: pointing Primary and Focus at the same skill gave it one share and silently dropped the other.

### Combat Revenue reads like MCS's

- One decimal and a plain hyphen: `95.1M - 13.2M = 82.0M/day`. Three numbers and two operators on one tile is already tight, and the second decimal buys nothing when the figure moves by millions a minute.

### Panels can now be tested, and testing this one found two more bugs

- **`happy-dom` is a dev dependency, opted into per file** with `/** @vitest-environment happy-dom */`. Everything else stays in `node`, which is right — most of what is worth testing here is arithmetic, and the DOM environment costs setup time on every file that takes it. `AGENTS.md` documents the pattern.
- **23 tests build the Combat Level panel and read it back.** The load-bearing one is the dullest: every section draws and none reports a failure. That single line is what a missing method, a renamed helper, or a property read off something that stopped having it all fail — and it is exactly what nothing caught last time.
- **Fixed: a clock that goes backwards stopped the rates.** A correction or a resume from sleep leaves readings stamped in the future, and the window between them is negative, so every rate reads as unmeasurable until real time catches up — which for a long sleep is hours of a panel quietly saying nothing. The readings are now discarded and the measurement starts again.
- **Fixed: switching character measured the gap between the two as a rate.** Experience does not go down, so a reading below the last one is a different character — a test server beside a live one is an ordinary thing to have. That skill's history is now dropped rather than subtracted across.

Both were found by writing the tests, not by using the panel.

### Fixed: the Combat Level panel stopped after the session bar

- `_busiest` was called and never written. It threw on the Target Selector, which is the section immediately after the session bar — so everything below it, the whole panel, was never drawn.
- **A section that cannot be drawn no longer takes the rest of the panel with it.** Each one is built inside its own guard and says what went wrong in its place. Half a panel with no explanation looks like a missing feature rather than a bug, which is the wrong thing for it to look like — and it is why this shipped at all.

### GWhiz, part three: the bar was measuring the wrong thing

- **The progress bar was 30% when it should have been 79%.** The obvious reading of "how far to the next combat level" is the fraction the displayed whole number throws away — `126.300` is 30% of the way to 127. That is wrong. Combat level is computed from **whole** skill levels, so it steps; feed it the part-finished levels instead and it becomes the continuous figure it really is. A build at `126.300` whose Melee is 81.7% of the way to its next level is 79% of the way to Combat 127, because most of the Melee level carrying the doubled term is already banked. That is the difference between "a third of the way" and "nearly there", and it is what GWhiz's bar has been showing all along.
- **So the bar is drawn in two colours**, and the formula is run twice: whole levels give the number the game shows and the arithmetic beside it, fractional levels give the bar. The first colour is what completed levels have banked; the second is what the level in progress has added.
- **Time to the next combat level**, on the block and on the title bar. It is the cheapest route's levels costed at that skill's measured rate against the real experience table — so "2 levels of Melee" and the 8d 22h beside it are the same plan, not two.
- **Laid out like GWhiz.** Cards rather than one column; a session bar with Start, Duration, Exp and Exp/Hr; the formula in monospace with **every term coloured by the skill it is**, so the repeated one is visible rather than inferred; a full block per skill actually gaining, with its remaining experience, its share of the run, and its own bar; and folding headings on the lower sections.
- **Time to Level answers "what if I trained something else".** The split between the two skills receiving experience — 28.4% and 71.6% on the reference build — is a property of the setup, not of those skills. The Primary and Focus selectors point those measured shares at any skill you like, and the table's rates and times follow, so the cost of switching is answerable without spending a day finding out. Projected rates are italicised, since they are not measurements.
- **Skills with no rate get a tile instead of a row of dashes** — level and how far into it — which is what GWhiz's compact section is for. The charm and wisdom figures stay beneath them.
- **Double-clicking Experience/hr or Time to Level opens the panel.** Both rows are one line about a question the panel answers in full. The Experience/hr row reaches it through the global rather than by import, since it is in the combat bundle and importing would have given it a second panel with its own session clock.
- Exp Lookup shows the subtraction, not just its result, since the two thresholds are the answer to the next question.

`levelFraction` and `fractionalLevels` are in `utils/combat-level.js` with 4 more tests, one of which reproduces the 79% from the reference build's own numbers.

### GWhiz, part two: the session, targets, charms and the lookup

- **Corrected the combat level formula.** The two maxima are over **different sets**: the flat sum takes the best of Melee, Ranged and Magic, and the doubled term takes the best of those _plus Attack and Defense_. Part one used the offensive maximum for both. The two agree whenever an offensive skill leads overall — which is most builds, and is exactly why the wrong reading survived a check against a real character — and part company the moment Attack or Defense is your highest, where it understated the level by as much as fifteen. The panel now names both skills, and the tooltip on the formula says which is which.
- **A Session block, and a Combat Session overlay row.** How long you have been at it, how much combat experience it has been worth, at what rate, and which skills it went to — with a **Reset** to start the measurement again. It survives closing the panel, since tidying up is not the same gesture as starting a new measurement, and it re-baselines itself rather than reporting a loss when the readings belong to a different character.
- **A target level per skill.** The Skills table gained an editable **Target** box and a **Time** column, so any level is answerable, not just the next one. This is the whole of GWhiz's separate skill-and-target selector, on the row it belongs to rather than behind a dropdown. Hovering the time says how much experience the target is worth.
- **Charms & Wisdom.** What is actually multiplying the experience in the table above it: the wisdom on every combat skill, and per skill the charm bonus, which charm it comes from, and the resulting multiplier. Read through Toolasha's own experience parser rather than re-derived, so it agrees with the figures the action panels already show.
- **Experience Lookup.** Experience between any two levels, which the game never shows.
- The panel no longer rebuilds itself under a box you are typing into, so a target half-entered on the five-second refresh is not lost.

The session arithmetic is in `utils/exp-session.js` with 9 tests, and the corrected formula is pinned by three in `utils/combat-level.js` that fail under the old reading.

### GWhiz, part one: combat level and what moves it

- **A Combat Level row and panel.** The game shows a whole number, which hides the two facts worth acting on: combat level is a weighted average, so the fraction you have already earned is invisible, and the skill that would finish it soonest is not the one most people are training.
- **The formula is spelled out**, the way GWhiz does it: `0.1 × (110 + 100 + 129 + 120 + 134) + 0.5 × 134 = 126.300`, with a bar for the 0.3 the displayed `126` throws away.
- **A level of the offensive skill you are actually using is worth six of any other**, because it counts twice in the formula — once in the sum and once on its own. The panel says how many levels of each skill would raise Combat, and the row names the shortest route.
- **An offensive skill sitting behind a higher one is worth nothing at all** until it overtakes, so it says so rather than reporting `0` — which would read as "already done" for a skill that will never do it on its own.
- Each skill also carries its measured experience rate and the countdown to its next level, over a rolling ten minutes.

The arithmetic is in `utils/combat-level.js` with 22 tests, checked against the figures GWhiz shows for the same build — `126.300` and "2 levels of Melee" are both reproduced from the screenshot's own numbers.

**Still to port from GWhiz:** the session timer and exp total, the TTL selector with arbitrary target levels, the per-skill target table, Charms, and the Exp Lookup. — _All of these landed in part two above, which also corrects the formula quoted here: `0.5 ×` takes the best of five skills, not of the three offensive ones. For this particular build the two happen to agree._

### Every feature that adds marketplace tabs now finds the visible marketplace

- `visibleTabsContainer` moved into `utils/marketplace-tabs.js` beside the tab machinery it serves, and **Missing Materials, the Crafting Plan, Guild Credit Value and the consumables restock all use it**. Each of them took the first tab bar in the document, which is the hidden full-page marketplace whenever the popout is the one you are looking at — so their tabs went somewhere real and invisible.
- That failure only showed up in the restock because the others are reached from flows that happen to land on the full marketplace page. The bug was the same in all four; only the route hid it.

- **House Cost Display, Market History Viewer and the Sell Queue** were fixed too, so **no feature anywhere still takes the first tab bar it finds**. None of them had been reported broken — they are reached by routes that land on the full marketplace page, exactly as the other three were — but the latent bug was the same and they would have failed the same way from the popout.

### Fixed: the restock tabs went onto the marketplace you could not see

- **There is more than one marketplace.** It opens as a popout over whatever you were doing, and the full marketplace page keeps its own tab bar in the document behind it. Both match the same selector, and the search took whichever came first — frequently the hidden one.
- So the tabs were being added correctly, to a tab bar nobody could see. That is why visiting the real marketplace first appeared to fix it: it made the bar that was already being picked the one on screen.
- Every candidate bar is now checked and the one actually being displayed wins.

### Fixed: the restock heading duplicated, and a failed build stood until something else rebuilt the tabs

- The green **Restock: N items** heading was not marked as one of ours, so the tidy-up that removes the tabs left it behind — and every re-add stacked another heading beside the last.
- Worse, the watcher judged itself on _having run_ rather than on the tabs being there. A heading with nothing after it counted as success, so a failed attempt stood until some other feature happened to rebuild the tab bar — which is why running a normal missing-materials lookup first appeared to "fix" it. It now checks that every item tab it expected is actually on screen, and rebuilds until they are.
- A tab that cannot be built logs why, rather than leaving a list that has silently arrived short looking like one that had nothing to add.

### Fixed: Buy all showed the heading and no tabs

- The tab helper reads `itemName`, and the shopping list passed `name`. It threw on the very first item, so the green **Restock: N items** heading went in and nothing after it did. Each tab is now built inside its own try/catch too, so one item that cannot be drawn costs its own tab rather than the whole list.

### Fixed: the overlay sat above the game's own interface

- It used the floating-panel layer, which is meant for panels you open on purpose and dismiss. The overlay is never dismissed — it is always up — so on that layer it covered the game's tabs and buttons wherever it happened to overlap them.
- It now sits on the HUD layer, below the game's interactive UI, which is what that layer exists for. The settings popover stays above, since that one _is_ summoned on purpose and has to be usable while it is open.

### Fixed: Buy all opened the marketplace with no tabs on it

- The tabs went in immediately after navigating, and the marketplace tab bar is usually **already there** from a previous visit — so they were added, and then wiped a moment later when React rebuilt the panel for the item being navigated to. Waiting longer would not have helped; the bar was never missing.
- The tabs are now put back whenever they have gone, for a few seconds after the navigation, which outlasts however many times the panel rebuilds itself.

### Fixed: the Consumables panel sat on top of the marketplace it sent you to

- It is a floating panel and the marketplace opens underneath it, so pressing Buy or Buy all covered the thing you had just asked for — including the tabs. It now closes itself on the way.

### Buy the whole restock at once, as marketplace tabs

- The footer's total is now a **Buy all** button. It opens the marketplace with **a tab per short item, each reading "Missing: N"** — the same tabs the missing-materials features already put there — and each one opens its item with the quantity filled in. The row of tabs is the shopping list: what is left to buy is what is still red.
- Buying a row at a time was the wrong gesture for a restock. Six items meant six trips back to a panel sitting behind the marketplace you were standing in.
- **Nothing about the tabs is new.** `createMaterialTab` draws them, the autofill manager fills the quantity, and the marketplace cleanup observer takes them away when you leave. A second implementation of marketplace tabs would only be a second set of bugs about where the game moved its tab bar.

### The buy recommendation now measures the queue instead of assuming it

- The order-against-instant call used a flat six-hour guess at how long a buy order takes to fill. It now reads the **real order book** — the queue length estimator already caches every book the game has sent — and estimates the wait from the depth at the best bid and the listing timestamps behind it.
- **The timestamps are the only rate signal there is.** Twenty listings at one price spanning ten minutes is a level that churns; twenty spanning a week is a level where an order is a week-long proposition. Fill time is depth ahead ÷ the rate depth arrived at, which assumes a level drains about as fast as it fills — true in a liquid market, false in a moving one, and stated in the module rather than buried.
- Queue depth is extrapolated past the twenty listings the game shows, using the same arithmetic as the queue length display, so the two never disagree.
- **It says which answer you got.** With a measured wait the hover reads "fills in about 40 minutes"; without one it says no order book has been seen for that item yet and suggests opening it once. A guess presented as a measurement is worse than a guess labelled as one.
- Measuring changes the answer both ways: a fast-filling book now recommends an order where the flat assumption refused one, and a slow book refuses an order the assumption would have allowed.

### Buy the shortfall, in equipped order, with exact drink rates

- **Click the Buy figure to open the marketplace with the quantity already filled in**, through the same autofill the missing-materials features use. It opens the buy modal rather than buying: this is a decision about spending coins, and a panel that spends them for you is a panel you have to watch.
- **It recommends an order or an instant buy**, the same judgement the bulk sell assistant makes in the other direction. ⏳ means a buy order at bid is worth the wait, ⚡ means take the ask. Two things force ⚡: **running out before an order would plausibly fill** — a discount that arrives after you have stopped has saved you nothing, so urgency beats price — and a spread too thin to be worth waiting for. The reasoning is in the hover text.
- **Rows are in equipped order now, not soonest-first.** Slot order is how you think about them, the one that runs out first is already marked in red, and sorting by it as well traded a familiar list for one that reshuffles itself.

### Fixed: drinks were assumed to be drunk at maximum concentration

- Drink consumption was measured from observed use and then **capped at a hardcoded 345.6 a day** — 300 seconds at the maximum 20% drink concentration. Anyone below that cap was told they drink faster than they do, and that their stock would run out sooner than it will.
- Drinks do not need measuring at all: one is re-drunk the moment its buff expires, so the rate is the buff's duration divided by `1 + drinkConcentration`, which is exactly what the combat simulator does to it. It is now computed from the game's own numbers and the player's actual concentration.
- **Food is deliberately still measured.** It is eaten when health or mana crosses a threshold, which depends on what is hitting you — there is nothing to compute, and observation is the only honest answer.

### The Consumables tile answers for you and for the party

- Reads `You: 1.2d   Party: --` the way MCS's does. **Two answers, because they are two different things to act on**: your own countdown is what you can do something about right now, and the party's is what ends the run regardless of how well stocked you are. Rolling them into one figure loses whichever of the two you needed.
- The party figure **excludes you** — it answers "and how is everyone else doing", which is the only part of it you cannot already see. Hovering names whoever in the party runs dry first.
- Under it, the item that stops you with its icon and how many remain, then the daily bill at **both sides of the book** to match the panel. Clicking the icon or the count opens the marketplace, which is where you go next when the answer is "soon".
- The tile and the panel now read their figures off one calculation. `partyOutlook` and the rest of the judgement live in `utils/consumable-forecast.js`, so neither view decides for itself what "runs out first" means.

### The Consumables panel reads like CRack's, and items open the marketplace

- **Laid out the way MCS lays it out**: the count you hold, the item's icon, its name, the daily rate, the cost, the shortfall, and the countdown — in that order, so the eye lands on the stock figure first.
- **Cost is shown at both sides of the book, Ask over Bid.** Buying costs ask and the stock you already hold is worth bid; on a bill of twelve million a day the gap between them is real money, and averaging it away hides it. The footer reads `Total Cost/Day: Ask: … / Bid: …` to match.
- **The consumable that stops the run is coloured throughout its row**, not only in its time column. It is the row the whole panel exists to point at, and a single red figure at the far right is easy to miss.
- **Click an item's icon or name — in the panel or on the overlay tile — to open it in the marketplace.** That is what you point at when you think "what does that cost", and the row is read while deciding whether to go and buy more. The click is stopped from reaching the tile behind, so it cannot accidentally count towards the double-click that closes the panel.
- The overlay tile gained the icon too, so the row and the panel name the same thing the same way.

**Not reproduced**: CRack's two `↑ / ↓` columns. They show the same pair of figures on every row and I could not work out what they measure without guessing, and a column that is confidently wrong is worse than a column that is absent.

### Double-clicking a tile closes the panel it opened

- Treasure, Houses and Consumables all toggle now. The same gesture that summoned a panel is the one you reach for to dismiss it, and a double-click that only ever opens leaves you hunting for the close button.

### The dev build says which build it is

- The dev script and the published one carry the same `@name` and the same `@version`, so neither Tampermonkey nor you can tell them apart — a stale install looks exactly like a fresh one that is missing a feature. Every dev build now prints `[Toolasha] dev build <timestamp>` to the console on load. Whatever the console says is what is actually running.

### A Consumables panel: what runs out, when, and what to buy

- The overlay row answers "what runs out first, and when". That is the figure worth watching, but not the one worth acting on — when the answer is "six hours", the next question is immediately "so what do I buy, and how much". **Double-click the Consumables row** to open the panel that holds it.
- **Every line is measured against a duration you pick** — 8 hours, a day, three days, a week, cycled from the header. A list of stock levels says what you have; the same list against "last me a day" says what to do about it, and the two readings differ per consumable because they are drunk at different rates.
- Each row shows what is held, how many go per day, how long it lasts, and **what to buy** — the shortfall from what you already hold, rounded up, priced. Half a drink is not a drink, and a refill that leaves you one short leaves you stopped.
- **The headline is a minimum, not a mean.** A character stops when its _first_ consumable runs out. Anything not being consumed is kept out of that entirely rather than counted as lasting forever and quietly winning it — an unused slot reads as `∞` in the list and is ignored by the verdict.
- **Party members are listed**, because a party run stops when the first member runs dry and that member is frequently not you.
- Unpriced consumables are counted separately rather than as free, so a total is never quietly smaller than the truth.

### Tile text buttons moved to the bottom left

- They sat top right, which is where a tile's value sits — so hovering to resize the text covered the number you were sizing. Bottom right belongs to the resize grip, so bottom left it is.

### The combat bundle had 19 KB left

- Adding the panel there would have left the next feature unable to build. The panel reads combat data but is otherwise a panel, so it lives in the UI bundle, and the collector it reads — a stateful singleton fed by the websocket — is now declared shared rather than copied into a second instance that would sit there receiving nothing. Verified in the built files: one collector, in combat, referenced by ui through the shared global. Headroom is back to 42 KB.

### Fixed: importing a layout wider than the panel folded it in half

- The layout was laid out against the width the panel **currently** was, and the panel is only resized to fit a moment later. A canvas narrower than the file asks for does not scroll — it _clamps_, pulling every tile past the right edge back inside it. That dropped the right-hand column on top of the left one, and settling then stacked the collision into a single very tall column with holes in it.
- It is now laid out against the width the file actually needs, which is the width the panel is about to have. Measured on the two-column layout: at the old panel width 19 of 20 tiles moved; now none do, so an imported layout arrives exactly as it was designed.

### Fixed: Time to Level tracked the total level

- The game keeps the total level in the same list as real skills, and it gains experience faster than any of them by definition — it is the sum of them all. So it always won "which skill is being trained", and always reported no next level, since there is no row for it in the experience table. The row read `Total Level 2274: —` and never anything else.

### Text size, per tile and for the panel at once

- **Every tile shows − and + when you hover it while the layout is unlocked**, for its own text size. The rest of the time a tile is something you read, and two buttons sitting on the figure are two buttons in the way.
- **A Text control in settings scales the whole panel.** Each tile's own size is a percentage of that, so scaling everything leaves the differences between tiles intact — a tile you made 130% stays half again as large as its neighbours. Reset puts it back to 100%, and Undo carries it back with the rest of the layout.

### Fixed: Ctrl+scroll zoomed the whole page

- Ctrl+wheel is the browser's own page-zoom gesture, and a page that zooms when you meant to resize one tile is worse than no shortcut at all. The buttons above replace it — and unlike a modifier gesture, they can be found without being told about.

### The settings popover moved out of the panel, and Autogrid can be undone

- **Settings open above the panel, not inside it.** The gear section took its height out of the tiles, so opening it squashed the very layout you opened it to arrange. It is now its own floating popover, placed above the panel — below it only when there is no room above — and it follows the panel when you drag or resize it.
- **Undo.** Autogrid, Reset and Import each throw away an arrangement that may have taken a while to get right, and none of them can be judged until after they have happened — you press Autogrid to find out what Autogrid does. Each now keeps the layout it replaced, and an **Undo Autogrid** / **Undo Reset** / **Undo Import** button appears beside it. It is only there when there is something to take back, so it never reads as a button that does nothing.

### Fixed: the panel was see-through

- At 90% opacity the game's inventory grid read straight through the tiles, and a figure you have to pick out of a background is not a glance. Near-opaque now.

### Fixed: an imported layout arrived as a scatter with holes in it

- Growing imported tiles to fit made them collide, and pushing the collisions down left the gaps the old smaller tiles used to sit in — so the layout stretched into something sparse and wrong rather than something snug.
- Tiles now **settle upwards in their own column** instead. Overlaps resolve because two tiles cannot settle in the same place, and the gaps close because a tile no longer stops at the space it used to sit below. Columns are still never crossed: sliding into the other column is not a nudge, it is a scramble.

### Separators, and an import that arrives usable

- **Separators.** Each tile draws a rule under it when the layout is locked, which is what gives a column of tiles the ruled look rather than a floating jumble. Off while you are editing, since the tile's own outline is showing then, and switchable in the gear.

- **Fixed: an imported OPanel layout arrived unreadable.** Every size in an OPanel file is a measurement of OPanel's rendering, and this overlay's rows are not that rendering — so tiles imported verbatim were too small for what they had to hold, and the result was a wall of clipped half-words. Imported tiles are now grown to at least what the row needs, taking the larger of the two so a tile someone deliberately made roomy stays roomy.
- Growing them makes them collide, so anything overlapping is **pushed straight down, staying in its column**. An OPanel layout is two columns, and a tile that resolves a collision by sliding into the other one has not been nudged, it has been scrambled. Reading order survives and the layout stretches instead.
- The panel's own frame is grown to fit as well. Left at the imported size, half the layout arrives below the fold, which reads as tiles that failed to import rather than as a panel that needs dragging.

- **Durations in tiles are short now.** `71 days 9h 55m` is right in a tooltip and wrong in a tile, where it pushed the label beside it down to a single letter. Two units at most, and the small one drops once the large one makes it noise: `45s`, `12m`, `3h 20m`, `4d 16h`, `71d`.

### Build Score, and rows that fit their tiles

- **Build Score.** Toolasha already computes this — it is the figure on the profile card, the build's cost in millions split into equipment, abilities and house. It was only ever shown for a profile you had opened, so the one build you could not casually check was your own. `calculateCombatScore` reads exactly three things out of a shared profile — house rooms, equipped abilities, worn items — and all three are already known for the current character, so the same shape is assembled locally and the same function gives the same answer as the card. It recomputes on gear and house changes, debounced, never on the overlay's timer, and attaches its listeners on the first render so a row nobody switched on costs nothing.

- **Import and export the overlay layout, in OPanel's own format.** A layout is worth an hour of fiddling and is then worth keeping, and someone arriving from MCS has already spent that hour. Positions, sizes, text scales, order, visibility, the lock and the grid all carry across; the panel's frame comes too. Rows the file names that have no equivalent here are **listed in the confirmation** rather than dropped quietly, because a layout that silently arrives missing three tiles reads as an import that half-worked. Export writes the same shape, leaving out rows OPanel has no key for — writing ours into their file gives MCS something it reads as corrupt rather than as extended.

- **Every row now reads like OPanel's.** Tiles are small and fixed, so anything that wraps does not get taller, it gets cut off — which is how the overlay ended up with "Drop luck" broken across two lines beside a figure that had run off the edge. One shared formatter now draws every row: nothing wraps, exactly one piece per line may be shortened (a name, never a number, since a truncated number is not a smaller number but a wrong one), and one palette means two rows cannot disagree about what green stands for.

- **The unit moved onto the value.** `260,572 exp/hr`, not `Experience` on the left and `260,572/hr` on the right — half the label was repeating what the number's own unit already said, in the space the number needed. Drop Luck is a figure with the sentence in its tooltip, the session clock reads `2:44:51 | 180.16 EPH`, and revenue reads `61.6M − 13.2M = 48.3M/day`.

### Fixed: Total Profit read NaN

- Session income had the two cost figures subtracted from it, but both are `{ask, bid}` objects rather than numbers, so the arithmetic produced NaN — the daily rate beside it was right, which is what made it look like a display bug rather than a subtraction one.

### Fixed: numbers above a trillion printed as thousands of billions

- `formatKMB` stopped at B, so a net worth of 985 trillion rendered `985663.62B`. It now carries on into T and Q.

### Twelve more overlay rows

Everything OPanel shows that Toolasha had the data for. Nothing here computes anything new on the overlay's timer — each row reads a figure some feature already keeps, or measures one thing cheaply itself.

- **Session Timer / EPH** — the run clock and encounters per hour. EPH is the rate every other figure is divided by, so it is the first thing to check when one has drifted: income falling while EPH holds means prices moved, both falling together means the fights got slower.
- **Total Profit** — what the run has actually banked, beside the daily projection. The two disagree whenever the run started badly or has just had a rare, and the disagreement is the useful part — a daily rate off twenty minutes is a guess.
- **Consumables** — which one runs out first, how long it has, and what the lot costs per day. The soonest one is the only one that matters: it is what ends the run whether you are watching or not. Under an hour it turns red.
- **Combat Status** — fighting, skilling, or idle. Read from the action queue, not from combat data, because combat data keeps saying what the last run did long after it stopped.
- **DPS** — damage and damage taken per second. **The game sends no damage figure**, so this is inferred from health lost between combat ticks. Two things follow and are stated on the row rather than buried: overkill is not counted, and in a party it is the whole party's damage, since nothing on the wire says who struck. The clock counts ticks received rather than wall time, so an idle night is not divided into the average.
- **Over Expected %** — takings against what the zone owed, in coins. The companion to Drop Luck rather than a duplicate of it: the percentile says how _unusual_ a run was, and on a zone whose value rides on one rare, a perfectly ordinary session sits well below the 50th and reads as bad luck. Against the mean it reads as par. Computed in closed form, so it costs microseconds where the percentile costs a tenth of a second.
- **Equipment Watch** — what is on the anvil, what it has cost, time left, and a progress bar. The bar is **attempts against expected attempts**, not level against target: levels are not evenly spaced, so a bar drawn on levels sits at 90% for hours. Past expectation it stays full and turns red, because "this has taken twice what it should" is the thing you want it to be able to say.
- **Time to Level** — which skill is going up fastest and when it next levels, measured over a rolling ten minutes. A rate measured from the session start answers how fast it has gone on average, when the question is how fast it is going now — and they differ by the whole of any break you took. At the cap it says nothing rather than "never".
- **Coins**, **Market Listings**, **Inventory Value**, **Skill Books** — four fields of the net worth pass you already run. Net worth as one figure moves too slowly to watch and hides the parts that do move.

**Not ported: Build Score.** It is KOllection's own formula, and Toolasha has no equivalent. Inventing a scoring formula and labelling it with someone else's name would produce a confident number that means nothing and matches nothing.

**Not ported: the Only Numbers / Only Player display toggles.** They control party columns, and every row here shows the current player only, so the switches would do nothing.

### The overlay is a layout, not a list

- **Rows are placed freely rather than stacked.** A stack forces one ordering decision — what goes above what — when the question you want to answer is what sits _beside_ what: revenue next to profit, luck next to expectation, so a glance reads a comparison instead of a column. Each tile carries its own position, size and text scale, and all of it is remembered.
- **Locked by default (🔒).** An always-editable overlay is one where every click risks nudging the layout. Unlock to drag tiles by their body and resize them from the corner; lock again to go back to reading it.
- **Snap to a 10px grid**, so tiles line up without being fiddled into place, and can be switched off when they need not to.
- **Ctrl+scroll a tile to change its text size.** Tiles hold wildly different amounts — a timer is four characters and combat revenue is three lines of figures — so one text size for the whole panel means either a cramped tile or a wasteful one. Plain scroll is left to the panel, which still has to scroll.
- **Autogrid** repacks everything from the top left in order, wrapping at the panel edge; a wrapped line clears the tallest tile above it rather than interleaving with it. **Reset layout** forgets every position, size and scale, and the panel's own geometry with them.
- The row picker is now **chips that wrap** rather than one line each — fifteen rows as a vertical list is a panel of scrollbar; as chips it is four lines. Order still matters: it is what Autogrid packs by and where a new row is placed.
- A row can declare the size it needs (`defaultSize`), because the row knows how much it draws and the panel does not. A row no saved layout has heard of is **placed in the first free space** rather than left at the origin under an existing tile, where it would read as a row that failed to render.
- Refreshes hold off while you are dragging. The panel rewrites every tile's position once a second, which mid-drag meant the tile snapping back under the pointer a second in.

### Panels remember their size and position, and can be resized

- Every floating panel opened at a hardcoded corner at a hardcoded width and forgot anything you did to it, so the Treasure ledger and the Houses grid had to be dragged and re-read into shape on every page load. All three panels — Overlay, Treasure, Houses — now have a resize corner and one shared store behind them.
- Saved geometry is **clamped to the current window** on the way back out. A panel restored wider than the screen cannot be resized back, because its resize grip is off the edge; a panel restored off the right edge cannot be reached at all, which looks exactly like a feature that stopped working.
- **The chest popup remembers its size, but not its position — until you move it.** Sitting beside the game's loot dialog is the whole point of that popup, and a remembered position would silently switch that off the first time you nudged it out of the way. Dragging it pins it; the gear then offers **Unpin popup** to hand it back to auto-placement.

### Import asks Add, Replace or Cancel, in three buttons

- It was an OK/Cancel box with a paragraph explaining that OK meant add and Cancel meant replace — a sentence you have to read twice and can still read wrong, and reading it wrong overwrites a history that took months to accumulate. Buttons that say what they do cannot be misread.
- Deleting all history asks the same way, with the destructive answer coloured as one.

### Treasure: choose what untradables are worth, and move your history in and out

- **Capes, quivers and cloaks can be valued three ways.** They have no market price, so a chest that drops one otherwise reads as a chest that dropped nothing. A header button cycles between the **token cost** of what those tokens would have bought, the price of a **Mirror of Protection**, and **zero**. The token figure is read from the game's own shop table rather than hardcoded, so it follows a price change instead of going stale.
- **Cowbells can be counted or ignored.** A cowbell is untradable but a bag of ten is not, so counted, one is worth a bag's market price less the 18% tax, split ten ways. The toggle dims itself when it is set to count something as nothing, so the panel says at a glance that a figure is leaving something out.
- **Export and import your chest history.** Export writes item counts and your valuation settings — deliberately not prices. A price is a fact about the market on the day you exported, and baking it in would make an old file re-import as a ledger priced in last month's money.
- **Import reads Toolasha and TReasure files.** The format is detected from the file rather than asked for. It then asks whether to **add** the file to what you hold or **replace** it: two copies of the same ledger are not twice the ledger, so replace is the default for a file from this same tool on another machine. Appending adds counts but keeps the last opening you already had — the file's "most recent" belongs to another timeline.
- **Import from Edible Tools** reads its data straight out of browser storage, finding the current character by id and falling back to name. It keys everything by display name in whatever language the game was running in, so translation needs a name index built from today's game data; anything that will not translate is **named in the confirmation** rather than dropped in silence. A chest renamed since the data was written would otherwise vanish without trace.
- **Chests can be hidden individually.** The gear turns on an eye beside each row. Hidden chests are still tracked and still counted in the totals — hiding is about what you want to read, not what you want to stop recording.

### The Treasure panel lists every chest, and its columns line up

- **Every chest in the game is listed, not only the ones you have opened.** The panel is also where you look up what a chest is worth before deciding to open it, and a list of your own history cannot answer that. Unopened chests show their name and value, dimmed, with no verdict and no Reset — there is nothing to reset and no verdict to give.
- Chests you have opened still sort worst-first; the rest follow by what one is worth, so the list stays useful rather than alphabetical.
- A chest the game has stopped listing keeps its history rather than disappearing from the panel at the next update.
- **The three columns now line up.** Each was laid out with flex, so counts, values and percentages drifted with the width of whatever was above them, and the expected column ran off the panel's edge — the last figure was cut mid-number. Every band now shares one grid, each column has fixed sub-columns, digits are tabular so a changing value does not make the column jitter, and the panel is wide enough for four figures.
- Chest headers carry what one chest is worth beside the name, and a per-chest Reset.

### Double-click an overlay row to open the panel behind it

- A row is a summary; the detail it provokes a question about now lives one gesture away. Rows that own a panel show a pointer cursor and a hint on hover; rows that do not are simply not interactive.
- **Treasure** opens the full ledger, **Houses** opens the new room panel. Registering a row now takes an optional `onOpen`, so any future row gets this for free.

### The Treasure ledger reads across three columns

- Expanding a chest now shows **LAST**, **TOTAL** and **EXPECTED** side by side, one row per item, in a shared order — the question is always "how does this compare with that", and a single column cannot answer it.
- The last opening is judged against what **that opening** owed, not against the whole run. One chest owes a fraction of what forty do, and scoring one against forty would report every single opening as a disaster.
- The expected column carries both scales: what one chest owes, and what every chest you have opened owed. Counts below one keep three decimals or go exponential — a rare owed 0.002 of itself per chest rounds to zero, which reads as owing nothing rather than a one-in-five-hundred chance.

### A Houses panel

- The overlay row says how many upgrades you can afford and the cheapest one. Double-clicking opens a grid of every room, coloured by whether you can afford its next level, maxed rooms last and the rest cheapest first — the panel is read to decide what to buy next, not to audit what you own.
- Selecting a room lists what its next level needs, with **what you hold against what it wants**. The coin cost is only the answer if you intend to buy the materials; the usual question is whether you already have them.

### Fixed: the Houses row counted only rooms you had already bought

- `characterHouseRoomMap` holds the rooms you own, not every room in the game. A character with one maxed observatory and everything else unbuilt therefore looked like a character with nothing left to buy, and the row drew a blank. The unbuilt rooms are the whole point of the figure.
- It now walks the game's full room list and treats anything missing from your map as level 0, so the first upgrade of an unbought room is counted like any other.

### Fixed: the treasure popup ignored the loot dialog and stayed in the corner

- The dialog is rendered by React from the same message that tells us about the loot, so it is reliably not on screen yet when we look for it. The first attempt found nothing and gave up, leaving the popup where it started.
- It now retries briefly until the dialog appears, then places against it. Falling back to the corner only once the retries run out, which is what should happen when a chest is opened by a route that raises no dialog.

### The treasure popup now sits beside the game's loot dialog

- It was pinned to the top-right corner while the game's Opened Loot dialog opens near the middle, so reading the two together meant looking back and forth across the whole window. The popup is now measured after it mounts and placed against the dialog — to its right, or to its left when the right would run off screen, top-aligned and nudged up only if it is the taller of the two.
- Falls back to the corner when no dialog is up, which happens if a chest is opened by a route that does not raise one.

### Toolasha.Debug.houses()

- The Houses row draws nothing when it cannot price a single upgrade, and nothing is indistinguishable from the feature being off. `Toolasha.Debug.houses()` in the console now reports which step came back empty: the room list, the level, the game's `upgradeCostsMap`, or the market prices those costs are valued at — per room, with the cumulative figures either side of the subtraction so a wrong reading of the cost table is visible rather than inferred.

### Drop luck updates during a run, not only after it

- It was computed once, on leaving combat, because that is when the battle panel it writes into appears. The overlay row therefore sat empty for a whole grind and then filled in at the end — the least useful moment. Everything it needs is already on the `new_battle` message, so it is now recomputed from the running loot total as you fight.
- Throttled to once every thirty seconds, and deferred off the WebSocket handler. The transform costs around a tenth of a second, battles can be seconds apart, and a message handler is the worst place to spend that — it delays every other feature listening to the same message.
- The other rows were already live. Revenue, Experience/hr and Deaths/hr are rebuilt on every `new_battle`, and Treasure on every chest; the earlier note saying they needed a finished run was wrong.

### Fixed: bundles were carrying private copies of shared utilities

The combat bundle was 2,648 bytes under its 2 MB ceiling and about to break the build.

- The released script is six bundles, and any `src/utils` module not declared shared in `rollup.config.js` is **copied into every bundle that imports it**. Seventeen were undeclared, including all the drop-luck maths — 85 KB of source duplicated across bundles for no reason.
- All seventeen are now shared. Verified against the built files: the combat bundle references `Toolasha.Utils.*` and contains no copy of `sessionLuck`, `fftInPlace` or `buildCombatSession`, each of which now exists exactly once, in the utils bundle.
- **Combat headroom went from 2,648 bytes to 67,403.** Every other bundle shrank too — actions by 18 KB, market by 51 KB, ui by 36 KB.
- This was the same class of mistake as the overlay registry bug: a module that looks shared because it sits in `src/utils/` is not shared unless the build is told. The rule is now written down in `rollup.config.js` beside the list.

### Five more overlay rows, from calculators Toolasha already had

The overlay had two rows and both needed something to have happened first, so a fresh install showed an empty box. These read figures the codebase already computes.

- **Revenue** — income, what it cost to earn, and what is left: `75.8M − 11.9M = 63.9M/day`. The third number is the only one worth acting on and the one an income figure alone quietly overstates.
- **Experience/hr** and **Deaths/hr** — the same figures the Combat Statistics popup shows, on the overlay so they can be watched during a run rather than opened after one. Zero deaths is left uncoloured: it is the goal, not a shortfall.
- **Net worth** — reads the value the networth feature last calculated rather than calculating. A full pass prices every item you own and runs a worker pool, which is not something a row redrawn every second may do; it refreshes when the feature itself recalculates.
- **Houses** — how many room upgrades your coins cover, and the cheapest one. Counted per room rather than as a basket, because buying the cheapest changes what you can afford next, so "you could buy all six" would be false.

Nothing new is computed for the three combat rows — `calculatePlayerStats` is the same function the popup calls. The result is cached for a few seconds, since that function prices every item in the loot map and the overlay redraws every second.

**The combat bundle is now 2,648 bytes under its 2 MB limit.** Adding the three combat rows took roughly 6 KB of the 8 KB that was left. The next feature that touches that bundle will break the build, and splitting it is now the blocking problem rather than a tidy-up.

### Treasure pops up what an opening actually paid

New setting, on by default. Open a chest and a panel appears beside the game's own Opened Loot dialog, itemised.

- The game's dialog answers "what did I get" and leaves the only interesting question — was that good — to a feeling. Each item now shows the count and value you got on top, and what the drop table owed for that many chests underneath, with the difference as a percentage.
- Items that **should** have dropped and did not are listed with a `-100%`. On an unlucky opening that missing row is the whole story, and a list of only what appeared cannot tell you.
- Expected counts below ten keep two decimals. A rare owed 0.02 of itself rounds to nothing, and a row reading "0 expected" would say the chest owed you nothing when it owed you a 1-in-50 chance.
- Underneath, the lifetime figure for that chest type, so a good opening off a bad run still reads as a bad run. "View full stats" opens the whole ledger.
- Priced through the same source as the ledger, so a chest cannot look lucky merely because two views priced it differently.

### Settings moved out of the wrong section

- **Overlay Panel** and **Treasure Tracker** were filed under "Item Tooltip Enhancements", which has nothing to do with either. They now sit under **UI & Appearance** and **Loot Log**.

### The reference script is no longer carried in the repository

- Frotty's MWI Combat Suite was vendored while the ports were written. It is ~2 MB and 42,155 lines, which is not worth carrying in the history for a file nothing builds against, so it has been removed from this branch's history rather than deleted in a later commit — the blob never reaches `main` at all.
- Attribution still needs to name something checkable, so `third-party/mwi-combat-suite/` keeps the licence, the version string, and the line numbers in that exact version for everything taken.

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
