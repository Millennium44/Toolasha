/**
 * Task Payout Analysis
 *
 * "Which kind of task actually pays?" — the arithmetic behind the task
 * statistics panel's realized-payout card.
 *
 * ## Realized, not forecast
 *
 * The rest of that panel prices the board as it stands: what the three tasks
 * in front of you would be worth if you did them. This is made of things that
 * happened — the claims the completion tracker recorded over its eight-week
 * window, each one's own coins, tokens and items.
 *
 * The items are priced at **today's** prices, because that is the only price
 * there is: nothing records what a Sundried Tomato was worth the afternoon it
 * was claimed. A claim from seven weeks ago is therefore valued at a price it
 * was never realized at, which is a real distortion when a price has moved and
 * the reason the card labels the figure as today's prices rather than calling
 * it realized income.
 *
 * ## No per-hour figures, ever
 *
 * A completion entry carries `completedAt` and nothing else about time — no
 * start, no duration, no action count. There is no honest denominator for a
 * rate, and dividing by wall-clock between claims would measure how often the
 * character was logged in, not how fast the task went. The card says so out
 * loud rather than leaving the absence to be noticed.
 *
 * ## What "net of rerolls" can and cannot mean
 *
 * Reroll spend is recorded per retired task, keyed by the same quest id the
 * completion carries, so the join is exact where both sides have the task. It
 * is not exhaustive: a task claimed before the reroll tracker retired it, or
 * one that aged past the reroll history's cap, has no spend record — and an
 * absent record is not the same fact as a zero. So the net figure is computed
 * only over the claims the join actually reached, and the count it rests on is
 * reported next to it.
 */

/**
 * How few claims a row may rest on and still show a median.
 *
 * Task payouts within a category are wide — a goal count varies severalfold and
 * the item rolls vary more — so a median over two or three claims is noise
 * presented as a finding. Rows under the gate keep their claim count, because
 * "you have only done four of these" is itself worth knowing, and show no
 * money.
 */
export const MIN_CLAIMS = 5;

/**
 * A category slug as a heading.
 *
 * The tracker stores bare slugs (`combat`, `cheesesmithing`, `unknown`), and
 * nothing in the codebase turns one into a label; the panel's own skill labels
 * are built from action-detail types, which a stored completion does not carry.
 * @param {string} category - Slug from a completion entry
 * @returns {string} Title-cased label
 */
export function categoryLabel(category) {
    const slug = (category || 'unknown').replace(/_/g, ' ');
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * The middle value of a numeric list.
 * @param {Array<number>} values - Numbers, any order
 * @returns {number|null} Median, or null when there is nothing finite in it
 */
export function median(values) {
    const sorted = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What one claim was worth, at today's prices.
 *
 * Coins, tokens and the prorated per-task gift go through the panel's own
 * reward valuation so this card cannot come to disagree with the rows above
 * it about what a token is worth. Items are priced one stack at a time, and a
 * stack with no price is **left out and counted** rather than treated as
 * worthless: a task whose only reward is an unpriced item would otherwise be
 * reported as paying nothing at all, which is a much worse answer than "one
 * reward could not be priced".
 *
 * @param {Object} entry - Completion entry `{coins, tokens, items}`
 * @param {Object} pricing - Valuation hooks
 * @param {Function} pricing.valueRewards - `({coins, tokens, taskCount}) => number|null`
 * @param {Function} pricing.priceItem - `(itemHrid) => number|null`, per unit
 * @returns {{value: number|null, unpricedStacks: number}} Claim value and how many stacks were skipped
 */
export function claimValue(entry, { valueRewards, priceItem } = {}) {
    const base = valueRewards
        ? valueRewards({ coins: entry?.coins || 0, tokens: entry?.tokens || 0, taskCount: 1 })
        : null;
    if (base === null || base === undefined) return { value: null, unpricedStacks: 0 };

    let items = 0;
    let unpricedStacks = 0;
    for (const stack of entry?.items || []) {
        const unit = priceItem ? priceItem(stack?.itemHrid) : null;
        if (typeof unit === 'number' && unit > 0) {
            items += unit * (stack?.count || 0);
        } else {
            unpricedStacks += 1;
        }
    }

    return { value: base + items, unpricedStacks };
}

/**
 * Reroll spend per quest id, in coins.
 *
 * Cowbells are converted so gold and cowbells can be one number; a cowbell
 * value of zero (the shop item unpriced) silently drops the cowbell half,
 * which is the same fallback the panel's existing spend row takes.
 * @param {Array<Object>} history - Reroll history entries `{taskId, goldSpent, cowbellsSpent}`
 * @param {number} cowbellValue - Coins per cowbell
 * @returns {Map<number, number>} questId → coins spent rerolling it
 */
export function spendByQuest(history, cowbellValue = 0) {
    const byQuest = new Map();
    for (const retired of Array.isArray(history) ? history : []) {
        if (!retired || retired.taskId === undefined || retired.taskId === null) continue;
        const coins = (retired.goldSpent || 0) + (retired.cowbellsSpent || 0) * cowbellValue;
        byQuest.set(retired.taskId, (byQuest.get(retired.taskId) || 0) + coins);
    }
    return byQuest;
}

/**
 * Split one category's claims at its own median goal count.
 *
 * Fixed goal-count bands would be wrong for every category at once — a combat
 * task's goal count and a cooking task's are not on the same scale — so the
 * split point comes from the data: the category's median goal, with claims at
 * or below it on one side. Returned only when **both** halves clear the gate
 * and the split actually separates something; a category whose goals are all
 * the same number has no bands to show, and neither does a thin one.
 *
 * @param {Array<Object>} claims - `{goalCount, value, net}` for one category
 * @param {number} [minClaims=MIN_CLAIMS] - Gate each half must clear
 * @returns {Array<Object>} Zero or two bands, each `{label, claims, medianPayout}`
 */
export function goalBands(claims, minClaims = MIN_CLAIMS) {
    const goals = claims.map((claim) => claim.goalCount).filter((goal) => Number.isFinite(goal));
    if (goals.length !== claims.length) return [];

    const split = median(goals);
    if (split === null) return [];

    const low = claims.filter((claim) => claim.goalCount <= split);
    const high = claims.filter((claim) => claim.goalCount > split);
    if (low.length < minClaims || high.length < minClaims) return [];

    return [
        { label: `goal ≤ ${split}`, claims: low.length, medianPayout: median(low.map((claim) => claim.value)) },
        { label: `goal > ${split}`, claims: high.length, medianPayout: median(high.map((claim) => claim.value)) },
    ];
}

/**
 * Median realized payout per claim, by task category.
 *
 * @param {Object} params - Inputs
 * @param {Array<Object>} params.completions - Completion entries from the tracker
 * @param {Array<Object>} [params.rerollHistory] - Retired-task reroll records
 * @param {number} [params.cowbellValue=0] - Coins per cowbell, for the spend join
 * @param {Function} params.valueRewards - `({coins, tokens, taskCount}) => number|null`
 * @param {Function} params.priceItem - `(itemHrid) => number|null`, per unit
 * @param {number} [params.minClaims=MIN_CLAIMS] - Per-row gate
 * @returns {{rows: Array<Object>, thin: Array<Object>, totalClaims: number, valuedClaims: number,
 *   unpricedStacks: number, unpricedClaims: number, best: Object|null, worst: Object|null}}
 *   `rows` are the categories that cleared the gate, richest first, each
 *   `{category, label, claims, medianPayout, netMedian, attributed, bands}`.
 */
export function analyzeTaskPayouts({
    completions,
    rerollHistory = [],
    cowbellValue = 0,
    valueRewards,
    priceItem,
    minClaims = MIN_CLAIMS,
} = {}) {
    const spend = spendByQuest(rerollHistory, cowbellValue);
    const byCategory = new Map();

    let totalClaims = 0;
    let valuedClaims = 0;
    let unpricedStacks = 0;
    let unpricedClaims = 0;

    for (const entry of Array.isArray(completions) ? completions : []) {
        if (!entry) continue;
        totalClaims += 1;

        const { value, unpricedStacks: skipped } = claimValue(entry, { valueRewards, priceItem });
        unpricedStacks += skipped;
        if (skipped > 0) unpricedClaims += 1;
        // A claim the token valuation could not price at all is not a zero-payer
        if (value === null) continue;
        valuedClaims += 1;

        const category = entry.category || 'unknown';
        const claims = byCategory.get(category);
        const attributedSpend = spend.has(entry.questId) ? spend.get(entry.questId) : null;
        const claim = {
            goalCount: entry.goalCount,
            value,
            net: attributedSpend === null ? null : value - attributedSpend,
        };
        if (claims) claims.push(claim);
        else byCategory.set(category, [claim]);
    }

    const rows = [];
    const thin = [];
    for (const [category, claims] of byCategory) {
        if (claims.length < minClaims) {
            thin.push({ category, label: categoryLabel(category), claims: claims.length });
            continue;
        }
        const attributed = claims.filter((claim) => claim.net !== null);
        rows.push({
            category,
            label: categoryLabel(category),
            claims: claims.length,
            medianPayout: median(claims.map((claim) => claim.value)),
            // Net only over the claims the reroll join actually reached; an
            // absent spend record is not a zero, so it must not average as one
            netMedian: attributed.length >= minClaims ? median(attributed.map((claim) => claim.net)) : null,
            attributed: attributed.length,
            bands: goalBands(claims, minClaims),
        });
    }

    rows.sort((a, b) => b.medianPayout - a.medianPayout);
    thin.sort((a, b) => b.claims - a.claims);

    // Only worth naming a best and a worst when there are two rows to compare;
    // "your best category is your only category" is not a finding
    const comparable = rows.length >= 2;

    return {
        rows,
        thin,
        totalClaims,
        valuedClaims,
        unpricedStacks,
        unpricedClaims,
        best: comparable ? rows[0] : null,
        worst: comparable ? rows[rows.length - 1] : null,
    };
}
