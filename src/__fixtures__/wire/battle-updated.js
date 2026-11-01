/**
 * `battle_updated`. Captured on the test server (Golem Cave), 2026-11-01.
 * `pMap` / `mMap` are deltas keyed by unit INDEX (a string), holding only the units that changed;
 * an empty `mMap` is a real shape. A cast carries `abilityHrid`; a plain auto-attack tick does not.
 * `battleId` is rebased onto the `new_battle` fixture so the two messages describe one battle.
 * The three entries: a player cast plus a monster tick, a player cast with an empty `mMap`, and a player
 * hit plus a monster ability cast.
 */

const CAPTURED = [
    {
        type: 'battle_updated',
        battleId: 16642,
        pMap: {
            0: {
                cHP: 1923,
                mHP: 1923,
                cMP: 2438,
                mMP: 2608,
                isActive: true,
                leftCombat: false,
                atkCounter: 180478,
                abilityHrid: '/abilities/mystic_aura',
                int: 136992306,
                dmgCounter: 142453,
                critCounter: 0,
            },
        },
        mMap: {
            2: {
                cHP: 319,
                mHP: 1600,
                cMP: 1600,
                mMP: 1600,
                isActive: true,
                leftCombat: false,
                atkCounter: 10,
                isAutoAtk: true,
                int: 2702702702,
                dmgCounter: 3,
                critCounter: 0,
            },
        },
    },
    {
        type: 'battle_updated',
        battleId: 16642,
        pMap: {
            0: {
                cHP: 1923,
                mHP: 1923,
                cMP: 2338,
                mMP: 2608,
                isActive: true,
                leftCombat: false,
                atkCounter: 180479,
                abilityHrid: '/abilities/entangle',
                int: 2054884597,
                dmgCounter: 142453,
                critCounter: 0,
            },
        },
        mMap: {},
    },
    {
        type: 'battle_updated',
        battleId: 16642,
        pMap: {
            0: {
                cHP: 1923,
                mHP: 1923,
                cMP: 2338,
                mMP: 2608,
                isActive: true,
                leftCombat: false,
                atkCounter: 180479,
                abilityHrid: '/abilities/entangle',
                int: 2054884597,
                dmgCounter: 142454,
                critCounter: 0,
            },
        },
        mMap: {
            2: {
                cHP: 319,
                mHP: 1600,
                cMP: 1600,
                mMP: 1600,
                isActive: true,
                leftCombat: false,
                atkCounter: 11,
                abilityHrid: '/abilities/toughness',
                int: 270270270,
                dmgCounter: 3,
                critCounter: 0,
            },
        },
    },
];

/**
 * @param {number} [shape] - Which captured shape (0 to 2)
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} A `battle_updated` message (a fresh copy each call)
 */
export function buildBattleUpdated(shape = 0, overrides = {}) {
    return { ...structuredClone(CAPTURED[shape]), ...overrides };
}

/** Number of captured shapes. */
export const BATTLE_UPDATED_SHAPES = 3;
