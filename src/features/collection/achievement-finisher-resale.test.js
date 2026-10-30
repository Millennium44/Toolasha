/**
 * "Any of" production achievements pick the candidate worth crafting and selling back: net of the resale,
 * bids first, thin markets last, unknown volume not thin.
 */

import { describe, test, expect } from 'vitest';

import { resolveAchievement, readiness } from './achievement-finisher-resolve.js';
import { ANY_OF_ACHIEVEMENTS as ACH, ANY_OF_DATA as DATA } from './__fixtures__/achievement-finisher-anyof.js';

const POT = '/actions/cheesesmithing/celestial_pot';
const HAMMER = '/actions/crafting/celestial_hammer';
const TOP = '/actions/tailoring/gatherers_top';

const withCount = (hrid, count) => ({
    ...DATA,
    actionDetailMap: {
        ...DATA.actionDetailMap,
        [hrid]: {
            ...DATA.actionDetailMap[hrid],
            outputItems: [{ itemHrid: `/items/${hrid.split('/').pop()}`, count }],
        },
    },
});
const resolve = (data = DATA) => resolveAchievement(ACH['/achievements/make_celestial'], data);
const LEVELS = new Map([
    ['/skills/crafting', 95],
    ['/skills/cheesesmithing', 95],
    ['/skills/tailoring', 95],
]);
const BUY = { '/items/mooncrystal': 100, '/items/silk': 10 };
// pot: 2 mooncrystal = 200, hammer: 4 = 400, top: 6 silk = 60
const ctx = (over = {}) => ({
    skillLevels: LEVELS,
    combatLevel: 50,
    inventory: [],
    ironCow: false,
    buyPrice: (hrid) => BUY[hrid] ?? null,
    ...over,
});
const sells = (table) => (hrid) => table[hrid] ?? null;

describe('any-of production ranks by net cost after resale', () => {
    test('a dearer bill that resells for more beats the cheapest bill', () => {
        const pick = (extra) => readiness(resolve(), ctx(extra));
        // Without resale data nothing changes: the 60 coin top
        expect(pick().actionHrid).toBe(TOP);
        const ready = pick({ sellPrice: sells({ '/items/celestial_pot': 100, '/items/celestial_hammer': 1000 }) });
        // pot net 200-100, hammer net 400-1000, top has no bid
        expect(ready.actionHrid).toBe(HAMMER);
        expect(ready).toMatchObject({ cost: 400, resale: 1000, net: -600, noBid: false, thin: false });
    });

    test('the resale counts every unit an action makes', () => {
        const ready = readiness(
            resolve(withCount(POT, 3)),
            ctx({ sellPrice: sells({ '/items/celestial_pot': 150, '/items/celestial_hammer': 400 }) })
        );
        // pot: 200 - 3*150 = -250 beats hammer 400 - 400 = 0
        expect(ready.actionHrid).toBe(POT);
        expect(ready).toMatchObject({ resale: 450, net: -250 });
    });

    test('an output with no bid ranks after any with a bid, even a cheaper bill', () => {
        const ready = readiness(resolve(), ctx({ sellPrice: sells({ '/items/celestial_hammer': 5 }) }));
        expect(ready.actionHrid).toBe(HAMMER);
        expect(ready.noBid).toBe(false);
        // Nothing has a bid: the cheapest bill, flagged
        const none = readiness(resolve(), ctx({ sellPrice: sells({}) }));
        expect(none.actionHrid).toBe(TOP);
        expect(none).toMatchObject({ noBid: true, resale: 0, net: 60 });
    });

    test('a thin market ranks after one that trades; unknown volume is not thin', () => {
        const prices = { '/items/celestial_pot': 100, '/items/celestial_hammer': 1000 };
        const volume = (table) => (hrid) => table[hrid] ?? null;
        const pick = (volumes) => readiness(resolve(), ctx({ sellPrice: sells(prices), dailyVolume: volume(volumes) }));
        const thinHammer = pick({
            '/items/celestial_hammer': { known: true, unitsPerDay: 0.3 },
            '/items/celestial_pot': { known: true, unitsPerDay: 20 },
        });
        expect(thinHammer.actionHrid).toBe(POT);
        expect(thinHammer.thin).toBe(false);
        // Unknown (never looked up, or looked up and unmeasurable) is not thin
        expect(pick({}).actionHrid).toBe(HAMMER);
        expect(pick({ '/items/celestial_hammer': { known: false, unitsPerDay: 0 } }).actionHrid).toBe(HAMMER);
        // Exactly 1 a day trades
        expect(pick({ '/items/celestial_hammer': { known: true, unitsPerDay: 1 } }).actionHrid).toBe(HAMMER);
        // Everything thin: the net decides, and the pick is flagged
        const allThin = pick({
            '/items/celestial_hammer': { known: true, unitsPerDay: 0.3 },
            '/items/celestial_pot': { known: true, unitsPerDay: 0.5 },
        });
        expect(allThin).toMatchObject({ actionHrid: HAMMER, thin: true, unitsPerDay: 0.3 });
    });

    test('an unpriced input never counts as free, whatever the output sells for', () => {
        const noSilk = { buyPrice: (h) => (h === '/items/mooncrystal' ? 100 : null) };
        const ready = readiness(resolve(), ctx({ ...noSilk, sellPrice: sells({ '/items/gatherers_top': 99999 }) }));
        // The top resells hugely but its bill is unknown: a priced bill still wins
        expect(ready.actionHrid).toBe(POT);
        // Only the top is level-met: it is chosen, resale shown, net unknown
        const topOnly = readiness(
            resolve(),
            ctx({
                ...noSilk,
                skillLevels: new Map([['/skills/tailoring', 95]]),
                sellPrice: sells({ '/items/gatherers_top': 500 }),
            })
        );
        expect(topOnly).toMatchObject({ actionHrid: TOP, cost: null, resale: 500, net: null });
        expect(topOnly.unpriced).toEqual(['/items/silk']);
    });

    test('owned inputs cost nothing: the better resale wins among them', () => {
        const inventory = [
            { itemHrid: '/items/mooncrystal', count: 10, itemLocationHrid: '/item_locations/inventory' },
            { itemHrid: '/items/silk', count: 10, itemLocationHrid: '/item_locations/inventory' },
        ].map((row) => ({ ...row, enhancementLevel: 0 }));
        const ready = readiness(
            resolve(),
            ctx({ inventory, sellPrice: sells({ '/items/celestial_pot': 10, '/items/gatherers_top': 70 }) })
        );
        expect(ready).toMatchObject({ actionHrid: TOP, owned: true, resale: 70, net: -70 });
    });

    test('an Iron Cow has no market: the pick is the old one and carries no resale', () => {
        const ready = readiness(
            resolve(),
            ctx({ ironCow: true, sellPrice: sells({ '/items/celestial_hammer': 1e6 }) })
        );
        expect(ready.actionHrid).toBe(POT);
        expect(ready.resale).toBeUndefined();
        expect(ready.net).toBeUndefined();
    });

    test('level not met on any: the lowest level, as before', () => {
        const ready = readiness(
            resolve(),
            ctx({
                skillLevels: new Map([
                    ['/skills/crafting', 1],
                    ['/skills/cheesesmithing', 1],
                    ['/skills/tailoring', 1],
                ]),
                sellPrice: sells({ '/items/celestial_hammer': 1e6 }),
            })
        );
        expect(ready.levelMet).toBe(false);
        expect(ready.actionHrid).toBe(POT);
    });
});
