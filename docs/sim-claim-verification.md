# Verification status of inherited simulator claims

Four combat-engine behaviors were once reviewed and scored as "we already do this correctly". All four
scores came from **reading the code**, and a code reading is not a measurement: the Fury multiplier was
read as correct for a long time, and it took an in-game observer on the live wire to find that the game
pools Fury additively.

This file records, per claim, what its verification actually rests on, so that nobody re-reads the same
code and files the same score again. It is a status list, not an argument — the mechanisms themselves are
documented where they live.

Status vocabulary:

- **Settled from source** — the server's own implementation is on record; measuring would be weaker
  evidence, not stronger.
- **Instrumented** — an observer for it ships; what is missing is a sample, not a method.
- **Measurable** — the live stream carries what would decide it, and the how is written down below.
- **Not measurable** — the stream does not distinguish the two outcomes, and that is the finding.
- **Unverified** — none of the above. Reading the code again does not change this.

## 1. A stun runs its full length even when its caster dies first

Where: `src/features/combat-sim/engine/combat-simulator.js:1957` stores `isStunned` and `stunExpireTime`
on the **target**; nothing prunes either when the caster dies.

**Status: instrumented (stun only).** `src/features/combat/stun-persistence.js` and its observer measure
exactly this, in both directions, from the `isStunned` flag on each unit entry. The headline is the
fraction of qualifying episodes where `isStunned: true` is restated on a tick strictly after the caster's
death tick.

Limits worth restating here: the payload carries **one** crowd-control flag. There is no blind flag and no
silence flag anywhere on the wire, so the claim as originally written — stun, blind _and_ silence — is one
third measurable and two thirds **not measurable**. Nothing in the fork should quote the stun result as
covering the other two.

## 2. A player who died while stunned does not come back stunned when the dungeon clears

Where: the dungeon-completion branch of `startNewEncounter`,
`src/features/combat-sim/engine/combat-simulator.js:642`–`676`.

**Status: was false; fixed, and now pinned by tests.** The dispute recorded here was right. The branch
restored hitpoints and manapoints and re-armed buff expirations for a player who was down, and did not
touch crowd control. Dying sweeps every event naming the unit, `StunExpirationEvent` among them, and
nothing at death lowers `isStunned` — so a player stunned, killed and then stood up by the clear stayed
stunned with no event left that could ever lift it. The same held for blind and silence. It was not the
flag alone: a stuck stun or silence fails `shouldTrigger`, so that player never casts an ability or takes
a consumable again; a stuck blind sends `addNextAttackEvent` down its else branch, which queues nothing,
so that player stops attacking entirely for the rest of the run.

The branch now calls `clearCCStatuses()` for a player who `wasDown`, alongside the existing
`removeExpiredBuffs()` / `_rescheduleBuffExpirations()`. Only for one who was down: a player still standing
at the clear may be inside a stun that is behaving correctly, with its expiration event intact, and
cancelling that would be the opposite bug. Statuses only rather than `clearCCs()`, because that also zeroes
`damageTaken`, which is not a status but the curse buff's folded value — and this branch keeps buffs on
purpose, so zeroing it would leave the stat disagreeing with the buff behind it until the next
`updateCombatDetails` quietly restored it. `clearCCs()` is now that helper plus the `damageTaken` reset, so
the three revival paths that do want both are unchanged.

Covered by `crowd control does not survive a dungeon-clear revive` in `combat-simulator.test.js`: each of
the three statuses cleared with no stale expiry time, a still-standing player's running stun and its queued
expiration left alone, the curse amplification left alone, and — the assertion a flag check would have
missed — the revived player holding an `AutoAttackEvent` afterwards rather than merely reading as unblinded.

This entry no longer needs a live measurement to settle; the note below is kept for the record.

Measurable from the live stream: yes.

- Fields: `pMap[slot].cHP` reaching 0 while that entry last reported `isStunned: true`, then the same slot
  reported alive after the run completes.
- Discriminator: a later tick that contains the slot **with** `cHP > 0` and **without** `isStunned`. A slot
  missing from the map entirely means nothing changed and must not be read as "not stunned" — that
  distinction is already implemented in `stun-persistence.js` and would be reused.
- Observations: rare. It needs a player death while flagged in the final wave of a run that then clears,
  which is a wipe-adjacent situation that usually ends the run instead.
- Falsifier: the revived player reported with `isStunned: true` after the completion.

**Would the shipped stun observer answer it as a by-product? No — it currently throws this evidence away
on purpose.** `createStunWatch().newBattle` truncates every running episode and `judgeEpisode` files it as
`waveEnded`, because an episode cut off by a wave boundary cannot be told from a stun that ended. Answering
this claim needs the opposite branch: retain an episode whose subject died while flagged, and judge it
against the first tick that reports that subject alive again.

## 3. A wave cleared by the same swing that kills the last player restarts the dungeon

Where: `checkEncounterEnd`, `src/features/combat-sim/engine/combat-simulator.js:1035` reads
`allPlayersDown` before the branches, and `:1060` routes the both-at-once case to the wipe branch so that
the two do not both do their accounting.

**Status: measurable, not measured.**

- Fields: a `battle_updated` in which every `mMap` entry is at `cHP: 0` and every `pMap` entry is at
  `cHP: 0`, followed by the next `new_battle` and its `wave`.
- Discriminator: the wave number. A restart opens at the first wave; a continuation opens at the wave after
  the one that just cleared. The time to that `new_battle` is a second, weaker signal — a stall would show
  up as no `new_battle` for far longer than the respawn interval.
- Observations: single digits, realistically. It needs a simultaneous clear and wipe, which in practice
  means thorns or retaliation killing the last monster on the blow that kills the last player, in a dungeon
  being run at the edge of survivability.
- Falsifier: the run continuing from the next wave, or no `new_battle` at all.

By-product of an existing observer? Not of the stun observer, which watches flags rather than rosters.
`src/features/combat/wave-gap.js` is much closer: its watch already tracks every monster reaching zero, the
wave number on each `new_battle`, and counts a wipe as its own discard. What it lacks is the player side of
the same tick, which is the one thing this claim turns on.

## 4. The party level-gap penalty

Where: `levelGapDebuff` in `src/utils/dungeon-level-gap.js:78` — `max(1.2, (level + 10) / level)` as an effective threshold,
compared strictly, with a slope of three and the multiplier floored at a tenth.

**Status: settled from source. Do not propose measuring it.** The file header quotes the server-side Go
implementation, supplied directly by the MWI developer, and the code is that formula rewritten as a debuff
rather than a multiplier. A sampled measurement of drop rates would be a noisier estimate of something the
source already states exactly.

Two things that remain open, and neither is a measurement of the formula:

- The quoted source is a snapshot. If the server changes it, nothing here will notice.
- It reads the **raw, unfloored** combat level, not the integer the client is sent. Anything calling it
  with the displayed level computes the wrong threshold — that is a caller-side correctness question.

The file is also explicit that the chest line is a separate, unmeasured mechanic, and that stays true.

## 5. The four repeating-effect tick intervals

Where: `src/features/combat-sim/engine/combat-simulator.js:122`–`126` — `HOT_TICK_INTERVAL = 5 s`,
`DOT_TICK_INTERVAL = 3 s`, `REGEN_TICK_INTERVAL = 10 s`, and the enrage ramp at 60 s. All four arrived with
the engine and none of them was ever checked here. The observer for them is
`src/features/combat/tick-period.js` and `tick-period-observer.js`, behind the `tickPeriodWatch` setting.

**Hitpoint and mana regeneration, 10 s — measured, and consistent.** 289 clean intervals off the live
stream, median 10,000 ms. The signature is a simultaneous rise in `cHP` and `cMP` on a unit whose own
`dmgCounter` and `atkCounter` did not move, which nothing else on the wire produces.

**Damage over time, 3 s — not measurable, and that is the finding.** A damage-over-time tick is a health
fall with no positive signature of its own, so the whole question was whether the server counts it in the
target's `dmgCounter` the way it counts a swing. A run made to answer it — a fire mage, damage over time
landing throughout — gave **539 health falls, all 539 attributed to a `dmgCounter` move and none
unattributed**. A tick therefore raises the damage counter exactly as a hit does, the stream carries no
discriminator between the two, and no sample of any size can separate them. The panel states this as a
settled result rather than as a row waiting for data, and the attributed/unattributed counts stay on screen
because they are the evidence. Do not propose measuring this one again without a new field on the wire.

**Food and drink recovery, 5 s — instrumented, after the first attempt measured the wrong quantity.** The
constant is the rate an _already-running_ recovery ticks at. The first version timed gaps between
consecutive health rises on a quiet unit, which is the gap between separate **eats**: consumables fire on
missing-HP and missing-MP triggers, so that quantity is set by when the player happens to need food and
runs to minutes (a live sample read 8 s, 142 s, 25 s, 42 s, 10 s, 10 s, 68 s, 10 s, 55 s, 125 s, 60 s).
No amount of extra sample fixes a quantity that is the wrong quantity. An interval now counts only when the
**same recovery effect instance** — unique hrid plus the server's `startTime` for it, read from the unit's
`combatBuffMap` — was on the unit at both ends, so a fresh meal never chains onto the last tick of the one
before it, while a tick missed because it had nothing to add still shows as a clean 2x echo. Instances are
matched on what the wire names them, not on an engine-side name: the engine calls this a consumable tick,
which the server never sends, and Fury is the standing warning that a type name invented here need not
exist there. Intervals dropped for a lapse are counted under their own discard reason, so the sample can
shrink to nothing and say why rather than quietly shrinking. The 48 intervals collected before the gate are
discarded on load by a storage version bump; regeneration's rows are kept, because the gate was never about
them and they are the one constant this tool has confirmed.

**And a party cannot measure it at all.** A cast names only its _caster_, so a heal landing on somebody else
leaves no mark on the unit that gained the health, and the only safe response to a tick naming any ability
is to void every recovery on it. A live reading in a five-player party shows exactly that: 334 candidates
discarded under "something named an ability on that tick" and climbing, with **nothing reaching the
continuity gate behind it**. In a group nearly every tick names somebody's cast, so the row cannot fill
whatever else is true, and the panel says so where the row would be rather than leaving a blank that reads
as a broken tool. This one is **still open** — it is not measured, and it is not settled-unmeasurable the
way damage over time is. Whether a solo stream can measure it is untested: a separate look at one player's
`combatBuffMap` over 54 s found no recovery entry at all, only permanent passives (`duration: 0`), 250 s
drinks and short ability buffs, which is suggestive and no more — that player was near full health
throughout, and the map only arrives on a `new_battle` snapshot. Measuring it means fighting solo, hurt,
with the setting on.

**Enrage ramp, 60 s — instrumented, not yet sampled.** One observation a minute at best, off a monster's
enrage entry restating a larger boost in its `combatBuffMap`.

## 6. A blinded unit stops attacking entirely

Where: the blind branch at the tail of `addNextAttackEvent`,
`src/features/combat-sim/engine/combat-simulator.js`. A blinded unit falls out of the function with no
`AutoAttackEvent` queued, so it swings again only when `processBlindExpirationEvent` lifts the flag.

**Status: unverified.** This arrived with the engine and has never been checked against the game. The two
candidate behaviors are "a blinded unit does not swing" and "a blinded unit swings and misses", and they
differ by the whole of that unit's damage for the blind's duration — a much larger error than any
bookkeeping around it. Reading the branch again does not settle it, and nothing in the fork should quote
it as settled.

What was fixed here is a separate and smaller thing: the branch used to also set `isOutOfMana`, which is
the fork's own bookkeeping for a unit parked waiting on mana. That flag gates the three
mana-restoration wakes and feeds `timeOutOfManaSeconds` / `manaExhaustionFraction`, which the food
optimizer reads, so a merely blinded unit reported as mana-starved. Blindness no longer touches it. That
correction stands whichever way the attack question resolves, and the tests assert only the flag — never
that the blinded unit queues nothing.

Measurable from the live stream: plausibly, and it is the only blind in the game to measure.

- Source: Nature's Veil, 0.5 chance, 5 s, carried by Dryad, Enchanted Bishop, Jackalope, Luna Empress,
  Squawker, Trial Hedgehog and Zombie.
- Fields: the victim's `atkCounter` across the blind window. The payload carries no blind flag (see the
  limits under claim 1), so the window has to be pinned from the caster's side — the tick the ability
  lands — rather than read off the victim.
- Discriminator: `atkCounter` rising during the window means the game keeps swinging and the engine
  understates blinded damage. A flat counter for the full 5 s, on a unit whose attack interval is
  comfortably shorter than that, means the engine is right.
- Falsifier for the engine's current behavior: any `atkCounter` move inside a confirmed window.
