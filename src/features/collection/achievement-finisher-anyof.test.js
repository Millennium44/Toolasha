/**
 * Rare-drop "Collect" and "any of" production achievements: resolving to candidate actions, and which
 * one readiness picks for a character.
 */

import { describe, test, expect } from 'vitest';

import { resolveAchievement, readiness } from './achievement-finisher-resolve.js';
import { ANY_OF_ACHIEVEMENTS as ACH, ANY_OF_DATA as DATA } from './__fixtures__/achievement-finisher-anyof.js';

const resolve = (slug, data = DATA) => resolveAchievement(ACH[`/achievements/${slug}`], data);
const inv = (itemHrid, count, extra = {}) => ({
    itemHrid,
    count,
    itemLocationHrid: '/item_locations/inventory',
    enhancementLevel: 0,
    ...extra,
});
const ctx = (levels = {}, over = {}) => ({
    skillLevels: new Map(Object.entries(levels).map(([skill, level]) => [`/skills/${skill}`, level])),
    combatLevel: 50,
    inventory: [],
    ironCow: false,
    buyPrice: () => null,
    ...over,
});

describe('rare-drop Collect achievements', () => {
    test('resolve to every skill action whose rare table lists the item, odds per action', () => {
        const res = resolve('collect_butter_of_proficiency');
        expect(res.kind).toBe('production');
        expect(res.rareItemHrid).toBe('/items/butter_of_proficiency');
        expect(res.candidates.map((c) => [c.actionHrid, c.level, c.dropRate, c.gathering])).toEqual([
            ['/actions/cheesesmithing/holy_cheese', 80, 0.00003, false],
            ['/actions/milking/holy_cow', 80, 0.00003, true],
            ['/actions/milking/unicow', 65, 0.00001, true],
        ]);
    });

    test('a duplicate drop entry for one action is two independent rolls, not two candidates', () => {
        const res = resolve('collect_branch_of_insight');
        const tree = res.candidates.filter((c) => c.actionHrid === '/actions/woodcutting/tree_a');
        expect(tree).toHaveLength(1);
        expect(tree[0].dropRate).toBeCloseTo(0.00019999, 8);
    });

    test('the description names the item when the hrid does not', () => {
        const res = resolveAchievement(
            { description: 'Collect a Butter of Proficiency from Milking or Cheesesmithing' },
            DATA
        );
        expect(res.rareItemHrid).toBe('/items/butter_of_proficiency');
    });

    test('an item no action drops resolves to nothing', () => {
        expect(resolve('collect_butter_of_proficiency', { ...DATA, actionDetailMap: {} })).toBeNull();
    });

    test('the highest rate among the met levels, over a better one the player cannot use', () => {
        const ready = readiness(resolve('collect_butter_of_proficiency'), ctx({ milking: 70, cheesesmithing: 1 }));
        expect(ready.actionHrid).toBe('/actions/milking/unicow');
        expect(ready.levelMet).toBe(true);
        expect(ready.dropRate).toBe(0.00001);
    });

    test('a tie on rate goes to the lower level, then to gathering before production', () => {
        const all = ctx({ milking: 90, cheesesmithing: 90 });
        expect(readiness(resolve('collect_butter_of_proficiency'), all).actionHrid).toBe('/actions/milking/holy_cow');
        // Same rate and level: tree_b (gathering, 70) and branch_craft (production, 70) tie at 0.0002
        const branch = readiness(resolve('collect_branch_of_insight'), ctx({ woodcutting: 70, crafting: 70 }));
        expect(branch.actionHrid).toBe('/actions/woodcutting/tree_b');
        // Level breaks the tie before the kind: a lower-level production action beats a higher gathering one
        const res = resolve('collect_branch_of_insight');
        const lowerProduction = {
            ...res,
            candidates: res.candidates.map((c) =>
                c.actionHrid === '/actions/crafting/branch_craft' ? { ...c, level: 60 } : c
            ),
        };
        expect(readiness(lowerProduction, ctx({ woodcutting: 70, crafting: 70 })).actionHrid).toBe(
            '/actions/crafting/branch_craft'
        );
    });

    test('none met: the lowest-level candidate, with the shortfall', () => {
        const ready = readiness(resolve('collect_butter_of_proficiency'), ctx({ milking: 10, cheesesmithing: 10 }));
        expect(ready.actionHrid).toBe('/actions/milking/unicow');
        expect(ready.levelMet).toBe(false);
        expect(ready.level).toMatchObject({ have: 10, need: 65 });
    });

    test('a chosen production action reports its short inputs; unpriced ones are not free', () => {
        const res = resolve('collect_butter_of_proficiency');
        // Only the production action is level-met
        const ready = readiness(res, ctx({ milking: 1, cheesesmithing: 80 }));
        expect(ready.actionHrid).toBe('/actions/cheesesmithing/holy_cheese');
        expect(ready.shortfall).toEqual([{ itemHrid: '/items/holy_milk', need: 2, have: 0 }]);
        expect(ready.cost).toBeNull();
        expect(ready.unpriced).toEqual(['/items/holy_milk']);
    });

    test('levels unknown: still names an action, level unknown', () => {
        const ready = readiness(resolve('collect_butter_of_proficiency'), ctx({}, { skillLevels: null }));
        expect(ready.actionHrid).toBe('/actions/milking/unicow');
        expect(ready.levelMet).toBeNull();
    });
});

describe('"any of" production achievements', () => {
    test('Celestial: celestial tools and level 90 skilling tops/bottoms, never a combat or other-level piece', () => {
        const res = resolve('make_celestial');
        expect(res.candidates.map((c) => c.actionHrid)).toEqual([
            '/actions/cheesesmithing/celestial_pot',
            '/actions/crafting/celestial_hammer',
            '/actions/tailoring/gatherers_top',
        ]);
    });

    test('Snack Pack Pro and Master Charmer', () => {
        expect(resolve('tailor_pouch').candidates.map((c) => c.actionHrid)).toEqual([
            '/actions/tailoring/gluttonous_pouch',
            '/actions/tailoring/guzzling_pouch',
        ]);
        expect(resolve('craft_master_charm').candidates.map((c) => c.actionHrid)).toEqual([
            '/actions/crafting/master_foraging_charm',
            '/actions/crafting/master_milking_charm',
        ]);
    });

    test('a catalog with none of the items resolves to nothing', () => {
        expect(resolve('tailor_pouch', { ...DATA, itemDetailMap: {} })).toBeNull();
    });

    test('met level, equal bills: owned inputs count as free, the lower level wins the tie', () => {
        const ready = readiness(
            resolve('tailor_pouch'),
            ctx({ tailoring: 70 }, { inventory: [inv('/items/silk', 3)] })
        );
        expect(ready.actionHrid).toBe('/actions/tailoring/guzzling_pouch');
        expect(ready.owned).toBe(true);
    });

    test('cheapest to complete beats lower level; unpriced inputs never rank as free', () => {
        const res = resolve('make_celestial');
        const levels = { crafting: 95, cheesesmithing: 95, tailoring: 95 };
        const prices = { '/items/mooncrystal': 100, '/items/silk': 10 };
        // pot: 2 mooncrystal = 200, hammer: 4 = 400, top: 6 silk = 60
        const priced = readiness(res, ctx(levels, { buyPrice: (h) => prices[h] ?? null }));
        expect(priced.actionHrid).toBe('/actions/tailoring/gatherers_top');
        expect(priced.cost).toBe(60);
        // Silk unpriced: the top has no known cost and loses to a priced bill
        const noSilk = readiness(res, ctx(levels, { buyPrice: (h) => (h === '/items/mooncrystal' ? 100 : null) }));
        expect(noSilk.actionHrid).toBe('/actions/cheesesmithing/celestial_pot');
        expect(noSilk.cost).toBe(200);
        // Nothing priced: still an action, cost null and the unpriced input flagged
        const none = readiness(res, ctx(levels));
        expect(none.cost).toBeNull();
        expect(none.unpriced.length).toBeGreaterThan(0);
    });

    test('a partly owned stack split in two is deducted from the bill', () => {
        const res = resolve('craft_master_charm');
        const ready = readiness(
            res,
            ctx(
                { crafting: 80 },
                { inventory: [inv('/items/charm_stone', 2), inv('/items/charm_stone', 2)], buyPrice: () => 10 }
            )
        );
        expect(ready.shortfall).toEqual([{ itemHrid: '/items/charm_stone', need: 5, have: 4 }]);
        expect(ready.cost).toBe(10);
    });

    test('level not met on any: the lowest level requirement, shortfall shown', () => {
        const ready = readiness(resolve('make_celestial'), ctx({ crafting: 1, cheesesmithing: 1, tailoring: 1 }));
        expect(ready.actionHrid).toBe('/actions/cheesesmithing/celestial_pot');
        expect(ready.levelMet).toBe(false);
        expect(ready.level).toMatchObject({ have: 1, need: 88 });
    });

    test('an Iron Cow, nothing owned: still picks a level-met action, no cost', () => {
        const ready = readiness(resolve('craft_master_charm'), ctx({ crafting: 80 }, { ironCow: true }));
        expect(ready.actionHrid).toBe('/actions/crafting/master_foraging_charm');
        expect(ready.cost).toBeNull();
        expect(ready.owned).toBe(false);
    });

    test('inventory not loaded: owned stays unknown', () => {
        const ready = readiness(resolve('craft_master_charm'), ctx({ crafting: 80 }, { inventory: null }));
        expect(ready.owned).toBeNull();
        expect(ready.actionHrid).toBe('/actions/crafting/master_foraging_charm');
    });
});
