/**
 * Guild member sign-up fields, from `init_character_data.guildCharacterMap` members.
 * Captured on the test server (MillenniumIC3), 2026-10-31. `""` means no sign-up. A
 * sign-up counts only when `signupWeekStartAt` is the current week. The capture did
 * not record the hrid prefix; `/guild_combat/` and `/guild_skilling/` are the ones
 * this repo's code already reads.
 *
 * Role and loadout fields, from the 2026-11-02 trial capture (test server, 128 members): the role is a
 * bare `damage_dealer`, `support` or `tank` (`""` for none; 11 members had a combat trial and no role), a
 * loadout id is a number with 0 for none, and both prefs fields are JSON strings keyed by trial hrid.
 */

export function buildGuildMember(overrides = {}) {
    return {
        characterID: 900201,
        name: 'Player01',
        signedUpCombatTrialHrid: '',
        signedUpSkillingTrialHrid: '',
        signedUpCombatRoleHrid: '',
        signedUpCombatLoadoutID: 0,
        signedUpSkillingLoadoutID: 0,
        trialRolePrefs: '',
        trialLoadoutPrefs: '',
        signupWeekStartAt: '2026-10-26T00:00:00Z',
        ...overrides,
    };
}

/** A member signed up for a skilling and a combat trial with a role, as the 2026-11-02 capture shows one. */
export function buildSignedUpGuildMember(overrides = {}) {
    return buildGuildMember({
        signedUpSkillingTrialHrid: '/guild_skilling/foraging',
        signedUpSkillingLoadoutID: 15811,
        signedUpCombatTrialHrid: '/guild_combat/swarm',
        signedUpCombatLoadoutID: 41111,
        signedUpCombatRoleHrid: 'damage_dealer',
        trialRolePrefs: '{"/guild_combat/badger":"damage_dealer","/guild_combat/swarm":"damage_dealer"}',
        trialLoadoutPrefs: '{"/guild_combat/swarm":41111,"/guild_skilling/foraging":15811}',
        signupWeekStartAt: '2026-11-02T00:00:00Z',
        ...overrides,
    });
}
