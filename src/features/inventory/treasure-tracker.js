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
import settingsStorage from '../../core/settings-storage.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import {
    recordOpening,
    resetTally,
    chestPerformance,
    chestBreakdown,
    summariseTally,
    tallyTotals,
} from '../../utils/chest-tally.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, clearGeometry } from '../../utils/panel-geometry.js';
import { askChoice } from '../../utils/choice-dialog.js';
import {
    toExport,
    fromToolashaExport,
    fromTreasureExport,
    fromEdibleTools,
    findEdibleToolsData,
    mergeTally,
} from '../../utils/chest-import.js';
import { calculateDungeonTokenValue, labyrinthRewardValue } from '../../utils/token-valuation.js';

const STORAGE_KEY = 'treasureTally';
const SETTINGS_KEY = 'treasureSettings';
const PANEL_ID = 'toolasha-treasure-panel';
const POPUP_ID = 'toolasha-treasure-popup';
/** Where each of the two is remembered; they are moved and sized independently */
const PANEL_GEOMETRY_KEY = 'treasurePanel';
const POPUP_GEOMETRY_KEY = 'treasurePopup';
/** What the ledger opens at before anyone has resized it */
const DEFAULT_PANEL = { width: 720, height: 560 };
/** The game's own dialog, which the popup wants to sit beside */
const LOOT_DIALOG_SELECTOR = '[class*="Modal_modal"]:not([class*="Modal_modalContainer"])';
/** Gap between the two, and how far off a screen edge the popup may not go */
const DIALOG_GAP = 12;
const EDGE_MARGIN = 8;
/**
 * The dialog is rendered by React in response to the same message that brings us
 * the loot, so it is reliably absent at the moment we are told about it. These
 * bound how long to keep looking.
 */
const DIALOG_TRIES = 12;
const DIALOG_RETRY_MS = 60;

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
 * How to value an item the market will not price.
 *
 * Capes, quivers and cloaks are untradable, so there is no market answer and any
 * figure is a judgement. `token` prices one at what its tokens would otherwise
 * have bought, `mirror` at a Mirror of Protection, `zero` says it is worth
 * nothing to you. The choice moves a chest's verdict a long way, which is why it
 * is a setting rather than a constant.
 */
const CAPE_VALUE_CYCLE = { token: 'mirror', mirror: 'zero', zero: 'token' };
const CAPE_VALUE_LABEL = { token: 'Token value', mirror: 'Mirror value', zero: 'No value' };

const MIRROR_HRID = '/items/mirror_of_protection';
const COWBELL_HRID = '/items/cowbell';
const COWBELL_BAG_HRID = '/items/bag_of_10_cowbells';
const COWBELLS_PER_BAG = 10;
/** The bag's own market tax, which you pay to turn cowbells into coins */
const COWBELL_BAG_TAX = 0.18;

const DEFAULT_SETTINGS = { capeValue: 'token', valueCowbells: true, hiddenChests: [], popupPinned: false };

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

/**
 * A count small enough that rounding it would say the wrong thing.
 *
 * A rare owed 0.002 of itself per chest rounds to zero, which reads as the chest
 * owing you nothing rather than a one-in-five-hundred chance.
 *
 * @param {number} count - Expected count
 * @returns {string} Readable count
 */
export function smallCount(count) {
    if (count >= 10) return formatLargeNumber(Math.round(count));
    if (count >= 1) return count.toFixed(2);
    if (count >= 0.001) return count.toFixed(3);
    return count.toExponential(1);
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
        this._dialogRetry = null;
        this.settings = { ...DEFAULT_SETTINGS };
        this.configMode = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('treasureTracker')) return;
        this.isInitialized = true;

        this.tally = (await storage.getJSON(STORAGE_KEY, 'settings', {})) || {};
        const saved = await storage.getJSON(SETTINGS_KEY, 'settings', null);
        if (saved) this.settings = { ...DEFAULT_SETTINGS, ...saved };

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

        // Size is always remembered; where it goes is not, unless you have moved
        // it. Auto-placement is the whole point of this popup, and a remembered
        // position would silently switch that off the first time you nudged it
        // out of the way — so only a deliberate drag pins it, and only a pinned
        // popup has a position stored to restore.
        //
        // Placed after the size is back rather than before, because placement
        // measures the popup and a width applied afterwards would move the edge
        // it was measured against.
        restoreGeometry(this.popup, POPUP_GEOMETRY_KEY, { width: 260, height: 120 }).then(() => {
            if (!this.settings.popupPinned) this._placeBesideDialog(0);
        });
    }

    /**
     * Put the popup beside the game's Opened Loot dialog.
     *
     * The two are read together — the game's counts on the left, whether they
     * were good on the right — so a popup pinned to a screen corner makes you
     * look back and forth across the whole window.
     *
     * Measured after mounting, because the height depends on how many items the
     * chest paid out — and retried, because the dialog is rendered from the same
     * message that brings us the loot and is reliably not there yet on the first
     * look. Falls back to the top-right corner once the retries run out, which
     * is what happens when a chest is opened by a route that raises no dialog.
     *
     * @param {number} tries - How many attempts have been made
     */
    _placeBesideDialog(tries) {
        if (!this.popup) return;

        const dialog = document.querySelector(LOOT_DIALOG_SELECTOR);
        // Not up yet — the message that told us about the loot is the same one
        // React is still rendering the dialog from
        if (!dialog || !dialog.getBoundingClientRect().width) {
            if (tries >= DIALOG_TRIES) return;
            const retry = setTimeout(() => this._placeBesideDialog(tries + 1), DIALOG_RETRY_MS);
            this._dialogRetry = retry;
            return;
        }

        const anchor = dialog.getBoundingClientRect();
        const self = this.popup.getBoundingClientRect();
        if (!self.width) return;

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

    /** Open if closed, close if open */
    toggle() {
        if (this.panel && document.body.contains(this.panel)) this._removePanel();
        else this.show();
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
        return (itemHrid) => {
            // Coins are the base currency and never appear on the market
            if (itemHrid === '/items/coin') return 1;
            if (itemHrid === COWBELL_HRID) return this._cowbellValue();

            const market = getItemPrice(itemHrid, { context: 'profit', side: 'sell' });
            if (market > 0) return market;

            // No market answer: an untradable reward, which is a judgement call
            return this._untradableValue(itemHrid);
        };
    }

    /**
     * What a cowbell is worth, if anything.
     *
     * Cowbells are not tradable; bags of ten are. So the value of one is a bag's
     * price less the tax you pay selling it, split ten ways — the same route
     * `expected-value-calculator.js` takes.
     *
     * @returns {number|null} Coins per cowbell, or null when they are not counted
     */
    _cowbellValue() {
        if (!this.settings.valueCowbells) return null;

        const bag = getItemPrice(COWBELL_BAG_HRID, { context: 'profit', side: 'sell' });
        if (!(bag > 0)) return null;
        return (bag * (1 - COWBELL_BAG_TAX)) / COWBELLS_PER_BAG;
    }

    /**
     * What an untradable reward is worth, under the current setting.
     *
     * Read from the game's own shop data rather than a hardcoded price list, so
     * a shop change does not quietly leave the figure a version behind.
     *
     * @param {string} itemHrid - The item
     * @returns {number|null} A value, or null to leave it out of the comparison
     */
    _untradableValue(itemHrid) {
        const mode = this.settings.capeValue;
        if (mode === 'zero') return null;
        if (mode === 'mirror') return getItemPrice(MIRROR_HRID, { context: 'profit', side: 'sell' }) || null;

        // Token value: what the tokens it costs would otherwise have bought
        const data = dataManager.getInitClientData();
        const shop = data?.shopItemDetailMap || {};
        const entry = Object.values(shop).find((item) => item.itemHrid === itemHrid);
        const cost = entry?.costs?.[0];

        if (cost?.count) {
            const perToken = calculateDungeonTokenValue(cost.itemHrid);
            return perToken > 0 ? perToken * cost.count : null;
        }

        // The labyrinth keeps its own shop under its own map, and the scrolls a
        // combat chest drops are in it and nowhere else. Without this they price
        // at nothing and vanish from the contents rather than showing a value —
        // which is what "the ported Treasure is missing the scrolls" was.
        return labyrinthRewardValue(itemHrid, data?.labyrinthShopItemDetailMap, (hrid) =>
            getItemPrice(hrid, { context: 'profit', side: 'sell' })
        );
    }

    _saveSettings() {
        storage.setJSON(SETTINGS_KEY, this.settings, 'settings').catch((error) => {
            console.error('[TreasureTracker] Saving treasure settings failed:', error);
        });
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
        // Scrolls rather than grows, so a chest that paid out twenty items does
        // not make a popup taller than the window
        Object.assign(body.style, { padding: '8px 11px 10px', flex: '1', overflow: 'auto', minHeight: '0' });
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

        // Moving it is what pins it. Nothing else in the popup says "stay here",
        // and a dedicated pin button would be a control most people never need.
        this._detachPopupDrag = makeDraggable(popup, header, (position) => {
            this.settings.popupPinned = true;
            this._saveSettings();
            saveGeometry(POPUP_GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this._detachPopupResize = makeResizable(popup, {
            minWidth: 260,
            minHeight: 120,
            onResize: (size) => saveGeometry(POPUP_GEOMETRY_KEY, size),
        });
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
        clearTimeout(this._dialogRetry);
        this._dialogRetry = null;
        this._detachPopupDrag?.();
        this._detachPopupDrag = null;
        this._detachPopupResize?.();
        this._detachPopupResize = null;
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
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
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
        Object.assign(this.contentEl.style, { padding: '8px 10px', overflow: 'auto', flex: '1' });
        this.panel.appendChild(this.contentEl);

        this._detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(PANEL_GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this._detachResize = makeResizable(this.panel, {
            minWidth: 420,
            minHeight: 200,
            onResize: (size) => saveGeometry(PANEL_GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, PANEL_GEOMETRY_KEY, { width: 420, height: 200 });
        this._render();
    }

    _createHeader() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });
        this.headerEl = header;

        const title = document.createElement('span');
        title.textContent = 'Treasure';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;
        title.style.marginRight = '4px';

        // Both toggles change what every figure in the panel means, so they sit
        // in the header showing their current state rather than hidden behind
        // the gear
        this.capeBtn = this._toggleButton(
            () => CAPE_VALUE_LABEL[this.settings.capeValue],
            'Untradable rewards — capes, quivers, cloaks — have no market price. ' +
                'Value them at what their tokens would have bought, at a Mirror of Protection, or at nothing.',
            () => {
                this.settings.capeValue = CAPE_VALUE_CYCLE[this.settings.capeValue] || 'token';
                this._saveSettings();
                this._refreshToggles();
                this._render();
            }
        );

        this.cowbellBtn = this._toggleButton(
            () => (this.settings.valueCowbells ? 'Cowbells counted' : 'Cowbells at zero'),
            'Cowbells are not tradable; bags of ten are. Counted, one is worth a bag less tax, split ten ways.',
            () => {
                this.settings.valueCowbells = !this.settings.valueCowbells;
                this._saveSettings();
                this._refreshToggles();
                this._render();
            }
        );

        const gear = this._headerButton('⚙', () => {
            this.configMode = !this.configMode;
            gear.style.background = this.configMode ? 'rgba(255, 207, 92, 0.25)' : 'none';
            this._render();
        });
        gear.title = 'Show or hide chests, and import or export your history';

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const closeBtn = this._headerButton('✕', () => this._removePanel());
        closeBtn.title = 'Close';

        header.append(title, this.capeBtn, this.cowbellBtn, gear, spacer, closeBtn);
        this._refreshToggles();
        return header;
    }

    /**
     * A header control that shows what it is currently set to.
     *
     * The label is a function rather than a string because these are cycled
     * rather than pressed, and a button that does not say where it landed leaves
     * you clicking through to find out.
     *
     * @param {Function} label - Returns the current label
     * @param {string} title - Hover explanation
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _toggleButton(label, title, onClick) {
        const button = document.createElement('button');
        button.title = title;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '2px 7px',
            whiteSpace: 'nowrap',
        });
        button._label = label;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /** Put the current setting back on the face of each toggle */
    _refreshToggles() {
        for (const button of [this.capeBtn, this.cowbellBtn]) {
            if (!button?._label) continue;
            button.textContent = button._label();
            // Dimmed when the setting means "count this as nothing", so the
            // panel says at a glance that something is being left out
            const counting = !/zero|No value/.test(button.textContent);
            button.style.color = counting ? COLORS.accent : COLORS.textDim;
            button.style.opacity = counting ? '1' : '0.7';
        }
    }

    /**
     * The gear panel: which chests to show, and moving history in or out.
     * @returns {HTMLElement}
     */
    _configSection() {
        const section = document.createElement('div');
        Object.assign(section.style, {
            padding: '7px 8px',
            marginBottom: '6px',
            background: 'rgba(255, 207, 92, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '4px',
        });

        const hint = document.createElement('div');
        hint.textContent = 'Click 👁 to show or hide a chest. Hidden chests are still tracked.';
        hint.style.color = COLORS.accent;
        hint.style.marginBottom = '6px';
        hint.style.fontSize = '11px';
        section.appendChild(hint);

        const buttons = document.createElement('div');
        Object.assign(buttons.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });

        buttons.appendChild(this._actionButton('Export', () => this._exportHistory()));
        buttons.appendChild(this._actionButton('Import', () => this._importHistory()));
        buttons.appendChild(this._actionButton('Import from Edible Tools', () => this._importEdibleTools()));

        // Only offered once there is something to undo — a control that does
        // nothing most of the time is a control you learn to ignore
        if (this.settings.popupPinned) {
            buttons.appendChild(
                this._actionButton('Unpin popup', () => {
                    this.settings.popupPinned = false;
                    this._saveSettings();
                    clearGeometry(POPUP_GEOMETRY_KEY);
                    this._render();
                })
            );
        }

        const wipe = this._actionButton('Delete all history', async () => {
            const confirmed = await askChoice({
                title: 'Delete all chest history',
                message: 'Every chest opening recorded so far. This cannot be undone.',
                choices: [
                    { value: 'delete', label: 'Delete everything', tone: 'danger' },
                    { value: null, label: 'Cancel' },
                ],
            });
            if (!confirmed) return;

            this.tally = resetTally(this.tally);
            this._save();
            this._render();
        });
        wipe.style.color = COLORS.bad;
        wipe.style.marginLeft = 'auto';
        buttons.appendChild(wipe);

        section.appendChild(buttons);
        return section;
    }

    /**
     * @param {string} text - Label
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _actionButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '3px 8px',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /** Write the ledger to a file */
    _exportHistory() {
        try {
            const file = toExport(this.tally, this.settings, settingsStorage.currentCharacterName || '');
            const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `toolasha-treasure-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('[TreasureTracker] Export failed:', error);
            window.alert('Could not write the export file.');
        }
    }

    /** Read a ledger from a file, ours or TReasure's */
    _importHistory() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                const json = JSON.parse(await file.text());
                // Ours first, since a TReasure file is anything with chests and
                // ours would otherwise be read by the looser reader
                const read = fromToolashaExport(json) || fromTreasureExport(json);
                if (!read) {
                    window.alert('That file is not a Toolasha or TReasure chest export.');
                    return;
                }

                const chests = Object.keys(read.tally).length;
                const mode = await this._askImportMode(`Import ${chests} chest${chests === 1 ? '' : 's'}.`);
                if (!mode) return;

                this.tally = mergeTally(this.tally, read.tally, mode);
                if (Object.keys(read.settings || {}).length) {
                    this.settings = { ...this.settings, ...read.settings };
                    this._saveSettings();
                    this._refreshToggles();
                }
                this._save();
                this._render();
            } catch (error) {
                console.error('[TreasureTracker] Import failed:', error);
                window.alert('Could not read that file.');
            }
        });
        input.click();
    }

    /**
     * Ask what to do with an imported ledger.
     *
     * Three answers, and three buttons. Squeezing them into OK and Cancel means a
     * sentence explaining which is which, which has to be read twice and can
     * still be read wrong — and reading it wrong overwrites a history that took
     * months to accumulate.
     *
     * @param {string} message - What is about to be imported
     * @returns {Promise<string|null>} `'append'`, `'replace'`, or null to do nothing
     */
    async _askImportMode(message) {
        return askChoice({
            title: 'Import chest history',
            message,
            choices: [
                { value: 'append', label: 'Add', hint: 'Add these counts to what you already have', tone: 'primary' },
                {
                    value: 'replace',
                    label: 'Replace',
                    hint: 'Throw away your history and use the file',
                    tone: 'danger',
                },
                { value: null, label: 'Cancel', hint: 'Leave your history alone' },
            ],
        });
    }

    /** Read Edible Tools' chest history out of its own storage */
    async _importEdibleTools() {
        try {
            const raw = window.localStorage.getItem('Edible_Tools');
            if (!raw) {
                window.alert('No Edible Tools data found in this browser.');
                return;
            }

            const found = findEdibleToolsData(
                JSON.parse(raw),
                dataManager.getCurrentCharacterId?.(),
                settingsStorage.currentCharacterName
            );
            if (!found) {
                window.alert('Edible Tools is installed, but has no chest history for this character.');
                return;
            }

            // It keys everything by display name, so the translation needs an
            // index built from the game data as it stands today
            const itemDetails = dataManager.getInitClientData()?.itemDetailMap || {};
            const nameToHrid = {};
            for (const [hrid, detail] of Object.entries(itemDetails)) {
                if (detail?.name) nameToHrid[detail.name] = hrid;
            }

            const { tally, unmatched } = fromEdibleTools(found, nameToHrid);
            const chests = Object.keys(tally).length;
            if (!chests) {
                window.alert('None of the Edible Tools entries matched an item this game knows about.');
                return;
            }

            const warning = unmatched.length
                ? `\n\n${unmatched.length} name${unmatched.length === 1 ? '' : 's'} could not be matched and will be left out:\n` +
                  unmatched.slice(0, 8).join(', ')
                : '';
            const mode = await this._askImportMode(
                `Import ${chests} chest${chests === 1 ? '' : 's'} from Edible Tools.${warning}`
            );
            if (!mode) return;

            this.tally = mergeTally(this.tally, tally, mode);
            this._save();
            this._render();
        } catch (error) {
            console.error('[TreasureTracker] Edible Tools import failed:', error);
            window.alert('Could not read the Edible Tools data.');
        }
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

    _removePanel() {
        this._detachDrag?.();
        this._detachDrag = null;
        this._detachResize?.();
        this._detachResize = null;
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
            // Reached only before the game's data has loaded — the list is
            // every chest in the game, not only the ones you have opened
            empty.textContent = 'Waiting for the game to send its chest data…';
            this.contentEl.appendChild(empty);
            return;
        }

        if (this.configMode) this.contentEl.appendChild(this._configSection());
        this.contentEl.appendChild(this._totalsRow(totals));

        const hidden = new Set(this.settings.hiddenChests || []);
        for (const row of rows) {
            // Hidden chests stay in the ledger and in the totals; they are only
            // kept off a list that would otherwise be forty rows long
            if (!this.configMode && hidden.has(row.chestHrid)) continue;
            this.contentEl.appendChild(this._chestRow(row, hidden.has(row.chestHrid)));
        }
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
        left.textContent = totals.opened ? `${totals.opened} chests opened` : 'Nothing opened yet';

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
     * One chest: a header that reads like the game's own item lines, and the
     * three-column breakdown underneath when expanded.
     *
     * @param {Object} row - From `summariseTally`
     * @param {boolean} isHidden - Whether it is currently hidden from the list
     * @returns {HTMLElement}
     */
    _chestRow(row, isHidden = false) {
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '2px';

        const untouched = !row.opened;

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '4px 5px',
            cursor: 'pointer',
            borderRadius: '3px',
            background: 'rgba(255, 255, 255, 0.03)',
        });
        header.addEventListener('mouseover', () => (header.style.background = 'rgba(255, 255, 255, 0.08)'));
        header.addEventListener('mouseout', () => (header.style.background = 'rgba(255, 255, 255, 0.03)'));

        const isExpanded = this.expanded.has(row.chestHrid);
        const caret = this._span(isExpanded ? '−' : '+');
        caret.style.color = COLORS.accent;
        caret.style.width = '9px';

        const name = document.createElement('span');
        name.style.fontWeight = 'bold';
        name.append(itemName(row.chestHrid) + ' ');
        // What one chest is worth on average, beside its name — the figure the
        // rest of the row is measured against
        const ev = this._span(`(${formatLargeNumber(Math.round(row.perChestValue))})`);
        ev.style.color = COLORS.textDim;
        ev.style.fontWeight = 'normal';
        name.appendChild(ev);

        const count = this._span(row.opened ? `×${row.opened}` : '');
        count.style.color = COLORS.textDim;
        count.style.marginLeft = 'auto';

        const verdict = formatReturn(row.ratio);
        const diff = this._span(verdict.text);
        diff.style.color = verdict.color;
        diff.style.minWidth = '58px';
        diff.style.textAlign = 'right';

        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        Object.assign(reset.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '1px 6px',
        });
        reset.title = `Forget every ${itemName(row.chestHrid)} opening`;
        reset.addEventListener('click', (event) => {
            // Without this the click also toggles the row it sits in
            event.stopPropagation();
            if (!window.confirm(`Forget all ${row.opened} ${itemName(row.chestHrid)} openings?`)) return;
            this.tally = resetTally(this.tally, row.chestHrid);
            this._save();
            this._render();
        });

        // A chest you have never opened has no verdict to show and nothing to
        // reset; it is here to be looked up, so it is dimmed rather than
        // decorated with empty controls
        if (untouched) {
            header.style.opacity = '0.65';
            header.append(caret, this._icon(row.chestHrid, 16), name, count);
        } else {
            header.append(caret, this._icon(row.chestHrid, 16), name, count, diff, reset);
        }

        if (this.configMode) {
            header.style.opacity = isHidden ? '0.45' : '1';
            header.appendChild(this._visibilityButton(row.chestHrid, isHidden));
        }

        header.addEventListener('click', () => {
            // In config mode the row is a thing to show or hide, not to expand
            if (this.configMode) return;
            if (this.expanded.has(row.chestHrid)) this.expanded.delete(row.chestHrid);
            else this.expanded.add(row.chestHrid);
            this._render();
        });

        wrapper.appendChild(header);
        if (isExpanded && !this.configMode) wrapper.appendChild(this._itemBreakdown(row));
        return wrapper;
    }

    /**
     * The eye that shows or hides one chest.
     *
     * Hiding only affects the list. The chest is still tracked and still counted
     * in the totals — a hidden chest that stopped being recorded would make the
     * ledger quietly wrong rather than merely shorter.
     *
     * @param {string} chestHrid - The chest
     * @param {boolean} isHidden - Its current state
     * @returns {HTMLButtonElement}
     */
    _visibilityButton(chestHrid, isHidden) {
        const button = document.createElement('button');
        button.textContent = isHidden ? '🚫' : '👁';
        button.title = isHidden ? 'Show this chest in the list' : 'Hide this chest from the list';
        Object.assign(button.style, {
            background: isHidden ? 'rgba(120, 60, 60, 0.35)' : 'rgba(60, 140, 90, 0.35)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 6px',
            marginLeft: '6px',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const hidden = new Set(this.settings.hiddenChests || []);
            if (hidden.has(chestHrid)) hidden.delete(chestHrid);
            else hidden.add(chestHrid);

            this.settings = { ...this.settings, hiddenChests: [...hidden] };
            this._saveSettings();
            this._render();
        });
        return button;
    }

    /**
     * The three views of one chest, side by side.
     *
     * Last opening, every opening, and what was owed — read across a row rather
     * than down a column, because the question is always "how does this compare
     * with that" and one column alone cannot answer it. The item order is shared
     * by all three, so a row means the same item in each.
     *
     * @param {Object} row - From `summariseTally`, carrying the chest hrid
     * @returns {HTMLElement}
     */
    _itemBreakdown(row) {
        const dropTable = dataManager.getInitClientData()?.openableLootDropMap?.[row.chestHrid];
        const { last, total, items } = chestBreakdown(this.tally[row.chestHrid], dropTable, this._priceOf());

        const wrap = document.createElement('div');
        Object.assign(wrap.style, {
            padding: '5px 5px 8px',
            background: 'rgba(0, 0, 0, 0.25)',
            borderRadius: '0 0 3px 3px',
            // Every figure is a number in a column; proportional digits make
            // columns of them jitter as the values change
            fontVariantNumeric: 'tabular-nums',
        });

        wrap.appendChild(
            this._headerBand([
                `LAST (×${last.opened || 0})`,
                `TOTAL (×${total.opened})`,
                `EXPECTED (×1 / ×${total.opened})`,
            ])
        );
        wrap.appendChild(this._summaryBand(last, total));

        for (const item of items) wrap.appendChild(this._breakdownRow(item));
        return wrap;
    }

    /**
     * @param {string[]} titles - Three column titles
     * @returns {HTMLElement}
     */
    _headerBand(titles) {
        const band = this._threeColumns();
        Object.assign(band.style, { fontSize: '10px', fontWeight: 'bold', color: '#7fb3ff', padding: '1px 0' });
        for (const title of titles) {
            const cell = document.createElement('div');
            cell.textContent = title;
            cell.style.textAlign = 'center';
            band.appendChild(cell);
        }
        return band;
    }

    /**
     * The verdict under each column title.
     * @param {Object} last - Performance of the last opening
     * @param {Object} total - Performance of every opening
     * @returns {HTMLElement}
     */
    _summaryBand(last, total) {
        const band = this._threeColumns();
        Object.assign(band.style, {
            fontSize: '11px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '4px',
            marginBottom: '3px',
        });

        const cells = [
            { value: last.actualValue, ratio: last.ratio },
            { value: total.actualValue, ratio: total.ratio },
            { value: total.expectedValue, ratio: null },
        ];
        for (const { value, ratio } of cells) {
            const verdict = formatReturn(ratio);
            const cell = document.createElement('div');
            cell.style.textAlign = 'center';
            cell.style.color = ratio === null ? COLORS.textDim : verdict.color;
            cell.textContent =
                ratio === null
                    ? formatLargeNumber(Math.round(value))
                    : `${formatLargeNumber(Math.round(value))} (${verdict.text})`;
            band.appendChild(cell);
        }
        return band;
    }

    /**
     * The outer three-column frame every band shares, so the titles, the summary
     * and every item line stack in the same places.
     * @returns {HTMLElement}
     */
    _threeColumns() {
        const el = document.createElement('div');
        Object.assign(el.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1.35fr',
            gap: '10px',
            alignItems: 'center',
        });
        return el;
    }

    /**
     * One item across all three columns.
     * @param {Object} item - From `chestBreakdown`
     * @returns {HTMLElement}
     */
    _breakdownRow(item) {
        const rowEl = this._threeColumns();
        Object.assign(rowEl.style, { fontSize: '11px', padding: '1px 0' });

        rowEl.appendChild(this._actualCell(item, item.lastCount, item.lastValue, item.lastRatio));
        rowEl.appendChild(this._actualCell(item, item.totalCount, item.totalValue, item.totalRatio));
        rowEl.appendChild(this._expectedCell(item));
        return rowEl;
    }

    /**
     * What dropped, what it was worth, and how that compares.
     *
     * A fixed sub-grid rather than flex, so counts, values and percentages line
     * up down the column instead of drifting with the width of the number above.
     *
     * @param {Object} item - The item, for its icon
     * @param {number} count - What dropped
     * @param {number} value - What it was worth
     * @param {number|null} ratio - Against expectation
     * @returns {HTMLElement}
     */
    _actualCell(item, count, value, ratio) {
        const cell = document.createElement('div');
        Object.assign(cell.style, {
            display: 'grid',
            gridTemplateColumns: '15px 1fr 1fr 54px',
            gap: '4px',
            alignItems: 'center',
        });

        const verdict = formatReturn(ratio);
        const countEl = this._span(formatLargeNumber(count));
        const valueEl = this._span(value > 0 ? formatLargeNumber(Math.round(value)) : '');
        valueEl.style.color = COLORS.good;
        valueEl.style.textAlign = 'right';
        const diffEl = this._span(ratio === null ? '' : verdict.text);
        diffEl.style.color = verdict.color;
        diffEl.style.textAlign = 'right';

        cell.append(this._icon(item.itemHrid, 13), countEl, valueEl, diffEl);
        return cell;
    }

    /**
     * What one chest owed, and what the whole run owed.
     * @param {Object} item - From `chestBreakdown`
     * @returns {HTMLElement}
     */
    _expectedCell(item) {
        const cell = document.createElement('div');
        Object.assign(cell.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 8px 1fr 1fr',
            gap: '4px',
            alignItems: 'center',
            color: COLORS.textDim,
        });

        const perChest = this._span(smallCount(item.expectedPerChest));
        const perChestValue = this._span(formatLargeNumber(Math.round(item.expectedPerChestValue)));
        perChestValue.style.textAlign = 'right';
        const divider = this._span('|');
        divider.style.textAlign = 'center';
        const overall = this._span(smallCount(item.expectedTotal));
        overall.style.textAlign = 'right';
        const overallValue = this._span(formatLargeNumber(Math.round(item.expectedTotalValue)));
        overallValue.style.textAlign = 'right';

        cell.append(perChest, perChestValue, divider, overall, overallValue);
        return cell;
    }

    /**
     * @param {string} text - Content
     * @returns {HTMLElement}
     */
    _span(text) {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.whiteSpace = 'nowrap';
        span.style.overflow = 'hidden';
        span.style.textOverflow = 'ellipsis';
        return span;
    }
}

const treasureTracker = new TreasureTracker();

// Registered at module scope so the overlay has the row whether or not this
// feature has started yet. It draws nothing until a chest has been opened.
registerRow({
    key: 'treasure',
    name: 'Treasure',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        if (!treasureTracker.isInitialized) return blank(container);

        const { totals } = treasureTracker._summary();
        if (!totals.opened) return blank(container);

        const verdict = formatReturn(totals.ratio);
        row(container, [
            { text: '🎁' },
            { text: `${formatLargeNumber(totals.opened)} chests`, color: ROW_COLORS.dim },
            { text: verdict.text, color: verdict.color, bold: true, push: true },
        ]);
        container.title = `${formatLargeNumber(Math.round(totals.difference))} against expectation over every chest opened.`;
    },
    onOpen: () => treasureTracker.toggle(),
});

export default treasureTracker;
