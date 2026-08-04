/**
 * Task Tokens overlay row
 *
 * What the task board is worth in tokens, what a token is worth in coins, and —
 * once there is anything to measure it from — what tasks are actually paying per
 * hour.
 *
 * ## The rate, and where it comes from
 *
 * This tile used to say outright that a rate was not available, and it was
 * right: a rate needs tokens earned and the time they took, and nothing in the
 * codebase recorded a finished task. `task-completion-tracker.js` records them
 * now — one entry per claimed task, with the tokens and coins it paid — so the
 * rate here is measured from claims that actually happened rather than modelled
 * from the board.
 *
 * It is a wall-clock rate: the tracker knows when tasks were claimed and not how
 * many of the hours between them were spent playing. The tooltip says so, in
 * those words, because a number labelled "tokens/hr" that quietly counts a night
 * of sleep is worse than one that admits what it measured.
 *
 * The alternative — measuring the task token count in the inventory over time —
 * would have been a rate about *spending*: the number falls every time you buy
 * anything in the Task Shop, so an afternoon of shopping would read as negative
 * tokens per hour.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { rows, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { calculateTaskTokenValue } from './task-profit-calculator.js';
import taskCompletionTracker from './task-completion-tracker.js';
import taskStatistics from './task-statistics.js';

/** The board's own token, for the icon */
const TASK_TOKEN_HRID = '/items/task_token';

/**
 * The tasks in progress and what they will pay in tokens.
 *
 * Read straight off `characterQuests` with the same two filters the statistics
 * panel uses, rather than through the panel — the panel is a feature that may
 * be switched off, and a tile that goes blank because an unrelated setting is
 * off is a tile nobody can explain.
 *
 * @returns {{tasks: number, tokens: number}} Counts; zero tasks when nothing is on the board
 */
export function boardTokens() {
    const quests = Array.isArray(dataManager.characterQuests) ? dataManager.characterQuests : [];
    let tasks = 0;
    let tokens = 0;

    for (const quest of quests) {
        if (quest?.category !== '/quest_category/random_task') continue;
        if (quest?.status !== '/quest_status/in_progress') continue;
        tasks += 1;

        // The rewards are JSON on the wire; a task whose rewards will not parse
        // is still a task, and counting it without its tokens is closer than
        // dropping it
        try {
            for (const reward of JSON.parse(quest.itemRewardsJSON || '[]')) {
                if (reward?.itemHrid === TASK_TOKEN_HRID) tokens += reward.count || 0;
            }
        } catch (error) {
            console.error('[TaskTokensRow] A task’s rewards could not be read:', error);
        }
    }

    return { tasks, tokens };
}

/**
 * A per-hour figure at a width a tile can afford.
 *
 * Small rates keep a decimal — the difference between 4 and 4.2 tokens an hour
 * is most of the reason to look — and large ones do not, because at 12,400 coins
 * an hour the decimal is noise.
 *
 * @param {number} value - Per-hour figure
 * @returns {string} Formatted, or an em dash when there is no figure
 */
export function formatRate(value) {
    if (!Number.isFinite(value)) return '—';
    if (Math.abs(value) >= 100) return formatLargeNumber(Math.round(value));
    return value.toFixed(1);
}

/**
 * The measured rates, or null when the tracker cannot answer.
 *
 * The tile is drawn about once a second and a throw here would take the whole
 * overlay row with it, which is a high price for a figure the tile can simply
 * leave out.
 *
 * @returns {Object|null} `{session, week, total}` as the tracker computes them
 */
function measuredRates() {
    try {
        return taskCompletionTracker.rates();
    } catch (error) {
        console.error('[TaskTokensRow] The measured task rate could not be read:', error);
        return null;
    }
}

/**
 * What the tooltip says about the rate.
 *
 * @param {Object|null} rates - `{session, week}` from the tracker
 * @returns {string} Lines for the tooltip, starting with a newline, or ''
 */
function rateTooltip(rates) {
    const week = rates?.week;
    if (!week) return '';

    if (week.completions < 2) {
        const seen = week.completions === 0 ? 'No tasks' : 'One task';
        return (
            `\n${seen} claimed in the last 7 days — a rate needs two, ` +
            'since the first one is only the moment the clock starts.'
        );
    }

    const hours = week.spanMs / 3600000;
    const lines = [
        `\n${formatRate(week.tokensPerHour)} tokens/hr and ${formatRate(week.coinsPerHour)} coins/hr, ` +
            `from ${week.completions} tasks claimed over ${hours.toFixed(1)}h.`,
        'Wall-clock rate: measured between your first and last claim in the window, ' +
            'including any hours the game was closed. The first claim starts the clock, so its rewards are not counted.',
    ];

    const session = rates.session;
    if (session?.tokensPerHour !== null && session?.tokensPerHour !== undefined) {
        lines.push(`Today: ${formatRate(session.tokensPerHour)} tokens/hr from ${session.completions} tasks.`);
    }

    return lines.join('\n');
}

/**
 * Open the task statistics popup, or close it if it is already up.
 *
 * The popup is the tile's own figures in full — every task, what each pays, what
 * the board has already cost in rerolls, and the completions the rate is
 * measured from — so it is what belongs behind a double-click. It builds itself
 * asynchronously and the overlay calls `onOpen` inside a synchronous try/catch,
 * so the rejection is caught here rather than escaping as an unhandled promise.
 *
 * @returns {Promise<void>}
 */
async function toggleStatistics() {
    try {
        if (taskStatistics.overlay) taskStatistics.closePopup();
        else await taskStatistics.showPopup();
    } catch (error) {
        console.error('[TaskTokensRow] Opening the task statistics failed:', error);
    }
}

registerRow({
    key: 'taskTokens',
    name: 'Task Tokens',
    empty: 'No tasks on the board',
    defaultVisible: false,
    defaultSize: { width: 200, height: 44 },
    render: (container) => {
        const { tasks, tokens } = boardTokens();
        if (!tasks) return blank(container);

        const valuation = calculateTaskTokenValue();
        const perToken = valuation?.totalPerToken;
        const worth = Number.isFinite(perToken) ? tokens * perToken : null;

        const rates = measuredRates();
        const week = rates?.week;
        const hasRate = Number.isFinite(week?.tokensPerHour);

        const lines = [
            [
                { icon: TASK_TOKEN_HRID, size: 18 },
                { text: formatWithSeparator(tokens), color: ROW_COLORS.violet, bold: true },
                {
                    text: worth === null ? '—' : formatLargeNumber(Math.round(worth)),
                    color: worth === null ? ROW_COLORS.dim : ROW_COLORS.gold,
                    push: true,
                },
            ],
        ];

        // Only once two tasks have been claimed: one claim is a timestamp, not
        // a rate, and a tile that showed a figure from it would be inventing one
        if (hasRate) {
            lines.push([
                { text: `${formatRate(week.tokensPerHour)} tokens/hr`, color: ROW_COLORS.violet },
                { text: 'this week', color: ROW_COLORS.dim, push: true },
            ]);
        }

        rows(container, lines);

        container.title =
            `${formatWithSeparator(tokens)} task tokens across ${tasks} task${tasks === 1 ? '' : 's'} in progress.\n` +
            (Number.isFinite(perToken)
                ? `A token is worth about ${Math.round(perToken).toLocaleString()} coins, ` +
                  'from the best line in the Task Shop plus a prorated Purple’s Gift.'
                : `Token value unavailable: ${valuation?.error || 'the Task Shop has not loaded'}.`) +
            '\nThat figure is what the board will pay when it is finished, not a rate.' +
            rateTooltip(rates) +
            '\nDouble-click for the task statistics.';
    },
    onOpen: toggleStatistics,
});

/**
 * Start recording completions.
 *
 * Here because this module is imported unconditionally by the UI bundle while
 * the tracker is what the rate above is made of, and because recording has to
 * carry on whether or not the tile is switched on — a rate that only accrues
 * while you are looking at it is not a rate. The tracker is idempotent and
 * swallows its own failures, so this is a call and not a promise anyone waits on.
 */
taskCompletionTracker.initialize();
