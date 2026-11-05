/**
 * Combat Stats overlay rows
 *
 * The figures the Combat Statistics popup already computes, on the overlay so
 * they can be watched during a run rather than opened after one.
 *
 * Nothing is calculated here that was not calculated already — `calculatePlayerStats`
 * is the same function the popup calls, given the same data. This module picks
 * the current player out of it and decides how three numbers should read.
 *
 * ## Why the cache
 *
 * The overlay redraws every second, and `calculatePlayerStats` prices every item
 * in the loot map to do it. A run with a long loot list would repeat that
 * pricing sixty times a minute for figures that move slowly. The result is held
 * briefly instead, which keeps `render` to a property read — what the overlay
 * asks of a row.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import {
    row,
    rows,
    blank,
    shortDuration,
    drawLine,
    itemIcon,
    linkToMarketplace,
    spriteUrl,
    ROW_COLORS,
} from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { getItemPrices } from '../../utils/market-data.js';
import {
    forecastAll,
    firstToRunOut,
    costPerDaySides,
    partyOutlook,
    drinkRatePerDay,
} from '../../utils/consumable-forecast.js';
import { isSkillingActionType, runningActionTypeHrid, skillingConsumables } from '../../utils/skilling-consumables.js';
import { currentTarget, loadTarget } from '../../utils/consumable-target.js';
import combatStatsDataCollector from './combat-stats-data-collector.js';
import { calculatePlayerStats, describeLuckAdjustment } from './combat-stats-calculator.js';
import {
    combatProfitView,
    profitPanel,
    combatLevelPanel,
    deathsPanel,
    partyLootPanel,
    consumablesPanel,
    skillTtlRow,
} from '../../utils/bundle-bridge.js';
import { runningAction } from '../../utils/combat-actions.js';
import { SELL_TAX_EXCLUDED_TOOLTIP } from '../../utils/profit-constants.js';
import { sellTaxMarker } from '../../utils/sell-tax-marker.js';
import { runningSkillingProfit, skillingProfitVersion } from './skilling-profit-estimate.js';

/** Long enough that a busy loot map is not repriced every tick */
const CACHE_MS = 4000;

/**
 * A missing market quote stays visible in the daily total.
 * @param {number|null} amount - Cost at one side of the market
 * @param {number} [unpriced] - Consumed items with no quote at this side
 * @param {number} [unknownRate] - Items without a usable consumption estimate
 * @returns {string}
 */
function formatConsumableCostSide(amount, unpriced = 0, unknownRate = 0) {
    const total = amount === null ? '—' : formatLargeNumber(Math.round(amount));
    const notes = [unpriced ? `${unpriced} unpriced` : '', unknownRate ? `${unknownRate} rate unknown` : ''].filter(
        Boolean
    );
    return notes.length ? `${total} (${notes.join(', ')})` : total;
}

let cached = null;
let cachedAt = 0;

/**
 * The consumable forecast's own cache, on the same four-second rhythm.
 *
 * `consumablePlayers` prices and forecasts every slot of every party member, and
 * the Consumables tile called it once a second. Cached here rather than inside
 * the helper's callers so the tile's `version()` can read the forecast it is
 * about to draw without paying for it twice.
 */
let consumableCache = null;
let consumableCachedAt = 0;

// This cache sits in front of `combatStatsDataCollector`, which clears its own
// `latestCombatData` synchronously on `character_switching` — but that does
// nothing for the copy already sitting here. Left alone, `partyStats()` kept
// answering with the outgoing character's figures for up to CACHE_MS after a
// switch (longer if a redraw landed just before the switch), which the
// overlay panel's 1s redraw made visible under the arriving character's name:
// Combat Revenue, Experience/hr, Deaths/hr and Total Profit are all fed by
// this cache. Dropped here so the next read goes straight to the collector,
// which is already reporting nothing for the new character at that point.
dataManager.on('character_switching', () => {
    cached = null;
    cachedAt = 0;
    consumableCache = null;
    consumableCachedAt = 0;
});

/**
 * Everybody's stats, recomputed at most every few seconds.
 *
 * The whole party rather than just you: loot is rolled per character against
 * their own drop gear, so five people splitting a zone do not split it evenly,
 * and a tile that shows one of the five answers a question nobody asked.
 *
 * Costs a loot-map pricing per player instead of one, which is why the cache
 * matters more than it did — the overlay redraws every second.
 *
 * @returns {Array<Object>} From `calculatePlayerStats`, yours first, empty until
 *   a run has produced data
 */
export function partyStats() {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_MS) return cached;

    const data = combatStatsDataCollector.getLatestData();
    const players = data?.players || [];
    if (!players.length) return [];

    // Live data can time its own duration; a stored snapshot cannot, because its
    // start time may belong to a run that ended hours ago
    let duration = data.durationSeconds || null;
    if (data.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) duration = elapsed;
    }

    cached = players
        .map((player) => ({ ...calculatePlayerStats(player, duration), isCurrentPlayer: player.isCurrentPlayer }))
        // Yours first whatever order the party arrived in, so the figure you
        // look for is always on the same line
        .sort((a, b) => Number(Boolean(b.isCurrentPlayer)) - Number(Boolean(a.isCurrentPlayer)));
    cachedAt = now;
    return cached;
}

/**
 * The current player's stats, for the rows that are only ever about you.
 *
 * @returns {Object|null} From `calculatePlayerStats`, or null
 */
function currentStats() {
    return partyStats().find((player) => player.isCurrentPlayer) || null;
}

/**
 * What a run has actually banked, after what it burned to get there.
 *
 * Reads `.value` — loot at the configured Sell side and consumables at the
 * configured Buy side (see `combat-stats-calculator.js`) — the same figure
 * Party Loot's own cards show, since this tile opens straight into that panel
 * and a mismatch between the two would be visible the moment it did. Both
 * cost figures are objects rather than numbers; subtracting them directly
 * gave NaN. Pulled out of the Total Profit render so its `version` can quote
 * the same figure rather than a second copy of the arithmetic.
 *
 * @param {Object} stats - From `calculatePlayerStats`
 * @returns {number} Coins
 */
function bankedTotal(stats) {
    return stats.income.value - (stats.consumableCosts?.value || 0) - (stats.keyCosts?.value || 0);
}

/**
 * Whether a dungeon run has yet to pay anything out.
 *
 * Keys are charged when a chest drops and the revenue arrives the same way, so
 * until the first chest a dungeon is pure consumable burn — a real cost, but
 * not a verdict, and painting it red for the first minutes of every run taught
 * people to distrust the figure. `keyBreakdown` filling is the same signal the
 * key costs bill by, so the two cannot disagree about what "no chest yet" means.
 *
 * @param {Object} stats - From `calculatePlayerStats`
 * @returns {boolean}
 */
export function warmingUp(stats) {
    return Boolean(stats?.isDungeonRun) && !(stats?.keyBreakdown || []).length;
}

/**
 * Everything the Combat Revenue tile draws, in one pass.
 *
 * Shared by the row's `render` and its `version` so the two cannot disagree
 * about what is on the tile: the version is a transcript of this, and anything
 * the render reads that is not in here would be an input the memo misses.
 *
 * @returns {{view: Object, warming: boolean, luckNotes: string[]}|null} Null when
 *   there is nothing to draw
 */
function revenuePayload() {
    const stats = currentStats();
    if (!stats) return null;

    // Income, what it cost to earn it, and what is left — the third number is
    // the only one worth acting on, and it is the one an income figure alone
    // quietly overstates.
    //
    // Which income and which cost is the panel's decision, not the tile's:
    // somebody reading Patient there is not thinking in bid revenue, and a
    // tile that disagrees with the panel behind it is a tile nobody trusts.
    // The panel lives in the UI bundle, so it is reached through the global.
    //
    // Read every tick rather than memoised alongside the stats: the pricing
    // mode, the costs switch and the MooPass switch are all panel buttons that
    // can move without the run's figures moving at all, and a memo keyed on the
    // figures would leave the tile showing the reading you just switched away
    // from.
    const view = combatProfitView()?.(stats) || {
        revenue: stats.dailyIncome.bid,
        cost: stats.dailyConsumableCosts + stats.dailyKeyCosts,
        tax: 0,
        profit: stats.dailyProfit.bid,
        title: 'Lazy Profit',
    };

    return {
        view,
        // A dungeon that has not paid out yet is dimmed rather than damned:
        // the burn is real, the verdict is not in until a chest drops
        warming: warmingUp(stats),
        // An adjusted chest EV inside the revenue is marked, never silent
        luckNotes: (stats.chestLuckAdjustments || []).map(describeLuckAdjustment),
    };
}

registerRow({
    key: 'combatRevenue',
    empty: 'No loot tracked yet',
    name: 'Combat Revenue',
    defaultSize: { width: 280, height: 40 },
    // The four figures as they are drawn — rounded, because that is the
    // precision the tile shows and a memo finer than the display redraws for
    // changes nobody can see — plus the reading's name, the warming flag and the
    // luck notes, which are the rest of what `render` puts on the tile.
    version: () => {
        const payload = revenuePayload();
        if (!payload) return 'blank';

        const { view, warming, luckNotes } = payload;
        return [
            Math.round(view.revenue),
            Math.round(view.tax),
            Math.round(view.cost),
            Math.round(view.profit),
            view.title,
            warming ? 1 : 0,
            luckNotes.join('~'),
        ].join('|');
    },
    render: (container) => {
        const payload = revenuePayload();
        if (!payload) return blank(container);

        const { view, warming, luckNotes } = payload;

        // One decimal and a plain hyphen, as MCS draws it. Three numbers and two
        // operators on one tile is already tight, and the second decimal buys
        // nothing here — 95.1M against 95.14M is not a distinction anybody acts
        // on when the figure moves by millions a minute.
        const segments = [{ text: formatLargeNumber(Math.round(view.revenue), 1), color: ROW_COLORS.good }];

        // The MooPass sits between revenue and consumables, in its own color,
        // because it is a standing bill rather than a cost of this run
        if (view.tax) {
            segments.push(
                { text: '-', color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(view.tax), 1), color: '#e8b4d8' }
            );
        }
        if (view.cost) {
            segments.push(
                { text: '-', color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(view.cost), 1), color: ROW_COLORS.bad }
            );
        }
        segments.push(
            { text: '=', color: ROW_COLORS.dim },
            {
                text: `${formatLargeNumber(Math.round(view.profit), 1)}/day`,
                color: view.profit >= 0 ? ROW_COLORS.gold : warming ? ROW_COLORS.dim : ROW_COLORS.bad,
                bold: true,
            }
        );
        if (warming) segments.push({ text: '· no chest yet', color: ROW_COLORS.dim });

        row(container, segments);
        container.title =
            (warming
                ? 'Warming up — no chest has dropped yet. Keys are charged when chests drop and the revenue ' +
                  'arrives the same way, so a dungeon run reads as a loss until it pays out.\n'
                : '') +
            `${view.title}.\nDouble-click for the other readings, costs and the MooPass tax.` +
            (view.tax ? '\nThe middle figure is the weekly MooPass, per day.' : '') +
            (luckNotes.length ? `\n${luckNotes.join('\n')}` : '');
    },
    onOpen: () => profitPanel()?.toggle(),
});

/**
 * The running skilling action's experience rate, from the same rolling window
 * Time to Level divides by, so the two agree to the digit.
 *
 * @returns {{name: string, xpPerHour: number|null}|null} Null when no skilling action is
 *   running (or the ui bundle that keeps the window is not up), which leaves the tile on its
 *   combat reading; `xpPerHour` is null until two readings exist
 */
function skillingReading() {
    try {
        return skillTtlRow()?.runningSkillReading() ?? null;
    } catch (error) {
        console.error('[CombatStatsRows] Reading the running skill failed:', error);
        return null;
    }
}

registerRow({
    key: 'experiencePerHour',
    // Worded for what the tile is waiting on: a skill reading takes two samples,
    // a combat figure takes a fight
    empty: () => (skillingReading() ? 'Measuring experience rate…' : 'No experience yet'),
    name: 'Experience/hr',
    defaultSize: { width: 180, height: 30 },
    // The whole tile is one rounded figure and a fixed title, so the rounded
    // figure is the whole input. It only moves when the collector's cache is
    // rebuilt, which `currentStats` is what asks for. While a skilling action
    // runs it is the running skill's rounded rate instead, with the skill's name.
    version: () => {
        const skilling = skillingReading();
        if (skilling) return `skill|${skilling.name}|${skilling.xpPerHour ? Math.round(skilling.xpPerHour) : 'blank'}`;
        const stats = currentStats();
        return stats?.expPerHour ? String(Math.round(stats.expPerHour)) : 'blank';
    },
    render: (container) => {
        // A skilling action running: that skill's rate, not the last fight's
        const skilling = skillingReading();
        if (skilling) {
            if (!skilling.xpPerHour) return blank(container);

            row(container, [
                { text: `${formatWithSeparator(Math.round(skilling.xpPerHour))} exp/hr`, color: ROW_COLORS.good },
                { text: skilling.name, color: ROW_COLORS.dim, ellipsis: true, push: true },
            ]);
            container.title =
                `${skilling.name} experience per hour since it started gaining (at most the last ten minutes).\n` +
                'The rate Time to Level divides by.\nDouble-click for the per-skill breakdown and combat level.';
            return;
        }

        const stats = currentStats();
        if (!stats?.expPerHour) return blank(container);

        // Separators rather than K/M here: experience per hour is compared with
        // itself between runs, and 260,572 against 261K is the comparison
        row(container, [
            { text: `${formatWithSeparator(Math.round(stats.expPerHour))} exp/hr`, color: ROW_COLORS.good },
        ]);
        container.title = 'Combat experience per hour.\nDouble-click for the per-skill breakdown and combat level.';
    },
    // The panel lives in the UI bundle, so it is reached through the global
    // rather than imported — a direct import here would put a second copy of it
    // in this bundle, with its own session clock
    onOpen: () => combatLevelPanel()?.toggle(),
});

registerRow({
    key: 'deathsPerHour',
    empty: 'No combat yet',
    name: 'Deaths/hr',
    defaultSize: { width: 130, height: 30 },
    // The figure as drawn, and separately whether it is above zero: a rate of
    // 0.04 draws as "0.0" but is colored as a death, so the two are not the
    // same input and keying on the text alone would freeze the color.
    version: () => {
        const stats = currentStats();
        if (!stats) return 'blank';
        return `${stats.deathsPerHour.toFixed(1)}|${stats.deathsPerHour > 0 ? 1 : 0}`;
    },
    render: (container) => {
        const stats = currentStats();
        if (!stats) return blank(container);

        // Zero deaths is the goal rather than a shortfall, so it is not colored
        // as a problem
        row(container, [
            {
                text: `${stats.deathsPerHour.toFixed(1)} deaths/hr`,
                color: stats.deathsPerHour > 0 ? ROW_COLORS.bad : ROW_COLORS.dim,
            },
        ]);
    },
    onOpen: () => deathsPanel()?.toggle(),
});

/**
 * The session clock and how fast encounters are coming.
 *
 * Encounters per hour is the rate everything else in the panel is divided by, so
 * it is the first thing to look at when a figure has drifted: income per hour
 * falling while EPH holds means prices moved, and both falling together means
 * the fights got slower.
 */
registerRow({
    key: 'battleTimer',
    empty: 'Not in combat',
    name: 'Session Timer / EPH',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const data = combatStatsDataCollector.getLatestData();
        const duration = sessionSeconds(data);
        if (!(duration > 0)) return blank(container);

        // battleId counts the battle in progress, which has paid out nothing yet
        const battles = Math.max(0, (data.battleId || 1) - 1);
        const eph = (3600 * battles) / duration;

        row(container, [
            { text: clock(duration) },
            { text: '|', color: ROW_COLORS.dim },
            { text: `${eph.toFixed(2)} EPH`, color: ROW_COLORS.accent },
        ]);
        container.title =
            'How long this run has been going, and encounters per hour.\n' +
            'Double-click for the loot, including the runs before this one.';
    },
    // The session's own loot list, and the picker for earlier sessions — the
    // question a session timer raises is what the session produced
    onOpen: () => partyLootPanel()?.toggle(),
});

/**
 * Draw the estimate for the running skilling action.
 *
 * Only a worked-out figure is drawn as a figure. A partial one (some price
 * missing) says so on the tile as well as in the tooltip, and a loss reads as a
 * loss; while the estimate is being worked out, or when this kind of action has
 * none, the tile draws nothing. What a blank tile then says depends on the
 * empty-tile setting: the default (compact) shows only the tile's name, and the
 * row's `empty` wording below ("Estimating profit…", "No profit estimate for X",
 * "Could not estimate profit for X") appears only under Full.
 *
 * @param {HTMLElement} container - The tile
 * @param {Object} skilling - From `runningSkillingProfit`, not idle
 */
function drawSkillingProfit(container, skilling) {
    if (skilling.state !== 'ready') return blank(container);

    const { profitPerHour, hasMissingPrices, excludeSellTax, pricingMode } = skilling.estimate;
    row(container, [
        { text: skilling.actionName, color: ROW_COLORS.dim, ellipsis: true },
        {
            text: `${formatLargeNumber(Math.round(profitPerHour))}/hr`,
            color: profitPerHour >= 0 ? ROW_COLORS.good : ROW_COLORS.bad,
            push: true,
        },
        {
            text: `${hasMissingPrices ? 'est. · partial' : 'est.'}${sellTaxMarker(excludeSellTax)}`,
            color: hasMissingPrices || excludeSellTax ? ROW_COLORS.gold : ROW_COLORS.dim,
        },
    ]);
    container.title =
        `${skilling.actionName}: an estimate of ${formatLargeNumber(Math.round(profitPerHour))} coins per hour at your ` +
        `current gear, tea and market (${pricingMode} pricing), not tracked loot.` +
        (profitPerHour < 0 ? '\nThis action costs more than it earns at current prices.' : '') +
        (hasMissingPrices
            ? '\nSome inputs or outputs have no market price, so this figure leaves them out and is not the whole.'
            : '') +
        (excludeSellTax ? `\n${SELL_TAX_EXCLUDED_TOOLTIP}` : '') +
        '\nA combat run shows its tracked loot here instead.\nDouble-click for Party Loot.';
}

/**
 * What the run has actually banked, and what that comes to per day.
 *
 * Combat Revenue answers the daily rate; this answers "so far". The two disagree
 * whenever the run started badly or has just had a rare, and the disagreement is
 * the useful part — a daily projection off twenty minutes is a guess.
 */
registerRow({
    key: 'totalProfit',
    // Worded for what the tile is waiting on while a skilling action runs: an
    // estimate being worked out, an action the calculators do not cover, or a
    // calculation that threw. Only drawn under the Full empty-tile setting; the
    // default policy is compact and shows just the tile's name (overlay-rows.js
    // `emptyPolicyFor`, `compactLabel`)
    empty: () => {
        const skilling = runningSkillingProfit();
        if (skilling.state === 'pending') return 'Estimating profit…';
        if (skilling.state === 'none') {
            return skilling.failed
                ? `Could not estimate profit for ${skilling.skillName}`
                : `No profit estimate for ${skilling.skillName}`;
        }
        return 'No loot tracked yet';
    },
    name: 'Total Profit',
    // Taller by default than it was: a party of five needs five lines, and a
    // tile sized for one clips the rest
    defaultSize: { width: 240, height: 78 },
    // A line per party member, each of which is a name, a banked figure and a
    // per-day figure — all three rounded the way the tile rounds them — plus the
    // luck notes that make up the tooltip. Nothing else reaches the tile.
    version: () => {
        // A skilling action running: the estimate for it, not the last fight
        const skilling = runningSkillingProfit();
        if (skilling.state !== 'idle') return skillingProfitVersion(skilling);

        const party = partyStats();
        if (!party.length) return 'blank';

        const lines = party.map((stats) =>
            [
                stats.name || 'You',
                stats.isCurrentPlayer ? 1 : 0,
                Math.round(bankedTotal(stats)),
                Math.round(stats.dailyProfit.value),
            ].join('~')
        );
        const luckNotes = [
            ...new Set(party.flatMap((stats) => (stats.chestLuckAdjustments || []).map(describeLuckAdjustment))),
        ];
        return `${lines.join('|')}#${luckNotes.join('~')}`;
    },
    render: (container) => {
        // A skilling action running: what that action is estimated to earn per
        // hour, marked as an estimate. A fight running, or nothing running, is
        // the tracked loot below.
        const skilling = runningSkillingProfit();
        if (skilling.state !== 'idle') return drawSkillingProfit(container, skilling);

        const party = partyStats();
        if (!party.length) return blank(container);

        // A row each, because loot is rolled per character against their own
        // drop gear — five people splitting a zone do not split it evenly, and
        // the party's spread is the thing worth watching during a run
        rows(
            container,
            party.map((stats) => {
                const banked = bankedTotal(stats);

                return [
                    {
                        text: stats.name || 'You',
                        color: stats.isCurrentPlayer ? ROW_COLORS.gold : ROW_COLORS.dim,
                        bold: Boolean(stats.isCurrentPlayer),
                        ellipsis: true,
                    },
                    { text: '🪙' },
                    {
                        text: formatLargeNumber(Math.round(banked)),
                        color: banked >= 0 ? ROW_COLORS.good : ROW_COLORS.bad,
                    },
                    {
                        text: `${formatLargeNumber(Math.round(stats.dailyProfit.value))}/day`,
                        color: ROW_COLORS.dim,
                        push: true,
                    },
                ];
            })
        );

        // The banked figures above price unopened chests at EV; when that EV is
        // scaled by measured luck the tile says so rather than staying silent
        const luckNotes = [
            ...new Set(party.flatMap((stats) => (stats.chestLuckAdjustments || []).map(describeLuckAdjustment))),
        ];
        container.title = luckNotes.join('\n');
    },
    // Party Loot rather than the Profit panel: this tile is a coin figure per
    // character, and the question it raises is *what* each of them picked up.
    // The Profit panel answers a different one — which pricing, and what the
    // costs were — and is still behind Combat Revenue.
    onOpen: () => partyLootPanel()?.toggle(),
});

/**
 * Which consumable runs out first, and what the lot costs per day.
 *
 * The soonest one is the only one that matters: it is what ends the run whether
 * you are watching or not. Naming it is the difference between "top up before
 * bed" and coming back to four idle hours.
 */
registerRow({
    key: 'consumables',
    empty: 'No teas or food slotted',
    name: 'Consumables',
    // Each market side has its own line so unpriced-item counts fit.
    defaultSize: { width: 240, height: 52 },
    // Every figure and color the tile carries, in the precision it carries
    // them: the two countdowns as they are worded, the color each is given —
    // which is a comparison against the Consumables panel's target, so a change
    // to that target has to move the version and does — the limiting item, and
    // the two cost figures rounded as drawn. The sprite sheet is in there too,
    // because an icon drawn before the game has loaded the sheet is a spacer
    // that has to be replaced when the sheet turns up.
    version: () => {
        // A skill running: the same builder the panel draws from, so the tile
        // redraws when the activity, the teas or the rounded time changes
        const skill = skillingPayload();
        if (skill) return skill.view.forecasts.length ? skillingVersion(skill) : 'skilling-blank';

        const payload = consumablesPayload();
        if (!payload) return 'blank';

        const { you, party, partyName, limiting, sides, youUnknown, partyUnknown } = payload;
        return [
            you ? `${shortDuration(you.secondsLeft)}@${runOutColor(you)}` : '--',
            party ? `${shortDuration(party.secondsLeft)}@${runOutColor(party)}` : '--',
            youUnknown ? 'you-rate-unknown' : '',
            partyUnknown ? 'party-rate-unknown' : '',
            partyName || '',
            limiting.itemHrid,
            limiting.held,
            runOutColor(limiting),
            sides.ask === null ? 'unknown' : Math.round(sides.ask),
            sides.bid === null ? 'unknown' : Math.round(sides.bid),
            sides.askUnpriced || 0,
            sides.bidUnpriced || 0,
            sides.askUnknown || 0,
            sides.bidUnknown || 0,
            spriteUrl('items'),
        ].join('|');
    },
    render: (container) => {
        container.removeAttribute('title');
        const skill = skillingPayload();
        if (skill) return skill.view.forecasts.length ? renderSkilling(container, skill) : blank(container);

        const payload = consumablesPayload();
        if (!payload) return blank(container);

        const { you, party, partyName, limiting, sides } = payload;

        container.replaceChildren();
        Object.assign(container.style, {
            display: 'flex',
            flexDirection: 'column',
            // From the top, so this tile's first line is level with the first
            // line of whatever is beside it
            justifyContent: 'flex-start',
            alignItems: 'stretch',
            textAlign: 'left',
            lineHeight: '1.3',
            overflow: 'hidden',
        });

        const first = document.createElement('div');
        drawLine(
            first,
            [
                { text: 'You:', color: ROW_COLORS.dim },
                {
                    text: you
                        ? `${shortDuration(you.secondsLeft)}${payload.youUnknown ? ' + ?' : ''}`
                        : payload.youUnknown
                          ? 'rate unknown'
                          : '--',
                    color: runOutColor(you),
                },
                { text: 'Party:', color: ROW_COLORS.dim },
                {
                    text: party
                        ? `${shortDuration(party.secondsLeft)}${payload.partyUnknown ? ' + ?' : ''}`
                        : payload.partyUnknown
                          ? 'rate unknown'
                          : '--',
                    color: runOutColor(party),
                },
                askSegment(sides),
            ],
            { wrap: true }
        );
        container.appendChild(first);

        container.appendChild(limitingLine(limiting));

        // The Bid side and the unpriced/unknown wording are the tooltip's: the
        // tile is two lines, like the skilling one.
        container.title =
            `${partyName ? `${partyName} runs out first in the party.\n` : ''}` +
            'Total cost per day of the consumables in use:\n' +
            `Ask: ${formatConsumableCostSide(sides.ask, sides.askUnpriced, sides.askUnknown)}\n` +
            `Bid: ${formatConsumableCostSide(sides.bid, sides.bidUnpriced, sides.bidUnknown)}\n` +
            'Double-click to open the Consumables panel.';
    },
    // Looked up at click time, not imported: the panel lives in the UI bundle,
    // which loads after this one
    onOpen: () => consumablesPanel()?.toggle(),
});

/**
 * The Ask-side daily cost as the right end of a tile's first line. A side with
 * a missing quote or an unknown rate is marked in gold on the tile itself (an
 * asterisk, because the line has no room for the words); the words are in the
 * tooltip.
 * @param {{ask: number|null, askUnpriced?: number, askUnknown?: number}} sides
 * @returns {Object} A `drawLine` segment
 */
function askSegment(sides) {
    const total = sides.ask === null ? '—' : formatLargeNumber(Math.round(sides.ask));
    const partial = Boolean(sides.askUnpriced || sides.askUnknown);
    return {
        text: `Ask ${total}/day${partial ? '*' : ''}`,
        color: partial ? ROW_COLORS.gold : ROW_COLORS.neutral,
        push: true,
        breakable: true,
    };
}

/**
 * The item that stops you: how many are left, then its icon, then its name —
 * CRack's order, and the reason for it is the count. It is a stock figure rather
 * than a sum of money, and "3.17K remaining" is a worse answer than "3,170" to
 * the only question being asked, which is whether to top up now. Clicking any
 * of the three opens the marketplace, which is where you go next when the
 * answer is "soon".
 *
 * @param {Object} limiting - A forecast entry
 * @returns {HTMLElement}
 */
function limitingLine(limiting) {
    const second = document.createElement('div');
    Object.assign(second.style, { display: 'flex', alignItems: 'center', gap: '5px', overflow: 'hidden' });

    const count = document.createElement('span');
    count.textContent = limiting.rateKnown ? formatWithSeparator(limiting.held) : '?';
    count.style.color = runOutColor(limiting);
    count.style.fontWeight = 'bold';

    const icon = itemIcon(limiting.itemHrid, 16);

    const name = document.createElement('span');
    name.textContent = limiting.rateKnown
        ? itemNameOf(limiting.itemHrid)
        : `${itemNameOf(limiting.itemHrid)} · rate unknown`;
    Object.assign(name.style, {
        color: ROW_COLORS.dim,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    });

    for (const part of [count, icon, name]) linkToMarketplace(part, limiting.itemHrid, navigateToMarketplace);
    second.append(count, icon, name);
    return second;
}

/**
 * What the Consumables tile draws while a skill is running: the slotted teas,
 * from the builder the panel uses. Null in combat, with nothing running, or
 * while a labyrinth or special action runs, so those keep the tile as it was.
 *
 * Only your own teas: a skill has no party figure, and the tile says nothing of
 * one.
 *
 * @returns {{type: string, view: Object, soonest: Object|null, limiting: Object|null,
 *   unknown: number, sides: Object}|null}
 */
function skillingPayload() {
    const type = runningActionTypeHrid();
    if (!isSkillingActionType(type)) return null;

    const view = skillingConsumables(type);
    const forecasts = view.forecasts;
    const soonest = firstToRunOut(forecasts);
    return {
        type,
        view,
        soonest,
        limiting: soonest || forecasts.find((entry) => !entry.rateKnown) || forecasts[0] || null,
        unknown: forecasts.filter((entry) => !entry.rateKnown).length,
        sides: costPerDaySides(forecasts),
    };
}

/**
 * A day's cost at one side, as a per-day figure with its caveats beside it.
 * @param {number|null} amount - Cost per day at this side
 * @param {number} unpriced - Teas with no quote at this side
 * @param {number} unknown - Teas without a rate
 * @returns {string} e.g. `412K/day (1 unpriced)`; `—/day` when nothing could be priced
 */
function skillingCostText(amount, unpriced, unknown) {
    const total = amount === null ? '—' : formatLargeNumber(Math.round(amount));
    const notes = [unpriced ? `${unpriced} unpriced` : '', unknown ? `${unknown} rate unknown` : ''].filter(Boolean);
    return `${total}/day${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * Every input the skilling tile draws, at the precision it draws it.
 * @param {Object} skill - From `skillingPayload`
 * @returns {string}
 */
function skillingVersion(skill) {
    const { type, view, soonest, limiting, unknown, sides } = skill;
    return [
        'skilling',
        type,
        view.forecasts.map((entry) => entry.itemHrid).join(','),
        soonest ? `${shortDuration(soonest.secondsLeft)}@${runOutColor(soonest)}` : '--',
        unknown,
        limiting.itemHrid,
        limiting.held,
        runOutColor(limiting),
        sides.ask === null ? 'unknown' : Math.round(sides.ask),
        sides.bid === null ? 'unknown' : Math.round(sides.bid),
        sides.askUnpriced || 0,
        sides.bidUnpriced || 0,
        sides.askUnknown || 0,
        sides.bidUnknown || 0,
        spriteUrl('items'),
    ].join('|');
}

/**
 * The skilling tile: how long your slotted teas last while the skill keeps
 * running, a day of them at the Ask price (the first side this tile lists, and
 * what buying costs), and the tea that runs out first. Two lines.
 *
 * @param {HTMLElement} container - The tile
 * @param {Object} skill - From `skillingPayload`
 */
function renderSkilling(container, skill) {
    const { view, soonest, limiting, unknown, sides } = skill;

    container.replaceChildren();
    Object.assign(container.style, {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        alignItems: 'stretch',
        textAlign: 'left',
        lineHeight: '1.3',
        overflow: 'hidden',
    });

    const first = document.createElement('div');
    drawLine(
        first,
        [
            { text: 'You:', color: ROW_COLORS.dim },
            {
                text: soonest ? `${shortDuration(soonest.secondsLeft)}${unknown ? ' + ?' : ''}` : 'rate unknown',
                color: runOutColor(soonest),
            },
            {
                text: `Ask ${skillingCostText(sides.ask, sides.askUnpriced, sides.askUnknown)}`,
                color: ROW_COLORS.neutral,
                push: true,
                breakable: true,
            },
        ],
        { wrap: true }
    );
    container.appendChild(first);
    container.appendChild(limitingLine(limiting));

    container.title =
        `${view.label} teas: how long your slotted teas last while ${view.label} keeps running, ` +
        `and what a day of them costs at the Ask price. Both assume it runs continuously.\n` +
        `Ask: ${skillingCostText(sides.ask, sides.askUnpriced, sides.askUnknown)}\n` +
        `Bid: ${skillingCostText(sides.bid, sides.bidUnpriced, sides.bidUnknown)}\n` +
        'Double-click to open the Consumables panel.';
}

/**
 * Whether the character is fighting, doing something else, or idle.
 *
 * Read from the action list rather than from combat data, because that is the
 * question being asked: combat data says what the last run did, and stays
 * saying it long after the run stopped.
 */
registerRow({
    key: 'combatStatus',
    empty: 'Not in combat',
    name: 'Combat Status',
    defaultSize: { width: 160, height: 30 },
    // The action currently running is the tile's only input, and the hrid is all
    // of it: the three words and three colors below are a pure function of it.
    version: () => currentAction()?.actionHrid || 'idle',
    render: (container) => {
        const current = currentAction();

        let text = 'Idle';
        let color = ROW_COLORS.bad;
        if (current?.actionHrid?.startsWith('/actions/combat/')) {
            text = 'In Combat';
            color = ROW_COLORS.good;
        } else if (current) {
            // Not idle and not fighting: the queue is busy with something else,
            // which is not a problem but is not combat either
            text = 'Skilling';
            color = ROW_COLORS.accent;
        }

        row(container, [{ text, color, bold: true }]);
    },
});

/**
 * Whatever the character is doing right now.
 * @returns {Object|null} The queue's first unfinished action, or null when idle
 */
function currentAction() {
    // Execution order (lowest ordinal), not array position — a repeating
    // action requeued to the front of the array carries a higher ordinal
    // than the one actually running.
    return runningAction(dataManager.getCurrentActions?.() || []);
}

/**
 * How long the current run has been going.
 *
 * Live data can time itself from its start; a stored snapshot cannot, because
 * its start belongs to a run that may have ended hours ago.
 *
 * @param {Object|null} data - From the collector
 * @returns {number} Seconds, or 0 when unknown
 */
function sessionSeconds(data) {
    if (!data) return 0;
    if (data.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) return elapsed;
    }
    return data.durationSeconds || 0;
}

/**
 * Seconds as a running clock.
 *
 * `timeReadable` rounds to whole units, which is right for "five days" and wrong
 * for a timer you watch — a session clock that sits on "2 hours" for an hour
 * reads as a stopped clock.
 *
 * @param {number} seconds - Elapsed
 * @returns {string} `H:MM:SS`
 */
function clock(seconds) {
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Every player's consumables, forecast.
 *
 * The same assembly the Consumables panel does, from the same collector and the
 * same prices. The judgement about what those numbers mean lives in
 * `utils/consumable-forecast.js`, so the two views share it rather than each
 * deciding for itself what "runs out first" means.
 *
 * @returns {Array<{name: string, isCurrent: boolean, forecasts: Array<Object>}>}
 */
function consumablePlayers() {
    const now = Date.now();
    if (consumableCache && now - consumableCachedAt < CACHE_MS) return consumableCache;

    consumableCache = forecastPlayers();
    consumableCachedAt = now;
    return consumableCache;
}

/**
 * What the Consumables tile draws, assembled once and read by both `version`
 * and `render` so neither can be looking at a different forecast than the other.
 *
 * @returns {{you: Object|null, party: Object|null, partyName: string,
 *   limiting: Object, sides: {ask: number, bid: number}}|null} Null when there
 *   is nothing slotted to forecast
 */
function consumablesPayload() {
    const players = consumablePlayers();
    const { you, party, partyName } = partyOutlook(players);
    // Costed through the same forecast the panel uses, so the tile can show
    // both sides of the book the way the panel does and the two are read off
    // one calculation rather than two that happen to agree
    const mine = players.find((player) => player.isCurrent)?.forecasts || [];
    const youPlayer = players.find((player) => player.isCurrent);
    const otherPlayers = players.filter((player) => !player.isCurrent);
    const youUnknown = !!youPlayer?.forecasts.some((entry) => !entry.rateKnown);
    const partyUnknown = otherPlayers.some((player) => player.forecasts.some((entry) => !entry.rateKnown));
    const unknown = players.flatMap((player) => player.forecasts).find((entry) => !entry.rateKnown) || null;
    if (!you && !party && !unknown) return null;

    return {
        you,
        party,
        partyName,
        youUnknown,
        partyUnknown,
        limiting: you || party || unknown,
        sides: costPerDaySides(mine),
    };
}

/**
 * The forecast itself, uncached.
 * @returns {Array<{name: string, isCurrent: boolean, forecasts: Array<Object>}>}
 */
function forecastPlayers() {
    const data = combatStatsDataCollector.getLatestData();
    if (!data?.players?.length) return [];

    const duration = data.durationSeconds || 0;
    return data.players.map((player) => ({
        name: player.name || 'Unknown',
        isCurrent: !!player.isCurrentPlayer,
        forecasts: forecastAll(
            exactDrinkRates(calculatePlayerStats(player, duration)?.consumableBreakdown, player),
            (hrid) => getItemPrices(hrid),
            { keepOrder: true }
        ),
    }));
}

/**
 * How urgent a countdown is.
 * @param {Object|null} entry - A forecast, or null when there is no answer
 * @returns {string} A color
 */
function runOutColor(entry) {
    if (!entry || !entry.rateKnown) return ROW_COLORS.dim;

    // Against the target you set in the Consumables panel, not a fixed hour.
    // With "3 days" chosen, something lasting two of them is precisely what the
    // setting exists to flag — and green here while the panel's Buy column says
    // to buy 1.15K of it was the two halves of one feature disagreeing.
    return entry.secondsLeft < currentTarget().seconds ? ROW_COLORS.bad : ROW_COLORS.good;
}

/**
 * An item's name, falling back to its hrid so an item the game data does not
 * know about still reads as something rather than as a blank.
 * @param {string} itemHrid - The item
 * @returns {string} Name
 */
function itemNameOf(itemHrid) {
    const details = dataManager.getItemDetails?.(itemHrid);
    return details?.name || String(itemHrid).replace('/items/', '').replace(/_/g, ' ');
}

/**
 * Replace measured drink rates with the arithmetic ones.
 *
 * A drink is re-drunk the moment its buff expires, so its rate follows from the
 * duration and the player's concentration. Food is eaten on a health or mana
 * trigger and has nothing to compute, so it stays measured. The same pass the
 * Consumables panel makes, so the two agree about how long anything lasts.
 *
 * @param {Array<Object>} breakdown - From `calculatePlayerStats`
 * @param {Object} player - The collector's player entry, for its concentration
 * @returns {Array<Object>} The same entries, drinks re-rated
 */
function exactDrinkRates(breakdown, player) {
    const concentration = player?.combatStats?.drinkConcentration || 0;

    return (breakdown || []).map((entry) => {
        const duration = dataManager.getItemDetails?.(entry?.itemHrid)?.consumableDetail?.buffs?.[0]?.duration;
        const perDay = drinkRatePerDay(duration, concentration);
        if (perDay === null) return entry;

        return { ...entry, consumptionRate: perDay / 86400, consumedPerDay: Math.ceil(perDay) };
    });
}

// The tile colors against the target, and this bundle may well be drawn before
// the one holding the panel that sets it. The module itself is shared, so a
// second call is a second storage read and nothing more.
loadTarget();
