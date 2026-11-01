/**
 * `battle_consumable_ability_updated`. Captured on the test server (Golem Cave), 2026-11-01.
 * Announces an ability cast; `ability` is an object (`abilityHrid`, `level`, `experience`) with the new
 * `availableTime`. Three captured messages: two for the same ability at different times, one for another.
 */

const CAPTURED = [
    {
        type: 'battle_consumable_ability_updated',
        ability: {
            abilityHrid: '/abilities/entangle',
            level: 100,
            experience: 10219272.899988443,
            availableTime: '2026-11-01T22:38:57.891317227Z',
        },
    },
    {
        type: 'battle_consumable_ability_updated',
        ability: {
            abilityHrid: '/abilities/mystic_aura',
            level: 100,
            experience: 10004849.999981932,
            availableTime: '2026-11-01T22:40:41.38830655Z',
        },
    },
    {
        type: 'battle_consumable_ability_updated',
        ability: {
            abilityHrid: '/abilities/entangle',
            level: 100,
            experience: 10219272.899988443,
            availableTime: '2026-11-01T22:39:00.083898702Z',
        },
    },
];

/**
 * @param {number} [shape] - Which captured message (0 to 2)
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} A `battle_consumable_ability_updated` message (a fresh copy each call)
 */
export function buildBattleConsumableAbilityUpdated(shape = 0, overrides = {}) {
    return { ...structuredClone(CAPTURED[shape]), ...overrides };
}
