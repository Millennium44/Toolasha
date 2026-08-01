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
import { shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { forecastAll, firstToRunOut, costPerDay, refillFor, refillAll } from '../../utils/consumable-forecast.js';
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
                    forecasts: forecastAll(stats?.consumableBreakdown),
                };
            })
            .filter((entry) => entry.forecasts.length)
            .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
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
        const cost = costPerDay(player.forecasts);
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
        for (const entry of player.forecasts) section.appendChild(this._entryRow(entry));

        section.appendChild(this._footer(cost, need));
        return section;
    }

    /** @returns {HTMLElement} */
    _columnHeadings() {
        const row = this._grid();
        row.style.color = COLORS.textDim;
        row.style.marginBottom = '2px';

        for (const [text, align] of [
            ['Item', 'left'],
            ['Held', 'right'],
            ['Per day', 'right'],
            ['Lasts', 'right'],
            [`Buy for ${this.target.label}`, 'right'],
        ]) {
            const cell = document.createElement('span');
            cell.textContent = text;
            cell.style.textAlign = align;
            row.appendChild(cell);
        }
        return row;
    }

    /**
     * One consumable.
     * @param {Object} entry - A forecast
     * @returns {HTMLElement}
     */
    _entryRow(entry) {
        const row = this._grid();
        row.style.padding = '1px 0';

        const name = document.createElement('span');
        name.textContent = entry.name;
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

        const held = this._cell(formatLargeNumber(entry.held));

        const perDay = this._cell(entry.perDay >= 1 ? formatLargeNumber(Math.round(entry.perDay)) : '—');
        perDay.style.color = COLORS.textDim;

        const lasts = this._cell(Number.isFinite(entry.secondsLeft) ? shortDuration(entry.secondsLeft) : '∞');
        if (!Number.isFinite(entry.secondsLeft)) lasts.style.color = COLORS.textDim;
        else lasts.style.color = entry.secondsLeft < URGENT_SECONDS ? ROW_COLORS.bad : ROW_COLORS.good;

        // The shortfall, not the requirement: what to buy rather than what to own
        const need = refillFor(entry, this.target.seconds);
        const buy = this._cell(
            need.count
                ? `${formatLargeNumber(need.count)}${need.cost === null ? '' : ` · ${formatLargeNumber(Math.round(need.cost))}`}`
                : '✓'
        );
        buy.style.color = need.count ? ROW_COLORS.gold : ROW_COLORS.good;

        row.append(name, held, perDay, lasts, buy);
        return row;
    }

    /**
     * @param {{total: number, unpriced: number}} cost - Cost per day
     * @param {{items: number, cost: number, unpriced: number}} need - Total shortfall
     * @returns {HTMLElement}
     */
    _footer(cost, need) {
        const footer = this._grid();
        Object.assign(footer.style, {
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: '4px',
            paddingTop: '3px',
            fontWeight: 'bold',
        });

        const label = document.createElement('span');
        label.textContent = 'Total';

        const blank = document.createElement('span');
        const perDay = this._cell(`${formatLargeNumber(Math.round(cost.total))}/day`);
        perDay.style.color = ROW_COLORS.bad;

        const spacer = document.createElement('span');

        const buy = this._cell(need.items ? formatLargeNumber(Math.round(need.cost)) : '✓');
        buy.style.color = need.items ? ROW_COLORS.gold : ROW_COLORS.good;
        if (need.unpriced) buy.title = `${need.unpriced} item(s) could not be priced and are not in this total.`;

        footer.append(label, blank, perDay, spacer, buy);
        return footer;
    }

    /** The one grid every line shares, so the columns line up */
    _grid() {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 64px 68px 78px 116px',
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
