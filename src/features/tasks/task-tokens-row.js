/**
 * Task Tokens overlay row
 *
 * What the task board is worth in tokens, and what a token is worth in coins.
 *
 * ## Why this is not tokens per hour
 *
 * It was asked for as a rate, and a rate is not honestly available. A rate needs
 * two things: tokens earned, and the time they took. Nothing in this codebase
 * records a completed task — the reroll tracker records rerolls, the statistics
 * panel reads the board as it stands now, and neither keeps a history of tasks
 * turned in. The only per-task duration that exists comes out of
 * `calculateTaskProfit`, which prices every input and output of the action
 * against the order book; that is an `await` and a market pass, and a row
 * redrawn once a second may not do either.
 *
 * The remaining option was to measure the task token count in the inventory over
 * time, which would have been a rate about *spending*: the number falls every
 * time you buy anything in the Task Shop, so an afternoon of shopping reads as
 * negative tokens per hour. A tile that goes negative while you are earning is
 * worse than a tile that does not claim to be a rate.
 *
 * So it reports what is actually known: the tokens the tasks on the board will
 * pay when they are finished, and what the Task Shop says a token is worth.
 * Both are read synchronously from state the game already has.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { calculateTaskTokenValue } from './task-profit-calculator.js';
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
 * Open the task statistics popup, or close it if it is already up.
 *
 * The popup is the tile's own figures in full — every task, what each pays, and
 * what the board has already cost in rerolls — so it is what belongs behind a
 * double-click. It builds itself asynchronously and the overlay calls `onOpen`
 * inside a synchronous try/catch, so the rejection is caught here rather than
 * escaping as an unhandled promise.
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
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const { tasks, tokens } = boardTokens();
        if (!tasks) return blank(container);

        const valuation = calculateTaskTokenValue();
        const perToken = valuation?.totalPerToken;
        const worth = Number.isFinite(perToken) ? tokens * perToken : null;

        row(container, [
            { icon: TASK_TOKEN_HRID, size: 18 },
            { text: formatWithSeparator(tokens), color: ROW_COLORS.violet, bold: true },
            {
                text: worth === null ? '—' : formatLargeNumber(Math.round(worth)),
                color: worth === null ? ROW_COLORS.dim : ROW_COLORS.gold,
                push: true,
            },
        ]);

        container.title =
            `${formatWithSeparator(tokens)} task tokens across ${tasks} task${tasks === 1 ? '' : 's'} in progress.\n` +
            (Number.isFinite(perToken)
                ? `A token is worth about ${Math.round(perToken).toLocaleString()} coins, ` +
                  'from the best line in the Task Shop plus a prorated Purple’s Gift.'
                : `Token value unavailable: ${valuation?.error || 'the Task Shop has not loaded'}.`) +
            '\nThis is what the board will pay, not a rate — nothing here records finished tasks.' +
            '\nDouble-click for the task statistics.';
    },
    onOpen: toggleStatistics,
});
