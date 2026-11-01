/**
 * Small `init_character_data` / `init_client_data` pieces. Test server, 2026-10-31/11-01.
 */

/** `characterInfo`: `offlineHourCap` is 20 hours base plus any bought upgrades. */
export function buildCharacterInfo(overrides = {}) {
    return { offlineHourCap: 20, ...overrides };
}

/** Every `characterSetting.labyrinthSkip<Room>` key is always present; the game default is 100. */
export const LABYRINTH_SKIP_DEFAULT = 100;
export function buildLabyrinthSkipSettings(roomSuffixes = ['Milking', 'Imp', 'GiantShoeBird'], overrides = {}) {
    const out = {};
    for (const suffix of roomSuffixes) out[`labyrinthSkip${suffix}`] = LABYRINTH_SKIP_DEFAULT;
    return { ...out, ...overrides };
}

/** `initClientData.abilitySlotsLevelRequirementList`, indexed by slot number 1..5 (index 0 unused). */
export const ABILITY_SLOTS_LEVEL_REQUIREMENT_LIST = [0, 1, 1, 20, 50, 90];

/** The only labyrinth entry in `actionDetailMap`. */
export const LABYRINTH_ACTION = { hrid: '/actions/labyrinth/explore', typeHrid: '/action_types/labyrinth' };
