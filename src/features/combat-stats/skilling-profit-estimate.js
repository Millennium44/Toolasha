/**
 * Skilling profit estimate for the Total Profit tile
 *
 * Total Profit shows what a fight has banked. While a skilling action runs there
 * is no fight to bank anything, but the Actions panel already knows what that
 * action is worth per hour, so the tile shows that figure, marked as an estimate.
 *
 * ## Why this is a memo and not a call per redraw
 *
 * The profit calculators are async and price every input and output of the
 * action. The overlay redraws once a second and a tile's `render` is
 * synchronous, so the answer is asked for in the background and held for a
 * short while; `render` only ever reads what is held.
 *
 * ## What it refuses to show
 *
 * Nothing stale: an answer is kept against the character, the action, the
 * pricing mode and the sell-tax setting it was worked out for, and a reading
 * whose key is not the current one is not drawn. Between the key changing and
 * the new answer arriving the tile says it is estimating. An answer that lands
 * after the character or the action moved on is dropped on arrival.
 *
 * The calculators live in the market bundle and are reached through the bundle
 * bridge. Importing them here would copy their caches into the combat bundle.
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { gatheringProfit, productionProfit } from '../../utils/bundle-bridge.js';
import { runningSkillingAction } from '../../utils/combat-actions.js';
import { GATHERING_TYPES, ALL_SKILL_TYPES } from '../../utils/profit-constants.js';
import { skillName } from '../../utils/skill-progress.js';

/** How long a worked-out figure is held before it is asked for again */
const MEMO_MS = 15000;

/**
 * The held answer.
 * @type {{key: string, at: number, estimate: Object|null, failed: boolean}|null}
 */
let memo = null;

/**
 * The request in flight, so a redraw does not start a second one for the same
 * key and a late answer can tell it was overtaken.
 * @type {{key: string}|null}
 */
let inflight = null;

// An answer worked out for the outgoing character must not be drawn for the
// arriving one, and one still being worked out must not land on it
dataManager.on('character_switching', () => {
    memo = null;
    inflight = null;
});

/**
 * Everything that changes the figure, as one string.
 * @param {string|number|null} characterId - Who is playing
 * @param {string} actionHrid - The running action
 * @returns {string}
 */
function keyFor(characterId, actionHrid) {
    const pricingMode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    const excludeSellTax = config.getSettingValue('profitCalc_excludeSellTax', false) ? 'notax' : 'tax';
    return `${characterId ?? ''}|${actionHrid}|${pricingMode}|${excludeSellTax}`;
}

/**
 * Work the figure out through whichever calculator the action's type belongs to.
 *
 * @param {string} actionHrid - e.g. `/actions/foraging/star_fruit`
 * @param {string} type - e.g. `/action_types/foraging`
 * @returns {Promise<Object|null>} The calculator's profit data, or null when this action has no estimate
 */
async function calculate(actionHrid, type) {
    const module = GATHERING_TYPES.includes(type) ? gatheringProfit() : productionProfit();
    if (!module) return null;
    const data = GATHERING_TYPES.includes(type)
        ? await module.calculateGatheringProfit(actionHrid)
        : await module.calculateProductionProfit(actionHrid);
    if (!data || !Number.isFinite(data.profitPerHour)) return null;
    return {
        profitPerHour: data.profitPerHour,
        hasMissingPrices: Boolean(data.hasMissingPrices),
        pricingMode: data.pricingMode || config.getSettingValue('profitCalc_pricingMode', 'hybrid'),
    };
}

/**
 * Ask for the figure in the background and keep it when it arrives.
 *
 * @param {string} actionHrid - The running action
 * @param {string} type - Its action type
 * @param {string} key - The key it is being worked out for
 * @param {string|number|null} characterId - Who it is being worked out for
 * @returns {Promise<void>}
 */
async function request(actionHrid, type, key, characterId) {
    const ticket = { key };
    inflight = ticket;

    let estimate = null;
    let failed = false;
    try {
        estimate = await calculate(actionHrid, type);
    } catch (error) {
        console.error('[SkillingProfit] Estimating the running action failed:', error);
        failed = true;
    }

    // Overtaken (another action asked, or the character switched and the
    // handler cleared this): the answer belongs to nobody now
    if (inflight !== ticket) return;
    inflight = null;
    if (dataManager.getCurrentCharacterId?.() !== characterId) return;
    memo = { key, at: Date.now(), estimate, failed };
}

/**
 * What the Total Profit tile should say about the running skilling action.
 *
 * `idle` means no skilling action is running, so the tile keeps its combat
 * reading. Asking has the side effect of starting the estimate when none is held
 * for the current key, which is how the first redraw after an action starts
 * kicks it off.
 *
 * @returns {{state: 'idle'}|{state: 'pending'|'none', actionName: string, skillName: string}|{state: 'ready', actionName: string, skillName: string, estimate: Object}}
 */
export function runningSkillingProfit() {
    const running = runningSkillingAction(dataManager.getCurrentActions?.() || [], (hrid) =>
        dataManager.getActionDetails?.(hrid)
    );
    if (!running) return { state: 'idle' };

    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    const key = keyFor(characterId, running.actionHrid);
    const named = {
        actionName: dataManager.getActionDetails?.(running.actionHrid)?.name || skillName(running.actionHrid),
        skillName: skillName(running.skillHrid),
    };

    const held = memo?.key === key ? memo : null;
    const fresh = held && Date.now() - held.at < MEMO_MS;
    // Types the calculators do not cover (Enhancing, Alchemy) are settled here
    // without a call; request() settles the rest in the background
    if (!ALL_SKILL_TYPES.includes(running.type)) return { state: 'none', failed: false, ...named };
    if (!fresh && inflight?.key !== key) void request(running.actionHrid, running.type, key, characterId);

    if (!held) return { state: 'pending', ...named };
    if (!held.estimate) return { state: 'none', failed: held.failed, ...named };
    return { state: 'ready', estimate: held.estimate, ...named };
}

/**
 * A cheap summary of what the tile would draw in the skilling case, for the
 * row's `version()`. Includes the held answer, so the redraw happens when it
 * lands rather than the tile sitting on its "estimating" line.
 *
 * @param {ReturnType<typeof runningSkillingProfit>} reading - From {@link runningSkillingProfit}
 * @returns {string}
 */
export function skillingProfitVersion(reading) {
    if (reading.state === 'ready') {
        const { profitPerHour, hasMissingPrices, pricingMode } = reading.estimate;
        return `skill|${reading.actionName}|${Math.round(profitPerHour)}|${hasMissingPrices ? 1 : 0}|${pricingMode}`;
    }
    return `skill|${reading.actionName}|${reading.state}${reading.failed ? '!' : ''}`;
}
