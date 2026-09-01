/**
 * Enhancing loot summary
 *
 * The cost/luck/profit of an enhancing action, reconstructed from a loot-log
 * entry. A loot-log entry hands us `drops` keyed by enhancement level
 * (`/items/foo::N`), so the whole run is recoverable from data — no DOM
 * scraping. The arithmetic is pure and dependency-injected so it can be tested
 * without the game: the caller passes in the Markov calculator, this character's
 * enhancing params, a price lookup, and the item's data.
 *
 * The reconstruction mirrors the community "Better Loot Tracker": the highest
 * level present with a count of exactly one is a successful stop at the target;
 * otherwise the run failed one short of `maxLevel + 1`. Protections are inferred
 * from the parity of the protect-level drop counts, assuming the cost-optimal
 * protect-from (the player's real choice is not recorded).
 */

/**
 * Recover the item, target level, success and attempt count from a loot-log
 * entry's drops.
 * @param {Object<string, number>} drops - `{ '/items/foo::N': count, ... }`
 * @param {number} actionCount - The action's attempt count
 * @returns {{baseHrid:string, levelCounts:Object<number,number>, maxLevel:number,
 *   targetLevel:number, success:boolean, attempts:number}|null}
 */
export function reconstructEnhancingRun(drops, actionCount) {
    if (!drops || typeof drops !== 'object') return null;

    // Per-level counts for each item that appears with a ::N suffix. Enhancing
    // essence is a byproduct, not the enhanced item.
    const byItem = {};
    for (const [key, count] of Object.entries(drops)) {
        const match = key.match(/^(.*)::(\d+)$/);
        if (!match) continue;
        const hrid = match[1];
        if (hrid === '/items/enhancing_essence') continue;
        const level = parseInt(match[2], 10);
        if (!byItem[hrid]) byItem[hrid] = {};
        byItem[hrid][level] = (byItem[hrid][level] || 0) + count;
    }

    // The enhanced item dominates the level-keyed drops.
    let baseHrid = null;
    let levelCounts = null;
    let bestTotal = -1;
    for (const [hrid, counts] of Object.entries(byItem)) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total > bestTotal) {
            bestTotal = total;
            baseHrid = hrid;
            levelCounts = counts;
        }
    }
    if (!baseHrid) return null;

    const levels = Object.keys(levelCounts).map(Number);
    const maxLevel = Math.max(...levels);
    const maxCount = levelCounts[maxLevel] || 0;

    let targetLevel;
    let success;
    if (maxCount === 1) {
        targetLevel = maxLevel;
        success = true;
    } else {
        targetLevel = maxLevel + 1;
        success = false;
    }

    const summed = Object.values(levelCounts).reduce((a, b) => a + b, 0);
    const attempts = actionCount || summed;
    return { baseHrid, levelCounts, maxLevel, targetLevel, success, attempts };
}

/**
 * How many protections a run used, inferred from the parity of the protect-level
 * drop counts. Same shape as the reference's calculateActualProtections.
 * @param {Object<number,number>} levelCounts
 * @param {number} protectFrom - Level protection starts at (0 = never)
 * @param {number} targetLevel
 * @param {boolean} success
 * @returns {number}
 */
export function countProtections(levelCounts, protectFrom, targetLevel, success) {
    if (!protectFrom || protectFrom < 1) return 0;
    const parity = protectFrom % 2;

    let count = 0;
    for (let level = protectFrom; level <= targetLevel; level++) {
        if (level % 2 !== parity) continue;
        count += levelCounts[level] || 0;
    }
    // A successful climb passes through each protect level once without a reset.
    if (success) {
        let passes = 0;
        for (let level = protectFrom; level <= targetLevel; level++) {
            if (level % 2 === parity) passes++;
        }
        count -= passes;
    }
    return Math.max(0, count);
}

/**
 * The cost/luck/profit of a reconstructed run.
 *
 * @param {Object} run - From {@link reconstructEnhancingRun}
 * @param {Object} deps
 * @param {(params: Object) => {attempts:number, protectionCount:number}} deps.calculateEnhancement
 * @param {Object} deps.params - This character's enhancing params (getEnhancingParams shape)
 * @param {(hrid: string) => number} deps.materialPrice - Per-unit enhancement
 *   material price, buy side — the same pricing the live tracker uses, with its
 *   production-cost / NPC fallbacks (an unlisted catalyst is not free). Coins
 *   must come back as 1.
 * @param {(baseHrid: string) => number} deps.protectionPrice - Cheapest protection
 *   unit price for the item (0 when none applies)
 * @param {(hrid: string, level: number) => number|null} deps.itemValue - Market
 *   resale (bid) value of the item at a level, or null when unlisted
 * @param {Object} deps.itemDetails - itemDetailMap entry for the enhanced item
 * @param {number} [deps.marketTax=0.05] - Sell fee (see profit-constants MARKET_TAX)
 * @returns {Object|null}
 */
export function computeEnhancingSummary(run, deps) {
    const {
        calculateEnhancement,
        params,
        materialPrice,
        protectionPrice,
        itemValue,
        itemDetails,
        marketTax = 0.05,
    } = deps || {};
    if (
        !run ||
        !itemDetails ||
        typeof calculateEnhancement !== 'function' ||
        !params ||
        typeof materialPrice !== 'function' ||
        typeof protectionPrice !== 'function' ||
        typeof itemValue !== 'function'
    ) {
        return null;
    }

    const itemLevel = itemDetails.itemLevel || 0;
    const enhancementCosts = itemDetails.enhancementCosts || [];

    // Per-attempt material cost (buy side), priced exactly as the live tracker
    // does — materialPrice handles coins (1) and the unlisted-material fallbacks.
    // A material that still comes back at zero after those fallbacks is unknown,
    // not free: every cost figure below is then an understatement, and the caller
    // is told so rather than being handed a confident-looking number.
    let perAttempt = 0;
    let materialsUnpriced = false;
    for (const material of enhancementCosts) {
        const count = material.count || 0;
        const price = materialPrice(material.itemHrid) || 0;
        if (count > 0 && price <= 0) materialsUnpriced = true;
        perAttempt += price * count;
    }

    const protUnit = protectionPrice(run.baseHrid) || 0;

    const runParams = (protectFrom) =>
        calculateEnhancement({
            enhancingLevel: params.enhancingLevel,
            itemLevel,
            targetLevel: run.targetLevel,
            protectFrom,
            toolBonus: params.toolBonus,
            speedBonus: params.speedBonus,
            blessedTea: params.teas?.blessed,
            guzzlingBonus: params.guzzlingBonus,
            blessedTeaBonus: params.blessedTeaBonus,
        });

    // Best protect-from by expected total cost — the run's protect-from is not
    // recorded, so we assume the cost-optimal choice.
    let best = null;
    const start = run.targetLevel === 1 ? 1 : 2;
    for (let protectFrom = start; protectFrom <= run.targetLevel; protectFrom++) {
        let result;
        try {
            result = runParams(protectFrom);
        } catch {
            continue;
        }
        if (!result) continue;
        const total = perAttempt * result.attempts + protUnit * (result.protectionCount || 0);
        if (!best || total < best.total) {
            best = { protectFrom, expAttempts: result.attempts, expProtects: result.protectionCount || 0, total };
        }
    }
    if (!best) return null;

    const materialExpected = perAttempt * best.expAttempts;
    const protectExpected = protUnit * best.expProtects;
    const totalExpected = materialExpected + protectExpected;

    const materialActual = perAttempt * run.attempts;
    const actualProtects = countProtections(run.levelCounts, best.protectFrom, run.targetLevel, run.success);
    const protectActual = protUnit * actualProtects;
    const totalActual = materialActual + protectActual;

    // Worth it: +N resale (after fee) minus base given up (after fee) minus spent.
    const keep = 1 - marketTax;
    const baseValue = itemValue(run.baseHrid, 0) || 0;
    const finalValue = run.success ? (itemValue(run.baseHrid, run.targetLevel) ?? null) : baseValue;
    const profit = finalValue == null ? null : finalValue * keep - baseValue * keep - totalActual;

    return {
        protectFrom: best.protectFrom,
        expectedAttempts: best.expAttempts,
        expectedProtects: best.expProtects,
        actualAttempts: run.attempts,
        actualProtects,
        materialActual,
        materialExpected,
        protectActual,
        protectExpected,
        totalActual,
        totalExpected,
        diff: totalActual - totalExpected, // positive → above expected (unlucky)
        finalValue,
        baseValue,
        profit,
        success: run.success,
        targetLevel: run.targetLevel,
        materialsUnpriced,
    };
}

/**
 * Combine several per-run summaries into one, for merging runs of the same item
 * that were split across loot-log entries — the real cost and profit of the lot.
 *
 * @param {Array<Object>} summaries - From {@link computeEnhancingSummary}
 * @returns {{runs:number, successes:number, materialActual:number,
 *   materialExpected:number, protectActual:number, protectExpected:number,
 *   totalActual:number, totalExpected:number, actualAttempts:number,
 *   expectedAttempts:number, actualProtects:number, expectedProtects:number,
 *   diff:number, profit:number|null, materialsUnpriced:boolean}|null}
 */
export function mergeEnhancingSummaries(summaries) {
    if (!Array.isArray(summaries) || summaries.length === 0) return null;

    const merged = {
        runs: 0,
        successes: 0,
        materialActual: 0,
        materialExpected: 0,
        protectActual: 0,
        protectExpected: 0,
        totalActual: 0,
        totalExpected: 0,
        actualAttempts: 0,
        expectedAttempts: 0,
        actualProtects: 0,
        expectedProtects: 0,
        profit: 0,
        materialsUnpriced: false,
    };
    let profitKnown = true;

    for (const s of summaries) {
        if (!s) continue;
        merged.runs += 1;
        if (s.success) merged.successes += 1;
        merged.materialActual += s.materialActual || 0;
        merged.materialExpected += s.materialExpected || 0;
        merged.protectActual += s.protectActual || 0;
        merged.protectExpected += s.protectExpected || 0;
        merged.totalActual += s.totalActual || 0;
        merged.totalExpected += s.totalExpected || 0;
        merged.actualAttempts += s.actualAttempts || 0;
        merged.expectedAttempts += s.expectedAttempts || 0;
        merged.actualProtects += s.actualProtects || 0;
        merged.expectedProtects += s.expectedProtects || 0;
        // One understated run understates the total, so the marker carries over.
        if (s.materialsUnpriced) merged.materialsUnpriced = true;
        // One un-priced run makes the merged profit unknowable rather than wrong.
        if (s.profit == null) profitKnown = false;
        else merged.profit += s.profit;
    }

    merged.diff = merged.totalActual - merged.totalExpected;
    if (!profitKnown) merged.profit = null;
    return merged;
}
