/**
 * Talisman modifier details as the game sends them, for code that reads both the values and the groups.
 *
 * The values (keys, isPercent, gradeValues) come from talisman-combat-modifiers.js and talisman-bonuses.js; the draw
 * weight and group of every line from talisman-reroll.js. All three are cuts of the same survey of the test server's
 * talismanModifierDetailMap (2026-11-12), so the merge is the game's own record for each line.
 */

import { COMBAT_MODIFIER_DETAILS } from './talisman-combat-modifiers.js';
import { MODIFIER_DETAILS } from './talisman-bonuses.js';
import { REROLL_MODIFIERS } from './talisman-reroll.js';

function merged() {
    const out = {};
    for (const [hrid, detail] of Object.entries({ ...COMBAT_MODIFIER_DETAILS, ...MODIFIER_DETAILS })) {
        const reroll = REROLL_MODIFIERS[hrid] || {};
        out[hrid] = { ...reroll, ...detail, groupHrid: reroll.groupHrid, weight: reroll.weight };
    }
    return out;
}

/** Every combat line and the skilling subset, with `groupHrid` and `weight` as the game sends them */
export const FULL_MODIFIER_DETAILS = merged();
