/**
 * The build-guide swap generator must offer the aura group's OR-alternative.
 *
 * A magic loadout running Mystic Aura should be offered Mystic Aura → Critical
 * Aura, and it was not: the generator ran every guide offer through a
 * style-from-buff-data heuristic that reads a universal aura (Critical Aura) as
 * some other style and vetoes it. The guide's own set is style-correct by
 * construction, so on the guide path the heuristic must not run — these tests
 * lock that in with a Critical Aura whose buff data deliberately misclassifies.
 */

import { describe, test, expect } from 'vitest';
import { generateCandidates } from './upgrade-advisor.js';

function gameData(criticalAuraEffects) {
    const magicAura = (name) => ({
        name,
        isSpecialAbility: true,
        abilityEffects: [{ buffs: [{ typeHrid: '/buff_types/damage', multiplierForSkillHrid: '/skills/magic' }] }],
    });
    const spell = (name) => ({
        name,
        isSpecialAbility: false,
        abilityEffects: [{ combatStyleHrid: '/combat_styles/magic' }],
    });
    return {
        itemDetailMap: {
            '/items/blooming_trident': {
                name: 'Blooming Trident',
                equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { magicDamage: 100 } },
            },
        },
        abilityDetailMap: {
            '/abilities/mystic_aura': magicAura('Mystic Aura'),
            '/abilities/critical_aura': {
                name: 'Critical Aura',
                isSpecialAbility: true,
                abilityEffects: criticalAuraEffects,
            },
            '/abilities/elemental_affinity': spell('Elemental Affinity'),
            '/abilities/precision': spell('Precision'),
            '/abilities/ice_spear': spell('Ice Spear'),
            '/abilities/entangle': spell('Entangle'),
        },
    };
}

/** A Nature loadout (Blooming Trident) running Mystic Aura, plus two off-guide fire spells */
const player = () => ({
    equipment: { '/equipment_types/two_hand': { hrid: '/items/blooming_trident' } },
    abilities: [
        { hrid: '/abilities/mystic_aura', level: 30 },
        { hrid: '/abilities/elemental_affinity', level: 43 },
        { hrid: '/abilities/precision', level: 72 },
        { hrid: '/abilities/smoke_burst', level: 47 },
        { hrid: '/abilities/fireball', level: 48 },
    ],
});

const offersAuraSwap = (gd) =>
    generateCandidates(player(), gd, 'ability_swap').some(
        (c) => c.upgradeHrid === '/abilities/critical_aura' && c.replacesHrid === '/abilities/mystic_aura'
    );

describe('aura group OR-alternative is offered on the guide path', () => {
    test('a universal Critical Aura is offered', () => {
        expect(offersAuraSwap(gameData([{ buffs: [{ typeHrid: '/buff_types/critical_rate' }] }]))).toBe(true);
    });

    test('offered even when Critical Aura buff data reads as another style', () => {
        const misclassifying = [
            { buffs: [{ typeHrid: '/buff_types/critical_rate', multiplierForSkillHrid: '/skills/melee' }] },
        ];
        expect(offersAuraSwap(gameData(misclassifying))).toBe(true);
    });
});
