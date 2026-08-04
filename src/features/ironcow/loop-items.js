/**
 * What the Iron Bell Farming money loop is made of, resolved from game data.
 *
 * The loop is named in items and actions — Star Fruit, the foraging action that
 * drops it, the essence it decomposes into — and hard-coding those hrids is how
 * a feature quietly stops working the next time the game renames something. So
 * only the *shape* is hard-coded here (a fruit that is foraged, decomposes into
 * something coinifiable) and every hrid is looked up, with the canonical names
 * as hints rather than as the answer.
 *
 * Kept apart from the loop arithmetic because the plan tracker needs the same
 * answers — the level at which alchemy stops being penalised on this loop is a
 * property of the item, not of the panel.
 */

import dataManager from '../../core/data-manager.js';

/** The fruit, in the spellings the game has plausibly used */
const STARFRUIT_CANDIDATES = ['/items/star_fruit', '/items/starfruit'];

/** Matched against `itemDetails.name` when no candidate hrid exists */
const STARFRUIT_NAME = /^star\s*fruit$/i;

const FORAGING_TYPE = '/action_types/foraging';

/**
 * Find the fruit itself.
 * @param {Object} itemDetailMap - `initClientData.itemDetailMap`
 * @returns {string|null} Its hrid, or null when the game has no such item
 */
function findStarfruit(itemDetailMap) {
    for (const candidate of STARFRUIT_CANDIDATES) {
        if (itemDetailMap[candidate]) return candidate;
    }
    for (const [hrid, details] of Object.entries(itemDetailMap)) {
        if (STARFRUIT_NAME.test(details?.name || '')) return hrid;
    }
    return null;
}

/**
 * The foraging action that drops the fruit.
 *
 * The plan is explicit that this is the fruit's own action and not the asteroid
 * belt, so where several foraging actions drop it the one that drops it most
 * often wins — which is the dedicated one by a wide margin.
 *
 * @param {Object} actionDetailMap - `initClientData.actionDetailMap`
 * @param {string} itemHrid - The fruit
 * @returns {string|null} Action hrid, or null when nothing forages it
 */
function findForageAction(actionDetailMap, itemHrid) {
    let best = null;
    let bestRate = -1;
    for (const [hrid, action] of Object.entries(actionDetailMap)) {
        if (action?.type !== FORAGING_TYPE || !Array.isArray(action.dropTable)) continue;
        const drop = action.dropTable.find((entry) => entry.itemHrid === itemHrid);
        if (!drop) continue;
        const rate = drop.dropRate || 0;
        if (rate > bestRate) {
            bestRate = rate;
            best = hrid;
        }
    }
    return best;
}

/**
 * Which of an item's decompose outputs is the one worth coinifying.
 *
 * Falls back to the first output when none is flagged coinifiable, so the plan
 * tracker still gets its alchemy target out of a game-data shape we did not
 * expect. Whether the loop can actually be costed is then the loop's own
 * answer, given by the coinify calculator declining the item.
 *
 * @param {Array<{itemHrid: string, count: number}>} decomposeItems - From `alchemyDetail`
 * @param {Object} itemDetailMap - `initClientData.itemDetailMap`
 * @returns {{itemHrid: string, count: number}|null} The output, or null when there are none
 */
function findCoinifiableOutput(decomposeItems, itemDetailMap) {
    for (const output of decomposeItems || []) {
        if (itemDetailMap[output.itemHrid]?.alchemyDetail?.isCoinifiable === true) return output;
    }
    return decomposeItems?.[0] || null;
}

/**
 * Everything the loop needs to name itself, or null when game data is not loaded.
 *
 * `alchemyTarget` is the level at which the under-level penalty stops biting on
 * this loop: alchemy is penalised by the *item's* level, and the loop touches
 * two items, so the target is the higher of the two. That is a real number the
 * plan can check against, rather than "level alchemy a bit".
 *
 * @returns {Object|null} `{starfruitHrid, forageActionHrid, essenceHrid, essencePerDecompose,
 *   starfruitLevel, essenceLevel, alchemyTarget}`, or null
 */
export function resolveLoopItems() {
    try {
        const gameData = dataManager.getInitClientData();
        const itemDetailMap = gameData?.itemDetailMap;
        const actionDetailMap = gameData?.actionDetailMap;
        if (!itemDetailMap || !actionDetailMap) return null;

        const starfruitHrid = findStarfruit(itemDetailMap);
        if (!starfruitHrid) return null;

        const starfruit = itemDetailMap[starfruitHrid];
        const output = findCoinifiableOutput(starfruit?.alchemyDetail?.decomposeItems, itemDetailMap);
        if (!output) return null;

        const forageActionHrid = findForageAction(actionDetailMap, starfruitHrid);
        if (!forageActionHrid) return null;

        const starfruitLevel = starfruit.itemLevel || 1;
        const essenceLevel = itemDetailMap[output.itemHrid]?.itemLevel || 1;

        return {
            starfruitHrid,
            starfruitName: starfruit.name || 'Star Fruit',
            forageActionHrid,
            essenceHrid: output.itemHrid,
            essenceName: itemDetailMap[output.itemHrid]?.name || 'essence',
            essencePerDecompose: output.count || 0,
            starfruitLevel,
            essenceLevel,
            alchemyTarget: Math.max(starfruitLevel, essenceLevel),
        };
    } catch (error) {
        console.error('[IronCow] Could not resolve the loop items:', error);
        return null;
    }
}
