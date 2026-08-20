# KikiMeter (reference notes)

Notes on **KikiMeter v3.32.1** by **ZhuLiMoon** — a lightweight DPS meter for Milky Way Idle,
MIT licensed, published as GreasyFork script 584984:

<https://greasyfork.org/scripts/584984>

The script is **not kept here**. It is a single 218 KB file and nothing in Toolasha builds
against it; the version number above is what makes the attribution checkable, and the script
can be fetched from that URL when a claim below needs re-reading. No KikiMeter source was
copied. What was taken is the analysis — six specific findings, each of which Toolasha
re-implemented against its own attribution module, its own storage and its own panels.

## What was adopted

- **Un-countered health loss is still damage.** KikiMeter attributes purely on health diffs and
  never consults a monster's hit counter, so a bleed tick or a thorns reflect is counted like
  anything else. Toolasha gated on the counter and silently discarded that volume, which is why
  its per-player tables disagreed with the party total measured off the boss bar by exactly the
  damage-over-time share. It is now a labelled event class (`isDot`) in
  `src/utils/damage-attribution.js`, attributed by the same rungs as a hit and kept out of the
  hit, crit and miss counts.
- **A collision too big to adjudicate is split, not awarded.** With synchronised builds several
  players cast on the same millisecond; ZhuLiMoon's captures put ~13% of trial messages in that
  state, with up to 23 actors at once. Toolasha's final fallback handed the whole tick to
  whichever player swung most recently — an iteration-order artifact, and a systematic bias in a
  thirty-person trial. Above three players present with nothing to separate them, the tick is
  now split equally (`COLLISION_SPLIT_THRESHOLD`).
- **…and equally, not weighted.** The weighted version — share the ambiguous damage in
  proportion to damage already confirmed — was tried upstream on a real trial capture and
  abandoned: players who never won a solo-confirmed tick stayed at zero while the early winners
  took the whole ambiguous stream. Measured mean error 56%, against the game's own end-of-trial
  figures. Toolasha did not repeat the experiment; it took the result.
- **A slot's maximum health changing is a new monster in it.** A guild trial receives
  `new_guild_battle` only one to three times an hour, so unlike personal combat it has no
  per-wave re-baseline. A monster respawning into the same slot is therefore caught by watching
  `mHP`, and the transition counts nothing.
- **A revive is not a heal.** Health going from exactly zero to positive returns a whole bar in
  one tick, and folded into healing it dwarfs every real cast on the table. Counted as a revive
  and kept out of the attribution — `src/features/guild/guild-trial-support.js`.
- **A trial ends, and the figures stop.** `end_guild_battle` is the honest signal, and
  `guild_updated.currentTrialsData` (a JSON _string_ carrying `status`, per-party `done` flags
  and `budgetRemainingMs` counting down from exactly 3,600,000) is the one that arrives whether
  or not the guild panel is open. Neither can be relied on to arrive at all, so a stream quiet
  for three minutes is treated as ended too. Toolasha's elapsed figure is accumulated from tick
  gaps rather than off the wall clock, so it never had the decaying-DPS bug this fixes upstream
  — but it is now frozen explicitly, and the stale-stream fallback and the `currentTrialsData`
  parse are both taken from here.

## What was not adopted

- **The DOM name scraping.** KikiMeter reads the trial roster out of `MiniUnit_name` elements
  with a slot-offset heuristic. Toolasha reads `new_guild_battle`'s own `players[]`, which it
  already had.
- **The panels.** KikiMeter is a floating meter window with its own recount, class detection and
  history. Toolasha's figures live in the game's own guild panel and in its existing rows.
- **Its `battle_updated` handling.** The two scripts separate personal combat from trial combat
  differently; Toolasha's spectator-liveness window predates this and was left alone.
