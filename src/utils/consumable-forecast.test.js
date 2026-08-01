import { describe, test, expect } from 'vitest';
import {
    forecast,
    forecastAll,
    firstToRunOut,
    costPerDay,
    costPerDaySides,
    partyOutlook,
    drinkRatePerDay,
    buyStrategy,
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

describe('partyOutlook', () => {
    const player = (name, isCurrent, seconds) => ({
        name,
        isCurrent,
        forecasts: forecastAll([{ ...drink, inventoryAmount: seconds / 3600 }]),
    });

    test('answers for you and for everyone else separately', () => {
        const outlook = partyOutlook([player('You', true, 7200), player('Them', false, 3600)]);
        expect(Math.round(outlook.you.secondsLeft)).toBe(7200);
        expect(Math.round(outlook.party.secondsLeft)).toBe(3600);
        expect(outlook.partyName).toBe('Them');
    });

    test('the party figure excludes you', () => {
        // It answers "how is everyone else doing" — the part you cannot already
        // see — so your own stock must not win it
        const outlook = partyOutlook([player('You', true, 60), player('Them', false, 7200)]);
        expect(Math.round(outlook.party.secondsLeft)).toBe(7200);
    });

    test('the party is the soonest of them, not the last one listed', () => {
        const outlook = partyOutlook([player('A', false, 7200), player('B', false, 1800)]);
        expect(outlook.partyName).toBe('B');
    });

    test('solo has no party answer rather than a copy of yours', () => {
        const outlook = partyOutlook([player('You', true, 3600)]);
        expect(outlook.party).toBeNull();
        expect(outlook.partyName).toBeNull();
    });

    test('a player consuming nothing is not the party answer', () => {
        const idle = { name: 'Idle', isCurrent: false, forecasts: forecastAll([{ ...drink, consumptionRate: 0 }]) };
        expect(partyOutlook([player('You', true, 3600), idle]).party).toBeNull();
    });

    test('survives no players', () => {
        expect(partyOutlook([])).toEqual({ you: null, party: null, partyName: null });
    });
});

describe('drinkRatePerDay', () => {
    test('is the day divided by how long one lasts', () => {
        // A 300-second drink with no concentration: 288 a day
        expect(drinkRatePerDay(300 * 1e9, 0)).toBeCloseTo(288, 6);
    });

    test('concentration shortens the buff, so more are drunk', () => {
        // 300s at 20% is a 250s buff — the 345.6 the old hardcoded cap assumed
        expect(drinkRatePerDay(300 * 1e9, 0.2)).toBeCloseTo(345.6, 4);
    });

    test('less concentration than the cap means fewer drinks, not the cap', () => {
        // The measured rate was capped at 345.6 for everyone, telling anyone
        // below maximum concentration they drink faster than they do
        expect(drinkRatePerDay(300 * 1e9, 0.05)).toBeLessThan(345.6);
    });

    test('an unknown duration has no answer rather than a zero rate', () => {
        expect(drinkRatePerDay(0)).toBeNull();
        expect(drinkRatePerDay(undefined)).toBeNull();
    });
});

describe('buyStrategy', () => {
    const base = { count: 100, ask: 110, bid: 100, secondsLeft: 30 * 86400 };

    test('a worthwhile spread with time to spare is an order', () => {
        const result = buyStrategy(base);
        expect(result.mode).toBe('order');
        expect(result.saving).toBe(1000);
    });

    test('running out first beats the saving', () => {
        // A fill that arrives after you have stopped has saved you nothing
        expect(buyStrategy({ ...base, secondsLeft: 3600 }).mode).toBe('instant');
    });

    test('a spread too thin to wait for is taken at ask', () => {
        expect(buyStrategy({ ...base, bid: 109 }).mode).toBe('instant');
    });

    test('nothing bid leaves an order nothing to sit at', () => {
        expect(buyStrategy({ ...base, bid: 0 }).mode).toBe('instant');
    });

    test('nothing to buy needs no strategy', () => {
        expect(buyStrategy({ ...base, count: 0 }).mode).toBe('instant');
    });
});

describe('buyStrategy and a measured fill time', () => {
    const base = { count: 100, ask: 110, bid: 100, secondsLeft: 30 * 86400 };

    test('says whether the wait was measured or assumed', () => {
        // A guess presented as an estimate is worse than a guess labelled as one
        expect(buyStrategy(base).measured).toBe(false);
        expect(buyStrategy({ ...base, fillSeconds: 900 }).measured).toBe(true);
    });

    test('a book saying it fills quickly rescues an order the assumption would refuse', () => {
        const urgent = { ...base, secondsLeft: 2 * 3600 };
        expect(buyStrategy(urgent).mode).toBe('instant');
        expect(buyStrategy({ ...urgent, fillSeconds: 600 }).mode).toBe('order');
    });

    test('a book saying it fills slowly refuses an order the assumption would allow', () => {
        expect(buyStrategy({ ...base, secondsLeft: 12 * 3600 }).mode).toBe('order');
        expect(buyStrategy({ ...base, secondsLeft: 12 * 3600, fillSeconds: 5 * 86400 }).mode).toBe('instant');
    });
});
