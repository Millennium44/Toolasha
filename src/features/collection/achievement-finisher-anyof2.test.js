/**
 * Azure tools, jewelry, dungeon equipment and refining as "any of" achievements, the real steam ids of the
 * first six, and the Shoebill monster-name case.
 */

import { describe, test, expect } from 'vitest';

import { resolveAchievement, readiness } from './achievement-finisher-resolve.js';
import { ANY_OF_DATA as DATA } from './__fixtures__/achievement-finisher-anyof.js';
import {
    MORE_ANY_OF_ACHIEVEMENTS as A,
    MORE_ANY_OF_DATA as D,
    SHOEBILL,
} from './__fixtures__/achievement-finisher-anyof2.js';

const ctx = (levels = {}, over = {}) => ({
    skillLevels: new Map(Object.entries(levels).map(([skill, level]) => [`/skills/${skill}`, level])),
    combatLevel: 50,
    inventory: [],
    ironCow: false,
    buyPrice: () => null,
    ...over,
});
const hrids = (res) => res.candidates.map((c) => c.actionHrid);

describe('azure tools, jewelry, dungeon equipment and refining', () => {
    test('azure tools: cheesesmithing actions that make an azure tool only', () => {
        expect(hrids(resolveAchievement(A.azure, D))).toEqual([
            '/actions/cheesesmithing/azure_hatchet',
            '/actions/cheesesmithing/azure_pickaxe',
        ]);
    });

    test('jewelry: crafting actions for neck, ear and ring slots', () => {
        expect(hrids(resolveAchievement(A.jewelry, D))).toEqual([
            '/actions/crafting/pearl_necklace',
            '/actions/crafting/ruby_ring',
        ]);
    });

    test('dungeon equipment: crafted equipment with a dungeon component, not the plain sword', () => {
        expect(hrids(resolveAchievement(A.dungeon, D))).toEqual(['/actions/crafting/chimerical_quiver']);
    });

    test('refining: the _refined piece made from an upgrade item, nothing else', () => {
        expect(hrids(resolveAchievement(A.refine, D))).toEqual(['/actions/crafting/chimerical_quiver_refined']);
    });

    test('the steam id alone selects the set when the description is in another language', () => {
        expect(resolveAchievement({ ...A.jewelry, description: 'x' }, D).candidates).toHaveLength(2);
    });

    test('readiness: the cheaper jewelry craft once both levels are met', () => {
        const prices = { '/items/ruby': 10, '/items/pearl': 500 };
        const ready = readiness(
            resolveAchievement(A.jewelry, D),
            ctx({ crafting: 60 }, { buyPrice: (h) => prices[h] ?? null })
        );
        expect(ready.actionHrid).toBe('/actions/crafting/ruby_ring');
        expect(ready.cost).toBe(20);
    });

    test('the real steam ids of the first six resolve', () => {
        const real = (steam) => resolveAchievement({ steamAchievementId: steam, description: 'x' }, DATA);
        expect(real('ach_craft_celestial_tool_or_outfit').candidates).toHaveLength(3);
        expect(real('ach_tailor_gluttonous_or_guzzling_pouch').candidates).toHaveLength(2);
        expect(real('ach_craft_master_charm').candidates).toHaveLength(2);
        expect(real('ach_collect_butter_of_proficiency').rareItemHrid).toBe('/items/butter_of_proficiency');
    });
});

describe('Defeat Shoebill', () => {
    test('resolves to the boss zone of the longer-named monster', () => {
        expect(resolveAchievement(SHOEBILL.achievement, SHOEBILL.data)).toMatchObject({
            kind: 'combat',
            actionHrid: '/actions/combat/swamp_planet',
            monsterHrid: '/monsters/giant_shoebill',
        });
    });

    test('two monsters ending in the name stay unresolved', () => {
        const data = {
            ...SHOEBILL.data,
            combatMonsterDetailMap: {
                ...SHOEBILL.data.combatMonsterDetailMap,
                '/monsters/baby_shoebill': { name: 'Baby Shoebill', combatDetails: { combatLevel: 4 } },
            },
        };
        expect(resolveAchievement(SHOEBILL.achievement, data)).toBeNull();
    });
});
