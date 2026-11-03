/**
 * Alchemy Catalyst Mark
 *
 * Says which catalyst is best, and what it earns, inside the game's own catalyst picker.
 *
 * Read only. This never clicks, selects, fills a slot or writes to the game: the player picks, and the
 * mark is a line at the top of the open menu plus a star on the best tile. (Scripted clicks are flagged
 * by the server, so none are made.)
 *
 * No profit model of its own: each option is the calculator's forced-catalyst answer, the same call the
 * Profitability what-if makes (`catalystChoice`), so the pricing mode, Iron Cow tax, refined-cape rule
 * and the live gear and drinks all apply exactly as they do in the panel.
 *
 * What it will not do is guess. An option the calculator cannot price is left out and named; fewer than
 * two priced options draws nothing; a profit that ties is called a tie rather than given a winner; a
 * figure with unpriced drops is labeled a floor, one with an unpriced tea a ceiling, and one with both incomplete.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { readAlchemyPanelSelection } from './alchemy-profit.js';
import { findCatalystMenu, activeAlchemyAction, menuTiles } from './alchemy-item-selector.js';
import { pricesMoved } from '../../utils/price-change.js';
import { formatKMB } from '../../utils/formatters.js';
import { GAME_COLORS, GAME_FRAME } from '../../utils/game-look.js';
import { PATIENT_TICK_SETTING_KEYS } from '../../utils/patient-tick.js';
import { IRONCOW_VALUATION_SETTING } from '../../utils/ironcow-valuation.js';
import { CAPE_BASE_VALUE_SETTING } from '../../utils/untradable-cape.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const SETTING = 'alchemyCatalystMark';
const STYLE_ID = 'mwi-alchemy-catalyst-mark-style';
const BANNER_CLASS = 'mwi-alchemy-catalyst-mark';
const TILE_CLASS = 'mwi-alchemy-catalyst-mark-tile';
const STAR_CLASS = 'mwi-alchemy-catalyst-mark-star';

/** The catalyst each choice slots, per tab (the calculator's own constants) */
const TYPE_CATALYSTS = {
    coinify: '/items/catalyst_of_coinification',
    decompose: '/items/catalyst_of_decomposition',
    transmute: '/items/catalyst_of_transmutation',
};
const PRIME_CATALYST = '/items/prime_catalyst';
/** A difference smaller than this many coins an hour is a tie, not a winner */
const TIE_EPSILON = 0.5;

const CSS = `
    .${BANNER_CLASS} {
        box-sizing: border-box;
        margin: 4px 0;
        padding: 6px 8px;
        border: ${GAME_FRAME.border};
        border-radius: ${GAME_FRAME.borderRadius};
        background: ${GAME_FRAME.background};
        color: ${GAME_COLORS.text};
        font-size: 0.8rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
    }
    .${BANNER_CLASS} div + div { margin-top: 2px; }
    .${BANNER_CLASS} .mwi-mark-best { color: ${GAME_COLORS.good}; font-weight: 600; }
    .${BANNER_CLASS} .mwi-mark-dim { color: ${GAME_COLORS.textDim}; }
    .${TILE_CLASS} { position: relative; outline: 2px solid ${GAME_COLORS.good}; outline-offset: -2px; }
    .${STAR_CLASS} {
        position: absolute; top: 1px; right: 2px; font-size: 12px; line-height: 1;
        color: ${GAME_COLORS.good}; pointer-events: none; text-shadow: 0 0 2px #000, 0 0 2px #000;
    }
`;

/**
 * The tile's item, from the sprite it draws. Both attributes are read because item icons often carry the
 * id on `xlink:href` alone.
 * @param {HTMLElement} tile - An item tile
 * @returns {string} Item hrid, or ''
 */
function iconHrid(tile) {
    const use = tile?.querySelector?.('use');
    const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
    const name = href.split('#')[1];
    return name ? `/items/${name}` : '';
}

/**
 * Pick the best option from priced ones. Pure.
 *
 * @param {Array<{key: string, hrid: string|null, profitPerHour: number}>} options - Priced options only
 * @returns {{state: 'none'|'best'|'tie'|'allTie', ranked: Array, best: Array}}
 *   `none`: fewer than two options, nothing to compare. `allTie`: every option earns the same.
 */
export function rankCatalystOptions(options) {
    const ranked = [...options].sort((a, b) => b.profitPerHour - a.profitPerHour);
    if (ranked.length < 2) return { state: 'none', ranked, best: [] };
    const top = ranked[0].profitPerHour;
    const best = ranked.filter((option) => top - option.profitPerHour < TIE_EPSILON);
    if (best.length === ranked.length) return { state: 'allTie', ranked, best };
    return { state: best.length > 1 ? 'tie' : 'best', ranked, best };
}

/** @param {number} value - Coins @returns {string} Signed short figure */
function signed(value) {
    const rounded = Math.round(value);
    return `${rounded < 0 ? '-' : '+'}${formatKMB(Math.abs(rounded))}`;
}

/** What changes the figures through the character rather than the market */
const CHARACTER_EVENTS = ['items_updated', 'consumables_updated', 'buffs_updated', 'skills_updated'];

class AlchemyCatalystMark {
    constructor() {
        this.isInitialized = false;
        this.unregister = null;
        this.menuObserver = null;
        this.watchedMenu = null;
        this.styleEl = null;
        this.timer = null;
        this.marketHandler = null;
        this.bookHandler = null;
        this.evHandler = null;
        this.settingUnsubscribers = [];
        /** One computed answer, for the input it was computed for */
        this.cache = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING)) return;
        this.isInitialized = true;

        this.styleEl = document.createElement('style');
        this.styleEl.id = STYLE_ID;
        this.styleEl.textContent = CSS;
        document.head.appendChild(this.styleEl);

        this.unregister = domObserver.onClass('AlchemyCatalystMark', 'ItemSelector_menu', () => this.schedule());
        this.marketHandler = () => {
            this.cache = null;
            this.schedule();
        };
        dataManager.on('market_item_values_updated', this.marketHandler);
        // The order book loads and moves on its own feed: a picker opened before it loaded must fill in, and
        // an open one must follow it
        this.bookHandler = (change) => {
            if (!pricesMoved(change)) return;
            this.cache = null;
            this.schedule();
        };
        marketAPI.on(this.bookHandler);
        // Essence and crate values come from the expected-value calculator; redraw when it (re)publishes
        this.evHandler = () => {
            this.cache = null;
            this.schedule();
        };
        dataManager.on('expected_value_initialized', this.evHandler);
        // The calculator reads the character's own skills, gear, drinks and buffs, and none of that is in the key
        this.characterHandler = () => {
            this.cache = null;
            this.schedule();
        };
        for (const event of CHARACTER_EVENTS) dataManager.on(event, this.characterHandler);
        // Pricing mode and the valuation settings change every figure
        const onChange = () => {
            this.cache = null;
            this.schedule();
        };
        this.settingUnsubscribers = [
            'profitCalc_pricingMode',
            ...PATIENT_TICK_SETTING_KEYS,
            IRONCOW_VALUATION_SETTING,
            CAPE_BASE_VALUE_SETTING,
        ].map((key) => config.onSettingChange(key, onChange));
        this.schedule();
    }

    disable() {
        noteTeardown(this);
        try {
            this.unregister?.();
            this.unregister = null;
            this.menuObserver?.disconnect();
            this.menuObserver = null;
            this.watchedMenu = null;
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            if (this.marketHandler) dataManager.off('market_item_values_updated', this.marketHandler);
            this.marketHandler = null;
            if (this.bookHandler) marketAPI.off(this.bookHandler);
            this.bookHandler = null;
            if (this.evHandler) dataManager.off('expected_value_initialized', this.evHandler);
            this.evHandler = null;
            if (this.characterHandler) {
                for (const event of CHARACTER_EVENTS) dataManager.off(event, this.characterHandler);
            }
            this.characterHandler = null;
            for (const unsubscribe of this.settingUnsubscribers) unsubscribe?.();
            this.settingUnsubscribers = [];
            this.clearMarks();
            this.styleEl?.remove();
            this.styleEl = null;
            this.cache = null;
        } catch (error) {
            console.error('[AlchemyCatalystMark] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /** Remove everything this module put on the page */
    clearMarks() {
        document.querySelectorAll(`.${BANNER_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`.${STAR_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`.${TILE_CLASS}`).forEach((el) => el.classList.remove(TILE_CLASS));
    }

    /** Coalesce bursts of menu changes into one pass */
    schedule() {
        if (!this.isInitialized || this.timer) return;
        const ticket = captureOwner(this);
        this.timer = setTimeout(() => {
            this.timer = null;
            if (stillOurs(ticket)) this.apply();
        }, 50);
    }

    watchMenu(menu) {
        if (this.watchedMenu === menu && this.menuObserver) return;
        this.menuObserver?.disconnect();
        // A new menu: the gear, drinks and stock it was priced under may have changed
        this.cache = null;
        this.watchedMenu = menu;
        // Children only. The pass writes classes and text, and reacting to those would be reacting to itself
        this.menuObserver = new MutationObserver(() => this.schedule());
        this.menuObserver.observe(menu, { childList: true, subtree: true });
    }

    /** Draw, redraw or remove the mark for the open catalyst picker */
    apply() {
        try {
            const menu = findCatalystMenu();
            if (!menu) {
                this.menuObserver?.disconnect();
                this.menuObserver = null;
                this.watchedMenu = null;
                this.cache = null;
                this.clearMarks();
                return;
            }
            this.watchMenu(menu);

            const answer = this.compute();
            // The panel may have closed or the menu been replaced while this ran
            if (!menu.isConnected) return;
            this.draw(menu, answer);
        } catch (error) {
            console.error('[AlchemyCatalystMark] Failed to draw:', error);
            this.clearMarks();
        }
    }

    /**
     * Every catalyst choice's profit for the panel's current input, from the calculator.
     * @returns {{options: Array, skipped: string[], missingOutput: boolean, missingTea: boolean}|null} null
     *   without an input or tab
     */
    compute() {
        const action = activeAlchemyAction();
        const selection = readAlchemyPanelSelection();
        if (!TYPE_CATALYSTS[action] || !selection?.itemHrid) return null;

        const charId = dataManager.getCurrentCharacterId?.() || null;
        const pricingMode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        // Essence and crate outputs read as unpriced until the expected-value calculator has run, and it runs
        // only when some other setting started it: ask for it (it shares one start between callers)
        if (!expectedValueCalculator.isInitialized) this.requestExpectedValue();
        // Every input that moves a figure: the book version and the calculator's readiness included
        const key = [
            charId,
            action,
            selection.itemHrid,
            selection.enhancementLevel,
            pricingMode,
            marketAPI.priceVersion,
            expectedValueCalculator.isInitialized,
        ].join('|');
        if (this.cache?.key === key) return this.cache.answer;

        const choices = [
            { key: 'none', hrid: null },
            { key: 'typeSpecific', hrid: TYPE_CATALYSTS[action] },
            { key: 'prime', hrid: PRIME_CATALYST },
        ];
        const options = [];
        const skipped = [];
        let missingOutput = false;
        let missingTea = false;
        for (const choice of choices) {
            let data = null;
            try {
                data = this.calculate(action, selection, choice.key);
            } catch (error) {
                console.error('[AlchemyCatalystMark] Calculator failed:', error);
            }
            if (!data || !Number.isFinite(data.profitPerHour)) {
                if (choice.hrid) skipped.push(choice.hrid);
                continue;
            }
            if (data.unpricedOutputs?.length > 0) missingOutput = true;
            if (data.hasMissingPrices) missingTea = true;
            options.push({
                ...choice,
                profitPerHour: data.profitPerHour,
                profitPerAction: data.profitPerAction,
            });
        }

        const answer = { options, skipped, missingOutput, missingTea };
        // An answer with nothing in it is "not loaded yet", not a result: never hold it
        if (options.length > 0) this.cache = { key, answer };
        return answer;
    }

    /** Start the expected-value calculator if nothing has; its 'expected_value_initialized' event redraws us */
    async requestExpectedValue() {
        try {
            await expectedValueCalculator.initialize?.();
        } catch (error) {
            console.error('[AlchemyCatalystMark] Expected value start failed:', error);
        }
    }

    calculate(action, selection, choice) {
        const { itemHrid, enhancementLevel } = selection;
        if (action === 'coinify') {
            return alchemyProfitCalculator.calculateCoinifyProfit(itemHrid, enhancementLevel, true, null, null, choice);
        }
        if (action === 'decompose') {
            return alchemyProfitCalculator.calculateDecomposeProfit(
                itemHrid,
                enhancementLevel,
                true,
                null,
                null,
                choice
            );
        }
        return alchemyProfitCalculator.calculateTransmuteProfit(itemHrid, true, null, choice, null, enhancementLevel);
    }

    /** How many of a catalyst the player holds in the bag */
    ownedCount(hrid) {
        return (dataManager.getInventory?.() || [])
            .filter(
                (item) =>
                    item.itemHrid === hrid &&
                    !(item.enhancementLevel > 0) &&
                    (!item.itemLocationHrid || item.itemLocationHrid === '/item_locations/inventory')
            )
            .reduce((sum, item) => sum + (item.count || 0), 0);
    }

    nameOf(option) {
        if (!option.hrid) return 'no catalyst';
        return dataManager.getItemDetails(option.hrid)?.name || option.hrid;
    }

    /** The lines the banner shows, as `[text, className]` pairs. Empty when there is nothing to say. */
    describe(answer) {
        if (!answer) return [];
        const { state, ranked, best } = rankCatalystOptions(answer.options);
        if (state === 'none') return [];

        const lines = [];
        const rate = (option) => `${signed(option.profitPerHour)}/hr`;
        // An unpriced drop counts as 0 revenue (a floor); an unpriced tea counts as 0 cost (a ceiling); with both,
        // neither bound holds. The same reading as the item tooltip's profit rows
        const floor =
            answer.missingOutput && answer.missingTea
                ? ' (incomplete: a drop and a tea have no price)'
                : answer.missingTea
                  ? ' (a ceiling: a tea has no price)'
                  : answer.missingOutput
                    ? ' (a floor: some drops have no price)'
                    : '';

        if (state === 'allTie') {
            lines.push([`Best catalyst: none of these changes profit (${rate(ranked[0])})${floor}.`, '']);
        } else if (state === 'tie') {
            lines.push([
                `Best catalyst: ${best.map((o) => this.nameOf(o)).join(' and ')} tie at ${rate(best[0])}${floor}.`,
                'mwi-mark-best',
            ]);
        } else {
            const top = best[0];
            const per = Number.isFinite(top.profitPerAction) ? `, ${signed(top.profitPerAction)}/action` : '';
            const note = top.hrid ? '' : ' (using a catalyst earns less)';
            lines.push([`Best catalyst: ${this.nameOf(top)}, ${rate(top)}${per}${note}${floor}.`, 'mwi-mark-best']);
            if (top.hrid && this.ownedCount(top.hrid) === 0) {
                const owned = ranked.find((o) => !o.hrid || this.ownedCount(o.hrid) > 0);
                lines.push([
                    `You have none. Best you own: ${owned ? `${this.nameOf(owned)}, ${rate(owned)}` : 'no catalyst'}.`,
                    '',
                ]);
            }
        }
        const others = ranked.filter((o) => !best.includes(o)).map((o) => `${this.nameOf(o)} ${rate(o)}`);
        if (others.length) lines.push([`Others: ${others.join(', ')}.`, 'mwi-mark-dim']);
        if (answer.skipped.length) {
            const names = answer.skipped.map((hrid) => dataManager.getItemDetails(hrid)?.name || hrid);
            lines.push([`Not compared (no market price): ${names.join(', ')}.`, 'mwi-mark-dim']);
        }
        return lines;
    }

    draw(menu, answer) {
        const lines = this.describe(answer);
        let banner = menu.querySelector(`:scope > .${BANNER_CLASS}`);
        if (!lines.length) {
            banner?.remove();
            this.clearTileMarks(menu);
            return;
        }
        if (!banner) {
            banner = document.createElement('div');
            banner.className = BANNER_CLASS;
            menu.insertBefore(banner, menu.firstChild);
        }
        const signature = JSON.stringify(lines);
        if (banner.dataset.mwiSignature !== signature) {
            banner.dataset.mwiSignature = signature;
            banner.replaceChildren(
                ...lines.map(([text, cls]) => {
                    const row = document.createElement('div');
                    row.textContent = text;
                    if (cls) row.className = cls;
                    return row;
                })
            );
        }

        // A star on the winning tile(s), only for a clear winner and only if it is in the list
        const { state, best } = rankCatalystOptions(answer.options);
        const winners = new Set(state === 'best' ? best.map((o) => o.hrid).filter(Boolean) : []);
        this.clearTileMarks(menu, winners);
        const { tiles } = menuTiles(menu);
        for (const node of tiles) {
            const tile = node.matches('[class*="Item_itemContainer"]')
                ? node
                : node.querySelector('[class*="Item_itemContainer"]');
            if (!tile || !winners.has(iconHrid(tile))) continue;
            tile.classList.add(TILE_CLASS);
            if (!tile.querySelector(`.${STAR_CLASS}`)) {
                const star = document.createElement('span');
                star.className = STAR_CLASS;
                star.textContent = '★';
                tile.appendChild(star);
            }
        }
    }

    /** Remove tile marks inside a menu, except on tiles whose hrid is in `keep` */
    clearTileMarks(menu, keep = new Set()) {
        menu.querySelectorAll(`.${TILE_CLASS}`).forEach((tile) => {
            if (keep.has(iconHrid(tile))) return;
            tile.classList.remove(TILE_CLASS);
            tile.querySelector(`.${STAR_CLASS}`)?.remove();
        });
    }
}

const alchemyCatalystMark = new AlchemyCatalystMark();
export default alchemyCatalystMark;
