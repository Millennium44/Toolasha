/**
 * The test server's Tester shop as a price source.
 *
 * The test server sells most things for coins in a shop tab called Tester —
 * materials at a flat price, equipment at +10, Philosopher's Mirrors at a
 * fraction of their live price — and a character there has coins to spare.
 * Anything costed against the marketplace (house levels, ability books,
 * enhancement materials, the simulators' upgrade rows) is therefore costed
 * wrong for what a tester actually does, which is walk to the shop.
 *
 * Opt-in, and only on the test server: live has no Tester tab, and nobody on
 * live wants their profit figures floored at a shop that does not exist. The
 * setting is hidden off the test server.
 *
 * ## What a piece of equipment costs there
 *
 * Up to the level the shop sells it at (+10 unless the entry says otherwise),
 * the shop price. Above that, the mirror route: a Philosopher's Mirror used as
 * protection guarantees the attempt and instead consumes a copy of the item one
 * level below, so each step up is a mirror plus the whole of the level beneath
 * — the cost doubles per level, plus a mirror. That is the recommended route
 * on a server where coins are free, and it is what is priced here.
 *
 * Nothing here is certain about the shop's data shape beyond what the game
 * data carries for every shop: a `shopItemDetailMap` entry with `itemHrid`
 * and a `costs` list. The Tester entries are told apart by their category or
 * hrid naming the tab.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { isTestServer } from './game-server.js';

/** The setting that turns the shop on as a price source */
export const TESTER_SHOP_SETTING = 'pricing_testerShop';

/** The protection that guarantees an enhancement attempt */
export const MIRROR_HRID = '/items/philosophers_mirror';

/** The level the shop sells equipment at when its entry does not say */
export const DEFAULT_SHOP_GEAR_LEVEL = 10;

/** A mirror's live-ish price, for a shop map that does not list one */
const MIRROR_FALLBACK_PRICE = 10_000_000;

/**
 * Whether a shop entry belongs to the Tester tab.
 * @param {Object} entry - A `shopItemDetailMap` value
 * @param {string} [key] - Its key in the map, for entries that carry no hrid of their own
 * @returns {boolean}
 */
export function isTesterShopEntry(entry, key = '') {
    const fields = [entry?.category, entry?.categoryHrid, entry?.shopCategoryHrid, entry?.hrid, key];
    return fields.some((value) => /tester/i.test(String(value || '')));
}

/**
 * Whether Tester-shop pricing is on: the test server, and the setting.
 * @param {Object} [options] - Injectable for tests
 * @param {boolean} [options.testServer] - Defaults to the hostname check
 * @param {boolean} [options.setting] - Defaults to the stored setting
 * @returns {boolean}
 */
export function testerShopEnabled({ testServer, setting } = {}) {
    const onTest = testServer === undefined ? isTestServer() : testServer;
    if (!onTest) return false;
    const on = setting === undefined ? config.getSetting?.(TESTER_SHOP_SETTING) : setting;
    return Boolean(on);
}

/**
 * The Tester shop's entry for an item, reduced to what pricing needs.
 * @param {string} itemHrid - Item hrid
 * @param {Object} [shopMap] - `shopItemDetailMap`; read from the client by default
 * @returns {{coinCost: number, enhancementLevel: number|null}|null} Null when not sold there for coins
 */
export function testerShopEntry(itemHrid, shopMap = dataManager.getInitClientData?.()?.shopItemDetailMap) {
    if (!itemHrid || !shopMap) return null;
    let best = null;
    for (const [key, entry] of Object.entries(shopMap)) {
        if (entry?.itemHrid !== itemHrid || !isTesterShopEntry(entry, key)) continue;
        const coins = (entry.costs || []).find((cost) => cost?.itemHrid === '/items/coin');
        const coinCost = Number(coins?.count) || 0;
        if (!(coinCost > 0)) continue;
        const level = Number.isFinite(Number(entry.enhancementLevel)) ? Number(entry.enhancementLevel) : null;
        if (!best || coinCost < best.coinCost) best = { coinCost, enhancementLevel: level };
    }
    return best;
}

/**
 * What the Tester shop charges for an item, 0 when it is not sold there.
 * @param {string} itemHrid - Item hrid
 * @param {Object} [shopMap] - `shopItemDetailMap`
 * @returns {number}
 */
export function testerShopCoinCost(itemHrid, shopMap) {
    return testerShopEntry(itemHrid, shopMap)?.coinCost || 0;
}

/**
 * The price of a piece of equipment at a level, bought from the shop and
 * mirrored up from there.
 *
 * @param {string} itemHrid - Item hrid
 * @param {number} level - Enhancement level wanted
 * @param {Object} [options]
 * @param {Object} [options.shopMap] - `shopItemDetailMap`
 * @param {Object} [options.itemDetailMap] - `itemDetailMap`, to tell equipment from a material
 * @returns {{price: number, route: 'shop'|'mirror', shopLevel: number, mirrors: number, mirrorPrice: number}|null}
 *   Null when the shop does not sell the item
 */
export function testerGearPrice(itemHrid, level, { shopMap, itemDetailMap } = {}) {
    const map = shopMap === undefined ? dataManager.getInitClientData?.()?.shopItemDetailMap : shopMap;
    const items = itemDetailMap === undefined ? dataManager.getInitClientData?.()?.itemDetailMap : itemDetailMap;
    const entry = testerShopEntry(itemHrid, map);
    if (!entry) return null;

    const isGear = Boolean(items?.[itemHrid]?.equipmentDetail);
    const shopLevel = entry.enhancementLevel ?? (isGear ? DEFAULT_SHOP_GEAR_LEVEL : 0);
    const target = Math.max(0, Math.floor(Number(level) || 0));
    const mirrorPrice = testerShopCoinCost(MIRROR_HRID, map) || MIRROR_FALLBACK_PRICE;

    if (target <= shopLevel) {
        return { price: entry.coinCost, route: 'shop', shopLevel, mirrors: 0, mirrorPrice };
    }

    // Each level above the shop's: a mirror, plus a copy of the level below —
    // which is itself a mirror plus a copy of the level below that
    let price = entry.coinCost;
    let mirrors = 0;
    for (let step = shopLevel; step < target; step++) {
        price = price * 2 + mirrorPrice;
        mirrors += 1;
    }
    return { price, route: 'mirror', shopLevel, mirrors, mirrorPrice };
}
