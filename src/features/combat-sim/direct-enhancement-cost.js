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
import {
    getCheapestProtectionPrice,
    perAttemptMaterialCost,
    priceGuarded,
} from '../../utils/enhancement-input-pricing.js';

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
 * What one enhancement run costs, how long it takes and what it teaches, on the cheapest protect-from plan.
 *
 * {@link calculateDirectEnhancementCost} is this, reduced to the gold. A caller that rates the run per
 * hour (the Craft & Enhance window) needs the seconds and the XP of the same plan, so one solve answers
 * all three and they cannot disagree about which plan was cheapest.
 *
 * @param {string} itemHrid - Item HRID
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @param {Object} [options] - Options
 * @param {Object} [options.params] - Enhancing parameters to quote at (for example the player's detected
 *   bench). Omitted, the advisor's resolution applies: pro rates or the simulator's bench, as set.
 * @param {number|null} [options.selfCopyCraftCost] - What one more copy of this very item costs to craft, a
 *   COMPLETE figure (no unpriced input). Given, the item's own copy competes as a protection at the cheaper of that
 *   and its market price, and the quote says how many copies were crafted. Omitted or not above 0, the copy is
 *   priced at market only, as before.
 * @returns {{cost: number, seconds: number, xp: number, xpKnown: boolean, attempts: number, protectFrom: number,
 *   protectionItemHrid: string|null, selfCopyCrafts: number}|null} `selfCopyCrafts` is the expected number of copies
 *   the plan spends that were priced at craft cost (0 when none); null when it cannot be quoted (no recipe, a material with no price,
 *   or nothing about the run priceable): unknown, never free
 */
export function quoteDirectEnhancement(
    itemHrid,
    startLevel,
    targetLevel,
    gameData,
    { params, selfCopyCraftCost = null } = {}
) {
    // Genuine no-op: nothing to enhance
    if (targetLevel <= startLevel) {
        return {
            cost: 0,
            seconds: 0,
            xp: 0,
            xpKnown: true,
            attempts: 0,
            protectFrom: 0,
            protectionItemHrid: null,
            selfCopyCrafts: 0,
        };
    }

    // On the test server with the Tester shop priced in, nobody rolls the
    // dice: the finished level is a shop copy mirrored up, guaranteed
    if (testerShopEnabled()) {
        const tester = testerGearPrice(itemHrid, targetLevel, { itemDetailMap: gameData?.itemDetailMap });
        if (tester) {
            return {
                cost: tester.price,
                seconds: 0,
                xp: 0,
                xpKnown: false,
                attempts: 0,
                protectFrom: 0,
                protectionItemHrid: null,
                selfCopyCrafts: 0,
            };
        }
    }

    const itemDetails = gameData.itemDetailMap[itemHrid];
    // No enhancement recipe: cost is unknown, not free. Reporting 0 here would
    // rank the upgrade as the best value in the list (gold-per-improvement 0).
    if (!itemDetails?.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return null;
    }

    const enhancingParams = params || enhancementSweepParams(itemHrid);

    // The shared rule: a one-sided book cross-fills, then production cost, and
    // trainee charms take the one shop-price constant. A material with none of
    // those is unpriced (`hasMissingPrices`), never a vendor price or free.
    // This used to be an inline transcription here, complete with its own 250000.
    const materials = perAttemptMaterialCost(itemDetails);
    // An enhance run with a material nobody prices is unknown, not the cost of the materials that have one:
    // every caller reads null as "cannot be quoted" (flags the row unpriced or drops the route), and a number
    // here would read as a full quote and rank the upgrade cheaper than it can be done
    // (a craft-priced material with an unpriced input is the same: its price is a partial bill)
    if (materials.hasMissingPrices || materials.hasPartialPrices) return null;

    // Get cheapest protection price. Null when nothing that could protect this
    // item has a price — which makes every protecting strategy unpriceable, not
    // free. Quoting protection at zero made the most-protected path the cheapest
    // by construction and put it top of the rankings.
    const craftCopy = Number(selfCopyCraftCost) > 0 ? Number(selfCopyCraftCost) : null;
    let protectionOptions;
    let protPartial;
    if (craftCopy === null) {
        const { price: protPrice, itemHrid: protHrid, partial } = getCheapestProtectionPrice(itemHrid);
        protPartial = partial;
        protectionOptions = protPrice > 0 ? [{ itemHrid: protHrid, price: protPrice }] : [];
    } else {
        // The item's own copy competes at the cheaper of its market price and what it costs to craft (a complete
        // figure, so it is never a floor); the mirror and the item's listed protection items compete as ever
        const others = getCheapestProtectionPrice(itemHrid, { includeSelf: false });
        const market = priceGuarded(itemHrid);
        // A market figure that is itself a craft-cost floor is no better than the complete craft cost: take that
        const marketUsable = market.price > 0 && !market.partial;
        protectionOptions = [];
        if (others.price > 0) protectionOptions.push({ itemHrid: others.itemHrid, price: others.price });
        if (market.custom) {
            // The player's own price for the item is their answer, as priceGuarded keeps it: used as is, with no
            // crafted copy competing, and a custom 0 or unpriced copy stays unpriced
            if (market.price > 0) protectionOptions.push({ itemHrid, price: market.price });
        } else {
            const selfPrice = marketUsable ? Math.min(market.price, craftCopy) : craftCopy;
            protectionOptions.push({ itemHrid, price: selfPrice, crafted: !marketUsable || craftCopy < market.price });
        }
        // Only the others can be a floor now: the self copy's price is a complete figure either way
        protPartial = others.partial;
    }
    // A protection price built on a partial bill is a floor: it only matters when the cheapest plan actually
    // spends it (checked after the sweep), because an unprotected cheapest plan is a complete quote

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
                // Conservation keeps a protection item; the options priced here are never a Philosopher's Mirror
                conservation: enhancingParams.conservation,
            },
            targetLevel,
            startLevel,
            materialCostPerAttempt: materials.cost,
            // The XP formula keys on the item's own level, the same reading the enhancing panel takes
            xpBaseLevel: itemDetails.itemLevel || 0,
            wisdomDecimal: (enhancingParams.experienceBonus || 0) / 100,
            epiphany: enhancingParams.epiphany || 0,
            protectionOptions,
            hasMissingPrices: materials.hasMissingPrices || materials.hasPartialPrices,
        });

        // The cheapest plan spends a protection whose price is a floor: the quote is a partial bill, so unknown
        // (in the crafted-copy case only the non-self option can be a floor, so a plan spending the self copy stands)
        const spendsSelf = craftCopy !== null && plan?.protectionItemHrid === itemHrid;
        if (plan && protPartial && plan.protectFrom > 0 && plan.protectionItemHrid && !spendsSelf) return null;

        // Nothing about the run could be priced — unknown, not free
        if (!plan) return null;
        return {
            cost: Math.max(0, Math.round(plan.cost)),
            seconds: plan.seconds,
            xp: plan.xp,
            xpKnown: true,
            attempts: plan.attempts,
            protectFrom: plan.protectFrom,
            protectionItemHrid: plan.protectionItemHrid,
            // Copies of the item itself bought at craft cost are crafts the player also makes
            selfCopyCrafts:
                spendsSelf && plan.protectFrom > 0 && protectionOptions.find((o) => o.itemHrid === itemHrid)?.crafted
                    ? Number(plan.protections) || 0
                    : 0,
        };
    } catch {
        return null;
    }
}

/**
 * Calculate the gold cost of enhancing an item from startLevel to targetLevel.
 * Uses incremental cost approach: cost(0→target) - cost(0→start), matching
 * the tooltip's enhancement path calculation exactly.
 * @param {string} itemHrid - Item HRID
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {number|null} Expected gold cost, or null when it cannot be quoted (no recipe, a material with no
 *   price, or nothing about the run priceable)
 */
export function calculateDirectEnhancementCost(itemHrid, startLevel, targetLevel, gameData) {
    return quoteDirectEnhancement(itemHrid, startLevel, targetLevel, gameData)?.cost ?? null;
}
