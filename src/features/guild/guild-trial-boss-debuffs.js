/**
 * Debuff timers on a guild trial's bosses, from the spectator stream.
 *
 * `guild_battle_updated` carries no `combatBuffMap` (0 of 309,553 player entries
 * and none on a boss in the 2026-09-07 trace), so nothing on the wire says which
 * effects a boss is carrying. Two things can still be said honestly:
 *
 * - **A debuff that was seen to land.** A player's attack counter rises while
 *   they were preparing an ability whose game data puts buffs on its enemy
 *   target (`utils/ability-effects.js`), on a tick where a boss's own hit counter
 *   rose. The timer runs for that buff's own `duration` in the ability data, not
 *   a hand-kept table, and a recast refreshes it. A miss starts nothing. Which
 *   boss a single-target cast struck is not stated, so a tick that hit two of
 *   them marks both.
 * - **A stun, which the stream states.** A boss entry carries `isStunned: true`
 *   on every tick it is stunned and omits it once it is not: 127 stuns on that
 *   trace, every one opening on a tick an Entangle landed, lasting a median
 *   2.0 s. The countdown is the landing ability's `stunDuration`; the chip goes
 *   when the stream says the stun is over.
 *
 * Silence and blind are chance-based and nothing on the stream states them, so
 * they are not drawn.
 *
 * Per wave: the slots and the monsters in them are re-dealt, so the caller drops
 * this state at every wave boundary, and a boss that dies or is replaced in its
 * slot sheds what it carried.
 *
 * Boss debuff timers in trials are KikiMeter v3.40.6's idea (ZhuLiMoon, MIT); it
 * starts hand-coded durations on sight of a cast. See `third-party/kikimeter/`.
 */

import dataManager from '../../core/data-manager.js';
import { abilityEffects, effectLabel, hridSlug } from '../../utils/ability-effects.js';

/** The key a stun is held under, beside the ability hrids debuffs are held under */
export const STUN_KEY = 'stun';

/**
 * How long past its countdown a stun the stream still states is kept.
 *
 * The stun is over when the stream says so, not when the countdown does; this
 * only bounds a stun whose ending never arrives because the boss stopped being
 * sent. The trace's longest stun ran 4.0 s against a 2 s countdown.
 */
export const STUN_GRACE_MS = 3000;

/** How long a stun with no known duration may stand without the stream restating it */
export const STUN_UNTIMED_MS = 5000;

/** The engine's time unit */
const NANOSECONDS_PER_SECOND = 1e9;

/** Ability map → hrid → profile, so a cast is looked up once per client data */
const profiles = new WeakMap();

/**
 * Seconds from a nanosecond duration.
 * @param {*} duration - A game-data duration
 * @returns {number|null} Seconds, or null when none is stated
 */
function seconds(duration) {
    const value = Number(duration) / NANOSECONDS_PER_SECOND;
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * What one cast of an ability can leave on its enemy, as the game data says.
 *
 * @param {string} abilityHrid - The prepared action, e.g. `/abilities/ice_spear`
 * @param {Object} [abilityDetailMap] - Game data; the live copy by default
 * @returns {{abilityHrid: string, slug: string, name: string, debuffSeconds: number|null,
 *   stunSeconds: number|null}|null} Null for anything that leaves nothing, or with no game data
 */
export function debuffProfile(abilityHrid, abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap) {
    if (!abilityDetailMap || typeof abilityHrid !== 'string' || !abilityHrid.startsWith('/abilities/')) return null;

    let byHrid = profiles.get(abilityDetailMap);
    if (!byHrid) {
        byHrid = new Map();
        profiles.set(abilityDetailMap, byHrid);
    }
    if (byHrid.has(abilityHrid)) return byHrid.get(abilityHrid);

    const detail = abilityDetailMap[abilityHrid];
    const debuffs = abilityEffects(abilityHrid, abilityDetailMap)?.enemyDebuffs || [];
    const debuffSeconds = Math.max(0, ...debuffs.map((effect) => effect.durationSeconds || 0)) || null;
    const stunSeconds =
        Math.max(0, ...(detail?.abilityEffects || []).map((effect) => seconds(effect?.stunDuration) || 0)) || null;

    const slug = hridSlug(abilityHrid);
    const profile =
        debuffSeconds || stunSeconds
            ? { abilityHrid, slug, name: detail?.name || slug.replace(/_/g, ' '), debuffSeconds, stunSeconds }
            : null;
    byHrid.set(abilityHrid, profile);
    return profile;
}

/**
 * A fresh state.
 * @returns {{monsters: Object<string, Object<string, Object>>}} Boss slot → key → effect
 */
export function newBossDebuffState() {
    return { monsters: {} };
}

/**
 * Fold one tick into the boss debuff state.
 *
 * Must run before the attribution engine reads the same tick: it compares the
 * tick's counters against the engine's held baselines (`playersAtk`,
 * `dmgCounter`, `monstersMaxHP`) and reads the actions prepared before it.
 *
 * @param {Object} debuffs - From {@link newBossDebuffState}, mutated
 * @param {Object} tick - The tick
 * @param {Object} tick.pMap - Its players
 * @param {Object} tick.mMap - Its monsters
 * @param {Object} tick.attribution - The attribution engine's state, not yet moved by this tick
 * @param {number} tick.now - Clock
 * @param {Object} [tick.abilityDetailMap] - Game data; the live copy by default
 */
export function noteBossDebuffTick(debuffs, { pMap, mMap, attribution, now, abilityDetailMap }) {
    const monsters = debuffs.monsters;
    const hit = [];
    const alive = new Set();

    for (const [slot, unit] of Object.entries(mMap || {})) {
        const health = Number(unit?.cHP);
        const max = Number(unit?.mHP);
        const heldMax = attribution?.monstersMaxHP?.[slot];
        // A corpse, or a different monster in the slot, carries nothing over
        if (
            (Number.isFinite(health) && health <= 0) ||
            (Number.isFinite(max) && heldMax !== undefined && max !== heldMax)
        ) {
            delete monsters[slot];
            continue;
        }
        alive.add(slot);
        const before = attribution?.dmgCounter?.[slot];
        if (before !== undefined && Number(unit?.dmgCounter) > before) hit.push(slot);
    }

    const landed = [];
    for (const [index, unit] of Object.entries(pMap || {})) {
        const before = attribution?.playersAtk?.[index];
        if (before === undefined || !(Number(unit?.atkCounter) > before)) continue;
        const profile = debuffProfile(attribution?.actions?.[index], abilityDetailMap ?? undefined);
        if (profile) landed.push(profile);
    }

    for (const profile of landed) {
        if (!profile.debuffSeconds) continue;
        for (const slot of hit) {
            (monsters[slot] ||= {})[profile.abilityHrid] = {
                key: profile.abilityHrid,
                kind: 'debuff',
                abilityHrid: profile.abilityHrid,
                slug: profile.slug,
                name: profile.name,
                label: effectLabel(profile.slug),
                expiresAt: now + profile.debuffSeconds * 1000,
            };
        }
    }

    const stunner = landed.filter((profile) => profile.stunSeconds).sort((a, b) => b.stunSeconds - a.stunSeconds)[0];
    for (const slot of alive) {
        const stunned = mMap[slot]?.isStunned === true;
        const held = monsters[slot]?.[STUN_KEY];
        if (!stunned) {
            if (held) delete monsters[slot][STUN_KEY];
            continue;
        }
        // Restated every tick of the stun; the first statement set the countdown
        if (held) {
            held.seenAt = now;
            continue;
        }
        (monsters[slot] ||= {})[STUN_KEY] = {
            key: STUN_KEY,
            kind: 'stun',
            abilityHrid: stunner?.abilityHrid ?? null,
            slug: stunner?.slug ?? null,
            name: stunner ? `Stunned by ${stunner.name}` : 'Stunned',
            label: 'STN',
            expiresAt: stunner ? now + stunner.stunSeconds * 1000 : null,
            seenAt: now,
        };
    }
}

/**
 * The effects standing on each boss now, expired ones dropped from the state.
 *
 * A stun stands for as long as the stream keeps stating it, bounded by
 * {@link STUN_GRACE_MS} past its countdown (or {@link STUN_UNTIMED_MS} since it
 * was last stated, with no countdown); everything else stands until its timer
 * runs out. Stuns first, then the longest-running.
 *
 * @param {Object} debuffs - From {@link newBossDebuffState}, mutated
 * @param {number} now - Clock
 * @returns {Map<string, Array<Object>>} Boss slot → effects, only for bosses carrying any
 */
export function activeBossDebuffs(debuffs, now) {
    const out = new Map();
    for (const [slot, effects] of Object.entries(debuffs?.monsters || {})) {
        for (const [key, effect] of Object.entries(effects)) {
            const over =
                effect.kind === 'stun'
                    ? effect.expiresAt === null
                        ? now - effect.seenAt > STUN_UNTIMED_MS
                        : now > effect.expiresAt + STUN_GRACE_MS
                    : effect.expiresAt <= now;
            if (over) delete effects[key];
        }
        const list = Object.values(effects);
        if (!list.length) {
            delete debuffs.monsters[slot];
            continue;
        }
        out.set(
            slot,
            list.sort(
                (a, b) =>
                    Number(b.kind === 'stun') - Number(a.kind === 'stun') || (b.expiresAt ?? 0) - (a.expiresAt ?? 0)
            )
        );
    }
    return out;
}
