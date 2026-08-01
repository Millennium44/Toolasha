/**
 * Treasure Tracker
 *
 * Keeps a ledger of every chest you open, and shows whether they paid out.
 *
 * Toolasha already prices a chest before you open it, in tooltips and in net
 * worth. That is a claim about the long run. This is the record of whether the
 * long run has turned up: how many you have opened, what came out, and what the
 * drop tables said should have.
 *
 * The tracking runs whenever the feature is on, whether or not the panel is
 * open — a ledger you have to remember to start is a ledger with nothing in it
 * when you finally want to read it. Only the drawing waits for the panel.
 *
 * The arithmetic is in `utils/chest-tally.js`. This module listens, stores, and
 * draws.
 *
 * The idea is TReasure's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The panel
 * is Toolasha's own.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import { recordOpening, resetTally, chestPerformance, summariseTally, tallyTotals } from '../../utils/chest-tally.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { makeDraggable } from '../../utils/floating-panel.js';

const STORAGE_KEY = 'treasureTally';
const PANEL_ID = 'toolasha-treasure-panel';
const POPUP_ID = 'toolasha-treasure-popup';
/** The game's own dialog, which the popup wants to sit beside */
const LOOT_DIALOG_SELECTOR = '[class*="Modal_modal"]:not([class*="Modal_modalContainer"])';
/** Gap between the two, and how far off a screen edge the popup may not go */
const DIALOG_GAP = 12;
const EDGE_MARGIN = 8;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.96)',
    headerBg: 'rgba(30, 22, 8, 0.8)',
    border: 'rgba(255, 207, 92, 0.35)',
    text: '#e8e6df',
    textDim: 'rgba(232, 230, 223, 0.55)',
    accent: '#ffcf5c',
    good: '#4ade80',
    bad: '#f87171',
};

/** Beyond this far from expectation, a chest is worth remarking on */
const NOTABLE_RATIO = 0.05;

/**
 * How a chest's return reads against expectation.
 * @param {number|null} ratio - actual ÷ expected, or null with nothing opened
 * @returns {{text: string, color: string}}
 */
export function formatReturn(ratio) {
    if (ratio === null || ratio === undefined) return { text: '—', color: COLORS.textDim };

    const percent = (ratio - 1) * 100;
    const sign = percent >= 0 ? '+' : '';
    const text = `${sign}${percent.toFixed(1)}%`;

    if (percent > NOTABLE_RATIO * 100) return { text, color: COLORS.good };
    if (percent < -NOTABLE_RATIO * 100) return { text, color: COLORS.bad };
    return { text, color: COLORS.textDim };
}

/**
 * An item hrid as a readable name, falling back to the hrid's own last segment
 * so an item the game data does not know about still reads as something.
 * @param {string} itemHrid - Item
 * @returns {string} Name
 */
export function itemName(itemHrid) {
    const details = dataManager.getItemDetails?.(itemHrid);
    if (details?.name) return details.name;
    return itemHrid.replace('/items/', '').replace(/_/g, ' ');
}

class TreasureTracker {
    constructor() {
        this.isInitialized = false;
        this.tally = {};
        this.lootOpenedHandler = null;
        this.panel = null;
        this.contentEl = null;
        this.headerEl = null;
        this.expanded = new Set();
        this.isDragging = false;
        this.popup = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('treasureTracker')) return;
        this.isInitialized = true;

        this.tally = (await storage.getJSON(STORAGE_KEY, 'settings', {})) || {};

        this.lootOpenedHandler = (data) => this._onLootOpened(data);
        webSocketHook.on('loot_opened', this.lootOpenedHandler);
    }

    disable() {
        if (this.lootOpenedHandler) {
            webSocketHook.off('loot_opened', this.lootOpenedHandler);
            this.lootOpenedHandler = null;
        }
        this._removePanel();
        this._removePopup();
        this.isInitialized = false;
    }

    /**
     * Record an opening and redraw if anyone is looking.
     * @param {Object} data - `loot_opened` message
     */
    _onLootOpened(data) {
        const chestHrid = data?.openedItem?.itemHrid;
        if (!chestHrid) return;

        this.tally = recordOpening(this.tally, chestHrid, data.openedItem.count || 1, data.gainedItems);
        this._save();
        if (this.panel) this._render();
        if (config.getSetting('treasureTracker_popup')) this._showOpening(chestHrid);
    }

    /**
     * Show what the opening that just happened paid, against what it owed.
     *
     * Beside the game's own "Opened Loot" dialog, because that dialog answers
     * "what did I get" and leaves the only interesting question — "was that
     * good?" — to a feeling. The counts are the same ones on screen; the second
     * line under each is what the drop table said to expect.
     *
     * @param {string} chestHrid - What was opened
     */
    _showOpening(chestHrid) {
        const entry = this.tally[chestHrid];
        if (!entry?.last) return;

        const dropTable = dataManager.getInitClientData()?.openableLootDropMap?.[chestHrid];
        const opening = chestPerformance(entry.last, dropTable, this._priceOf());
        const lifetime = chestPerformance(entry, dropTable, this._priceOf());

        this._removePopup();
        this.popup = this._buildPopup(chestHrid, opening, lifetime);
        document.body.appendChild(this.popup);
        registerFloatingPanel(this.popup);
        this._placeBesideDialog();
    }

    /**
     * Put the popup beside the game's Opened Loot dialog.
     *
     * The two are read together — the game's counts on the left, whether they
     * were good on the right — so a popup pinned to a screen corner makes you
     * look back and forth across the whole window.
     *
     * Measured after mounting, because the height depends on how many items the
     * chest paid out. Falls back to the top-right corner when the dialog is not
     * up, which happens when a chest is opened by some route that does not raise
     * one.
     */
    _placeBesideDialog() {
        const dialog = document.querySelector(LOOT_DIALOG_SELECTOR);
        if (!dialog) return;

        const anchor = dialog.getBoundingClientRect();
        const self = this.popup.getBoundingClientRect();
        if (!anchor.width || !self.width) return;

        // To the right of the dialog, unless that would run off screen, in which
        // case the left side has the room
        const rightOf = anchor.right + DIALOG_GAP;
        const leftOf = anchor.left - self.width - DIALOG_GAP;
        const fitsRight = rightOf + self.width <= window.innerWidth - EDGE_MARGIN;
        const left = fitsRight ? rightOf : Math.max(leftOf, EDGE_MARGIN);

        // Top-aligned with the dialog, nudged up only if the popup is the taller
        // of the two and would otherwise hang off the bottom
        const maxTop = window.innerHeight - self.height - EDGE_MARGIN;
        const top = Math.max(EDGE_MARGIN, Math.min(anchor.top, maxTop));

        Object.assign(this.popup.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
    }

    _save() {
        storage.setJSON(STORAGE_KEY, this.tally, 'settings').catch((error) => {
            console.error('[TreasureTracker] Saving the chest tally failed:', error);
        });
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._createPanel();
    }

    /**
     * The rows to draw, and their totals.
     * @returns {{rows: Array<Object>, totals: Object}}
     */
    _summary() {
        const dropTables = dataManager.getInitClientData()?.openableLootDropMap || {};
        const rows = summariseTally(this.tally, dropTables, this._priceOf());
        return { rows, totals: tallyTotals(rows) };
    }

    /**
     * The one price source both the ledger and the popup read through, so a
     * chest cannot look lucky merely because two views priced it differently.
     * @returns {Function} `(itemHrid) => number|null`
     */
    _priceOf() {
        // Coins are the base currency and never appear on the market
        return (itemHrid) =>
            itemHrid === '/items/coin' ? 1 : getItemPrice(itemHrid, { context: 'profit', side: 'sell' });
    }

    /**
     * The item sprite sheet the game is on today.
     *
     * Read off any icon already on the page rather than pinned, because the URL
     * carries a build hash the game regenerates.
     * @returns {string} Sprite URL, or '' if none is on screen yet
     */
    _spriteUrl() {
        if (this._sprite) return this._sprite;
        const use = document.querySelector('svg use[href*="items_sprite"]');
        this._sprite = use?.getAttribute('href')?.split('#')[0] || '';
        return this._sprite;
    }

    /**
     * @param {string} itemHrid - Item to draw
     * @param {number} size - Pixels
     * @returns {SVGElement|HTMLElement} An icon, or a spacer if the sheet is unknown
     */
    _icon(itemHrid, size = 18) {
        const sprite = this._spriteUrl();
        if (!sprite) {
            const spacer = document.createElement('span');
            spacer.style.width = `${size}px`;
            return spacer;
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flex = '0 0 auto';
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `${sprite}#${itemHrid.split('/').pop()}`);
        svg.appendChild(use);
        return svg;
    }

    /**
     * Build the just-opened popup.
     * @param {string} chestHrid - What was opened
     * @param {Object} opening - Performance of this opening
     * @param {Object} lifetime - Performance of every opening of this chest
     * @returns {HTMLElement} The popup
     */
    _buildPopup(chestHrid, opening, lifetime) {
        const popup = document.createElement('div');
        popup.id = POPUP_ID;
        Object.assign(popup.style, {
            position: 'fixed',
            top: '80px',
            right: '40px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: '340px',
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

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            cursor: 'move',
            userSelect: 'none',
        });
        const title = document.createElement('span');
        title.textContent = `Treasure — ${itemName(chestHrid)}`;
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;
        header.appendChild(title);
        header.appendChild(this._headerButton('✕', () => this._removePopup()));
        popup.appendChild(header);

        const body = document.createElement('div');
        body.style.padding = '8px 11px 10px';
        popup.appendChild(body);

        const subtitle = document.createElement('div');
        subtitle.textContent = `Last opening (×${opening.opened})`;
        subtitle.style.color = COLORS.accent;
        subtitle.style.marginBottom = '3px';
        body.appendChild(subtitle);

        const verdict = formatReturn(opening.ratio);
        const summary = document.createElement('div');
        Object.assign(summary.style, { display: 'flex', justifyContent: 'space-between', marginBottom: '7px' });
        const paid = document.createElement('span');
        paid.textContent = formatLargeNumber(Math.round(opening.actualValue));
        paid.style.color = verdict.color;
        const pct = document.createElement('span');
        pct.textContent = verdict.text;
        pct.style.color = verdict.color;
        summary.appendChild(paid);
        summary.appendChild(pct);
        body.appendChild(summary);

        for (const item of opening.items) body.appendChild(this._openingRow(item));

        const total = document.createElement('div');
        Object.assign(total.style, {
            display: 'flex',
            justifyContent: 'space-between',
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: '7px',
            paddingTop: '6px',
        });
        const lifeVerdict = formatReturn(lifetime.ratio);
        const totalLabel = document.createElement('span');
        totalLabel.textContent = `All ${lifetime.opened} opened`;
        const totalValue = document.createElement('span');
        totalValue.textContent = `${formatLargeNumber(Math.round(lifetime.actualValue))} · ${lifeVerdict.text}`;
        totalValue.style.color = lifeVerdict.color;
        total.appendChild(totalLabel);
        total.appendChild(totalValue);
        body.appendChild(total);

        const full = document.createElement('button');
        full.textContent = 'View full stats';
        Object.assign(full.style, {
            marginTop: '8px',
            width: '100%',
            padding: '5px',
            background: 'rgba(255, 207, 92, 0.12)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '4px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '12px',
        });
        full.addEventListener('click', () => {
            this._removePopup();
            this.show();
        });
        body.appendChild(full);

        this._detachPopupDrag = makeDraggable(popup, header);
        return popup;
    }

    /**
     * One item: what came out on top, what was owed underneath.
     *
     * Two lines rather than one because the comparison is the point — a count on
     * its own says nothing, and putting expected beside actual on a single line
     * makes eight of them unreadable.
     *
     * @param {Object} item - From `chestPerformance`
     * @returns {HTMLElement} The row
     */
    _openingRow(item) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '7px', alignItems: 'flex-start', padding: '2px 0' });
        row.appendChild(this._icon(item.itemHrid));

        const columns = document.createElement('div');
        Object.assign(columns.style, { flex: '1', display: 'flex', flexDirection: 'column', lineHeight: '1.35' });

        const ratio = item.expectedValue > 0 ? item.actualValue / item.expectedValue : null;
        const verdict = formatReturn(ratio);

        const actual = document.createElement('div');
        Object.assign(actual.style, { display: 'flex', justifyContent: 'space-between', gap: '6px' });
        const actualCount = document.createElement('span');
        actualCount.textContent = formatLargeNumber(item.actualCount);
        const actualValue = document.createElement('span');
        actualValue.textContent = formatLargeNumber(Math.round(item.actualValue));
        actualValue.style.color = COLORS.good;
        actualValue.style.marginLeft = 'auto';
        const diff = document.createElement('span');
        diff.textContent = verdict.text;
        diff.style.color = verdict.color;
        diff.style.minWidth = '62px';
        diff.style.textAlign = 'right';
        actual.appendChild(actualCount);
        actual.appendChild(actualValue);
        actual.appendChild(diff);

        const expected = document.createElement('div');
        Object.assign(expected.style, {
            display: 'flex',
            justifyContent: 'space-between',
            gap: '6px',
            color: COLORS.textDim,
        });
        const expectedCount = document.createElement('span');
        // Small expectations are the interesting ones — a rare owed 0.02 of
        // itself rounds to nothing and would read as owing zero
        expectedCount.textContent =
            item.expectedCount < 10 ? item.expectedCount.toFixed(2) : formatLargeNumber(Math.round(item.expectedCount));
        const expectedValue = document.createElement('span');
        expectedValue.textContent = formatLargeNumber(Math.round(item.expectedValue));
        expectedValue.style.marginLeft = 'auto';
        const word = document.createElement('span');
        word.textContent = 'expected';
        word.style.minWidth = '62px';
        word.style.textAlign = 'right';
        expected.appendChild(expectedCount);
        expected.appendChild(expectedValue);
        expected.appendChild(word);

        columns.appendChild(actual);
        columns.appendChild(expected);
        row.appendChild(columns);
        return row;
    }

    _removePopup() {
        this._detachPopupDrag?.();
        this._detachPopupDrag = null;
        if (!this.popup) return;
        unregisterFloatingPanel(this.popup);
        this.popup.remove();
        this.popup = null;
    }

    _createPanel() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '80px',
            right: '80px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: '460px',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.panel.appendChild(this._createHeader());

        this.contentEl = document.createElement('div');
        Object.assign(this.contentEl.style, { padding: '8px 10px', overflow: 'auto', maxHeight: '520px' });
        this.panel.appendChild(this.contentEl);

        this._makeDraggable();
        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        this._render();
    }

    _createHeader() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'move',
            padding: '8px 12px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });
        this.headerEl = header;

        const title = document.createElement('span');
        title.textContent = 'Treasure';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.gap = '4px';

        const resetBtn = this._headerButton('Reset', () => {
            if (!window.confirm('Forget every chest opening recorded so far? This cannot be undone.')) return;
            this.tally = resetTally(this.tally);
            this._save();
            this._render();
        });
        resetBtn.title = 'Forget the whole ledger';
        resetBtn.style.fontSize = '11px';

        const closeBtn = this._headerButton('✕', () => this._removePanel());
        closeBtn.title = 'Close';

        buttons.appendChild(resetBtn);
        buttons.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(buttons);
        return header;
    }

    /**
     * @param {string} text - Label
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _headerButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        Object.assign(button.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 6px',
            borderRadius: '3px',
        });
        button.addEventListener('mouseover', () => (button.style.background = 'rgba(255, 207, 92, 0.15)'));
        button.addEventListener('mouseout', () => (button.style.background = 'none'));
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    _makeDraggable() {
        let offsetX = 0;
        let offsetY = 0;

        const onMouseMove = (event) => {
            if (!this.isDragging) return;
            this.panel.style.left = `${event.clientX - offsetX}px`;
            this.panel.style.right = 'auto';
            this.panel.style.top = `${event.clientY - offsetY}px`;
        };
        const onMouseUp = () => {
            this.isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        this.headerEl.addEventListener('mousedown', (event) => {
            bringPanelToFront(this.panel);
            this.isDragging = true;
            const rect = this.panel.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    _removePanel() {
        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.contentEl = null;
        this.headerEl = null;
    }

    _render() {
        if (!this.contentEl) return;
        this.contentEl.replaceChildren();

        const { rows, totals } = this._summary();
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.style.padding = '8px 2px';
            empty.textContent = 'Nothing opened yet. Open a chest and it will show up here.';
            this.contentEl.appendChild(empty);
            return;
        }

        this.contentEl.appendChild(this._totalsRow(totals));
        for (const row of rows) this.contentEl.appendChild(this._chestRow(row));
    }

    /**
     * @param {Object} totals - From `tallyTotals`
     * @returns {HTMLElement}
     */
    _totalsRow(totals) {
        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 4px 8px',
            borderBottom: `1px solid ${COLORS.border}`,
            marginBottom: '6px',
            fontWeight: 'bold',
        });

        const left = document.createElement('span');
        left.textContent = `${totals.opened} chests`;

        const right = document.createElement('span');
        const verdict = formatReturn(totals.ratio);
        right.style.color = verdict.color;
        right.textContent = `${formatLargeNumber(Math.round(totals.actualValue))} of ${formatLargeNumber(
            Math.round(totals.expectedValue)
        )} — ${verdict.text}`;

        wrapper.appendChild(left);
        wrapper.appendChild(right);
        return wrapper;
    }

    /**
     * One chest, expandable into the items behind its verdict.
     * @param {Object} row - From `summariseTally`
     * @returns {HTMLElement}
     */
    _chestRow(row) {
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '2px';

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            padding: '3px 4px',
            cursor: 'pointer',
            borderRadius: '3px',
        });
        header.addEventListener('mouseover', () => (header.style.background = 'rgba(255, 255, 255, 0.05)'));
        header.addEventListener('mouseout', () => (header.style.background = 'none'));

        const isExpanded = this.expanded.has(row.chestHrid);
        const left = document.createElement('span');
        left.textContent = `${isExpanded ? '−' : '+'} ${itemName(row.chestHrid)} ×${row.opened}`;

        const right = document.createElement('span');
        const verdict = formatReturn(row.ratio);
        right.style.color = verdict.color;
        right.style.whiteSpace = 'nowrap';
        right.textContent = `${formatLargeNumber(Math.round(row.difference))} · ${verdict.text}`;

        header.appendChild(left);
        header.appendChild(right);
        header.addEventListener('click', () => {
            if (this.expanded.has(row.chestHrid)) this.expanded.delete(row.chestHrid);
            else this.expanded.add(row.chestHrid);
            this._render();
        });

        wrapper.appendChild(header);
        if (isExpanded) wrapper.appendChild(this._itemBreakdown(row));
        return wrapper;
    }

    /**
     * The items behind a chest's verdict, which is where a shortfall turns out
     * to be one unlucky rare rather than something wrong across the board.
     * @param {Object} row - From `summariseTally`
     * @returns {HTMLElement}
     */
    _itemBreakdown(row) {
        const list = document.createElement('div');
        Object.assign(list.style, {
            padding: '2px 4px 6px 18px',
            fontSize: '12px',
            color: COLORS.textDim,
        });

        for (const item of row.items) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' });

            const name = document.createElement('span');
            name.textContent = itemName(item.itemHrid);

            const counts = document.createElement('span');
            counts.style.whiteSpace = 'nowrap';
            const expected = item.expectedCount < 10 ? item.expectedCount.toFixed(2) : Math.round(item.expectedCount);
            counts.textContent = `${formatLargeNumber(item.actualCount)} of ${expected}`;
            if (item.actualValue > item.expectedValue) counts.style.color = COLORS.good;
            else if (item.actualValue < item.expectedValue) counts.style.color = COLORS.bad;

            line.appendChild(name);
            line.appendChild(counts);
            list.appendChild(line);
        }
        return list;
    }
}

const treasureTracker = new TreasureTracker();

// Registered at module scope so the overlay has the row whether or not this
// feature has started yet. It draws nothing until a chest has been opened.
registerRow({
    key: 'treasure',
    name: 'Treasure',
    render: (container) => {
        if (!treasureTracker.isInitialized) {
            container.replaceChildren();
            return;
        }

        const { totals } = treasureTracker._summary();
        container.replaceChildren();
        if (!totals.opened) return;

        const label = document.createElement('span');
        label.textContent = `${totals.opened} chests `;

        const verdict = formatReturn(totals.ratio);
        const value = document.createElement('span');
        value.style.color = verdict.color;
        value.textContent = `${formatLargeNumber(Math.round(totals.difference))} · ${verdict.text}`;

        container.style.display = 'flex';
        container.style.justifyContent = 'space-between';
        container.style.gap = '10px';
        container.appendChild(label);
        container.appendChild(value);
    },
});

export default treasureTracker;
