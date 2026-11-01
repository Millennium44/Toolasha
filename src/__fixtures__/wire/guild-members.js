/**
 * Guild member sign-up fields, from `init_character_data.guildCharacterMap` members.
 * Captured on the test server (MillenniumIC3), 2026-10-31. `""` means no sign-up. A
 * sign-up counts only when `signupWeekStartAt` is the current week. The capture did
 * not record the hrid prefix; `/guild_combat/` and `/guild_skilling/` are the ones
 * this repo's code already reads.
 */

export function buildGuildMember(overrides = {}) {
    return {
        characterID: 900201,
        name: 'Player01',
        signedUpCombatTrialHrid: '',
        signedUpSkillingTrialHrid: '',
        signupWeekStartAt: '2026-10-26T00:00:00Z',
        ...overrides,
    };
}
