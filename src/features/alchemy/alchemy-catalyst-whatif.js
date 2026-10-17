/**
 * Alchemy catalyst what-if.
 *
 * The catalyst a player wants the Alchemy panel's Profitability section to
 * assume, which may differ from the one slotted in the game. The game's own
 * selection is never touched: this is a figure-only override.
 *
 * Two pieces of state, shared by the profit display (which owns the picker) and
 * the Alchemy Missing Mats button (which sizes the picked catalyst):
 *
 * - the choice — `null` means "the equipped catalyst", i.e. no what-if;
 * - the result the display last computed for that choice — which catalyst, at
 *   what success rate, for which item and tab — or null when no what-if figure
 *   is on screen. The button only reads a result for the item it is costing.
 *
 * In memory only. A player who reloads is back on the equipped catalyst.
 */

/** The choices the calculator's `catalystChoice` accepts */
export const CATALYST_WHATIF_CHOICES = ['none', 'typeSpecific', 'prime'];

let choice = null;
let result = null;
const listeners = new Set();

function notify(kind) {
    for (const listener of Array.from(listeners)) {
        try {
            listener(kind);
        } catch (error) {
            console.error('[AlchemyCatalystWhatIf] Listener failed:', error);
        }
    }
}

/**
 * @returns {'none'|'typeSpecific'|'prime'|null} The picked catalyst, or null for the equipped one
 */
export function getCatalystWhatIf() {
    return choice;
}

/**
 * Pick a catalyst to assume, or null to go back to the equipped one.
 * @param {'none'|'typeSpecific'|'prime'|null} next - The choice
 */
export function setCatalystWhatIf(next) {
    const normalized = CATALYST_WHATIF_CHOICES.includes(next) ? next : null;
    if (normalized === choice) return;
    choice = normalized;
    result = null;
    notify('choice');
}

/**
 * What the display computed for the current choice, or null when no what-if figure is shown.
 * @returns {{itemHrid: string, actionType: string, catalystHrid: string, successRate: number}|null}
 */
export function getCatalystWhatIfResult() {
    return choice === null ? null : result;
}

/**
 * Published by the profit display after each render.
 * @param {{itemHrid: string, actionType: string, catalystHrid: string, successRate: number}|null} next
 */
export function publishCatalystWhatIfResult(next) {
    const same =
        (next === null && result === null) ||
        (next &&
            result &&
            next.itemHrid === result.itemHrid &&
            next.actionType === result.actionType &&
            next.catalystHrid === result.catalystHrid &&
            next.successRate === result.successRate);
    if (same) return;
    result = next;
    notify('result');
}

/**
 * @param {Function} listener - Called with `'choice'` or `'result'` on every change
 * @returns {Function} Unsubscribe
 */
export function onCatalystWhatIfChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Back to the equipped catalyst with nothing published (the display's disable).
 * Listeners stay: each subscriber removes its own.
 */
export function resetCatalystWhatIf() {
    const changed = choice !== null || result !== null;
    choice = null;
    result = null;
    if (changed) notify('choice');
}
