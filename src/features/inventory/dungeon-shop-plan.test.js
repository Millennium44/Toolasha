import { describe, test, expect } from 'vitest';
import { volumeCap, planTokenSpend, DEFAULT_CAP_DAYS, DEFAULT_CAP_SHARE_PERCENT } from './dungeon-shop-plan.js';

const DEFAULTS = { days: DEFAULT_CAP_DAYS, sharePercent: DEFAULT_CAP_SHARE_PERCENT };

/** The Pirate shop's shape: a 1-token essence and 2,000/3,000-token items */
const OFFERS = [
    { itemHrid: '/items/pirate_essence', name: 'Pirate Essence', cost: 1, netValue: 150 },
    { itemHrid: '/items/marksman_brooch', name: 'Marksman Brooch', cost: 2000, netValue: 500_000 },
    { itemHrid: '/items/kraken_fang', name: 'Kraken Fang', cost: 3000, netValue: 900_000 },
    { itemHrid: '/items/damaged_anchor', name: 'Damaged Anchor', cost: 2000, netValue: 360_000 },
];

const measured = (unitsPerDay) => ({ unitsPerDay, known: true });

describe('volumeCap', () => {
    test('is N days × X% of the traded volume, in whole items', () => {
        expect(volumeCap(measured(10), DEFAULTS)).toEqual({ cap: 7, measured: true, unitsPerDay: 10 });
        expect(volumeCap(measured(4), DEFAULTS).cap).toBe(3);
    });

    test('changing N and X changes the cap', () => {
        expect(volumeCap(measured(10), { days: 7, sharePercent: 25 }).cap).toBe(17);
        expect(volumeCap(measured(10), { days: 3, sharePercent: 50 }).cap).toBe(15);
        expect(volumeCap(measured(10), { days: 1, sharePercent: 10 }).cap).toBe(1);
    });

    test('a measured zero caps at zero whatever the unmeasured switch says', () => {
        expect(volumeCap(measured(0), { ...DEFAULTS, includeUnmeasured: true })).toEqual({
            cap: 0,
            measured: true,
            unitsPerDay: 0,
        });
    });

    test('an unmeasured item caps at zero, or is uncapped when included', () => {
        expect(volumeCap({ unitsPerDay: 0, known: false }, DEFAULTS)).toEqual({
            cap: 0,
            measured: false,
            unitsPerDay: null,
        });
        expect(volumeCap(null, { ...DEFAULTS, includeUnmeasured: true }).cap).toBe(Number.POSITIVE_INFINITY);
    });
});

describe('planTokenSpend', () => {
    const allCaps = (cap) => Object.fromEntries(OFFERS.map((o) => [o.itemHrid, { cap, measured: true }]));

    test('spends greedily by gold per token, in whole items', () => {
        // Fang 300/token, Brooch 250, Anchor 180, Essence 150
        const plan = planTokenSpend({ offers: OFFERS, tokens: 10_500, caps: allCaps(10_000) });
        const byName = Object.fromEntries(plan.rows.map((r) => [r.name, r]));
        expect(plan.rows.map((r) => r.name)).toEqual([
            'Kraken Fang',
            'Marksman Brooch',
            'Damaged Anchor',
            'Pirate Essence',
        ]);
        expect(byName['Kraken Fang'].quantity).toBe(3);
        expect(byName['Marksman Brooch'].quantity).toBe(0);
        expect(byName['Pirate Essence'].quantity).toBe(1500);
        expect(plan.spent).toBe(10_500);
        expect(plan.leftover).toBe(0);
        expect(plan.gold).toBe(3 * 900_000 + 1500 * 150);
        for (const row of plan.rows) expect(Number.isInteger(row.quantity)).toBe(true);
    });

    test('a volume cap moves the rest down the ranking', () => {
        const caps = allCaps(100);
        caps['/items/kraken_fang'] = { cap: 1, measured: true };
        caps['/items/pirate_essence'] = { cap: 200, measured: true };
        const plan = planTokenSpend({ offers: OFFERS, tokens: 10_500, caps });
        const byName = Object.fromEntries(plan.rows.map((r) => [r.name, r]));
        expect(byName['Kraken Fang']).toMatchObject({ quantity: 1, reason: 'volume' });
        expect(byName['Marksman Brooch']).toMatchObject({ quantity: 3, tokens: 6000 });
        expect(byName['Damaged Anchor']).toMatchObject({ quantity: 0, reason: 'tokens' });
        expect(byName['Pirate Essence']).toMatchObject({ quantity: 200, reason: 'volume' });
        expect(plan.spent).toBe(3000 + 6000 + 200);
        expect(plan.leftover).toBe(10_500 - 9200);
    });

    test('reports leftover tokens when every cap binds', () => {
        const plan = planTokenSpend({ offers: OFFERS, tokens: 50_000, caps: allCaps(1) });
        expect(plan.spent).toBe(1 + 2000 + 3000 + 2000);
        expect(plan.leftover).toBe(50_000 - 7001);
    });

    test('the essence takes leftovers only while it is worth something and within its cap', () => {
        const worthless = OFFERS.map((o) => (o.cost === 1 ? { ...o, netValue: 0 } : o));
        const plan = planTokenSpend({ offers: worthless, tokens: 3500, caps: allCaps(100) });
        const essence = plan.rows.find((r) => r.cost === 1);
        expect(essence).toMatchObject({ quantity: 0, reason: 'unprofitable' });
        expect(plan.leftover).toBe(500);
    });

    test('an unmeasured item plans nothing unless it was included, and is flagged', () => {
        const caps = allCaps(100);
        delete caps['/items/kraken_fang'];
        const excluded = planTokenSpend({ offers: OFFERS, tokens: 3000, caps });
        expect(excluded.rows.find((r) => r.name === 'Kraken Fang')).toMatchObject({
            quantity: 0,
            reason: 'no-volume',
            measured: false,
        });

        caps['/items/kraken_fang'] = { cap: Number.POSITIVE_INFINITY, measured: false };
        const included = planTokenSpend({ offers: OFFERS, tokens: 9000, caps });
        expect(included.rows.find((r) => r.name === 'Kraken Fang')).toMatchObject({
            quantity: 3,
            measured: false,
            reason: 'tokens',
        });
    });

    test('an item with no price is listed but never planned', () => {
        const offers = [
            ...OFFERS,
            { itemHrid: '/items/corsair_crest', name: 'Corsair Crest', cost: 2000, netValue: null },
        ];
        const plan = planTokenSpend({
            offers,
            tokens: 2000,
            caps: { ...allCaps(100), '/items/corsair_crest': { cap: 5, measured: true } },
        });
        expect(plan.rows.find((r) => r.name === 'Corsair Crest')).toMatchObject({ quantity: 0, reason: 'no-price' });
    });

    test('no tokens plans nothing', () => {
        const plan = planTokenSpend({ offers: OFFERS, tokens: 0, caps: allCaps(100) });
        expect(plan.spent).toBe(0);
        expect(plan.gold).toBe(0);
        expect(plan.rows.every((r) => r.quantity === 0)).toBe(true);
    });
});
