/**
 * The Iron Bell queue as one cycle: what is left of it, when it ends, what it earns, and where
 * its gold runs out.
 *
 * Nothing is modelled here. Every figure is a sum over the stages `walkQueueCoins` already walked
 * through the action-time engine's own ledger — the counts, fees, coinify proceeds and seconds the
 * queue tooltip and the panel's reserve read — so the strip on the action bar and the Iron Bell
 * panel cannot disagree about the same queue.
 *
 * The horizon is the queue, not the offline window: a farm is often queued for weeks. The offline
 * cap is noted beside it when the queue outlasts it, because offline the game stops at the cap.
 */

import { COWBELLS_PER_BAG } from './coin-reserve.js';
import { formatDateTime, formatKMB, formatWithSeparator, timeReadable } from '../../utils/formatters.js';
import { compareActionQueueOrder } from '../../utils/combat-actions.js';

/** The alchemy actions the loop uses; the item is chosen in the slot, so it is read off the hash */
export const DECOMPOSE_ACTION = '/actions/alchemy/decompose';
export const COINIFY_ACTION = '/actions/alchemy/coinify';

/**
 * Data-manager events that can change what the queue spends or earns: coins and materials, the
 * queue itself, and everything that moves a success rate, an efficiency or a level penalty.
 */
export const LIVE_EVENTS = [
    'items_updated',
    'actions_updated',
    'skills_updated',
    'buffs_updated',
    'equipment_buffs_updated',
    'house_rooms_updated',
    'consumables_updated',
    'consumable_buffs_updated',
    'personal_buffs_updated',
    'community_buffs_updated',
    'guild_buffs_updated',
    'moo_pass_buffs_updated',
    'achievement_buffs_updated',
];

/** Shared wording, so the panel and the strip explain the same number the same way */
export const UNREADABLE_NOTE =
    'The action queue could not be read in full (an unknown action, or a row that may run on ' +
    'loot from a fight ahead of it), so the gold it still needs is unknown.';
export const UNQUOTED_NOTE =
    'No bag of ten cowbells is listed for sale right now; the price above is only an estimate.';
export const ESTIMATE_NOTE =
    ' Part of this is a prediction (enhancing attempts, or a row limited by materials it only' +
    ' expects to have), so it is an estimate: bad luck can spend more.';

/**
 * The sentence that says what the reserve holds back.
 * @param {number} reserve - Coins kept for the queue
 * @param {Array<string>} spenders - The rows that spend it
 * @param {Function} formatCoins - Coins → text, in the caller's style
 * @param {number} [buffer=0] - The part of `reserve` that is a safety margin rather than fees
 * @returns {string} One or two sentences
 */
export function keptNote(reserve, spenders, formatCoins, buffer = 0) {
    const fees = reserve - buffer;
    const margin = buffer > 0 ? ` plus a ${formatCoins(buffer)} safety buffer` : '';
    if (fees > 0) {
        return (
            `Keeps ${formatCoins(reserve)} back: what ${spenders.join(', ')} spends${margin}. Coinify earnings ` +
            'are not counted on, since its rolls can fail.'
        );
    }
    return buffer > 0
        ? `Nothing queued spends gold; ${formatCoins(buffer)} is kept back as a safety buffer.`
        : 'Nothing queued spends gold, so nothing is held back.';
}

/**
 * @param {string|null} stoppedAt - The row that never ends, from `walkQueueCoins`
 * @returns {string} The note, or ''
 */
export function stoppedNote(stoppedAt) {
    return stoppedAt ? ` The queue is followed up to ${stoppedAt}, which never ends.` : '';
}

/**
 * The item a queued action names in its primary slot.
 * @param {string|null|undefined} hash - `characterId::location::itemHrid::level`
 * @returns {string|null} The item hrid, or null
 */
function itemFromHash(hash) {
    if (typeof hash !== 'string') return null;
    const parts = hash.split('::');
    return parts.length >= 4 ? parts[2] : null;
}

/**
 * Which leg of the loop an action (or a walked stage) is.
 * @param {{actionHrid?: string, itemHrid?: string|null, primaryItemHash?: string}|null} entry - A
 *   queued action, or a stage from `walkQueueCoins` (which carries `itemHrid`)
 * @param {Object|null} loopItems - From `resolveLoopItems`
 * @returns {'forage'|'decompose'|'coinify'|null} Null for anything that is not a loop leg
 */
export function loopLegOf(entry, loopItems) {
    if (!entry?.actionHrid || !loopItems?.forageActionHrid) return null;
    if (entry.actionHrid === loopItems.forageActionHrid) return 'forage';
    const item = entry.itemHrid ?? itemFromHash(entry.primaryItemHash);
    if (entry.actionHrid === DECOMPOSE_ACTION && item && item === loopItems.starfruitHrid) return 'decompose';
    if (entry.actionHrid === COINIFY_ACTION && item && item === loopItems.essenceHrid) return 'coinify';
    return null;
}

/**
 * Where the gold runs out, walking the coins on hand through every fee in run order.
 *
 * Spend-only, as the reserve is: coinify proceeds are not counted on, since its rolls can fail —
 * so a shortfall exists exactly when the coins on hand are under the reserve.
 *
 * @param {Array<Object>} stages - From `walkQueueCoins`
 * @param {number} coins - Coins on hand
 * @param {Object|null} loopItems - From `resolveLoopItems`, to name the stalling leg
 * @returns {{label: string, leg: string|null, atSeconds: number|null, short: number}|null} The row
 *   that stalls, how far into the queue it stalls (null when a row ahead of it cannot be timed) and
 *   how many coins short the whole queue is; null when the coins cover every fee
 */
function findShortfall(stages, coins, loopItems) {
    let balance = Number.isFinite(coins) ? Math.max(0, coins) : 0;
    let elapsed = 0;
    let totalFees = 0;
    let stall = null;
    for (const stage of stages) {
        const fee = stage.coinDelta < 0 ? -stage.coinDelta : 0;
        totalFees += fee;
        if (!stall && fee > balance) {
            const perAction = stage.count > 0 ? fee / stage.count : fee;
            const affordable = perAction > 0 ? Math.floor(balance / perAction + 1e-9) : 0;
            const into =
                Number.isFinite(stage.seconds) && stage.count > 0 ? stage.seconds * (affordable / stage.count) : null;
            stall = {
                label: stage.label,
                leg: loopLegOf(stage, loopItems),
                atSeconds: Number.isFinite(elapsed) && into !== null ? elapsed + into : null,
            };
        }
        if (!stall) balance -= fee;
        elapsed += Number.isFinite(stage.seconds) ? stage.seconds : Infinity;
    }
    if (!stall) return null;
    const startCoins = Number.isFinite(coins) ? Math.max(0, coins) : 0;
    return { ...stall, short: totalFees - startCoins };
}

/**
 * The whole queued cycle, summed.
 *
 * @param {Object|null} walked - From `walkQueueCoins`
 * @param {Object} params
 * @param {number} params.coins - Coins on hand
 * @param {Object|null} params.loopItems - From `resolveLoopItems`
 * @param {number|null} [params.bellPrice] - Gold per bell (the buy-now ask); null when unpriced
 * @param {number|null} [params.offlineCapHours] - `characterInfo.offlineHourCap`
 * @returns {Object|null} `{legs: {forage, decompose, coinify}, otherActions, seconds, endless,
 *   fees, earned, net, netBells, netBags, estimated, shortfall, outlastsCap, capHours}`; null when the
 *   queue could not be walked. `seconds` is null when the cycle never ends (`endless` names the
 *   row) or a row in it cannot be timed (a counted fight).
 */
export function summarizeCycle(walked, { coins, loopItems, bellPrice = null, offlineCapHours = null }) {
    if (!walked) return null;
    const stages = walked.stages || [];
    const legs = { forage: 0, decompose: 0, coinify: 0 };
    let otherActions = 0;
    let fees = 0;
    let earned = 0;
    let seconds = 0;
    for (const stage of stages) {
        const leg = loopLegOf(stage, loopItems);
        const count = Number.isFinite(stage.count) ? stage.count : 0;
        if (leg) legs[leg] += count;
        else otherActions += count;
        fees += stage.coinDelta < 0 ? -stage.coinDelta : 0;
        earned += stage.earned > 0 ? stage.earned : 0;
        seconds += Number.isFinite(stage.seconds) ? stage.seconds : Infinity;
    }
    const endless = walked.stoppedAt ?? null;
    const timed = !endless && Number.isFinite(seconds);
    const net = earned - fees;
    const priced = Number.isFinite(bellPrice) && bellPrice > 0;
    const netBells = priced ? Math.max(0, net) / bellPrice : null;
    const capHours = Number.isFinite(offlineCapHours) && offlineCapHours > 0 ? offlineCapHours : null;
    return {
        legs,
        otherActions,
        seconds: timed ? seconds : null,
        endless,
        fees,
        earned,
        net,
        netBells,
        netBags: netBells === null ? null : Math.floor(netBells / COWBELLS_PER_BAG + 1e-9),
        // Coinify pays out on successes, so its proceeds are an expectation; a catalyst-limited leg's
        // fees are one too (catalysts go only on a success), whether or not anything earns
        estimated: earned > 0 || stages.some((stage) => stage.estimated),
        shortfall: findShortfall(stages, coins, loopItems),
        // An endless cycle outlasts any cap; an untimed one cannot be said to
        outlastsCap: capHours !== null && (endless ? true : timed ? seconds > capHours * 3600 : false),
        capHours,
    };
}

/**
 * What the game queue still holds of each loop leg, by action AND item (alchemy is one action for
 * every item, so the action alone says nothing). Every unfinished row counts, the running one
 * included, at what it has left to do; the queue is never read by position.
 *
 * The rows are walked in queue order (never by position in the array, and never by "the first row is the
 * running one"), with the fruit and essence the character holds as the starting stock. A forage row adds
 * the fruit it is expected to yield; a decompose row can perform only as many actions as the fruit ahead
 * of it covers; a coinify row only as many as the essence ahead of it covers. That is the same limit the
 * engine's `walkQueueCoins` applies (`limitCountedByMaterials`), so `performed` is what will really run,
 * not just what the row asks for. A row whose count exceeds what it can perform is `starved`: it would
 * stall the queue there. A row with no count (Repeat ∞) never hands on, so the rows behind it are
 * unreachable and the walk stops at it.
 *
 * @param {Array<Object>|null} actions - `dataManager.getCurrentActions()`
 * @param {Object|null} loopItems - From `resolveLoopItems`
 * @param {Object} [stock]
 * @param {Object|null} [stock.loop] - From `calculateStarfruitLoop` (bulk sizes, yields)
 * @param {number} [stock.fruitHeld] - Star Fruit held (net of what another plan reserved)
 * @param {number} [stock.essenceHeld] - Essence held (net of reservations)
 * @param {((action: Object) => string|null)|null} [stock.labelOf] - The action's display name, for `endless`
 * @returns {{forage: {count: number, performed: number}, decompose: {count: number, performed: number},
 *   coinify: {count: number, performed: number}, endless: string|null, starved: Array<Object>,
 *   fruitAfter: number, essenceAfter: number}} `count` is what the rows ask for, `performed` what will
 *   run; `endless` names the first row with no count; `starved` lists `{leg, count, performed}`
 */
export function queuedLegCounts(
    actions,
    loopItems,
    { loop = null, fruitHeld = 0, essenceHeld = 0, labelOf = null } = {}
) {
    const legs = {
        forage: { count: 0, performed: 0 },
        decompose: { count: 0, performed: 0 },
        coinify: { count: 0, performed: 0 },
    };
    const fruitPerForage = loop?.fruitPerForageAction || 0;
    const decomposeBulk = loop?.decomposeBulk || 1;
    const coinifyBulk = loop?.coinifyBulk || 1;
    const essencePerFruit = loop?.essencePerFruit || 0;
    let fruit = Math.max(0, Number(fruitHeld) || 0);
    let essence = Math.max(0, Number(essenceHeld) || 0);
    let endless = null;
    const starved = [];

    const rows = (actions || []).filter((action) => action && !action.isDone).sort(compareActionQueueOrder);
    for (const action of rows) {
        const leg = loopLegOf(action, loopItems);
        // Repeat ∞ on an alchemy leg is limited by its materials (the queue shows "mat 184K"): it runs for
        // as long as the stock ahead of it lasts and then hands on, so it is covered up to that and never
        // starved. Any other row with no count (a gather, a fight) has no limit and never hands on.
        const materialLimited = !action.hasMaxCount && (leg === 'decompose' || leg === 'coinify');
        if (!action.hasMaxCount && !materialLimited) {
            // Said by the action's display name (never an hrid): the caller knows how the game names it
            endless = labelOf?.(action) || (leg ? LEG_NAMES[leg] : 'An action with no count');
            break;
        }
        if (!leg) continue;
        const count = materialLimited
            ? Infinity
            : Math.max(0, (Number(action.maxCount) || 0) - (Number(action.currentCount) || 0));
        let performed = count;
        if (leg === 'forage') {
            fruit += count * fruitPerForage;
        } else if (leg === 'decompose') {
            performed = Math.min(count, Math.floor(fruit / decomposeBulk));
            fruit -= performed * decomposeBulk;
            essence += performed * decomposeBulk * essencePerFruit;
        } else {
            performed = Math.min(count, Math.floor(essence / coinifyBulk));
            essence -= performed * coinifyBulk;
        }
        // An ∞ row asks for exactly what it can run
        legs[leg].count += materialLimited ? performed : count;
        legs[leg].performed += performed;
        if (!materialLimited && performed < count) starved.push({ leg, count, performed });
    }
    return { ...legs, endless, starved, fruitAfter: fruit, essenceAfter: essence };
}

/** Display names of the legs, for the walk button's note */
const LEG_NAMES = { forage: 'Forage', decompose: 'Decompose', coinify: 'Coinify' };

/**
 * Take off a batch what the game queue already holds, leg by leg.
 *
 * New rows go on at the END of the queue, in forage, decompose, coinify order, so nothing walked can
 * feed a row that is already queued ahead of it. A leg is therefore credited only for what the queue
 * will really perform (`performed`, in order), and what is walked is capped to what its own inputs
 * allow: the fruit left after the queued rows plus the new forage, and the essence left plus the new
 * decompose. The batch itself is not changed, only the copy the walk is built from.
 *
 * The walk is refused (`blocked`, with the reason) only when it would itself leave a queue that looks complete
 * but idles for good: a starved queued row whose missing input the new rows would make from behind it. A row with
 * no count that the new rows sit behind is a warning (`waitingBehind`, `notes`), not a refusal.
 *
 * @param {Object|null} batch - Counts as `forageActions` / `decomposeActions` / `coinifyActions`
 * @param {ReturnType<typeof queuedLegCounts>} queued - From {@link queuedLegCounts}
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @returns {{batch: Object|null, skipped: Array<string>, partial: Array<string>, blocked: string|null}}
 *   The batch to walk, the legs left out entirely, the legs cut to a difference, and why the walk is
 *   refused (null when it is not)
 */
export function reduceBatchByQueue(batch, queued, loop = null) {
    if (!batch) return { batch, skipped: [], partial: [], blocked: null };
    const reduced = { ...batch };
    const skipped = [];
    const partial = [];
    const fruitPerForage = loop?.fruitPerForageAction || 0;
    const decomposeBulk = loop?.decomposeBulk || 1;
    const coinifyBulk = loop?.coinifyBulk || 1;
    const essencePerFruit = loop?.essencePerFruit || 0;

    const credit = (leg, wanted) => {
        const have = queued?.[leg]?.performed || 0;
        return Math.min(wanted, have);
    };
    const forageHave = credit('forage', batch.forageActions || 0);
    const decomposeHave = credit('decompose', batch.decomposeActions || 0);
    const coinifyHave = credit('coinify', batch.coinifyActions || 0);
    reduced.forageActions = Math.max(0, (batch.forageActions || 0) - forageHave);
    // What the new rows can use: the stock the queue leaves, plus what the new rows make ahead of them
    const fruitForNew = (queued?.fruitAfter || 0) + reduced.forageActions * fruitPerForage;
    const decomposeWanted = Math.max(0, (batch.decomposeActions || 0) - decomposeHave);
    reduced.decomposeActions = Math.min(decomposeWanted, Math.floor(fruitForNew / decomposeBulk));
    const essenceForNew = (queued?.essenceAfter || 0) + reduced.decomposeActions * decomposeBulk * essencePerFruit;
    const coinifyWanted = Math.max(0, (batch.coinifyActions || 0) - coinifyHave);
    reduced.coinifyActions = Math.min(coinifyWanted, Math.floor(essenceForNew / coinifyBulk));

    for (const [leg, have, key] of [
        ['forage', forageHave, 'forageActions'],
        ['decompose', decomposeHave, 'decomposeActions'],
        ['coinify', coinifyHave, 'coinifyActions'],
    ]) {
        const need = batch[key] || 0;
        if (need <= 0 || have <= 0) continue;
        if (reduced[key] <= 0 && have >= need) skipped.push(LEG_NAMES[leg]);
        else partial.push(LEG_NAMES[leg]);
    }

    let blocked = null;
    const notes = [];
    const anythingToWalk = reduced.forageActions + reduced.decomposeActions + reduced.coinifyActions > 0;
    // A starved queued row stalls the queue with or without this walk. The walk is refused only when it would
    // itself leave that row idle for good: the row's missing input would be made by a row added BEHIND it, which
    // can never run until the starved row does.
    const feeders = { decompose: reduced.forageActions > 0, coinify: reduced.decomposeActions > 0 };
    for (const { leg, count, performed } of queued?.starved || []) {
        const message =
            `${LEG_NAMES[leg]} is queued for ${formatWithSeparator(count)} but the stock ahead of it covers only ` +
            `${formatWithSeparator(performed)}`;
        if (feeders[leg] && !blocked) {
            blocked = `${message}, and what would feed it is queued behind it, so the queue would stall there for good.`;
        } else if (!feeders[leg]) {
            notes.push(`${message}, so it stalls there until more arrives; rows added behind it wait.`);
        }
    }
    // A row with no count and no material limit never hands on: the new rows wait behind it until it is stopped.
    // A warning, not a refusal; the rows are queued and run when it is stopped.
    let waitingBehind = null;
    if (queued?.endless && anythingToWalk) {
        waitingBehind = queued.endless;
        notes.push(`The new rows wait behind ${queued.endless}, which repeats forever, until you stop it.`);
    }
    return { batch: reduced, skipped, partial, blocked, waitingBehind, notes };
}

/**
 * A clock time `seconds` from `now`, with the date when it is not today.
 * @param {number} seconds - From now
 * @param {number} [now] - Epoch ms
 * @returns {string} e.g. "11-04 3:05 PM"
 */
export function clockAfterSeconds(seconds, now = Date.now()) {
    const at = new Date(now + seconds * 1000);
    const today = at.toDateString() === new Date(now).toDateString();
    return formatDateTime(at, { includeDate: !today, includeSeconds: false });
}

/**
 * When the queue runs out and about what the bell balance would be then.
 *
 * Bells by then are an estimate: the gold on hand plus the coinify the queue is expected to pay (its rolls
 * can fail) less the fees it takes, at the price a bell can be bought at now, whole bags of ten.
 *
 * @param {Object|null} walked - From `walkQueueCoins`
 * @param {Object|null} cycle - From {@link summarizeCycle} over the same walk
 * @param {{coins: number, bellPrice?: number|null, now?: number}} params
 * @returns {{text: string, title: string}|null} Null when the queue could not be read
 */
export function queueEndText(walked, cycle, { coins, bellPrice = null, now = Date.now(), capHours = null }) {
    if (!walked || !cycle) return null;
    if (cycle.endless) {
        return {
            text: `The queue repeats ${cycle.endless} forever, so it never runs out.`,
            title: 'A row with no count never hands on to the rows behind it.',
        };
    }
    if (!walked.stages?.length) return { text: 'The queue is empty.', title: 'Nothing is queued to run.' };
    if (cycle.seconds === null) {
        return {
            text: 'The queue holds a fight that cannot be timed, so when it runs out is unknown.',
            title: 'Counted fights have no fixed length.',
        };
    }
    const when = `${clockAfterSeconds(cycle.seconds, now)} (in ${timeReadable(cycle.seconds)})`;
    const capText =
        Number.isFinite(capHours) && capHours > 0 && cycle.outlastsCap
            ? ` Away from the game it stops ${capHours}h after you leave.`
            : '';
    // The gold runs out before the rows do: the queue stops there, so neither the end time nor the bells
    // by then describe what will happen
    if (cycle.shortfall) {
        const { label, atSeconds, short } = cycle.shortfall;
        const at =
            atSeconds === null
                ? 'partway through'
                : atSeconds <= 0
                  ? 'at once'
                  : `at ${clockAfterSeconds(atSeconds, now)} (in ${timeReadable(atSeconds)})`;
        return {
            text:
                `⚠ Gold runs out on ${label} ${at}, ${formatKMB(Math.round(short))} short: the queue stops there, ` +
                `not when its rows finish (${when}).${capText}`,
            title: 'The fees of every queued row, in order, against your gold, with no coinify income counted on.',
        };
    }
    const priced = Number.isFinite(bellPrice) && bellPrice > 0;
    let bellsText = '';
    if (priced) {
        const held = Number.isFinite(coins) ? Math.max(0, coins) : 0;
        const bags = Math.floor(Math.max(0, held + cycle.net) / (bellPrice * COWBELLS_PER_BAG) + 1e-9);
        bellsText = ` — about ${formatWithSeparator(bags * COWBELLS_PER_BAG)} bells by then (estimate)`;
    }
    return {
        text: `The queue runs out ${when}${bellsText}.${capText}`,
        title:
            'Estimate: the gold on hand plus the coinify the queue is expected to pay (its rolls can fail), ' +
            'less its decompose fees, in whole bags of ten at the price you can buy at now.',
    };
}
