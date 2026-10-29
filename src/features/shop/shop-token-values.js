/**
 * Shop Token Values
 *
 * Marks each entry of the Dungeon shop and the Labyrinth shop with what one token is worth in it
 * (the market value of what it buys, after market tax, divided by its token cost), and stars the
 * best entry of each currency. An untradable cape has no market price: it shows the untradable-cape
 * setting's value with an asterisk and never takes the star.
 *
 * Nothing here ever clicks or buys. A badge is a node appended to a shop tile; disable() removes
 * every one and every listener.
 *
 * The tile selectors and the cost element's layout are read from the live game DOM and are the part
 * most likely to need a touch-up after a game update: ShopPanel_shopItems / ShopPanel_shopItem__
 * for the Dungeon shop, LabyrinthPanel_buyableGrid / LabyrinthPanel_item for the Labyrinth shop.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { formatKMB } from '../../utils/formatters.js';
import { CAPE_BASE_VALUE_SETTING } from '../../utils/untradable-cape.js';
import { DUNGEON_TOKEN_HRIDS } from '../../utils/token-valuation.js';
import { itemHridFromIcon } from '../../utils/item-icon.js';
import {
    badgeSide,
    badgedCurrencies,
    bestLine,
    shopLineValues,
    LABYRINTH_TOKEN_HRID,
} from './shop-token-values-logic.js';

const SETTING = 'shopTokenValues';
const BADGE_CLASS = 'mwi-shop-token-value';
const OBSERVER_NAME = 'ShopTokenValues';
const CATCHUP_DELAY_MS = 500;
const REFRESH_DEBOUNCE_MS = 100;

// Settings that move a badge: the book side, and what a base cape is assumed to be worth
const WATCHED_SETTINGS = ['profitCalc_pricingMode', 'expectedValue_respectPricingMode', CAPE_BASE_VALUE_SETTING];

const DUNGEON_TILE_SELECTOR = '[class*="ShopPanel_shopItems"] [class*="ShopPanel_shopItem__"]';
const LABYRINTH_TILE_SELECTOR = '[class*="LabyrinthPanel_buyableGrid"] [class*="LabyrinthPanel_item"]';
const COST_SELECTOR = '[class*="costs"], [class*="cost"]';

/**
 * The item a shop tile sells, from its icon sprite (locale independent). The tile also draws the
 * currency icon in its cost line, so icons inside the cost element are skipped.
 *
 * @param {Element} tile - A shop tile
 * @param {Object} itemDetailMap - Game item map, to validate a sprite against
 * @returns {string|null} Item HRID, or null when no icon resolves
 */
function tileItemHrid(tile, itemDetailMap) {
    const resolve = (use) => {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href');
        const slug = href?.split('#')[1];
        return slug && itemDetailMap[`/items/${slug}`] ? `/items/${slug}` : null;
    };
    const uses = [...tile.querySelectorAll('svg use')];
    const insideCost = (use) => {
        const cost = use.closest(COST_SELECTOR);
        return Boolean(cost) && cost !== tile;
    };
    // The item icon first; if every icon sits in a cost-looking element, the layout is not what was
    // assumed and the first resolvable icon is the best remaining guess
    for (const use of uses.filter((u) => !insideCost(u))) {
        const hrid = resolve(use);
        if (hrid) return hrid;
    }
    for (const use of uses) {
        const hrid = resolve(use);
        if (hrid) return hrid;
    }
    return null;
}

/**
 * The currency and the token count a Dungeon tile asks for, read from its cost line: the currency
 * from its icon sprite, the count from the digits (locale independent).
 *
 * @param {Element} tile - A Dungeon shop tile
 * @param {Object} itemDetailMap - Game item map
 * @returns {{currencyHrid: string|null, cost: number|null}}
 */
function tileCost(tile, itemDetailMap) {
    const costEl = tile.querySelector('[class*="ShopPanel_costs"]');
    if (!costEl) return { currencyHrid: null, cost: null };
    const match = (costEl.textContent || '').match(/\d[\d,.\s]*/);
    const cost = match ? Number(match[0].replace(/[^\d]/g, '')) : NaN;
    return { currencyHrid: itemHridFromIcon(costEl, itemDetailMap), cost: cost > 0 ? cost : null };
}

class ShopTokenValues {
    constructor() {
        this.unregisterHandlers = [];
        this.timer = null;
        this.isInitialized = false;
        this.priceHandler = null;
    }

    initialize() {
        if (!config.getSetting(SETTING) || this.isInitialized) return;
        this.isInitialized = true;

        // Tiles are added when a tab opens (partial class match: a tile or the grid that holds them)
        for (const className of ['ShopPanel_shopItem', 'LabyrinthPanel_buyableGrid', 'LabyrinthPanel_item']) {
            this.unregisterHandlers.push(
                domObserver.onClass(`${OBSERVER_NAME}_${className}`, className, () => this.scheduleRefresh())
            );
        }
        // Content already on the page when the feature starts (document-start: wait for the observer)
        this.unregisterHandlers.push(
            domObserver.onReady(`${OBSERVER_NAME}_catchUp`, () => this.scheduleRefresh(CATCHUP_DELAY_MS))
        );

        // A price tick or a setting that moves the numbers redraws the badges
        this.priceHandler = () => this.scheduleRefresh();
        marketAPI.on(this.priceHandler);
        for (const key of WATCHED_SETTINGS) {
            this.unregisterHandlers.push(config.onSettingChange(key, () => this.scheduleRefresh()));
        }
    }

    disable() {
        this.isInitialized = false;
        clearTimeout(this.timer);
        this.timer = null;
        for (const unregister of this.unregisterHandlers) unregister();
        this.unregisterHandlers = [];
        if (this.priceHandler) {
            marketAPI.off(this.priceHandler);
            this.priceHandler = null;
        }
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
    }

    scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
        if (!this.isInitialized) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refreshAll();
        }, delay);
    }

    refreshAll() {
        if (!this.isInitialized) return;
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap;
        if (!itemDetailMap) return;

        const dungeonTiles = [...document.querySelectorAll(DUNGEON_TILE_SELECTOR)];
        const labyrinthTiles = [...document.querySelectorAll(LABYRINTH_TILE_SELECTOR)];
        if (dungeonTiles.length === 0 && labyrinthTiles.length === 0) return;

        // Every line of each currency, and its best: the shop's, not just the tiles on screen
        const side = badgeSide();
        const linesByCurrency = new Map();
        for (const currencyHrid of badgedCurrencies()) {
            const lines = shopLineValues(currencyHrid, side);
            linesByCurrency.set(currencyHrid, { lines, best: bestLine(lines) });
        }

        for (const tile of dungeonTiles) {
            const itemHrid = tileItemHrid(tile, itemDetailMap);
            const { currencyHrid, cost } = tileCost(tile, itemDetailMap);
            let match = null;
            for (const tokenHrid of DUNGEON_TOKEN_HRIDS) {
                if (currencyHrid && currencyHrid !== tokenHrid) continue;
                const { lines, best } = linesByCurrency.get(tokenHrid);
                const line = lines.find((entry) => entry.itemHrid === itemHrid && entry.cost === cost);
                if (line) {
                    match = { line, best };
                    break;
                }
            }
            this.renderTile(tile, match);
        }

        const labyrinth = linesByCurrency.get(LABYRINTH_TOKEN_HRID);
        for (const tile of labyrinthTiles) {
            const itemHrid = tileItemHrid(tile, itemDetailMap);
            const candidates = labyrinth.lines.filter((entry) => entry.itemHrid === itemHrid);
            // One line per item is the norm; when an item is offered more than once, the tile's own
            // digits say which
            const line =
                candidates.length <= 1
                    ? candidates[0]
                    : candidates.find((entry) =>
                          (tile.textContent || '').replace(/[,\s]/g, '').includes(String(entry.cost))
                      );
            this.renderTile(tile, line ? { line, best: labyrinth.best } : null);
        }
    }

    /**
     * @param {Element} tile - A shop tile
     * @param {{line: Object, best: {itemHrid: string, cost: number}|null}|null} match - Its shop line, or null
     */
    renderTile(tile, match) {
        const existing = tile.querySelector(`.${BADGE_CLASS}`);
        if (!match) {
            existing?.remove();
            return;
        }
        const { line, best } = match;

        const element = existing || document.createElement('div');
        if (!existing) {
            element.className = BADGE_CLASS;
            element.style.cssText = 'font-size: 0.7rem; text-align: center; margin-top: 2px; line-height: 1.3;';
            tile.appendChild(element);
        }

        const isBest = !line.assumed && best?.itemHrid === line.itemHrid && best?.cost === line.cost;
        const value = line.perToken > 0 ? formatKMB(line.perToken) : '—';
        element.textContent = `${isBest ? '★ ' : ''}${value}/token${line.assumed ? '*' : ''}`;
        element.style.color = isBest ? '#4ade80' : '#aaa';
        element.style.fontWeight = isBest ? '600' : '400';
        element.dataset.mwiBest = isBest ? 'true' : 'false';
        element.dataset.mwiAssumed = line.assumed ? 'true' : 'false';
        element.title = line.assumed
            ? line.assumedValue > 0
                ? `Not on the market. Assumed worth ${formatKMB(line.assumedValue)} from the untradable-cape setting` +
                  `${line.partial ? ' (a floor: the base cape counts as nothing)' : ''}, never taxed and never marked best.`
                : 'Not on the market, and the untradable-cape setting values the base cape at nothing. Never marked best.'
            : isBest
              ? `Best value for this token: market value of what it buys, after market tax, per token (${badgeSide()} price).`
              : `Market value of what it buys, after market tax, per token (${badgeSide()} price).`;
    }
}

const shopTokenValues = new ShopTokenValues();

export { ShopTokenValues, shopTokenValues };

export default {
    name: 'Shop Token Values',
    initialize: async () => {
        shopTokenValues.initialize();
    },
    cleanup: () => {
        shopTokenValues.disable();
    },
    disable: () => {
        shopTokenValues.disable();
    },
};
