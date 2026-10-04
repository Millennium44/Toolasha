/**
 * Collection Points optimizer.
 *
 * A collapsible panel on Achievements → Collections that ranks the cheapest
 * next collection points: per item, the next rung of the points ladder and
 * the cheapest route to it (craft, decompose chain, or shop gear decomposed),
 * in gold per point. A target box plans the cheapest list of rungs to gain
 * "+N points".
 *
 * The counts are the game's own `collections_updated` message, which it sends
 * when the Collections tab is opened; the panel appears once it has arrived.
 * Buying an item on the market does not collect it, so no Buy route exists.
 *
 * The routes are priced once per opening (or on Recompute), off the tooltip
 * hover path, and kept for the session; ranking against the counts is cheap
 * and redone whenever the counts arrive again. The arithmetic is in
 * collection-optimizer-plan.js.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import profitCalculator from '../market/profit-calculator.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import { ownUseCompare } from '../market/tooltip-prices.js';
import { getItemPrice } from '../../utils/market-data.js';
import { getShopCoinCost } from '../../utils/game-lookups.js';
import { formatKMB, timeReadable } from '../../utils/formatters.js';
import { ownUseUnitCost, selfUseDecomposeChain } from '../../utils/self-use-alchemy.js';
import {
    ROUTE_LABELS,
    bestOptions,
    collectionAchievementTargets,
    collectionCounts,
    indexRoutes,
    nextAchievementTarget,
    planTarget,
    totalCollectionPoints,
} from './collection-optimizer-plan.js';

/** The setting that turns the panel on */
export const SETTING_KEY = 'collectionOptimizer';

/** The panel's root class */
const PANEL_CLASS = 'toolasha-collopt';

/** Rows shown in the ranking */
const MAX_ROWS = 40;

/** Items priced between yields to the browser while the routes are built */
const YIELD_EVERY = 25;

/** Items that are never a collection entry */
const SKIP_ITEMS = new Set(['/items/coin']);

/**
 * Hand the event loop back so a long build never freezes the page.
 * @returns {Promise<void>}
 */
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Price every route the game data allows, for the current character's bench.
 *
 * Craft: per item with a production action, the own-use make cost
 * ({@link ownUseCompare}: materials and teas at the buy side per item made)
 * and 3600 / items made per hour.
 *
 * Decompose / shop: per item with decompose outputs, the full chain at the
 * calculator's catalyst/tea pick with an input cost of 0
 * ({@link selfUseDecomposeChain}), so one walk serves both: the decompose
 * route adds the item's own-use cost (cheaper of make and buy), the shop
 * route its shop coin price.
 *
 * @param {Object} [opts]
 * @param {() => boolean} [opts.cancelled] - Stops the build when it turns true
 * @returns {Promise<{craft: Array<Object>, sources: Array<Object>}|null>} Null when cancelled
 */
export async function buildCollectionRoutes({ cancelled = () => false } = {}) {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const getItemDetails = (hrid) => itemDetailMap[hrid] || dataManager.getItemDetails?.(hrid) || null;
    const priceOf = (hrid) => getItemPrice(hrid, { context: 'profit', side: 'buy' });

    const craft = [];
    const makeCost = new Map();
    let done = 0;
    for (const hrid of Object.keys(itemDetailMap)) {
        if (SKIP_ITEMS.has(hrid) || !profitCalculator.findProductionAction?.(hrid)) continue;
        if (++done % YIELD_EVERY === 0) {
            await yieldToBrowser();
            if (cancelled()) return null;
        }
        try {
            const profitData = await profitCalculator.calculateProfit(hrid);
            if (!profitData) continue;
            const comparison = ownUseCompare(profitData, dataManager.getActionDetails?.(profitData.actionHrid) ?? null);
            const perHour = Number(profitData.totalItemsPerHour);
            if (!comparison || !(perHour > 0)) continue;
            makeCost.set(hrid, comparison.make);
            craft.push({ route: 'craft', itemHrid: hrid, unitCost: comparison.make, unitSeconds: 3600 / perHour });
        } catch (error) {
            console.error('[CollectionOptimizer] Craft route failed for', hrid, error);
        }
    }
    if (cancelled()) return null;

    const decomposeResults = new Map();
    const getDecompose = (hrid) => {
        if (!decomposeResults.has(hrid)) {
            let result = null;
            try {
                result = alchemyProfitCalculator.calculateDecomposeProfit(hrid) ?? null;
            } catch (error) {
                console.error('[CollectionOptimizer] Decompose failed for', hrid, error);
            }
            decomposeResults.set(hrid, result);
        }
        return decomposeResults.get(hrid);
    };
    const isChainable = (hrid) => {
        const details = getItemDetails(hrid);
        return Boolean(details?.equipmentDetail && details.alchemyDetail?.decomposeItems?.length);
    };

    const sources = [];
    done = 0;
    for (const [hrid, details] of Object.entries(itemDetailMap)) {
        if (!details?.alchemyDetail?.decomposeItems?.length) continue;
        if (++done % YIELD_EVERY === 0) {
            await yieldToBrowser();
            if (cancelled()) return null;
        }
        const chain = selfUseDecomposeChain(hrid, {
            getDecompose,
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 0,
        });
        if (!chain) continue;

        // A piece cut short by a cycle is listed as gear and as kept; it is one piece
        const yields = new Map();
        for (const { itemHrid, expected } of [...chain.collected, ...chain.terminals]) {
            if (SKIP_ITEMS.has(itemHrid) || !(expected > 0)) continue;
            yields.set(itemHrid, Math.max(yields.get(itemHrid) || 0, expected));
        }
        const kept = new Map();
        for (const { itemHrid, value } of chain.terminals) {
            if (value !== null && value !== undefined) kept.set(itemHrid, value);
        }
        if (yields.size === 0) continue;
        const shared = {
            sourceHrid: hrid,
            seconds: chain.seconds,
            yields,
            kept,
            partlyUnpriced: chain.partlyUnpriced,
        };

        const ownUse = ownUseUnitCost({ make: makeCost.get(hrid) ?? null, buy: priceOf(hrid) });
        if (ownUse !== null) sources.push({ ...shared, route: 'decompose', cost: ownUse + chain.overheadCost });
        const shopPrice = getShopCoinCost(hrid);
        if (shopPrice > 0) sources.push({ ...shared, route: 'shop', cost: shopPrice + chain.overheadCost });
    }
    if (cancelled()) return null;
    return { craft, sources };
}

/**
 * An item's display name.
 * @param {string} hrid
 * @returns {string}
 */
function itemName(hrid) {
    return (
        dataManager.getItemDetails?.(hrid)?.name ||
        String(hrid || '')
            .split('/')
            .pop()
    );
}

/**
 * Build an element with inline style and text.
 * @param {string} tag
 * @param {string} [style]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, style = '', text = '') {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
}

/**
 * A count for display: whole numbers as they are, an expected fraction to one place.
 * @param {number} value
 * @returns {string}
 */
function formatCount(value) {
    if (Number.isInteger(value)) return formatKMB(value, 0) ?? '0';
    return formatKMB(value, 1) ?? '0';
}

/**
 * A route's description for a row: the route, and the source item it starts from.
 * @param {Object} option
 * @returns {string}
 */
function describeRoute(option) {
    const label = ROUTE_LABELS[option.route] || option.route;
    if (!option.sourceHrid) return label;
    return `${label}: ${option.units}× ${itemName(option.sourceHrid)}`;
}

class CollectionOptimizer {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.collectionsHandler = null;
        /** Priced routes, by character, kept for the session */
        this.routes = null;
        this.routesFor = null;
        this.index = null;
        this.building = null;
        this.generation = 0;
        this.collapsed = false;
        this.targetPoints = 10;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING_KEY)) return;
        this.isInitialized = true;
        this.generation++;

        const unregister = domObserver.onClass('CollectionOptimizer-panel', 'AchievementsPanel_controls', (node) => {
            const panel = node.closest?.('[class*="AchievementsPanel_collections"]');
            if (panel) this.mount(panel);
        });
        this.unregisterHandlers.push(unregister);

        this.collectionsHandler = () => {
            const panel = document.querySelector(`.${PANEL_CLASS}`)?.parentElement || this.findVisiblePanel();
            if (panel) this.mount(panel);
        };
        dataManager.on('collections_updated', this.collectionsHandler);

        const open = this.findVisiblePanel();
        if (open) this.mount(open);
    }

    disable() {
        this.generation++;
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];
        if (this.collectionsHandler) {
            dataManager.off('collections_updated', this.collectionsHandler);
            this.collectionsHandler = null;
        }
        document.querySelectorAll(`.${PANEL_CLASS}`).forEach((node) => node.remove());
        this.routes = null;
        this.routesFor = null;
        this.index = null;
        this.building = null;
        this.isInitialized = false;
    }

    /**
     * The Collections panel on screen, if any.
     * @returns {Element|null}
     */
    findVisiblePanel() {
        return document.querySelector('[class*="AchievementsPanel_collections"]');
    }

    /**
     * Put the panel into the Collections tab, once the game has sent the counts.
     * @param {Element} collectionsPanel - The `AchievementsPanel_collections` element
     */
    mount(collectionsPanel) {
        if (!this.isInitialized || !collectionsPanel) return;
        if (!dataManager.getCharacterCollections?.()) return;

        let root = collectionsPanel.querySelector(`:scope > .${PANEL_CLASS}`);
        if (!root) {
            root = el(
                'div',
                'margin:6px 0;padding:6px 8px;border:1px solid #444;border-radius:6px;background:rgba(0,0,0,0.25);font-size:12px;color:#ddd;'
            );
            root.className = PANEL_CLASS;
            const categories = collectionsPanel.querySelector('[class*="AchievementsPanel_categories"]');
            if (categories && categories.parentElement === collectionsPanel) {
                collectionsPanel.insertBefore(root, categories);
            } else {
                collectionsPanel.appendChild(root);
            }
        }
        this.render(root);
    }

    /**
     * Draw the panel: header, summary, target box and ranking. Prices the
     * routes first when none are in hand for this character.
     * @param {Element} root
     */
    render(root) {
        root.replaceChildren();
        const counts = collectionCounts(dataManager.getCharacterCollections?.());
        const total = totalCollectionPoints(counts);

        const header = el('div', 'display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:bold;');
        header.className = 'toolasha-collopt-header';
        header.appendChild(el('span', '', `${this.collapsed ? '▸' : '▾'} Collection Points Optimizer`));
        const targets = collectionAchievementTargets(dataManager.getInitClientData?.()?.achievementDetailMap);
        const next = nextAchievementTarget(targets, total);
        const summary = next ? `${total} points — next achievement at ${next.target}` : `${total} points`;
        header.appendChild(el('span', 'font-weight:normal;color:#aaa;', summary));
        header.addEventListener('click', () => {
            this.collapsed = !this.collapsed;
            this.render(root);
        });
        root.appendChild(header);
        if (this.collapsed) return;

        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (!this.index || this.routesFor !== characterId) {
            root.appendChild(el('div', 'color:#aaa;margin-top:4px;', 'Pricing routes…'));
            this.ensureRoutes(root, characterId);
            return;
        }

        const body = el('div', 'margin-top:4px;');
        body.className = 'toolasha-collopt-body';
        root.appendChild(body);
        this.renderTargetBox(body, counts);
        this.renderRanking(body, counts);

        const footer = el('div', 'margin-top:4px;color:#888;');
        footer.appendChild(
            el(
                'span',
                '',
                'Buying on the market does not collect an item. Gold is net of the other kept outputs, untaxed. '
            )
        );
        const recompute = el('button', 'font-size:11px;margin-left:4px;', 'Recompute');
        recompute.className = 'toolasha-collopt-recompute';
        recompute.addEventListener('click', (event) => {
            event.stopPropagation();
            this.index = null;
            this.routes = null;
            this.render(root);
        });
        footer.appendChild(recompute);
        body.appendChild(footer);
    }

    /**
     * Price the routes once, then redraw.
     * @param {Element} root
     * @param {*} characterId - The character the routes are priced for
     */
    ensureRoutes(root, characterId) {
        if (this.building) return;
        const generation = this.generation;
        const cancelled = () =>
            generation !== this.generation || (dataManager.getCurrentCharacterId?.() ?? null) !== characterId;
        this.building = (async () => {
            try {
                const routes = await buildCollectionRoutes({ cancelled });
                if (!routes || cancelled()) return;
                this.routes = routes;
                this.routesFor = characterId;
                this.index = indexRoutes(routes);
            } catch (error) {
                console.error('[CollectionOptimizer] Pricing routes failed:', error);
            } finally {
                if (generation === this.generation) this.building = null;
            }
            if (!cancelled() && root.isConnected && this.index) this.render(root);
        })();
    }

    /**
     * The "+N points" box and its plan.
     * @param {Element} body
     * @param {Map<string, number>} counts
     */
    renderTargetBox(body, counts) {
        const row = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        row.appendChild(el('span', '', 'Plan +'));
        const input = el('input', 'width:60px;font-size:12px;background:#222;color:#eee;border:1px solid #444;');
        input.type = 'number';
        input.min = '1';
        input.value = String(this.targetPoints);
        input.className = 'toolasha-collopt-target';
        row.appendChild(input);
        row.appendChild(el('span', '', 'points'));
        const go = el('button', 'font-size:11px;', 'Plan');
        go.className = 'toolasha-collopt-plan';
        row.appendChild(go);
        body.appendChild(row);

        const result = el('div', '');
        result.className = 'toolasha-collopt-plan-result';
        body.appendChild(result);

        const run = () => {
            const wanted = Math.max(1, Math.floor(Number(input.value) || 0));
            this.targetPoints = wanted;
            const plan = planTarget(counts, this.index, wanted);
            result.replaceChildren();
            const head = plan.reached
                ? `+${plan.points} points: ${formatKMB(plan.gold)} gold, ${timeReadable(plan.seconds)}`
                : `Only +${plan.points} points found: ${formatKMB(plan.gold)} gold, ${timeReadable(plan.seconds)}`;
            result.appendChild(el('div', 'color:#9cf;', head));
            const list = el('ol', 'margin:2px 0 4px 18px;padding:0;');
            for (const step of plan.steps) {
                list.appendChild(
                    el(
                        'li',
                        '',
                        `${itemName(step.itemHrid)} → ${formatCount(step.to)} (+${step.points}) via ` +
                            `${describeRoute(step)}: ${formatKMB(step.gold)}`
                    )
                );
            }
            result.appendChild(list);
        };
        go.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') run();
        });
        input.addEventListener('click', (event) => event.stopPropagation());
    }

    /**
     * The ranking: each item's cheapest next rung.
     * @param {Element} body
     * @param {Map<string, number>} counts
     */
    renderRanking(body, counts) {
        const options = bestOptions(counts, this.index);
        if (options.length === 0) {
            body.appendChild(el('div', 'color:#aaa;', 'No priced route yet — market data may still be loading.'));
            return;
        }
        const table = el('table', 'width:100%;border-collapse:collapse;font-size:11px;');
        table.className = 'toolasha-collopt-table';
        const head = el('tr', 'color:#aaa;text-align:left;');
        for (const label of ['Item', 'Count → next', 'Points', 'Route', 'Gold', 'Time', 'Gold/pt']) {
            head.appendChild(el('th', 'padding:1px 4px;font-weight:normal;', label));
        }
        table.appendChild(head);
        for (const option of options.slice(0, MAX_ROWS)) {
            const tr = el('tr', 'border-top:1px solid #333;');
            tr.className = 'toolasha-collopt-row';
            tr.dataset.item = option.itemHrid;
            tr.dataset.route = option.route;
            const points = option.collateral > 0 ? `+${option.gain} (+${option.collateral})` : `+${option.gain}`;
            const cells = [
                itemName(option.itemHrid),
                `${formatCount(option.from)} → ${formatCount(option.to)}`,
                points,
                describeRoute(option),
                formatKMB(option.gold),
                timeReadable(option.seconds),
                formatKMB(option.goldPerPoint),
            ];
            for (const text of cells) tr.appendChild(el('td', 'padding:1px 4px;', String(text ?? '')));
            table.appendChild(tr);
        }
        body.appendChild(table);
    }
}

const collectionOptimizer = new CollectionOptimizer();

export default collectionOptimizer;
