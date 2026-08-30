/**
 * The success rate an alchemy session was started expecting.
 *
 * The three alchemy trackers have always recorded what happened —
 * `totalAttempts` and `totalSuccesses`, uncapped, going back as far as the
 * account does. What none of them recorded is what was *supposed* to happen, and
 * without that the observed rate cannot be checked against anything: comparing
 * an old session to today's model measures the model's history, not its
 * accuracy. Tea bonuses change, catalysts are swapped, the character levels past
 * the item and the under-level penalty vanishes, and the script's own formula
 * gets fixed. Every one of those moves the predicted rate, and none of them
 * leaves a trace on a session that only wrote down its outcome.
 *
 * So the prediction is stamped at the moment the session starts, out of the same
 * `calculateSuccessRateBreakdown` the profit rankings use, with the same base
 * rates, catalyst bonuses and level penalty. A session that already existed when
 * this file landed carries no stamp and is excluded from calibration for good —
 * it is never retro-stamped, because a stamp computed later is exactly the lie
 * this module exists to prevent. History fills forward only.
 *
 * The live catalyst is read from the action panel's own slot, the way the
 * calculator's live-setup path reads it: it is the catalyst the run will
 * actually be played with, and it is worth 15 or 25 percent of the rate.
 *
 * Everything the calculator knows is asked of the calculator singleton rather
 * than imported as a constant: the trackers are in the UI bundle and the
 * calculator is in the market one, where a named import compiles to a property
 * read off a global that does not carry it.
 */

import dataManager from '../../core/data-manager.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';

/** The three kinds of alchemy a session can be, each with its own model */
export const ALCHEMY_KINDS = ['transmute', 'decompose', 'coinify'];

/**
 * The catalyst sitting in the action panel's catalyst slot right now.
 *
 * Item icons carry the sprite id on `xlink:href` and only some carry a plain
 * `href`; reading one alone leaves the live catalyst unseen on whichever the
 * game happens to emit, which is the same bug `_liveSetupCombo` had.
 *
 * @returns {string|null} Catalyst item HRID, or null when the slot is empty
 */
export function readLiveCatalyst() {
    try {
        const use = document.querySelector(
            '[class*="SkillActionDetail_catalystItemInputContainer"] [class*="Item_itemContainer"] svg use'
        );
        const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || null;
        const icon = href?.match(/#(.+)$/)?.[1] || null;
        if (!icon) return null;
        const hrid = `/items/${icon}`;
        // Anything the calculator would not pay a bonus for is not a catalyst,
        // and the calculator is the one that decides
        return alchemyProfitCalculator.catalystSuccessBonus(hrid) > 0 ? hrid : null;
    } catch (error) {
        console.error('[AlchemySuccessStamp] Could not read the catalyst slot:', error);
        return null;
    }
}

/**
 * The stamp to put on a session that is starting now.
 *
 * Returns null rather than a zero when the rate cannot be computed — an item
 * with no transmute drop table, or game data that has not arrived. A session
 * stamped with a rate nobody predicted would be worse than an unstamped one,
 * because the unstamped one is at least excluded.
 *
 * @param {string} kind - `transmute` | `decompose` | `coinify`
 * @param {string} inputItemHrid - The item being worked on
 * @param {number} [now] - Clock, for the stamp's own timestamp
 * @returns {{predictedRate: number, predictedAt: number, predictedCatalystHrid: string|null}|null}
 */
export function predictedSuccessStamp(kind, inputItemHrid, now = Date.now()) {
    try {
        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        const baseRate = alchemyProfitCalculator.baseSuccessRateFor(kind, itemDetails);
        if (!(baseRate > 0)) return null;

        const catalystHrid = readLiveCatalyst();
        // The penalty keys off the ITEM's level, not the action, so all three
        // kinds take it — an under-levelled character is quoted the full base
        // rate without it
        const levelPenalty = alchemyProfitCalculator.getUnderLevelPenalty(itemDetails?.itemLevel || 1);
        // `null` tea override means "read the live buffs", which is what the
        // rankings do and therefore what is being calibrated
        const breakdown = alchemyProfitCalculator.calculateSuccessRateBreakdown(
            baseRate,
            alchemyProfitCalculator.catalystSuccessBonus(catalystHrid),
            null,
            levelPenalty
        );

        const predictedRate = breakdown?.total;
        if (!Number.isFinite(predictedRate) || predictedRate <= 0) return null;

        return { predictedRate, predictedAt: now, predictedCatalystHrid: catalystHrid };
    } catch (error) {
        console.error('[AlchemySuccessStamp] Could not stamp the predicted rate:', error);
        return null;
    }
}

export default { predictedSuccessStamp, readLiveCatalyst, ALCHEMY_KINDS };
