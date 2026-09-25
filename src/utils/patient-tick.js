/**
 * Patient one-tick-in.
 *
 * A patient order sits in a queue behind everyone already at the best price, so
 * a trader who actually wants it filled places it one market tick better: a buy
 * one tick above the best bid, a sell one tick below the best ask. Each side has
 * its own switch — `profitCalc_patientTickBuy` and `profitCalc_patientTickSell` —
 * and with one on, profit pricing assumes exactly that on that side whenever the
 * chosen mode prices it patiently. Instant sides (buying at the ask, selling at
 * the bid) are never touched — there is no queue to jump.
 *
 * One helper, so the central `getItemPriceInfo` path and the few modules that map
 * a pricing mode onto a raw book themselves all move by the same tick.
 */

import config from '../core/config.js';
import { nextPriceUp, nextPriceDown, clampToBand } from './market-values.js';

/** The setting that ticks patient buys up from the bid. */
export const PATIENT_TICK_BUY_SETTING = 'profitCalc_patientTickBuy';

/** The setting that ticks patient sells down from the ask. */
export const PATIENT_TICK_SELL_SETTING = 'profitCalc_patientTickSell';

/**
 * Both tick settings, for anything that listens for a change to either.
 * `core/config.js` and `core/settings-storage.js` name the same two literals
 * (core loads before utils and cannot import this); a test pins them together.
 */
export const PATIENT_TICK_SETTING_KEYS = Object.freeze([PATIENT_TICK_BUY_SETTING, PATIENT_TICK_SELL_SETTING]);

/**
 * The tick setting for a transaction side.
 * @param {'buy'|'sell'} side - Transaction side
 * @returns {string|null} The setting key, or null for anything that is not a side
 */
export function patientTickSettingFor(side) {
    if (side === 'buy') return PATIENT_TICK_BUY_SETTING;
    if (side === 'sell') return PATIENT_TICK_SELL_SETTING;
    return null;
}

/**
 * Whether profit pricing should improve a patient quote on `side` by one tick.
 * @param {'buy'|'sell'} side - Transaction side
 * @returns {boolean}
 */
export function isPatientTickOn(side) {
    const key = patientTickSettingFor(side);
    if (!key) return false;
    // getSettingValue, not getSetting: a checkbox reads the same either way (the
    // schema default is false), and this sits under every profit price, so it
    // takes the accessor every pricing path — and every test mock of config — has
    return config.getSettingValue(key, false) === true;
}

/**
 * Improve a patient-side quote by one market tick, when that side's setting is on.
 *
 * Only a buy priced at the bid (moves up, under the buy setting) or a sell priced
 * at the ask (moves down, under the sell setting) changes; every other side/basis
 * pair comes back as given. The tick never crosses the spread — a bid that would
 * reach the ask, or an ask that would reach the bid, stays where it was, because
 * that order would fill instantly at the other side's price instead of queueing.
 * With an item hrid the result is pulled back into the item's tradable range.
 *
 * The caller decides whether the quote is a real listing: an estimate filled in
 * from the official value map, or a user's custom price, has no queue to jump and
 * should not be passed here.
 *
 * @param {number|null} price - The quote at `basis`
 * @param {'buy'|'sell'} side - Transaction side
 * @param {string} basis - The book side the quote came from ('ask'|'bid'|'average')
 * @param {Object} [book] - The rest of the book, for the no-crossing check and the band
 * @param {number|null} [book.ask] - Best ask (a buy never ticks up to it)
 * @param {number|null} [book.bid] - Best bid (a sell never ticks down to it)
 * @param {string} [book.itemHrid] - Item HRID, to clamp into the tradable range
 * @param {number} [book.enhancementLevel=0] - Enhancement level; sets the tick size and the band
 * @returns {number|null} The improved price, or `price` unchanged
 */
export function patientTickPrice(price, side, basis, book = {}) {
    if (typeof price !== 'number' || !(price > 0)) return price;
    const buyAtBid = side === 'buy' && basis === 'bid';
    const sellAtAsk = side === 'sell' && basis === 'ask';
    if (!buyAtBid && !sellAtAsk) return price;
    if (!isPatientTickOn(side)) return price;

    const { ask = null, bid = null, itemHrid = null, enhancementLevel = 0 } = book;
    let improved;
    if (buyAtBid) {
        improved = nextPriceUp(price, enhancementLevel);
        if (typeof ask === 'number' && ask > 0 && improved >= ask) return price;
    } else {
        improved = nextPriceDown(price, enhancementLevel);
        if (improved >= price) return price;
        if (typeof bid === 'number' && bid > 0 && improved <= bid) return price;
    }

    if (itemHrid) {
        improved = clampToBand(improved, itemHrid, enhancementLevel);
    }
    return improved;
}
