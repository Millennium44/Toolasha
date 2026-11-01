/**
 * `action_completed`. Captured on the test server, 2026-10-31/11-01.
 * Carries the finished/continuing action, and every row the action changed: items,
 * abilities, skills (changed ones plus `total_level`) and quests.
 */
import { buildCharacterAction } from './character-actions.js';

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} An `action_completed` message
 */
export function buildActionCompleted(overrides = {}) {
    return {
        type: 'action_completed',
        endCharacterAction: buildCharacterAction({ id: 900001, currentCount: 1 }),
        endCharacterItems: [],
        endCharacterAbilities: [],
        endCharacterSkills: [
            { skillHrid: '/skills/milking', level: 11, experience: 1400 },
            { skillHrid: '/skills/total_level', level: 51, experience: 0 },
        ],
        endCharacterQuests: [],
        ...overrides,
    };
}
