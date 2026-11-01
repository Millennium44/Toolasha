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
