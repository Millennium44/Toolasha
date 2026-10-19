/**
 * Which `pMap` key is the logged-in character.
 *
 * `battle_updated.pMap` is keyed by position in the battle, and the only message that names the
 * positions is `new_battle`. After a page reload in an ongoing solo fight no `new_battle` ever
 * arrives (a death does not start a new battle), so the seat has to be found without one.
 *
 * Sources, in order of trust:
 * 1. `new_battle.players` — the fight's own roster, by character id then name;
 * 2. the data manager's cached copy of the last `new_battle` (covers a module that started
 *    mid-fight in a tab that did see the message);
 * 3. a solo fallback: the party is known to be just us (or empty) and the tick names exactly one
 *    seat. A party with no roster is never guessed at — a wrong seat would report a party
 *    member's death as ours — so it waits for the next `new_battle`.
 */

import dataManager from '../../core/data-manager.js';

/**
 * The local player's seat in a `new_battle`.
 * @param {Object} battle - `new_battle` payload
 * @returns {{index: string, player: Object}|null} Null when no entry is ours
 */
export function seatFromBattle(battle) {
    const entries = Object.entries(battle?.players || {});
    const id = dataManager.getCurrentCharacterId?.() ?? null;
    const name = dataManager.getCurrentCharacterName?.() ?? null;
    const hit =
        entries.find(([, p]) => id !== null && p?.character?.id === id) ||
        entries.find(([, p]) => name && (p?.character?.name === name || p?.name === name));
    return hit ? { index: hit[0], player: hit[1] } : null;
}

/**
 * Find the seat from a tick when no `new_battle` named it.
 * @param {Object} tick - `battle_updated` payload
 * @returns {{index: string, guessed: boolean}|null} Null when the seat cannot be told safely
 */
export function seatFromTick(tick) {
    const cached = seatFromBattle(dataManager.battleData);
    if (cached) return { index: cached.index, guessed: false };

    const id = dataManager.getCurrentCharacterId?.() ?? null;
    const members = dataManager.getPartyMembers?.()?.members;
    if (!id || !Array.isArray(members)) return null;
    const alone = members.length === 0 || (members.length === 1 && members[0].characterID === id);
    const keys = Object.keys(tick?.pMap || {});
    return alone && keys.length === 1 ? { index: keys[0], guessed: true } : null;
}

/**
 * Whether a guessed seat has been contradicted: a solo fallback is only sound while the tick keeps
 * naming a single seat, so a second one means a party and the guess is dropped.
 * @param {Object} tick - `battle_updated` payload
 * @returns {boolean} True when the guess must be discarded
 */
export function guessContradicted(tick) {
    return Object.keys(tick?.pMap || {}).length > 1;
}
