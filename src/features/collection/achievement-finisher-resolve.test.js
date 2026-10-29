/**
 * Resolving one-off achievements to game hrids, and the readiness hint, against
 * fixtures in the game's own shapes.
 */

import { describe, test, expect } from 'vitest';

import {
    parseAchievement,
    resolveAchievement,
    readiness,
    readinessGroup,
    sortRemaining,
    ownedCount,
} from './achievement-finisher-resolve.js';
import { ACHIEVEMENTS, DATA, INVENTORY, PRICES, SKILLS } from './__fixtures__/achievement-finisher-game.js';

const resolve = (slug) => resolveAchievement(ACHIEVEMENTS[`/achievements/${slug}`], DATA);

const context = (over = {}) => ({
    skillLevels: new Map(SKILLS.map((s) => [s.skillHrid, s.level])),
    combatLevel: 60,
    inventory: INVENTORY,
    ironCow: false,
    buyPrice: (hrid) => PRICES[hrid] ?? null,
    ...over,
});

describe('resolveAchievement: the nine listed achievements', () => {
    test('cook: the cooking action, not the same-named brewing one, with its inputs', () => {
        expect(resolve('cook_peach_yogurt')).toEqual({
            kind: 'production',
            actionHrid: '/actions/cooking/peach_yogurt',
            skillHrid: '/skills/cooking',
            level: 40,
            inputs: [
                { itemHrid: '/items/milk', count: 3 },
                { itemHrid: '/items/peach', count: 3 },
            ],
        });
        expect(resolve('cook_spaceberry_cake').actionHrid).toBe('/actions/cooking/spaceberry_cake');
    });

    test('tailor: the upgrade item counts as an input', () => {
        expect(resolve('tailor_umbral_tunic').inputs).toEqual([
            { itemHrid: '/items/umbral_leather', count: 8 },
            { itemHrid: '/items/sighted_tunic', count: 1 },
        ]);
    });

    test('woodcut: the gathering action, no inputs', () => {
        const res = resolve('woodcut_arcane_tree');
        expect(res.actionHrid).toBe('/actions/woodcutting/arcane_tree');
        expect(res.inputs).toEqual([]);
        expect(res.level).toBe(60);
    });

    test('decompose: the alchemy tab on the item, gated by the item level, with its coin fee', () => {
        expect(resolve('decompose_bamboo_gloves')).toEqual({
            kind: 'alchemy',
            actionHrid: '/actions/alchemy/decompose',
            alchemyType: 'decompose',
            itemHrid: '/items/bamboo_gloves',
            skillHrid: '/skills/alchemy',
            level: 10,
            inputs: [
                { itemHrid: '/items/bamboo_gloves', count: 1 },
                { itemHrid: '/items/coin', count: 100 },
            ],
        });
    });

    test('defeat: the non-dungeon zone that spawns the boss, tier 0', () => {
        expect(resolve('defeat_gobo_chieftain')).toMatchObject({
            kind: 'combat',
            actionHrid: '/actions/combat/gobo_planet',
            monsterHrid: '/monsters/gobo_chieftain',
            tier: 0,
            requirement: null,
            monsterLevel: 45,
        });
        expect(resolve('defeat_red_panda')).toMatchObject({
            actionHrid: '/actions/combat/jungle_planet',
            tier: 0,
        });
    });

    test('defeat T5: the tier comes from the id, and a zone that tops out below it is skipped', () => {
        // Jerry spawns in a dungeon (sort 0), a zone with max tier 2 (sort 1) and Jungle Planet (max 5)
        expect(resolve('defeat_jerry_t5')).toMatchObject({
            actionHrid: '/actions/combat/jungle_planet',
            monsterHrid: '/monsters/jerry',
            tier: 5,
        });
    });

    test('equip any X weapon: the weapon-slot items with that prefix only', () => {
        expect(resolve('equip_ginkgo_weapon').candidates).toEqual([
            '/items/ginkgo_bow',
            '/items/ginkgo_crossbow',
            '/items/ginkgo_nature_staff',
        ]);
    });
});

describe('resolveAchievement: what it refuses', () => {
    test('an unknown verb, an unknown target, and an unparseable entry are unresolved', () => {
        expect(resolve('enhance_something')).toBeNull();
        expect(resolveAchievement({ steamAchievementId: 'ach_cook_moon_soup', description: '' }, DATA)).toBeNull();
        expect(resolveAchievement({ description: 'Reach total level 1000' }, DATA)).toBeNull();
        expect(resolveAchievement({}, DATA)).toBeNull();
        expect(resolveAchievement(undefined, DATA)).toBeNull();
    });

    test('a tier above every zone that spawns the monster is unresolved, not opened at a lower tier', () => {
        expect(resolveAchievement({ steamAchievementId: 'ach_defeat_jerry_t9' }, DATA)).toBeNull();
    });

    test('an item that cannot take the named alchemy is unresolved', () => {
        expect(resolveAchievement({ steamAchievementId: 'ach_transmute_bamboo_gloves' }, DATA)).toBeNull();
        expect(resolveAchievement({ steamAchievementId: 'ach_transmute_star_fragment' }, DATA)).toMatchObject({
            alchemyType: 'transmute',
            // A transmute takes a bulk of ten
            inputs: [
                { itemHrid: '/items/star_fragment', count: 10 },
                { itemHrid: '/items/coin', count: 1000 },
            ],
        });
    });

    test('the description is the fallback when there is no steam id', () => {
        expect(parseAchievement({ description: 'Defeat T5 Jerry by yourself' })).toMatchObject({
            kind: 'combat',
            slug: 'jerry',
            tier: 5,
        });
        expect(resolveAchievement({ description: 'Make a Peach Yogurt with Cooking' }, DATA).actionHrid).toBe(
            '/actions/cooking/peach_yogurt'
        );
        expect(
            resolveAchievement({ description: 'Equip any Ginkgo weapon (staff, bow, or crossbow)' }, DATA).kind
        ).toBe('equip');
    });

    test('missing game data resolves nothing', () => {
        expect(resolveAchievement(ACHIEVEMENTS['/achievements/cook_peach_yogurt'], {})).toBeNull();
        expect(resolveAchievement(ACHIEVEMENTS['/achievements/cook_peach_yogurt'], null)).toBeNull();
    });
});

describe('readiness', () => {
    test('stock is +0 inventory stacks only, summed across stacks', () => {
        expect(ownedCount(INVENTORY, '/items/milk')).toBe(3);
        expect(ownedCount(INVENTORY, '/items/bamboo_gloves')).toBe(1);
        expect(ownedCount(INVENTORY, '/items/bamboo_gloves', { anyLocation: true })).toBe(2);
    });

    test('materials partly owned: only the shortfall is priced', () => {
        const ready = readiness(resolve('cook_peach_yogurt'), context());
        expect(ready.levelMet).toBe(true);
        expect(ready.owned).toBe(false);
        expect(ready.shortfall).toEqual([{ itemHrid: '/items/peach', need: 3, have: 1 }]);
        expect(ready.cost).toBe(200);
    });

    test('an unpriced input leaves the cost unknown and names it, never treats it as 0', () => {
        const ready = readiness(resolve('cook_spaceberry_cake'), context());
        expect(ready.levelMet).toBe(false);
        expect(ready.cost).toBeNull();
        expect(ready.unpriced).toEqual(['/items/mystery_sugar']);
        expect(ready.partialCost).toBe(0);
    });

    test('level not met', () => {
        const ready = readiness(resolve('tailor_umbral_tunic'), context());
        expect(ready.levelMet).toBe(false);
        expect(ready.level).toMatchObject({ have: 50, need: 90 });
        expect(ready.cost).toBe(8 * 1000 + 5000);
    });

    test('decompose with the item and the fee on hand is ready', () => {
        const ready = readiness(resolve('decompose_bamboo_gloves'), context());
        expect(ready).toMatchObject({ levelMet: true, owned: true, shortfall: [] });
    });

    test('a short coin fee is counted in gold, not looked up as a market item', () => {
        const poor = INVENTORY.map((row) => (row.itemHrid === '/items/coin' ? { ...row, count: 30 } : row));
        const ready = readiness(resolve('decompose_bamboo_gloves'), context({ inventory: poor }));
        expect(ready.owned).toBe(false);
        expect(ready.cost).toBe(70);
    });

    test('equip: the cheapest weapon not owned, never the off-hand; owned anywhere counts', () => {
        const res = resolve('equip_ginkgo_weapon');
        const ready = readiness(res, context());
        expect(ready).toMatchObject({ owned: false, buyHrid: '/items/ginkgo_crossbow', cost: 700, levelMet: true });

        const equipped = [
            ...INVENTORY,
            {
                itemHrid: '/items/ginkgo_bow',
                count: 1,
                itemLocationHrid: '/item_locations/two_hand',
                enhancementLevel: 3,
            },
        ];
        expect(readiness(res, context({ inventory: equipped }))).toMatchObject({
            owned: true,
            ownedHrid: '/items/ginkgo_bow',
            buyHrid: null,
        });
    });

    test('equip with every candidate unpriced has nothing to buy', () => {
        const ready = readiness(resolve('equip_ginkgo_weapon'), context({ buyPrice: () => null }));
        expect(ready.buyHrid).toBeNull();
        expect(ready.unpriced).toHaveLength(3);
    });

    test('an Iron Cow character gets no buy cost', () => {
        expect(readiness(resolve('cook_peach_yogurt'), context({ ironCow: true }))).toMatchObject({
            owned: false,
            cost: null,
            unpriced: [],
        });
        expect(readiness(resolve('equip_ginkgo_weapon'), context({ ironCow: true })).buyHrid).toBeNull();
    });

    test('combat with no zone requirement in the data: level unknown, never assumed met', () => {
        const ready = readiness(resolve('defeat_jerry_t5'), context());
        expect(ready.levelMet).toBeNull();
    });

    test('a zone requirement on a non-skill hrid compares against the combat level', () => {
        const res = { ...resolve('defeat_red_panda'), requirement: { skillHrid: '/skills/combat', level: 70 } };
        expect(readiness(res, context()).level).toMatchObject({ met: false, have: 60, need: 70 });
    });

    test('inventory or skills not loaded is unknown, not owned or met', () => {
        const ready = readiness(resolve('cook_peach_yogurt'), context({ inventory: null, skillLevels: null }));
        expect(ready.owned).toBeNull();
        expect(ready.levelMet).toBeNull();
    });
});

describe('sortRemaining', () => {
    test('ready, then needs buying cheapest first, then unpriced, then level unknown, not met, unresolved', () => {
        const row = (name, readinessValue) => ({ name, readiness: readinessValue });
        const rows = [
            row('unresolved', null),
            row('not met', { levelMet: false, owned: true }),
            row('dear', { levelMet: true, owned: false, cost: 900 }),
            row('unknown', { levelMet: null, owned: true }),
            row('unpriced', { levelMet: true, owned: false, cost: null }),
            row('cheap', { levelMet: true, owned: false, cost: 100 }),
            row('ready', { levelMet: true, owned: true }),
        ];
        expect(sortRemaining(rows).map((r) => r.name)).toEqual([
            'ready',
            'cheap',
            'dear',
            'unpriced',
            'unknown',
            'not met',
            'unresolved',
        ]);
        expect(readinessGroup({ readiness: null })).toBe(5);
    });
});
