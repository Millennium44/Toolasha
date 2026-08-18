/**
 * Zone uptime / cadence harness
 *
 * The zone edition of the labyrinth uptime harness: decompose the *incoming*
 * damage of a recorded zone session per monster and per ability, and put it
 * beside the same decomposition read out of the sim the Sim Accuracy check
 * already ran. The comparison logic — shares, means, verdicts — is imported
 * from the lab harness unchanged; what this module owns is the extraction,
 * because a zone wave has several monsters where the lab has one:
 *
 *   - **Swing detection stays exact per monster.** Every present `mMap` entry
 *     carries its own `atkCounter`, so cast counts per (monster, ability) come
 *     off the counters exactly, however many monsters swing at once.
 *   - **Payoff attribution is a single shared stream.** The player has one
 *     `dmgCounter`. Swings from all monsters join one FIFO queue in
 *     observation order and each counter rise pays off the oldest. Two swings
 *     in the same 3 Hz tick enqueue in payload-key order, which can coarsen
 *     *which monster* a given damage amount lands under — never the cast
 *     counts, which are per-monster by construction.
 *   - **DoT is a wave-level row.** A counter rise with an empty queue is a
 *     damage-over-time tick, but nothing in the feed says whose bleed it was —
 *     so the real side keeps ONE `dot` aggregate for the wave, compared
 *     against the sim's `damageOverTime` entries summed over the same
 *     monsters, rather than pretending to a per-monster split it cannot see.
 *
 * Everything here is pure and node-testable; the debug entry point that feeds
 * it a recorder session and a retained sim result lives in the combat library.
 */

import { compareIncoming, summarizeSimAttacks, MIN_REAL_CASTS } from './labyrinth-uptime-harness.js';

/** The pseudo-ability both sides file damage-over-time under. */
const DOT_ABILITY = 'damageOverTime';

/**
 * A field of a `new_battle` unit, wherever this payload put it. Full unit
 * snapshots have carried these inside `combatDetails` and at the top level in
 * different payload versions; the recorder keeps whatever arrived, so read
 * both — the same both-places read `seedWave` uses for hitpoints.
 * @param {Object} unit
 * @param {string} name
 * @returns {*}
 */
function unitField(unit, name) {
    return unit?.combatDetails?.[name] ?? unit?.[name];
}

/** The units of an array-or-map `new_battle` collection, with their indices. */
function unitEntries(units) {
    if (Array.isArray(units)) return units.map((unit, index) => [String(index), unit]);
    return Object.entries(units || {});
}

/**
 * Map every monster of a wave to the abilities that deal no damage — the
 * per-hrid generalisation of the lab's `nonDamagingAbilities`. A buff still
 * takes a turn (a cast), but it lands no hit: queueing one would let the next
 * real swing's damage pay off the buff's slot.
 *
 * @param {Object} gameData - `{combatMonsterDetailMap, abilityDetailMap}`
 * @param {Iterable<string>} monsterHrids
 * @returns {Map<string, Set<string>>} Monster hrid → non-damaging ability hrids
 */
export function nonDamagingByHrid(gameData, monsterHrids) {
    const abilityMap = gameData?.abilityDetailMap || {};
    const byHrid = new Map();
    for (const monsterHrid of monsterHrids || []) {
        const set = new Set();
        const monster = gameData?.combatMonsterDetailMap?.[monsterHrid];
        for (const entry of monster?.abilities || []) {
            const hrid = entry?.abilityHrid;
            const def = hrid && abilityMap[hrid];
            if (!def) continue;
            const dealsDamage = (def.abilityEffects || []).some((e) => e.effectType === '/ability_effect_types/damage');
            if (!dealsDamage) set.add(hrid);
        }
        byHrid.set(monsterHrid, set);
    }
    return byHrid;
}

/**
 * The monster hrids a segment's `new_battle` messages name — the cheap
 * pre-pass that lets a caller build the non-damaging map before extracting.
 * @param {Array<Object>} ticks
 * @returns {Set<string>}
 */
export function waveHridsOf(ticks) {
    const hrids = new Set();
    for (const tick of ticks || []) {
        if (tick?.type !== 'new_battle') continue;
        for (const [, unit] of unitEntries(tick?.payload?.monsters)) {
            if (unit?.hrid) hrids.add(unit.hrid);
        }
    }
    return hrids;
}

/** A fresh per-ability record. */
function newRecord() {
    return { casts: 0, hits: 0, misses: 0, damage: 0, samples: [] };
}

/** Merge `from` into the per-ability record `into`, summing counts and concatenating samples. */
function mergeRecord(into, from) {
    into.casts += from.casts || 0;
    into.hits += from.hits || 0;
    into.misses += from.misses || 0;
    into.damage += from.damage || 0;
    if (from.samples?.length) into.samples.push(...from.samples);
}

/**
 * One segment's ticks → the wave's incoming decomposition, per monster hrid.
 *
 * ## Requirements, stated rather than guessed around
 *
 * The extraction runs on counters only: `atkCounter` on the monsters names and
 * counts every swing, `dmgCounter` on the player marks every resolution. The
 * lab's health-drop fallback is NOT ported — with several monsters in the
 * wave, which one's ability caused a health drop is exactly the guess the
 * counter ladder exists to avoid — so a recording without counters returns
 * `{usable: false}` with the reason named instead of an honest-looking table.
 *
 * ## Attempts
 *
 * Every `new_battle` opens a fresh attempt and seeds all baselines from its
 * full unit snapshots (counters, health, what each side is preparing), so the
 * first compact tick is measured against the wave's true start — the opening
 * swing counted, not silently swallowed as a baseline. Ticks before the first
 * `new_battle` are a fight already in progress when the segment began: kept as
 * a partial attempt, excluded from the aggregate. The aggregate covers
 * complete attempts only.
 *
 * @param {Array<Object>} ticks - One segment's ticks (recorder shape:
 *   `{at, type, payload}` with `battle_updated` and `new_battle`)
 * @param {Object} [opts] - `{nonDamaging}`: a Map from {@link nonDamagingByHrid}
 * @returns {Object} `{usable, reason?, durationMs, fights, partialFights,
 *   captureStartedMidFight, partySize, waveHrids, byMonster, dot, attempts}`
 *   where `byMonster[hrid] = {fights, byAbility}` in the lab's byAbility shape
 */
export function extractWaveIncoming(ticks, opts = {}) {
    const nonDamaging = opts.nonDamaging instanceof Map ? opts.nonDamaging : new Map();

    const hasAtkCounters = (ticks || []).some(
        (t) =>
            t?.type !== 'new_battle' &&
            Object.values(t?.payload?.mMap || {}).some((m) => Number.isFinite(Number(m?.atkCounter)))
    );
    const hasDmgCounter = (ticks || []).some(
        (t) =>
            t?.type !== 'new_battle' &&
            Object.values(t?.payload?.pMap || {}).some((p) => Number.isFinite(Number(p?.dmgCounter)))
    );
    if (!hasAtkCounters || !hasDmgCounter) {
        return { usable: false, reason: 'no attack counters (old recording)' };
    }

    let firstAt;
    let lastAt;
    let partySize = 1;

    // Per-monster-index running state for the current attempt. Compact mMap
    // ticks are deltas — an index absent from a tick is a monster with nothing
    // to report, NOT a gap — so state persists across ticks and resets only at
    // a battle boundary.
    let monsterStates = new Map(); // index -> {hrid, prevAtk, prevLabel}
    let playerIndex = '0';
    let prevPHP;
    let prevPdmg;
    // Swings from every monster awaiting their resolution, oldest first.
    const pending = [];

    const attempts = [];
    let current = null;

    const resetBaselines = () => {
        monsterStates = new Map();
        prevPHP = undefined;
        prevPdmg = undefined;
        pending.length = 0;
    };

    const rec = (byAbility, ability) => (byAbility[ability] = byAbility[ability] || newRecord());

    const closeAttempt = () => {
        if (!current) return;
        const monsterHPs = Object.values(current.lastMHPs);
        current.outcome =
            current.lastPHP === 0
                ? 'loss'
                : monsterHPs.length && monsterHPs.every((hp) => hp === 0)
                  ? 'win'
                  : 'unknown';
        attempts.push(current);
        current = null;
    };

    const openAttempt = (complete, at) => {
        closeAttempt();
        current = {
            complete,
            startAt: at ?? null,
            endAt: at ?? null,
            lastPHP: null,
            lastMHPs: {},
            sawAttack: false,
            waveHrids: new Set(),
            byMonster: {}, // hrid -> byAbility
            dot: newRecord(),
        };
    };

    for (const tick of ticks || []) {
        const at = tick?.at;
        if (firstAt === undefined && Number.isFinite(at)) firstAt = at;
        if (Number.isFinite(at)) lastAt = at;

        if (tick?.type === 'new_battle') {
            openAttempt(true, at);
            resetBaselines();
            const players = unitEntries(tick?.payload?.players);
            partySize = Math.max(partySize, players.length);
            if (players.length) {
                const [index, unit] = players[0];
                playerIndex = index;
                const pdmg = Number(unitField(unit, 'damageSplatCounter') ?? unitField(unit, 'dmgCounter'));
                if (Number.isFinite(pdmg)) prevPdmg = pdmg;
                const php = Number(unitField(unit, 'currentHitpoints'));
                if (Number.isFinite(php)) {
                    prevPHP = php;
                    current.lastPHP = php;
                }
            }
            for (const [index, unit] of unitEntries(tick?.payload?.monsters)) {
                const hrid = unit?.hrid || null;
                const state = { hrid, prevAtk: undefined, prevLabel: undefined };
                const atk = Number(unitField(unit, 'attackAttemptCounter') ?? unitField(unit, 'atkCounter'));
                if (Number.isFinite(atk)) state.prevAtk = atk;
                const preparing = unitField(unit, 'preparingAbilityHrid');
                if (preparing) state.prevLabel = preparing;
                else if (unitField(unit, 'isPreparingAutoAttack')) state.prevLabel = 'autoAttack';
                monsterStates.set(index, state);
                if (hrid) current.waveHrids.add(hrid);
                const mhp = Number(unitField(unit, 'currentHitpoints'));
                if (Number.isFinite(mhp)) current.lastMHPs[index] = mhp;
            }
            continue;
        }

        const mMap = tick?.payload?.mMap;
        const pMap = tick?.payload?.pMap;
        if (!mMap && !pMap) continue;

        // Compact ticks before any `new_battle`: a fight already in progress
        // when the segment began. Tracked as a partial attempt — never
        // aggregated, because its monsters cannot even be named.
        if (!current) openAttempt(false, at);
        if (Number.isFinite(at)) current.endAt = at;

        const pKeys = Object.keys(pMap || {});
        if (pKeys.length > 1) partySize = Math.max(partySize, pKeys.length);

        // Monsters first, in payload-key order: their swings must be in the
        // queue before this tick's resolutions pay anything off.
        for (const [index, monster] of Object.entries(mMap || {})) {
            if (!monster) continue;
            let state = monsterStates.get(index);
            if (!state) {
                // No snapshot named this index (a partial attempt, or a payload
                // shape surprise): track it unnamed so counters stay coherent.
                state = { hrid: null, prevAtk: undefined, prevLabel: undefined };
                monsterStates.set(index, state);
            }
            const matk = Number(monster.atkCounter);
            if (Number.isFinite(Number(monster.cHP))) current.lastMHPs[index] = Number(monster.cHP);

            if (state.prevAtk !== undefined && Number.isFinite(matk) && matk > state.prevAtk) {
                const label = state.prevLabel || monster.abilityHrid || 'autoAttack';
                const dealsDamage = !(state.hrid && nonDamaging.get(state.hrid)?.has(label));
                const byAbility = state.hrid
                    ? (current.byMonster[state.hrid] = current.byMonster[state.hrid] || {})
                    : null;
                for (let n = 0; n < matk - state.prevAtk; n++) {
                    if (byAbility) rec(byAbility, label).casts += 1;
                    // A buff takes a turn but lands no hit, so it never joins
                    // the queue the next resolution pays off.
                    if (dealsDamage) pending.push({ hrid: state.hrid, label });
                }
                current.sawAttack = true;
            }
            if (Number.isFinite(matk)) state.prevAtk = matk;
            // What this monster is doing this tick, so its NEXT swing is
            // labelled by it. The payload names a special in abilityHrid only
            // on its cast tick and marks ordinary swings with isAutoAtk — so an
            // auto-attack tick must reset the label to autoAttack, or the last
            // special sticks to every following auto and inflates its share
            // past what the cooldown physically allows.
            if (monster.abilityHrid) state.prevLabel = monster.abilityHrid;
            else if (monster.isAutoAtk) state.prevLabel = 'autoAttack';
        }

        // Then the player: each dmgCounter rise pays off the oldest pending
        // swing; a rise with nothing waiting is a damage-over-time tick.
        const player = pMap?.[playerIndex] ?? (pKeys.length === 1 ? pMap[pKeys[0]] : undefined);
        if (player) {
            const php = Number.isFinite(Number(player.cHP)) ? Number(player.cHP) : null;
            const pdmg = Number.isFinite(Number(player.dmgCounter)) ? Number(player.dmgCounter) : null;
            if (php != null) current.lastPHP = php;

            if (prevPdmg !== undefined && pdmg !== null && pdmg > prevPdmg) {
                const count = pdmg - prevPdmg;
                const drop = prevPHP != null && php != null ? Math.max(0, prevPHP - php) : 0;
                const per = count > 0 ? drop / count : 0; // even split across a merged tick
                for (let n = 0; n < count; n++) {
                    const swing = pending.length ? pending.shift() : null;
                    const target = swing?.hrid
                        ? rec((current.byMonster[swing.hrid] = current.byMonster[swing.hrid] || {}), swing.label)
                        : swing
                          ? null // an unnamed monster's swing: counted nowhere rather than somewhere wrong
                          : current.dot;
                    if (!target) continue;
                    if (per > 0) {
                        target.hits += 1;
                        target.damage += per;
                        target.samples.push(per);
                    } else {
                        target.misses += 1;
                    }
                }
                current.sawAttack = true;
            }
            if (php != null) prevPHP = php;
            if (pdmg != null) prevPdmg = pdmg;
        }
    }

    closeAttempt();

    // The aggregate the comparison runs on: complete attempts only.
    const complete = attempts.filter((attempt) => attempt.complete && attempt.sawAttack);
    const byMonster = {};
    const dot = newRecord();
    const waveHrids = new Set();
    for (const attempt of complete) {
        for (const hrid of attempt.waveHrids) waveHrids.add(hrid);
        for (const [hrid, abilities] of Object.entries(attempt.byMonster)) {
            const target = (byMonster[hrid] = byMonster[hrid] || { fights: 0, byAbility: {} });
            for (const [ability, record] of Object.entries(abilities)) {
                mergeRecord(rec(target.byAbility, ability), record);
            }
        }
        mergeRecord(dot, attempt.dot);
    }
    // A monster's fight count: complete attempts whose wave contained it —
    // fought-and-never-hit is a denominator fact, not a missing row.
    for (const attempt of complete) {
        for (const hrid of attempt.waveHrids) {
            if (byMonster[hrid]) byMonster[hrid].fights += 1;
        }
    }

    return {
        usable: true,
        durationMs: (lastAt ?? 0) - (firstAt ?? 0),
        fights: complete.length,
        partialFights: attempts.filter((attempt) => !attempt.complete && attempt.sawAttack).length,
        captureStartedMidFight: attempts.length > 0 && !attempts[0].complete,
        partySize,
        waveHrids: [...waveHrids],
        byMonster,
        dot,
        attempts,
    };
}

/**
 * Merge several segments' extractions into one aggregate.
 *
 * Segments are extracted independently — each banked segment restarts its `at`
 * clock and opens with its own boundary `new_battle`, so raw ticks must never
 * be concatenated — and their aggregates sum here.
 *
 * @param {Array<Object>} parts - From {@link extractWaveIncoming}
 * @returns {Object} The same shape; `{usable: false}` when no part was usable
 */
export function mergeWaveIncoming(parts) {
    const usable = (parts || []).filter((part) => part?.usable);
    if (!usable.length) {
        return { usable: false, reason: (parts || []).find((p) => p?.reason)?.reason || 'no usable segments' };
    }
    const out = {
        usable: true,
        durationMs: 0,
        fights: 0,
        partialFights: 0,
        captureStartedMidFight: false,
        partySize: 1,
        waveHrids: [],
        byMonster: {},
        dot: newRecord(),
        attempts: [],
    };
    const hrids = new Set();
    for (const part of usable) {
        out.durationMs += part.durationMs || 0;
        out.fights += part.fights || 0;
        out.partialFights += part.partialFights || 0;
        out.captureStartedMidFight = out.captureStartedMidFight || Boolean(part.captureStartedMidFight);
        out.partySize = Math.max(out.partySize, part.partySize || 1);
        for (const hrid of part.waveHrids || []) hrids.add(hrid);
        for (const [hrid, entry] of Object.entries(part.byMonster || {})) {
            const target = (out.byMonster[hrid] = out.byMonster[hrid] || { fights: 0, byAbility: {} });
            target.fights += entry.fights || 0;
            for (const [ability, record] of Object.entries(entry.byAbility || {})) {
                mergeRecord((target.byAbility[ability] = target.byAbility[ability] || newRecord()), record);
            }
        }
        mergeRecord(out.dot, part.dot || newRecord());
        out.attempts.push(...(part.attempts || []));
    }
    out.waveHrids = [...hrids];
    return out;
}

/**
 * Assemble the per-monster comparisons against a sim result.
 *
 * One section per monster hrid **seen in the real recording**, each compared
 * with the lab's `compareIncoming` unchanged — within-monster shares sidestep
 * wave-mix sampling differences entirely (the sim draws its own encounters,
 * boss included; a short real sample may never see the boss). Monsters only
 * the sim produced are listed in `simOnlyHrids` as a footnote, never graded
 * `sim-extra`. The sim's per-monster `damageOverTime` entries are pulled out
 * of the sections and summed into the wave-level DoT row, matching what the
 * real side can actually attribute.
 *
 * @param {Object} real - From {@link mergeWaveIncoming}
 * @param {Object} simResult - A `SimResult`-shaped object with `attacks`
 * @param {string} [playerHrid='player1'] - The sim's key for the player
 * @param {number} [tolerancePct=15] - Share gap beyond which a row is flagged
 * @returns {{sections: Array<Object>, dotRow: Object|null, simOnlyHrids: string[]}}
 */
export function compareZoneIncoming(real, simResult, playerHrid = 'player1', tolerancePct = 15) {
    const attacks = simResult?.attacks || {};
    const realHrids = Object.keys(real?.byMonster || {});
    const realSet = new Set(realHrids);

    let simDot = null;
    const sections = [];
    for (const hrid of realHrids) {
        const sim = summarizeSimAttacks(attacks[hrid]?.[playerHrid]);
        if (sim.byAbility[DOT_ABILITY]) {
            simDot = simDot || newRecord();
            mergeRecord(simDot, { ...sim.byAbility[DOT_ABILITY], samples: [] });
            delete sim.byAbility[DOT_ABILITY];
        }
        const entry = real.byMonster[hrid];
        const comparison = compareIncoming({ byAbility: entry.byAbility }, sim, tolerancePct);
        sections.push({ monsterHrid: hrid, fights: entry.fights, ...comparison });
    }
    sections.sort((a, b) => (b.realTotals?.damage ?? 0) - (a.realTotals?.damage ?? 0));

    // The wave-level DoT row: real ticks nobody's queue claimed vs the sim's
    // DoT summed over the same monsters. Means are per tick on both sides
    // (each 3 s sim DamageOverTimeEvent tick is one entry); shares are of the
    // wave's whole incoming damage.
    let dotRow = null;
    const realDot = real?.dot;
    if ((realDot && realDot.hits + realDot.misses > 0) || simDot) {
        const realWaveDamage =
            realHrids.reduce(
                (sum, hrid) =>
                    sum +
                    Object.values(real.byMonster[hrid].byAbility).reduce((s, record) => s + (record.damage || 0), 0),
                0
            ) + (realDot?.damage || 0);
        const simWaveDamage =
            realHrids.reduce(
                (sum, hrid) =>
                    sum +
                    Object.values(summarizeSimAttacks(attacks[hrid]?.[playerHrid]).byAbility).reduce(
                        (s, record) => s + (record.damage || 0),
                        0
                    ),
                0
            ) || 0;
        const side = (record, waveDamage) => {
            if (!record) return null;
            const ticks = (record.hits || 0) + (record.misses || 0);
            return {
                ticks,
                damage: Math.round(record.damage || 0),
                dmgSharePct: waveDamage ? (100 * (record.damage || 0)) / waveDamage : 0,
                meanPerTick: ticks ? (record.damage || 0) / ticks : 0,
            };
        };
        const r = side(realDot && realDot.hits + realDot.misses > 0 ? realDot : null, realWaveDamage);
        const s = side(simDot, simWaveDamage);
        const dmgShareGap = (s?.dmgSharePct ?? 0) - (r?.dmgSharePct ?? 0);
        const meanGapPct = r && s && r.meanPerTick > 0 ? (100 * (s.meanPerTick - r.meanPerTick)) / r.meanPerTick : null;
        let verdict = 'ok';
        if (!s) verdict = 'sim-missing';
        else if (!r) verdict = 'sim-extra';
        else if (r.ticks < MIN_REAL_CASTS) verdict = 'inconclusive';
        else if (Math.abs(dmgShareGap) >= tolerancePct) verdict = dmgShareGap < 0 ? 'sim-under' : 'sim-over';
        dotRow = { ability: DOT_ABILITY, real: r, sim: s, dmgShareGap, meanGapPct, verdict };
    }

    const simOnlyHrids = Object.keys(attacks).filter(
        (hrid) => !realSet.has(hrid) && Object.keys(attacks[hrid]?.[playerHrid] || {}).length > 0
    );

    return { sections, dotRow, simOnlyHrids };
}

/**
 * What a loadout snapshot has to agree on to count as the same kit. When it
 * was taken is not part of it: two segments of one recording are taken minutes
 * apart and are the same build.
 * @param {Object|null} snapshot
 * @returns {string}
 */
function snapshotSignature(snapshot) {
    if (!snapshot) return 'none';
    const { capturedAt: _ignored, ...fields } = snapshot;
    return JSON.stringify(fields);
}

/**
 * Why this recording cannot be decomposed against this sim — the refusal that
 * names what differs instead of producing a confident wrong table. Empty means
 * usable. The pattern of the stat check's `captureContextMismatches`; the
 * fields are the zone edition's.
 *
 * @param {Object} real - From {@link mergeWaveIncoming}
 * @param {Object} context - `{zoneHrid, gameData, segmentLoadouts}`
 * @returns {string[]} Mismatch codes: 'party', 'zone', 'wave', 'build'
 */
export function zoneUptimeMismatches(real, { zoneHrid, gameData, segmentLoadouts } = {}) {
    const mismatches = [];
    if ((real?.partySize || 1) > 1) mismatches.push('party');
    if (!zoneHrid) mismatches.push('zone');

    // A recorded monster foreign to the zone's spawn table means the recording
    // and the sim are not describing the same place. Only judged when the
    // zone's spawn table is actually on hand — an absent table (a dungeon, or
    // missing game data) proves nothing either way.
    const fightInfo = gameData?.actionDetailMap?.[zoneHrid]?.combatZoneInfo?.fightInfo;
    const spawns = [...(fightInfo?.randomSpawnInfo?.spawns || []), ...(fightInfo?.bossSpawns || [])];
    if (zoneHrid && spawns.length) {
        const known = new Set(spawns.map((spawn) => spawn.combatMonsterHrid).filter(Boolean));
        if ((real?.waveHrids || []).some((hrid) => !known.has(hrid))) mismatches.push('wave');
    }

    // Mixed builds across segments would average two different characters into
    // one table and compare it against a sim of a third.
    const signatures = new Set((segmentLoadouts || []).map(snapshotSignature));
    if (signatures.size > 1) mismatches.push('build');

    return mismatches;
}
