/**
 * How many cowbells the coins on hand buy without starving the queue.
 *
 * Decompose is paid for in gold, one fee per action, and the coinify that pays
 * it back runs *after* it. So the gold the queue needs is not its net cost but
 * the deepest the balance dips on the way through: a 94M decompose leg ahead of
 * a 400M coinify leg still needs 94M up front. Anything above that dip is spare.
 *
 * The queue is not modelled here. It is walked through the action-time engine's
 * own ledger (`buildInventoryLookup` → `calculateSingleQueueActionTime` →
 * `deductQueueActionMaterials`), the same walk the queue tooltip and the
 * character-select projection use, so a Repeat ∞ row runs to the same "mat
 * limit" the queue shows, decompose output feeds the coinify behind it, and the
 * fee is the one `utils/alchemy-fees.js` states.
 */

import dataManager from '../../core/data-manager.js';
import { compareActionQueueOrder } from '../../utils/combat-actions.js';

const COIN = '/items/coin';

/** Bells come loose or in bags of this many */
export const COWBELLS_PER_BAG = 10;

/**
 * The ledger's coin balance during the walk.
 *
 * Large enough that gold never binds a row's limit — the walk asks how much
 * gold the queue needs, so it must not stop where today's coins would — and
 * small enough that a fee of a few hundred still moves it exactly (the spacing
 * of doubles near 1e15 is 0.125).
 */
const LEDGER_COINS = 1e15;

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
 * Walk the live queue in execution order and record each row's coin flow.
 *
 * A row that never hands the queue on (a gather with Repeat ∞, an uncounted fight) ends
 * the walk: nothing behind it ever runs, so nothing behind it can need gold. A counted
 * fight spends no gold and does hand on, so the walk goes through it.
 *
 * Gold a row earns (coinify) is recorded as `earned` but not credited: its rolls can
 * fail, and a reserve funded by expected proceeds can leave a later fee unpaid. So the
 * reserve counts on no earnings at all.
 *
 * @param {Object|null} engine - The action-time engine (see `bundle-bridge.actionTimeDisplay`)
 * @param {Array<Object>} [actions] - The queue; defaults to `dataManager.getCurrentActions()`
 * @param {Array<Object>} [inventory] - Defaults to `dataManager.getInventory()`
 * @returns {{stages: Array<{actionHrid: string, label: string, count: number, coinDelta: number,
 *   earned: number}>, stoppedAt: string|null}|null} Rows in run order; `stoppedAt` names the
 *   unbounded row that ended the walk. Null when the engine is unavailable or a row's action is
 *   unknown — an unread row may spend, or never hand on, so no reserve is better than a low one.
 */
export function walkQueueCoins(engine, actions, inventory) {
    if (!engine?.buildInventoryLookup || !engine.calculateSingleQueueActionTime || !engine.deductQueueActionMaterials) {
        return null;
    }

    const queue = (actions ?? dataManager.getCurrentActions() ?? [])
        .filter((action) => action && !action.isDone)
        .sort(compareActionQueueOrder);
    const ledger = engine.buildInventoryLookup(inventory ?? dataManager.getInventory() ?? []);
    ledger.byHrid[COIN] = LEDGER_COINS;
    ledger.byEnhancedKey[`${COIN}::0`] = LEDGER_COINS;

    const stages = [];
    let stoppedAt = null;
    for (const action of queue) {
        const details = dataManager.getActionDetails(action.actionHrid);
        if (!details) return null;

        const timing = engine.calculateSingleQueueActionTime(action, details, ledger, {
            limitCountedByMaterials: true,
        });
        const itemHrid = itemFromHash(action.primaryItemHash);
        const itemName = itemHrid ? dataManager.getItemDetails(itemHrid)?.name : null;
        const label = itemName ? `${details.name}: ${itemName}` : details.name || action.actionHrid;

        // The engine calls every fight infinite; a counted one ends and hands on, paying no gold
        if (timing?.isTrulyInfinite && action.hasMaxCount && action.actionHrid?.includes('/combat/')) {
            const count = Math.max(0, (action.maxCount || 0) - (action.currentCount || 0));
            stages.push({ actionHrid: action.actionHrid, label, count, coinDelta: 0, earned: 0 });
            continue;
        }
        if (timing?.isTrulyInfinite) {
            stoppedAt = label;
            break;
        }

        const before = ledger.byHrid[COIN] || 0;
        const count = engine.deductQueueActionMaterials(ledger, details, action, timing) || 0;
        const delta = (ledger.byHrid[COIN] || 0) - before;
        // Earnings are not counted on (see above): the ledger keeps its spend-only balance
        if (delta > 0) {
            ledger.byHrid[COIN] = before;
            ledger.byEnhancedKey[`${COIN}::0`] = before;
        }
        stages.push({
            actionHrid: action.actionHrid,
            label,
            count,
            coinDelta: Math.min(0, delta),
            earned: Math.max(0, delta),
            // Enhancing spends per attempt, and the attempts are a prediction: a run of failures spends more
            estimated: delta < 0 && String(action.actionHrid).startsWith('/actions/enhancing/'),
        });
    }
    return { stages, stoppedAt };
}

/**
 * The gold the queue needs on hand: the deepest the balance falls below where it
 * started, at any point of the run.
 *
 * Every row either only spends (decompose, transmute, enhancing) or only earns
 * (coinify), so within a row the balance moves one way and its extremes are the
 * row's two ends — checking every boundary is checking every point. Earning
 * only helps from the moment it lands: a coinify behind a decompose does not
 * lower the decompose's dip.
 *
 * @param {Array<{coinDelta: number, label?: string}>} stages - From {@link walkQueueCoins}, in run order
 * @returns {{reserve: number, spenders: Array<string>, estimated: boolean}} `reserve` ≥ 0;
 *   `spenders` names the rows that spend on the way down to the dip; `estimated` when one of them
 *   spends a predicted rather than a fixed amount (enhancing)
 */
export function coinReserve(stages) {
    let balance = 0;
    let lowest = 0;
    let lowestAt = -1;
    (stages || []).forEach((stage, index) => {
        balance += Number.isFinite(stage?.coinDelta) ? stage.coinDelta : 0;
        if (balance < lowest) {
            lowest = balance;
            lowestAt = index;
        }
    });

    const spenders = [];
    let estimated = false;
    for (let index = 0; index <= lowestAt; index++) {
        const stage = stages[index];
        if (stage.coinDelta < 0 && stage.estimated) estimated = true;
        if (stage.coinDelta < 0 && stage.label && !spenders.includes(stage.label)) spenders.push(stage.label);
    }
    return { reserve: lowest < 0 ? -lowest : 0, spenders, estimated };
}

/**
 * Whole units a sum buys. The nudge keeps an exact multiple from flooring one short
 * when `price × 10` lands a hair above the bag price it was divided out of.
 * @param {number} sum - Coins
 * @param {number} cost - Coins per unit, > 0
 * @returns {number} Units, ≥ 0
 */
function wholeUnits(sum, cost) {
    return Math.max(0, Math.floor(sum / cost + 1e-9));
}

/**
 * Bells the spare coins buy, the way the panel says to buy them.
 *
 * Whole bells only, rounded down. When the bag is the cheaper route, whole bags
 * first, then whatever loose bells the remainder still buys at the loose price.
 * `looseBells` is the count buying every bell loose instead.
 *
 * @param {number} coins - Coins on hand
 * @param {number} reserve - From {@link coinReserve}
 * @param {{price: number|null, source: 'loose'|'bag'|null, loose: number|null}} pricing - From
 *   `cowbellPricing()`; `price` is per bell either way
 * @returns {{spare: number, bells: number, bags: number|null, extraLoose: number,
 *   looseBells: number|null}|null} `extraLoose` is the loose bells bought beside the bags. Null
 *   without a bell price
 */
export function bellsAffordable(coins, reserve, pricing) {
    const price = pricing?.price;
    if (!Number.isFinite(price) || price <= 0) return null;
    const spare = Math.max(0, (Number.isFinite(coins) ? coins : 0) - (Number.isFinite(reserve) ? reserve : 0));
    const loose = Number.isFinite(pricing.loose) && pricing.loose > 0 ? pricing.loose : null;
    const looseBells = loose === null ? null : wholeUnits(spare, loose);

    if (pricing.source === 'bag') {
        const bagCost = price * COWBELLS_PER_BAG;
        const bags = wholeUnits(spare, bagCost);
        const extraLoose = loose === null ? 0 : wholeUnits(spare - bags * bagCost, loose);
        return { spare, bells: bags * COWBELLS_PER_BAG + extraLoose, bags, extraLoose, looseBells };
    }
    return { spare, bells: wholeUnits(spare, price), bags: null, extraLoose: 0, looseBells };
}
