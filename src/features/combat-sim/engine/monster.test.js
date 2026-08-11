/**
 * The labyrinth builds a monster at difficultyTier 0, which drops every
 * tier-gated ability — leaving a monster like the Cyclops as a bare
 * auto-attacker and the sim over-predicting clears. `includeAllAbilities` is the
 * lever that keeps the full kit; this pins that gating down.
 *
 * A minimal single-effect ability detail is supplied so the abilities can
 * actually instantiate; the gating, not the ability's mechanics, is under test.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from './game-data.js';
import Monster from './monster.js';

const HRID = '/monsters/test_dummy';
const ABILITY_HRID = '/abilities/test_blast';

/** A minimal damage ability the engine can instantiate */
const ABILITY_DETAIL = {
    hrid: ABILITY_HRID,
    manaCost: 0,
    cooldownDuration: 5e9,
    castDuration: 0,
    isSpecialAbility: false,
    abilityEffects: [
        {
            targetType: 'allEnemies',
            effectType: '/ability_effect_types/damage',
            combatStyleHrid: '/combat_styles/magic',
            damageType: '/damage_types/fire',
            baseDamageFlat: 0,
            baseDamageFlatLevelBonus: 0,
            baseDamageRatio: 0.3,
            baseDamageRatioLevelBonus: 0,
            bonusAccuracyRatio: 0,
            bonusAccuracyRatioLevelBonus: 0,
            damageOverTimeRatio: 0,
            damageOverTimeDuration: 0,
            armorDamageRatio: 0,
            armorDamageRatioLevelBonus: 0,
            hpDrainRatio: 0,
            pierceChance: 0,
            blindChance: 0,
            blindDuration: 0,
            silenceChance: 0,
            silenceDuration: 0,
            stunChance: 0,
            stunDuration: 0,
            spendHpRatio: 0,
            buffs: null,
        },
    ],
    defaultCombatTriggers: [],
};

/** Two abilities, one available at tier 0 and one gated behind tier 1 */
const ABILITIES = [
    { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 0 },
    { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 1 },
];

function seed(abilities = ABILITIES) {
    setGameData({
        abilityDetailMap: { [ABILITY_HRID]: ABILITY_DETAIL },
        combatMonsterDetailMap: { [HRID]: { enrageTime: 0, abilities } },
    });
}

afterEach(() => setGameData(null));

describe('Monster ability tier gating', () => {
    test('at difficulty tier 0 the tier-gated ability is dropped by default', () => {
        seed();
        const monster = new Monster(HRID, 0, 100);
        expect(monster.abilities.filter(Boolean)).toHaveLength(1);
    });

    test('includeAllAbilities keeps the full kit even at tier 0', () => {
        seed();
        const monster = new Monster(HRID, 0, 100, true);
        expect(monster.abilities.filter(Boolean)).toHaveLength(2);
    });

    test('the tier filter still applies to non-labyrinth monsters', () => {
        // A tier-2 monster instantiates a tier-1 ability but not a tier-3 gate
        seed([
            { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 1 },
            { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 3 },
        ]);
        const monster = new Monster(HRID, 2, 0);
        expect(monster.abilities.filter(Boolean)).toHaveLength(1);
    });
});
