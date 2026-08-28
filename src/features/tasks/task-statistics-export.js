/**
 * Task Statistics CSV export
 *
 * The same per-task figures the Statistics popup already draws — reward,
 * action profit, completion time — turned into a CSV string, so they can
 * leave the popup into a spreadsheet or a chat message rather than being
 * retyped by hand. A pure string builder, kept apart from the popup's DOM
 * code so it is testable without one.
 */

/**
 * Escape one CSV field.
 *
 * Wrapped in quotes, with any embedded quote doubled, only when the field
 * contains something a bare field could not carry — a comma, a quote, or a
 * newline. Most fields here are numbers or short task names and pass through
 * unquoted.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function csvField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

/**
 * Build a CSV of the active board's per-task rewards.
 *
 * One row per task, in the same order the popup lists them, plus a trailing
 * Total row carrying the same sums the "Combined Total" / "Total (non-combat)"
 * rows show. A task whose action profit or completion time could not be priced
 * is left blank in that column, the same distinction the popup draws between
 * an unpriced task and a genuine zero.
 *
 * @param {Object} rewards - `TaskStatistics.calculateRewardsSummary()` output
 * @returns {string} CSV text, header row first, LF line endings
 */
export function buildTaskStatisticsCsv(rewards) {
    const header = ['Task', 'Type', 'Coins', 'Tokens', 'Action Profit', 'Completion (s)', 'Progress'];
    const rows = [header];

    for (const detail of rewards?.taskDetails || []) {
        rows.push([
            detail.name,
            detail.isCombat ? 'Combat' : 'Action',
            detail.coinReward,
            detail.tokenReward,
            detail.isCombat ? '' : (detail.actionProfit ?? ''),
            detail.isCombat ? '' : (detail.completionSeconds ?? ''),
            `${detail.currentCount}/${detail.goalCount}`,
        ]);
    }

    rows.push([
        'Total',
        '',
        rewards?.totalCoins ?? '',
        rewards?.totalTokens ?? '',
        rewards?.totalActionProfit ?? '',
        rewards?.totalCompletionSeconds ?? '',
        '',
    ]);

    return rows.map((row) => row.map(csvField).join(',')).join('\n');
}
