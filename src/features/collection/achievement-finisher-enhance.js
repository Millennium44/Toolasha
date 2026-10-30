/**
 * Enhancer achievements: the cheapest way to land one enhancing success at +target or above.
 *
 * The maintainer's rule: buy a piece at some level +s (0 ≤ s ≤ target) and enhance it, protecting with
 * the cheapest protection item, until a success lands at ≥ target. Buying at +target counts too: one
 * success makes +target+1, and a protected failure drops to +target−1, one success away again. Every
 * qualifying piece and every start level is priced, and the cheapest total wins.
 *
 * Pure. The chain is the shared calculator's (`calculateEnhancement`, protect-from 0 or 2..target, the
 * same strategies the enhancing panel sweeps); the prices, the character's enhancing stats, the per-
 * attempt material cost and the protection price come in through `ctx`, so one pricing rule governs
 * every hint on the page.
 */

import {
    BASE_SUCCESS_RATES,
    calculateEnhancement,
    calculateSuccessMultiplier,
} from '../../utils/enhancement-calculator.js';
import { NO_PROTECTION, protectFromLevels } from '../../utils/enhancement-protect-sweep.js';

/**
 * The calculator's chain inputs for one item level, from enhancing params (`getAutoDetectedParams`).
 * @param {Object} params
 * @param {number} itemLevel
 * @returns {Object}
 */
function chainOf(params, itemLevel) {
    return {
        enhancingLevel: Number(params.enhancingLevel) || 1,
        toolBonus: Number(params.toolBonus) || 0,
        speedBonus: Number(params.speedBonus) || 0,
        itemLevel,
        blessedTea: Boolean(params.teas?.blessed),
        guzzlingBonus: params.guzzlingBonus ?? 1,
        ...(params.blessedTeaBonus > 0 ? { blessedTeaBonus: params.blessedTeaBonus } : {}),
    };
}

/**
 * Expected attempts and protection uses from `start` until the item first reaches `target`, per
 * protect-from strategy. Solved once per (item level, start, target, protect-from) in `cache`: the
 * chain depends on nothing else within one render.
 * @returns {Array<{protectFrom: number, attempts: number, protections: number}>}
 */
function strategies(params, itemLevel, start, target, cache) {
    const key = `${itemLevel}|${start}|${target}`;
    if (cache.has(key)) return cache.get(key);
    const chain = chainOf(params, itemLevel);
    const rows = [NO_PROTECTION, ...protectFromLevels(target)].map((protectFrom) => {
        const calc = calculateEnhancement({ ...chain, targetLevel: target, startLevel: start, protectFrom });
        return {
            protectFrom,
            attempts: calc.attempts,
            protections: protectFrom > 0 ? calc.protectionCount || 0 : 0,
        };
    });
    cache.set(key, rows);
    return rows;
}

/** The cheapest strategy at these prices; protected ones only when protection has a price */
function cheapest(rows, materialCost, protectionPrice) {
    let best = null;
    for (const row of rows) {
        if (row.protectFrom > 0 && !(protectionPrice > 0)) continue;
        const cost = row.attempts * materialCost + row.protections * (row.protectFrom > 0 ? protectionPrice : 0);
        if (!best || cost < best.cost) best = { ...row, cost };
    }
    return best;
}

/**
 * Expected enhancing cost (materials and protection) from +start to the first success at ≥ +target.
 *
 * Below the target it is the chain's own answer. At the target, one attempt is made at +target: a
 * success counts; a failure drops to +target−1 when that attempt is protected (paying one protection),
 * else to +0, and the cheapest run back up to +target follows.
 *
 * @param {Object} args
 * @param {Object} args.params - Enhancing params
 * @param {number} args.itemLevel
 * @param {number} args.start
 * @param {number} args.target
 * @param {number} args.materialCost - Coins per attempt
 * @param {number|null} args.protectionPrice - Coins per protection, null when unpriced
 * @param {Map} args.cache - Chain solves, shared within one render
 * @returns {{cost: number, protected: boolean}}
 */
export function enhanceRunCost({ params, itemLevel, start, target, materialCost, protectionPrice, cache }) {
    if (start < target) {
        const best = cheapest(strategies(params, itemLevel, start, target, cache), materialCost, protectionPrice);
        return { cost: best.cost, protected: best.protectFrom > 0 && best.protections > 0 };
    }
    const multiplier = calculateSuccessMultiplier({
        enhancingLevel: Number(params.enhancingLevel) || 1,
        toolBonus: Number(params.toolBonus) || 0,
        itemLevel,
    });
    const success = Math.min(1, ((BASE_SUCCESS_RATES[target] ?? 0) / 100) * multiplier);
    const fail = 1 - success;
    const fromZero = cheapest(strategies(params, itemLevel, 0, target, cache), materialCost, protectionPrice);
    let cost = materialCost + fail * fromZero.cost;
    let isProtected = fromZero.protectFrom > 0 && fromZero.protections > 0;
    if (protectionPrice > 0 && target >= 2) {
        const fromBelow = cheapest(
            strategies(params, itemLevel, target - 1, target, cache),
            materialCost,
            protectionPrice
        );
        const protectedCost = materialCost + fail * (protectionPrice + fromBelow.cost);
        if (protectedCost < cost) {
            cost = protectedCost;
            isProtected = true;
        }
    }
    return { cost, protected: isProtected };
}

/**
 * Readiness of an Enhancer achievement: the cheapest route over every qualifying piece and start level.
 *
 * Fills `buyHrid`, `buyLevel`, `cost` (listing + expected enhancing), `listingPrice`,
 * `protectionHrid` (null when the route never protects) and `protectionUnpriced` (no protection item
 * has a price, so only unprotected runs were costed). A level with no listing, or only a value-map
 * estimate, is skipped. A piece whose enhancing materials are unpriced is not costed: when no route is
 * fully priced, the cheapest such listing is named with `cost` null and `partialCost` its listing.
 * An Iron Cow cannot buy: `ironCow` is set and nothing is picked.
 *
 * @param {Object} res - An `enhance` resolution
 * @param {Object} ctx
 * @param {() => Object|null} ctx.enhanceParams - The character's own enhancing params
 * @param {(itemHrid: string, level: number) => number|null} ctx.buyPriceAt - A listing price, null when none
 * @param {(itemHrid: string) => {cost: number, hasMissingPrices: boolean}} ctx.enhanceMaterialCost
 * @param {(itemHrid: string) => {price: number|null, itemHrid: string|null}} ctx.protectionFor
 * @param {Map} [ctx.enhanceCache] - Chain solves to share across this render's rows
 * @param {Object} out - The result being filled
 * @returns {Object} out
 */
export function enhanceReadiness(res, ctx, out) {
    out.levelMet = true;
    out.owned = false;
    if (ctx.ironCow) {
        out.ironCow = true;
        return out;
    }
    const params = ctx.enhanceParams?.() ?? null;
    if (!params) {
        out.levelMet = null;
        return out;
    }
    const cache = ctx.enhanceCache || new Map();

    const listings = [];
    for (const cand of res.candidates) {
        for (let level = 0; level <= res.target; level += 1) {
            const price = ctx.buyPriceAt(cand.itemHrid, level);
            if (Number.isFinite(price) && price > 0) listings.push({ cand, level, price });
        }
    }
    if (listings.length === 0) {
        out.noListing = true;
        return out;
    }
    // Cheapest listing first: once a listing alone costs more than the best route, nothing later can win
    listings.sort((a, b) => a.price - b.price || a.cand.itemHrid.localeCompare(b.cand.itemHrid) || a.level - b.level);

    const materials = new Map();
    const protections = new Map();
    const materialOf = (hrid) => {
        if (!materials.has(hrid)) materials.set(hrid, ctx.enhanceMaterialCost(hrid));
        return materials.get(hrid);
    };
    const protectionOf = (hrid) => {
        if (!protections.has(hrid)) protections.set(hrid, ctx.protectionFor(hrid) || { price: null, itemHrid: null });
        return protections.get(hrid);
    };

    let best = null;
    let firstUnpriced = null;
    for (const listing of listings) {
        if (best && listing.price >= best.cost) break;
        const material = materialOf(listing.cand.itemHrid);
        // A partial bill (a craft-priced material with an unpriced input) is not a full price either
        if (!material || material.hasMissingPrices || material.hasPartialPrices || !Number.isFinite(material.cost)) {
            firstUnpriced ||= listing;
            continue;
        }
        const protection = protectionOf(listing.cand.itemHrid);
        // A partial protection price is treated as unpriced: the route is costed without protection
        const protectionPrice = protection.price > 0 && !protection.partial ? protection.price : null;
        const run = enhanceRunCost({
            params,
            itemLevel: listing.cand.itemLevel,
            start: listing.level,
            target: res.target,
            materialCost: material.cost,
            protectionPrice,
            cache,
        });
        const cost = listing.price + run.cost;
        if (!best || cost < best.cost) {
            best = {
                listing,
                cost,
                protectionHrid: run.protected ? protection.itemHrid : null,
                protectionUnpriced: protectionPrice === null,
            };
        }
    }

    if (!best) {
        Object.assign(out, {
            buyHrid: firstUnpriced.cand.itemHrid,
            buyLevel: firstUnpriced.level,
            listingPrice: firstUnpriced.price,
            partialCost: firstUnpriced.price,
            unpriced: [firstUnpriced.cand.itemHrid],
        });
        return out;
    }
    Object.assign(out, {
        buyHrid: best.listing.cand.itemHrid,
        buyLevel: best.listing.level,
        listingPrice: best.listing.price,
        cost: best.cost,
        protectionHrid: best.protectionHrid,
        protectionUnpriced: best.protectionUnpriced,
    });
    return out;
}
