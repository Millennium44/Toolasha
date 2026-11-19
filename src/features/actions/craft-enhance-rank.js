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
 * Within one recipe a dungeon input is split into the units the character holds and the shortfall:
 *
 * - `market` (default): the units held are valued at what they would fetch if sold now, after the market tax,
 *   which is the opportunity cost of using them. A token-shop input is valued through its token (tokens it costs
 *   times the best coins a token converts to), after tax, the same figure the token tooltip uses.
 * - `sunk`: the units held cost 0.
 * - `buy`: nothing held is counted; every unit is bought.
 *
 * In `market` and `sunk` the units NOT held are bought at the buy side of the pricing mode, like `buy` prices
 * them. One held stack is drawn down once across every line of a recipe that uses the item, so it is never
 * counted for two inputs. The stock is spread over one hour of crafts: what the hour needs beyond it is bought, and
 * the cost per craft is the hour's bill divided by the crafts in the hour.
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
 * Held units by item and level, from the character's inventory.
 *
 * Only stacks in the inventory count (not equipment, not the market). The pool is keyed
 * `${itemHrid}:${enhancementLevel}`, because a production input is consumed at +0 while an upgrade item can be any level.
 *
 * @param {Array<{itemHrid: string, count?: number, enhancementLevel?: number, itemLocationHrid?: string}>|null} inventory -
 *   `dataManager.getInventory()`; null when no inventory is loaded
 * @returns {Map<string, number>|null} Null when the inventory is not loaded, which is not the same as empty: an
 *   empty Map is a character holding nothing
 */
export function buildHeldPool(inventory) {
    if (!Array.isArray(inventory)) return null;
    const pool = new Map();
    for (const stack of inventory) {
        if (stack?.itemLocationHrid !== '/item_locations/inventory') continue;
        const count = Number(stack.count);
        if (!stack.itemHrid || !(count > 0)) continue;
        const key = `${stack.itemHrid}:${Math.max(0, Math.floor(Number(stack.enhancementLevel) || 0))}`;
        pool.set(key, (pool.get(key) || 0) + count);
    }
    return pool;
}

/**
 * The crafting materials of one action, priced for this ranking.
 *
 * `materials` are the profit calculator's own per-action lines, so the Artisan-reduced `amount` (not
 * `baseAmount`) and its buy-side price are what a non-dungeon input costs. Dungeon inputs are re-priced:
 *
 * - `buy`: every unit at the calculator's own buy-side price, untaxed. A token-shop item takes the cheaper of that
 *   and the token route (an owned token is a cheaper way in than the market). Neither priced is **unpriced**.
 *   What the character holds is ignored.
 * - `market` and `sunk`: the units the character holds (from `heldPool`, +0 stacks) are valued as owned and the
 *   shortfall is bought as `buy` prices it. Owned is, for `market`, the drop's after-tax sale value from
 *   `valueDrop`, else for a token-shop item the token route from `valueToken`; for `sunk` it is 0. A line whose
 *   held part or bought part cannot be priced is **unpriced** whole, never a partial sum.
 *
 * One stack is drawn down across the lines: the same item on two lines (or as the upgrade item and an input) cannot
 * be held twice. `heldPool` is not changed. A null `heldPool` (no inventory loaded) holds nothing, so every unit is
 * bought: the safe direction, since owned is never dearer than bought.
 *
 * @param {Object} args - Inputs
 * @param {Array<{itemHrid: string, amount: number, totalCost: number, missingPrice?: boolean}>} args.materials -
 *   The calculator's `materialCosts`
 * @param {{drops: Map, tokenShop: Map}} args.index - From {@link buildDungeonInputIndex}
 * @param {string} args.ownedMode - {@link OWNED_MODES}
 * @param {Map<string, number>|null} [args.heldPool] - From {@link buildHeldPool}
 * @param {number|null} [args.craftsPerHour] - Crafts (actions that consume inputs) in an hour. The held stock is
 *   spread over that hour: each input needs `amount x craftsPerHour`, the stock covers up to that and the rest is
 *   bought, and the cost per craft is the hour's bill divided by `craftsPerHour`. Missing or 0 prices one craft and
 *   sets `perCraftFallback`.
 * @param {(itemHrid: string) => number|null} args.valueDrop - After-tax sale value of one unit, or null
 *   when nothing real prices it
 * @param {(itemHrid: string) => number|null} args.valueToken - After-tax value of one unit bought with
 *   tokens, or null
 * @param {(itemHrid: string) => boolean} [args.tokenEstimated] - Whether `valueToken`'s figure rests on a
 *   value-map price (an estimate), so a row valued through tokens says so like a bought input does
 * @param {(material: Object) => number} [args.amountOf] - Units one craft consumes of a line, when that is not
 *   the calculator's own averaged `amount` (Artisan worst case rounds each craft up). A line priced at an
 *   amount other than the calculator's is costed as its buy price times that amount.
 * @returns {{costPerAction: number, unpriced: Array<{itemHrid: string, reason: string}>,
 *   dungeonInputs: Array<Object>, estimated: string[], heldInputs: Array<Object>}} `costPerAction` is meaningful
 *   only when `unpriced` is empty. `dungeonInputs` has one entry per priced portion (`held` says which);
 *   `heldInputs` is per item: `{itemHrid, needed, held, bought, stock}` for the units the hour needs, the part
 *   covered from the stack, the shortfall, and the whole +0 stack. `dungeonInputs` amounts are per craft.
 */
export function priceCraftMaterials({
    materials,
    index,
    ownedMode,
    heldPool = null,
    craftsPerHour = null,
    valueDrop,
    valueToken,
    tokenEstimated,
    amountOf,
}) {
    const mode = normalizeOwnedMode(ownedMode);
    const unpriced = [];
    const dungeonInputs = [];
    // Inputs whose price is only the game's value-map estimate: usable, but the row says so
    const estimated = [];
    const heldSummary = new Map();
    // Drawn down as lines use it; a copy, so one row never spends another's stack
    const remaining = new Map(heldPool || []);
    // Crafts in the hour the stock is spread over. Unknown or 0 falls back to one craft, which the result flags
    const hourKnown = Number(craftsPerHour) > 0;
    const crafts = hourKnown ? Number(craftsPerHour) : 1;
    let costPerAction = 0;

    /** What buying one unit costs: the buy side, or for a token-shop item the cheaper token route */
    const boughtPrice = (material, kind) => {
        const bought = material?.missingPrice ? null : Number(material?.askPrice);
        const buyPrice = bought > 0 ? bought : null;
        const tokenPrice = kind.token ? valueToken?.(material.itemHrid) : null;
        const candidates = [];
        if (buyPrice) candidates.push({ unitValue: buyPrice, via: 'buy' });
        if (tokenPrice > 0) candidates.push({ unitValue: tokenPrice, via: 'token' });
        if (candidates.length === 0) return null;
        return candidates.reduce((low, next) => (next.unitValue < low.unitValue ? next : low));
    };
    /** What using one unit already held costs: its sale (or token) value, or 0 when sunk */
    const ownedPrice = (material, kind) => {
        if (mode === OWNED_MODES.SUNK) return { unitValue: 0, via: null };
        // Selling what you hold is the alternative to using it; for a drop that can be sold that is the
        // figure. A shop item the market will not price is valued through the tokens it costs.
        let unitValue = kind.drop ? valueDrop?.(material.itemHrid) : null;
        let via = 'sale';
        if (!(unitValue > 0) && kind.token) {
            unitValue = valueToken?.(material.itemHrid);
            via = 'token';
        }
        return unitValue > 0 ? { unitValue, via } : null;
    };
    const noteEstimated = (material, price) => {
        if (price.via === 'buy' && material?.estimatedPrice) estimated.push(material.itemHrid);
        if (price.via === 'token' && tokenEstimated?.(material.itemHrid)) estimated.push(material.itemHrid);
    };

    for (const material of materials || []) {
        const calculatorAmount = Number(material?.amount) || 0;
        const amount = amountOf ? Number(amountOf(material)) || 0 : calculatorAmount;
        const kind = dungeonInputKind(material?.itemHrid, index);

        if (!kind) {
            if (material?.missingPrice) {
                unpriced.push({ itemHrid: material.itemHrid, reason: 'input' });
                continue;
            }
            costPerAction +=
                amount === calculatorAmount
                    ? Number(material?.totalCost) || 0
                    : (Number(material?.askPrice) || 0) * amount;
            if (material?.estimatedPrice) estimated.push(material.itemHrid);
            continue;
        }

        // Units of this line covered by the stack: none in `buy`, and none when nothing is known to be held
        const key = `${material.itemHrid}:0`;
        const stock = mode === OWNED_MODES.BUY ? 0 : remaining.get(key) || 0;
        // The stock is spread over the hour's crafts: it covers min(held, hour need) and the rest is bought
        const hourNeed = amount * crafts;
        const heldUnits = Math.min(stock, hourNeed);
        const boughtUnits = hourNeed - heldUnits > 1e-9 ? hourNeed - heldUnits : 0;

        const own = heldUnits > 0 ? ownedPrice(material, kind) : null;
        const buy = boughtUnits > 0 ? boughtPrice(material, kind) : null;
        // A line with a part that cannot be priced is unpriced whole; a partial sum would read as a full price
        if ((heldUnits > 0 && !own) || (boughtUnits > 0 && !buy)) {
            unpriced.push({ itemHrid: material.itemHrid, reason: 'dungeon-input' });
            continue;
        }

        if (mode !== OWNED_MODES.BUY) {
            remaining.set(key, stock - heldUnits);
            const seen = heldSummary.get(material.itemHrid) || {
                itemHrid: material.itemHrid,
                needed: 0,
                held: 0,
                bought: 0,
                stock: heldPool?.get(key) || 0,
            };
            seen.needed += hourNeed;
            seen.held += heldUnits;
            seen.bought += boughtUnits;
            heldSummary.set(material.itemHrid, seen);
        }
        if (own) {
            costPerAction += (own.unitValue * heldUnits) / crafts;
            noteEstimated(material, own);
            dungeonInputs.push({
                itemHrid: material.itemHrid,
                amount: heldUnits / crafts,
                unitValue: own.unitValue,
                sunk: mode === OWNED_MODES.SUNK,
                via: own.via,
                kind,
                held: true,
            });
        }
        if (buy) {
            costPerAction += (buy.unitValue * boughtUnits) / crafts;
            noteEstimated(material, buy);
            dungeonInputs.push({
                itemHrid: material.itemHrid,
                amount: boughtUnits / crafts,
                ...buy,
                sunk: false,
                kind,
                held: false,
            });
        }
    }

    return {
        costPerAction,
        unpriced,
        dungeonInputs,
        estimated,
        heldInputs: [...heldSummary.values()],
        craftsPerHour: crafts,
        perCraftFallback: !hourKnown,
    };
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
 * @param {{cost: number, seconds: number, xp: number, xpKnown?: boolean, extraCraftSeconds?: number,
 *   extraCraftXp?: number|null}|null} args.enhance - The enhancement run, null when it cannot be quoted (ignored at
 *   level 0). `extraCraftSeconds` and `extraCraftXp` are the crafts of the protection copies the run spends at craft
 *   price, per finished item: more time in the cycle and more crafting XP, apart from the enhancing time and XP
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

    // Protection copies crafted at craft price are crafts too: their seconds are in the cycle, their XP in the craft XP
    const extraCraftSeconds = enhancing ? Number(enhance.extraCraftSeconds) || 0 : 0;
    const extraCraftXp = enhancing ? (enhance.extraCraftXp === null ? null : Number(enhance.extraCraftXp) || 0) : 0;
    const cycleSeconds = secondsPerUnit + enhanceSeconds + extraCraftSeconds;
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
        craftXpPerHour:
            craftXpPerUnit === null || craftXpPerUnit === undefined || extraCraftXp === null
                ? null
                : (craftXpPerUnit + extraCraftXp) * unitsPerHour,
        enhanceXpPerHour: enhanceXp === null ? null : enhanceXp * unitsPerHour,
    };
}

/**
 * The ways a refined (star) item reaches +N: enhance the star item itself, enhance its cheaper base first, or start
 * from a base the character already holds (at its held level) and enhance it the rest of the way
 */
export const ENHANCE_ROUTES = Object.freeze({ DIRECT: 'craft', BASE: 'refine-base', HELD_BASE: 'held-base' });

/**
 * Pick the enhancement route for a level.
 *
 * A refined recipe keeps the enhancement of the base it upgrades, so +N can be reached by enhancing the star item
 * after the refinement (`direct`) or by enhancing the cheaper base and then refining it (`viaBase`). Either quote
 * is null when that run cannot be priced (a material, protection or drink with no price, no enhancement recipe,
 * the tester shop's guaranteed copy), and a null route is never chosen and never counted as free: a route that
 * cannot be priced is simply not a candidate. Both null leaves no enhancement run, which the level reads as
 * unpriced. The cheaper cost wins; a tie keeps the direct route, which needs nothing extra to explain.
 *
 * Nothing is enhanced at +0 (or below), so there is no route to choose.
 *
 * @param {Object} args - Inputs
 * @param {number} args.level - The level being rated
 * @param {Object|null} args.direct - Quote for enhancing the item itself, from 0 to the level
 * @param {Object|null} [args.viaBase] - Quote for enhancing the base from 0 to the level; omitted or null for a
 *   recipe with no refinement route
 * @returns {{route: string|null, enhance: Object|null, directCost: number|null, baseCost: number|null,
 *   saved: number}} `saved` is what the winner saves over the other priced route, 0 when only one is priced
 */
export function chooseEnhanceRoute({ level, direct, viaBase }) {
    if (!(level > 0)) return { route: null, enhance: null, directCost: null, baseCost: null, saved: 0 };
    const directCost = direct ? direct.cost : null;
    const baseCost = viaBase ? viaBase.cost : null;
    const useBase = viaBase && (!direct || viaBase.cost < direct.cost);
    const chosen = useBase ? viaBase : direct || null;
    return {
        route: chosen ? (useBase ? ENHANCE_ROUTES.BASE : ENHANCE_ROUTES.DIRECT) : null,
        enhance: chosen,
        directCost,
        baseCost,
        saved: direct && viaBase ? Math.abs(direct.cost - viaBase.cost) : 0,
    };
}

/**
 * The level with the best profit per hour among a sweep's levels.
 *
 * Only a level with a full figure counts: a level with no sale quote, an enhancement run that cannot be priced or an
 * unpriced input has no profit, so it is skipped, never read as 0. This is the uncapped figure (the market's volume is
 * not asked for at every level). A tie goes to the lower level: the same hour for less enhancing.
 *
 * @param {Array<Object>} sweep - Levels in ascending order, each an `evaluateLevel` result
 * @returns {{level: number, profitPerHour: number, profitPerUnit: number, route: string|null}|null} Null when no
 *   level has a full figure
 */
export function bestLevelOf(sweep) {
    let best = null;
    for (const entry of sweep) {
        if (entry.status !== 'ok' || !Number.isFinite(entry.profitPerHour)) continue;
        if (best === null || entry.profitPerHour > best.profitPerHour) {
            best = {
                level: entry.level,
                profitPerHour: entry.profitPerHour,
                profitPerUnit: entry.profitPerUnit,
                route: entry.route ?? null,
            };
        }
    }
    return best;
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
 *   on the item itself
 * @param {{cost: number, seconds: number, xp: number, xpKnown?: boolean}|null} [args.viaBase] - Run to the target
 *   on the base item of a refinement, which is then refined (see {@link chooseEnhanceRoute}); omit when the
 *   recipe has no such route
 * @param {string|null} [args.baseHrid] - The base the refinement route enhances, for the tooltip
 * @param {Array<Object>} [args.heldBases] - Candidates that start from a base the character holds, one per held
 *   level at or below the target: `{level, count, coverage, unitValue, via, enhance, craftCostPerUnit,
 *   secondsPerUnit, otherNetPerUnit, craftXpPerUnit}`. `coverage` (0 to 1, default 1) is the share of the hour's
 *   crafts the held stack can serve; the rest are rated on the fresh route and the figures are blended. The base's own price is already inside `craftCostPerUnit` (and the chain
 *   a bought base needs is already out of `secondsPerUnit` and the XP). A candidate with no `enhance` or no
 *   `craftCostPerUnit` is not priceable and is never chosen. They apply to the target level only: a held +3 base
 *   makes a +3 item, so it cannot lower the +0 figure.
 * @param {Array<{level: number, enhance: Object|null, viaBase?: Object|null, heldBases?: Array<Object>,
 *   saleAfterTax: number|null}>} [args.levels] - The levels from +1 up to (not including) the target, each with the
 *   runs to that level and its sale, for the sweep; omitted, the sweep holds +0 and the target only
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
    viaBase = null,
    baseHrid = null,
    heldBases = [],
    levels = [],
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

    // The held base covers `coverage` of the hour's crafts (its stack over the crafts the hour needs, at most 1); the
    // rest of the crafts take the fresh route, so every per-unit figure is the blend of the two. A candidate that
    // leaves crafts uncovered when the fresh route cannot be priced has no figure for them and is not a candidate.
    const mix = (heldValue, freshValue, share) =>
        share >= 1
            ? heldValue
            : Number.isFinite(heldValue) && Number.isFinite(freshValue)
              ? share * heldValue + (1 - share) * freshValue
              : null;
    // An unknown XP (null) in either part of a blend is unknown; a missing one is none
    const mixExtraXp = (heldXp, freshXp, share) =>
        heldXp === null || (share < 1 && freshXp === null)
            ? null
            : mix(Number(heldXp) || 0, Number(freshXp) || 0, share);
    /**
     * One level of the row: the route to it chosen by the same rules at every level (the item itself, the base
     * first then refined, a held base at or below the level), and that route's figures. The target and every level of
     * the sweep go through here, so +N in the sweep is the row's own +N by construction.
     * @param {number} level - The level (1 or more)
     * @param {Object} inputs - `enhance` (item itself), `viaBase`, `candidates` (held bases at or below the level,
     *   each with its `enhance` to this level) and `saleAfterTax`
     * @returns {{route: Object, result: Object}}
     */
    const rateLevel = (level, { enhance, viaBase, candidates, saleAfterTax }) => {
        const chosen = chooseEnhanceRoute({ level, direct: enhance, viaBase });

        // The routes above share one craft cost, so the enhancement run alone told them apart. A held base changes the
        // craft side too (its price, its missing chain), so it is compared on craft plus enhancement, and only against
        // a fresh route that has both. A fresh route that cannot be priced leaves any priceable held base the winner.
        const freshTotal =
            chosen.enhance && craftCostPerUnit !== null ? craftCostPerUnit + Number(chosen.enhance.cost) : null;
        let held = null;
        for (const candidate of candidates) {
            if (!candidate?.enhance || !Number.isFinite(candidate.craftCostPerUnit)) continue;
            const share = Math.min(1, Math.max(0, Number(candidate.coverage ?? 1)));
            if (!(share > 0)) continue;
            if (share < 1 && (freshTotal === null || !chosen.enhance)) continue;
            const heldTotal = candidate.craftCostPerUnit + Number(candidate.enhance.cost);
            if (!Number.isFinite(heldTotal)) continue;
            // A part-covering candidate prices the fresh crafts of its hour with the shared inputs spread over that
            // mixed hour; the standalone fresh figure would spread them over a different hour
            const freshCraft =
                share < 1 && Number.isFinite(candidate.freshCraftCostPerUnit)
                    ? candidate.freshCraftCostPerUnit
                    : craftCostPerUnit;
            const freshMixedTotal = freshTotal === null ? null : freshCraft + Number(chosen.enhance.cost);
            // The whole blended hour must beat staying fresh: a mixed hour can run out of shared stock the fresh
            // hour alone would not, so a cheaper held portion is not enough
            const total = mix(heldTotal, freshMixedTotal, share);
            if (!(total < (freshTotal ?? Infinity))) continue;
            if (held && !(total < held.total)) continue;
            const fresh = chosen.enhance;
            const enhanceXpKnown = candidate.enhance.xpKnown !== false && (share >= 1 || fresh.xpKnown !== false);
            held = {
                ...candidate,
                share,
                total,
                craftCostPerUnit: mix(candidate.craftCostPerUnit, freshCraft, share),
                secondsPerUnit: mix(candidate.secondsPerUnit, common.secondsPerUnit, share),
                otherNetPerUnit: mix(candidate.otherNetPerUnit, common.otherNetPerUnit, share),
                craftXpPerUnit:
                    candidate.craftXpPerUnit === null || candidate.craftXpPerUnit === undefined
                        ? null
                        : mix(candidate.craftXpPerUnit, craftXpPerUnit, share),
                enhance: {
                    ...candidate.enhance,
                    cost: mix(Number(candidate.enhance.cost), Number(fresh?.cost), share),
                    seconds: mix(Number(candidate.enhance.seconds), Number(fresh?.seconds), share),
                    xp: mix(Number(candidate.enhance.xp), Number(fresh?.xp), share),
                    xpKnown: enhanceXpKnown,
                    // The crafted protection copies of the blended hour (an unknown XP stays unknown)
                    selfCopyCrafts: mix(
                        Number(candidate.enhance.selfCopyCrafts) || 0,
                        Number(fresh?.selfCopyCrafts) || 0,
                        share
                    ),
                    extraCraftSeconds: mix(
                        Number(candidate.enhance.extraCraftSeconds) || 0,
                        Number(fresh?.extraCraftSeconds) || 0,
                        share
                    ),
                    extraCraftXp: mixExtraXp(candidate.enhance.extraCraftXp, fresh?.extraCraftXp, share),
                },
            };
        }

        let route = { ...chosen, offered: Boolean(baseHrid), baseHrid: baseHrid || null, heldBase: null };
        let result;
        if (held) {
            route = {
                ...route,
                route: ENHANCE_ROUTES.HELD_BASE,
                enhance: held.enhance,
                heldBase: {
                    level: held.level,
                    count: held.count,
                    unitValue: held.unitValue,
                    via: held.via,
                    total: held.total,
                    // The share of the hour's crafts the held stack covers; the rest take the fresh route
                    coverage: held.share,
                    // Null when the fresh routes could not be priced, so nothing was compared
                    saved: freshTotal === null ? null : freshTotal - held.total,
                },
            };
            result = evaluateLevel({
                level,
                craftCostPerUnit: held.craftCostPerUnit,
                unpricedInputs: [],
                secondsPerUnit: held.secondsPerUnit,
                otherNetPerUnit: held.otherNetPerUnit,
                craftXpPerUnit: held.craftXpPerUnit,
                enhance: held.enhance,
                saleAfterTax,
            });
        } else {
            result = evaluateLevel({ ...common, level, enhance: chosen.enhance, saleAfterTax });
        }
        return { route, result };
    };

    const rated = rateLevel(targetLevel, { enhance, viaBase, candidates: heldBases, saleAfterTax: saleTarget });
    const route = rated.route;
    const target = rated.result;

    // Every level from +0 to the target, each on its own best route. A level with no full figure is kept in the list
    // with its reasons, so the tooltip can say why it is missing, and is never a candidate for the best level.
    const sweep = [{ ...base, route: null }];
    for (const spec of [...levels].sort((a, b) => a.level - b.level)) {
        if (!(spec.level > 0) || spec.level >= targetLevel) continue;
        const { route: levelRoute, result } = rateLevel(spec.level, {
            enhance: spec.enhance ?? null,
            viaBase: spec.viaBase ?? null,
            candidates: spec.heldBases ?? [],
            saleAfterTax: spec.saleAfterTax,
        });
        sweep.push({ ...result, route: levelRoute.route });
    }
    sweep.push({ ...target, route: route.route });
    const best = bestLevelOf(sweep);

    return {
        ...recipe,
        targetLevel,
        base,
        target,
        // Every level 0..N rated on its own best route, and the one with the best profit per hour
        sweep,
        best,
        // Which way +N is reached; `offered` is whether the recipe has a base route at all
        route,
        dungeonInputs: priced.dungeonInputs,
        heldInputs: priced.heldInputs || [],
        estimatedInputs: priced.estimated || [],
        sunkInputs: [
            ...new Set(priced.dungeonInputs.filter((input) => input.sunk && input.amount > 0).map((i) => i.itemHrid)),
        ],
        notes,
        // Filled in by the window for visible rows: {known, unitsPerDay}, null until asked
        volume: null,
    };
}

/**
 * A level's profit per hour once the market's traded volume is taken into account: no more units an hour can be
 * sold than the market takes (`unitsPerDay / 24`), so a faster maker is held to that.
 *
 * Only a measured volume caps (`known`): an unknown one is not 0, and 0 is only ever a measured 0. Only a positive
 * profit per unit is capped: with a loss on every unit, making fewer of them is not a better hour to show, so a
 * losing level keeps its uncapped figure. A level without a full figure has nothing to cap. The row is not changed;
 * the ranking and the sort keep the uncapped figure, so rows do not reorder as volumes arrive.
 *
 * @param {Object} level - A row's `base` or `target`
 * @param {{known?: boolean, unitsPerDay?: number}|null|undefined} volume - From the liquidity module, when asked
 * @returns {{capped: boolean, profitPerHour: number|null, uncappedPerHour: number|null, unitsPerHourCap: number|null}}
 */
export function capProfitByVolume(level, volume) {
    const uncapped = Number.isFinite(level?.profitPerHour) ? level.profitPerHour : null;
    const none = { capped: false, profitPerHour: uncapped, uncappedPerHour: uncapped, unitsPerHourCap: null };
    if (uncapped === null || level.status !== 'ok') return none;
    if (!volume || volume.known !== true || !Number.isFinite(volume.unitsPerDay) || volume.unitsPerDay < 0) return none;
    if (!(level.profitPerUnit > 0) || !(level.unitsPerHour > 0)) return none;
    const unitsPerHourCap = volume.unitsPerDay / 24;
    if (unitsPerHourCap >= level.unitsPerHour) return { ...none, unitsPerHourCap };
    return {
        capped: true,
        profitPerHour: level.profitPerUnit * unitsPerHourCap,
        uncappedPerHour: uncapped,
        unitsPerHourCap,
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
    buildHeldPool,
    buildDungeonInputIndex,
    dungeonInputKind,
    hasDungeonInput,
    priceCraftMaterials,
    craftUnitFigures,
    evaluateLevel,
    chooseEnhanceRoute,
    ENHANCE_ROUTES,
    buildCraftEnhanceRow,
    arrangeCraftEnhanceRows,
    capProfitByVolume,
};
