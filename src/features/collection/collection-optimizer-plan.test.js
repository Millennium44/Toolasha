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
    DEFAULT_SORT,
    SORT_MODES,
    bestOptions,
    buyCost,
    collectionAchievementTargets,
    collectionCounts,
    evaluateOption,
    indexRoutes,
    nextAchievementTarget,
    planTarget,
    pointsStep,
    totalCollectionPoints,
    validSort,
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
        ['/items/umbral_leather', { perSource: 0.6 * 90, unit: 5 }],
        ['/items/beast_leather', { perSource: 0.6 * 0.5 * 60, unit: 2 }],
    ]),
});

const cheeseSword = (route = 'shop', cost = 50) => ({
    route,
    sourceHrid: '/items/cheese_sword',
    cost,
    seconds: 36,
    yields: new Map([['/items/cheese', 18]]),
    kept: new Map([['/items/cheese', { perSource: 18, unit: 10 }]]),
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
        // Gold is net of the other outputs, sold
        const kept = 0.6 * 90 * 5 + 0.6 * 0.5 * 60 * 2;
        expect(option.gold).toBeCloseTo(4 * (1000 - kept), 6);
        expect(option.sold.get('/items/umbral_leather')).toBeCloseTo(4 * 54, 9);
        // The target is collected, never sold
        expect(option.sold.has('/items/gobo_hood')).toBe(false);
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

describe('selling the other outputs', () => {
    /**
     * Earrings of Essence Find, as the game data has it: decompose → 600 Star Fragment + 6 Amber, the
     * whole recipe back. At the 0.8 success rate the maintainer's row implies, one earring bought at
     * the 6.3M ask, plus 200 coins and a 7,920 catalyst used on success, yields 480 Star Fragments
     * and 4.8 Amber.
     */
    const earrings = (fragmentUnit) => ({
        route: 'decompose',
        sourceHrid: '/items/earrings_of_essence_find',
        cost: 6_300_000 + 200 + 7920 * 0.8,
        seconds: 36,
        yields: new Map([
            ['/items/star_fragment', 480],
            ['/items/amber', 4.8],
        ]),
        kept: new Map([
            ['/items/star_fragment', { perSource: 480, unit: fragmentUnit }],
            ['/items/amber', { perSource: 4.8, unit: 20_160 * 0.96 }],
        ]),
    });
    // Amber at 3,000 toward 10,000: 7,000 more is 1,459 earrings
    const counts = new Map([
        ['/items/amber', 3000],
        ['/items/star_fragment', 1_000_000],
    ]);

    test("the maintainer's Amber row: Star Fragments at the untaxed ask make the route earn ~430M", () => {
        const option = evaluateOption('/items/amber', counts, earrings(13_750));
        expect(option.units).toBe(1459);
        // Per earring: 480 × 13,750 = 6,600,000 against 6,306,536 spent
        expect(option.gold / option.units).toBeCloseTo(6_306_536 - 6_600_000, 3);
        expect(option.gold).toBeLessThan(-400e6);
    });

    test('at the bid after tax the same earring earns 6.4k, not 293k', () => {
        const option = evaluateOption('/items/amber', counts, earrings(13_700 * 0.96));
        // 480 × 13,152 = 6,312,960
        expect(option.gold / option.units).toBeCloseTo(6_306_536 - 6_312_960, 3);
    });

    test('only what the market takes is sold; the rest is collected and worth nothing', () => {
        // Star Fragments trade ~22,885 a day; a quarter of that for a week is ~40,049
        const week = 0.25 * 22_885 * 7;
        const sellable = (hrid) => (hrid === '/items/star_fragment' ? week : Infinity);
        const option = evaluateOption('/items/amber', counts, earrings(13_700 * 0.96), { sellable });
        expect(option.sold.get('/items/star_fragment')).toBeCloseTo(week, 6);
        // Every fragment is still collected
        expect(option.credits.get('/items/star_fragment')).toBeCloseTo(1459 * 480, 6);
        // 1,459 earrings cost ~9.2B; the fragments the market takes return ~0.53B
        expect(option.gold).toBeCloseTo(1459 * 6_306_536 - week * 13_152, 0);
        expect(option.gold).toBeGreaterThan(8e9);
    });

    test('the plan counts what earlier steps sold against what the market takes', () => {
        const route = {
            ...cheeseSword('shop', 50),
            kept: new Map([['/items/gold_dust', { perSource: 2, unit: 100 }]]),
        };
        route.yields = new Map([
            ['/items/cheese', 18],
            ['/items/gold_dust', 2],
        ]);
        // 3 units of Gold Dust can be sold over the whole plan
        const sellable = (hrid) => (hrid === '/items/gold_dust' ? 3 : Infinity);
        const plan = planTarget(new Map(), indexRoutes({ sources: [route] }), 6, { sellable });
        expect(plan.steps).toHaveLength(2);
        // Step 1: one sword, 2 dust sold. Step 2: five swords, 10 dust made, 1 sold
        expect(plan.steps[0].sold.get('/items/gold_dust')).toBe(2);
        expect(plan.steps[1].sold.get('/items/gold_dust')).toBe(1);
        expect(plan.gold).toBe(50 - 200 + 5 * 50 - 100);
    });
});

describe('the sort', () => {
    // Cheap and slow against dear and fast, for two items
    const index = () =>
        indexRoutes({
            craft: [
                { route: 'craft', itemHrid: '/items/a', unitCost: 10, unitSeconds: 100 },
                { route: 'craft', itemHrid: '/items/a', unitCost: 50, unitSeconds: 1 },
                { route: 'craft', itemHrid: '/items/b', unitCost: 20, unitSeconds: 10 },
            ],
        });

    test('most profitable is the default and today’s order: lowest cost per point, per item and overall', () => {
        const options = bestOptions(new Map(), index());
        expect(options.map((o) => [o.itemHrid, o.gold])).toEqual([
            ['/items/a', 10],
            ['/items/b', 20],
        ]);
        expect(bestOptions(new Map(), index(), { sort: 'profit' })).toEqual(options);
    });

    test('fastest picks each item’s quickest route and ranks by time per point', () => {
        const options = bestOptions(new Map(), index(), { sort: 'fastest' });
        expect(options.map((o) => [o.itemHrid, o.seconds])).toEqual([
            ['/items/a', 1],
            ['/items/b', 10],
        ]);
        expect(options[0].secondsPerPoint).toBe(1);
    });

    test('the plan follows the sort', () => {
        expect(planTarget(new Map(), index(), 1).steps[0].gold).toBe(10);
        expect(planTarget(new Map(), index(), 1, { sort: 'fastest' }).steps[0].seconds).toBe(1);
    });

    test('an unknown sort is the default', () => {
        expect(validSort('fastest')).toBe('fastest');
        expect(validSort('cheapest')).toBe(DEFAULT_SORT);
        expect(validSort(undefined)).toBe('profit');
        expect(Object.keys(SORT_MODES)).toEqual(['profit', 'fastest']);
    });
});

describe('a transmute route', () => {
    // Per Amber bought at 0.08 back per attempt: 1 / 0.92 attempts
    const amber = () => ({
        route: 'transmute',
        sourceHrid: '/items/amber',
        cost: 20_000,
        seconds: 36 / 0.92,
        yields: new Map([
            ['/items/garnet', 0.06 / 0.92],
            ['/items/amber', 0.08 / 0.92],
        ]),
        kept: new Map([['/items/garnet', { perSource: 0.06 / 0.92, unit: 20_000 }]]),
    });

    test('collects the copies of its source that come back, so the source is a target too', () => {
        const index = indexRoutes({ sources: [amber()] });
        expect(index.get('/items/amber')[0].route).toBe('transmute');
        const option = evaluateOption('/items/amber', new Map(), amber());
        // 0.087 back per Amber bought: 12 for the first
        expect(option.units).toBe(12);
        expect(option.gold).toBeCloseTo(12 * 20_000 - 12 * (0.06 / 0.92) * 20_000, 6);
        expect(option.sold.has('/items/amber')).toBe(false);
    });

    test('plans with its credits like any other route', () => {
        const plan = planTarget(new Map(), indexRoutes({ sources: [amber()] }), 2, { maxSeconds: 3600 });
        expect(plan.reached).toBe(true);
        for (const step of plan.steps) expect(step.route).toBe('transmute');
    });
});

describe('a gather route', () => {
    // A cow at 10 s an action: 1.35 milk and 0.15 cheese an action, 2 of tea
    const cow = () => ({
        route: 'gather',
        sourceHrid: null,
        actionHrid: '/actions/milking/cow',
        cost: 2,
        seconds: 10,
        batch: 1,
        yields: new Map([
            ['/items/milk', 1.35],
            ['/items/cheese', 0.15],
        ]),
        kept: new Map([
            ['/items/milk', { perSource: 1.35, unit: 86.4 }],
            ['/items/cheese', { perSource: 0.15, unit: 9.6 }],
        ]),
    });

    test('whole actions, timed, with the other drop sold', () => {
        const option = evaluateOption('/items/cheese', new Map(), cow());
        // 0.15 cheese an action: 7 actions for the first
        expect(option.units).toBe(7);
        expect(option.actionHrid).toBe('/actions/milking/cow');
        expect(option.seconds).toBe(70);
        expect(option.gold).toBeCloseTo(7 * 2 - 7 * 1.35 * 86.4, 9);
        expect(option.credits.get('/items/milk')).toBeCloseTo(9.45, 9);
    });

    test('respects the max time per step and plans', () => {
        const index = indexRoutes({ sources: [cow()] });
        // Cheese 0 → 1 is 70 s; milk 0 → 1 one action, 10 s
        expect(bestOptions(new Map(), index, { maxSeconds: 60 }).map((o) => o.itemHrid)).toEqual(['/items/milk']);
        const plan = planTarget(new Map(), index, 2);
        expect(plan.reached).toBe(true);
        for (const step of plan.steps) expect(step.route).toBe('gather');
    });
});

describe('buying a source', () => {
    /**
     * An Earrings of Essence Find ask side in the game's shape (one row per listing, best first,
     * several listings at one price), around the live 6.3M ask: 11 earrings on show in all.
     */
    const EARRING_ASKS = [
        { listingId: 9001, price: 6_300_000, quantity: 1, createdTimestamp: '2026-10-08T19:02:11.000Z' },
        { listingId: 9002, price: 6_300_000, quantity: 1, createdTimestamp: '2026-10-08T20:15:40.000Z' },
        { listingId: 8790, price: 6_350_000, quantity: 1, createdTimestamp: '2026-10-07T11:30:02.000Z' },
        { listingId: 8811, price: 6_400_000, quantity: 3, createdTimestamp: '2026-10-07T14:41:55.000Z' },
        { listingId: 8402, price: 6_500_000, quantity: 1, createdTimestamp: '2026-10-05T08:12:19.000Z' },
        { listingId: 8125, price: 6_800_000, quantity: 4, createdTimestamp: '2026-10-03T22:47:31.000Z' },
    ];

    test('with no book, every unit at the top ask; nothing measured, no limit', () => {
        expect(buyCost(1459, { ask: 6_300_000 })).toEqual({
            gold: 1459 * 6_300_000,
            feasible: true,
            limit: Infinity,
            fromBook: false,
        });
    });

    test('up the book, level by level', () => {
        const quote = buyCost(5, { ask: 6_300_000, listings: EARRING_ASKS });
        expect(quote.gold).toBe(2 * 6_300_000 + 6_350_000 + 2 * 6_400_000);
        expect(quote.fromBook).toBe(true);
    });

    test('past the depth on show, at the deepest level, while the week trades that many', () => {
        // 30 a day trade: a quarter of that for a week is 52.5
        const quote = buyCost(15, { ask: 6_300_000, listings: EARRING_ASKS, weekly: 52.5 });
        const book = 2 * 6_300_000 + 6_350_000 + 3 * 6_400_000 + 6_500_000 + 4 * 6_800_000;
        expect(quote.gold).toBe(book + 4 * 6_800_000);
        expect(quote.limit).toBe(52.5);
    });

    test('no more than the book shows or the week trades, whichever is more', () => {
        // The live feed's 1 a day: a week's share is 1.75, but 11 are on show
        expect(buyCost(11, { ask: 6_300_000, listings: EARRING_ASKS, weekly: 1.75 }).feasible).toBe(true);
        const short = buyCost(12, { ask: 6_300_000, listings: EARRING_ASKS, weekly: 1.75 });
        expect(short.feasible).toBe(false);
        expect(short.limit).toBe(11);
        // No book seen: the week alone
        expect(buyCost(2, { ask: 6_300_000, weekly: 1.75 }).feasible).toBe(false);
        // A measured zero buys nothing, unless the book shows some
        expect(buyCost(1, { ask: 6_300_000, weekly: 0 }).feasible).toBe(false);
    });

    test('after earlier buys, the next units cost what is left further up', () => {
        const quote = buyCost(3, { ask: 6_300_000, listings: EARRING_ASKS, already: 2 });
        expect(quote.gold).toBe(6_350_000 + 2 * 6_400_000);
    });

    test('an older book never makes buying cheaper than the ask now', () => {
        const quote = buyCost(3, { ask: 6_380_000, listings: EARRING_ASKS });
        expect(quote.gold).toBe(3 * 6_380_000);
    });

    const earrings = () => ({
        route: 'decompose',
        sourceHrid: '/items/earrings_of_essence_find',
        cost: 6_300_000 + 6536,
        purchase: { hrid: '/items/earrings_of_essence_find', ask: 6_300_000 },
        seconds: 36,
        yields: new Map([['/items/amber', 4.8]]),
        kept: new Map(),
    });

    test('a step is charged what its quantity costs on the book, not the top ask for all of it', () => {
        const buyQuote = (purchase, units) => buyCost(units, { ask: purchase.ask, listings: EARRING_ASKS });
        // A first Amber: one earring, at the top of the book
        const option = evaluateOption('/items/amber', new Map(), earrings(), { buyQuote });
        expect(option.units).toBe(1);
        expect(option.gold).toBeCloseTo(6_306_536, 6);
        expect(option.bought.get('/items/earrings_of_essence_find')).toBe(1);
        // 10 → 100 Amber is 19 earrings: 11 on the book, 8 more at its deepest level
        const step = evaluateOption('/items/amber', new Map([['/items/amber', 10]]), earrings(), { buyQuote });
        expect(step.units).toBe(19);
        const book = 2 * 6_300_000 + 6_350_000 + 3 * 6_400_000 + 6_500_000 + 4 * 6_800_000;
        expect(step.gold).toBeCloseTo(19 * 6536 + book + 8 * 6_800_000, 6);
    });

    test('a step needing more than the market offers is no option, so a dearer route ranks instead', () => {
        // The maintainer's Amber row: 1,459 earrings against the 1 a day the feed shows
        const counts = new Map([['/items/amber', 3000]]);
        const buyQuote = (purchase, units) =>
            buyCost(units, { ask: purchase.ask, listings: EARRING_ASKS, weekly: 0.25 * 1 * 7 });
        expect(evaluateOption('/items/amber', counts, earrings(), { buyQuote })).toBeNull();
        const transmute = {
            route: 'transmute',
            sourceHrid: '/items/garnet',
            cost: 28_100,
            seconds: 36,
            // 2.8M an Amber, against the earrings' 1.3M at the top ask
            yields: new Map([['/items/amber', 0.01]]),
            kept: new Map(),
        };
        const index = indexRoutes({ sources: [earrings(), transmute] });
        // At the top ask for any quantity the earrings looked cheaper, per point
        expect(bestOptions(counts, index)[0].sourceHrid).toBe('/items/earrings_of_essence_find');
        const [best] = bestOptions(counts, index, { buyQuote });
        expect(best.sourceHrid).toBe('/items/garnet');
    });

    test('the plan buys further up the book with each step, and stops at what the market offers', () => {
        const buyQuote = (purchase, units, already) =>
            buyCost(units, { ask: purchase.ask, listings: EARRING_ASKS, weekly: 0, already });
        const plan = planTarget(new Map(), indexRoutes({ sources: [earrings()] }), 10, { buyQuote });
        // One earring for the first Amber, two for the tenth; the hundredth needs 18 more of the 11 on show
        const bought = plan.steps.reduce((sum, step) => sum + step.bought.get('/items/earrings_of_essence_find'), 0);
        expect(bought).toBe(3);
        expect(plan.reached).toBe(false);
        expect(plan.steps[0].gold).toBeCloseTo(6_306_536, 6);
        // The second step starts where the first left the book: 6.3M, then 6.35M
        expect(plan.steps[1].gold).toBeCloseTo(2 * 6536 + 6_300_000 + 6_350_000, 6);
    });
});
