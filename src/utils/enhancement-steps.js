/**
 * Enhancement bonus table
 * Maps enhancement level to percentage bonus
 */
export const ENHANCEMENT_BONUSES = {
    1: 0.02,
    2: 0.042,
    3: 0.066,
    4: 0.092,
    5: 0.12,
    6: 0.15,
    7: 0.182,
    8: 0.216,
    9: 0.252,
    10: 0.29,
    11: 0.334,
    12: 0.384,
    13: 0.44,
    14: 0.502,
    15: 0.57,
    16: 0.644,
    17: 0.724,
    18: 0.81,
    19: 0.902,
    20: 1.0,
};

/**
 * The game's step count at an enhancement level: its own table when it has the level, else the fallback table
 * above scaled to the game's units (50 steps per whole base stat).
 * @param {number} enhancementLevel
 * @param {number[]|undefined} gameTable - `enhancementLevelTotalBonusMultiplierTable` from init_client_data
 * @returns {number} Steps (0 for level 0 or an unknown level)
 */
export function enhancementSteps(enhancementLevel, gameTable) {
    const fromGame = gameTable?.[enhancementLevel];
    if (typeof fromGame === 'number' && Number.isFinite(fromGame) && fromGame >= 0) {
        return fromGame;
    }
    return (ENHANCEMENT_BONUSES[enhancementLevel] || 0) * 50;
}

/**
 * Task speed a worn item gives, split into its parts, as the game adds it: `base + steps * bonus`.
 * `noncombatEnhancementBonuses` already includes the slot multiplier, so none is applied here.
 * @param {Object} itemDetail - Item from itemDetailMap
 * @param {number} enhancementLevel
 * @param {number[]|undefined} gameTable
 * @returns {{base: number, enhancement: number}} Fractions (0.15 is 15%)
 */
export function taskSpeedParts(itemDetail, enhancementLevel, gameTable) {
    const detail = itemDetail?.equipmentDetail;
    const base = detail?.noncombatStats?.taskSpeed || 0;
    const perStep = detail?.noncombatEnhancementBonuses?.taskSpeed || 0;
    return { base, enhancement: enhancementSteps(enhancementLevel || 0, gameTable) * perStep };
}
