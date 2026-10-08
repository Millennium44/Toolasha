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
 * The lowest protect-from level the game will accept.
 *
 * A failure at +1 drops to +0, which is the same place an unprotected failure
 * lands, so there is nothing for a protection item to absorb and the game does
 * not offer the setting. The search therefore starts at 2 — never at 0, and
 * never at the level the run happens to start from.
 *
 * That last point cost the savings card a bug: it used to bound the search
 * below at the start level, which forbade the cheap strategies to exactly the
 * runs that start high. A protect-from below where you begin is not a wasted
 * setting, because the first failure drops you *below* the start and from there
 * the protection is what stops the next one sending you to +0. So a +5 → +7 run
 * could only protect from +5 while a +4 → +7 run was allowed to protect from
 * +4, and the card reported that starting a level lower was cheaper.
 */
export const MIN_PROTECT_FROM = 2;

/**
 * Every protect-from level a target admits, cheapest search first.
 * @param {number} targetLevel - Target enhancement level
 * @returns {number[]} `[2, 3, …, targetLevel]`, empty below +2
 */
export function protectFromLevels(targetLevel) {
    const levels = [];
    for (let from = MIN_PROTECT_FROM; from <= targetLevel; from++) levels.push(from);
    return levels;
}

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
 * How many copies of a protection item a player can spend on a run without dipping below the
 * number they keep in reserve.
 * @param {number} held - Copies held at +0 in the bag
 * @param {number} reserve - Copies to keep untouched
 * @returns {number} max(0, held − reserve), whole copies
 */
export function spareStock(held, reserve) {
    const have = Math.max(0, Math.floor(Number(held) || 0));
    const keep = Math.max(0, Math.floor(Number(reserve) || 0));
    return Math.max(0, have - keep);
}

/**
 * Invert a small square matrix (Gauss–Jordan with partial pivoting).
 * @param {number[][]} matrix - n×n, not modified
 * @returns {number[][]|null} The inverse, or null when singular
 */
function invertSmall(matrix) {
    const n = matrix.length;
    const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        if (!(Math.abs(a[pivot][col]) > 1e-15)) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        const scale = a[col][col];
        for (let c = 0; c < 2 * n; c++) a[col][c] /= scale;
        for (let r = 0; r < n; r++) {
            if (r === col || a[r][col] === 0) continue;
            const factor = a[r][col];
            for (let c = 0; c < 2 * n; c++) a[r][c] -= factor * a[col][c];
        }
    }
    return a.map((row) => row.slice(n));
}

/**
 * How many protections a run is expected to draw from a stock of `stock` copies: E[min(stock, N)],
 * N being the protections the run consumes.
 *
 * `protectionCount` is E[N], and min(stock, E[N]) is not the same thing: a level with a 50%
 * success rate expects one failure, yet one held copy is spent in only half of runs. Since
 * min(·) is concave the shortcut always overstates what stock covers, and so understates the
 * bill whenever stock is cheaper than buying.
 *
 * Exactly, E[min(s, N)] = Σ_{k=1..s} P(N ≥ k). Let g_k(i) be the chance a run standing at +i
 * consumes at least k more protections before reaching the target. g_0 = 1, and g_k solves the
 * chain with the protected failures taken out as transitions and put back as the source term:
 * g_k = (I − Q′)⁻¹ · b_k, b_k(i) = P(protected failure at i) · g_{k−1}(i − 1). Q′ is the transient
 * block of the same chain `buildEnhancementMarkov` builds (Blessed Tea included), minus those
 * failures. That makes g_k = Lᵏ·1 for one fixed matrix L, so the whole tail sums in closed form:
 * with h = (I − L)⁻¹·1, E[N] = h(start) − 1 and Σ_{k>s} P(N ≥ k) = (L^{s+1}·h)(start). Two small
 * inversions and log₂(s) squarings, exact for any stock.
 *
 * @param {Object} args - Inputs
 * @param {number[]} args.successChances - Success chance per level 0..target−1, as decimals
 * @param {number} args.targetLevel - Absorbing level
 * @param {number} [args.startLevel=0] - Level the run starts from
 * @param {number} args.protectFrom - Protect-from level (0 = none)
 * @param {boolean} [args.blessedTea=false] - Whether Blessed Tea can double-jump
 * @param {number} [args.guzzlingBonus=1] - Drink concentration multiplier
 * @param {number} [args.blessedTeaBonus=0.01] - Blessed Tea double-jump chance as a decimal
 * @param {number} args.stock - Copies on hand
 * @returns {number|null} E[min(stock, N)], or null when the chain is not described well enough
 *   to solve (the caller then falls back to min(stock, E[N]))
 */
export function expectedProtectionsFromStock({
    successChances,
    targetLevel,
    startLevel = 0,
    protectFrom,
    blessedTea = false,
    guzzlingBonus = 1,
    blessedTeaBonus = 0.01,
    stock,
}) {
    const s = Math.max(0, Math.floor(Number(stock) || 0));
    if (s === 0 || !(protectFrom > 0)) return 0;
    const T = Math.floor(Number(targetLevel) || 0);
    if (!(T >= 1) || !Array.isArray(successChances) || successChances.length < T) return null;
    const start = Math.max(0, Math.min(T - 1, Math.floor(Number(startLevel) || 0)));

    const jump = blessedTea ? (Number(blessedTeaBonus) || 0) * (Number(guzzlingBonus) || 1) : 0;
    const A = Array.from({ length: T }, (_, i) => Array.from({ length: T }, (__, j) => (i === j ? 1 : 0)));
    const protectedFail = new Array(T).fill(0);
    for (let i = 0; i < T; i++) {
        const p = Math.min(1, Math.max(0, Number(successChances[i]) || 0));
        const skip = p * jump;
        // Landing on or past the target is absorbed, so those moves leave the transient block
        if (i + 1 < T) A[i][i + 1] -= p - skip;
        if (i + 2 < T) A[i][i + 2] -= skip;
        if (i >= protectFrom) protectedFail[i] = 1 - p;
        else A[i][0] -= 1 - p;
    }
    const inverse = invertSmall(A);
    if (!inverse) return null;

    // L maps g_{k−1} to g_k: L[i][j] = (I − Q′)⁻¹[i][j + 1] · P(protected failure at j + 1)
    const L = inverse.map((row) => row.map((_, j) => (j + 1 < T ? row[j + 1] * protectedFail[j + 1] : 0)));
    // h = Σ_{k≥0} Lᵏ·1 = (I − L)⁻¹·1, so h(start) = 1 + E[N]
    const minusL = L.map((row, i) => row.map((value, j) => (i === j ? 1 : 0) - value));
    const resolvent = invertSmall(minusL);
    if (!resolvent) return null;
    const h = resolvent.map((row) => row.reduce((sum, value) => sum + value, 0));
    const meanUses = h[start] - 1;

    // Σ_{k>s} P(N ≥ k) = (L^{s+1}·h)(start); square-and-multiply, since stock can run to thousands
    const matVec = (m, v) => m.map((row) => row.reduce((sum, value, j) => sum + value * v[j], 0));
    const matMul = (a, b) =>
        a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
    let beyond = h;
    let power = L;
    for (let e = s + 1; e > 0; e = Math.floor(e / 2)) {
        if (e % 2 === 1) beyond = matVec(power, beyond);
        if (e > 1) power = matMul(power, power);
    }
    const fromStock = meanUses - beyond[start];
    if (!Number.isFinite(fromStock)) return null;
    return Math.max(0, Math.min(s, meanUses, fromStock));
}

/**
 * The protection items worth pricing for an item: what is in the slot, and the cheapest other
 * thing that would work. The Philosopher's Mirror is not among them — it guarantees the attempt
 * instead of softening the fall, so the protect-from chain says nothing about it.
 *
 * With `holdingsOf`, every candidate the player holds spare copies of (above `reserve`) is
 * priced too, and each option carries what it can draw from the bag: `held`, `reserve`,
 * `stock` (the spare copies), `stockPrice` (what one would sell for — the run spends that, not
 * the ask) and `role` ('slot', 'cheapest' or 'held'). Without it the options are exactly what
 * they always were. A candidate with no buy quote can still be listed when its spare copies
 * have a sell value; the sweep keeps only rows whose expected uses those copies cover completely.
 *
 * @param {Object} args - Inputs
 * @param {string} args.itemHrid - The item being enhanced (it protects itself)
 * @param {Object} [args.itemDetails] - Its game data, for `protectionItemHrids`
 * @param {string|null} [args.selectedHrid] - What the panel's protection slot holds
 * @param {function(string): number} args.priceOf - Buy price for an item hrid, 0 when unknown
 * @param {function(string): string} [args.nameOf] - Display name for an item hrid
 * @param {function(string): number} [args.holdingsOf] - Copies of an item held at +0 that could
 *   be spent (the caller leaves out the copy on the bench); omit to ignore the bag
 * @param {number} [args.reserve=0] - Copies of each protection item to keep
 * @param {function(string): number} [args.sellPriceOf] - What one copy would sell for, 0 when
 *   unknown; falls back to the buy price, and never exceeds it
 * @returns {{options: Array<{itemHrid: string, name: string, price: number, selected: boolean,
 *   role?: string, held?: number, reserve?: number, stock?: number, stockPrice?: number}>,
 *   selectedIsMirror: boolean}} The selected one first, then the cheapest alternative, then any
 *   other held candidate, cheapest stock first. `selectedIsMirror` when the slot holds a
 *   Philosopher's Mirror, which the sweep cannot price
 */
export function chooseProtectionOptions({
    itemHrid,
    itemDetails,
    selectedHrid = null,
    priceOf,
    nameOf,
    holdingsOf,
    reserve = 0,
    sellPriceOf,
}) {
    const name = (hrid) => (typeof nameOf === 'function' ? nameOf(hrid) : null) || hrid;
    const selectedIsMirror = selectedHrid === PHILOSOPHERS_MIRROR_HRID;
    const selected = selectedIsMirror ? null : selectedHrid || null;
    const useStock = typeof holdingsOf === 'function';
    const keep = Math.max(0, Math.floor(Number(reserve) || 0));

    // What the bag can put toward an option. Only attached when the caller asked, so an option
    // built without holdings is the same object it always was
    const withStock = (option, role) => {
        if (!useStock) return option;
        const held = Math.max(0, Math.floor(Number(holdingsOf(option.itemHrid)) || 0));
        // Only the item protecting itself is held back: a Mirror of Protection or any other
        // protection item is spent freely
        const keepHere = option.itemHrid === itemHrid ? keep : 0;
        const spare = spareStock(held, keepHere);
        let stockPrice = 0;
        if (spare > 0) {
            const sell = typeof sellPriceOf === 'function' ? Number(sellPriceOf(option.itemHrid)) || 0 : 0;
            // A copy spent is a copy not sold. With no bid, what buying one would cost is the
            // stand-in; a bid above the ask is never what a copy is worth to keep
            stockPrice = sell > 0 ? (option.price > 0 ? Math.min(sell, option.price) : sell) : option.price;
        }
        // Stock nothing can value is left in the bag rather than spent for free
        return {
            ...option,
            ...(option.price > 0 ? {} : { buyPriceUnknown: true }),
            role,
            held,
            reserve: keepHere,
            stock: stockPrice > 0 ? spare : 0,
            stockPrice,
        };
    };

    const candidates = [itemHrid, MIRROR_OF_PROTECTION_HRID, ...(itemDetails?.protectionItemHrids || [])];
    if (selected && !candidates.includes(selected)) candidates.push(selected);

    const options = [];
    if (selected) {
        const selectedOption = withStock(
            { itemHrid: selected, name: name(selected), price: priceOf(selected) || 0, selected: true },
            'slot'
        );
        if (selectedOption.price > 0 || selectedOption.stock > 0) {
            options.push(selectedOption);
        }
    }

    let cheapest = null;
    const priced = [];
    const unpricedHeld = [];
    for (const hrid of new Set(candidates)) {
        if (!hrid || hrid === selected || hrid === PHILOSOPHERS_MIRROR_HRID) continue;
        const price = priceOf(hrid) || 0;
        const option = { itemHrid: hrid, name: name(hrid), price, selected: false };
        if (price > 0) {
            priced.push(option);
            if (!cheapest || price < cheapest.price) cheapest = option;
        } else if (useStock) {
            const heldOption = withStock(option, 'held');
            if (heldOption.stock > 0) unpricedHeld.push(heldOption);
        }
    }
    // The alternative earns its column when there is nothing selected, the selected item has
    // no price, or it is genuinely cheaper than what is in the slot
    const showCheapest = Boolean(
        cheapest && (!selected || !(options[0]?.price > 0) || cheapest.price < options[0].price)
    );
    if (showCheapest) options.push(withStock(cheapest, 'cheapest'));

    // Every other candidate the player holds spare copies of earns a column of its own: the
    // cheapest plan may well be the one that spends what is already in the bag. A candidate
    // with no buy price stays out — its rows would buy the shortfall for nothing
    if (useStock) {
        const held = priced
            .filter((option) => !(showCheapest && option === cheapest))
            .map((option) => withStock(option, 'held'))
            .filter((option) => option.stock > 0)
            .concat(unpricedHeld)
            .sort((a, b) => a.stockPrice - b.stockPrice);
        options.push(...held);
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
 *   attemptsStdDev, protections, expectedCost, costStdDev, p10, p90, spreadApprox, xp,
 *   goldPerXp, time, and the stock split protectionsFromStock (E[min(stock, N)]),
 *   protectionsToBuy, stockPrice, stockSplitApprox. `spreadApprox` marks the rows whose p10–p90
 *   is only approximate; `stockSplitApprox` the rows whose split fell back to min(stock, E[N]).
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

    // E[min(stock, N)] per protect-from level and stock size; options sharing a stock share it
    const fromStockCache = new Map();
    const expectedFromStock = (calc, protectFrom, stock, protections) => {
        const key = `${protectFrom}:${stock}`;
        if (!fromStockCache.has(key)) {
            const exact = expectedProtectionsFromStock({
                successChances: Array.isArray(calc.successRates)
                    ? calc.successRates.map((rate) => (Number(rate?.actualRate) || 0) / 100)
                    : null,
                targetLevel: target,
                startLevel: start,
                protectFrom,
                blessedTea: Boolean(chain?.blessedTea),
                guzzlingBonus: chain?.guzzlingBonus ?? 1,
                blessedTeaBonus: chain?.blessedTeaBonus ?? 0.01,
                stock,
            });
            fromStockCache.set(key, exact);
        }
        const exact = fromStockCache.get(key);
        // No exact figure (a calculator result without per-level success rates): the mean-count
        // shortcut, which overstates what stock covers, and the row says so
        if (exact === null) return { value: Math.min(stock, protections), approx: true };
        return { value: Math.min(protections, exact), approx: false };
    };

    const buildRow = (calc, protectFrom, option) => {
        const protections = protectFrom > 0 ? calc.protectionCount || 0 : 0;
        const protectionPrice = option?.price || 0;
        // Spare copies in the bag go first, at what they would have sold for; the rest are bought.
        // The split is E[min(stock, N)] over the run's protection uses N — not min(stock, E[N]),
        // which spends a held copy in every run that merely expects to need one
        const stockPrice = option?.stockPrice > 0 ? option.stockPrice : 0;
        const stock = stockPrice > 0 ? Math.max(0, Math.floor(option?.stock || 0)) : 0;
        const split =
            stock > 0 && protections > 0
                ? expectedFromStock(calc, protectFrom, stock, protections)
                : { value: 0, approx: false };
        const protectionsFromStock = split.value;
        const protectionsToBuy = protections - protectionsFromStock;
        const protectionCost = protectionsFromStock * stockPrice + protectionsToBuy * protectionPrice;
        // Protection is consumed on protected failures, whose expected count scales with the
        // attempt count — so it folds into the per-attempt rate the cost distribution is built on
        const protectionPerAttempt = calc.attempts > 0 ? protectionCost / calc.attempts : 0;
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
            protectionsFromStock,
            protectionsToBuy,
            stockSplitApprox: split.approx,
            stockPrice,
            expectedCost: stats.expected,
            costStdDev: stats.stdDev,
            p10: percentiles.p10,
            p90: percentiles.p90,
            // The percentiles come from a distribution over attempts at one
            // cost each, and protection is not spent once per attempt — it is
            // spent on protected failures. Folding it into the per-attempt rate
            // gets the mean right and only approximates the spread, so a row
            // that uses protection says so rather than implying a precision the
            // model does not have
            spreadApprox: protectionPerAttempt > 0,
            xp,
            goldPerXp: xp > 0 ? stats.expected / xp : null,
            time: seconds,
        };
    };

    const rows = [buildRow(solve(NO_PROTECTION), NO_PROTECTION, null)];

    // Protected rows need either a buy quote or stock whose expected uses cover the whole run.
    // An unknown buy quote on the remaining amount must not create a free route.
    if (target >= MIN_PROTECT_FROM && protectionOptions.length > 0) {
        const levels = protectFromLevels(target);
        const solves = new Map();
        for (const protectFrom of levels) {
            solves.set(protectFrom, solve(protectFrom));
        }
        for (const option of protectionOptions) {
            for (const protectFrom of levels) {
                const row = buildRow(solves.get(protectFrom), protectFrom, option);
                // A known stock value prices only the copies the run expects to use from the
                // bag. Do not turn an unknown buy quote for the shortfall into a free route.
                if (!option.buyPriceUnknown || row.protectionsToBuy <= 1e-12) rows.push(row);
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

/**
 * What one run costs, on the cheapest protect-from plan.
 *
 * The enhancing panel wants the whole column — that is `sweepProtectFrom`. Every
 * other surface wants one number: what does it cost me to take *this* piece from
 * where it is to where I want it. That question was being answered by three
 * separate sweeps (the item tooltip, the sim's upgrade advisor, the inventory
 * savings card) which had drifted apart; this is the one answer they now share.
 *
 * ## From where it is now, always
 *
 * The run is solved from `startLevel`, not priced as the difference between two
 * runs from +0. The advisor used to do the latter — `fullCost[target] −
 * fullCost[start]` — and the surprise, recorded in `enhancement-cost-parity.test.js`,
 * is that the two are the *same number* almost everywhere: an item cannot skip a
 * level, so every path from +0 to +7 passes through +4 and the expected attempts
 * split exactly at the crossing. They part only under Blessed Tea, whose double
 * jump can vault the start level; there the difference undercounts the real run
 * by about a per cent. Solving from the start level is right in both cases and
 * is the only form that can say what it means.
 *
 * ## Unpriceable is not free
 *
 * `null` when nothing about the run can be priced, and `hasMissingPrices` when
 * part of it could not be. A run quoted at 0 goes to the top of every value
 * ranking it appears in, which is the failure mode this shape exists to prevent.
 *
 * @param {Object} args - Same shape as {@link sweepProtectFrom}, plus:
 * @param {boolean} [args.hasMissingPrices=false] - Whether the caller's material
 *   tally left something unpriced (from `perAttemptMaterialCost`)
 * @returns {{cost: number, protectFrom: number, protectionItemHrid: string|null,
 *   attempts: number, protections: number, hasMissingPrices: boolean}|null} The
 *   cheapest plan, or null when the run cannot be priced at all
 */
export function cheapestProtectPlan({ hasMissingPrices = false, ...args }) {
    const { rows, cheapestIndex } = sweepProtectFrom(args);
    const row = rows[cheapestIndex];
    // Nothing priced at all: not a free run, an unknown one
    if (!row || !(row.expectedCost > 0)) return null;

    return {
        cost: row.expectedCost,
        protectFrom: row.protectFrom,
        protectionItemHrid: row.itemHrid,
        attempts: row.attempts,
        protections: row.protections,
        hasMissingPrices: Boolean(hasMissingPrices),
    };
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
    // Holdings and the reserve are in it: a copy bought, sold or spent, or a changed keep-N,
    // moves what the bag covers and so every protected row
    const options = (args.protectionOptions || []).map((option) => [
        option.itemHrid,
        option.price,
        option.selected,
        option.held ?? null,
        option.reserve ?? null,
        option.stock ?? null,
        option.stockPrice ?? null,
    ]);
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
