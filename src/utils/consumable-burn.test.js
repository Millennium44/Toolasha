import { describe, test, expect } from 'vitest';
import {
    isDrinkConsumable,
    measuredBurnPerHour,
    simBurnPerHour,
    compareCategory,
    compareBurnToSim,
    formatBurnLine,
    MIN_MEASURED_SECONDS,
} from './consumable-burn.js';

const HOUR = 3600;

describe('isDrinkConsumable', () => {
    test('names coffees and drinks as drinks', () => {
        expect(isDrinkConsumable('/items/swiftness_coffee')).toBe(true);
        expect(isDrinkConsumable('/items/drinks/whatever')).toBe(true);
    });

    test('falls back to the item category', () => {
        expect(isDrinkConsumable('/items/mystery', { categoryHrid: '/item_categories/drink' })).toBe(true);
        expect(isDrinkConsumable('/items/mystery', { categoryHrid: '/item_categories/food' })).toBe(false);
    });

    test('food is food', () => {
        expect(isDrinkConsumable('/items/blueberry_cake')).toBe(false);
        expect(isDrinkConsumable('')).toBe(false);
    });
});

describe('measuredBurnPerHour', () => {
    test('counts uses over the window, split by category', () => {
        const measured = measuredBurnPerHour([
            { itemHrid: '/items/blueberry_cake', actualConsumed: 90, elapsedSeconds: 2 * HOUR },
            { itemHrid: '/items/swiftness_coffee', actualConsumed: 24, elapsedSeconds: 2 * HOUR },
        ]);
        expect(measured.food).toBeCloseTo(45);
        expect(measured.drinks).toBeCloseTo(12);
        expect(measured.measuredSeconds).toBe(2 * HOUR);
    });

    test('ignores a slot that was never watched, and reports the longest window', () => {
        const measured = measuredBurnPerHour([
            { itemHrid: '/items/blueberry_cake', actualConsumed: 10, elapsedSeconds: 0 },
            { itemHrid: '/items/gourmet_cake', actualConsumed: 30, elapsedSeconds: HOUR },
        ]);
        expect(measured.food).toBeCloseTo(30);
        expect(measured.measuredSeconds).toBe(HOUR);
    });

    test('a slot filled but never eaten from still counts its window', () => {
        const measured = measuredBurnPerHour([
            { itemHrid: '/items/blueberry_cake', actualConsumed: 0, elapsedSeconds: HOUR },
        ]);
        expect(measured.food).toBe(0);
        expect(measured.measuredSeconds).toBe(HOUR);
    });

    test('nothing at all measures nothing', () => {
        expect(measuredBurnPerHour(null)).toEqual({ food: 0, drinks: 0, measuredSeconds: 0 });
    });
});

describe('simBurnPerHour', () => {
    test('sums the sim record by category', () => {
        const sim = simBurnPerHour({
            '/items/blueberry_cake': 20,
            '/items/gourmet_cake': 5,
            '/items/swiftness_coffee': 12,
            '/items/unused': 0,
        });
        expect(sim.food).toBeCloseTo(25);
        expect(sim.drinks).toBeCloseTo(12);
    });
});

describe('compareCategory', () => {
    test('is a ratio, coloured past the band', () => {
        expect(compareCategory(45, 25)).toMatchObject({ ratio: 1.8, tone: 'high' });
        expect(compareCategory(12, 12)).toMatchObject({ ratio: 1, tone: 'flat' });
        expect(compareCategory(10, 20)).toMatchObject({ ratio: 0.5, tone: 'low' });
    });

    test('the band edges are inside the flat zone', () => {
        expect(compareCategory(125, 100).tone).toBe('flat');
        expect(compareCategory(75, 100).tone).toBe('flat');
        expect(compareCategory(126, 100).tone).toBe('high');
        expect(compareCategory(74, 100).tone).toBe('low');
    });

    test('a sim that assumed nothing is unratable, not infinite', () => {
        expect(compareCategory(10, 0)).toBeNull();
        expect(compareCategory(0, 0)).toBeNull();
    });

    test('eating nothing against a sim that expected something is a real zero', () => {
        expect(compareCategory(0, 20)).toMatchObject({ ratio: 0, tone: 'low' });
    });
});

describe('compareBurnToSim', () => {
    const consumables = [
        { itemHrid: '/items/blueberry_cake', actualConsumed: 90, elapsedSeconds: 2 * HOUR },
        { itemHrid: '/items/swiftness_coffee', actualConsumed: 24, elapsedSeconds: 2 * HOUR },
    ];
    const simRecord = {
        zoneHrid: '/actions/combat/chimerical_den',
        difficultyTier: 0,
        savedAt: 1700000000000,
        perHour: { '/items/blueberry_cake': 25, '/items/swiftness_coffee': 12 },
    };

    test('rates both categories against the matching sim', () => {
        const result = compareBurnToSim({
            consumables,
            simRecord,
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
        });
        expect(result.reason).toBeNull();
        expect(result.food.ratio).toBeCloseTo(1.8);
        expect(result.drinks.ratio).toBeCloseTo(1);
        expect(result.measuredSeconds).toBe(2 * HOUR);
        expect(result.simmedAt).toBe(1700000000000);
    });

    test('refuses a sim of another zone', () => {
        const result = compareBurnToSim({
            consumables,
            simRecord,
            actionHrid: '/actions/combat/pirate_cove',
            difficultyTier: 0,
        });
        expect(result.food).toBeNull();
        expect(result.reason).toBe('no sim on record for this zone');
    });

    test('refuses a sim of the same zone at another tier', () => {
        const result = compareBurnToSim({
            consumables,
            simRecord,
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 2,
        });
        expect(result.reason).toBe('the sim on record is for a different tier');
    });

    test('refuses a window too short to mean anything', () => {
        const result = compareBurnToSim({
            consumables: [{ itemHrid: '/items/blueberry_cake', actualConsumed: 5, elapsedSeconds: 300 }],
            simRecord,
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
        });
        expect(result.reason).toBe('not measured for long enough yet');
        expect(result.measuredSeconds).toBe(300);
        expect(MIN_MEASURED_SECONDS).toBeGreaterThan(300);
    });

    test('says so when no sim has ever run', () => {
        const result = compareBurnToSim({
            consumables,
            simRecord: null,
            actionHrid: '/actions/combat/chimerical_den',
        });
        expect(result.reason).toBe('no sim on record for this zone');
    });
});

describe('formatBurnLine', () => {
    test('reads as the one line it is meant to be', () => {
        const line = formatBurnLine(
            {
                food: { ratio: 1.8, tone: 'high' },
                drinks: { ratio: 1.02, tone: 'flat' },
                measuredSeconds: 2 * HOUR,
            },
            (seconds) => `${seconds / HOUR}h`
        );
        expect(line.text).toBe('food 1.8× sim · drinks 1.0× sim (2h measured)');
        expect(line.tone).toBe('high');
        expect(line.note).toContain('inherits');
    });

    test('one rated category is still a line', () => {
        const line = formatBurnLine({ food: { ratio: 0.5, tone: 'low' }, drinks: null, measuredSeconds: HOUR });
        expect(line.text).toContain('food 0.5× sim');
        expect(line.text).not.toContain('drinks');
        expect(line.tone).toBe('low');
    });

    test('nothing rated draws nothing', () => {
        expect(formatBurnLine({ food: null, drinks: null, measuredSeconds: HOUR })).toBeNull();
        expect(formatBurnLine(null)).toBeNull();
    });
});
