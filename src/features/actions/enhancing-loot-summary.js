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
 * @param {(hrid: string, level: number, side: 'ask'|'bid') => number} deps.priceOf
 * @param {Object} deps.itemDetails - itemDetailMap entry for the enhanced item
 * @param {number} [deps.marketTax=0.02] - Sell fee
 * @returns {Object|null}
 */
export function computeEnhancingSummary(run, deps) {
    const { calculateEnhancement, params, priceOf, itemDetails, marketTax = 0.02 } = deps || {};
    if (
        !run ||
        !itemDetails ||
        typeof calculateEnhancement !== 'function' ||
        !params ||
        typeof priceOf !== 'function'
    ) {
        return null;
    }

    const itemLevel = itemDetails.itemLevel || 0;
    const enhancementCosts = itemDetails.enhancementCosts || [];

    // Per-attempt material cost (buy side); coins are worth one each.
    let perAttempt = 0;
    for (const material of enhancementCosts) {
        const price = material.itemHrid === '/items/coin' ? 1 : priceOf(material.itemHrid, 0, 'ask') || 0;
        perAttempt += price * (material.count || 0);
    }

    // Cheapest protection option.
    const protectionOptions = [run.baseHrid, '/items/mirror_of_protection', ...(itemDetails.protectionItemHrids || [])];
    let protUnit = Infinity;
    for (const hrid of protectionOptions) {
        const price = priceOf(hrid, 0, 'ask') || 0;
        if (price > 0 && price < protUnit) protUnit = price;
    }
    if (!isFinite(protUnit)) protUnit = 0;

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
    const baseValue = priceOf(run.baseHrid, 0, 'bid') || 0;
    const finalValue = run.success ? (priceOf(run.baseHrid, run.targetLevel, 'bid') ?? null) : baseValue;
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
    };
}
