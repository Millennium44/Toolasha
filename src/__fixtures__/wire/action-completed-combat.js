/**
 * `action_completed` from a combat action. Captured on the test server (Golem Cave), 2026-11-01.
 * Differs from the skilling shape in `action-completed.js`: `endCharacterQuests` is `null` (not `[]`),
 * skill and ability rows are the full database rows (`characterID`, `offlineExperience`, `createdAt`,
 * `updatedAt`), and the action runs with a saved loadout (`characterLoadoutID` is not 0) and a negative
 * `ordinal`.
 */

const CAPTURED = {
    type: 'action_completed',
    endCharacterAction: {
        id: 900001,
        characterID: 900001,
        partyID: 0,
        actionHrid: '/actions/combat/golem_cave',
        difficultyTier: 0,
        hasMaxCount: false,
        maxCount: 0,
        currentCount: 97298,
        wave: 0,
        primaryItemHash: '',
        secondaryItemHash: '',
        enhancingMaxLevel: 0,
        enhancingProtectionMinLevel: 0,
        characterLoadoutID: 900401,
        ordinal: -8,
        isDone: false,
        createdAt: '2026-10-10T02:08:47Z',
        updatedAt: '2026-11-01T22:39:02.526306279Z',
    },
    endCharacterItems: [
        {
            id: 6191621,
            characterID: 900001,
            itemLocationHrid: '/item_locations/inventory',
            itemHrid: '/items/coin',
            enhancementLevel: 0,
            count: 5346914614927,
            offlineCount: 0,
            hash: '900001::/item_locations/inventory::/items/coin::0',
            createdAt: '2026-08-05T16:47:30Z',
            updatedAt: '2026-11-01T22:39:02.483275843Z',
        },
        {
            id: 6192079,
            characterID: 900001,
            itemLocationHrid: '/item_locations/inventory',
            itemHrid: '/items/emp_tea_leaf',
            enhancementLevel: 0,
            count: 206806,
            offlineCount: 0,
            hash: '900001::/item_locations/inventory::/items/emp_tea_leaf::0',
            createdAt: '2026-08-05T21:51:20Z',
            updatedAt: '2026-11-01T22:39:02.492839475Z',
        },
    ],
    endCharacterAbilities: [
        {
            characterID: 900001,
            abilityHrid: '/abilities/entangle',
            experience: 10219273.899988443,
            level: 100,
            slotNumber: 5,
            createdAt: '2026-08-05T19:25:23Z',
            updatedAt: '2026-11-01T22:39:02.505641884Z',
        },
        {
            characterID: 900001,
            abilityHrid: '/abilities/life_drain',
            experience: 10037383.099922089,
            level: 100,
            slotNumber: 4,
            createdAt: '2026-08-05T19:25:16Z',
            updatedAt: '2026-11-01T22:39:02.510537381Z',
        },
        {
            characterID: 900001,
            abilityHrid: '/abilities/mystic_aura',
            experience: 10004850.099981932,
            level: 100,
            slotNumber: 1,
            createdAt: '2026-08-05T19:24:41Z',
            updatedAt: '2026-11-01T22:39:02.511900157Z',
        },
        {
            characterID: 900001,
            abilityHrid: '/abilities/precision',
            experience: 10021717.1999294,
            level: 100,
            slotNumber: 3,
            createdAt: '2026-08-05T19:25:00Z',
            updatedAt: '2026-11-01T22:39:02.514967521Z',
        },
        {
            characterID: 900001,
            abilityHrid: '/abilities/rejuvenate',
            experience: 10019682.199943593,
            level: 100,
            slotNumber: 2,
            createdAt: '2026-08-05T19:24:50Z',
            updatedAt: '2026-11-01T22:39:02.515910548Z',
        },
    ],
    endCharacterSkills: [
        {
            characterID: 900001,
            skillHrid: '/skills/magic',
            experience: 1823131167.1420412,
            level: 153,
            offlineExperience: 0,
            createdAt: '2026-08-05T16:44:01Z',
            updatedAt: '2026-11-01T22:39:02.520942964Z',
        },
        {
            characterID: 900001,
            skillHrid: '/skills/total_level',
            experience: 10269012380.849977,
            level: 2085,
            offlineExperience: 0,
            createdAt: '2026-08-05T16:44:01Z',
            updatedAt: '2026-11-01T22:39:02.524556116Z',
        },
    ],
    endCharacterQuests: null,
};

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} A combat `action_completed` message (a fresh copy each call)
 */
export function buildCombatActionCompleted(overrides = {}) {
    return { ...structuredClone(CAPTURED), ...overrides };
}
