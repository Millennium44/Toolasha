/**
 * Enhancement profit / luck math
 *
 * Two readings of an enhancement session, kept as pure functions so the
 * arithmetic can be tested without a DOM:
 *
 *  - cost vs expected (luck): what this run actually paid against what the
 *    prediction expected it to pay, holding unit prices at this run's own — so
 *    the gap is attempt/protection luck, not market drift.
 *  - value vs cost (worth it): the +N item's resale value minus the +0 base you
 *    gave up minus what you spent — did enhancing it pay off.
 */

import { MARKET_TAX } from '../../utils/profit-constants.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';

/**
 * Cost this run paid vs the prediction's expected cost, at this run's own unit
 * prices. Whole-session; returns null when it cannot be read honestly:
 *  - no attempts or no stored prediction,
 *  - an extended (multi-leg) session, where the prediction covers only the last
 *    leg but the tracked cost covers every leg.
 *
 * @param {Object} session - Live enhancement session
 * @param {{attempts: number, protections: number}} [leg] - current-leg counters
 * @returns {{actualCost:number, expectedCost:number, diff:number, factor:number,
 *   materialActual:number, materialExpected:number, protActual:number,
 *   protExpected:number, hasProt:boolean}|null}
 */
export function costVsExpected(session, leg = null) {
    const predictions = session?.predictions;
    const totalAttempts = session?.totalAttempts || 0;
    if (!predictions || totalAttempts <= 0) return null;
    // Cost is tracked per session, not per leg — only compare when the whole
    // session is a single leg, or the expected (one leg) undercounts the actual.
    if (leg && leg.attempts !== totalAttempts) return null;

    const expAtt = predictions.expectedAttempts || 0;
    const expProt = predictions.expectedProtections || 0;
    if (expAtt <= 0) return null;

    const materialActual = Object.values(session.materialCosts || {}).reduce((sum, m) => sum + (m.totalCost || 0), 0);
    const coinActual = session.coinCost || 0;
    const protActual = session.protectionCost || 0;
    const protCount = session.protectionCount || 0;

    // Materials and coins are spent per attempt; protection per protect.
    const perAttempt = (materialActual + coinActual) / totalAttempts;
    const protUnit = protCount > 0 ? protActual / protCount : 0;

    const materialExpected = perAttempt * expAtt;
    const protExpected = protUnit * expProt;
    const expectedCost = materialExpected + protExpected;
    const actualCost = materialActual + coinActual + protActual;
    if (expectedCost <= 0) return null;

    return {
        actualCost,
        expectedCost,
        diff: expectedCost - actualCost, // positive → came in below expected (lucky)
        factor: actualCost / expectedCost,
        materialActual: materialActual + coinActual,
        materialExpected,
        protActual,
        protExpected,
        hasProt: protCount > 0 || expProt > 0,
    };
}

/** Marketplace sell fee — the cut taken when a listing fills. */
export const MARKET_SELL_TAX = MARKET_TAX;

/**
 * Whether the enhanced item is worth more than it cost to make: the +N resale
 * value (after the market sell fee) minus the piece the session started from
 * minus what was spent. Answers "was enhancing this worth it vs just selling
 * what I put on the bench?".
 *
 * The piece given up is the one at the session's start level, not +0: a session
 * that picks up a +5 only spends from +5, so netting that spend against a +0
 * leaves the +0 to +5 path out of the cost entirely.
 *
 * @param {Object} session - Live enhancement session
 * @param {(hrid: string, level: number) => ({bid:number, ask:number}|null)} getPrices
 *   - Market price lookup (injected for testability)
 * @param {number} [sellTax] - Fraction taken on a sale; `MARKET_SELL_TAX`, or `0` for the
 *   current Iron Cow character, which has no market access to sell an enhanced piece on
 * @returns {{level:number, baseLevel:number, spent:number, valueN:number|null, value0:number|null,
 *   net:number|null, sellTax:number}|null} `value0` is the bid at `baseLevel`, the session's start level
 */
export function valueVsCost(session, getPrices, sellTax = isIronCowCharacter() ? 0 : MARKET_SELL_TAX) {
    if (!session?.itemHrid) return null;
    const level = session.currentLevel || 0;
    if (level <= 0) return null;

    const baseLevel = Math.max(0, Number(session.startLevel) || 0);
    const spent = session.totalCost || 0;
    const nPrices = getPrices?.(session.itemHrid, level) || null;
    const basePrices = getPrices?.(session.itemHrid, baseLevel) || null;
    const valueN = nPrices?.bid ?? null;
    const value0 = basePrices?.bid ?? null;

    if (valueN == null || value0 == null) return { level, baseLevel, spent, valueN, value0, net: null, sellTax };
    const keep = 1 - sellTax;
    return { level, baseLevel, spent, valueN, value0, net: valueN * keep - value0 * keep - spent, sellTax };
}
