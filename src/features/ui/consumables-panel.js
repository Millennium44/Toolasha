/**
 * Consumables panel
 *
 * Everything the character is eating and drinking, how long it lasts, and what
 * it would take to keep it going.
 *
 * The overlay row answers "what runs out first, and when". That is the figure
 * worth watching, but it is not the figure worth acting on — when the answer is
 * "six hours", the next question is immediately "so what do I buy, and how
 * much", and the row cannot hold that. This can.
 *
 * ## The target duration is the point
 *
 * Every line is measured against a duration you pick: overnight, a day, a
 * weekend. A list of stock levels tells you what you have; the same list against
 * "last me a day" tells you what to do about it, and the two readings differ for
 * every consumable because they are consumed at different rates.
 *
 * Shortfalls are rounded up and counted from what is already held, so the figure
 * is what to buy rather than what to own. The arithmetic is in
 * `utils/consumable-forecast.js`; this module lists, sorts and draws.
 *
 * Party members are shown when there are any, because a party run stops when the
 * **first** member runs dry, and that member is frequently not you.
 *
 * ## Why it lives in the UI bundle
 *
 * It reads combat data but is otherwise a panel, and the combat bundle is close
 * to its size ceiling while this one is not. The collector it reads is a
 * stateful singleton fed by the websocket, so it is declared shared in
 * `rollup.config.js` rather than imported into a second copy that would sit
 * there receiving nothing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { shortDuration, itemIcon, linkToMarketplace, ROW_COLORS } from '../../utils/overlay-format.js';
import { getItemPrices } from '../../utils/market-data.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import {
    forecastAll,
    firstToRunOut,
    costPerDaySides,
    refillFor,
    refillAll,
    drinkRatePerDay,
    buyStrategy,
} from '../../utils/consumable-forecast.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';

const PANEL_ID = 'toolasha-consumables-panel';
const GEOMETRY_KEY = 'consumablesPanel';
const DEFAULT_PANEL = { width: 520, height: 420 };
const REFRESH_MS = 5000;

/** How long you might want the stock to last, cycled by the header button */
const TARGETS = [
    { label: '8 hours', seconds: 8 * 3600 },
    { label: '1 day', seconds: 86400 },
    { label: '3 days', seconds: 3 * 86400 },
    { label: '1 week', seconds: 7 * 86400 },
];

/** Below this, a consumable is worth doing something about now */
const URGENT_SECONDS = 3600;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.97)',
    headerBg: 'rgba(20, 30, 24, 0.9)',
    border: 'rgba(120, 200, 150, 0.32)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#7fd6a3',
};

class ConsumablesPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.targetIndex = 1;
        this.refreshId = null;
        // The same mechanism the missing-materials features use: park a quantity,
        // and the buy modal fills itself in when it appears
        this.autofill = createAutofillManager('Consumables');
        this.autofill.initialize?.();
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** The duration everything is measured against */
    get target() {
        return TARGETS[this.targetIndex] || TARGETS[1];
    }

    /**
     * Every player's consumables, the current character first.
     *
     * A party run stops when the first member runs dry, and that member is
     * frequently not you — so party members are listed rather than summarised
     * away.
     *
     * @returns {Array<{name: string, isCurrent: boolean, forecasts: Array<Object>}>}
     */
    _players() {
        const data = combatStatsDataCollector.getLatestData();
        if (!data?.players?.length) return [];

        const duration = data.durationSeconds || 0;
        return data.players
            .map((player) => {
                const stats = calculatePlayerStats(player, duration);
                return {
                    name: player.name || 'Unknown',
                    isCurrent: !!player.isCurrentPlayer,
                    forecasts: forecastAll(
                        this._exactRates(stats?.consumableBreakdown, player),
                        (hrid) => getItemPrices(hrid),
                        {
                            keepOrder: true,
                        }
                    ),
                };
            })
            .filter((entry) => entry.forecasts.length)
            .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    }

    /**
     * Replace measured drink rates with the arithmetic ones.
     *
     * A drink is re-drunk the moment its buff expires, so its rate follows from
     * the buff's duration and the player's drink concentration and needs no
     * observing. Food is eaten on a health or mana trigger, which depends on
     * what is hitting you, so it is left measured — there is nothing to compute.
     *
     * The measured figure was also capped at a hardcoded 345.6 a day, the rate
     * at the maximum 20% concentration, so anyone below that was told their
     * drinks would run out sooner than they will.
     *
     * @param {Array<Object>} breakdown - From `calculatePlayerStats`
     * @param {Object} player - The collector's player entry, for its concentration
     * @returns {Array<Object>} The same entries, drinks re-rated
     */
    _exactRates(breakdown, player) {
        const concentration = player?.combatStats?.drinkConcentration || 0;

        return (breakdown || []).map((entry) => {
            const detail = dataManager.getItemDetails?.(entry?.itemHrid);
            const duration = detail?.consumableDetail?.buffs?.[0]?.duration;
            const perDay = drinkRatePerDay(duration, concentration);
            if (perDay === null) return entry;

            return { ...entry, consumptionRate: perDay / 86400, consumedPerDay: Math.ceil(perDay) };
        });
    }

    /**
     * Send the shortfall to the marketplace, quantity already filled in.
     *
     * Opening the buy modal rather than buying: this is a decision about
     * spending coins, and a panel that spends them for you is a panel you have
     * to watch. The recommendation of order-against-instant rides along in the
     * tooltip, where it informs the decision without making it.
     *
     * @param {Object} entry - The forecast being topped up
     * @param {number} count - How many are missing
     */
    _buy(entry, count) {
        if (!count) return;
        try {
            this.autofill.setQuantity(count);
            navigateToMarketplace(entry.itemHrid);
        } catch (error) {
            console.error('[ConsumablesPanel] Opening the marketplace failed:', error);
        }
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '110px',
            left: '70px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px 10px 10px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 200,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 200 });

        this._render();
        // Stock and rates both move as you play, and prices move under them
        this.refreshId = setInterval(() => this._render(), REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Consumables';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        // The duration everything is measured against, on its own face rather
        // than behind a menu — every figure below it changes when it changes
        this.targetBtn = document.createElement('button');
        Object.assign(this.targetBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 8px',
        });
        this.targetBtn.title = 'How long the stock should last. Every shortfall below is measured against this.';
        this.targetBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.targetIndex = (this.targetIndex + 1) % TARGETS.length;
            this._render();
        });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.append(title, this.targetBtn, spacer, close);
        return header;
    }

    _render() {
        if (!this.bodyEl) return;
        this.targetBtn.textContent = `Last ${this.target.label}`;

        this.bodyEl.replaceChildren();
        const players = this._players();

        if (!players.length) {
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            // Reached before any combat has been fought — consumption is measured
            // from what a run actually used, so there is nothing to measure yet
            empty.textContent = 'No consumable data yet. Fight something with food or drinks equipped.';
            this.bodyEl.appendChild(empty);
            return;
        }

        for (const player of players) this.bodyEl.appendChild(this._playerSection(player));
    }

    /**
     * One player's consumables, with their own summary.
     * @param {Object} player - From `_players`
     * @returns {HTMLElement}
     */
    _playerSection(player) {
        const section = document.createElement('div');
        section.style.marginBottom = '12px';

        const soonest = firstToRunOut(player.forecasts);
        const sides = costPerDaySides(player.forecasts);
        const need = refillAll(player.forecasts, this.target.seconds);

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });

        const name = document.createElement('span');
        name.textContent = player.isCurrent ? `${player.name} (you)` : player.name;
        name.style.fontWeight = 'bold';
        name.style.color = player.isCurrent ? COLORS.accent : COLORS.text;

        const stops = document.createElement('span');
        stops.style.marginLeft = 'auto';
        if (soonest) {
            stops.textContent = `stops in ${shortDuration(soonest.secondsLeft)} · ${soonest.name}`;
            stops.style.color = soonest.secondsLeft < URGENT_SECONDS ? ROW_COLORS.bad : ROW_COLORS.good;
        } else {
            // Nothing being consumed at all, which is not the same as lasting
            // forever — it usually means an empty slot
            stops.textContent = 'nothing being consumed';
            stops.style.color = COLORS.textDim;
        }

        heading.append(name, stops);
        section.appendChild(heading);

        section.appendChild(this._columnHeadings());
        for (const entry of player.forecasts) {
            section.appendChild(this._entryRow(entry, entry === soonest));
        }

        section.appendChild(this._footer(sides, need));
        return section;
    }

    /** @returns {HTMLElement} */
    _columnHeadings() {
        const row = this._grid();
        row.style.color = COLORS.textDim;
        row.style.marginBottom = '3px';

        for (const [text, align] of [
            ['Held', 'right'],
            ['', 'left'],
            ['Item', 'left'],
            ['Per day', 'right'],
            ['Cost/day', 'right'],
            [`Buy for ${this.target.label}`, 'right'],
            ['Lasts', 'right'],
        ]) {
            const cell = document.createElement('span');
            cell.textContent = text;
            cell.style.textAlign = align;
            row.appendChild(cell);
        }
        return row;
    }

    /**
     * One consumable, laid out the way MCS's CRack lays it out: the count you
     * hold, the icon, the name, then the rates and the countdown.
     *
     * The one that runs out first is coloured throughout rather than only in its
     * time column — it is the row the whole panel exists to point at, and a
     * single red figure at the far right is easy to miss.
     *
     * @param {Object} entry - A forecast
     * @param {boolean} isLimiting - Whether this is the one that stops the run
     * @returns {HTMLElement}
     */
    _entryRow(entry, isLimiting) {
        const row = this._grid();
        row.style.padding = '2px 0';

        const held = this._cell(formatLargeNumber(entry.held));
        held.style.color = isLimiting ? ROW_COLORS.bad : COLORS.text;

        const icon = itemIcon(entry.itemHrid, 18);
        linkToMarketplace(icon, entry.itemHrid, navigateToMarketplace);

        const name = document.createElement('span');
        name.textContent = entry.name;
        Object.assign(name.style, {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: isLimiting ? ROW_COLORS.bad : COLORS.text,
        });
        linkToMarketplace(name, entry.itemHrid, navigateToMarketplace);

        const perDay = this._cell(entry.perDay >= 1 ? `${entry.perDay.toFixed(1)}/day` : '—');
        perDay.style.color = COLORS.textDim;

        // Both sides stacked, because buying costs ask and what you hold is worth
        // bid — averaging them hides a gap that is real money at this scale
        const cost = document.createElement('span');
        Object.assign(cost.style, { textAlign: 'right', lineHeight: '1.15', fontSize: '90%' });
        const sides = entry.costPerDaySides;
        if (sides.ask === null && sides.bid === null) {
            cost.textContent = '—';
            cost.style.color = COLORS.textDim;
        } else {
            cost.appendChild(this._side('Ask', sides.ask));
            cost.appendChild(this._side('Bid', sides.bid));
        }

        const need = refillFor(entry, this.target.seconds);
        const buy = this._cell(need.count ? formatLargeNumber(need.count) : '✓');
        buy.style.color = need.count ? ROW_COLORS.gold : ROW_COLORS.good;

        if (need.count) {
            const strategy = buyStrategy({
                count: need.count,
                ask: entry.price,
                bid: entry.costPerDaySides.bid && entry.perDay ? entry.costPerDaySides.bid / entry.perDay : null,
                secondsLeft: entry.secondsLeft,
            });

            // The recommendation is on the face of it, because it is the whole
            // reason to press one of these rather than open the marketplace
            buy.textContent = `${formatLargeNumber(need.count)} ${strategy.mode === 'order' ? '⏳' : '⚡'}`;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            buy.title =
                `Buy ${need.count.toLocaleString()}` +
                (need.cost === null ? '' : ` for about ${Math.round(need.cost).toLocaleString()} coins`) +
                `.\n${strategy.mode === 'order' ? 'Place an order' : 'Buy now'}: ${strategy.reason}`;
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._buy(entry, need.count);
            });
        }

        const lasts = this._cell(Number.isFinite(entry.secondsLeft) ? shortDuration(entry.secondsLeft) : '∞');
        if (!Number.isFinite(entry.secondsLeft)) lasts.style.color = COLORS.textDim;
        else lasts.style.color = isLimiting || entry.secondsLeft < URGENT_SECONDS ? ROW_COLORS.bad : ROW_COLORS.good;

        row.append(held, icon, name, perDay, cost, buy, lasts);
        return row;
    }

    /**
     * One side of the book, on its own line.
     * @param {string} label - `Ask` or `Bid`
     * @param {number|null} value - Coins per day
     * @returns {HTMLElement}
     */
    _side(label, value) {
        const line = document.createElement('div');
        line.textContent = `${label}: ${value === null ? '—' : formatLargeNumber(Math.round(value))}`;
        line.style.color = COLORS.textDim;
        line.style.whiteSpace = 'nowrap';
        return line;
    }

    /**
     * @param {{ask: number, bid: number}} sides - Cost per day
     * @param {{items: number, cost: number, unpriced: number}} need - Total shortfall
     * @returns {HTMLElement}
     */
    _footer(sides, need) {
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: '5px',
            paddingTop: '4px',
            fontWeight: 'bold',
        });

        const label = document.createElement('span');
        label.textContent = 'Total Cost/Day:';
        label.style.color = COLORS.accent;

        const value = document.createElement('span');
        value.textContent = `Ask: ${formatLargeNumber(Math.round(sides.ask))} / Bid: ${formatLargeNumber(Math.round(sides.bid))}`;
        value.style.whiteSpace = 'nowrap';

        const buy = document.createElement('span');
        buy.style.marginLeft = 'auto';
        buy.style.whiteSpace = 'nowrap';
        if (need.items) {
            buy.textContent = `Buy ${formatLargeNumber(need.items)} · ${formatLargeNumber(Math.round(need.cost))}`;
            buy.style.color = ROW_COLORS.gold;
            if (need.unpriced) buy.title = `${need.unpriced} item(s) could not be priced and are not in this total.`;
        } else {
            buy.textContent = 'Stocked ✓';
            buy.style.color = ROW_COLORS.good;
        }

        footer.append(label, value, buy);
        return footer;
    }

    /** The one grid every line shares, so the columns line up */
    _grid() {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '64px 20px minmax(0, 1fr) 76px 84px 74px 64px',
            gap: '6px',
            alignItems: 'baseline',
        });
        return row;
    }

    /**
     * @param {string} text - Cell contents
     * @returns {HTMLElement}
     */
    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const consumablesPanel = new ConsumablesPanel();

/** Console handle, since a panel that only opens from the overlay is hard to reach */
if (typeof window !== 'undefined') {
    window.Toolasha = window.Toolasha || {};
    window.Toolasha.Debug = window.Toolasha.Debug || {};
    window.Toolasha.Debug.consumables = () => {
        const data = combatStatsDataCollector.getLatestData();
        console.log('[Consumables] players:', data?.players?.length ?? 0);
        for (const player of data?.players || []) {
            const stats = calculatePlayerStats(player, data.durationSeconds || 0);
            console.log(` ${player.name}:`, forecastAll(stats?.consumableBreakdown));
        }
        return dataManager.getCurrentCharacterId?.();
    };
}
