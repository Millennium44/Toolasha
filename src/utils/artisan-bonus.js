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

/**
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {number} Artisan reduction as a decimal (0.112 = 11.2% fewer inputs), 0 when none or unreadable
 */
export function getArtisanBonus(actionTypeHrid) {
    try {
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
        const { equipment, drinks } = resolveActionContext(actionTypeHrid);
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
        const bonus = parseArtisanBonus(drinks, itemDetailMap, drinkConcentration);
        return bonus > 0 ? bonus : 0;
    } catch {
        // No reduction when the data is unavailable
        return 0;
    }
}

export default { getArtisanBonus };
