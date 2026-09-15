import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ tick: true, band: null }));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'profitCalc_patientTick' ? mocks.tick : fallback),
    },
}));

vi.mock('./market-values.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        nextPriceUp: actual.nextPriceUp,
        nextPriceDown: actual.nextPriceDown,
        clampToBand: (price) => (mocks.band ? Math.min(Math.max(price, mocks.band.min), mocks.band.max) : price),
    };
});

vi.mock('../core/data-manager.js', () => ({ default: {} }));

import { patientTickPrice, isPatientTickEnabled } from './patient-tick.js';

beforeEach(() => {
    mocks.tick = true;
    mocks.band = null;
});

describe('patientTickPrice', () => {
    test('a buy at the bid moves one tick up, a sell at the ask one tick down', () => {
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100 })).toBe(1005);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900 })).toBe(998);
    });

    test('instant sides and averages are untouched', () => {
        expect(patientTickPrice(1000, 'buy', 'ask', { bid: 900 })).toBe(1000);
        expect(patientTickPrice(1000, 'sell', 'bid', { ask: 1100 })).toBe(1000);
        expect(patientTickPrice(1000, 'buy', 'average')).toBe(1000);
    });

    test('off, nothing moves', () => {
        mocks.tick = false;
        expect(isPatientTickEnabled()).toBe(false);
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100 })).toBe(1000);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900 })).toBe(1000);
    });

    test('the tick never crosses the spread', () => {
        // One tick above 1000 is 1005: equal to the ask would fill instantly
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1005 })).toBe(1000);
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1010 })).toBe(1005);
        // One tick below 1000 is 998
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 998 })).toBe(1000);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 996 })).toBe(998);
    });

    test('a missing other side (absent, 0 or -1) is no bound', () => {
        expect(patientTickPrice(1000, 'buy', 'bid', {})).toBe(1005);
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: -1 })).toBe(1005);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 0 })).toBe(998);
    });

    test('a sell at 1 has nowhere lower to go', () => {
        expect(patientTickPrice(1, 'sell', 'ask', {})).toBe(1);
    });

    test('re-clamped into the tradable range when an item is named', () => {
        mocks.band = { min: 900, max: 1000 };
        expect(patientTickPrice(1000, 'buy', 'bid', { itemHrid: '/items/x' })).toBe(1000);
        mocks.band = { min: 1000, max: 1200 };
        expect(patientTickPrice(1000, 'sell', 'ask', { itemHrid: '/items/x' })).toBe(1000);
        // No hrid, no clamp
        expect(patientTickPrice(1000, 'sell', 'ask', {})).toBe(998);
    });

    test('an unpriced quote passes straight through', () => {
        expect(patientTickPrice(null, 'buy', 'bid')).toBeNull();
        expect(patientTickPrice(0, 'buy', 'bid')).toBe(0);
    });
});
