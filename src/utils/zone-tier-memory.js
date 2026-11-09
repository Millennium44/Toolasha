/**
 * The difficulty tier a combat task estimate simulates, and Go opens a zone at.
 *
 * The game remembers each zone's Difficulty pick per character in the page's localStorage
 * (`lastSelectedActionDifficultyMap_<characterId>` = `{ [zoneHrid]: tier }`, read off the test server
 * 2026-11-08) and opens the zone's panel at it. Toolasha reads that map and never writes it, so the
 * estimate simulates the tier the game will show and Go leaves the player's pick alone. A zone the game
 * has no pick for opens at T0.
 *
 * `taskCombatGoTier` "best" instead has the task card search every tier for the best balanced Score
 * (`task-profit-display.js`); this module still answers the game's pick there, for everything else.
 *
 * Earlier builds kept their own record of the tier last run in each zone (`combatZoneTiers_<id>`, a
 * synced settings key). Nothing reads it any more; a stored copy is left as it is.
 *
 * Lives in `utils` and is shared by global (rollup.config.js) because the task cards and the Task
 * Statistics rows read it from different bundles.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';

/** The game's own per-zone Difficulty selection: `localStorage[<base>_<characterId>]` = `{ [zoneHrid]: tier }` */
export const GAME_SELECTED_TIERS_KEY = 'lastSelectedActionDifficultyMap';

/** `taskCombatGoTier` values */
export const GO_TIER_GAME = 'game';
export const GO_TIER_BEST = 'best';

/**
 * The tier the game's own Difficulty box will show for a zone when it opens.
 * @param {string} zoneHrid
 * @returns {number|null} Null when the game has no pick for this zone or it cannot be read
 */
export function gameSelectedTier(zoneHrid) {
    const who = dataManager.getCurrentCharacterId?.();
    if (!zoneHrid || !who) return null;
    try {
        const raw = globalThis.localStorage?.getItem(`${GAME_SELECTED_TIERS_KEY}_${who}`);
        if (!raw) return null;
        const tier = JSON.parse(raw)?.[zoneHrid];
        return Number.isInteger(tier) && tier >= 0 ? tier : null;
    } catch {
        return null;
    }
}

/** @returns {string} The `taskCombatGoTier` setting: {@link GO_TIER_GAME} or {@link GO_TIER_BEST} */
export function goTierMode() {
    try {
        const mode = config.getSettingValue?.('taskCombatGoTier', GO_TIER_GAME);
        return mode === GO_TIER_BEST ? GO_TIER_BEST : GO_TIER_GAME;
    } catch {
        return GO_TIER_GAME;
    }
}

/**
 * The tier the game will open a zone at, and where it came from.
 * @param {string} zoneHrid
 * @returns {{tier: number, known: boolean, source: 'selected'|'default', pending: boolean}}
 *   `source` 'default' is the game's own T0 for a zone it has no pick for. `pending` is always false
 *   (kept for the callers' shape).
 */
export function resolveZoneTier(zoneHrid) {
    const selected = gameSelectedTier(zoneHrid);
    if (selected !== null) return { tier: selected, known: true, source: 'selected', pending: false };
    return { tier: 0, known: true, source: 'default', pending: false };
}

/**
 * Words for where a tier came from, for the card's tooltip and breakdown.
 * @param {number} tier
 * @param {{source: string}} resolved
 * @returns {string} For example "T3 (the tier selected in the game)"
 */
export function describeZoneTier(tier, resolved) {
    if (resolved.source === 'best') return `T${tier} (best Score of the tiers simulated)`;
    if (resolved.source === 'selected') return `T${tier} (the tier selected in the game)`;
    return `T${tier} (the game's default for this zone)`;
}
