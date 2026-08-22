/**
 * Production index: which actions make which item.
 *
 * Several features need "the action that produces this item" — the profit
 * calculator, the enhancement tooltip's production-cost chain, the market
 * tooltip's upgrade rows, the crafting planner — and each used to answer it by
 * scanning every entry of actionDetailMap. Per tooltip that was already four
 * scans; the profit calculator runs per open panel on every inventory update.
 *
 * This is the one reverse index they share: outputItemHrid → the actions that
 * list it as an output, in actionDetailMap order, with the position of that
 * output in the action's outputItems so callers that only honour the primary
 * output (index 0) can filter. The index is rebuilt only when the action map it
 * was built from is replaced — it is keyed on the map's identity, so a
 * character switch that hands out a new init_client_data invalidates it and a
 * re-read of the same object does not.
 */

import dataManager from '../core/data-manager.js';

/** The map the current index was built from — compared by identity */
let indexedMap = null;
/** @type {Map<string, Array<{actionHrid: string, outputIndex: number}>>|null} */
let index = null;

/**
 * Build the reverse index for one action map.
 * @param {Object} actionDetailMap - actionHrid → action details
 * @returns {Map<string, Array<{actionHrid: string, outputIndex: number}>>}
 */
function buildIndex(actionDetailMap) {
    const built = new Map();
    for (const actionHrid in actionDetailMap) {
        const outputs = actionDetailMap[actionHrid]?.outputItems;
        if (!outputs || outputs.length === 0) continue;
        for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
            const itemHrid = outputs[outputIndex]?.itemHrid;
            if (!itemHrid) continue;
            let entries = built.get(itemHrid);
            if (!entries) {
                entries = [];
                built.set(itemHrid, entries);
            }
            // An action listing the same item twice still counts once, at its first position
            if (entries.some((entry) => entry.actionHrid === actionHrid)) continue;
            entries.push({ actionHrid, outputIndex });
        }
    }
    return built;
}

/**
 * The reverse index for an action map, cached by the map's identity.
 * @param {Object} [actionDetailMap] - Defaults to the current init_client_data's map
 * @returns {Map<string, Array<{actionHrid: string, outputIndex: number}>>|null} null without an action map
 */
export function getProductionIndex(actionDetailMap = dataManager.getInitClientData()?.actionDetailMap) {
    if (!actionDetailMap) return null;
    if (actionDetailMap !== indexedMap) {
        index = buildIndex(actionDetailMap);
        indexedMap = actionDetailMap;
    }
    return index;
}

/**
 * The actions that produce an item, in actionDetailMap order.
 *
 * @param {string} itemHrid - Item HRID
 * @param {Object} [options]
 * @param {boolean} [options.primaryOnly=false] - Only actions whose *first* output is the item
 * @param {Object} [options.actionDetailMap] - The action map to index (defaults to the live one)
 * @returns {Array<{actionHrid: string, action: Object, output: Object}>} Empty when nothing makes it
 */
export function findProducingActions(itemHrid, { primaryOnly = false, actionDetailMap } = {}) {
    const map = actionDetailMap ?? dataManager.getInitClientData()?.actionDetailMap;
    const entries = getProductionIndex(map)?.get(itemHrid);
    if (!entries) return [];
    const results = [];
    for (const { actionHrid, outputIndex } of entries) {
        if (primaryOnly && outputIndex !== 0) continue;
        const action = map[actionHrid];
        const output = action?.outputItems?.[outputIndex];
        if (!action || !output) continue;
        results.push({ actionHrid, action, output });
    }
    return results;
}

/**
 * The first action that produces an item — the one a single-recipe lookup wants.
 * @param {string} itemHrid - Item HRID
 * @param {Object} [options] - Same options as {@link findProducingActions}
 * @returns {{actionHrid: string, action: Object, output: Object}|null}
 */
export function findProducingAction(itemHrid, options) {
    return findProducingActions(itemHrid, options)[0] ?? null;
}

/** Drop the cached index. Tests only. */
export function _resetProductionIndex() {
    indexedMap = null;
    index = null;
}
