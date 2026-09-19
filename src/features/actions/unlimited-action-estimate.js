/**
 * Unlimited Action Estimate
 *
 * An action panel set to Repeat ∞ used to read `Total time: ∞` / `Total profit: ∞`, while the
 * moment the same action was queued the queue row showed a real, materials-bounded figure
 * (`[4 days 3h 41m · mat: 85.4K]`). The two were describing the same run, so they must not
 * disagree — and the arithmetic behind the queue row already answers for an unqueued action:
 * `calculateSingleQueueActionTime`'s own JSDoc says so, and its `limitCountedByMaterials`
 * option is off by default precisely so the whole bag is the basis when nothing is queued.
 *
 * This module is the glue, not a second implementation. It builds the synthetic "action object"
 * the calculator wants out of what a panel actually knows (an action hrid, and for alchemy or
 * enhancing the selected item), calls the one calculator, and formats the answer in the queue
 * row's own vocabulary so a player recognises the two figures as the same number. Nothing here
 * re-derives a time, a count or a material limit.
 */

import dataManager from '../../core/data-manager.js';
import { timeReadable, formatLargeNumber } from '../../utils/formatters.js';
import actionTimeDisplay from './action-time-display.js';

/**
 * How long a computed estimate is reused before the inventory is walked again.
 *
 * These panels redraw their total on every keystroke in the Repeat box, and the estimate does
 * not depend on what is typed — only on the action and the bag. Without this, holding a key
 * down would walk the whole inventory per repeat. 1.5s is short enough that a craft finishing
 * or a purchase landing is reflected almost immediately, and long enough that typing is free.
 */
const ESTIMATE_TTL_MS = 1500;

/** The action id no real action can have, so the calculator's in-progress elapsed-time lookup misses. */
const UNQUEUED_ACTION_ID = 'mwi-unqueued-estimate';

let cache = { key: null, at: 0, value: null };

/**
 * Forget any memoized estimate. Called when a panel is rebuilt for a different action, and
 * available to tests so one case cannot inherit another's answer.
 */
export function clearUnlimitedEstimateCache() {
    cache = { key: null, at: 0, value: null };
}

/**
 * Build the item hash the calculator parses for alchemy and enhancing actions.
 * `parseItemHash` looks for the `/items/…` part and a trailing numeric level, so the short
 * form is all it needs — a panel has no character id to put in front of it.
 * @param {string|null} itemHrid - Selected item hrid, or null
 * @param {number} [enhancementLevel] - Enhancement level of the selected item
 * @returns {string|null} Hash string, or null when there is no item
 */
function buildItemHash(itemHrid, enhancementLevel = 0) {
    if (!itemHrid) return null;
    return `${itemHrid}::${enhancementLevel || 0}`;
}

/**
 * Build the synthetic, unqueued action object the shared calculator takes.
 * `hasMaxCount: false` is what makes it the "Repeat ∞" case.
 * @param {Object} spec - { actionHrid, itemHrid, enhancementLevel, catalystHrid }
 * @returns {Object} Action object shaped like one from dataManager
 */
export function buildUnqueuedActionObject({ actionHrid, itemHrid = null, enhancementLevel = 0, catalystHrid = null }) {
    return {
        id: UNQUEUED_ACTION_ID,
        actionHrid,
        hasMaxCount: false,
        currentCount: 0,
        maxCount: 0,
        primaryItemHash: buildItemHash(itemHrid, enhancementLevel),
        secondaryItemHash: buildItemHash(catalystHrid, 0),
    };
}

/**
 * Estimate how long an unqueued "Repeat ∞" action would actually run for, and on what.
 *
 * Returns the shared calculator's own result object, so every field the queue row reads is
 * present and means the same thing: `totalTime`, `count`, `materialLimit`, `limitLabel`,
 * `materialLimitIsEstimated`, `isTrulyInfinite`.
 *
 * @param {Object} spec - { actionHrid, itemHrid, enhancementLevel, catalystHrid }
 * @returns {Object|null} The calculator result, or null when the action is not recognised
 */
export function estimateUnlimitedAction(spec) {
    try {
        if (!spec || !spec.actionHrid) return null;

        const key = [spec.actionHrid, spec.itemHrid || '', spec.enhancementLevel || 0, spec.catalystHrid || ''].join(
            '|'
        );
        const now = Date.now();
        if (cache.key === key && now - cache.at < ESTIMATE_TTL_MS) {
            return cache.value;
        }

        const actionDetails = dataManager.getActionDetails(spec.actionHrid);
        if (!actionDetails) return null;

        const inventoryLookup = actionTimeDisplay.buildInventoryLookup(dataManager.getInventory());
        const actionObj = buildUnqueuedActionObject(spec);

        // No `limitCountedByMaterials`: nothing is queued ahead of this, so the whole bag is
        // the right basis — which is exactly the case the option is off by default for.
        const result = actionTimeDisplay.calculateSingleQueueActionTime(actionObj, actionDetails, inventoryLookup);

        cache = { key, at: now, value: result };
        return result;
    } catch (error) {
        console.error('[UnlimitedActionEstimate] Failed to estimate an unlimited action:', error);
        return null;
    }
}

/**
 * True when the estimate is a real, finite, materials-bounded run worth showing.
 * A genuinely unbounded action — one with no material cost at all, or one whose limit cannot
 * be determined — is not, and must keep reading ∞ rather than gain a fabricated number.
 * @param {Object|null} timing - Result from `estimateUnlimitedAction`
 * @returns {boolean}
 */
export function isBoundedEstimate(timing) {
    return Boolean(
        timing &&
        !timing.isTrulyInfinite &&
        timing.materialLimit !== null &&
        Number.isFinite(timing.totalTime) &&
        timing.count > 0
    );
}

/**
 * The material note the queue row prints after a bounded row's time, e.g. `mat: 85.4K`,
 * carrying the `~` marker when the limit rests on credited expected yield rather than stock
 * counted in the bag.
 * @param {Object|null} timing - Result from `estimateUnlimitedAction`
 * @returns {string} The note, or '' when there is nothing to say
 */
export function formatMaterialNote(timing) {
    if (!isBoundedEstimate(timing)) return '';
    const mark = timing.materialLimitIsEstimated ? '~' : '';
    return `${timing.limitLabel}: ${mark}${actionTimeDisplay.formatLargeNumber(timing.materialLimit)}`;
}

/**
 * The bounded time a queue row would show for this action, with its material note — the same
 * `4 days 3h 41m · mat: 85.4K` text, without the queue's surrounding brackets.
 * @param {Object|null} timing - Result from `estimateUnlimitedAction`
 * @returns {string|null} Formatted text, or null when the action really is unbounded
 */
export function formatUnlimitedTimeText(timing) {
    if (!isBoundedEstimate(timing)) return null;
    return `${timeReadable(timing.totalTime)} · ${formatMaterialNote(timing)}`;
}

/**
 * The "Total profit" text a panel shows for an action whose Repeat is set to unlimited (∞),
 * priced through that panel's own totals helper for the materials-bounded count the estimate
 * settled on — the same bound `formatUnlimitedTimeText` reports for the same `timing`, so a
 * panel that shows both never has one line disagree with the other.
 *
 * A genuinely unbounded action gets `∞` back rather than an invented figure.
 *
 * @param {Object|null} timing - Result from `estimateUnlimitedAction`
 * @param {(count: number) => {totalProfit: number}} totalsForCount - Panel's own totals helper
 * @returns {string} Formatted profit text, or '∞'
 */
export function formatUnlimitedProfitText(timing, totalsForCount) {
    if (!isBoundedEstimate(timing)) return '∞';
    const totalProfit = Math.round(totalsForCount(timing.count).totalProfit);
    return `${formatLargeNumber(totalProfit)} · ${formatMaterialNote(timing)}`;
}
