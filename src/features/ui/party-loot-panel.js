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

import config from '../../core/config.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, shortDuration, ROW_COLORS, GLYPHS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { DUNGEON_CHEST_ENTRY_KEYS, DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';
import { loadSessions, combineSessions, describeSession } from '../combat-stats/combat-session-history.js';
import {
    createPricingQuickSettings,
    PRICING_QUICK_SETTINGS_KEYS,
    PRICING_QUICK_SETTINGS_TOOLTIP_KEYS,
} from './pricing-quick-settings.js';

/** Every entry-key hrid a regular dungeon chest implies, for splitting the Keys section */
const ENTRY_KEY_HRIDS = new Set(Object.values(DUNGEON_CHEST_ENTRY_KEYS));
/** Every chest-key hrid a dungeon chest (regular or refinement) implies */
const CHEST_KEY_HRIDS = new Set(Object.values(DUNGEON_CHEST_CHEST_KEYS));

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
 * Which characters' cards are expanded to their full breakdown, by name.
 *
 * Module state for the same reason `viewing` is: a redraw happens every
 * `refreshMs` tick, and a click that expanded a card must still be expanded
 * after the very next one — collapsing it on its own timer is indistinguishable
 * from the panel ignoring the click.
 */
let expandedNames = new Set();

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

    // A combined snapshot is not one run — its `combatStartTime` is whichever
    // session in the lot happened to be the oldest, kept only so a picker
    // label has something to show. Treating that as a live run's start (the
    // branch below) timed every player off "now minus the oldest session's
    // start", which is the wall-clock gap across however many days the
    // archive spans — including every hour nobody was playing — rather than
    // the play time actually measured. `combineSessions` already worked out
    // the one duration that is honest here: each player's own, summed only
    // over the sessions *they* appeared in, since a roster is not the same
    // names in every combined run.
    if (data.combined) {
        return players
            .map((player) => ({
                ...calculatePlayerStats(player, player.durationSeconds || 0),
                isCurrentPlayer: player.isCurrentPlayer,
            }))
            .sort((a, b) => Number(Boolean(b.isCurrentPlayer)) - Number(Boolean(a.isCurrentPlayer)));
    }

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

/** Test-only: the same board the panel draws, without going through the DOM. */
export function _partyRuns() {
    return partyRuns();
}

/**
 * Test-only: forget which run is being viewed and the archive read for it.
 *
 * Both are module state on purpose — the chosen run outliving the panel is the
 * feature — so closing the panel does not clear them and one test's choice is
 * the next test's starting view. There is nothing here for the running script
 * to call: a session only ever gains this state.
 */
export function _resetView() {
    viewing = 'live';
    sessions = [];
    expandedNames = new Set();
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
 * One line of the breakdown table: a name, a count, a unit price and a total.
 *
 * @param {string} name - Item or key name
 * @param {string} count - Formatted count
 * @param {string} unit - Formatted unit price, or '' to leave the column blank
 * @param {string} total - Formatted total
 * @param {string} [color] - Ink for the total column
 * @returns {HTMLElement}
 */
function breakdownRow(name, count, unit, total, color = ROW_COLORS.neutral) {
    const line = document.createElement('div');
    Object.assign(line.style, {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 52px 62px 68px',
        gap: '6px',
        fontSize: '11px',
        padding: '1px 0',
    });

    const nameEl = document.createElement('span');
    nameEl.textContent = name;
    Object.assign(nameEl.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

    const countEl = document.createElement('span');
    countEl.textContent = count;
    Object.assign(countEl.style, { textAlign: 'right', whiteSpace: 'nowrap', color: ROW_COLORS.dim });

    const unitEl = document.createElement('span');
    unitEl.textContent = unit;
    Object.assign(unitEl.style, { textAlign: 'right', whiteSpace: 'nowrap', color: ROW_COLORS.dim });

    const totalEl = document.createElement('span');
    totalEl.textContent = total;
    Object.assign(totalEl.style, { textAlign: 'right', whiteSpace: 'nowrap', color });

    line.append(nameEl, countEl, unitEl, totalEl);
    return line;
}

/**
 * A section heading inside the breakdown: what follows, and why.
 *
 * @param {string} text - Section label
 * @returns {HTMLElement}
 */
function breakdownHeading(text) {
    const heading = document.createElement('div');
    heading.textContent = text;
    Object.assign(heading.style, {
        color: ROW_COLORS.dim,
        fontWeight: 'bold',
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.02em',
        marginTop: '4px',
    });
    return heading;
}

/**
 * A count, formatted the same way the loot rows already do — compacted past
 * six digits so a coin count does not blow out the column.
 *
 * @param {number} count
 * @returns {string}
 */
function formatCount(count) {
    return count >= 100000 ? formatKMB(count) : formatWithSeparator(count);
}

/**
 * The full income/cost breakdown for one character: every drop, every
 * consumable, every key, and the summary line that ties them to the banked
 * figure the card shows.
 *
 * Every figure here comes from `calculatePlayerStats` — nothing is
 * recomputed, so the breakdown can never disagree with the card it expands.
 *
 * @param {Object} stats - From `calculatePlayerStats`
 * @param {number} banked - The exact figure the card's coin line shows
 * @returns {HTMLElement}
 */
function playerBreakdown(stats, banked) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        marginTop: '2px',
        marginBottom: '2px',
        paddingTop: '4px',
        borderTop: '1px dashed rgba(255, 255, 255, 0.12)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
    });

    // Income: every drop and coin, at what the card actually counted it as
    const incomeItems = stats.incomeItems || [];
    wrap.appendChild(breakdownHeading('Income'));
    if (incomeItems.length) {
        if (incomeItems.some((item) => item.isOpenable)) {
            wrap.appendChild(panelNote('Chests at opening value.'));
        }
        for (const item of incomeItems) {
            const unpriced = item.totalValue.bid <= 0;
            wrap.appendChild(
                breakdownRow(
                    item.itemName,
                    formatCount(item.count),
                    unpriced ? '—' : formatKMB(item.unitValue.bid),
                    unpriced ? '—' : formatKMB(item.totalValue.bid),
                    ROW_COLORS.gold
                )
            );
        }
    } else {
        wrap.appendChild(panelNote('Nothing dropped yet.'));
    }

    // Consumables: what was eaten and drunk to get it. Every count here —
    // the current player's included — comes from a consumption *rate* times
    // the run's duration (see `combat-stats-data-collector.js`), not a tally
    // of actual events, so both sections carry the same "estimated" label.
    const consumableItems = stats.consumableBreakdown || [];
    wrap.appendChild(breakdownHeading('Consumables (estimated)'));
    if (consumableItems.length) {
        for (const item of consumableItems) {
            wrap.appendChild(
                breakdownRow(
                    item.itemName,
                    // The count is a rate-based estimate, so it can be fractional ("3.676 cakes");
                    // shown rounded with "≈" while the cost beside it stays exact
                    Number.isInteger(item.count) ? formatCount(item.count) : `≈${formatCount(Math.round(item.count))}`,
                    item.pricePerItem !== null ? formatKMB(item.pricePerItem) : '—',
                    item.pricePerItem !== null ? formatKMB(item.totalCost) : '—',
                    ROW_COLORS.bad
                )
            );
        }
    } else {
        wrap.appendChild(panelNote('None used.'));
    }

    // Keys: entry keys (one per regular dungeon chest received) and chest
    // keys (one per chest, regular or refinement) charged separately, each
    // priced at whichever of buying and crafting was cheaper
    // keyBreakdown only ever contains entry keys and chest keys (see
    // `calculateKeyCosts`), so entry keys are simply listed before chest keys —
    // there is no third kind to account for.
    const keyItems = stats.keyBreakdown || [];
    const entryKeys = keyItems.filter((item) => ENTRY_KEY_HRIDS.has(item.itemHrid));
    const chestKeys = keyItems.filter((item) => CHEST_KEY_HRIDS.has(item.itemHrid));

    wrap.appendChild(breakdownHeading('Keys'));
    if (keyItems.length) {
        const keyRow = (item) => {
            const route = item.keyCost?.cheaper === 'craft' ? 'crafted' : 'market';
            return breakdownRow(
                `${item.itemName} (${route})`,
                formatCount(item.count),
                formatKMB(item.pricePerItem),
                formatKMB(item.totalCost),
                ROW_COLORS.bad
            );
        };
        for (const item of entryKeys) wrap.appendChild(keyRow(item));
        for (const item of chestKeys) wrap.appendChild(keyRow(item));
    } else {
        wrap.appendChild(panelNote('None spent.'));
    }

    // Summary: the same subtraction the card's coin line does, spelled out —
    // `banked` is that exact figure, not recomputed, so the two can never
    // read differently
    wrap.appendChild(breakdownHeading('Summary'));
    wrap.appendChild(breakdownRow('Loot total', '', '', formatKMB(stats.income.bid), ROW_COLORS.gold));
    wrap.appendChild(breakdownRow('− Consumables', '', '', formatKMB(stats.consumableCosts?.bid || 0), ROW_COLORS.bad));
    wrap.appendChild(breakdownRow('− Keys', '', '', formatKMB(stats.keyCosts?.bid || 0), ROW_COLORS.bad));
    wrap.appendChild(breakdownRow('= Net', '', '', formatKMB(banked), banked >= 0 ? ROW_COLORS.good : ROW_COLORS.bad));

    const rateLine = document.createElement('div');
    Object.assign(rateLine.style, { fontSize: '11px', color: ROW_COLORS.dim, marginTop: '2px' });
    const sessionLength = Number.isFinite(stats.duration) && stats.duration > 0 ? shortDuration(stats.duration) : '—';
    rateLine.textContent = `${formatKMB(Math.round(stats.dailyProfit.bid))}/day over ${sessionLength}`;
    wrap.appendChild(rateLine);

    return wrap;
}

/**
 * One character: what they banked, what that is per day, and every drop.
 *
 * The name row doubles as a disclosure control — clicking it expands the card
 * into the full income/cost breakdown `playerBreakdown` builds, and the ▸/▾
 * glyph says so before the click. Which characters are expanded is kept in
 * `expandedNames` rather than on the card, so it survives the panel's own
 * refresh timer redrawing everything underneath it.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} stats - From `calculatePlayerStats`
 */
function drawPlayer(body, stats) {
    const accent = stats.isCurrentPlayer ? ROW_COLORS.gold : ACCENT;
    const card = panelCard(body, null, accent);

    const nameKey = stats.name || 'You';
    const expanded = expandedNames.has(nameKey);

    const heading = document.createElement('div');
    Object.assign(heading.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        color: accent,
        fontWeight: 'bold',
        marginBottom: '3px',
        cursor: 'pointer',
        userSelect: 'none',
    });
    heading.title = expanded ? 'Click to collapse.' : 'Click for a full income/cost breakdown.';
    heading.setAttribute('role', 'button');
    heading.setAttribute('tabindex', '0');
    heading.setAttribute('aria-expanded', String(expanded));

    const caret = document.createElement('span');
    caret.textContent = expanded ? '▾' : '▸';
    caret.style.fontSize = '9px';

    const label = document.createElement('span');
    label.textContent = nameKey;

    heading.append(caret, label);
    const toggle = () => {
        if (expandedNames.has(nameKey)) expandedNames.delete(nameKey);
        else expandedNames.add(nameKey);
        partyLootPanel.render();
    };
    heading.addEventListener('click', toggle);
    heading.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
    });
    card.appendChild(heading);

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

    if (expanded) card.appendChild(playerBreakdown(stats, banked));

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
        flexWrap: 'wrap',
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

    // Anything the picker is no longer offering falls back to the live run,
    // because the picker would otherwise read "Live Session" — the first option,
    // since none is marked selected — while the body showed nothing at all, and
    // there is no gesture that puts that right.
    //
    // Asked of the options rather than of `sessions`, which is what this used to
    // do while excepting `combined` outright. Combined is only offered while
    // there are two runs to combine, so an archive that has since been pruned
    // back to one run (or to none, which is every fresh character) left the view
    // pinned to a snapshot `combineSessions` returns nothing for. `viewing`
    // survives the panel being closed on purpose, so it survives that too.
    if (![...picker.options].some((element) => element.value === viewing)) {
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

    const pricing = createPricingQuickSettings({
        selectCssText:
            'background: rgba(255, 255, 255, 0.06); color: #e8ecf5; border: 1px solid rgba(255, 255, 255, 0.15); ' +
            'border-radius: 4px; padding: 2px 4px; font-size: 11px; max-width: 92px;',
    });
    bar.appendChild(pricing.element);

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
 * Re-render whenever a pricing setting changes, wherever it was changed —
 * this panel's own quick-settings row, the main settings panel, or the
 * combat simulator's copy of the same row. `render()` no-ops while the panel
 * is closed (`draw` only runs once there is a body to draw into), and every
 * figure on screen is recomputed from `calculatePlayerStats` on each render,
 * so a resync here is simply asking for the redraw the panel already knows
 * how to do — nothing is cached across a pricing change.
 *
 * Module scope, not `initialize()`/`cleanup()`: this panel has neither, and
 * lives for the life of the tab like the shell itself (`simple-panel.js`
 * subscribes to `character_switched` the same way, at module scope).
 */
for (const key of [...PRICING_QUICK_SETTINGS_KEYS, ...PRICING_QUICK_SETTINGS_TOOLTIP_KEYS]) {
    config.onSettingChange(key, () => partyLootPanel.render());
}
config.onSettingsLoaded(() => partyLootPanel.render());

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
