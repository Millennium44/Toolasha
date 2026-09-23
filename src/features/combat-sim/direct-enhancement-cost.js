/**
 * Direct enhancement cost
 *
 * What it costs to take one item from one enhancement level to another at the
 * bench the upgrade advisor quotes. Lives apart from the upgrade advisor so that
 * callers in other bundles (the Skilling Optimizer loads with Actions and UI)
 * can import it without copying the whole advisor — and the advisor's imports
 * from the Combat bundle, which loads after them — into their own bundle.
 */

import { testerShopEnabled, testerGearPrice } from '../../utils/tester-shop.js';
import { enhancementParamsFor } from '../enhancement/enhancement-params-source.js';
// The one enhancement cost model: the shared protect-from sweep and the shared
// pricing rules.
import { cheapestProtectPlan } from '../../utils/enhancement-protect-sweep.js';
import { getCheapestProtectionPrice, perAttemptMaterialCost } from '../../utils/enhancement-pricing.js';

/**
 * Whose bench an enhancement sweep is quoting.
 *
 * This used to ask whether the slot was `/equipment_types/back`, on the premise
 * (verbatim, from 12b978be) that "back items are non-tradeable". The premise is
 * the right one — nobody can sell you a finished piece you have to make
 * yourself, so your own bench is the only honest one — but the slot is a poor
 * proxy for it: a chance cape is back-slot and perfectly tradable, and was
 * being costed at the character's bench while the tooltip beside it costed the
 * same cape at whatever the simulator was set to. The rule now asks the item.
 *
 * Named rather than inlined because the answer has to be reportable: a figure
 * costed at a professional's bench and one costed at yours land in the same
 * column, and {@link explainUpgradeCost} carries which it was so the row can
 * say so in the same words the enhancement tooltip's chip uses.
 *
 * @param {string} [itemHrid] - Item being enhanced
 * @returns {Object} Enhancement parameters, tagged with `paramsSource`
 */
export function enhancementSweepParams(itemHrid) {
    return enhancementParamsFor('advisor', itemHrid);
}

/**
 * Calculate the gold cost of enhancing an item from startLevel to targetLevel.
 * Uses incremental cost approach: cost(0→target) - cost(0→start), matching
 * the tooltip's enhancement path calculation exactly.
 * @param {string} itemHrid - Item HRID
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {number} Expected gold cost
 */
export function calculateDirectEnhancementCost(itemHrid, startLevel, targetLevel, gameData) {
    // Genuine no-op: nothing to enhance
    if (targetLevel <= startLevel) {
        return 0;
    }

    // On the test server with the Tester shop priced in, nobody rolls the
    // dice: the finished level is a shop copy mirrored up, guaranteed
    if (testerShopEnabled()) {
        const tester = testerGearPrice(itemHrid, targetLevel, { itemDetailMap: gameData?.itemDetailMap });
        if (tester) return tester.price;
    }

    const itemDetails = gameData.itemDetailMap[itemHrid];
    // No enhancement recipe: cost is unknown, not free. Reporting 0 here would
    // rank the upgrade as the best value in the list (gold-per-improvement 0).
    if (!itemDetails?.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return null;
    }

    const enhancingParams = enhancementSweepParams(itemHrid);

    // The shared rule: a one-sided book cross-fills, then production cost, then
    // the vendor price, and trainee charms take the one shop-price constant.
    // This used to be an inline transcription here, complete with its own 250000.
    const materials = perAttemptMaterialCost(itemDetails);

    // Get cheapest protection price. Null when nothing that could protect this
    // item has a price — which makes every protecting strategy unpriceable, not
    // free. Quoting protection at zero made the most-protected path the cheapest
    // by construction and put it top of the rankings.
    const { price: protPrice, itemHrid: protHrid } = getCheapestProtectionPrice(itemHrid);

    try {
        // From the level the piece is actually at, not the difference between
        // two runs from +0. The old form — fullCost[target] − fullCost[start] —
        // gives the same number almost everywhere, because an item cannot skip
        // a level and so every path to +7 passes through +4 (see
        // enhancement-cost-parity.test.js). It parts company under Blessed Tea,
        // whose double jump can vault the start level, and there it undercounts
        // the real run. Solving from the start is right in both cases.
        const plan = cheapestProtectPlan({
            chain: {
                // Every input comes from whichever bench `enhancementSweepParams`
                // resolved — the observatory level and the blessed tea's real double-jump
                // chance included, so the quote is one run and not a mix of two
                enhancingLevel: enhancingParams.enhancingLevel,
                toolBonus: enhancingParams.toolBonus,
                speedBonus: enhancingParams.speedBonus || 0,
                itemLevel: itemDetails.itemLevel || 1,
                blessedTea: enhancingParams.teas?.blessed || false,
                guzzlingBonus: enhancingParams.guzzlingBonus || 1.0,
                blessedTeaBonus: enhancingParams.blessedTeaBonus,
            },
            targetLevel,
            startLevel,
            materialCostPerAttempt: materials.cost,
            protectionOptions: protPrice > 0 ? [{ itemHrid: protHrid, price: protPrice }] : [],
            hasMissingPrices: materials.hasMissingPrices,
        });

        // Nothing about the run could be priced — unknown, not free
        return plan ? Math.max(0, Math.round(plan.cost)) : null;
    } catch {
        return null;
    }
}
