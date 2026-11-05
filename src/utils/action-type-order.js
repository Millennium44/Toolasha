/**
 * Action types in the game's own order (Milking first, Combat last), so a
 * picker lists skills the way the game's skill list does rather than A to Z.
 *
 * The order is the game's `sortIndex` from `actionTypeDetailMap` in the init
 * client data; a type the game has not numbered (or before the data loads)
 * goes after every numbered one, by name.
 */

import dataManager from '../core/data-manager.js';

/**
 * The last path segment of an hrid, only for breaking ties.
 * @param {string} hrid - e.g. `/action_types/foraging`
 * @returns {string}
 */
function nameOf(hrid) {
    return String(hrid || '')
        .split('/')
        .pop();
}

/**
 * Sort action type hrids into the game's order.
 * @param {Iterable<string>} hrids - Action type hrids
 * @returns {string[]} A new array
 */
export function sortActionTypes(hrids) {
    const details = dataManager.getInitClientData?.()?.actionTypeDetailMap || {};
    const index = (hrid) => {
        const value = details[hrid]?.sortIndex;
        return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    };
    return [...hrids].sort((a, b) => index(a) - index(b) || nameOf(a).localeCompare(nameOf(b)));
}
