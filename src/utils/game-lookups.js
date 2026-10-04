/**
 * Game Data Lookup Utilities
 *
 * Centralized functions for resolving display names to HRIDs.
 * Handles the ★ ↔ (R) refined item display name difference between
 * test server and live server.
 */

import dataManager from '../core/data-manager.js';
import { isTesterShopEntry, testerShopEnabled } from './tester-shop.js';
import { fiberFor } from './react-click.js';

/*
 * Display names are translated client-side while every detail map stores the English name, so a
 * name -> hrid lookup silently misses on any non-English game language. The icon sprite fragment
 * and the component props below are locale-independent; callers try them first and keep the name
 * lookup as the fallback, which leaves English behavior unchanged.
 */

/**
 * Generate alternate display names to handle ★ ↔ (R) refined item naming.
 * @param {string} name - Original display name
 * @returns {string[]} Array of alternate names to try (may be empty)
 */
function getRefinedNameVariants(name) {
    const variants = [];
    if (name.includes('★')) {
        variants.push(name.replace(/\s*★/, ' (R)'));
    }
    if (name.includes('(R)')) {
        variants.push(name.replace(/\s*\(R\)/, ' ★'));
    }
    return variants;
}

/**
 * Name → hrid memo for one detail map, keyed on the map's identity.
 *
 * These lookups run on per-panel and per-tooltip paths — a couple of dozen call
 * sites — and each used to walk the whole detail map (twice more on a miss, once
 * per refined-name variant). The map is built once per detail map and rebuilt
 * only when a different map object is handed out (a character switch that
 * replaces init_client_data); a re-read of the same object is a Map.get.
 *
 * Resolution order is unchanged: the first hrid in map order whose display name
 * equals the query, then the first whose name equals a ★ ↔ (R) variant of it.
 */
class NameIndex {
    constructor() {
        this.sourceMap = null;
        /** @type {Map<string, string>|null} display name → first hrid with that name */
        this.byName = null;
    }

    /**
     * Resolve a display name against a detail map.
     * @param {Object|undefined} detailMap - hrid → { name } (action or item details)
     * @param {string} name - Display name to resolve
     * @returns {string|null} The hrid, or null
     */
    lookup(detailMap, name) {
        if (!detailMap) return null;
        if (detailMap !== this.sourceMap) {
            this.byName = buildNameMap(detailMap);
            this.sourceMap = detailMap;
        }
        const exact = this.byName.get(name);
        if (exact !== undefined) return exact;
        for (const variant of getRefinedNameVariants(name)) {
            const hit = this.byName.get(variant);
            if (hit !== undefined) return hit;
        }
        return null;
    }
}

/**
 * Build display name → first hrid for a detail map.
 * @param {Object} detailMap - hrid → { name }
 * @returns {Map<string, string>}
 */
function buildNameMap(detailMap) {
    const byName = new Map();
    for (const hrid in detailMap) {
        const name = detailMap[hrid]?.name;
        if (name === undefined || byName.has(name)) continue;
        byName.set(name, hrid);
    }
    return byName;
}

const actionNames = new NameIndex();
const itemNames = new NameIndex();

/**
 * Sprite fragment -> hrid memo for one detail map, keyed on the map's identity like NameIndex.
 * The sheets key actions and skills by the last hrid segment ("milking" for
 * /actions/milking/... and /skills/milking alike), so that segment is what is indexed.
 */
class FragmentIndex {
    constructor() {
        this.sourceMap = null;
        /** @type {Map<string, string>|null} last hrid segment -> hrid */
        this.byFragment = null;
    }

    /**
     * @param {Object|undefined} detailMap - hrid -> details
     * @param {string} fragment - Sprite fragment, e.g. "milking"
     * @returns {string|null}
     */
    lookup(detailMap, fragment) {
        if (!detailMap) return null;
        if (detailMap !== this.sourceMap) {
            const byFragment = new Map();
            for (const hrid in detailMap) {
                const key = hrid.slice(hrid.lastIndexOf('/') + 1);
                if (!byFragment.has(key)) byFragment.set(key, hrid);
            }
            this.byFragment = byFragment;
            this.sourceMap = detailMap;
        }
        return this.byFragment.get(fragment) ?? null;
    }
}

const actionFragments = new FragmentIndex();
const skillFragments = new FragmentIndex();

/**
 * The fragment of a sprite href when it points into the named sheet.
 * @param {string|null|undefined} href - e.g. "/static/media/actions_sprite.<hash>.svg#milking"
 * @param {string} sheet - Sheet name, e.g. "actions_sprite"
 * @returns {string|null}
 */
function spriteFragment(href, sheet) {
    if (!href || !href.includes(sheet)) return null;
    const fragment = href.split('#')[1];
    return fragment || null;
}

/**
 * Resolve an action HRID from its icon sprite href, which does not change with the game language.
 * @param {string|null|undefined} href - e.g. ".../actions_sprite.<hash>.svg#milking"
 * @returns {string|null}
 */
export function getActionHridFromIconHref(href) {
    const fragment = spriteFragment(href, 'actions_sprite');
    if (!fragment) return null;
    return actionFragments.lookup(dataManager.getInitClientData()?.actionDetailMap, fragment);
}

/**
 * Resolve a skill HRID from its icon sprite href, which does not change with the game language.
 * @param {string|null|undefined} href - e.g. ".../skills_sprite.<hash>.svg#milking"
 * @returns {string|null}
 */
export function getSkillHridFromIconHref(href) {
    const fragment = spriteFragment(href, 'skills_sprite');
    if (!fragment) return null;
    return skillFragments.lookup(dataManager.getInitClientData()?.skillDetailMap, fragment);
}

/**
 * Resolve an item HRID from its icon sprite href. The item fragment is the whole hrid tail
 * ("redwood_log" for /items/redwood_log), so it is validated against itemDetailMap, not indexed.
 * @param {string|null|undefined} href - e.g. ".../items_sprite.<hash>.svg#redwood_log"
 * @returns {string|null}
 */
export function getItemHridFromIconHref(href) {
    const fragment = spriteFragment(href, 'items_sprite');
    if (!fragment) return null;
    const hrid = `/items/${fragment}`;
    return dataManager.getInitClientData()?.itemDetailMap?.[hrid] ? hrid : null;
}

/**
 * The first icon in a container that points into the given sprite sheet, as a href.
 * @param {ParentNode|null|undefined} container
 * @param {string} sheet - Sheet name, e.g. "skills_sprite"
 * @returns {string|null}
 */
export function getIconHref(container, sheet) {
    // Item icons often carry the sprite id on `xlink:href` alone (see alchemy-profit-calculator.js),
    // which a plain `[href]` selector does not match, so both attributes are read
    for (const use of container?.querySelectorAll?.('svg use') ?? []) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href');
        if (href?.includes(sheet)) return href;
    }
    return null;
}

/**
 * Resolve an action HRID from a node inside the action detail modal. The modal draws no
 * hrid-keyed icon of its own, but its component carries `actionDetail` as a prop.
 * @param {Element|null|undefined} element - Any node inside the modal
 * @returns {string|null}
 */
export function getActionHridFromFiber(element) {
    let fiber = element ? fiberFor(element) : null;
    while (fiber) {
        const hrid = fiber.memoizedProps?.actionDetail?.hrid;
        if (typeof hrid === 'string' && hrid.startsWith('/actions/')) return hrid;
        fiber = fiber.return;
    }
    return null;
}

/**
 * Find an action HRID from its display name.
 * Tries exact match first, then ★ ↔ (R) variants for refined items.
 * @param {string} actionName - Display name of the action
 * @returns {string|null} Action HRID or null if not found
 */
export function getActionHridFromName(actionName) {
    return actionNames.lookup(dataManager.getInitClientData()?.actionDetailMap, actionName);
}

/**
 * Find an item HRID from its display name.
 * Tries exact match first, then ★ ↔ (R) variants for refined items.
 * @param {string} itemName - Display name of the item
 * @returns {string|null} Item HRID or null if not found
 */
export function getItemHridFromName(itemName) {
    return itemNames.lookup(dataManager.getInitClientData()?.itemDetailMap, itemName);
}

/**
 * Get the coin cost of an item from the in-game shop.
 * Returns 0 if the item is not available in the shop or not purchasable with coins.
 * @param {string} itemHrid - Item HRID
 * @returns {number} Coin cost, or 0 if not available in shop
 */
/**
 * The coin price of an item in the in-game shop when coins are its whole price: 0 when it is not
 * sold there or the offer also asks for another currency, which a coin figure would understate.
 * @param {string} itemHrid
 * @returns {number} Coins, or 0
 */
export function getShopCoinOnlyCost(itemHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.shopItemDetailMap) return 0;
    const testerOn = testerShopEnabled();
    for (const [key, shopItem] of Object.entries(gameData.shopItemDetailMap)) {
        if (!testerOn && isTesterShopEntry(shopItem, key)) continue;
        if (shopItem.itemHrid !== itemHrid || !shopItem.costs?.length) continue;
        if (shopItem.costs.every((cost) => cost.itemHrid === '/items/coin')) {
            return shopItem.costs.reduce((sum, cost) => sum + (Number(cost.count) || 0), 0);
        }
    }
    return 0;
}

export function getShopCoinCost(itemHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.shopItemDetailMap) return 0;

    // The test server's Tester tab is a price source only when asked for —
    // see tester-shop.js — so its entries are skipped otherwise
    const testerOn = testerShopEnabled();
    for (const [key, shopItem] of Object.entries(gameData.shopItemDetailMap)) {
        if (!testerOn && isTesterShopEntry(shopItem, key)) continue;
        if (shopItem.itemHrid === itemHrid) {
            if (shopItem.costs && shopItem.costs.length > 0) {
                const coinCost = shopItem.costs.find((cost) => cost.itemHrid === '/items/coin');
                if (coinCost) {
                    return coinCost.count;
                }
            }
        }
    }

    return 0;
}
