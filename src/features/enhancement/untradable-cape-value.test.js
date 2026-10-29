import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    capes: new Set(),
    baseCost: null,
    path: null,
    pathError: null,
    pathCalls: [],
    surfaceCalls: [],
}));

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
        return { bench: 'own' };
    },
}));

const { getUntradableCapeValue } = await import('./untradable-cape-value.js');

const CAPE = '/items/gatherer_cape';

beforeEach(() => {
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
