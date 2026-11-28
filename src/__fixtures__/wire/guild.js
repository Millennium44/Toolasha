/**
 * Guild membership changes, as the game sends them when a character leaves a guild and creates another.
 * Captured on the test server (2026-11-28, a character leaving a guild then creating one). Ids and names are
 * synthesized. Joining an existing guild with buildings (a non-empty `guildBuildingLevelMap`) and a guild-mate
 * joining or leaving were not captured; they are assumed to carry the same full replacement maps.
 */

const WEEKLY_TRIAL_SET = {
    skillHrids: [
        '/guild_skilling/cooking',
        '/guild_skilling/alchemy',
        '/guild_skilling/foraging',
        '/guild_skilling/enhancing',
    ],
    combatHrids: ['/guild_combat/chameleon', '/guild_combat/badger'],
};

export const FIXTURE_NEW_GUILD_ID = 900725;
export const FIXTURE_NEW_GUILD_NAME = 'FixtureNewGuild';
export const FIXTURE_OWN_CHARACTER_ID = 900301;

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} The `guild_updated` a leave sends: `guild: null` and empty building levels
 */
export function buildGuildLeftUpdated(overrides = {}) {
    return {
        type: 'guild_updated',
        guild: null,
        guildWeeklyTrialSet: structuredClone(WEEKLY_TRIAL_SET),
        guildBuildingLevelMap: {},
        guildTrialScheduleHourOffset: 0,
        ...overrides,
    };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} The `guild_updated` a create sends: the whole guild object
 */
export function buildGuildCreatedUpdated(overrides = {}) {
    return {
        type: 'guild_updated',
        guild: {
            id: FIXTURE_NEW_GUILD_ID,
            name: FIXTURE_NEW_GUILD_NAME,
            guildIconItemHrid: '',
            guildIconTier: 0,
            guildType: 'casual',
            experience: 0,
            level: 1,
            noticeMessage: `Welcome to ${FIXTURE_NEW_GUILD_NAME}!`,
            isDisbanded: false,
            applicationsOpen: false,
            guildPoints: 0,
            lifetimeGuildPoints: 0,
            currentWeekStartAt: '2026-11-28T00:00:00Z',
            currentTrialsData: '{}',
            trialScheduleHourOffset: -1,
            trialMinLevelsData: '{}',
            createdAt: '2026-11-28T17:02:29Z',
            updatedAt: '2026-11-28T17:02:29Z',
        },
        guildWeeklyTrialSet: structuredClone(WEEKLY_TRIAL_SET),
        guildBuildingLevelMap: {},
        guildTrialScheduleHourOffset: 4,
        ...overrides,
    };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} The `guild_characters_updated` a leave sends: all three maps empty
 */
export function buildGuildLeftCharacters(overrides = {}) {
    return {
        type: 'guild_characters_updated',
        guildCharacterMap: {},
        guildSharableCharacterMap: {},
        guildTrialSignupLevelMap: {},
        ...overrides,
    };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} The `guild_characters_updated` a create sends: the founder as the only member
 */
export function buildGuildCreatedCharacters(overrides = {}) {
    return {
        type: 'guild_characters_updated',
        guildCharacterMap: {
            [FIXTURE_OWN_CHARACTER_ID]: {
                guildID: FIXTURE_NEW_GUILD_ID,
                characterID: FIXTURE_OWN_CHARACTER_ID,
                inviterCharacterID: FIXTURE_OWN_CHARACTER_ID,
                role: 'leader',
                status: 'joined',
                guildExperience: 0,
                joinTime: '2026-11-28T17:02:28.875Z',
                leaveTime: '0001-01-01T00:00:00Z',
                signedUpSkillingTrialHrid: '',
                signedUpSkillingLoadoutID: 0,
                signedUpCombatTrialHrid: '',
                signedUpCombatLoadoutID: 0,
                signedUpCombatRoleHrid: '',
                signupWeekStartAt: '1970-01-01T00:00:00Z',
                trialLoadoutPrefs: '{}',
                trialRolePrefs: '{}',
                weeklyGuildExperience: 0,
            },
        },
        guildSharableCharacterMap: {
            [FIXTURE_OWN_CHARACTER_ID]: {
                name: 'FixtureFounder',
                gameMode: 'ironcow',
                hasMooPass: true,
                actionType: '/action_types/combat',
                isOnline: true,
                createdAt: '2026-09-03T13:33:34Z',
            },
        },
        guildTrialSignupLevelMap: {},
        ...overrides,
    };
}
