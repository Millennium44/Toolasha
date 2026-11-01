/**
 * `skills_updated` and the skill slice of `action_completed`.
 * Captured on the test server (MillenniumTest), 2026-10-31/11-01. The game's own
 * `handleMessageSkillsUpdated` reads `endCharacterSkills` (and `endCharacterAbilities`)
 * and merges by `skillHrid`; there is no `characterSkills` key on this message.
 * Only the skills that changed are listed, plus the synthetic `total_level` row.
 */

/** A skill row as the wire carries it. */
export function buildSkillRow(skillHrid, level, experience, overrides = {}) {
    return { skillHrid, level, experience, ...overrides };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} A `skills_updated` message
 */
export function buildSkillsUpdated(overrides = {}) {
    return {
        type: 'skills_updated',
        endCharacterSkills: [buildSkillRow('/skills/milking', 11, 1400), buildSkillRow('/skills/total_level', 51, 0)],
        endCharacterAbilities: [],
        ...overrides,
    };
}
