import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    capes: new Set(),
    baseCost: null,
    path: null,
    pathError: null,
    pathCalls: [],
    surfaceCalls: [],
    params: { bench: 'own' },
    priceVersion: 1,
    stamp: 'a',
    characterId: 'c1',
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        get priceVersion() {
            return mocks.priceVersion;
        },
        liveSourced: false,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => mocks.characterId } }));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({ pricingStamp: () => mocks.stamp }));

vi.mock('../../utils/untradable-cape.js', () => ({ isUntradableCape: (hrid) => mocks.capes.has(hrid) }));
vi.mock('../../utils/untradable-cape-cost.js', () => ({ getUntradableCapeBaseCost: () => mocks.baseCost }));
vi.mock('./tooltip-enhancement.js', () => ({
    calculateEnhancementPath: (...args) => {
        mocks.pathCalls.push(args);
        if (mocks.pathError) throw mocks.pathError;
        return mocks.path;
    },
}));
vi.mock('./enhancement-params-source.js', () => ({
    enhancementParamsFor: (surface, hrid) => {
        mocks.surfaceCalls.push([surface, hrid]);
        return mocks.params;
    },
}));

const { getUntradableCapeValue, clearUntradableCapeValueCache } = await import('./untradable-cape-value.js');

const CAPE = '/items/gatherer_cape';

beforeEach(() => {
    clearUntradableCapeValueCache();
    mocks.params = { bench: 'own' };
    mocks.priceVersion = 1;
    mocks.stamp = 'a';
    mocks.characterId = 'c1';
    mocks.capes = new Set([CAPE]);
    mocks.baseCost = { value: 1000, partial: false };
    mocks.path = { optimalStrategy: { totalCost: 9000 }, pricesPartial: false, inputsPartial: false };
    mocks.pathError = null;
    mocks.pathCalls = [];
    mocks.surfaceCalls = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getUntradableCapeValue', () => {
    test('anything that is not an untradable cape has no cape value', () => {
        expect(getUntradableCapeValue('/items/cheese', 0)).toBeNull();
        expect(getUntradableCapeValue('/items/cheese', 5)).toBeNull();
    });

    test('+0 is the base cost, with no enhancement path run', () => {
        expect(getUntradableCapeValue(CAPE, 0)).toEqual({ value: 1000, partial: false });
        expect(mocks.pathCalls).toHaveLength(0);
    });

    test('+N is the enhancement path, run on the character’s own bench', () => {
        expect(getUntradableCapeValue(CAPE, 7)).toEqual({ value: 9000, partial: false });
        expect(mocks.surfaceCalls).toEqual([['valuation', CAPE]]);
        expect(mocks.pathCalls[0].slice(0, 3)).toEqual([CAPE, 7, { bench: 'own' }]);
        expect(mocks.pathCalls[0][3]).toEqual({ priceContext: 'profit' });
    });

    test('a path whose only unpriced input is the assumed base is its run cost, flagged as a floor', () => {
        mocks.path = {
            optimalStrategy: { totalCost: 4000 },
            pricesPartial: true,
            pricesPartialOnlyByAssumedBase: true,
            inputsPartial: true,
        };
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: 4000, partial: true });
    });

    test('a path with an unpriced material is not a value: null, flagged, never the partial cost', () => {
        mocks.path = { optimalStrategy: { totalCost: 4000 }, pricesPartial: true, inputsPartial: false };
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: null, partial: true });
    });

    test('a selected input that is itself a partial bill flags an otherwise usable path', () => {
        mocks.path = { optimalStrategy: { totalCost: 4000 }, pricesPartial: false, inputsPartial: true };
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: 4000, partial: true });
    });

    test('no path, a zero cost or a throwing path is unvalued, not free', () => {
        mocks.path = null;
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: null, partial: true });
        mocks.path = { optimalStrategy: { totalCost: 0 }, pricesPartial: false };
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: null, partial: true });
        mocks.pathError = new Error('boom');
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: null, partial: true });
    });

    test('a second call with the same inputs does not run the path again, and keeps the flags', () => {
        mocks.path = { optimalStrategy: { totalCost: 4000 }, pricesPartial: false, inputsPartial: true };
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: 4000, partial: true });
        mocks.path = { optimalStrategy: { totalCost: 1 }, pricesPartial: false };
        expect(getUntradableCapeValue(CAPE, 3)).toEqual({ value: 4000, partial: true });
        expect(mocks.pathCalls).toHaveLength(1);
        // the caller cannot corrupt the held figure
        getUntradableCapeValue(CAPE, 3).value = 5;
        expect(getUntradableCapeValue(CAPE, 3).value).toBe(4000);
    });

    test('an unvalued result is held too, and a throw is not', () => {
        mocks.path = null;
        getUntradableCapeValue(CAPE, 3);
        getUntradableCapeValue(CAPE, 3);
        expect(mocks.pathCalls).toHaveLength(1);
        mocks.pathError = new Error('boom');
        getUntradableCapeValue(CAPE, 4);
        getUntradableCapeValue(CAPE, 4);
        expect(mocks.pathCalls).toHaveLength(3);
    });

    test.each([
        ['level', () => getUntradableCapeValue(CAPE, 4)],
        ['price context', () => getUntradableCapeValue(CAPE, 3, { context: 'networth' })],
        ['forced ask', () => getUntradableCapeValue(CAPE, 3, { mode: 'ask' })],
        ['another cape', () => getUntradableCapeValue('/items/other_cape', 3)],
        [
            'bench params',
            () => {
                mocks.params = { bench: 'other' };
                return getUntradableCapeValue(CAPE, 3);
            },
        ],
        [
            'market prices',
            () => {
                mocks.priceVersion = 2;
                return getUntradableCapeValue(CAPE, 3);
            },
        ],
        [
            'pricing stamp (modes, cape setting, custom price, value map)',
            () => {
                mocks.stamp = 'b';
                return getUntradableCapeValue(CAPE, 3);
            },
        ],
        [
            'character',
            () => {
                mocks.characterId = 'c2';
                return getUntradableCapeValue(CAPE, 3);
            },
        ],
    ])('a changed %s recomputes', (_name, change) => {
        mocks.capes.add('/items/other_cape');
        getUntradableCapeValue(CAPE, 3);
        change();
        expect(mocks.pathCalls).toHaveLength(2);
    });

    test('clearUntradableCapeValueCache forces a recompute', () => {
        getUntradableCapeValue(CAPE, 3);
        clearUntradableCapeValueCache();
        getUntradableCapeValue(CAPE, 3);
        expect(mocks.pathCalls).toHaveLength(2);
    });

    test('the net worth context and a forced ask reach the path as its price context', () => {
        getUntradableCapeValue(CAPE, 3, { context: 'networth' });
        getUntradableCapeValue(CAPE, 3, { mode: 'ask' });
        expect(mocks.pathCalls[0][3]).toEqual({ priceContext: 'networth' });
        expect(mocks.pathCalls[1][3]).toEqual({ priceContext: 'ask' });
    });

    test('an unvalued +0 base cost passes through as unvalued', () => {
        mocks.baseCost = { value: null, partial: true };
        expect(getUntradableCapeValue(CAPE, 0)).toEqual({ value: null, partial: true });
    });
});
