/**
 * Artisan bonus for a production action type
 *
 * The share of input materials the player's active Artisan Tea (plus Drink Concentration) saves on
 * actions of that skill. Same read as getProductionCost in enhancement-pricing.js: the drinks and gear
 * come from resolveActionContext, so a slotted-but-empty tea is not counted.
 */

import dataManager from '../core/data-manager.js';
import { parseArtisanBonus, getDrinkConcentration } from './tea-parser.js';
import { resolveActionContext } from './action-context.js';
import { drinkEffectConcentration, drinkOutcomes, mixOutcomes } from './talisman-bonuses.js';

/**
 * The Artisan reduction for a set of drinks and gear on an action type, with Invigoration (a talisman chance to double
 * the active drinks' effects on cooking and brewing) counted as two outcomes: the drinks as they are (weight 1 - p) and
 * twice as strong (weight p), weighted by {@link mixOutcomes}. That is the expected reduction per craft (the drink
 * bonus is never averaged first). A reader that rounds each craft up (worst-case) must ask for the 'normal' outcome,
 * the one that saves least, since a proc only ever saves more.
 * @param {Object} args
 * @param {Map|null|undefined} args.equipment
 * @param {Array} args.drinks - Active drinks
 * @param {Object} args.itemDetailMap
 * @param {string} args.actionType
 * @param {'normal'|'doubled'} [args.outcome] - One outcome; left out, the weighted mix
 * @returns {number} Reduction as a decimal
 */
export function artisanBonusFor({ equipment, drinks, itemDetailMap, actionType, outcome }) {
    const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
    const at = (which) =>
        parseArtisanBonus(
            drinks,
            itemDetailMap,
            drinkEffectConcentration(equipment, actionType, drinkConcentration, which)
        );
    if (outcome) return at(outcome);
    return mixOutcomes(
        drinkOutcomes(equipment, actionType).map(({ outcome: which, weight }) => ({ weight, value: at(which) }))
    );
}

/**
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {number} Artisan reduction as a decimal (0.112 = 11.2% fewer inputs), 0 when none or unreadable
 */
export function getArtisanBonus(actionTypeHrid) {
    try {
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
        const { equipment, drinks } = resolveActionContext(actionTypeHrid);
        const bonus = artisanBonusFor({ equipment, drinks, itemDetailMap, actionType: actionTypeHrid });
        return bonus > 0 ? bonus : 0;
    } catch {
        // No reduction when the data is unavailable
        return 0;
    }
}

export default { getArtisanBonus };
