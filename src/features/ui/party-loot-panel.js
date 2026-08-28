/**
 * Party Loot panel
 *
 * What each character in the party actually picked up, item by item.
 *
 * The Total Profit tile carries one line per character — banked coin and a daily
 * rate — and the question it provokes is *what*. A party of five splitting a
 * dungeon does not split it evenly: loot is rolled per character against their
 * own drop gear, so one of them walks out with two chests and another with none,
 * and the tile can only say that it happened. This says what it was.
 *
 * ## Why it is a panel and not a wider tile
 *
 * Five characters with a drop list each is a table, and the overlay is a strip
 * of one-glance figures. MCS draws its loot view as a row of columns, one per
 * player; here it is a card per player down the panel, because the panel is
 * resizable and narrow more often than wide, and five columns in a 400px panel
 * is five columns of ellipsis.
 *
 * ## Where the numbers come from
 *
 * Entirely from `calculatePlayerStats`, which is the same function the Combat
 * Statistics popup and the overlay rows call. Nothing is recomputed here — a
 * third opinion about a run's income is a third number to reconcile when they
 * disagree.
 *
 * The pricing follows the same rule as everywhere else: coins at face value,
 * openable containers at their expected value rather than their sale price
 * (a chest is worth what is in it), everything else at the market.
 */

import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, shortDuration, ROW_COLORS, GLYPHS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';
import { loadSessions, combineSessions, describeSession } from '../combat-stats/combat-session-history.js';

const ACCENT = '#e0b978';

/** Past this a drop list is a scrollbar rather than an answer */
const MAX_ITEMS = 14;

/** The session-history export, one row per archived run */
export const SESSION_HISTORY_COLUMNS = [
    { key: 'start', label: 'Start' },
    { key: 'durationSeconds', label: 'Duration (s)' },
    { key: 'zone', label: 'Zone' },
    { key: 'zoneHrid', label: 'Zone Hrid' },
    { key: 'partySize', label: 'Party Size' },
    { key: 'players', label: 'Players' },
    { key: 'bankedTotal', label: 'Banked Total' },
    { key: 'perPlayerBanked', label: 'Per-Player Banked' },
    { key: 'perPlayerDaily', label: 'Per-Player Daily' },
];

/**
 * The archived runs as CSV rows, one per session.
 *
 * The per-player figures are the ones the panel's cards show: loot income less
 * consumables and keys ("banked"), and the daily rate, both at bid — packed
 * `Name: value` into two columns, because the roster changes run to run and a
 * column per player would give every export a different shape. The numbers
 * inside are raw integers, not the panel's `1.2M`.
 *
 * @param {Array<Object>} sessionList - Archived snapshots, as `loadSessions` returns them
 * @param {Function} [statsFor] - `(player, durationSeconds) => stats`, injectable for tests
 * @returns {Array<Object>} Rows for `SESSION_HISTORY_COLUMNS`
 */
export function buildSessionHistoryRows(sessionList, statsFor = calculatePlayerStats) {
    return (sessionList || [])
        .filter((session) => session?.players?.length)
        .map((session) => {
            const stats = session.players.map((player) => statsFor(player, session.durationSeconds || 0));
            const banked = (playerStats) =>
                playerStats.income.bid - (playerStats.consumableCosts?.bid || 0) - (playerStats.keyCosts?.bid || 0);

            const started = new Date(session.combatStartTime);
            const zoneHrid = session.actionHrid || '';

            return {
                start: Number.isNaN(started.getTime()) ? String(session.combatStartTime || '') : started.toISOString(),
                durationSeconds: session.durationSeconds || 0,
                // The snapshot stores the zone as an hrid; its tail reads well
                // enough without asking the game for a display name
                zone: zoneHrid ? zoneHrid.split('/').pop().replace(/_/g, ' ') : '',
                zoneHrid,
                partySize: session.players.length,
                players: stats.map((playerStats) => playerStats.name || '?').join(', '),
                bankedTotal: Math.round(stats.reduce((sum, playerStats) => sum + banked(playerStats), 0)),
                perPlayerBanked: stats
                    .map((playerStats) => `${playerStats.name || '?'}: ${Math.round(banked(playerStats))}`)
                    .join('; '),
                perPlayerDaily: stats
                    .map((playerStats) => `${playerStats.name || '?'}: ${Math.round(playerStats.dailyProfit.bid)}`)
                    .join('; '),
            };
        });
}

/**
 * The view on screen right now, as plain text for pasting into chat.
 *
 * The same figures the cards show — banked and daily rate per player, then
 * every drop — read off `party` rather than recomputed, so what lands on the
 * clipboard always matches what was on screen when the button was pressed.
 * The CSV export covers the archive across every stored run; this covers the
 * one run somebody is actually looking at, in a shape meant to be read rather
 * than parsed.
 *
 * @param {Array<Object>} party - From `partyRuns`
 * @param {string} label - What the picker said was showing, e.g. "Live Session"
 * @returns {string} Empty when there is nothing to report
 */
export function buildSummaryText(party, label) {
    if (!party?.length) return '';

    const lines = [`Party Loot — ${label}`];
    for (const stats of party) {
        const banked = stats.income.bid - (stats.consumableCosts?.bid || 0) - (stats.keyCosts?.bid || 0);
        lines.push(
            '',
            `${stats.name || '?'}: ${formatWithSeparator(Math.round(banked))} coins ` +
                `(${formatWithSeparator(Math.round(stats.dailyProfit.bid))}/day)`
        );

        const items = stats.lootList || [];
        if (!items.length) {
            lines.push('  Nothing dropped yet.');
            continue;
        }
        for (const item of items) {
            const value = item.totalValue > 0 ? ` — ${formatWithSeparator(Math.round(item.totalValue))}` : '';
            lines.push(`  ${formatWithSeparator(item.count)} × ${item.itemName}${value}`);
        }
    }
    return lines.join('\n');
}

/**
 * Which run the panel is showing.
 *
 * Kept on the module rather than in the panel so it survives the panel being
 * closed and reopened — having to re-find last night's session every time you
 * glance at it is the difference between a history and a novelty.
 */
let viewing = 'live';

/** Archived runs, newest first; refilled whenever the panel draws */
let sessions = [];

/**
 * Take a fresh copy of the archive.
 *
 * Async and fire-and-forget, because `draw` is synchronous and a storage read
 * has no business blocking a redraw. The first open used to show only "Live
 * Session" until the next 5s refresh; now the read triggers one redraw when it
 * actually changed the list, so the history appears as soon as it is readable.
 * Keyed on the newest run rather than the length so a same-size turnover still
 * redraws, and no change at all never re-renders (which would loop).
 */
async function refreshSessions() {
    try {
        const fresh = await loadSessions();
        const changed = fresh.length !== sessions.length || fresh[0]?.key !== sessions[0]?.key;
        sessions = fresh;
        if (changed) partyLootPanel.render();
    } catch (error) {
        console.error('[PartyLoot] Reading the session list failed:', error);
    }
}

/**
 * The snapshot the panel should be reading.
 *
 * @returns {Object|null}
 */
function chosenSnapshot() {
    if (viewing === 'live') return combatStatsDataCollector.getLatestData();
    if (viewing === 'combined') return combineSessions(sessions);

    return sessions.find((session) => session.key === viewing) || null;
}

/**
 * Everybody's run, yours first.
 *
 * @returns {Array<Object>} From `calculatePlayerStats`, empty until the chosen
 *   run has produced data
 */
function partyRuns() {
    const data = chosenSnapshot();
    const players = data?.players || [];
    if (!players.length) return [];

    // The same dating rule the overlay rows use: a live run times itself from
    // the server's start time, so the daily rates agree with the tile that
    // opened this rather than being a second answer
    let duration = data.durationSeconds || null;
    if (data.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) duration = elapsed;
    }

    return players
        .map((player) => ({ ...calculatePlayerStats(player, duration), isCurrentPlayer: player.isCurrentPlayer }))
        .sort((a, b) => Number(Boolean(b.isCurrentPlayer)) - Number(Boolean(a.isCurrentPlayer)));
}

/**
 * One drop: what it was, what it is worth, how many came.
 *
 * @param {Object} item - From `formatLootList`
 * @returns {HTMLElement}
 */
function lootRow(item) {
    const line = document.createElement('div');
    Object.assign(line.style, {
        display: 'grid',
        // The count column sizes to its content — a coin count in the millions
        // used to overflow a fixed column and give the whole panel a horizontal
        // scrollbar. The name is the column that gives way (it ellipsizes).
        gridTemplateColumns: '18px minmax(0, 1fr) 62px auto',
        gap: '6px',
        alignItems: 'center',
        padding: '1px 0',
    });

    const icon = itemIcon(item.itemHrid, 16);
    const name = document.createElement('span');
    name.textContent = item.itemName;
    Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

    linkToMarketplace(icon, item.itemHrid, navigateToMarketplace);
    linkToMarketplace(name, item.itemHrid, navigateToMarketplace);

    const value = document.createElement('span');
    value.textContent = item.totalValue > 0 ? formatKMB(item.totalValue) : '—';
    Object.assign(value.style, {
        textAlign: 'right',
        whiteSpace: 'nowrap',
        // An unpriced drop is dimmed rather than shown as zero: zero is a claim
        // about its worth, and the market simply has not said
        color: item.totalValue > 0 ? ROW_COLORS.gold : ROW_COLORS.dim,
    });

    const count = document.createElement('span');
    // A seven-digit count (coins, mostly) is compacted; the tooltip keeps the
    // exact figure
    count.textContent = `× ${item.count >= 100000 ? formatKMB(item.count) : formatWithSeparator(item.count)}`;
    Object.assign(count.style, { textAlign: 'right', whiteSpace: 'nowrap', color: ROW_COLORS.dim });

    line.append(icon, name, value, count);
    line.title =
        `${formatWithSeparator(item.count)} × ${item.itemName}` +
        (item.totalValue > 0 ? `, ${formatWithSeparator(Math.round(item.totalValue))} in total.` : ', unpriced.') +
        '\nClick to open its marketplace listing.';
    return line;
}

/**
 * One character: what they banked, what that is per day, and every drop.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} stats - From `calculatePlayerStats`
 */
function drawPlayer(body, stats) {
    const card = panelCard(body, stats.name || 'You', stats.isCurrentPlayer ? ROW_COLORS.gold : ACCENT);

    // Both cost figures are `{ask, bid}` rather than numbers; subtracting the
    // objects gives NaN, which is how this last went wrong on the tile
    const banked = stats.income.bid - (stats.consumableCosts?.bid || 0) - (stats.keyCosts?.bid || 0);

    const summary = document.createElement('div');
    Object.assign(summary.style, {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '8px',
        paddingBottom: '3px',
        marginBottom: '3px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.10)',
    });

    const coin = document.createElement('span');
    coin.textContent = `${GLYPHS.coin} ${formatKMB(banked)}`;
    coin.style.color = banked >= 0 ? ROW_COLORS.good : ROW_COLORS.bad;

    const rate = document.createElement('span');
    rate.textContent = `${formatKMB(Math.round(stats.dailyProfit.bid))}/day`;
    rate.style.color = ROW_COLORS.dim;

    summary.append(coin, rate);
    summary.title =
        `${formatWithSeparator(Math.round(stats.income.bid))} of loot, less ` +
        `${formatWithSeparator(Math.round(stats.consumableCosts?.bid || 0))} of consumables and ` +
        `${formatWithSeparator(Math.round(stats.keyCosts?.bid || 0))} of keys.`;

    // A key is costed at the cheaper of buying and crafting it, and which one
    // that was changes the figure above — so say so rather than leave the
    // number unexplained.
    const craftedKeys = (stats.keyBreakdown || []).filter((entry) => entry.keyCost?.cheaper === 'craft');
    if (craftedKeys.length) {
        summary.title += `\nPriced as crafted, cheaper than buying: ${craftedKeys
            .map((entry) => entry.itemName)
            .join(', ')}.`;
    }
    card.appendChild(summary);

    const items = stats.lootList || [];
    if (!items.length) {
        card.appendChild(panelNote('Nothing dropped yet.'));
        return;
    }

    for (const item of items.slice(0, MAX_ITEMS)) card.appendChild(lootRow(item));
    if (items.length > MAX_ITEMS) {
        card.appendChild(panelNote(`${items.length - MAX_ITEMS} more, smallest first, not shown.`));
    }
}

/**
 * The bar across the top: which run, how long it ran, and how fast.
 *
 * FLoot's arrangement, because the picker is the point — a loot list of the run
 * in progress answers "how is this going", and the question people actually come
 * back with is "what did last night earn", which needs the run to be choosable.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Array<Object>} party - From `partyRuns`, for the Copy button
 */
function drawTopBar(body, party) {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        paddingBottom: '6px',
        marginBottom: '6px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.10)',
    });

    const picker = document.createElement('select');
    picker.classList.add('toolasha-select');
    Object.assign(picker.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        color: ROW_COLORS.neutral,
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: '4px',
        padding: '2px 4px',
        fontSize: '11px',
        maxWidth: '190px',
    });

    const option = (value, label) => {
        const element = document.createElement('option');
        element.value = value;
        element.textContent = label;
        element.selected = viewing === value;
        picker.appendChild(element);
    };

    option('live', 'Live Session');
    for (const session of sessions) option(session.key, describeSession(session, shortDuration));
    if (sessions.length > 1) option('combined', `Combined (${sessions.length})`);

    // A stored run that has since fallen off the end of the list would otherwise
    // leave the picker showing "Live Session" while the body showed nothing
    if (viewing !== 'live' && viewing !== 'combined' && !sessions.some((session) => session.key === viewing)) {
        viewing = 'live';
        picker.value = 'live';
    }

    picker.addEventListener('change', () => {
        viewing = picker.value;
        partyLootPanel.render();
    });

    const snapshot = chosenSnapshot();
    const meta = document.createElement('span');
    meta.style.color = ROW_COLORS.dim;
    meta.textContent = snapshot?.durationSeconds ? shortDuration(snapshot.durationSeconds) : '';

    bar.append(picker, meta);

    // Only when there is something on screen to send — a button that copies
    // nothing would read as the button breaking, and there is no such thing
    // as an empty party (the panel does not draw the bar without one)
    if (party.length) {
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '⧉';
        copyBtn.title = 'Copy this view as plain text — banked, daily rate and every drop, per player.';
        Object.assign(copyBtn.style, {
            marginLeft: 'auto',
            background: 'rgba(255, 255, 255, 0.06)',
            color: ROW_COLORS.dim,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '11px',
            cursor: 'pointer',
        });
        copyBtn.addEventListener('click', () => {
            const label = picker.selectedOptions[0]?.textContent || 'Party Loot';
            const summary = buildSummaryText(party, label);
            if (!summary || !navigator.clipboard) return;
            navigator.clipboard
                .writeText(summary)
                .then(() => {
                    copyBtn.textContent = '✓';
                    setTimeout(() => (copyBtn.textContent = '⧉'), 1200);
                })
                .catch((error) => console.error('[PartyLoot] Copy failed:', error));
        });
        bar.appendChild(copyBtn);
    }

    // Only when there is a history to write — the live run is not archived, and
    // a button exporting an empty file would read as the button breaking
    if (sessions.length) {
        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export CSV';
        exportBtn.title = 'Save every archived run as a spreadsheet — one row per session, raw numbers.';
        Object.assign(exportBtn.style, {
            marginLeft: 'auto',
            background: 'rgba(255, 255, 255, 0.06)',
            color: ROW_COLORS.dim,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '11px',
            cursor: 'pointer',
        });
        exportBtn.addEventListener('click', () => {
            try {
                const rows = buildSessionHistoryRows(sessions);
                if (!rows.length) return;
                downloadCsv(csvFilename('combat-sessions'), toCsv(rows, SESSION_HISTORY_COLUMNS));
            } catch (error) {
                console.error('[PartyLoot] CSV export failed:', error);
            }
        });
        bar.appendChild(exportBtn);
    }

    if (viewing === 'combined') {
        const note = document.createElement('span');
        note.style.color = ROW_COLORS.dim;
        note.textContent = `${snapshot?.sessionCount || 0} runs`;
        note.title = 'Loot summed per item across every stored run, and the durations added.';
        bar.appendChild(note);
    }

    body.appendChild(bar);
}

/**
 * What everyone picked up.
 */
export const partyLootPanel = createPanel({
    id: 'partyLoot',
    title: 'Party Loot',
    size: { width: 420, height: 520 },
    accent: ACCENT,
    refreshMs: 5000,
    draw: (body) => {
        refreshSessions();
        const party = partyRuns();
        drawTopBar(body, party);

        if (!party.length) {
            body.appendChild(panelNote('No run measured yet.'));
            body.appendChild(
                panelNote(
                    'The party and its loot arrive with each battle, so this fills in once a run is under way — ' +
                        'and comes back on its own after a refresh.'
                )
            );
            return;
        }

        // The party total first, because "did we do well" is asked before "who
        // got what". Against the party rather than as an average of the
        // characters: an average weights somebody who looted one item the same
        // as somebody who looted a hundred.
        if (party.length > 1) {
            const total = party.reduce(
                (sum, stats) => sum + stats.income.bid - (stats.consumableCosts?.bid || 0) - (stats.keyCosts?.bid || 0),
                0
            );
            const perDay = party.reduce((sum, stats) => sum + stats.dailyProfit.bid, 0);

            const card = panelCard(body, `Party of ${party.length}`, ACCENT);
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' });

            const banked = document.createElement('span');
            banked.textContent = `${GLYPHS.coin} ${formatKMB(total)}`;
            banked.style.color = total >= 0 ? ROW_COLORS.good : ROW_COLORS.bad;
            banked.style.fontWeight = 'bold';

            const rate = document.createElement('span');
            rate.textContent = `${formatKMB(Math.round(perDay))}/day`;
            rate.style.color = ROW_COLORS.dim;

            line.append(banked, rate);
            card.appendChild(line);
        }

        for (const stats of party) drawPlayer(body, stats);

        body.appendChild(
            panelNote(
                'Chests are counted at what opening one is worth rather than what it sells for, so a run of ' +
                    'unopened chests still reads as income.'
            )
        );
    },
});

export default partyLootPanel;
