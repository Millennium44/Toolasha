/**
 * Protect-from sweep.
 *
 * The enhancing panel asks for one protect-from level and prices that one plan. The question a
 * player is actually asking is which protect-from level to type, and the only honest answer is
 * the whole column: every level from 2 to the target, plus no protection at all, each with what
 * it is expected to cost and how far a run can stray from that. This module walks that column
 * for one item and target, for each protection item the caller cares to price, and flags the
 * cheapest plan and the best gold per XP.
 *
 * The chain itself does not care which protection item is used — only whether a level is
 * protected — so one Markov solve per protect-from level serves every protection item. The
 * solve is the only real work, and a level-by-level table of twenty solves is a few
 * milliseconds, so the sweep runs inline; the memo below makes the repeat renders the panel
 * triggers free.
 *
 * Pure: the prices, the chain parameters and the calculator arrive as arguments, so the node
 * tests can pin the arithmetic without a game behind it.
 */

import { calculateEnhancement, costStats, costPercentiles } from './enhancement-calculator.js';

/** The protection that is not a protect-from item: it guarantees the attempt instead */
export const PHILOSOPHERS_MIRROR_HRID = '/items/philosophers_mirror';

/** The generic protection every item accepts */
export const MIRROR_OF_PROTECTION_HRID = '/items/mirror_of_protection';

/** The "no protection" row's protect-from value */
export const NO_PROTECTION = 0;

/**
 * Expected XP a run earns, summed over the expected visits to every level.
 *
 * Same formula the panel's costs-by-level table uses: a success at +i is worth
 * floor(1.4 · (1 + wisdom) · mult · (10 + base level)) with mult 1 at +0 and i + 1 above, and a
 * failure a tenth of that, floored.
 *
 * @param {Object} calc - A calculateEnhancement result (visitCounts, successRates)
 * @param {Object} xp - XP inputs
 * @param {number} [xp.xpBaseLevel=0] - The level the XP formula keys on
 * @param {number} [xp.wisdomDecimal=0] - Wisdom bonus as a decimal
 * @returns {number} Expected XP for the run
 */
export function expectedRunXp(calc, { xpBaseLevel = 0, wisdomDecimal = 0 } = {}) {
    if (!calc?.visitCounts || !calc?.successRates) return 0;
    let total = 0;
    for (let i = 0; i < calc.visitCounts.length; i++) {
        const visits = calc.visitCounts[i] || 0;
        const successRate = (calc.successRates[i]?.actualRate || 0) / 100;
        const enhMult = i === 0 ? 1.0 : i + 1;
        const successXP = Math.floor(1.4 * (1 + wisdomDecimal) * enhMult * (10 + xpBaseLevel));
        const failXP = Math.floor(successXP * 0.1);
        total += visits * (successRate * successXP + (1 - successRate) * failXP);
    }
    return total;
}

/**
 * The protection items worth pricing for an item: what is in the slot, and the cheapest other
 * thing that would work. The Philosopher's Mirror is not among them — it guarantees the attempt
 * instead of softening the fall, so the protect-from chain says nothing about it.
 *
 * @param {Object} args - Inputs
 * @param {string} args.itemHrid - The item being enhanced (it protects itself)
 * @param {Object} [args.itemDetails] - Its game data, for `protectionItemHrids`
 * @param {string|null} [args.selectedHrid] - What the panel's protection slot holds
 * @param {function(string): number} args.priceOf - Buy price for an item hrid, 0 when unknown
 * @param {function(string): string} [args.nameOf] - Display name for an item hrid
 * @returns {{options: Array<{itemHrid: string, name: string, price: number, selected: boolean}>,
 *   selectedIsMirror: boolean}} At most two options, the selected one first. `selectedIsMirror`
 *   when the slot holds a Philosopher's Mirror, which the sweep cannot price
 */
export function chooseProtectionOptions({ itemHrid, itemDetails, selectedHrid = null, priceOf, nameOf }) {
    const name = (hrid) => (typeof nameOf === 'function' ? nameOf(hrid) : null) || hrid;
    const selectedIsMirror = selectedHrid === PHILOSOPHERS_MIRROR_HRID;
    const selected = selectedIsMirror ? null : selectedHrid || null;

    const candidates = [itemHrid, MIRROR_OF_PROTECTION_HRID, ...(itemDetails?.protectionItemHrids || [])];
    if (selected && !candidates.includes(selected)) candidates.push(selected);

    const options = [];
    if (selected) {
        options.push({ itemHrid: selected, name: name(selected), price: priceOf(selected) || 0, selected: true });
    }

    let cheapest = null;
    for (const hrid of new Set(candidates)) {
        if (!hrid || hrid === selected || hrid === PHILOSOPHERS_MIRROR_HRID) continue;
        const price = priceOf(hrid) || 0;
        if (!(price > 0)) continue;
        if (!cheapest || price < cheapest.price)
            cheapest = { itemHrid: hrid, name: name(hrid), price, selected: false };
    }
    // The alternative earns its column when there is nothing selected, the selected item has
    // no price, or it is genuinely cheaper than what is in the slot
    if (cheapest && (!selected || !(options[0].price > 0) || cheapest.price < options[0].price)) {
        options.push(cheapest);
    }
    return { options, selectedIsMirror };
}

/**
 * Sweep every protect-from level for one item and target.
 *
 * @param {Object} args - Inputs
 * @param {Object} args.chain - calculateEnhancement parameters other than targetLevel/protectFrom:
 *   enhancingLevel, toolBonus, speedBonus, itemLevel, blessedTea, guzzlingBonus, blessedTeaBonus
 * @param {number} args.targetLevel - Target level, 1..20
 * @param {number} [args.startLevel=0] - Level the run starts from
 * @param {number} [args.materialCostPerAttempt=0] - Coins every attempt burns in materials
 * @param {number} [args.fixedCost=0] - Coins paid once (the base item), when the caller wants it in
 * @param {Array<{itemHrid: string, name: string, price: number, selected?: boolean}>}
 *   [args.protectionOptions=[]] - Protection items to price the protected rows with
 * @param {number} [args.perActionTime] - Seconds per attempt; falls back to the calculator's
 * @param {number} [args.xpBaseLevel=0] - Level the XP formula keys on
 * @param {number} [args.wisdomDecimal=0] - Wisdom bonus as a decimal
 * @param {Function} [args.calculate] - calculateEnhancement, injectable for tests
 * @returns {{rows: Array<Object>, cheapestIndex: number, bestGoldPerXpIndex: number}} Rows are the
 *   "no protection" row first, then for each protection option every protect-from level from 2
 *   to the target. Each row: protectFrom, itemHrid (null for none), name, attempts,
 *   attemptsStdDev, protections, expectedCost, costStdDev, p10, p90, xp, goldPerXp, time.
 *   The index fields point at the cheapest expected cost and the lowest gold per XP
 */
export function sweepProtectFrom({
    chain,
    targetLevel,
    startLevel = 0,
    materialCostPerAttempt = 0,
    fixedCost = 0,
    protectionOptions = [],
    perActionTime,
    xpBaseLevel = 0,
    wisdomDecimal = 0,
    calculate = calculateEnhancement,
}) {
    const target = Math.max(1, Math.min(20, Math.floor(Number(targetLevel) || 0)));
    const start = Math.max(0, Math.min(target - 1, Math.floor(Number(startLevel) || 0)));
    const materials = Math.max(0, Number(materialCostPerAttempt) || 0);
    const fixed = Math.max(0, Number(fixedCost) || 0);
    const xpInputs = { xpBaseLevel, wisdomDecimal };

    // One solve per protect-from level; every protection option reads the same chain
    const solve = (protectFrom) =>
        calculate({
            ...chain,
            targetLevel: target,
            startLevel: start,
            protectFrom,
        });

    const buildRow = (calc, protectFrom, option) => {
        const protections = protectFrom > 0 ? calc.protectionCount || 0 : 0;
        const protectionPrice = option?.price || 0;
        // Protection is consumed on protected failures, whose expected count scales with the
        // attempt count — so it folds into the per-attempt rate the cost distribution is built on
        const protectionPerAttempt = calc.attempts > 0 ? (protections * protectionPrice) / calc.attempts : 0;
        const stats = costStats(calc, { costPerAttempt: materials + protectionPerAttempt, fixedCost: fixed });
        const percentiles = costPercentiles(stats, [0.1, 0.9]);
        const xp = expectedRunXp(calc, xpInputs);
        const seconds = (perActionTime > 0 ? perActionTime : calc.perActionTime || 0) * calc.attempts;
        return {
            protectFrom,
            itemHrid: option?.itemHrid || null,
            name: option?.name || null,
            selected: Boolean(option?.selected),
            attempts: calc.attempts,
            attemptsStdDev: calc.attemptsStdDev || 0,
            protections,
            protectionPrice,
            expectedCost: stats.expected,
            costStdDev: stats.stdDev,
            p10: percentiles.p10,
            p90: percentiles.p90,
            xp,
            goldPerXp: xp > 0 ? stats.expected / xp : null,
            time: seconds,
        };
    };

    const rows = [buildRow(solve(NO_PROTECTION), NO_PROTECTION, null)];

    if (target >= 2 && protectionOptions.length > 0) {
        const solves = new Map();
        for (let protectFrom = 2; protectFrom <= target; protectFrom++) {
            solves.set(protectFrom, solve(protectFrom));
        }
        for (const option of protectionOptions) {
            for (let protectFrom = 2; protectFrom <= target; protectFrom++) {
                rows.push(buildRow(solves.get(protectFrom), protectFrom, option));
            }
        }
    }

    let cheapestIndex = 0;
    let bestGoldPerXpIndex = -1;
    rows.forEach((row, index) => {
        if (row.expectedCost < rows[cheapestIndex].expectedCost) cheapestIndex = index;
        if (row.goldPerXp !== null && (bestGoldPerXpIndex < 0 || row.goldPerXp < rows[bestGoldPerXpIndex].goldPerXp)) {
            bestGoldPerXpIndex = index;
        }
    });

    return { rows, cheapestIndex, bestGoldPerXpIndex };
}

const MEMO_LIMIT = 16;
const memo = new Map();

/**
 * A key that changes exactly when the sweep's answer would.
 * @param {Object} args - sweepProtectFrom arguments
 * @returns {string}
 */
function memoKey(args) {
    const chain = args.chain || {};
    const options = (args.protectionOptions || []).map((option) => [option.itemHrid, option.price, option.selected]);
    return JSON.stringify([
        chain.enhancingLevel,
        chain.toolBonus,
        chain.speedBonus,
        chain.itemLevel,
        chain.blessedTea,
        chain.guzzlingBonus,
        chain.blessedTeaBonus,
        args.targetLevel,
        args.startLevel,
        args.materialCostPerAttempt,
        args.fixedCost,
        args.perActionTime,
        args.xpBaseLevel,
        args.wisdomDecimal,
        options,
    ]);
}

/**
 * sweepProtectFrom, remembered across the re-renders the panel fires for the same inputs.
 * The key is every input the answer depends on, so a price tick or a typed target misses and
 * recomputes; anything else is a lookup.
 *
 * @param {Object} args - sweepProtectFrom arguments
 * @returns {ReturnType<typeof sweepProtectFrom>}
 */
export function sweepProtectFromMemo(args) {
    const key = memoKey(args);
    const hit = memo.get(key);
    if (hit) {
        // Refresh recency so the hot entry is the last to be evicted
        memo.delete(key);
        memo.set(key, hit);
        return hit;
    }
    const result = sweepProtectFrom(args);
    memo.set(key, result);
    while (memo.size > MEMO_LIMIT) {
        memo.delete(memo.keys().next().value);
    }
    return result;
}

/** Empty the memo — tests, and anything that rewires the calculator */
export function clearProtectSweepMemo() {
    memo.clear();
}
