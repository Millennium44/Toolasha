/**
 * Mooket Live Price Check
 *
 * A button in the marketplace item view that asks the pooled Mooket dataset
 * whether it has seen the item's book more recently than the game's own price
 * feed has.
 *
 * The game publishes `marketplace.json` roughly once an hour, at no fixed
 * minute, so the price it quotes can be most of an hour stale with no way to
 * tell from the number itself. The Mooket pool is fed continuously by every
 * client that opens an item, so for anything people are actually looking at its
 * newest sighting can be minutes old. That is not guaranteed — a book nobody has
 * opened lately is older in the pool than in the snapshot — so this shows both
 * readings and how old each is, and marks whichever is fresher rather than
 * declaring one the truth.
 *
 * Reading the pool means telling a third-party server which item you looked up,
 * which is the same cost the price-history panel pays, so this rides the same
 * `market_pooledHistory` switch and does nothing until it is on.
 */

import config from '../../../core/config.js';
import marketAPI from '../../../api/marketplace.js';
import { GAME } from '../../../utils/selectors.js';
import { createCleanupRegistry } from '../../../utils/cleanup-registry.js';
import { formatWithSeparator, formatRelativeTime } from '../../../utils/formatters.js';
import marketHistoryAPI from './market-history-api.js';

const CONTAINER_ID = 'mwi-mooket-live-check';
/** The marketplace re-renders as prices tick; this keeps up with a person clicking */
const POLL_MS = 500;

/**
 * The newest sighting in a set of history rows.
 *
 * A row carries best ask (`a`), best bid (`b`) and a time; a non-positive side
 * means nothing was resting there, not a price of zero, so it becomes null. Kept
 * pure so the pick-the-freshest logic can be tested without a server.
 *
 * @param {Array<Object>|null} rows - Rows from the history API
 * @returns {{time: number, ask: number|null, bid: number|null}|null} Freshest, or null
 */
export function freshestSighting(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;

    let best = null;
    for (const row of rows) {
        const time = rowTimeMs(row);
        if (!time) continue;
        if (!best || time > best.time) {
            best = {
                time,
                ask: row?.a > 0 ? row.a : null,
                bid: row?.b > 0 ? row.b : null,
            };
        }
    }
    return best;
}

/**
 * A row's timestamp in milliseconds. The server writes seconds since the epoch
 * as a number, or occasionally a parseable date string.
 * @param {Object} row - History row
 * @returns {number} Milliseconds, or 0 when unreadable
 */
function rowTimeMs(row) {
    if (typeof row?.time === 'number') return row.time * 1000;
    const parsed = new Date(row?.time).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Which of the two readings is the more recent.
 *
 * A missing age is treated as "no reading", so the side that has one wins; with
 * neither there is nothing to mark. Pure, for testing.
 *
 * @param {number|null} gameAgeMs - Age of the game snapshot
 * @param {number|null} mooketAgeMs - Age of the Mooket sighting
 * @returns {'game'|'mooket'|null} The fresher side, or null when it cannot be judged
 */
export function fresherSide(gameAgeMs, mooketAgeMs) {
    const hasGame = typeof gameAgeMs === 'number' && gameAgeMs >= 0;
    const hasMooket = typeof mooketAgeMs === 'number' && mooketAgeMs >= 0;
    if (hasGame && hasMooket) return mooketAgeMs < gameAgeMs ? 'mooket' : 'game';
    if (hasMooket) return 'mooket';
    if (hasGame) return 'game';
    return null;
}

class MooketLivePriceCheck {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.container = null;
        this.button = null;
        this.result = null;
        /** The item the result under the button is describing, so a switch clears it */
        this.shownKey = null;
    }

    initialize() {
        if (this.isInitialized) return;
        // Same third-party read as the history panel, so the same switch governs it
        if (!config.getSetting('market_pooledHistory')) return;
        this.isInitialized = true;

        const poll = setInterval(() => this.followMarketplace(), POLL_MS);
        this.cleanupRegistry.registerInterval(poll);
        this.followMarketplace();
    }

    cleanup() {
        this.container?.remove();
        this.container = null;
        this.button = null;
        this.result = null;
        this.shownKey = null;
        this.cleanupRegistry.cleanup();
        this.isInitialized = false;
    }

    /**
     * Keep the button sitting under whichever item the marketplace is showing,
     * and clear a stale reading when that item changes.
     */
    followMarketplace() {
        if (document.hidden) return;

        const panel = document.querySelector(GAME.MARKETPLACE_PANEL);
        const currentItem = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const visible = !!(panel && panel.getClientRects().length && currentItem);

        if (!visible) {
            this.container?.remove();
            this.container = null;
            return;
        }

        if (!this.container || !this.container.isConnected) this.buildContainer();

        // Parked as the item block's next sibling. The marketplace rebuilds the
        // block on a re-render, so this puts it back rather than assuming it held.
        if (currentItem.nextElementSibling !== this.container) {
            currentItem.insertAdjacentElement('afterend', this.container);
        }

        const item = this.readCurrentItem(currentItem);
        const key = item ? `${item.itemHrid}:${item.enhancementLevel}` : null;
        if (key !== this.shownKey) {
            this.shownKey = key;
            this.clearResult();
        }
    }

    buildContainer() {
        const container = document.createElement('div');
        container.id = CONTAINER_ID;
        container.style.cssText =
            'display:flex; flex-direction:column; gap:4px; padding:4px 6px; align-items:flex-start;';

        const button = document.createElement('button');
        button.textContent = '⧉ Check Mooket price';
        button.title =
            'Ask the pooled Mooket dataset for the newest sighting of this item and compare it with the ' +
            "game's hourly price snapshot. Reads a third-party server (the same one the price history panel uses).";
        button.style.cssText =
            'background:rgba(255,255,255,0.08); border:1px solid #4a5a8a; color:#e7e7e7; ' +
            'border-radius:3px; cursor:pointer; font-size:12px; line-height:1; padding:4px 8px;';
        button.addEventListener('click', () => this.runCheck());
        container.appendChild(button);

        const result = document.createElement('div');
        result.style.cssText = 'font-size:12px; line-height:1.4; color:#c8cee0; white-space:pre;';
        container.appendChild(result);

        this.container = container;
        this.button = button;
        this.result = result;
    }

    /**
     * The item the marketplace is currently showing.
     * @param {HTMLElement} currentItem - The current-item block
     * @returns {{itemHrid: string, enhancementLevel: number}|null}
     */
    readCurrentItem(currentItem) {
        const use = currentItem?.querySelector('svg use');
        const iconName = use?.href?.baseVal?.split('#')[1];
        if (!iconName) return null;

        const badge = currentItem.querySelector('[class*="Item_enhancementLevel"]');
        const enhancementLevel = Number(badge?.textContent?.replace('+', '')) || 0;
        return { itemHrid: `/items/${iconName}`, enhancementLevel };
    }

    /** Empty the reading under the button. */
    clearResult() {
        if (this.result) this.result.textContent = '';
    }

    /** @param {string} text - A one-line status shown in place of a reading */
    showMessage(text) {
        if (!this.result) return;
        this.result.textContent = text;
        this.result.style.color = '#9aa4c0';
    }

    /**
     * The game's own `marketplace.json` reading for an item, with how stale it is.
     *
     * Deliberately the raw snapshot rather than {@link marketAPI.getPrice}, which
     * would hand back a fresher order-book patch and defeat the comparison: the
     * point is what the game's hourly feed says on its own.
     *
     * @param {string} itemHrid - Item
     * @param {number} level - Enhancement level
     * @returns {{ask: number|null, bid: number|null, ageMs: number|null}|null}
     */
    gameSnapshot(itemHrid, level) {
        const raw = marketAPI.marketData?.[itemHrid]?.[level];
        if (!raw) return null;
        const norm = (value) => (typeof value === 'number' && value >= 0 ? value : null);
        return { ask: norm(raw.a), bid: norm(raw.b), ageMs: marketAPI.getDataAge() };
    }

    async runCheck() {
        const currentItem = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const item = this.readCurrentItem(currentItem);
        if (!item) {
            this.showMessage('No item selected.');
            return;
        }

        this.showMessage('Checking Mooket…');
        try {
            const rows = await marketHistoryAPI.fetchHistory(item.itemHrid, item.enhancementLevel, 1);
            const mooket = freshestSighting(rows);
            const game = this.gameSnapshot(item.itemHrid, item.enhancementLevel);
            this.renderResult(game, mooket);
        } catch (error) {
            console.error('[MooketLiveCheck] Checking live price failed:', error);
            this.showMessage('Mooket check failed.');
        }
    }

    /**
     * Draw the two readings and mark the fresher one.
     * @param {{ask: number|null, bid: number|null, ageMs: number|null}|null} game - Game snapshot
     * @param {{time: number, ask: number|null, bid: number|null}|null} mooket - Freshest Mooket sighting
     */
    renderResult(game, mooket) {
        if (!this.result) return;
        this.result.textContent = '';
        this.result.style.color = '#c8cee0';

        if (!game && !mooket) {
            this.showMessage('No price data from either source.');
            return;
        }

        const mooketAgeMs = mooket ? Math.max(0, Date.now() - mooket.time) : null;
        const gameAgeMs = game ? game.ageMs : null;
        const fresher = fresherSide(gameAgeMs, mooketAgeMs);

        this.result.appendChild(this.priceLine('Game', game?.ask, game?.bid, gameAgeMs, fresher === 'game'));
        this.result.appendChild(this.priceLine('Mooket', mooket?.ask, mooket?.bid, mooketAgeMs, fresher === 'mooket'));
    }

    /**
     * One source's line: label, ask/bid, age, and a fresher marker.
     * @param {string} label - 'Game' or 'Mooket'
     * @param {number|null|undefined} ask - Best ask
     * @param {number|null|undefined} bid - Best bid
     * @param {number|null} ageMs - How old this reading is
     * @param {boolean} isFresher - Whether to mark this line as the newer one
     * @returns {HTMLElement}
     */
    priceLine(label, ask, bid, ageMs, isFresher) {
        const price = (value) => (value === null || value === undefined ? '—' : formatWithSeparator(value));
        const age = typeof ageMs === 'number' && ageMs >= 0 ? `~${formatRelativeTime(ageMs)} old` : 'no reading';

        const line = document.createElement('div');
        const text = document.createElement('span');
        text.textContent = `${label.padEnd(6)} ask ${price(ask)} · bid ${price(bid)}   (${age})`;
        line.appendChild(text);

        if (isFresher) {
            const tag = document.createElement('span');
            tag.textContent = '  ← fresher';
            tag.style.color = '#67c23a';
            line.appendChild(tag);
        } else if (typeof ageMs === 'number' && ageMs >= 0) {
            text.style.opacity = '0.7';
        }

        return line;
    }
}

const mooketLivePriceCheck = new MooketLivePriceCheck();
export default mooketLivePriceCheck;
