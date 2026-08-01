import { describe, test, expect } from 'vitest';
import {
    forecast,
    forecastAll,
    firstToRunOut,
    costPerDay,
    costPerDaySides,
    refillFor,
    refillAll,
} from './consumable-forecast.js';

/** One drink an hour, 100 in the bag, worth 50 each */
const drink = {
    itemHrid: '/items/drink',
    itemName: 'Drink',
    inventoryAmount: 100,
    consumptionRate: 1 / 3600,
    pricePerItem: 50,
};

describe('forecast', () => {
    test('turns a rate per second into a day and a countdown', () => {
        const result = forecast(drink);
        expect(result.perDay).toBeCloseTo(24, 6);
        expect(result.secondsLeft).toBeCloseTo(360000, 3);
        expect(result.costPerDay).toBeCloseTo(1200, 6);
    });

    test('something not being consumed lasts forever rather than zero seconds', () => {
        expect(forecast({ ...drink, consumptionRate: 0 }).secondsLeft).toBe(Infinity);
    });

    test('an empty slot runs out now, not never', () => {
        expect(forecast({ ...drink, inventoryAmount: 0 }).secondsLeft).toBe(0);
    });

    test('no price is null rather than zero, so it is not counted as free', () => {
        const result = forecast({ ...drink, pricePerItem: 0 });
        expect(result.price).toBeNull();
        expect(result.costPerDay).toBeNull();
    });

    test('falls back to the current count when there is no inventory figure', () => {
        expect(forecast({ ...drink, inventoryAmount: undefined, currentCount: 7 }).held).toBe(7);
    });

    test('survives an empty entry', () => {
        expect(forecast(null).held).toBe(0);
    });
});

describe('forecastAll', () => {
    test('puts the soonest first', () => {
        const list = forecastAll([
            { ...drink, itemName: 'Slow', consumptionRate: 1 / 7200 },
            { ...drink, itemName: 'Fast', consumptionRate: 1 / 60 },
        ]);
        expect(list.map((entry) => entry.name)).toEqual(['Fast', 'Slow']);
    });

    test('something unused sorts last rather than being dropped', () => {
        // A slot filled with something it is not drinking is still worth seeing
        const list = forecastAll([
            { ...drink, itemName: 'Unused', consumptionRate: 0 },
            { ...drink, itemName: 'Used' },
        ]);
        expect(list.map((entry) => entry.name)).toEqual(['Used', 'Unused']);
    });

    test('survives nothing at all', () => {
        expect(forecastAll(null)).toEqual([]);
    });
});

describe('firstToRunOut', () => {
    test('is the minimum, because a run ends when its first consumable does', () => {
        const list = forecastAll([
            { ...drink, itemName: 'Slow', consumptionRate: 1 / 7200 },
            { ...drink, itemName: 'Fast', consumptionRate: 1 / 60 },
        ]);
        expect(firstToRunOut(list).name).toBe('Fast');
    });

    test('never is not a candidate for soonest', () => {
        // Infinity loses a numeric comparison, but only if it is compared at all
        const list = forecastAll([{ ...drink, itemName: 'Unused', consumptionRate: 0 }]);
        expect(firstToRunOut(list)).toBeNull();
    });

    test('nothing in use is nobody', () => {
        expect(firstToRunOut([])).toBeNull();
    });
});

describe('costPerDay', () => {
    test('adds up what a day costs', () => {
        expect(costPerDay(forecastAll([drink, drink])).total).toBeCloseTo(2400, 6);
    });

    test('counts the unpriced separately rather than as free', () => {
        // Rolled into the total as zero, an unpriced consumable makes the figure
        // look smaller than it is with nothing to say so
        const result = costPerDay(forecastAll([drink, { ...drink, pricePerItem: 0 }]));
        expect(result.total).toBeCloseTo(1200, 6);
        expect(result.unpriced).toBe(1);
    });
});

describe('refillFor', () => {
    const entry = forecast(drink);

    test('asks for the shortfall, not the whole requirement', () => {
        // Two days at 24/day is 48; 100 are already held
        expect(refillFor(entry, 2 * 86400).count).toBe(0);
    });

    test('rounds up, because half a drink is not a drink', () => {
        const slow = forecast({ ...drink, inventoryAmount: 0, consumptionRate: 1 / 86400 });
        expect(refillFor(slow, 43200).count).toBe(1);
    });

    test('prices the shortfall', () => {
        const empty = forecast({ ...drink, inventoryAmount: 0 });
        const need = refillFor(empty, 86400);
        expect(need.count).toBe(24);
        expect(need.cost).toBe(1200);
    });

    test('an unpriced item still says how many, and nothing about cost', () => {
        const free = forecast({ ...drink, inventoryAmount: 0, pricePerItem: 0 });
        expect(refillFor(free, 86400)).toEqual({ count: 24, cost: null });
    });

    test('something not being consumed needs nothing, however long the target', () => {
        expect(refillFor(forecast({ ...drink, consumptionRate: 0 }), 86400 * 30).count).toBe(0);
    });
});

describe('refillAll', () => {
    test('adds up the shortfall across everything', () => {
        const list = forecastAll([
            { ...drink, inventoryAmount: 0 },
            { ...drink, inventoryAmount: 0, itemName: 'Other' },
        ]);
        const need = refillAll(list, 86400);
        expect(need.items).toBe(48);
        expect(need.cost).toBe(2400);
    });

    test('reports how many it could not price', () => {
        const list = forecastAll([
            { ...drink, inventoryAmount: 0 },
            { ...drink, inventoryAmount: 0, pricePerItem: 0 },
        ]);
        expect(refillAll(list, 86400).unpriced).toBe(1);
    });

    test('nothing needed costs nothing', () => {
        expect(refillAll(forecastAll([drink]), 3600)).toEqual({ items: 0, cost: 0, unpriced: 0 });
    });
});

describe('two-sided pricing', () => {
    const prices = { '/items/drink': { ask: 60, bid: 40 } };
    const pricesFor = (hrid) => prices[hrid];

    test('a day costs ask to buy and returns bid to sell', () => {
        const [entry] = forecastAll([drink], pricesFor);
        expect(entry.costPerDaySides.ask).toBeCloseTo(24 * 60, 6);
        expect(entry.costPerDaySides.bid).toBeCloseTo(24 * 40, 6);
    });

    test('no book gives no sides rather than zero ones', () => {
        // Zero would read as free; null says the market had no answer
        const [entry] = forecastAll([drink]);
        expect(entry.costPerDaySides).toEqual({ ask: null, bid: null });
    });

    test('the total carries both sides', () => {
        const totals = costPerDaySides(forecastAll([drink, drink], pricesFor));
        expect(totals.ask).toBeCloseTo(2880, 6);
        expect(totals.bid).toBeCloseTo(1920, 6);
    });
});
