/**
 * The ledger and the planner, drawn.
 *
 * Two questions a guild leader asks that no surface in the game answers, in one
 * panel because they are the same conversation held at two ends of a week: who
 * turned up and what they did (`guild-trial-ledger.js`), and whether the list
 * about to sign up can actually clear the tier (`guild-trial-composition.js`).
 *
 * Everything below is drawing. The arithmetic, the lint rules and the storage
 * all live in those two modules and are tested without a DOM; what is here is
 * the sortable table, the window selector, the coverage line, the CSV button and
 * the paste box — plus the one piece of state a redraw must not lose, which is
 * whatever the user has half-typed into the roster box.
 *
 * ## Why a panel and not a tab on the guild page
 *
 * `guild-trials.js` decorates the game's own trial cards, and those cards are
 * only on screen while the guild page is open on the right tab. The ledger is
 * read *between* trials — on a Sunday, deciding who to message — so it is a
 * floating panel and an overlay row, reachable whatever the page is showing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import { loadLoadouts } from './guild-loadouts.js';
import {
    LEDGER_COLUMNS,
    LEDGER_CSV_COLUMNS,
    LEDGER_WINDOWS,
    foldLedgerCycles,
    ledgerCsvRows,
    loadLedgerCycles,
    observedCoverage,
    sortLedgerRows,
} from './guild-trial-ledger.js';
import {
    compositionStatusLine,
    lintComposition,
    parseRosterNames,
    resolveRosterKits,
} from './guild-trial-composition.js';

const ACCENT = '#b0d8ff';

/** Ink per check status, so the checklist reads at a glance */
const STATUS_COLOR = {
    ok: ROW_COLORS.good,
    gap: ROW_COLORS.bad,
    unknown: ROW_COLORS.gold,
};

/** The mark in front of a check */
const STATUS_MARK = { ok: '✓', gap: '✗', unknown: '?' };

/**
 * Everything the panel remembers between redraws.
 *
 * A panel rebuilds its whole body every few seconds, so anything the user is in
 * the middle of — a sort they chose, a roster they pasted — has to live out here
 * or it is thrown away under their hands.
 */
const state = {
    /** Cycle records as last read; the panel never reads storage while drawing */
    cycles: [],
    /** Whether a read has happened at all, so "empty" and "not looked yet" differ */
    loaded: false,
    /** Which {@link LEDGER_WINDOWS} key is selected */
    window: '4',
    sortKey: 'damageShare',
    sortDirection: 'desc',
    /** The roster box's contents, as typed */
    rosterText: '',
    /** Whether the box has ever been filled from the last cycle */
    rosterSeeded: false,
    /** The tier being aimed at, as typed */
    tier: '',
    /** Kits, keyed by lowercased name, from the stored loadouts */
    loadouts: {},
};

/** Reset every remembered thing. Exported for tests, which must not inherit a run. */
export function resetLedgerView() {
    state.cycles = [];
    state.loaded = false;
    state.window = '4';
    state.sortKey = 'damageShare';
    state.sortDirection = 'desc';
    state.rosterText = '';
    state.rosterSeeded = false;
    state.tier = '';
    state.loadouts = {};
}

/** @returns {string|null} The guild whose ledger is being drawn */
function guildName() {
    return guildXPTracker.getOwnGuildName?.() || null;
}

/** @returns {string[]} Every member the XP tracker knows, for the no-show rows */
function rosterNames() {
    return (guildXPTracker.getMemberList?.() || []).map((member) => member?.name).filter(Boolean);
}

/**
 * Read the ledger and the stored kits, then redraw.
 *
 * Fire-and-forget from the panel's opening and from the window selector: a
 * storage read has no business holding up a draw, and the panel refreshes on its
 * own timer anyway.
 *
 * @returns {Promise<void>}
 */
export async function refreshLedgerView() {
    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    const guild = guildName();
    const chosen = LEDGER_WINDOWS.find((entry) => entry.key === state.window) || LEDGER_WINDOWS[0];

    try {
        state.cycles = await loadLedgerCycles(guild, characterId, { cycles: chosen.cycles });
        state.loaded = true;

        const record = await loadLoadouts(characterId, guild);
        const kits = {};
        for (const entry of Object.values(record?.players || {})) {
            const key = String(entry?.name || '')
                .trim()
                .toLowerCase();
            if (!key) continue;
            kits[key] = { name: entry.name, abilities: entry.abilities || [], stats: entry.stats || null };
        }
        state.loadouts = kits;
    } catch (error) {
        console.error('[GuildTrialLedgerView] Refreshing the ledger failed:', error);
        state.loaded = true;
    }

    guildTrialLedgerPanel.render();
}

/**
 * The table as it currently stands: folded, sorted, and with its coverage.
 *
 * Exported because it is the whole of the table's logic and the drawing below is
 * not worth a test — a caller hands it cycles and a roster and gets back exactly
 * what the panel puts on screen.
 *
 * @param {Object} [options] - Overrides, for tests
 * @param {Array<Object>} [options.cycles] - Cycle records
 * @param {Array<string>} [options.roster] - Guild members, for no-show rows
 * @param {string} [options.sortKey] - A {@link LEDGER_COLUMNS} key
 * @param {'asc'|'desc'} [options.sortDirection] - Which way
 * @returns {{rows: Array<Object>, trialsRun: number, coverage: Object, cycles: number}} The table
 */
export function buildLedgerTable({
    cycles = state.cycles,
    roster = null,
    sortKey = state.sortKey,
    sortDirection = state.sortDirection,
} = {}) {
    const folded = foldLedgerCycles(cycles, { rosterNames: roster ?? rosterNames() });
    return {
        rows: sortLedgerRows(folded.rows, sortKey, sortDirection),
        trialsRun: folded.trialsRun,
        cycles: folded.cycles,
        coverage: observedCoverage(cycles),
    };
}

/**
 * The observed-coverage sentence.
 *
 * The current week is excluded from the ratio — its trials have not all been
 * run — so the sentence says so rather than letting the reader assume the
 * figure covers everything on screen.
 *
 * @param {Object} coverage - From `observedCoverage`
 * @returns {string} e.g. `4 of 8 trials watched across 4 cycles`
 */
export function coverageLine(coverage) {
    const thisWeek = coverage?.inProgress ? ' This week is still running and is not counted yet.' : '';
    if (!coverage?.cycles) {
        return coverage?.inProgress ? `No completed cycles yet.${thisWeek}` : 'No cycles recorded yet.';
    }
    return (
        `${coverage.observed} of ${coverage.expected} trials watched across ${coverage.cycles} cycle` +
        `${coverage.cycles === 1 ? '' : 's'}${thisWeek}`
    );
}

/** A percentage, or a dash for a figure nothing measured */
function percent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

/** Minutes, or a dash */
function minutes(ms) {
    return Number.isFinite(ms) && ms > 0 ? `${Math.round(ms / 60000)}m` : '—';
}

/**
 * The cell text for one column of one row.
 * @param {Object} row - A folded row
 * @param {string} key - A {@link LEDGER_COLUMNS} key
 * @returns {string} What the cell says
 */
export function ledgerCellText(row, key) {
    switch (key) {
        case 'name':
            return row.noShow ? `${row.name} (no-show)` : row.name;
        case 'trials':
            return String(row.trials);
        case 'attendance':
            return percent(row.attendance);
        case 'damageShare':
            return percent(row.damageShare);
        case 'healingShare':
            return percent(row.healingShare);
        case 'tankShare':
            return percent(row.tankShare);
        case 'deaths':
            return String(row.deaths);
        case 'starvedMs':
            return minutes(row.starvedMs);
        default:
            return '—';
    }
}

/**
 * A small control button in the guild panels' idiom.
 * @param {string} label - Button text
 * @param {string} title - Tooltip
 * @param {Function} onClick - Action
 * @returns {HTMLElement} The button
 */
function controlButton(label, title, onClick) {
    const button = document.createElement('button');
    button.textContent = label;
    button.title = title;
    button.style.cssText =
        'background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; ' +
        'border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 12px;';
    button.addEventListener('click', onClick);
    return button;
}

/** Draw the window selector and the CSV button */
function drawControls(card, table) {
    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });

    const select = document.createElement('select');
    select.style.cssText =
        'background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; ' +
        'border-radius: 5px; padding: 3px 6px; font-size: 12px;';
    for (const window of LEDGER_WINDOWS) {
        const option = document.createElement('option');
        option.value = window.key;
        option.textContent = window.label;
        if (window.key === state.window) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        state.window = select.value;
        refreshLedgerView();
    });

    bar.appendChild(select);
    bar.appendChild(
        controlButton('Export CSV', 'The table as it stands, with raw numbers a spreadsheet can sort.', () => {
            const csv = toCsv(ledgerCsvRows(table.rows, table.trialsRun), LEDGER_CSV_COLUMNS);
            downloadCsv(csvFilename('guild-trial-ledger'), csv);
        })
    );
    card.appendChild(bar);
}

/** Draw the sortable table itself */
function drawTable(card, table) {
    if (!table.rows.length) {
        card.appendChild(
            panelNote(
                state.loaded
                    ? 'Nothing recorded yet. The ledger fills in as trials you have the guild panel open for finish.'
                    : 'Reading the ledger…'
            )
        );
        return;
    }

    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, { overflowX: 'auto' });

    const element = document.createElement('table');
    Object.assign(element.style, { borderCollapse: 'collapse', width: '100%', fontSize: '11px' });

    const head = document.createElement('tr');
    for (const column of LEDGER_COLUMNS) {
        const cell = document.createElement('th');
        const active = state.sortKey === column.key;
        cell.textContent = active ? `${column.label} ${state.sortDirection === 'asc' ? '▲' : '▼'}` : column.label;
        Object.assign(cell.style, {
            textAlign: column.numeric ? 'right' : 'left',
            padding: '2px 5px',
            cursor: 'pointer',
            color: active ? ACCENT : 'rgba(232, 236, 245, 0.6)',
            whiteSpace: 'nowrap',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
        });
        cell.addEventListener('click', () => {
            if (state.sortKey === column.key) {
                state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortKey = column.key;
                state.sortDirection = column.numeric ? 'desc' : 'asc';
            }
            guildTrialLedgerPanel.render();
        });
        head.appendChild(cell);
    }
    element.appendChild(head);

    for (const entry of table.rows) {
        const line = document.createElement('tr');
        for (const column of LEDGER_COLUMNS) {
            const cell = document.createElement('td');
            cell.textContent = ledgerCellText(entry, column.key);
            Object.assign(cell.style, {
                textAlign: column.numeric ? 'right' : 'left',
                padding: '2px 5px',
                whiteSpace: 'nowrap',
                color: entry.noShow ? ROW_COLORS.bad : '#e8ecf5',
            });
            line.appendChild(cell);
        }
        line.title =
            `${entry.name} joined ${entry.trials} of ${table.trialsRun} recorded trials.\n` +
            `${formatKMB(entry.damage)} damage · ${formatKMB(entry.healing)} healing · ` +
            `${formatKMB(entry.damageTaken)} taken · ${entry.deaths} death${entry.deaths === 1 ? '' : 's'}.\n` +
            'Shares are of what was actually measured over the selected window.';
        element.appendChild(line);
    }

    wrapper.appendChild(element);
    card.appendChild(wrapper);
}

/**
 * The names the box starts with: whoever was in the most recent recorded cycle.
 * @param {Array<Object>} cycles - Cycle records, oldest first
 * @returns {string[]} Names
 */
export function lastCycleParticipants(cycles) {
    const latest = (cycles || []).filter(Boolean).slice(-1)[0];
    return Object.values(latest?.members || {})
        .filter((member) => (member?.trials || 0) > 0)
        .map((member) => member.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

/** Draw the composition planner section */
function drawPlanner(body) {
    const card = panelCard(body, 'Roster composition', ACCENT);

    if (!state.rosterSeeded && !state.rosterText) {
        const seeded = lastCycleParticipants(state.cycles);
        if (seeded.length) {
            state.rosterText = seeded.join('\n');
            state.rosterSeeded = true;
        }
    }

    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });

    const tier = document.createElement('input');
    tier.type = 'number';
    tier.min = '1';
    tier.placeholder = 'Tier';
    tier.value = state.tier;
    tier.title = 'The tier you are going for — how many tanks the check wants depends on it.';
    tier.style.cssText =
        'width: 60px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); ' +
        'color: #e8ecf5; border-radius: 5px; padding: 3px 6px; font-size: 12px;';
    tier.addEventListener('input', () => {
        state.tier = tier.value;
    });
    bar.appendChild(tier);
    bar.appendChild(
        controlButton('Use last cycle', 'Replace the list with everyone the last recorded cycle saw.', () => {
            state.rosterText = lastCycleParticipants(state.cycles).join('\n');
            state.rosterSeeded = true;
            guildTrialLedgerPanel.render();
        })
    );
    card.appendChild(bar);

    const box = document.createElement('textarea');
    box.value = state.rosterText;
    box.placeholder = 'One name per line, or comma-separated.';
    box.rows = 4;
    box.style.cssText =
        'width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #e8ecf5; ' +
        'border: 1px solid rgba(255,255,255,0.18); border-radius: 5px; padding: 4px 6px; ' +
        'font-size: 11px; font-family: inherit; resize: vertical;';
    box.addEventListener('input', () => {
        state.rosterText = box.value;
        state.rosterSeeded = true;
    });
    card.appendChild(box);

    const names = parseRosterNames(state.rosterText);
    if (!names.length) {
        card.appendChild(panelNote('Paste a roster, or press "Use last cycle", to check it.'));
        return;
    }

    const abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap || {};
    const members = resolveRosterKits(names, { loadouts: state.loadouts, abilityDetailMap });

    const onRoster = new Set(names.map((name) => name.toLowerCase()));
    const benchNames = Object.keys(state.loadouts).filter((key) => !onRoster.has(key));
    const bench = resolveRosterKits(
        benchNames.map((key) => state.loadouts[key]?.name || key),
        { loadouts: state.loadouts, abilityDetailMap }
    );

    const lint = lintComposition({
        members,
        bench,
        tier: Number(state.tier) || null,
        abilityDetailMap,
    });

    card.appendChild(panelLine('Status', compositionStatusLine(lint), ACCENT, lint.coverage.line));

    for (const entry of lint.checks) {
        const line = panelLine(
            `${STATUS_MARK[entry.status] || '·'} ${entry.text}`,
            entry.suggestions.length ? `swap in: ${entry.suggestions.slice(0, 3).join(', ')}` : '',
            STATUS_COLOR[entry.status] || ROW_COLORS.dim,
            entry.detail
        );
        card.appendChild(line);
    }
}

export const guildTrialLedgerPanel = createPanel({
    id: 'guildTrialLedger',
    title: 'Trial Ledger',
    size: { width: 520, height: 520 },
    accent: ACCENT,
    draw: (body) => {
        const guild = guildName();
        const table = buildLedgerTable();

        const header = panelCard(body, guild || 'Guild trials', ACCENT);
        header.appendChild(
            panelLine(
                'Observed',
                coverageLine(table.coverage),
                ROW_COLORS.dim,
                'A trial only reaches the ledger if the guild panel was open while it ran. ' +
                    'Attendance is against the trials recorded here, never against the ones you missed.'
            )
        );
        header.appendChild(panelLine('Trials in window', String(table.trialsRun), ROW_COLORS.dim));
        drawControls(header, table);

        const ledger = panelCard(body, `Attendance and contribution (${table.rows.length})`, ACCENT);
        drawTable(ledger, table);

        drawPlanner(body);
    },
});

/** Open the panel, reading the ledger first so it does not draw an empty table */
export function openTrialLedgerPanel() {
    guildTrialLedgerPanel.show();
    refreshLedgerView();
}

/**
 * Register the overlay tile. Called from `initialize`, so a switched-off feature
 * leaves no tile and no command palette entry behind.
 */
export function registerTrialLedgerRow() {
    registerRow({
        key: 'guildTrialLedger',
        name: 'Trial Ledger',
        empty: 'No trials recorded',
        defaultVisible: false,
        defaultSize: { width: 230, height: 30 },
        render: (container) => {
            const table = buildLedgerTable();
            if (!table.trialsRun) return blank(container);

            const noShows = table.rows.filter((entry) => entry.noShow).length;
            const top = table.rows.find((entry) => Number.isFinite(entry.damageShare) && entry.damageShare > 0);
            row(container, [
                { text: top?.name || '—', color: ROW_COLORS.dim, ellipsis: true },
                { text: percent(top?.damageShare), color: ROW_COLORS.gold },
                {
                    text: noShows ? `${noShows} no-show` : `${table.trialsRun} trials`,
                    color: noShows ? ROW_COLORS.bad : ROW_COLORS.good,
                },
            ]);
            container.title =
                `${table.trialsRun} recorded trials over ${table.cycles} cycle(s).` +
                (noShows ? `\n${noShows} rostered member(s) joined none of them.` : '') +
                '\nDouble-click for the whole ledger.';
        },
        onOpen: () => openTrialLedgerPanel(),
    });
}

export default {
    name: 'Guild Trial Ledger',
    initialize: async () => {
        if (!config.getSetting('guildTrialLedger', true)) return;
        registerTrialLedgerRow();
        await refreshLedgerView();
    },
    cleanup: () => {
        guildTrialLedgerPanel.hide({ remember: false });
        resetLedgerView();
    },
};
