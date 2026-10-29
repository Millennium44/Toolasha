import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    items: {},
    settings: {},
    prices: {},
    priceCalls: [],
}));

vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback },
}));
vi.mock('../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => mocks.items[hrid] ?? null },
}));
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid, options) => {
        mocks.priceCalls.push([hrid, options]);
        return mocks.prices[hrid] ?? null;
    },
}));

const {
    isUntradableCape,
    isRefinedCape,
    unrefinedCapeOf,
    getCapeBaseValue,
    getCapeBaseValueMode,
    describeAssumedCape,
} = await import('./untradable-cape.js');

const back = { equipmentDetail: { type: '/equipment_types/back' } };

beforeEach(() => {
    mocks.settings = {};
    mocks.prices = { '/items/mirror_of_protection': 5_000_000 };
    mocks.priceCalls = [];
    mocks.items = {
        '/items/gatherer_cape': { name: 'Gatherer Cape', ...back },
        '/items/gatherer_cape_refined': { name: 'Gatherer Cape (Refined)', ...back },
        '/items/chimerical_quiver': { name: 'Chimerical Quiver', ...back },
        '/items/enchanted_cloak': { name: 'Enchanted Cloak', ...back },
        '/items/sinister_cape_refined': { name: 'Sinister Cape (Refined)', ...back },
        '/items/tradable_cloak': { name: 'Tradable Cloak', isTradable: true, ...back },
        '/items/lucky_charm': { name: 'Charm', equipmentDetail: { type: '/equipment_types/charm' } },
        '/items/cheese': { name: 'Cheese', isTradable: true },
    };
});

describe('isUntradableCape', () => {
    test('skilling capes, the quiver, the cloak and their refined versions are untradable capes', () => {
        for (const hrid of [
            '/items/gatherer_cape',
            '/items/gatherer_cape_refined',
            '/items/chimerical_quiver',
            '/items/enchanted_cloak',
            '/items/sinister_cape_refined',
        ]) {
            expect(isUntradableCape(hrid)).toBe(true);
        }
    });

    test('a tradable back piece, an untradable piece in another slot and an ordinary item are not', () => {
        expect(isUntradableCape('/items/tradable_cloak')).toBe(false);
        expect(isUntradableCape('/items/lucky_charm')).toBe(false);
        expect(isUntradableCape('/items/cheese')).toBe(false);
    });

    test('an item the data does not know, or no item at all, is not a cape', () => {
        expect(isUntradableCape('/items/unknown_cape')).toBe(false);
        expect(isUntradableCape('')).toBe(false);
        expect(isUntradableCape(null)).toBe(false);
        expect(isUntradableCape(undefined)).toBe(false);
    });
});

describe('refined helpers', () => {
    test('a refined hrid is recognized and maps back to its unrefined cape', () => {
        expect(isRefinedCape('/items/gatherer_cape_refined')).toBe(true);
        expect(isRefinedCape('/items/gatherer_cape')).toBe(false);
        expect(unrefinedCapeOf('/items/gatherer_cape_refined')).toBe('/items/gatherer_cape');
        expect(unrefinedCapeOf('/items/gatherer_cape')).toBe('/items/gatherer_cape');
    });
});

describe('getCapeBaseValue', () => {
    test('defaults to nothing', () => {
        expect(getCapeBaseValueMode()).toBe('zero');
        expect(getCapeBaseValue()).toBe(0);
        expect(mocks.priceCalls).toHaveLength(0);
    });

    test('on the mirror setting it is the Mirror of Protection buy price, on the side and context asked', () => {
        mocks.settings.untradableCapeBaseValue = 'mirror';
        expect(getCapeBaseValueMode()).toBe('mirror');
        expect(getCapeBaseValue()).toBe(5_000_000);
        expect(getCapeBaseValue({ context: 'networth', mode: 'bid' })).toBe(5_000_000);
        expect(mocks.priceCalls[1]).toEqual([
            '/items/mirror_of_protection',
            { context: 'networth', side: 'buy', mode: 'bid' },
        ]);
    });

    test('an unpriced mirror is 0, never a guess; an unknown setting value reads as nothing', () => {
        mocks.settings.untradableCapeBaseValue = 'mirror';
        delete mocks.prices['/items/mirror_of_protection'];
        expect(getCapeBaseValue()).toBe(0);
        mocks.settings.untradableCapeBaseValue = 'something-else';
        expect(getCapeBaseValueMode()).toBe('zero');
    });
});

describe('describeAssumedCape', () => {
    const format = (n) => String(n);

    test('names the cape, its level and the value, and says it is untaxed', () => {
        const text = describeAssumedCape({ enhancementLevel: 7, value: 123, partial: false }, 'Gatherer Cape', format);
        expect(text).toContain('Gatherer Cape +7');
        expect(text).toContain('123');
        expect(text).toContain('never taxed');
        expect(text).not.toContain('floor');
    });

    test('a figure built on a base of nothing says it is a floor', () => {
        expect(describeAssumedCape({ enhancementLevel: 0, value: 5, partial: true }, 'Cape', format)).toContain(
            'floor'
        );
    });
});
