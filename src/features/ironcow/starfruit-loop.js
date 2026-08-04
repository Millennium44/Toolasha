/**
 * What the Star Fruit loop earns an iron cow, and what that buys in cowbells.
 *
 * ## The one constraint that shapes everything here
 *
 * An iron cow cannot sell on the marketplace. It can only *buy* — and in
 * practice only cowbells. So every market sell price in the repository is the
 * wrong number for this loop: nothing in it is ever sold. The fruit is
 * decomposed, the essence is coinified, and the only gold that exists comes out
 * of coinify, whose output is `sellPrice × bulkMultiplier × 5` — the game's own
 * vendor formula, not a market quote.
 *
 * This module therefore reads three things and only three things out of the
 * calculators it composes:
 *
 *  - **rates** — items and actions per hour, which are price-independent;
 *  - **coinify's coin output**, which is the vendor formula above;
 *  - **the decompose coin fee**, from `utils/alchemy-fees.js`.
 *
 * It never reads `profitPerHour`, `revenuePerHour`, `materialCost` or any
 * `dropRevenues[].price` off those results, because every one of those is a
 * market valuation of something this character cannot sell. `loopBasis()` says
 * so in one line for anything that wants to check, and the tests assert it by
 * moving every market price and watching the loop not move.
 *
 * ## Why the loop is costed per fruit and not per hour
 *
 * The three actions do not run at once. They queue, and the queue runs one at a
 * time, so an hour of "the loop" is an hour split between foraging, decomposing
 * and coinifying in whatever ratio keeps the fruit moving. The honest unit is
 * therefore one fruit all the way through: the time it takes to forage, the time
 * to decompose, the time to coinify what came out, and the coins at the end.
 * Gold per hour is that divided by that.
 *
 * ## Why no catalyst
 *
 * The alchemy calculator's default is a search over six catalyst-and-tea
 * combinations, priced at market. An iron cow cannot buy a catalyst, so a quote
 * that assumes one is a quote for a loop it cannot run. The success rates below
 * are recomputed through the calculator's own public
 * `calculateSuccessRateBreakdown` with no catalyst and the character's live tea
 * bonus — teas being self-brewed, and so free. Catalysts found as drops only
 * make the real thing better than this figure.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { getAlchemyCoinCost } from '../../utils/alchemy-fees.js';
import { getAlchemySuccessBonus } from '../../utils/buff-parser.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { getItemPrice, getPricingMode } from '../../utils/market-data.js';
import { HOURS_PER_DAY } from '../../utils/profit-constants.js';
import { resolveLoopItems } from './loop-items.js';

/** Alchemy is paid for in gold, and a loop that runs dry stops. */
export const LOW_GOLD_BUFFER = 3_000_000;

/** Decompose, coinify, forage — the loop does not close with fewer. */
export const LOOP_QUEUE_SLOTS = 3;

/**
 * The offline window the plan assumes.
 *
 * Nothing in `init_client_data` or in anything the websocket reports states the
 * account's offline cap, so this is the plan's own figure and is labelled as an
 * assumption wherever it is shown. If the game ever starts reporting it,
 * `offlineWindow()` is the one place to teach.
 */
export const ASSUMED_OFFLINE_HOURS = 16;

const COIN = '/items/coin';
const COWBELL = '/items/cowbell';
const COWBELL_BAG = '/items/bag_of_10_cowbells';
const COWBELLS_PER_BAG = 10;
const HOURS_PER_WEEK = 168;

/**
 * The one line that says what the loop's gold is made of.
 *
 * Exists to be asserted against: a change that starts valuing any part of this
 * loop at a market sell price has to come through here and say so.
 *
 * @returns {{gold: string, sells: boolean, note: string}}
 */
export function loopBasis() {
    return {
        gold: 'coinify',
        sells: false,
        note: 'An iron cow sells nothing. All gold in this loop is coinify output at the vendor formula.',
    };
}

/**
 * The offline window, and whether it is known or assumed.
 * @returns {{hours: number, assumed: boolean}}
 */
export function offlineWindow() {
    const reported = dataManager.characterData?.offlineHours;
    if (typeof reported === 'number' && reported > 0) return { hours: reported, assumed: false };
    return { hours: ASSUMED_OFFLINE_HOURS, assumed: true };
}

/**
 * The success rate this character actually gets, with no catalyst bought.
 * @param {Object} result - A result from the alchemy calculator
 * @returns {number} Success rate, 0 to 1
 */
function ironCowSuccessRate(result) {
    const breakdown = result?.successRateBreakdown || {};
    return alchemyProfitCalculator.calculateSuccessRateBreakdown(
        breakdown.base ?? 0,
        0,
        getAlchemySuccessBonus(),
        breakdown.levelPenalty ?? 0
    ).total;
}

/**
 * What a cowbell costs, bought the cheaper of the two ways.
 *
 * Cowbells are sold loose and in bags of ten, and the bag is not always ten
 * times the loose price. Since buying them is the entire point of the gold,
 * quoting the wrong one misprices the whole projection.
 *
 * @returns {{price: number|null, source: 'loose'|'bag'|null, loose: number|null, bag: number|null,
 *   pricingMode: string}}
 */
export function cowbellPricing() {
    // 'buy' side, because buying cowbells is the only market act available.
    const loose = getItemPrice(COWBELL, { context: 'profit', side: 'buy' });
    const bag = getItemPrice(COWBELL_BAG, { context: 'profit', side: 'buy' });
    const pricingMode = getPricingMode('profit', 'buy');

    const perBellFromBag = typeof bag === 'number' && bag > 0 ? bag / COWBELLS_PER_BAG : null;
    const perBellLoose = typeof loose === 'number' && loose > 0 ? loose : null;

    let price = null;
    let source = null;
    if (perBellLoose !== null && (perBellFromBag === null || perBellLoose <= perBellFromBag)) {
        price = perBellLoose;
        source = 'loose';
    } else if (perBellFromBag !== null) {
        price = perBellFromBag;
        source = 'bag';
    }

    return { price, source, loose: perBellLoose, bag: perBellFromBag, pricingMode };
}

/**
 * Bells earned by a gold rate, at a bell price.
 * @param {number} goldPerHour - What the loop earns
 * @param {number|null} bellPrice - Gold per bell
 * @returns {{perHour: number, perDay: number, perWeek: number}|null} Null with no bell price
 */
export function bellsFrom(goldPerHour, bellPrice) {
    if (!Number.isFinite(goldPerHour) || !Number.isFinite(bellPrice) || bellPrice <= 0) return null;
    const perHour = goldPerHour / bellPrice;
    return {
        perHour,
        perDay: perHour * HOURS_PER_DAY,
        perWeek: perHour * HOURS_PER_WEEK,
    };
}

/**
 * Cost the loop, one fruit at a time.
 *
 * Composes three existing calculators and takes only their rates and coinify's
 * coin output from them — see the module doc for why anything else would be the
 * wrong number for an iron cow.
 *
 * @returns {Promise<Object|null>} The loop, or null when it cannot be costed
 */
export async function calculateStarfruitLoop() {
    try {
        const items = resolveLoopItems();
        if (!items) return null;

        const foraging = await calculateGatheringProfit(items.forageActionHrid);
        const decompose = alchemyProfitCalculator.calculateDecomposeProfit(items.starfruitHrid);
        const coinify = alchemyProfitCalculator.calculateCoinifyProfit(items.essenceHrid);

        const missing = [];
        if (!foraging) missing.push(`foraging ${items.starfruitName}`);
        if (!decompose) missing.push(`decomposing ${items.starfruitName}`);
        if (!coinify) missing.push(`coinifying ${items.essenceName}`);
        if (missing.length) return { items, missing, basis: loopBasis() };

        // Rate only. The revenue on this object is a market valuation of fruit
        // that is never sold.
        const fruitPerHour =
            foraging.baseOutputs?.find((output) => output.itemHrid === items.starfruitHrid)?.itemsPerHour || 0;

        const decomposeRate = ironCowSuccessRate(decompose);
        const coinifyRate = ironCowSuccessRate(coinify);

        const decomposeActionsPerHour = decompose.actionsPerHour || 0;
        const coinifyActionsPerHour = coinify.actionsPerHour || 0;

        // Straight from game data: how much essence one fruit becomes, and how
        // much essence one coinify consumes.
        const essencePerSuccess = items.essencePerDecompose;
        const coinifyBulk =
            dataManager.getItemDetails(items.essenceHrid)?.alchemyDetail?.bulkMultiplier ||
            coinify.requirementCosts?.find((cost) => cost.itemHrid === items.essenceHrid)?.count ||
            1;

        // The vendor formula, taken off the calculator rather than restated.
        const coinsPerSuccess = coinify.dropRevenues?.find((drop) => drop.itemHrid === COIN)?.count || 0;

        // The only gold the loop spends. Coinify is free (see utils/alchemy-fees.js).
        const decomposeFee = getAlchemyCoinCost(dataManager.getItemDetails(items.starfruitHrid), 'decompose');

        if (fruitPerHour <= 0 || decomposeActionsPerHour <= 0 || coinifyActionsPerHour <= 0) {
            return { items, missing: ['a rate for one of the three actions'], basis: loopBasis() };
        }

        // One fruit, all the way through.
        const forageHours = 1 / fruitPerHour;
        const decomposeHours = 1 / decomposeActionsPerHour;
        const essencePerFruit = essencePerSuccess * decomposeRate;
        const coinifyActionsPerFruit = coinifyBulk > 0 ? essencePerFruit / coinifyBulk : 0;
        const coinifyHours = coinifyActionsPerFruit / coinifyActionsPerHour;

        const goldInPerFruit = coinifyActionsPerFruit * coinsPerSuccess * coinifyRate;
        const goldOutPerFruit = decomposeFee;
        const netPerFruit = goldInPerFruit - goldOutPerFruit;

        const hoursPerFruit = forageHours + decomposeHours + coinifyHours;
        const goldPerHour = hoursPerFruit > 0 ? netPerFruit / hoursPerFruit : 0;

        const bells = cowbellPricing();

        return {
            items,
            missing: [],
            basis: loopBasis(),

            // What the loop is doing
            fruitPerHour,
            essencePerFruit,
            decomposeRate,
            coinifyRate,
            decomposeActionsPerHour,
            coinifyActionsPerHour,
            coinifyBulk,
            coinsPerSuccess,

            // What one fruit is worth, and what it costs in time
            goldInPerFruit,
            goldOutPerFruit,
            netPerFruit,
            hoursPerFruit,
            timeShare: {
                forage: hoursPerFruit > 0 ? forageHours / hoursPerFruit : 0,
                decompose: hoursPerFruit > 0 ? decomposeHours / hoursPerFruit : 0,
                coinify: hoursPerFruit > 0 ? coinifyHours / hoursPerFruit : 0,
            },

            // What that is per hour, and in bells
            goldPerHour,
            goldPerDay: goldPerHour * HOURS_PER_DAY,
            alchemyFeePerHour: hoursPerFruit > 0 ? goldOutPerFruit / hoursPerFruit : 0,
            bellPrice: bells.price,
            bellPricing: bells,
            bells: bellsFrom(goldPerHour, bells.price),

            // The convention the rest of the script prints prices under
            pricingMode: config.getSettingValue('profitCalc_pricingMode', 'hybrid'),
            computedAt: Date.now(),
        };
    } catch (error) {
        console.error('[IronCow] Could not cost the Star Fruit loop:', error);
        return null;
    }
}

/**
 * What is wrong with the loop as it is set up right now.
 *
 * @param {Object} state - From `readCharacterState`
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @returns {Array<{id: string, severity: 'warn'|'info', text: string}>} In the order they matter
 */
export function loopWarnings(state, loop) {
    const warnings = [];
    const coins = state?.coins || 0;
    const queueLength = state?.queueLength || 0;

    if (coins < LOW_GOLD_BUFFER) {
        const hourly = loop?.alchemyFeePerHour || 0;
        const runsFor = hourly > 0 ? ` — about ${Math.round(coins / hourly)}h of decompose fees at this rate` : '';
        warnings.push({
            id: 'gold',
            severity: 'warn',
            text:
                `Gold buffer is under ${formatWithSeparator(LOW_GOLD_BUFFER)}${runsFor}. ` +
                'Alchemy is paid for in gold; a loop that runs dry stops.',
        });
    }

    if (queueLength < LOOP_QUEUE_SLOTS) {
        warnings.push({
            id: 'queue',
            severity: 'warn',
            text:
                `The queue has ${queueLength} of the ${LOOP_QUEUE_SLOTS} actions the loop needs ` +
                '(decompose, coinify, forage). With fewer it stops partway round.',
        });
    }

    const offline = offlineWindow();
    warnings.push({
        id: 'offline',
        severity: 'info',
        text: offline.assumed
            ? `Queue enough for about ${offline.hours}h — the plan's assumed offline window. ` +
              'The game does not report the real cap, so this is the plan’s figure, not yours.'
            : `Queue enough for ${offline.hours}h, which is your offline window.`,
    });

    if (loop && loop.missing?.length === 0 && loop.bellPrice === null) {
        warnings.push({
            id: 'bellprice',
            severity: 'warn',
            text: 'No market price for a cowbell yet, so the bell figures cannot be quoted.',
        });
    }

    return warnings;
}
