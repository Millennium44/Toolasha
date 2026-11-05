/**
 * Skilling consumables
 *
 * The teas slotted for a gathering, production or other non-combat skill,
 * turned into the same forecast entries the Consumables panel and the overlay
 * tile draw for a fight. Combat measures its drinks off a battle; a skill has no
 * battle, so the rate is arithmetic: the buff's base duration divided by
 * (1 + drink concentration). Measured live, every slot of a running skill
 * consumed one tea together every ~268 s at 12.9% concentration, which is
 * 300 / 1.129.
 *
 * ## What is and is not a number here
 *
 * - A slot's `duration` counts down only while the skill runs. A skill that is
 *   not running consumes nothing, so its teas are reported as frozen rather
 *   than as expiring.
 * - Time left is the running activation plus the held stack at the tea rate,
 *   which is what `calculateDrinkRemainingSeconds` (the drink timer) computes,
 *   so the panel, the tile and the timer cannot disagree.
 * - A slotted tea held at 0 is kept, with its full shortfall: that is exactly
 *   what the shortfall exists to point at.
 * - A tea with no buff duration in the game data has an unknown rate, and says
 *   so. `drink-calculator` falls back to five minutes there; a fabricated
 *   figure a player buys from is worse than a labelled blank.
 * - An unpriced tea carries no price on any side; the cost helpers count it as
 *   unpriced instead of as free.
 *
 * Stateless: every call reads the game state afresh, so each bundle that
 * includes a copy answers alike.
 */

import dataManager from '../core/data-manager.js';
import { forecast, drinkRatePerDay } from './consumable-forecast.js';
import { getItemPrices } from './market-data.js';
import { getDrinkConcentration } from './tea-parser.js';
import { resolveActionContext } from './action-context.js';
import { runningAction } from './combat-actions.js';
import { heldInInventory } from './dungeon-key-forecast.js';
import { sortActionTypes } from './action-type-order.js';

export const COMBAT_ACTION_TYPE = '/action_types/combat';

/** Action types that carry drink slots but are not skills with teas to forecast */
const EXCLUDED_ACTION_TYPES = new Set(['/action_types/labyrinth', '/action_types/special']);

const NS_PER_SECOND = 1e9;

/**
 * An action type's name in words.
 * @param {string} actionTypeHrid - e.g. `/action_types/foraging`
 * @returns {string} e.g. `Foraging`
 */
export function actionTypeLabel(actionTypeHrid) {
    return (
        String(actionTypeHrid || '')
            .split('/')
            .pop()
            .split('_')
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ') || '?'
    );
}

/**
 * Whether an action type is one whose teas this module forecasts.
 * @param {string|null|undefined} actionTypeHrid - An action type hrid
 * @returns {boolean} False for combat, labyrinth, special and nothing
 */
export function isSkillingActionType(actionTypeHrid) {
    return (
        Boolean(actionTypeHrid) && actionTypeHrid !== COMBAT_ACTION_TYPE && !EXCLUDED_ACTION_TYPES.has(actionTypeHrid)
    );
}

/**
 * The action type of the action actually running, by execution order.
 *
 * Through `runningAction`, never `actions[0]`, which may be queued behind it.
 *
 * @returns {string|null} An action type hrid, or null when idle or unknown
 */
export function runningActionTypeHrid() {
    const action = runningAction(dataManager.getCurrentActions?.() || []);
    if (!action?.actionHrid) return null;
    return dataManager.getActionDetails?.(action.actionHrid)?.type || null;
}

/**
 * Every skill the character has drink slots for, in the game's order.
 * @returns {string[]} Action type hrids, combat, labyrinth and special left out
 */
export function skillingActionTypes() {
    const map = dataManager.actionTypeDrinkSlotsMap;
    const keys = map && typeof map.keys === 'function' ? [...map.keys()] : [];
    return sortActionTypes(keys.filter(isSkillingActionType));
}

/**
 * Drink concentration for an action type.
 *
 * The running skill uses the character's own stat, which already includes every
 * source the game counts. Any other skill is read off the gear that skill would
 * use.
 *
 * @param {string} actionTypeHrid - The action type
 * @param {boolean} isRunning - Whether it is the running one
 * @param {Object} itemDetailMap - Game item data
 * @returns {{value: number, source: 'character'|'gear'}}
 */
function concentrationFor(actionTypeHrid, isRunning, itemDetailMap) {
    const live = dataManager.characterData?.noncombatStats?.drinkConcentration;
    if (isRunning && typeof live === 'number' && Number.isFinite(live) && live >= 0) {
        return { value: live, source: 'character' };
    }

    let gear = 0;
    try {
        gear = getDrinkConcentration(resolveActionContext(actionTypeHrid).equipment, itemDetailMap) || 0;
    } catch (error) {
        console.error('[SkillingConsumables] Reading drink concentration from gear failed:', error);
    }
    return { value: gear, source: 'gear' };
}

/**
 * @typedef {Object} SkillingConsumables
 * @property {string} actionTypeHrid - The action type asked about
 * @property {string} label - Its name in words
 * @property {boolean} ready - False until the character's data (and inventory) has loaded
 * @property {boolean} running - Whether this action type is the one running
 * @property {boolean} frozen - True when it is not running: nothing is consumed and no timer moves
 * @property {number} slotted - Distinct teas slotted
 * @property {number} held - Teas held, summed over the slotted ones
 * @property {number} concentration - Drink concentration used, as a fraction
 * @property {'character'|'gear'} concentrationSource - Where it was read
 * @property {Object[]} forecasts - One per distinct slotted tea, in slot order; each is a
 *   `forecast()` entry whose `secondsLeft` includes the running activation, plus `activeSeconds`
 */

/**
 * The forecast for the teas slotted for one skill.
 *
 * @param {string} actionTypeHrid - e.g. `/action_types/foraging`
 * @param {Object} [options]
 * @param {Function} [options.prices] - `(itemHrid) => {ask, bid}|null`, for tests
 * @returns {SkillingConsumables}
 */
export function skillingConsumables(actionTypeHrid, { prices = getItemPrices } = {}) {
    const result = {
        actionTypeHrid,
        label: actionTypeLabel(actionTypeHrid),
        ready: false,
        running: false,
        frozen: true,
        slotted: 0,
        held: 0,
        concentration: 0,
        concentrationSource: 'gear',
        forecasts: [],
    };

    const gameData = dataManager.getInitClientData?.();
    const inventory = dataManager.getInventory?.();
    // Before the character loads there is no inventory to count: a held count of
    // zero would be a made-up shortfall rather than a blank
    if (!gameData || !dataManager.characterData || !Array.isArray(inventory)) return result;

    const itemDetailMap = gameData.itemDetailMap || {};
    result.ready = true;
    result.running = runningActionTypeHrid() === actionTypeHrid;
    result.frozen = !result.running;

    const slots = dataManager.getActionDrinkSlots?.(actionTypeHrid) || [];
    const concentration = concentrationFor(actionTypeHrid, result.running, itemDetailMap);
    result.concentration = concentration.value;
    result.concentrationSource = concentration.source;

    const seen = new Set();
    for (const slot of slots) {
        // Empty slots arrive as null
        if (!slot?.itemHrid || seen.has(slot.itemHrid)) continue;
        seen.add(slot.itemHrid);

        const details = dataManager.getItemDetails?.(slot.itemHrid) || itemDetailMap[slot.itemHrid];
        const held = heldInInventory(inventory, slot.itemHrid);
        const perDay = drinkRatePerDay(details?.consumableDetail?.buffs?.[0]?.duration, concentration.value);
        const price = prices?.(slot.itemHrid) || null;

        const entry = forecast(
            {
                itemHrid: slot.itemHrid,
                itemName: details?.name || slot.itemHrid.split('/').pop().replace(/_/g, ' '),
                inventoryAmount: held,
                consumptionRate: perDay === null ? null : perDay / 86400,
                consumedPerDay: perDay === null ? null : Math.ceil(perDay),
                pricePerItem: Number(price?.ask) > 0 ? price.ask : null,
            },
            price
        );

        // The running activation counts toward time left, as `calculateDrinkRemainingSeconds` has it
        const activeSeconds = slot.isActive ? Math.max(0, Number(slot.duration) || 0) / NS_PER_SECOND : 0;
        entry.activeSeconds = activeSeconds;
        if (entry.rateKnown && Number.isFinite(entry.secondsLeft)) entry.secondsLeft += activeSeconds;

        result.forecasts.push(entry);
        result.held += held;
    }
    result.slotted = result.forecasts.length;
    return result;
}
