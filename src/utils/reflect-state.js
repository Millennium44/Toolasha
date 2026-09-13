/**
 * Reflect state
 *
 * Which players have a reflect (Spike Shell, Retribution) up, for the
 * `reflecting` option of `damage-attribution.js`. That option is inert without
 * it: thorns move a monster's hit counter exactly like a swing, so only the
 * wearer's buff state tells the two apart.
 *
 * ## Two sources, and which one answered is recorded
 *
 * - **The buff map.** A personal `battle_updated` can carry a unit's
 *   `combatBuffMap` — the complete list of what is on it, replacing the last one
 *   (`combat-unit-buff-bars.js` reads it the same way) — and `new_battle` states
 *   every player's. An entry joins back to its ability through
 *   `effectForBuff`, and a reflect entry that has not expired is the answer.
 * - **A remembered cast.** Without a map for the slot, or without game data that
 *   declares a buff for either reflect ability, a reflect is taken to be up for
 *   {@link REFLECT_WINDOW_MS} after the slot was last seen preparing one. On a
 *   57-slot trial trace the recasts land at a p90 of 32.7 s and thorns-shaped
 *   ticks up to 32.8 s after a cast; this window beat KikiMeter's same-tick
 *   marker against the game's own totals (1.164% against 1.199% error).
 *
 * The buff-map reading was never checked against a live personal payload — the
 * recorded fixtures carry no `combatBuffMap` — so every answer notes which source
 * gave it, and a caller can expose that for a live check.
 */

import { abilityEffects, effectForBuff } from './ability-effects.js';

/** The abilities whose buff reflects damage onto an attacker */
export const REFLECT_ABILITIES = new Set(['/abilities/spike_shell', '/abilities/retribution']);

/** How long a remembered reflect cast is taken to still be up */
export const REFLECT_WINDOW_MS = 33_000;

/** Nanoseconds in a second, the unit every stated duration uses */
const NANOSECONDS_PER_SECOND = 1e9;

/**
 * A fresh reflect state.
 * @returns {{buffMaps: Object, casts: Object, sources: Object, damage: {buffMap: number, castWindow: number}}}
 */
export function newReflectState() {
    return {
        /** Player index → the last `combatBuffMap` stated for the slot */
        buffMaps: {},
        /** Player index → `{hrid, at}`, the last reflect seen being prepared */
        casts: {},
        /** Player index → `'buffMap'` or `'castWindow'`, whichever last answered for the slot */
        sources: {},
        /** Reflect damage credited, by the source that said the reflect was up */
        damage: { buffMap: 0, castWindow: 0 },
    };
}

/**
 * Keep the buff maps a message states.
 *
 * A unit the message does not mention, or mentions without a map, keeps what it
 * had: a tick is a patch, not a census.
 *
 * @param {Object} state - From {@link newReflectState}, mutated
 * @param {Object} units - `new_battle`'s `players` or a tick's `pMap`
 */
export function noteReflectBuffs(state, units) {
    for (const [index, unit] of Object.entries(units || {})) {
        const map = unit?.combatBuffMap;
        if (map && typeof map === 'object') state.buffMaps[index] = map;
    }
}

/**
 * Remember who is preparing a reflect.
 *
 * Called after attribution, like `noteActions`: a tick naming Spike Shell says
 * it is about to be cast, and every later sighting refreshes the time, so the
 * last one lands close to the cast itself.
 *
 * @param {Object} state - From {@link newReflectState}, mutated
 * @param {Object} units - A tick's `pMap` or `new_battle`'s `players`
 * @param {number} now - ms since epoch
 */
export function noteReflectCasts(state, units, now) {
    for (const [index, unit] of Object.entries(units || {})) {
        const hrid = unit?.abilityHrid || unit?.preparingAbilityHrid;
        if (REFLECT_ABILITIES.has(hrid)) state.casts[index] = { hrid, at: now };
    }
}

/**
 * Whether the game data can join a buff map entry to a reflect ability at all.
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {boolean}
 */
function buffMapReadable(abilityDetailMap) {
    for (const hrid of REFLECT_ABILITIES) {
        if (abilityEffects(hrid, abilityDetailMap)?.selfBuffs?.length) return true;
    }
    return false;
}

/**
 * The reflect ability a buff map says is up.
 *
 * Expiry as `combat-unit-buff-bars.js` reads it: the live duration in
 * nanoseconds from `startTime`, else the duration the ability data states, and an
 * entry with neither is taken to be on the unit.
 *
 * @param {Object} buffMap - One unit's `combatBuffMap`
 * @param {number} now - ms since epoch
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {string|null} The ability hrid, or null when no reflect is up
 */
export function reflectFromBuffMap(buffMap, now, abilityDetailMap) {
    for (const [uniqueHrid, buff] of Object.entries(buffMap || {})) {
        const record = effectForBuff(buff?.uniqueHrid || uniqueHrid, abilityDetailMap);
        if (!record || !REFLECT_ABILITIES.has(record.abilityHrid)) continue;

        const live = Number(buff?.duration) / NANOSECONDS_PER_SECOND;
        const seconds = Number.isFinite(live) && live > 0 ? live : record.durationSeconds;
        const started = Date.parse(String(buff?.startTime ?? ''));
        if (seconds && Number.isFinite(started) && started + seconds * 1000 <= now) continue;
        return record.abilityHrid;
    }
    return null;
}

/**
 * The `reflecting` callback for one tick.
 *
 * @param {Object} state - From {@link newReflectState}; `sources` is mutated
 * @param {number} now - ms since epoch
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {Function} `(index) => hrid|null`
 */
export function reflectingFor(state, now, abilityDetailMap) {
    const readable = buffMapReadable(abilityDetailMap);
    return (index) => {
        const map = state.buffMaps[index];
        if (map && readable) {
            state.sources[index] = 'buffMap';
            return reflectFromBuffMap(map, now, abilityDetailMap);
        }
        state.sources[index] = 'castWindow';
        const cast = state.casts[index];
        return cast && now - cast.at >= 0 && now - cast.at <= REFLECT_WINDOW_MS ? cast.hrid : null;
    };
}

/**
 * Charge a tick's reflect events to the source that answered for their player.
 * @param {Object} state - From {@link newReflectState}, mutated
 * @param {Array<Object>} events - From `attributeTick`
 */
export function noteReflectEvents(state, events) {
    for (const event of events || []) {
        if (!event?.isReflect) continue;
        const source = state.sources[event.playerIndex] === 'buffMap' ? 'buffMap' : 'castWindow';
        state.damage[source] += Number(event.amount) || 0;
    }
}

/**
 * What the reflect state knows, for a console check.
 * @param {Object} state - From {@link newReflectState}
 * @param {number} [now] - ms since epoch
 * @returns {{sources: Object, buffMapSlots: string[], casts: Object, damage: Object}}
 */
export function reflectSummary(state, now = Date.now()) {
    const casts = {};
    for (const [index, cast] of Object.entries(state?.casts || {})) {
        casts[index] = { hrid: cast.hrid, secondsAgo: Math.round((now - cast.at) / 100) / 10 };
    }
    return {
        sources: { ...(state?.sources || {}) },
        buffMapSlots: Object.keys(state?.buffMaps || {}),
        casts,
        damage: { ...(state?.damage || { buffMap: 0, castWindow: 0 }) },
    };
}
