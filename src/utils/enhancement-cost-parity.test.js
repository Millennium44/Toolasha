/**
 * The four enhancement cost sweeps, side by side.
 *
 * One Markov core (`enhancement-calculator.js`) is wrapped by four different
 * protect-from sweeps that disagree about what a run costs:
 *
 *   T  `features/enhancement/tooltip-enhancement.js`  — the item tooltip's path
 *   E  `utils/enhancement-protect-sweep.js`           — the enhancing panel's column
 *   A  `features/combat-sim/upgrade-advisor.js`       — the sim's Cost column
 *   S  `features/inventory/equipment-savings-row.js`  — the savings card
 *
 * They differ on three axes, and the differences are worth money:
 *
 *   1. **Where the run starts.** A prices every level from 1 and subtracts
 *      (`fullCost[target] − fullCost[start]`); E and S solve the chain from the
 *      level the item is actually at. The table below shows these are the *same
 *      number* whenever the chain cannot skip a level — to reach +7 the item
 *      must pass through +4, the transition probabilities do not depend on the
 *      target, and so by the strong Markov property
 *      `E[0→7] = E[0→4] + E[4→7]`. They part company only under Blessed Tea,
 *      whose double jump can vault the start level: there the delta *undercounts*
 *      the real run by up to about 1%.
 *   2. **How materials are priced.** T and A cross-fill a one-sided book and
 *      fall back to production cost; S takes `ask || sellPrice`, which on a
 *      bid-only book quotes the vendor price and can be an order of magnitude low.
 *   3. **What protection costs.** T prices an unpriceable protection at zero,
 *      which makes protected strategies free by construction and always win.
 *      A and S refuse to price a strategy whose protection has no price.
 *
 * ## Why the implementations are transcribed here
 *
 * Each of the four lives behind a different module-mock graph, and vitest's
 * mocks are per-file — there is no way to import all four into one file and
 * drive them from one set of fixtures. So each sweep is transcribed below from
 * its source, marked with the file and function it came from, and driven by the
 * **real** `calculateEnhancement`. To keep the transcriptions honest, the
 * savings-row one is checked against the exact figures its own suite pins
 * (`equipment-savings-row.test.js`, "the two levels the report was about"):
 * 81,926,437 and 101,311,834. If a transcription drifts from its original that
 * anchor fails.
 *
 * This file is the before-picture. It is deliberately not a pass/fail test of
 * correctness — it records what each surface says today so that after the
 * consolidation the same table can be read back and every moved number
 * accounted for.
 */

import { describe, test, expect } from 'vitest';
import { calculateEnhancement } from './enhancement-calculator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The enhancing bench every transcription runs on, so only the sweep differs */
const CHAIN = {
    enhancingLevel: 84,
    toolBonus: 4,
    speedBonus: 0,
    itemLevel: 50,
    blessedTea: false,
    guzzlingBonus: 1,
};

/** The piece the savings-row anchor below is about */
const _ITEM = '/items/sinister_cape';
const MATERIAL = '/items/shard';
const MIRROR = '/items/mirror_of_protection';

/**
 * Two market fixtures. The first quotes both sides, so the three pricing rules
 * agree and any disagreement in the table is the sweep's alone. The second
 * quotes a bid only — the case that separates them.
 */
const BOOKS = {
    twoSided: {
        [MATERIAL]: { ask: 1_000_000, bid: 900_000 },
        [MIRROR]: { ask: 240_000, bid: 220_000 },
    },
    bidOnly: {
        [MATERIAL]: { ask: null, bid: 900_000 },
        [MIRROR]: { ask: 240_000, bid: 220_000 },
    },
};

/** Vendor sell prices and production costs, the two fallbacks the rules differ over */
const SELL_PRICE = { [MATERIAL]: 100_000, [MIRROR]: 240_000 };
const PRODUCTION_COST = { [MATERIAL]: 700_000, [MIRROR]: 0 };

/** One shard an attempt, the same recipe every transcription prices */
const ENHANCEMENT_COSTS = [{ itemHrid: MATERIAL, count: 1 }];

/** The (start, target) pairs the surfaces are asked about */
const RUNS = [
    { start: 0, target: 5 },
    { start: 0, target: 7 },
    { start: 4, target: 7 },
    { start: 5, target: 7 },
    { start: 8, target: 12 },
];

// ---------------------------------------------------------------------------
// The three material pricing rules, transcribed
// ---------------------------------------------------------------------------

/**
 * T/A's rule: cross-fill a one-sided book, then production cost, then vendor.
 * From `getEnhancementMaterialPrice` in tooltip-enhancement.js, which the
 * advisor carries an inline copy of at upgrade-advisor.js:467.
 * @param {string} hrid - Material
 * @param {Object} book - Market fixture
 * @returns {number} Unit price
 */
function crossFillPrice(hrid, book) {
    const quote = book[hrid];
    if (quote) {
        let { ask, bid } = quote;
        if (ask > 0 && !(bid > 0)) bid = ask;
        if (bid > 0 && !(ask > 0)) ask = bid;
        if (ask > 0) return ask;
    }
    return PRODUCTION_COST[hrid] || SELL_PRICE[hrid] || 0;
}

/**
 * S's rule: the ask, or the vendor sell price. No cross-fill, no production cost.
 * From `priceOf` in equipment-savings-row.js:1141.
 * @param {string} hrid - Material
 * @param {Object} book - Market fixture
 * @returns {number} Unit price
 */
function askOrSellPrice(hrid, book) {
    return book[hrid]?.ask || SELL_PRICE[hrid] || 0;
}

// ---------------------------------------------------------------------------
// The four sweeps, transcribed
// ---------------------------------------------------------------------------

/**
 * Solve the chain once.
 * @param {number} targetLevel - Target
 * @param {number} startLevel - Where the run begins
 * @param {number} protectFrom - Protect-from level, 0 for none
 * @returns {Object} calculateEnhancement result
 */
function solve(targetLevel, startLevel, protectFrom) {
    return calculateEnhancement({ ...CHAIN, targetLevel, startLevel, protectFrom });
}

/**
 * T — the tooltip's per-level minimum, from level 1, protection priced at zero
 * when it has no price. `calculateCostForStrategy` + `calculateTotalCost`,
 * tooltip-enhancement.js:282 and :687. The base item is left out so the figure
 * is comparable with the other three.
 * @param {number} targetLevel - Target
 * @param {Object} book - Market fixture
 * @returns {number} Path cost to reach the level from 0
 */
function tooltipPathCost(targetLevel, book) {
    const perAttempt = crossFillPrice(MATERIAL, book) * ENHANCEMENT_COSTS[0].count;
    // getCheapestProtectionPrice returns null when nothing can be priced, and
    // calculateTotalCost then leaves protectionCost at 0 — protection is free
    const protectionPrice = crossFillPrice(MIRROR, book);

    let best = Infinity;
    for (const protectFrom of [0, ...levelsFromTwo(targetLevel)]) {
        const run = solve(targetLevel, 0, protectFrom);
        const protections = protectFrom > 0 ? run.protectionCount || 0 : 0;
        best = Math.min(best, perAttempt * run.attempts + protectionPrice * protections);
    }
    return best;
}

/**
 * A — the advisor's incremental cost: the per-level minimum from level 1, then
 * `fullCost[target] − fullCost[start]`. upgrade-advisor.js:507.
 * @param {number} startLevel - Where the item is now
 * @param {number} targetLevel - Target
 * @param {Object} book - Market fixture
 * @returns {number} Incremental cost
 */
function advisorCost(startLevel, targetLevel, book) {
    const perAttempt = crossFillPrice(MATERIAL, book) * ENHANCEMENT_COSTS[0].count;
    const protectionPrice = crossFillPrice(MIRROR, book);

    const fullCost = new Array(targetLevel + 1).fill(0);
    for (let level = 1; level <= targetLevel; level++) {
        let best = Infinity;
        for (const protectFrom of [0, ...levelsFromTwo(level)]) {
            const run = solve(level, 0, protectFrom);
            const protections = run.protectionCount || 0;
            // A strategy whose protection has no price is skipped, not free
            if (protections > 0 && !(protectionPrice > 0)) continue;
            best = Math.min(best, perAttempt * run.attempts + protectionPrice * protections);
        }
        fullCost[level] = best;
    }
    return Math.max(0, fullCost[targetLevel] - fullCost[startLevel]);
}

/**
 * S — the savings card: solve from the start level, search protect-from 2 to
 * target, price materials at ask-or-vendor, and never let the item protect
 * itself. equipment-savings-row.js:1127.
 * @param {number} startLevel - Where the item is now
 * @param {number} targetLevel - Target
 * @param {Object} book - Market fixture
 * @returns {number} Run cost
 */
function savingsCost(startLevel, targetLevel, book) {
    const perAttempt = askOrSellPrice(MATERIAL, book) * ENHANCEMENT_COSTS[0].count;
    const protectionPrice = askOrSellPrice(MIRROR, book);

    const strategies = [0, ...(protectionPrice > 0 ? levelsFromTwo(targetLevel) : [])];
    let best = Infinity;
    for (const protectFrom of strategies) {
        const run = solve(targetLevel, startLevel, protectFrom);
        best = Math.min(best, run.attempts * perAttempt + (run.protectionCount || 0) * protectionPrice);
    }
    return best;
}

/**
 * E — the enhancing panel's column, through the real engine: solve from the
 * start level and take the cheapest row. Materials are priced by whatever the
 * caller hands in, which for the panel is `resolveItemPrice`; the cross-fill
 * rule stands in for it here so the pricing axis does not confound the sweep axis.
 * @param {number} startLevel - Where the item is now
 * @param {number} targetLevel - Target
 * @param {Object} book - Market fixture
 * @returns {number} Run cost
 */
function engineCost(startLevel, targetLevel, book) {
    const perAttempt = crossFillPrice(MATERIAL, book) * ENHANCEMENT_COSTS[0].count;
    const protectionPrice = crossFillPrice(MIRROR, book);

    const strategies = [0, ...(protectionPrice > 0 ? levelsFromTwo(targetLevel) : [])];
    let best = Infinity;
    for (const protectFrom of strategies) {
        const run = solve(targetLevel, startLevel, protectFrom);
        best = Math.min(best, run.attempts * perAttempt + (run.protectionCount || 0) * protectionPrice);
    }
    return best;
}

/**
 * The protect-from levels a target admits: 2 up to the target, never below 2 and
 * never bounded by where the run starts — a failure drops you below the start,
 * so protecting from under it is not a wasted setting.
 * @param {number} targetLevel - Target
 * @returns {number[]} Legal protect-from levels
 */
function levelsFromTwo(targetLevel) {
    const levels = [];
    for (let from = 2; from <= targetLevel; from++) levels.push(from);
    return levels;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Every surface's answer for one run.
 * @param {{start: number, target: number}} run - The run
 * @param {Object} book - Market fixture
 * @returns {Object} One row of the disagreement table
 */
function row(run, book) {
    return {
        run: `+${run.start} → +${run.target}`,
        tooltip: tooltipPathCost(run.target, book) - (run.start > 0 ? tooltipPathCost(run.start, book) : 0),
        advisor: advisorCost(run.start, run.target, book),
        savings: savingsCost(run.start, run.target, book),
        engine: engineCost(run.start, run.target, book),
    };
}

describe('the four enhancement sweeps, on identical inputs', () => {
    test('a two-sided book: only the sweep differs', () => {
        const table = RUNS.map((run) => row(run, BOOKS.twoSided));

        // Recorded, not asserted for correctness: this is what each surface says
        // today. Every figure that moves in the consolidation is accounted for
        // against this table.
        for (const entry of table) {
            expect(entry.advisor).toBeGreaterThanOrEqual(0);
            expect(entry.savings).toBeGreaterThan(0);
            expect(entry.engine).toBeGreaterThan(0);
        }

        // The finding this harness exists to record: without Blessed Tea the
        // delta convention and the from-current convention are the *same
        // number*, to floating-point. The item cannot skip a level, so every
        // path from +0 to +7 passes through +4, and the expected attempts split
        // exactly at the crossing. Retiring the delta convention therefore moves
        // nothing at all on this fixture — which is why the movement budget in
        // the conversion is spent almost entirely on pricing, not on the sweep.
        for (const entry of table) {
            expect(entry.advisor / entry.engine).toBeCloseTo(1, 6);
            // Same question, and on a two-sided book the same pricing
            expect(entry.savings / entry.engine).toBeCloseTo(1, 6);
        }

        // Recorded figures, so a later run can be diffed against them
        expect(Math.round(table[0].engine)).toBe(44_677_188); // +0 → +5
        expect(Math.round(table[1].engine)).toBe(126_603_624); // +0 → +7
        expect(Math.round(table[2].engine)).toBe(101_311_834); // +4 → +7
        expect(Math.round(table[3].engine)).toBe(81_926_437); // +5 → +7
        expect(Math.round(table[4].engine)).toBe(2_343_498_964); // +8 → +12
    }, 60_000);

    test('Blessed Tea is where the delta convention actually breaks', () => {
        // A double jump can vault the level the run starts at, so the run no
        // longer has to pass through it and the split stops being exact. The
        // delta comes out *under* the honest from-current figure — the advisor
        // has been quoting a discount it cannot deliver.
        const tea = { ...CHAIN, blessedTea: true, blessedTeaBonus: 0.01 };
        const perAttempt = crossFillPrice(MATERIAL, BOOKS.twoSided);
        const protectionPrice = crossFillPrice(MIRROR, BOOKS.twoSided);

        const cheapest = (startLevel, targetLevel) => {
            let best = Infinity;
            for (const protectFrom of [0, ...levelsFromTwo(targetLevel)]) {
                const solved = calculateEnhancement({ ...tea, targetLevel, startLevel, protectFrom });
                best = Math.min(best, perAttempt * solved.attempts + protectionPrice * (solved.protectionCount || 0));
            }
            return best;
        };

        const delta = cheapest(0, 7) - cheapest(0, 4);
        const fromFour = cheapest(4, 7);

        expect(delta).toBeLessThan(fromFour);
        // Small, and always in the same direction: under a per-cent, never near
        // the 2× band that would mean something is wrong rather than different
        expect(delta / fromFour).toBeGreaterThan(0.99);
    }, 60_000);

    test('a bid-only book: the savings card quotes the vendor price', () => {
        const table = RUNS.map((run) => row(run, BOOKS.bidOnly));

        // 900,000 cross-filled from the bid against 100,000 at the vendor: the
        // savings card reports a ninth of the real bill for the same run
        for (const entry of table) {
            expect(entry.savings).toBeLessThan(entry.engine / 5);
        }
        expect(askOrSellPrice(MATERIAL, BOOKS.bidOnly)).toBe(100_000);
        expect(crossFillPrice(MATERIAL, BOOKS.bidOnly)).toBe(900_000);
    }, 60_000);

    test('unpriceable protection is free to the tooltip and refused by the others', () => {
        const noProtection = {
            [MATERIAL]: { ask: 1_000_000, bid: 900_000 },
            [MIRROR]: { ask: null, bid: null },
        };
        // Neither the mirror's production cost nor a vendor price exists here
        expect(crossFillPrice(MIRROR, noProtection)).toBe(240_000);

        // With the mirror genuinely unpriceable the tooltip still runs the
        // protected strategies and charges nothing for the protections
        const bare = { ...noProtection, [MIRROR]: { ask: null, bid: null } };
        const unpriceable = (hrid, book) => (hrid === MIRROR ? 0 : crossFillPrice(hrid, book));

        const perAttempt = unpriceable(MATERIAL, bare);
        let tooltipBest = Infinity;
        let honestBest = Infinity;
        for (const protectFrom of [0, ...levelsFromTwo(7)]) {
            const run = solve(7, 0, protectFrom);
            const protections = protectFrom > 0 ? run.protectionCount || 0 : 0;
            tooltipBest = Math.min(tooltipBest, perAttempt * run.attempts);
            if (protections === 0) honestBest = Math.min(honestBest, perAttempt * run.attempts);
        }

        // The tooltip's cheapest is a protected run costed as if protection were
        // free; the honest answer is the unprotected run, which is far dearer
        expect(tooltipBest).toBeLessThan(honestBest / 3);
    }, 60_000);

    test('the savings transcription reproduces the figures its own suite pins', () => {
        // equipment-savings-row.test.js, "the two levels the report was about":
        // a sinister cape at 1M a shard with a 240k mirror, on this same bench
        const book = BOOKS.twoSided;
        expect(Math.round(savingsCost(5, 7, book))).toBe(81_926_437);
        expect(Math.round(savingsCost(4, 7, book))).toBe(101_311_834);
    }, 60_000);
});
