/**
 * Lab Sim upgrade tables as cards: the pure half.
 *
 * The Lab's tables each hold their rows already sorted, with every cell already worked out (the strings the
 * table prints). Nothing here ranks, scores or formats a figure of its own: a section describes its columns once
 * (label, the cell text, its tone, the sentence a header would show on hover), and `labCardEntries` turns the
 * rows, in the order the table drew them, into the entries `buildUpgradeCards` (`upgrade-cards.js`) draws. Card N is
 * row N because the same array is walked.
 */

import { figure, UNKNOWN_TEXT } from './upgrade-cards.js';

/** The em dash a table prints where a cost or value is missing */
const DASHES = new Set(['—', '—', '-', '']);

/**
 * A table's dash read as a word. A missing price must not read as zero, and an empty cell would read as nothing.
 * @param {string} html - A cell's text or markup
 * @returns {string} The same, or "unknown" when the cell is only a dash
 */
export function dashToUnknown(html) {
    return DASHES.has(String(html ?? '').trim()) ? UNKNOWN_TEXT : html;
}

/**
 * @typedef {Object} LabColumn
 * @property {string} key - The table's sort key for this column
 * @property {string|function(Object): string} label - Visible name (a function when it depends on the row)
 * @property {'face'|'delta'|'fact'} band - face and delta are shown under the name, fact only in Details
 * @property {function(Object): string} html - The cell's own text, as the table prints it
 * @property {function(Object): ('good'|'bad'|'warn'|'neutral'|'muted')} [tone]
 * @property {string|function(Object): string} [title] - The header's hover sentence, for the section's "What the columns mean"
 * @property {function(Object): boolean} [show] - False leaves the figure out for that row
 */

/**
 * Turn a table's rows into card entries.
 * @param {Object} spec
 * @param {Array<Object>} spec.rows - The table's rows, in the order it draws them
 * @param {Array<LabColumn>} spec.columns - The table's columns
 * @param {string} spec.headKey - The column under the selected Rank by (the table's sort key)
 * @param {string} spec.fallbackHead - The column that leads when the table is ordered by name
 * @param {function(Object): string} spec.nameOf - Plain text name
 * @param {function(Object): string} spec.keyOf - The row's identity
 * @param {function(Object, number): Object} [spec.extra] - More entry fields (actions, detail, verify state, ...)
 * @returns {Array<Object>} Entries for `buildUpgradeCards`, in row order
 */
export function labCardEntries({ rows, columns, headKey, fallbackHead, nameOf, keyOf, extra = () => ({}) }) {
    const lead = columns.some((c) => c.key === headKey) ? headKey : fallbackHead;
    return rows.map((row, index) => {
        const made = (c) => {
            if (c.show && !c.show(row)) return null;
            const label = typeof c.label === 'function' ? c.label(row) : c.label;
            const title = typeof c.title === 'function' ? c.title(row) : c.title || '';
            return figure(label, c.html(row), c.tone ? c.tone(row) : 'neutral', title);
        };
        const others = (band) => columns.filter((c) => c.band === band && c.key !== lead).map(made);
        const headColumn = columns.find((c) => c.key === lead);
        return {
            row,
            key: keyOf(row),
            name: nameOf(row),
            headline: headColumn ? made(headColumn) : null,
            lines: [others('face').filter(Boolean), others('delta').filter(Boolean)],
            facts: others('fact').filter(Boolean),
            ...extra(row, index),
        };
    });
}

/**
 * The end of a column a table starts at when its header is first clicked, and the end that is the good news,
 * for the single-fight and skilling tables (which open every new column at 'desc', the name at 'asc').
 */
export const SINGLE_FIGHT_BEST_DIR = Object.freeze({
    desc: 'asc',
    tokenCost: 'asc',
    cost: 'asc',
    rateVal: 'desc',
    winRate: 'desc',
    clearRate: 'desc',
    deltaVal: 'desc',
    roomLevelDelta: 'desc',
    floorVal: 'desc',
    tokensPerPct: 'asc',
    goldPerPct: 'asc',
    cowbellCost: 'asc',
    xpPerRoom: 'desc',
    xpDelta: 'desc',
    tokensPerXp: 'asc',
    roomsAffected: 'desc',
    tries: 'asc',
    triesDelta: 'asc',
});

/**
 * The sort a header click on `key` writes in the single-fight and skilling tables.
 * @param {string} key - The column
 * @returns {{key: string, dir: 'asc'|'desc'}}
 */
export function singleFightHeaderSort(key) {
    return { key, dir: key === 'desc' ? 'asc' : 'desc' };
}

/**
 * Whether a table is ordered with the good news last.
 * @param {{key: string, dir: string}|null} state - The sort in force
 * @param {Object} bestDir - Column key → the direction that puts the best first
 * @returns {boolean} False for a column with no stated best end
 */
export function isWorstFirst(state, bestDir) {
    const best = state ? bestDir?.[state.key] : null;
    return Boolean(best && state.dir !== best);
}

export const LAB_CARD_STYLE_ID = 'mwi-lab-upgrade-cards';

/** The Lab-only parts of a card: the Sim together pick box beside a skilling card's name */
export const LAB_CARD_CSS = `
    .mwi-lab-pick { display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; font-size: 10px;
        font-weight: 400; color: #9ab; cursor: pointer; white-space: nowrap; }
    .mwi-lab-pick input { margin: 0; cursor: pointer; }
    @media (pointer: coarse) {
        .mwi-lab-pick { min-height: 34px; padding: 0 6px; }
        .mwi-lab-pick input { width: 18px; height: 18px; }
    }
`;

/**
 * The record kept for the Cards | Table pick, read back whatever shape it was saved in.
 * Re-exported from `upgrade-cards.js` so the Lab and Combat Sim read the pick the same way.
 */
export { normalizeViewChoices, resolveCardView, withViewChoice } from './upgrade-cards.js';
