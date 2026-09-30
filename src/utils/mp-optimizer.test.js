import { describe, test, expect } from 'vitest';
import { slotTypeOf, buildMpCandidates, findBestOptimAllocation, findMaxMpAllocation } from './mp-optimizer.js';

const MINUTE_NS = 60e9;

/** Item shapes as the game emits them: category hrid, consumableDetail with nanosecond cooldowns */
const ITEMS = {
    '/items/donut': {
        name: 'Donut',
        categoryHrid: '/item_categories/food',
        consumableDetail: { hitpointRestore: 0, manapointRestore: 60, cooldownDuration: MINUTE_NS },
    },
    '/items/star_fruit_yogurt': {
        name: 'Star Fruit Yogurt',
        categoryHrid: '/item_categories/food',
        consumableDetail: { hitpointRestore: 0, manapointRestore: 350, cooldownDuration: MINUTE_NS },
    },
    '/items/plum_gummy': {
        name: 'Plum Gummy',
        categoryHrid: '/item_categories/food',
        consumableDetail: {
            hitpointRestore: 0,
            manapointRestore: 100,
            recoveryDuration: 10e9,
            cooldownDuration: MINUTE_NS,
        },
    },
    '/items/star_fruit_gummy': {
        name: 'Star Fruit Gummy',
        categoryHrid: '/item_categories/food',
        consumableDetail: {
            hitpointRestore: 0,
            manapointRestore: 280,
            recoveryDuration: 10e9,
            cooldownDuration: MINUTE_NS,
        },
    },
    '/items/marsberry_cake': {
        name: 'Marsberry Cake',
        categoryHrid: '/item_categories/food',
        consumableDetail: { hitpointRestore: 240, manapointRestore: 0, cooldownDuration: MINUTE_NS },
    },
    '/items/sword': { name: 'Sword', categoryHrid: '/item_categories/equipment', equipmentDetail: {} },
};

const PRICES = {
    '/items/donut': 300,
    '/items/star_fruit_yogurt': 900,
    '/items/plum_gummy': 200,
    '/items/star_fruit_gummy': 500,
    '/items/marsberry_cake': 400,
};

const priceOf = (hrid) => PRICES[hrid] ?? null;
const build = (extra = {}) => buildMpCandidates({ ...ITEMS, ...extra }, { priceOf });

describe('slotTypeOf', () => {
    test('names the restore type the game lets one item occupy', () => {
        expect(slotTypeOf({ manapointRestore: 60 })).toBe('mp_instant');
        expect(slotTypeOf({ manapointRestore: 60, recoveryDuration: 10e9 })).toBe('mp_over_time');
        expect(slotTypeOf({ hitpointRestore: 50, manapointRestore: 60 })).toBe('hp_instant');
        expect(slotTypeOf({ buffs: [{ uniqueHrid: '/luck' }] })).toBe(null);
    });
});

describe('buildMpCandidates', () => {
    test('rates come from the cooldown and the restore, priced per hour', () => {
        const yogurt = build().find((c) => c.hrid === '/items/star_fruit_yogurt');

        expect(yogurt.usesPerMinute).toBe(1);
        expect(yogurt.mpPerMinute).toBe(350);
        expect(yogurt.costPerHour).toBe(54_000);
        expect(yogurt.slotType).toBe('food:mp_instant');
    });

    test('food haste shortens a food cooldown and leaves a drink alone', () => {
        const drink = {
            '/items/mana_drink': {
                name: 'Mana Drink',
                categoryHrid: '/item_categories/drink',
                consumableDetail: { manapointRestore: 120, cooldownDuration: 30e9 },
            },
        };
        const options = { priceOf: (hrid) => priceOf(hrid) ?? 100, foodHaste: 0.25, drinkConcentration: 0 };
        const candidates = buildMpCandidates({ ...ITEMS, ...drink }, options);

        expect(candidates.find((c) => c.hrid === '/items/star_fruit_yogurt').mpPerMinute).toBe(350 * 1.25);
        expect(candidates.find((c) => c.hrid === '/items/mana_drink').mpPerMinute).toBe(240);

        const concentrated = buildMpCandidates({ ...ITEMS, ...drink }, { ...options, drinkConcentration: 0.5 });
        expect(concentrated.find((c) => c.hrid === '/items/mana_drink').mpPerMinute).toBe(360);
        expect(concentrated.find((c) => c.hrid === '/items/star_fruit_yogurt').mpPerMinute).toBe(350 * 1.25);
    });

    test('leaves out what restores no mana, is unpriced, or has no cooldown', () => {
        const candidates = build({
            '/items/free_donut': { ...ITEMS['/items/donut'] },
            '/items/no_cooldown': {
                name: 'X',
                categoryHrid: '/item_categories/food',
                consumableDetail: { manapointRestore: 50 },
            },
        });

        expect(candidates.map((c) => c.hrid).sort()).toEqual([
            '/items/donut',
            '/items/plum_gummy',
            '/items/star_fruit_gummy',
            '/items/star_fruit_yogurt',
        ]);
    });

    test('flags a food that also heals and files it under the HP type', () => {
        const combo = {
            '/items/combo': {
                name: 'Combo',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 100, manapointRestore: 100, cooldownDuration: MINUTE_NS },
            },
        };
        const [candidate] = buildMpCandidates(combo, { priceOf: () => 10 });

        expect(candidate.alsoHeals).toBe(true);
        expect(candidate.slotType).toBe('food:hp_instant');
    });
});

describe('findBestOptimAllocation', () => {
    test('takes the single cheapest item that reaches a low target', () => {
        // Per hour: donut 60 MP/min for 18,000; plum gummy 100 for 12,000
        const best = findBestOptimAllocation(build(), 50);

        expect(best.items.map((i) => i.hrid)).toEqual(['/items/plum_gummy']);
        expect(best.mpPerMinute).toBe(100);
        expect(best.costPerHour).toBe(12_000);
    });

    test('combines slot types when no single item reaches the target', () => {
        // 380 needs a yogurt (350) or gummy (280) plus something from the other type
        const best = findBestOptimAllocation(build(), 380);

        expect(best.mpPerMinute).toBeGreaterThanOrEqual(380);
        const types = best.items.map((i) => i.slotType);
        expect(new Set(types).size).toBe(types.length);
        // Yogurt 350 + plum gummy 100 = 450 MP/min for 66,000/h beats yogurt + star fruit gummy at 84,000/h
        expect(best.items.map((i) => i.hrid).sort()).toEqual(['/items/plum_gummy', '/items/star_fruit_yogurt']);
        expect(best.costPerHour).toBe(66_000);
    });

    test('never holds two items of one slot type', () => {
        const best = findBestOptimAllocation(build(), 500);
        const types = best.items.map((i) => i.slotType);

        expect(new Set(types).size).toBe(types.length);
    });

    test('an unreachable target is null', () => {
        // Best possible is yogurt 350 + star fruit gummy 280 = 630
        expect(findBestOptimAllocation(build(), 631)).toBe(null);
    });

    test('a target exactly at the ceiling is reachable', () => {
        const best = findBestOptimAllocation(build(), 630);

        expect(best.mpPerMinute).toBe(630);
        expect(best.items.map((i) => i.hrid).sort()).toEqual(['/items/star_fruit_gummy', '/items/star_fruit_yogurt']);
    });

    test('a zero target needs no items', () => {
        const best = findBestOptimAllocation(build(), 0);

        expect(best.items).toEqual([]);
        expect(best.costPerHour).toBe(0);
    });

    test('no candidates: a target is unreachable, and so is nothing to supply only at zero', () => {
        expect(findBestOptimAllocation([], 10)).toBe(null);
        expect(findBestOptimAllocation([], 0).items).toEqual([]);
    });

    test('a slot cap of one food narrows the reachable range', () => {
        const maxSlots = { food: 1, drink: 3 };

        expect(findBestOptimAllocation(build(), 351, { maxSlots })).toBe(null);
        expect(findBestOptimAllocation(build(), 350, { maxSlots }).items.map((i) => i.hrid)).toEqual([
            '/items/star_fruit_yogurt',
        ]);
    });

    test('equal cost goes to more MP, then to the same answer whatever the order', () => {
        const twin = (hrid, mp) => ({
            [hrid]: {
                name: hrid,
                categoryHrid: '/item_categories/food',
                consumableDetail: { manapointRestore: mp, cooldownDuration: MINUTE_NS },
            },
        });
        const a = twin('/items/a', 100);
        const b = twin('/items/b', 120);
        const c = twin('/items/c', 100);
        const prices = { '/items/a': 10, '/items/b': 10, '/items/c': 10 };
        const make = (parts) =>
            buildMpCandidates(Object.assign({}, ...parts), {
                priceOf: (hrid) => prices[hrid],
            });

        expect(findBestOptimAllocation(make([a, b]), 50).items[0].hrid).toBe('/items/b');
        expect(findBestOptimAllocation(make([a, c]), 50).items[0].hrid).toBe('/items/a');
        expect(findBestOptimAllocation(make([c, a]), 50).items[0].hrid).toBe('/items/a');
    });
});

describe('findMaxMpAllocation', () => {
    test('is the best item of every slot type', () => {
        const max = findMaxMpAllocation(build());

        expect(max.mpPerMinute).toBe(630);
        expect(max.items.map((i) => i.hrid).sort()).toEqual(['/items/star_fruit_gummy', '/items/star_fruit_yogurt']);
    });

    test('a budget takes the best that fits', () => {
        // Yogurt alone is 54,000/h; adding the plum gummy is 66,000/h
        const max = findMaxMpAllocation(build(), { maxCostPerHour: 60_000 });

        expect(max.items.map((i) => i.hrid)).toEqual(['/items/star_fruit_yogurt']);
        expect(max.mpPerMinute).toBe(350);
    });

    test('a budget nothing fits is null', () => {
        expect(findMaxMpAllocation(build(), { maxCostPerHour: 100 })).toBe(null);
    });

    test('the slot cap limits it', () => {
        const max = findMaxMpAllocation(build(), { maxSlots: { food: 1, drink: 3 } });

        expect(max.items.map((i) => i.hrid)).toEqual(['/items/star_fruit_yogurt']);
    });

    test('nothing priced is null', () => {
        expect(findMaxMpAllocation([])).toBe(null);
    });
});
