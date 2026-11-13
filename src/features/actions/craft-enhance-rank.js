/**
 * Craft & Enhance ranking: the arithmetic, with no game and no market in it.
 *
 * ## The case
 *
 * Guild players craft gear whose recipe takes dungeon drops (chest contents) or dungeon-token shop
 * items, enhance it to about +5 and sell it. Crafting XP is good, and the whole thing often pays when
 * the drops and tokens are already owned. This module builds one row per qualifying recipe and rates
 * it at +0 and at the target level.
 *
 * ## The rule that matters most: a missing price is never 0
 *
 * A row ranked as profitable because an input, the +N sale or the enhancement run had no price is the
 * worst thing this can show. So every figure that depends on a price is `null` when that price is
 * missing, never a number computed with a 0 standing in. A row with any such gap has
 * `status: 'unpriced'` at that level, carries the reasons, its profit fields are all `null`, and it is
 * sorted behind every row that has a full figure and excluded from "profitable only".
 *
 * A **sunk** input is the opposite case and must not be confused with the one above: the player chose
 * to count an owned drop at 0, so the 0 is a real, deliberate value. It is carried as `sunk: true` on
 * the input and `sunkInputs` on the row, and never as an unpriced reason.
 *
 * ## What is owned versus bought
 *
 * Phase 1 values every unit of a dungeon input the same way, with no inventory split:
 *
 * - `market` (default): what the drop would fetch if sold now, after the market tax, which is the
 *   opportunity cost of using it. A token-shop input is valued through its token (tokens it costs times
 *   the best coins a token converts to), after tax, the same figure the token tooltip uses.
 * - `sunk`: dungeon inputs cost 0.
 *
 * Inputs that are not dungeon inputs are bought at the buy side of the pricing mode, untaxed, exactly
 * as the profit calculator priced them. Buying pays no market tax; only the sale does.
 *
 * Everything here takes its prices as arguments, so it tests without a market.
 */

import { combatZones, openableDrops, zoneDrops } from '../../utils/drop-sources.js';
import { DUNGEON_TOKEN_HRIDS, shopCosts } from '../../utils/token-valuation.js';
import { isTesterShopEntry } from '../../utils/shop-index.js';

/**
 * The three ways a dungeon input is valued:
 * - `market`: owned, so what it would sell for after tax (the cost of using it).
 * - `buy`: bought, so the buy side of the pricing mode, untaxed. A token-shop item takes the cheaper of that
 *   and its token route.
 * - `sunk`: already owned and counted at 0.
 */
export const OWNED_MODES = Object.freeze({ MARKET: 'market', BUY: 'buy', SUNK: 'sunk' });

/** The level a row is rated at when the player has not chosen one */
export const DEFAULT_TARGET_LEVEL = 5;

/** The highest target the window offers */
export const MAX_TARGET_LEVEL = 10;

const SECONDS_PER_HOUR = 3600;

/**
 * Clamp a requested target to what the window offers.
 * @param {*} value - A stored or typed level
 * @returns {number} A whole level from 1 to {@link MAX_TARGET_LEVEL}; the default for anything unusable
 */
export function normalizeTargetLevel(value) {
    const level = Math.floor(Number(value));
    if (!Number.isFinite(level) || level < 1) return DEFAULT_TARGET_LEVEL;
    return Math.min(MAX_TARGET_LEVEL, level);
}

/**
 * @param {*} value - A stored owned-drops mode
 * @returns {string} A known mode; market for anything unknown
 */
export function normalizeOwnedMode(value) {
    return value === OWNED_MODES.SUNK || value === OWNED_MODES.BUY ? value : OWNED_MODES.MARKET;
}

/**
 * Which items are dungeon inputs, read from the game's own data.
 *
 * A dungeon drop is anything in a dungeon's completion reward table and, for each of those that is a
 * chest (an entry of `openableLootDropMap`), everything the chest can contain, followed through chests
 * inside chests. In the game the gear materials come out of the chest, not the reward table itself.
 *
 * **Generic materials are not dungeon inputs.** An item that an ordinary production or gathering action
 * makes (cheese, lumber, a refined bar) can also turn up in a chest, but a player buys it like anything else:
 * valuing it at its after-tax sale would price a recipe that has to buy it too cheaply. Only items with no
 * such source count as drops.
 *
 * A token-shop item is a line of the shop priced in a dungeon token alone: a line that also asks for coins
 * or another item says nothing clean about what a token buys and is left out, as
 * `calculateDungeonTokenValue` leaves it out. Costs are read through the token valuation's own `shopCosts`,
 * so both spellings (`costs` array, single `cost`) are understood.
 *
 * @param {Object} gameData - The game's `initClientData`
 * @returns {{drops: Map<string, {dungeons: string[]}>, tokenShop: Map<string, {tokenHrid: string,
 *   tokenCount: number, outputCount: number}>}} Both keyed by item hrid
 */
export function buildDungeonInputIndex(gameData) {
    const drops = new Map();
    const tokenShop = new Map();

    // Anything an ordinary (non-combat) action makes
    const common = new Set();
    for (const action of Object.values(gameData?.actionDetailMap || {})) {
        if (action?.combatZoneInfo) continue;
        for (const output of action?.outputItems || []) {
            if (output?.itemHrid) common.add(output.itemHrid);
        }
    }

    const note = (itemHrid, dungeonName) => {
        if (common.has(itemHrid)) return;
        const known = drops.get(itemHrid);
        if (known) {
            if (!known.dungeons.includes(dungeonName)) known.dungeons.push(dungeonName);
        } else {
            drops.set(itemHrid, { dungeons: [dungeonName] });
        }
    };

    const walk = (itemHrid, dungeonName, seen) => {
        note(itemHrid, dungeonName);
        if (seen.has(itemHrid) || !gameData?.openableLootDropMap?.[itemHrid]) return;
        seen.add(itemHrid);
        for (const inner of openableDrops(itemHrid, gameData)) {
            if (inner.hrid !== itemHrid) walk(inner.hrid, dungeonName, seen);
        }
    };

    for (const zone of combatZones(gameData?.actionDetailMap)) {
        if (!zone.isDungeon) continue;
        for (const drop of zoneDrops(zone.hrid, gameData)) walk(drop.hrid, zone.name, new Set());
    }

    for (const [key, line] of Object.entries(gameData?.shopItemDetailMap || {})) {
        if (!line?.itemHrid || isTesterShopEntry(line, key)) continue;
        const costs = shopCosts(line);
        if (costs.length !== 1 || !DUNGEON_TOKEN_HRIDS.has(costs[0]?.itemHrid) || !(costs[0]?.count > 0)) continue;
        if (tokenShop.has(line.itemHrid)) continue;
        tokenShop.set(line.itemHrid, {
            tokenHrid: costs[0].itemHrid,
            tokenCount: costs[0].count,
            outputCount: line.outputCount > 0 ? line.outputCount : 1,
        });
    }

    return { drops, tokenShop };
}

/**
 * What kind of dungeon input an item is, if any.
 * @param {string} itemHrid - An input
 * @param {{drops: Map, tokenShop: Map}} index - From {@link buildDungeonInputIndex}
 * @returns {{drop: boolean, token: boolean}|null} Null for an item that is neither
 */
export function dungeonInputKind(itemHrid, index) {
    const drop = Boolean(index?.drops?.has(itemHrid));
    const token = Boolean(index?.tokenShop?.has(itemHrid));
    return drop || token ? { drop, token } : null;
}

/**
 * Whether a recipe has a dungeon input among its direct inputs. The upgrade item counts as a direct
 * input; nothing deeper (an intermediate made from a drop) does.
 *
 * @param {Object} action - The game's action details
 * @param {{drops: Map, tokenShop: Map}} index - From {@link buildDungeonInputIndex}
 * @returns {boolean}
 */
export function hasDungeonInput(action, index) {
    const hrids = (action?.inputItems || []).map((input) => input?.itemHrid);
    if (action?.upgradeItemHrid) hrids.push(action.upgradeItemHrid);
    return hrids.some((hrid) => hrid && dungeonInputKind(hrid, index));
}

/**
 * The crafting materials of one action, priced for this ranking.
 *
 * `materials` are the profit calculator's own per-action lines, so the Artisan-reduced `amount` (not
 * `baseAmount`) and its buy-side price are what a non-dungeon input costs. Dungeon inputs are re-priced:
 *
 * - `market`: the drop's after-tax sale value from `valueDrop`, else for a token-shop item the token
 *   route from `valueToken`; neither answering makes the input **unpriced**, not free.
 * - `buy`: the calculator's own buy-side price, untaxed. A token-shop item takes the cheaper of that and the
 *   token route (an owned token is a cheaper way in than the market). Neither priced is **unpriced**.
 * - `sunk`: 0, flagged `sunk`.
 *
 * The same item may appear on more than one line; each is priced on its own.
 *
 * @param {Object} args - Inputs
 * @param {Array<{itemHrid: string, amount: number, totalCost: number, missingPrice?: boolean}>} args.materials -
 *   The calculator's `materialCosts`
 * @param {{drops: Map, tokenShop: Map}} args.index - From {@link buildDungeonInputIndex}
 * @param {string} args.ownedMode - {@link OWNED_MODES}
 * @param {(itemHrid: string) => number|null} args.valueDrop - After-tax sale value of one unit, or null
 *   when nothing real prices it
 * @param {(itemHrid: string) => number|null} args.valueToken - After-tax value of one unit bought with
 *   tokens, or null
 * @returns {{costPerAction: number, unpriced: Array<{itemHrid: string, reason: string}>,
 *   dungeonInputs: Array<Object>, estimated: string[]}} `costPerAction` is meaningful only when `unpriced` is empty
 */
export function priceCraftMaterials({ materials, index, ownedMode, valueDrop, valueToken }) {
    const mode = normalizeOwnedMode(ownedMode);
    const unpriced = [];
    const dungeonInputs = [];
    // Inputs whose price is only the game's value-map estimate: usable, but the row says so
    const estimated = [];
    let costPerAction = 0;

    for (const material of materials || []) {
        const amount = Number(material?.amount) || 0;
        const kind = dungeonInputKind(material?.itemHrid, index);

        if (!kind) {
            if (material?.missingPrice) {
                unpriced.push({ itemHrid: material.itemHrid, reason: 'input' });
                continue;
            }
            costPerAction += Number(material?.totalCost) || 0;
            if (material?.estimatedPrice) estimated.push(material.itemHrid);
            continue;
        }

        if (mode === OWNED_MODES.SUNK) {
            dungeonInputs.push({ itemHrid: material.itemHrid, amount, unitValue: 0, sunk: true, via: null, kind });
            continue;
        }

        if (mode === OWNED_MODES.BUY) {
            const bought = material?.missingPrice ? null : Number(material?.askPrice);
            const buyPrice = bought > 0 ? bought : null;
            const tokenPrice = kind.token ? valueToken?.(material.itemHrid) : null;
            const candidates = [];
            if (buyPrice) candidates.push({ unitValue: buyPrice, via: 'buy' });
            if (tokenPrice > 0) candidates.push({ unitValue: tokenPrice, via: 'token' });
            if (candidates.length === 0) {
                unpriced.push({ itemHrid: material.itemHrid, reason: 'dungeon-input' });
                continue;
            }
            const best = candidates.reduce((low, next) => (next.unitValue < low.unitValue ? next : low));
            costPerAction += best.unitValue * amount;
            if (best.via === 'buy' && material?.estimatedPrice) estimated.push(material.itemHrid);
            dungeonInputs.push({ itemHrid: material.itemHrid, amount, ...best, sunk: false, kind });
            continue;
        }

        // Selling what you hold is the alternative to using it; for a drop that can be sold that is the
        // figure. A shop item the market will not price is valued through the tokens it costs.
        let unitValue = kind.drop ? valueDrop?.(material.itemHrid) : null;
        let via = 'sale';
        if (!(unitValue > 0) && kind.token) {
            unitValue = valueToken?.(material.itemHrid);
            via = 'token';
        }
        if (!(unitValue > 0)) {
            unpriced.push({ itemHrid: material.itemHrid, reason: 'dungeon-input' });
            continue;
        }
        costPerAction += unitValue * amount;
        dungeonInputs.push({ itemHrid: material.itemHrid, amount, unitValue, sunk: false, via, kind });
    }

    return { costPerAction, unpriced, dungeonInputs, estimated };
}

/**
 * One craft's per-unit figures, from the calculator's answer and the re-priced materials.
 *
 * Gourmet copies come out of the same inputs, so they divide the material cost; efficiency does not (each
 * repeat consumes its own inputs), and neither does it change the cost of a unit. `otherNetPerUnit` is
 * what the calculator counts beyond the sale and the inputs (bonus essence and rare-find drops, tea
 * included in cost, the tax on bonus revenue): it is the part of the calculator's profit that is neither the
 * sale nor the materials nor the drinks, so it can be carried to any sale level without re-deriving it.
 *
 * @param {Object} args - Inputs
 * @param {number} args.materialCostPerAction - From {@link priceCraftMaterials}
 * @param {Object} args.profit - The calculator's answer
 * @param {number} args.taxRate - The market tax rate that applies to this character
 * @returns {{craftCostPerUnit: number, secondsPerUnit: number, otherNetPerUnit: number}|null} Null when the
 *   recipe makes nothing per hour
 */
export function craftUnitFigures({ materialCostPerAction, profit, taxRate }) {
    const itemsPerHour = Number(profit?.totalItemsPerHour) || 0;
    if (!(itemsPerHour > 0)) return null;
    const outputAmount = Number(profit.outputAmount) || 1;
    const gourmet = Number(profit.gourmetBonus) || 0;
    const teaPerHour = Number(profit.totalTeaCostPerHour) || 0;
    const matPerHour = Number(profit.materialCostPerHour) || 0;

    const teaPerUnit = teaPerHour / itemsPerHour;
    const materialPerUnit = materialCostPerAction / (outputAmount * (1 + gourmet));

    // profit = rev(1 - t) + bonus(1 - t) + exempt * t - materials - tea, and revenue is the one term this
    // ranking replaces, so what is left once it, the materials and the tea are taken out is "other"
    const otherNetPerHour =
        (Number(profit.profitPerHour) || 0) -
        (Number(profit.revenuePerHour) || 0) * (1 - taxRate) +
        matPerHour +
        teaPerHour;

    return {
        craftCostPerUnit: materialPerUnit + teaPerUnit,
        secondsPerUnit: SECONDS_PER_HOUR / itemsPerHour,
        otherNetPerUnit: otherNetPerHour / itemsPerHour,
    };
}

/**
 * One level of one row: the cost of getting there, the sale, and what is left.
 *
 * Every price-dependent figure is `null` when its price is missing, and the profit fields are `null`
 * whenever anything the profit rests on is.
 *
 * @param {Object} args - Inputs
 * @param {number} args.level - Enhancement level, 0 for the craft alone
 * @param {number|null} args.craftCostPerUnit - Null when an input is unpriced
 * @param {Array<{itemHrid: string, reason: string}>} args.unpricedInputs - Why the craft cost is null
 * @param {number} args.secondsPerUnit - Craft seconds per unit
 * @param {number} args.otherNetPerUnit - From {@link craftUnitFigures}
 * @param {number|null} args.craftXpPerUnit - Crafting-skill XP per unit, null when unknown
 * @param {{cost: number, seconds: number, xp: number, xpKnown?: boolean}|null} args.enhance - The enhancement
 *   run, null when it cannot be quoted (ignored at level 0)
 * @param {number|null} args.saleAfterTax - The sale at this level after tax, null with no real quote
 * @returns {Object} The level's figures
 */
export function evaluateLevel({
    level,
    craftCostPerUnit,
    unpricedInputs = [],
    secondsPerUnit,
    otherNetPerUnit,
    craftXpPerUnit,
    enhance,
    saleAfterTax,
}) {
    const reasons = [];
    // Each kind of gap keeps its own reason: an unpriced drink is not an unpriced input
    for (const input of unpricedInputs) {
        if (!reasons.includes(input.reason)) reasons.push(input.reason);
    }
    if ((craftCostPerUnit === null || craftCostPerUnit === undefined) && reasons.length === 0) {
        reasons.push('input');
    }
    const craftUnpriced = reasons.length > 0;
    const enhancing = level > 0;
    if (enhancing && !enhance) reasons.push('enhance');
    if (!(saleAfterTax > 0)) reasons.push('sale');
    if (!(secondsPerUnit > 0)) reasons.push('rate');

    const enhanceCost = enhancing ? (enhance ? enhance.cost : null) : 0;
    const enhanceSeconds = enhancing ? (enhance ? enhance.seconds : null) : 0;
    const base = {
        level,
        reasons,
        unpricedInputs,
        enhanceCost,
        saleAfterTax: saleAfterTax > 0 ? saleAfterTax : null,
        craftCostPerUnit: craftUnpriced || reasons.includes('rate') ? null : craftCostPerUnit,
    };

    if (reasons.length > 0) {
        return {
            ...base,
            status: 'unpriced',
            profitPerUnit: null,
            unitsPerHour: null,
            profitPerHour: null,
            craftXpPerHour: null,
            enhanceXpPerHour: null,
        };
    }

    const cycleSeconds = secondsPerUnit + enhanceSeconds;
    const unitsPerHour = SECONDS_PER_HOUR / cycleSeconds;
    const profitPerUnit = saleAfterTax + otherNetPerUnit - craftCostPerUnit - enhanceCost;
    // An XP figure that cannot be known is null, not 0: the tester shop skips the run and teaches nothing
    const enhanceXp = !enhancing ? 0 : enhance.xpKnown === false ? null : enhance.xp;

    return {
        ...base,
        status: 'ok',
        profitPerUnit,
        unitsPerHour,
        profitPerHour: profitPerUnit * unitsPerHour,
        craftXpPerHour: craftXpPerUnit === null || craftXpPerUnit === undefined ? null : craftXpPerUnit * unitsPerHour,
        enhanceXpPerHour: enhanceXp === null ? null : enhanceXp * unitsPerHour,
    };
}

/**
 * One window row.
 *
 * @param {Object} args - Inputs
 * @param {Object} args.recipe - Identity fields: itemHrid, itemName, actionHrid, actionName, skillHrid,
 *   skillLabel, requiredLevel, level, levelMet
 * @param {Object} args.priced - From {@link priceCraftMaterials}
 * @param {Object|null} args.figures - From {@link craftUnitFigures}; null when the recipe makes nothing
 * @param {number|null} args.craftXpPerUnit - Crafting XP per unit, null when unknown
 * @param {number} args.targetLevel - The level the row is rated at, besides +0
 * @param {{cost: number, seconds: number, xp: number, xpKnown?: boolean}|null} args.enhance - Run to the target
 * @param {number|null} args.saleBase - Sale at +0 after tax
 * @param {number|null} args.saleTarget - Sale at the target after tax
 * @param {string[]} [args.notes] - Plain-language caveats for the row's tooltip
 * @returns {Object} A row
 */
export function buildCraftEnhanceRow({
    recipe,
    priced,
    figures,
    craftXpPerUnit,
    targetLevel,
    enhance,
    saleBase,
    saleTarget,
    notes = [],
}) {
    const inputUnpriced = priced.unpriced.length > 0;
    // Null only for an unpriced input; a recipe with no rate fails on the rate, not on a price
    const craftCostPerUnit = inputUnpriced ? null : (figures?.craftCostPerUnit ?? 0);
    const common = {
        craftCostPerUnit,
        unpricedInputs: priced.unpriced,
        secondsPerUnit: figures?.secondsPerUnit ?? 0,
        otherNetPerUnit: figures?.otherNetPerUnit ?? 0,
        craftXpPerUnit,
    };

    const base = evaluateLevel({ ...common, level: 0, enhance: null, saleAfterTax: saleBase });
    const target = evaluateLevel({ ...common, level: targetLevel, enhance, saleAfterTax: saleTarget });

    return {
        ...recipe,
        targetLevel,
        base,
        target,
        dungeonInputs: priced.dungeonInputs,
        estimatedInputs: priced.estimated || [],
        sunkInputs: priced.dungeonInputs.filter((input) => input.sunk).map((input) => input.itemHrid),
        notes,
        // Filled in by the window for visible rows: {known, unitsPerDay}, null until asked
        volume: null,
    };
}

/** The sort keys the window offers, each reading the target level's figure; null sorts behind everything */
export const SORT_LEVELS = Object.freeze({
    hour: 'target',
    unit: 'target',
    craftXp: 'target',
    enhanceXp: 'target',
    base: 'base',
});

export const SORT_KEYS = Object.freeze({
    hour: (row) => row.target.profitPerHour,
    unit: (row) => row.target.profitPerUnit,
    craftXp: (row) => row.target.craftXpPerHour,
    enhanceXp: (row) => row.target.enhanceXpPerHour,
    base: (row) => row.base.profitPerHour,
});

/**
 * Filter and order rows the way the window shows them.
 *
 * A row whose figure for the chosen sort is missing is placed behind every row that has one, whatever
 * the direction, so an unpriced row can never outrank a priced one by having no number.
 *
 * @param {Array<Object>} rows - From {@link buildCraftEnhanceRow}
 * @param {Object} [options] - Options
 * @param {string} [options.sort='hour'] - A key of {@link SORT_KEYS}
 * @param {boolean} [options.descending=true] - Largest first
 * @param {boolean} [options.profitableOnly=false] - Only rows with a full figure that is above zero
 * @param {boolean} [options.craftableOnly=false] - Only rows whose level the player meets
 * @param {string|null} [options.skillHrid=null] - Only this skill
 * @param {string} [options.query=''] - Item or action name contains this
 * @returns {Array<Object>} A new array
 */
export function arrangeCraftEnhanceRows(
    rows,
    {
        sort = 'hour',
        descending = true,
        profitableOnly = false,
        craftableOnly = false,
        skillHrid = null,
        query = '',
    } = {}
) {
    const key = SORT_KEYS[sort] || SORT_KEYS.hour;
    const needle = String(query || '')
        .trim()
        .toLowerCase();

    const kept = (rows || []).filter((row) => {
        if (skillHrid && row.skillHrid !== skillHrid) return false;
        if (craftableOnly && !row.levelMet) return false;
        if (needle && !row.itemName.toLowerCase().includes(needle) && !row.actionName.toLowerCase().includes(needle)) {
            return false;
        }
        if (profitableOnly) {
            // Only a full figure can be profitable: an unpriced row has no profit to be above zero
            if (row.target.status !== 'ok' || !(row.target.profitPerHour > 0)) return false;
        }
        return true;
    });

    const direction = descending ? 1 : -1;
    return kept.sort((a, b) => {
        // A row with no priced target level goes last whatever is sorted
        // A sort reads one level; that level having a full figure is what places a row, so +0 rows sort by
        // +0 even when their +N is unpriced
        const level = SORT_LEVELS[SORT_KEYS[sort] ? sort : 'hour'];
        const aFull = a[level].status === 'ok';
        const bFull = b[level].status === 'ok';
        if (aFull !== bFull) return aFull ? -1 : 1;
        const av = key(a);
        const bv = key(b);
        const aHas = typeof av === 'number' && Number.isFinite(av);
        const bHas = typeof bv === 'number' && Number.isFinite(bv);
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aHas && av !== bv) return (bv - av) * direction;
        return a.itemName.localeCompare(b.itemName);
    });
}

export default {
    OWNED_MODES,
    DEFAULT_TARGET_LEVEL,
    MAX_TARGET_LEVEL,
    SORT_KEYS,
    normalizeTargetLevel,
    normalizeOwnedMode,
    buildDungeonInputIndex,
    dungeonInputKind,
    hasDungeonInput,
    priceCraftMaterials,
    craftUnitFigures,
    evaluateLevel,
    buildCraftEnhanceRow,
    arrangeCraftEnhanceRows,
};
