/**
 * Patient +1 tick.
 *
 * A patient order sits in a queue behind everyone already at the best price, so
 * a trader who actually wants it filled places it one market tick better: a buy
 * one tick above the best bid, a sell one tick below the best ask. With
 * `profitCalc_patientTick` on, profit pricing assumes exactly that on the patient
 * side of the chosen mode. Instant sides (buying at the ask, selling at the bid)
 * are never touched — there is no queue to jump.
 *
 * One helper, so the central `getItemPriceInfo` path and the few modules that map
 * a pricing mode onto a raw book themselves all move by the same tick.
 */

import config from '../core/config.js';
import { nextPriceUp, nextPriceDown, clampToBand } from './market-values.js';

/** The setting that turns the tick on. */
export const PATIENT_TICK_SETTING = 'profitCalc_patientTick';

/**
 * Whether profit pricing should improve patient quotes by one tick.
 * @returns {boolean}
 */
export function isPatientTickEnabled() {
    // getSettingValue, not getSetting: a checkbox reads the same either way (the
    // schema default is false), and this sits under every profit price, so it
    // takes the accessor every pricing path — and every test mock of config — has
    return config.getSettingValue(PATIENT_TICK_SETTING, false) === true;
}

/**
 * Improve a patient-side quote by one market tick, when the setting is on.
 *
 * Only a buy priced at the bid (moves up) or a sell priced at the ask (moves
 * down) changes; every other side/basis pair comes back as given. The tick never
 * crosses the spread — a bid that would reach the ask, or an ask that would reach
 * the bid, stays where it was, because that order would fill instantly at the
 * other side's price instead of queueing. With an item hrid the result is pulled
 * back into the item's tradable range.
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
 * @param {number} [book.enhancementLevel=0] - Enhancement level
 * @returns {number|null} The improved price, or `price` unchanged
 */
export function patientTickPrice(price, side, basis, book = {}) {
    if (typeof price !== 'number' || !(price > 0)) return price;
    const buyAtBid = side === 'buy' && basis === 'bid';
    const sellAtAsk = side === 'sell' && basis === 'ask';
    if (!buyAtBid && !sellAtAsk) return price;
    if (!isPatientTickEnabled()) return price;

    const { ask = null, bid = null, itemHrid = null, enhancementLevel = 0 } = book;
    let improved;
    if (buyAtBid) {
        improved = nextPriceUp(price);
        if (typeof ask === 'number' && ask > 0 && improved >= ask) return price;
    } else {
        improved = nextPriceDown(price);
        if (improved >= price) return price;
        if (typeof bid === 'number' && bid > 0 && improved <= bid) return price;
    }

    if (itemHrid) {
        improved = clampToBand(improved, itemHrid, enhancementLevel);
    }
    return improved;
}
