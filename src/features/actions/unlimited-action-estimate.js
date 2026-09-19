/**
 * Unlimited Action Estimate
 *
 * An action panel set to Repeat ∞ used to read `Total time: ∞` / `Total profit: ∞`, while the
 * moment the same action was queued the queue row showed a real, materials-bounded figure
 * (`[4 days 3h · mat: 85.4K]`). The two were describing the same run, so they must not
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
import { runningAction } from '../../utils/combat-actions.js';

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
 *
 * The enhancing fields are only read by `calculateEnhancingQueueTime` (gated on
 * `actionDetails.type === '/action_types/enhancing'`), so passing them for a crafting or
 * alchemy spec is harmless — they simply go unread.
 *
 * @param {Object} spec - { actionHrid, itemHrid, enhancementLevel, catalystHrid,
 *   enhancingMaxLevel, enhancingProtectionMinLevel, enhancingProtectionItemHrid }
 * @returns {Object} Action object shaped like one from dataManager
 */
export function buildUnqueuedActionObject({
    actionHrid,
    itemHrid = null,
    enhancementLevel = 0,
    catalystHrid = null,
    enhancingMaxLevel = 0,
    enhancingProtectionMinLevel = 0,
    enhancingProtectionItemHrid = null,
}) {
    return {
        id: UNQUEUED_ACTION_ID,
        actionHrid,
        hasMaxCount: false,
        currentCount: 0,
        maxCount: 0,
        primaryItemHash: buildItemHash(itemHrid, enhancementLevel),
        secondaryItemHash: buildItemHash(catalystHrid, 0),
        // Read directly by `calculateEnhancingQueueTime` / `getEnhancingProtectionDraw`, the
        // same fields a real queued enhancing row carries (see
        // action-time-display.enhancing-protection-limit.test.js's `enhancingRow` fixture).
        enhancingMaxLevel,
        enhancingProtectionMinLevel,
        enhancingProtectionItemHrid,
    };
}

/**
 * Estimate how long an unqueued "Repeat ∞" action would actually run for, and on what.
 *
 * Returns the shared calculator's own result object, so every field the queue row reads is
 * present and means the same thing: `totalTime`, `count`, `materialLimit`, `limitLabel`,
 * `materialLimitIsEstimated`, `isTrulyInfinite`.
 *
 * @param {Object} spec - { actionHrid, itemHrid, enhancementLevel, catalystHrid,
 *   enhancingMaxLevel, enhancingProtectionMinLevel, enhancingProtectionItemHrid }
 * @returns {Object|null} The calculator result, or null when the action is not recognised
 */
export function estimateUnlimitedAction(spec) {
    try {
        if (!spec || !spec.actionHrid) return null;

        const key = [
            spec.actionHrid,
            spec.itemHrid || '',
            spec.enhancementLevel || 0,
            spec.catalystHrid || '',
            spec.enhancingMaxLevel || 0,
            spec.enhancingProtectionMinLevel || 0,
            spec.enhancingProtectionItemHrid || '',
        ].join('|');
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
    return `${timing.limitLabel}: ${mark}${formatLargeNumber(timing.materialLimit)}`;
}

/**
 * The bounded time a queue row would show for this action, with its material note — the same
 * `4 days 3h · mat: 85.4K` text, without the queue's surrounding brackets.
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

/**
 * True when an enhancing estimate is a real, finite, affordable run worth showing.
 *
 * `isBoundedEstimate` above insists on `materialLimit !== null`, which the crafting/alchemy
 * branch of `calculateSingleQueueActionTime` only ever sets from a *capped counted* row
 * (`options.limitCountedByMaterials` binding against `actionObj.hasMaxCount`). This estimate's
 * action object is always `hasMaxCount: false` — the "Repeat ∞" shape — so for enhancing that
 * cap path never runs and `materialLimit` stays `null` even when `calculateEnhancingQueueTime`
 * genuinely bounded the run by its per-attempt bill. `count` and `totalTime` are trustworthy
 * regardless: they come straight out of `calculateMaterialLimit`'s enhancing branch by way of
 * `calculateEnhancingQueueTime`'s own `queuedActions` — see action-time-display.js around
 * `calculateEnhancingQueueTime` (~line 2874) and `calculateSingleQueueActionTime`'s enhancing
 * branch (~line 1778), which only forwards `materialLimit` from `enhancingTime.limitType`.
 * @param {Object|null} timing - Result from `estimateUnlimitedAction`
 * @returns {boolean}
 */
export function isBoundedEnhancingEstimate(timing) {
    return Boolean(
        timing && timing.isEnhancing && !timing.isTrulyInfinite && Number.isFinite(timing.totalTime) && timing.count > 0
    );
}

/**
 * The bounded time text for an enhancing action whose Repeat is set to unlimited (∞): the time
 * its materials and protection items actually pay for, and how many attempts that is — carrying
 * the `~` marker when the bound rests on the expected protection draw rather than a stock count
 * (`materialLimitIsEstimated`, set by `getEnhancingProtectionDraw`).
 *
 * A genuinely unbounded run (no Target Level set, or nothing to predict from) gets `∞` back
 * rather than an invented figure.
 * @param {Object|null} timing - Result from `estimateUnlimitedAction`
 * @returns {string} Formatted text, or '∞'
 */
export function formatEnhancingUnlimitedText(timing) {
    if (!isBoundedEnhancingEstimate(timing)) return '∞';
    const mark = timing.materialLimitIsEstimated ? '~' : '';
    return `${timeReadable(timing.totalTime)} · ${mark}${formatLargeNumber(Math.round(timing.count))} attempts`;
}

/**
 * The "Total profit" text for a panel with no Repeat input at all — the Current Action tab,
 * which shows the action actually running (with a Stop button) rather than one being
 * configured. There is no `∞` / a typed count to read from a field here, so the answer has to
 * come from the running action's own queue entry instead of an input's value.
 *
 * `dataManager.getCurrentActions()` is the character's queue; `runningAction` (not array
 * position — see its own doc header) finds the one actually executing, matched to this panel by
 * `spec.actionHrid`. From there:
 * - `hasMaxCount === false` is the Repeat-∞ shape, exactly what `estimateUnlimitedAction` already
 *   answers for the configure tab's own `∞` case — reusing it here is what keeps the two tabs
 *   from ever disagreeing about the same run.
 * - `hasMaxCount === true` is a counted run in progress; what is left to earn is `maxCount -
 *   currentCount`, priced through the caller's own totals helper. A run that has already used up
 *   its count prices to a real, computed 0 — that is not a fabrication, it is the answer.
 *
 * Returns `null` — never a string `'0'` — when there is nothing honest to price: no running
 * action matches `spec.actionHrid` at all. The caller is expected to omit the whole
 * "| Total profit: …" clause in that case rather than print an invented figure.
 *
 * @param {Object} spec - Same shape `estimateUnlimitedAction` takes: {actionHrid, itemHrid,
 *   enhancementLevel, catalystHrid, enhancingMaxLevel, enhancingProtectionMinLevel,
 *   enhancingProtectionItemHrid}
 * @param {(count: number) => {totalProfit: number}} totalsForCount - Panel's own totals helper
 * @returns {string|null} Formatted profit text ('∞' included), or null to omit the clause
 */
export function formatRunningActionProfitText(spec, totalsForCount) {
    try {
        if (!spec || !spec.actionHrid) return null;

        const running = runningAction(dataManager.getCurrentActions(), (a) => a.actionHrid === spec.actionHrid);
        if (!running) return null;

        if (running.hasMaxCount === false) {
            return formatUnlimitedProfitText(estimateUnlimitedAction(spec), totalsForCount);
        }

        const remaining = Math.max(0, (running.maxCount || 0) - (running.currentCount || 0));
        const totalProfit = Math.round(totalsForCount(remaining).totalProfit);
        return formatLargeNumber(totalProfit);
    } catch (error) {
        console.error('[UnlimitedActionEstimate] Failed to price the running action:', error);
        return null;
    }
}
