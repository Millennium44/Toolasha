/**
 * The Collection Points optimizer's arithmetic: the per-item next rung, the
 * route options, and the greedy "+N points" plan.
 *
 * Shapes are the game's: `collections_updated.collections` rows
 * `{characterID, itemHrid, count, enhancementData}`, and the measured hood
 * decompose chain (umbral_hood → 90 umbral_leather + 1 beast_hood,
 * beast_hood → 60 beast_leather + 1 gobo_hood) and cheese_sword → 18 cheese.
 */

import { describe, test, expect } from 'vitest';
import { pointsFromCount } from '../../utils/points-from-count.js';
import {
    ALCHEMY_BONUS_DROPS,
    bestOptions,
    collectionAchievementTargets,
    collectionCounts,
    evaluateOption,
    indexRoutes,
    nextAchievementTarget,
    planTarget,
    pointsStep,
    totalCollectionPoints,
} from './collection-optimizer-plan.js';

const ROWS = [
    { characterID: 1, itemHrid: '/items/umbral_hood', count: 331, enhancementData: '{}' },
    { characterID: 1, itemHrid: '/items/cheese', count: 5, enhancementData: '{}' },
];

/** The umbral hood chain at success 0.6 / 0.5, per one Umbral Hood */
const umbralChain = (route = 'decompose', cost = 1000) => ({
    route,
    sourceHrid: '/items/umbral_hood',
    cost,
    seconds: 60,
    yields: new Map([
        ['/items/umbral_leather', 0.6 * 90],
        ['/items/beast_hood', 0.6],
        ['/items/beast_leather', 0.6 * 0.5 * 60],
        ['/items/gobo_hood', 0.6 * 0.5],
    ]),
    kept: new Map([
        ['/items/umbral_leather', 0.6 * 90 * 5],
        ['/items/beast_leather', 0.6 * 0.5 * 60 * 2],
    ]),
});

const cheeseSword = (route = 'shop', cost = 50) => ({
    route,
    sourceHrid: '/items/cheese_sword',
    cost,
    seconds: 36,
    yields: new Map([['/items/cheese', 18]]),
    kept: new Map([['/items/cheese', 180]]),
});

describe('counts and the ladder', () => {
    test('rows become counts; an uncollected item is absent', () => {
        const counts = collectionCounts(ROWS);
        expect(counts.get('/items/umbral_hood')).toBe(331);
        expect(counts.has('/items/beast_hood')).toBe(false);
        expect(totalCollectionPoints(counts)).toBe(6 + 1);
    });

    test('next rung: 331 needs 669 more for +4; an uncollected item gives 1 for its first unit', () => {
        expect(pointsStep(331)).toEqual({ count: 331, points: 6, threshold: 1000, needed: 669, gain: 4 });
        expect(pointsStep(0)).toEqual({ count: 0, points: 0, threshold: 1, needed: 1, gain: 1 });
    });

    test('the next collection-points achievement', () => {
        const targets = collectionAchievementTargets({
            '/achievements/collection_points_500': { hrid: '/achievements/collection_points_500', target: 500 },
            '/achievements/collection_points_100': { hrid: '/achievements/collection_points_100', target: 100 },
            '/achievements/bestiary_points_100': { hrid: '/achievements/bestiary_points_100', target: 100 },
        });
        expect(targets.map((t) => t.target)).toEqual([100, 500]);
        expect(nextAchievementTarget(targets, 120).target).toBe(500);
        expect(nextAchievementTarget(targets, 600)).toBeNull();
    });
});

describe('route options', () => {
    test('craft: units to the next rung times the make cost', () => {
        const counts = collectionCounts(ROWS);
        const option = evaluateOption('/items/umbral_hood', counts, {
            route: 'craft',
            itemHrid: '/items/umbral_hood',
            unitCost: 2000,
            unitSeconds: 30,
        });
        expect(option.units).toBe(669);
        expect(option.gold).toBe(669 * 2000);
        expect(option.seconds).toBe(669 * 30);
        expect(option.points).toBe(4);
        expect(option.goldPerPoint).toBe((669 * 2000) / 4);
    });

    test('decompose chain credits the lower hoods it collects on the way', () => {
        const counts = collectionCounts(ROWS);
        const option = evaluateOption('/items/gobo_hood', counts, umbralChain());
        // One Gobo Hood reaches the end of 0.3 of the chains: 4 Umbral Hoods for the first one
        expect(option.units).toBe(4);
        expect(option.credits.get('/items/gobo_hood')).toBeCloseTo(1.2, 9);
        expect(option.credits.get('/items/beast_hood')).toBeCloseTo(2.4, 9);
        // Beast Hood 0 → 2 is its first point; the leathers cross several rungs too
        expect(option.collateral).toBeGreaterThanOrEqual(1);
        expect(option.points).toBe(1 + option.collateral);
        // Gold is net of the other kept outputs
        const kept = 0.6 * 90 * 5 + 0.6 * 0.5 * 60 * 2;
        expect(option.gold).toBeCloseTo(4 * (1000 - kept), 6);
    });

    test('the target itself is not netted out of the gold', () => {
        const counts = collectionCounts(ROWS);
        const option = evaluateOption('/items/cheese', counts, cheeseSword());
        // 5 → 10 needs 5 cheese: one sword
        expect(option.units).toBe(1);
        expect(option.gold).toBe(50);
    });

    test('a batch that crosses several rungs is scored for all of them', () => {
        // Uncollected cheese, 18 per sword: one sword takes it past 1 and 10 at once, 3 points
        const option = evaluateOption('/items/cheese', new Map(), cheeseSword());
        expect(option.units).toBe(1);
        expect(option.gain).toBe(3);
        expect(option.points).toBe(3);
        expect(option.goldPerPoint).toBeCloseTo(50 / 3);
    });

    test('a bulk action or shop bundle rounds the sources up to whole batches and credits every output', () => {
        // 5 → 10 cheese needs one sword, but an action eats 10 swords: all 10 are charged and credited
        const option = evaluateOption('/items/cheese', collectionCounts(ROWS), { ...cheeseSword(), batch: 10 });
        expect(option.units).toBe(10);
        expect(option.gold).toBe(10 * 50);
        expect(option.credits.get('/items/cheese')).toBe(180);
        // 5 + 180 crosses 10 and 100 as well: the target gain is for the whole batch
        expect(option.gain).toBe(pointsFromCount(185) - pointsFromCount(5));
        // A batch already covering the need adds nothing extra
        expect(evaluateOption('/items/cheese', collectionCounts(ROWS), { ...cheeseSword(), batch: 1 }).units).toBe(1);
    });

    test('a recipe making 15 at a time crafts whole actions and collects all 15', () => {
        // Uncollected: one action makes 15, past 1 and 10 at once, for 3 points
        const option = evaluateOption('/items/crushed_amber', new Map(), {
            route: 'craft',
            itemHrid: '/items/crushed_amber',
            unitCost: 2,
            unitSeconds: 1,
            batch: 15,
        });
        expect(option.units).toBe(15);
        expect(option.gold).toBe(30);
        expect(option.points).toBe(3);
        expect(option.credits.get('/items/crushed_amber')).toBe(15);
    });

    test('a Gourmet batch charges and credits the expected output of the whole action', () => {
        // 15 base copies at +20% Gourmet is 18 expected per action; 0 → 1 needs one action
        const option = evaluateOption('/items/crushed_amber', new Map(), {
            route: 'craft',
            itemHrid: '/items/crushed_amber',
            unitCost: 2,
            unitSeconds: 1,
            batch: 18,
        });
        expect(option.units).toBe(18);
        expect(option.gold).toBe(36);
        expect(option.credits.get('/items/crushed_amber')).toBe(18);
    });

    test('a route with an unpriced kept output is left out of the ranking', () => {
        const counts = collectionCounts(ROWS);
        const index = indexRoutes({ craft: [], sources: [{ ...cheeseSword(), partlyUnpriced: true }] });
        expect(index.get('/items/cheese')).toBeUndefined();
        expect(bestOptions(counts, index)).toEqual([]);
    });

    test('a crafted source collects itself and pays its making time', () => {
        const counts = collectionCounts(ROWS);
        const route = {
            ...cheeseSword('craftDecompose', 30),
            seconds: 36 + 20,
            yields: new Map([
                ['/items/cheese', 18],
                ['/items/cheese_sword', 1],
            ]),
        };
        const option = evaluateOption('/items/cheese_sword', counts, route);
        // The sword itself goes 0 -> 1 for a point, and its 18 cheese take 5 -> 23 for 2 more
        expect(option.points).toBe(3);
        expect(option.seconds).toBe(56);
    });

    test('no Buy route ever appears, only the ones handed in', () => {
        const counts = collectionCounts(ROWS);
        const index = indexRoutes({
            craft: [{ route: 'craft', itemHrid: '/items/umbral_hood', unitCost: 2000, unitSeconds: 30 }],
            sources: [umbralChain(), cheeseSword()],
        });
        const options = bestOptions(counts, index);
        expect(options.length).toBeGreaterThan(0);
        for (const option of options) expect(['craft', 'decompose', 'shop']).toContain(option.route);
        // Sources themselves are never collected by decomposing them
        expect(index.has('/items/cheese_sword')).toBe(false);
    });

    test('options are ranked cheapest gold per point first', () => {
        const counts = collectionCounts(ROWS);
        const options = bestOptions(counts, indexRoutes({ sources: [umbralChain(), cheeseSword()] }));
        for (let i = 1; i < options.length; i++) {
            expect(options[i].goldPerPoint).toBeGreaterThanOrEqual(options[i - 1].goldPerPoint);
        }
    });
});

describe('the "+N points" plan', () => {
    test('greedy by gold per point; a taken rung offers the next one', () => {
        const counts = new Map([['/items/cheese', 0]]);
        const index = indexRoutes({ sources: [cheeseSword('shop', 50)] });
        const plan = planTarget(counts, index, 3);
        expect(plan.reached).toBe(true);
        // 0 → 18 cheese from one sword crosses 1 and 10: +3 in one step
        expect(plan.steps).toHaveLength(1);
        expect(plan.points).toBe(3);
        expect(plan.gold).toBe(50);

        const more = planTarget(counts, index, 6);
        // The next rung is 100: ⌈82 / 18⌉ = 5 more swords
        expect(more.steps).toHaveLength(2);
        expect(more.steps[1].units).toBe(5);
        expect(more.points).toBe(6);
        expect(more.gold).toBe(50 + 5 * 50);
        expect(more.seconds).toBe(36 + 5 * 36);
    });

    test('picks the cheaper item first and stops when nothing is left', () => {
        const counts = new Map();
        const index = indexRoutes({
            craft: [
                { route: 'craft', itemHrid: '/items/a', unitCost: 100, unitSeconds: 1 },
                { route: 'craft', itemHrid: '/items/b', unitCost: 10, unitSeconds: 1 },
            ],
        });
        // b's first unit (10/pt), then b's 1 → 10 (90 for +2: 45/pt) beat a's first unit (100/pt);
        // b's 10 → 100 (900 for +3: 300/pt) does not
        const plan = planTarget(counts, index, 4);
        expect(plan.steps.map((s) => s.itemHrid)).toEqual(['/items/b', '/items/b', '/items/a']);
        expect(plan.gold).toBe(10 + 90 + 100);
        expect(plan.points).toBe(4);
        expect(planTarget(new Map(), new Map(), 5)).toMatchObject({ steps: [], points: 0, reached: false });
    });

    test('the counts handed in are not modified', () => {
        const counts = new Map([['/items/cheese', 5]]);
        planTarget(counts, indexRoutes({ sources: [cheeseSword()] }), 10);
        expect(counts.get('/items/cheese')).toBe(5);
    });
});

describe('the alchemy-wide bonus drops', () => {
    /** A Cheese Sword chain that also rolls Alchemy Essence and a Small Artisan's Crate */
    const withBonus = () => ({
        ...cheeseSword('shop', 50),
        yields: new Map([
            ['/items/cheese', 18],
            ['/items/alchemy_essence', 0.5],
            ['/items/small_artisans_crate', 0.001],
            ['/items/prime_catalyst_shard', 0.01],
        ]),
        bonus: new Set(['/items/prime_catalyst_shard']),
    });

    test('are never a route target, whether known or flagged by the route', () => {
        const index = indexRoutes({ sources: [withBonus()] });
        expect(index.has('/items/cheese')).toBe(true);
        expect(index.has('/items/prime_catalyst_shard')).toBe(false);
        for (const hrid of ALCHEMY_BONUS_DROPS) expect(index.has(hrid)).toBe(false);
    });

    test('still count toward the points of the route that yields them', () => {
        const route = withBonus();
        route.yields.set('/items/alchemy_essence', 2);
        // 5 → 10 cheese is one sword, which also brings the first 2 essence: +1
        const option = evaluateOption('/items/cheese', new Map([['/items/cheese', 5]]), route);
        expect(option.gain).toBe(2);
        expect(option.collateral).toBe(1);
        expect(option.points).toBe(3);
        expect(option.credits.get('/items/alchemy_essence')).toBe(2);
    });
});

describe('the max time per step', () => {
    test('leaves slower options out of the ranking', () => {
        const counts = new Map([['/items/cheese', 10]]);
        const index = indexRoutes({ sources: [cheeseSword()] });
        // 10 → 100 cheese is 5 swords at 36 s each
        expect(bestOptions(counts, index, { maxSeconds: 180 })).toHaveLength(1);
        expect(bestOptions(counts, index, { maxSeconds: 179 })).toHaveLength(0);
        expect(bestOptions(counts, index)).toHaveLength(1);
    });

    test('and out of the plan', () => {
        const counts = new Map([['/items/cheese', 0]]);
        const index = indexRoutes({ sources: [cheeseSword()] });
        const plan = planTarget(counts, index, 6, { maxSeconds: 100 });
        // One sword (36 s) for +3; the next rung's five swords (180 s) are over the limit
        expect(plan.steps).toHaveLength(1);
        expect(plan.points).toBe(3);
        expect(plan.reached).toBe(false);
    });
});
