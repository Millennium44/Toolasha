/**
 * Alchemy coin fees.
 *
 * The game charges gold to run an alchemy action, and that charge is nowhere in
 * the game's data: `actionDetails.coinCost` is 0 for every `/actions/alchemy/*`
 * action, and nothing the websocket reports records the fee that was actually
 * paid (the decompose tracker drops the coin entry from `endCharacterItems`
 * outright). Both formulas below are reverse-engineered, and this module is the
 * one place that states them so the callers cannot drift apart again.
 */

/** Alchemy types billed by item level: (10 + itemLevel) × 5 per item */
const LEVEL_PRICED_TYPES = new Set(['decompose', 'unrefine']);

/**
 * Coinify is not billed at all — the item is the input and coins are the output,
 * so there is no separate gold fee to pay. Every other coinify site in the repo
 * already assumed this (the profit calculator hardcodes `coinCost = 0`, the action
 * planner and the gold summary both skip coinify outright); only the coinify history
 * viewer charged the transmute fee, which overstated every session's cost. The rule
 * lives here now so the sites cannot disagree again.
 */
const FREE_TYPES = new Set(['coinify']);

/**
 * Coin fee for one alchemy action, including the item's bulk multiplier.
 *
 * Three families:
 *  - decompose / unrefine — `(10 + itemLevel) * 5` per item
 *  - transmute — `max(50, floor(sellPrice / 5))` per item
 *  - coinify — free (see FREE_TYPES)
 *
 * Decompose used `max(50, floor(sellPrice / 5))` in the history viewer while
 * every other decompose site used the item-level formula. Nothing in the repo
 * can adjudicate that — the fee is absent from game data and unrecorded in
 * session history — so the item-level formula won, being the one the other
 * decompose sites and upstream already agreed on.
 *
 * @param {Object|null|undefined} itemDetails - Item details from dataManager
 * @param {'decompose'|'unrefine'|'transmute'|'coinify'} alchemyType - Which alchemy action
 * @param {number} [bulkMultiplierOverride] - Bulk size to bill at, for history callers that
 *   recorded the multiplier in effect at the time rather than the item's current one
 * @returns {number} Coin fee per action, or 0 when the item is unknown
 */
export function getAlchemyCoinCost(itemDetails, alchemyType, bulkMultiplierOverride) {
    if (!itemDetails) return 0;
    if (FREE_TYPES.has(alchemyType)) return 0;

    const bulkMultiplier = bulkMultiplierOverride || itemDetails.alchemyDetail?.bulkMultiplier || 1;

    if (LEVEL_PRICED_TYPES.has(alchemyType)) {
        const itemLevel = itemDetails.itemLevel || 1;
        return (10 + itemLevel) * 5 * bulkMultiplier;
    }

    const sellPrice = itemDetails.sellPrice || 0;
    return Math.max(50, Math.floor(sellPrice / 5)) * bulkMultiplier;
}

/**
 * Which alchemy type an action hrid names, for callers holding an action rather
 * than a panel selection.
 * @param {string} actionHrid - e.g. `/actions/alchemy/decompose`
 * @returns {string|null} The alchemy type, or null when the hrid is not alchemy
 */
export function getAlchemyTypeFromActionHrid(actionHrid) {
    if (!actionHrid) return null;
    for (const type of ['decompose', 'unrefine', 'transmute', 'coinify']) {
        if (actionHrid.includes(type)) return type;
    }
    return null;
}
