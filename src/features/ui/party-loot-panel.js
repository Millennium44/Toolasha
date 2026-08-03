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
import { itemIcon, linkToMarketplace, ROW_COLORS, GLYPHS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';

const ACCENT = '#e0b978';

/** Past this a drop list is a scrollbar rather than an answer */
const MAX_ITEMS = 14;

/**
 * Everybody's run, yours first.
 *
 * @returns {Array<Object>} From `calculatePlayerStats`, empty until a run has
 *   produced data
 */
function partyRuns() {
    const data = combatStatsDataCollector.getLatestData();
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
        gridTemplateColumns: '18px minmax(0, 1fr) 62px 44px',
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
    count.textContent = `× ${formatWithSeparator(item.count)}`;
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
 * What everyone picked up.
 */
export const partyLootPanel = createPanel({
    id: 'partyLoot',
    title: 'Party Loot',
    size: { width: 420, height: 520 },
    accent: ACCENT,
    refreshMs: 5000,
    draw: (body) => {
        const party = partyRuns();

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
