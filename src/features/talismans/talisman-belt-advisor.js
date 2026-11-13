/**
 * Talisman belt advisor
 *
 * Test server only. Answers "which belt upgrade is worth buying, against what it costs?" for the talismans the
 * player has slotted now: every candidate belt is valued by re-running the same valuation the Talisman lines ranking
 * uses (the sim for combat, the skilling math for skilling) with the candidate swapped in for the belt worn, and
 * priced from the market. This module holds what both surfaces share: the candidates, the prices, the gain per cost
 * and the order, plus the exact skilling run. The combat run is in combat-sim/talisman-belt-run.js.
 *
 * A candidate belt is the current one at higher enhancement levels, or a larger belt (more slots) at +0 and at the
 * current level. A larger belt's extra slots are empty, so they are worth nothing here and the row says so; no
 * talisman is invented for them.
 *
 * Prices: only a live order-book quote (or the player's own price) counts. An estimate from the game's value map is
 * not a quote, and a missing price is never zero: the row is unpriced, has no gain per cost and sorts last. Nothing is
 * priced from the Tester shop.
 *
 * Stateless: everything a run needs is passed in or read live on each call.
 */

import { isTestServer } from '../../utils/game-server.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { testerShopEnabled } from '../../utils/tester-shop.js';
import {
    BELT_LOCATION,
    attachTalismanBonuses,
    getBeltSlotCount,
    getTalismanPower,
    isEmptyTalismanBonuses,
    talismanBonusesOf,
} from '../../utils/talisman-bonuses.js';
import {
    SKILLING_RANKING_METRICS,
    RANKABLE_SKILLING_TYPES,
    EXACT_UNPRICED_TOLERANCE,
    newlyUnpricedLineCosts,
} from '../../utils/talisman-line-sets.js';
import { calculateDirectEnhancementCost } from '../combat-sim/direct-enhancement-cost.js';
import { benchNote, enhancementParamsFor } from '../enhancement/enhancement-params-source.js';

/** The equipment type of a Talisman Belt */
export const BELT_EQUIPMENT_TYPE = '/equipment_types/belt';

/** The highest enhancement level a candidate is offered at */
export const MAX_BELT_LEVEL = 20;

/** How many levels above the current one are always offered */
export const NEXT_LEVELS = 3;

/** The higher levels offered whatever the current one is */
export const LANDMARK_LEVELS = Object.freeze([10, 15, 20]);

/** Gain per cost is quoted per this many coins */
export const COST_UNIT = 100_000_000;

/** What a row's cost can mean (the Cost select) */
export const COST_BASES = [
    {
        key: 'market',
        label: 'Buy',
        help: 'The market price of the candidate belt at that level, at the Buy price your profit pricing mode uses. Your current belt is not counted.',
    },
    {
        key: 'net',
        label: 'Buy, sell mine',
        help: 'The market price of the candidate less what your current belt sells for after the market tax (the profit pricing mode’s Sell price). Can be zero or below when your belt pays for it.',
    },
    {
        key: 'enhance',
        label: 'Enhance (estimate)',
        help: 'What enhancing it costs, as the enhancement tooltip estimates it (expected cost, cheapest protection), on the bench that tooltip uses: your own, or Pro rates or your manual simulator stats when those are set, which the result then names. Your current belt up to the level; a larger belt is bought at +0 first. Not available while Tester-shop pricing is on.',
    },
];

/** The cost basis used when none is chosen */
export const DEFAULT_COST_BASIS = 'market';

/**
 * Every Talisman Belt the game data lists, smallest first.
 * @param {Object} itemDetailMap
 * @returns {Array<{hrid: string, name: string, slots: number}>}
 */
export function listBelts(itemDetailMap) {
    const belts = [];
    for (const [hrid, item] of Object.entries(itemDetailMap || {})) {
        const detail = item?.equipmentDetail;
        if (detail?.type !== BELT_EQUIPMENT_TYPE) continue;
        const slots = getBeltSlotCount({ itemHrid: hrid }, itemDetailMap);
        if (slots === 0) continue;
        belts.push({ hrid, name: item.name || hrid, slots, base: detail.combatStats?.talismanPower || 0 });
    }
    return belts.sort((a, b) => a.slots - b.slots || a.base - b.base);
}

/**
 * The belts worth pricing against the one worn: the same belt at higher levels (the next few and the landmark
 * levels), and each larger belt at +0 and at the current level.
 * @param {{hrid: string, enhancementLevel?: number}|null} current - The belt worn (an Equipment: `hrid`)
 * @param {Object} itemDetailMap
 * @param {number[]|undefined} enhancementTable
 * @param {Object} [options]
 * @param {number} [options.maxLevel]
 * @returns {Array<{key: string, kind: 'enhance'|'larger', hrid: string, name: string, level: number, slots: number,
 *   power: number, emptySlots: number}>} In the order they are tried
 */
export function beltCandidates(current, itemDetailMap, enhancementTable, { maxLevel = MAX_BELT_LEVEL } = {}) {
    if (!current?.hrid) return [];
    const currentLevel = Math.max(0, Math.floor(Number(current.enhancementLevel) || 0));
    const currentSlots = getBeltSlotCount({ itemHrid: current.hrid }, itemDetailMap);
    if (currentSlots === 0) return [];
    const make = (hrid, level, kind) => {
        const slots = getBeltSlotCount({ itemHrid: hrid }, itemDetailMap);
        return {
            key: `${hrid}@${level}`,
            kind,
            hrid,
            name: itemDetailMap?.[hrid]?.name || hrid,
            level,
            slots,
            power: getTalismanPower({ itemHrid: hrid, enhancementLevel: level }, itemDetailMap, enhancementTable),
            emptySlots: Math.max(0, slots - currentSlots),
        };
    };
    const levels = new Set();
    for (let step = 1; step <= NEXT_LEVELS; step++) levels.add(currentLevel + step);
    for (const level of LANDMARK_LEVELS) if (level > currentLevel) levels.add(level);
    const out = [...levels]
        .filter((level) => level <= maxLevel)
        .sort((a, b) => a - b)
        .map((level) => make(current.hrid, level, 'enhance'));
    for (const belt of listBelts(itemDetailMap)) {
        if (belt.slots <= currentSlots) continue;
        out.push(make(belt.hrid, 0, 'larger'));
        if (currentLevel > 0) out.push(make(belt.hrid, currentLevel, 'larger'));
    }
    return out;
}

/**
 * A live market quote for a belt at a level, or null. Only an order-book price or the player's own counts: a value-map
 * estimate is not what a belt costs (it ignores the level), and a missing price is not zero.
 * @param {string} hrid
 * @param {number} level
 * @param {'buy'|'sell'} side
 * @param {Function} [priceInfo] - getItemPriceInfo-shaped; injectable for tests
 * @returns {number|null}
 */
export function quoteBelt(hrid, level, side, priceInfo = getItemPriceInfo) {
    let quote = null;
    try {
        quote = priceInfo(hrid, { enhancementLevel: level, context: 'profit', side, marketQuote: true });
    } catch (error) {
        console.error('[TalismanBeltAdvisor] Pricing a belt failed:', error);
    }
    if (quote && (quote.source === 'book' || quote.source === 'custom') && quote.price > 0) return quote.price;
    return null;
}

/**
 * What a belt sells for after the market tax, or null without a quote.
 * @param {{hrid: string, enhancementLevel?: number}} belt
 * @param {Object} deps - `{priceInfo, afterTax}`
 * @returns {number|null}
 */
function proceedsOf(belt, deps) {
    const price = quoteBelt(belt.hrid, belt.enhancementLevel || 0, 'sell', deps.priceInfo);
    return price === null ? null : Math.floor(deps.afterTax(price));
}

/**
 * The cost of every candidate on every basis. A basis that cannot be priced says why and has no number.
 *
 * @param {Object} candidate - From {@link beltCandidates}
 * @param {{hrid: string, enhancementLevel?: number}} current - The belt worn
 * @param {Object} gameData - `itemDetailMap` for the enhancement estimate
 * @param {Object} [deps] - `{priceInfo, afterTax, testerOn, enhanceCost, bench}`; real ones by default
 * @returns {{market: {price: number|null, reason?: string}, net: Object, enhance: Object}}
 */
export function beltCosts(candidate, current, gameData, deps = {}) {
    const d = {
        priceInfo: getItemPriceInfo,
        afterTax: (price) => calculatePriceAfterTax(price),
        testerOn: () => testerShopEnabled(),
        enhanceCost: calculateDirectEnhancementCost,
        // The bench the estimate above runs on, when it is not the player's own (Pro rates, a manual bench)
        bench: (hrid) => {
            try {
                return benchNote(enhancementParamsFor('advisor', hrid));
            } catch (error) {
                console.error('[TalismanBeltAdvisor] Could not name the enhancement bench:', error);
                return null;
            }
        },
        ...deps,
    };
    const label = `${candidate.name} +${candidate.level}`;
    const buy = quoteBelt(candidate.hrid, candidate.level, 'buy', d.priceInfo);
    const market = buy === null ? { price: null, reason: `No market listing for ${label}.` } : { price: buy };

    let net;
    if (buy === null) {
        net = { price: null, reason: market.reason };
    } else {
        const proceeds = proceedsOf(current, d);
        net =
            proceeds === null
                ? {
                      price: null,
                      reason: 'Your current belt has no market listing to sell at, so its resale is unknown.',
                  }
                : { price: buy - proceeds, resale: proceeds };
    }

    let enhance;
    if (d.testerOn()) {
        enhance = {
            price: null,
            reason: 'Tester-shop pricing is on in Settings: the enhancement estimate would use shop prices that live never charges.',
        };
    } else if (candidate.kind === 'enhance') {
        const cost = d.enhanceCost(candidate.hrid, current.enhancementLevel || 0, candidate.level, gameData);
        enhance =
            typeof cost === 'number' && cost >= 0
                ? { price: cost, bench: d.bench(candidate.hrid) || null }
                : {
                      price: null,
                      reason: 'The enhancement cost cannot be estimated (a material or protection has no price).',
                  };
    } else {
        const base = quoteBelt(candidate.hrid, 0, 'buy', d.priceInfo);
        if (base === null) {
            enhance = { price: null, reason: `No market listing for ${candidate.name} +0 to enhance from.` };
        } else if (candidate.level === 0) {
            enhance = { price: base, bench: null };
        } else {
            const cost = d.enhanceCost(candidate.hrid, 0, candidate.level, gameData);
            enhance =
                typeof cost === 'number' && cost >= 0
                    ? { price: base + cost, bench: d.bench(candidate.hrid) || null }
                    : {
                          price: null,
                          reason: 'The enhancement cost cannot be estimated (a material or protection has no price).',
                      };
        }
    }
    return { market, net, enhance };
}

/**
 * Gain against cost for one row.
 *
 * A ratio only exists for a priced row whose gain is positive, real (not within noise, not resting on a cost counted as
 * free) and whose cost is positive. A cost at or below zero (selling your belt pays for it) is `free`, never divided.
 *
 * @param {Object} row - `{value, significant?, gainUnreal?, costs}`
 * @param {string} basis - A COST_BASES key
 * @returns {{kind: 'unpriced'|'free'|'ratio'|'none', per100m?: number, why?: string, cost: number|null}}
 */
export function rateRow(row, basis) {
    const cost = row.costs?.[basis]?.price;
    if (!(typeof cost === 'number' && Number.isFinite(cost))) {
        return { kind: 'unpriced', why: row.costs?.[basis]?.reason || 'No price.', cost: null };
    }
    if (!(row.value > 0)) return { kind: 'none', why: 'No gain.', cost };
    if (row.significant === false) return { kind: 'none', why: 'The gain is within noise.', cost };
    if (row.gainUnreal) {
        return { kind: 'none', why: 'The gain counts an unpriced cost as free, so it is a ceiling.', cost };
    }
    if (!(cost > 0)) return { kind: 'free', cost };
    return { kind: 'ratio', per100m: (row.value / cost) * COST_UNIT, cost };
}

/**
 * Rows in the order to read them: free upgrades, then by gain per cost, then priced rows without a ratio by gain, and
 * unpriced rows last (by gain).
 * @param {Array<Object>} rows
 * @param {string} basis
 * @returns {Array<Object>} A new array
 */
export function sortBeltRows(rows, basis) {
    const group = { free: 0, ratio: 1, none: 2, unpriced: 3 };
    const rated = (rows || []).map((row) => ({ row, rate: rateRow(row, basis) }));
    rated.sort((a, b) => {
        const g = group[a.rate.kind] - group[b.rate.kind];
        if (g !== 0) return g;
        if (a.rate.kind === 'ratio' && b.rate.per100m !== a.rate.per100m) return b.rate.per100m - a.rate.per100m;
        return (b.row.value || 0) - (a.row.value || 0);
    });
    return rated.map((entry) => entry.row);
}

/**
 * The words for a row's candidate.
 * @param {Object} candidate
 * @returns {string} e.g. "Large Talisman Belt +10"
 */
export function candidateLabel(candidate) {
    return `${candidate.name} +${candidate.level}`;
}

/**
 * The note a larger belt's extra slots get.
 * @param {number} emptySlots
 * @returns {string} '' when there are none
 */
export function emptySlotNote(emptySlots) {
    return emptySlots > 0 ? `+${emptySlots} empty slot${emptySlots === 1 ? '' : 's'}, not valued` : '';
}

/**
 * Scale a bonus set to another belt's Talisman Power. Every line is `gradeValue * (1 + power)`, so a set worked out for
 * one power is the set for another times the ratio of the two: exact, not an approximation.
 * @param {{noncombat: Object, buffs: Object, combat: Object}} bonuses
 * @param {number} fromPower
 * @param {number} toPower
 * @returns {{noncombat: Object, buffs: Object, combat: Object}} A new set
 */
export function scaleBonuses(bonuses, fromPower, toPower) {
    const factor = (1 + toPower) / (1 + fromPower);
    const scaled = (map) => Object.fromEntries(Object.entries(map || {}).map(([key, value]) => [key, value * factor]));
    return { noncombat: scaled(bonuses.noncombat), buffs: scaled(bonuses.buffs), combat: scaled(bonuses.combat) };
}

/**
 * Value every candidate belt for a skilling action, exactly: the action's figures (profit and XP from the skilling
 * math) with the talismans slotted in the gear it runs with, once per candidate belt.
 *
 * The slotted talismans reach the math as a bonus set tied to the gear's equipment Map. That set was worked out for the
 * belt in the Map, and scales linearly with the belt's Talisman Power, so a candidate gets the same set scaled by the
 * power ratio and the candidate belt put in the Map. Candidates never have fewer slots than the belt worn, so no slotted
 * talisman is dropped; a new slot holds nothing.
 *
 * @param {Object} params
 * @param {string} params.actionHrid
 * @param {string} params.metricKey - 'profit' or 'xp'
 * @param {Object} deps
 * @param {Function} deps.getGameData
 * @param {Function} deps.resolveContext - `(actionTypeHrid) => {equipment: Map, drinks: Array}`
 * @param {Function} deps.evaluate - `async (actionHrid, {equipment, drinks}) => figures|null`
 * @param {Object} [deps.costDeps] - Price readers for {@link beltCosts}
 * @param {Function} [deps.yieldNow]
 * @param {Object} [options] - `{abortSignal}`
 * @returns {Promise<Object>} `{status: 'done'|'stopped'|'refused', ...}`
 */
export async function runSkillingBeltAdvisor(params, deps, options = {}) {
    const { actionHrid, metricKey } = params;
    const stopped = () => Boolean(options.abortSignal?.());
    if (!isTestServer()) {
        return { status: 'refused', reason: 'live', message: 'Talismans exist on the test server only.' };
    }
    const gameData = deps.getGameData();
    const action = gameData?.actionDetailMap?.[actionHrid];
    if (!action) return { status: 'refused', reason: 'no_action', message: 'Pick an action.' };
    if (!RANKABLE_SKILLING_TYPES.includes(action.type)) {
        return {
            status: 'refused',
            reason: 'unsupported',
            message: 'Only gathering and production actions are valued (not Alchemy or Enhancing).',
        };
    }
    const resolved = deps.resolveContext(action.type);
    // One snapshot of the gear (with the talisman share it carries) and drinks for the whole run
    const context = resolved?.equipment
        ? {
              equipment: attachTalismanBonuses(new Map(resolved.equipment), talismanBonusesOf(resolved.equipment)),
              drinks: [...(resolved.drinks || [])],
          }
        : resolved;
    const belt = context?.equipment?.get?.(BELT_LOCATION) || null;
    const slots = getBeltSlotCount(belt, gameData.itemDetailMap);
    if (!belt?.itemHrid || slots === 0) {
        return {
            status: 'refused',
            reason: 'no_belt',
            message: 'The gear this action runs with has no Talisman Belt. Put one on first.',
        };
    }
    const table = gameData.enhancementLevelTotalBonusMultiplierTable;
    const power = getTalismanPower(belt, gameData.itemDetailMap, table);
    const worn = talismanBonusesOf(context.equipment);
    // The skilling math reads the stat and buff shares; a set of combat lines alone changes nothing here
    if (isEmptyTalismanBonuses({ noncombat: worn.noncombat, buffs: worn.buffs })) {
        return {
            status: 'refused',
            reason: 'no_talismans',
            message:
                'No skilling talisman is slotted in the gear this action runs with, so a belt changes nothing here.',
        };
    }
    const metric = SKILLING_RANKING_METRICS.find((m) => m.key === metricKey) || SKILLING_RANKING_METRICS[0];
    const candidates = beltCandidates(
        { hrid: belt.itemHrid, enhancementLevel: belt.enhancementLevel || 0 },
        gameData.itemDetailMap,
        table
    );

    const base = {
        kind: 'skilling',
        actionHrid,
        actionName: action.name,
        metricKey: metric.key,
        power,
        slots,
        belt: { hrid: belt.itemHrid, enhancementLevel: belt.enhancementLevel || 0 },
        of: candidates.length,
    };
    let anyMissing = false;
    let anyUnpricedInputs = false;
    const outputMissing = (figures) => Boolean(figures?.hasMissingPrices) && figures.outputsUnpriced !== false;
    const noteMissing = (figures) => {
        if (outputMissing(figures)) anyMissing = true;
        if (figures?.unpricedCost?.length) anyUnpricedInputs = true;
        return figures;
    };
    const finish = (status, rows, extra = {}) => ({
        status,
        ...base,
        rows,
        measured: rows.length,
        hasMissingPrices: anyMissing,
        hasUnpricedInputs: anyUnpricedInputs,
        ...extra,
    });
    const yieldNow = deps.yieldNow || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    const read = (figures) => (figures ? metric.rate(figures) || 0 : NaN);

    const bare = noteMissing(await deps.evaluate(actionHrid, { equipment: context.equipment, drinks: context.drinks }));
    if (!bare) return { status: 'refused', reason: 'no_figures', message: 'This action has no figures to value.' };
    if (metric.key === 'profit' && bare.hasMissingPrices && !(bare.revenuePerHour > 0)) {
        return {
            status: 'refused',
            reason: 'no_prices',
            message: 'No prices for this action yet (market data not loaded?). Try again, or value by EXP/hr.',
        };
    }
    const bareValue = read(bare);
    const rows = [];
    for (const candidate of candidates) {
        if (stopped()) return finish('stopped', rows);
        await yieldNow();
        deps.onProgress?.({
            current: rows.length,
            total: candidates.length,
            description: `Belts: ${candidateLabel(candidate)}`,
        });
        const equipment = new Map(context.equipment);
        equipment.set(BELT_LOCATION, { ...belt, itemHrid: candidate.hrid, enhancementLevel: candidate.level });
        attachTalismanBonuses(equipment, scaleBonuses(worn, power, candidate.power));
        const figures = noteMissing(await deps.evaluate(actionHrid, { equipment, drinks: context.drinks }));
        if (stopped()) return finish('stopped', rows);
        if (!figures) return finish('stopped', rows, { reason: 'no_figures' });
        // Skilling figures are exact: no sampling tolerance, so a small rise in an unpriced input still counts
        const costUnpriced = newlyUnpricedLineCosts(bare, figures, EXACT_UNPRICED_TOLERANCE);
        const value = read(figures) - bareValue;
        rows.push({
            ...candidate,
            value,
            significant: true,
            noEffect: value === 0,
            hasMissingPrices: outputMissing(figures),
            ...(costUnpriced.length ? { costUnpriced, gainUnreal: metric.key === 'profit' } : {}),
            costs: beltCosts(candidate, base.belt, gameData, deps.costDeps),
        });
    }
    return finish('done', rows);
}
