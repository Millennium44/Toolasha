import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ tickBuy: true, tickSell: true, band: null, september: false }));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => {
            if (key === 'profitCalc_patientTickBuy') return mocks.tickBuy;
            if (key === 'profitCalc_patientTickSell') return mocks.tickSell;
            return fallback;
        },
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
vi.mock('./server-gate.js', () => ({
    isMarketplacePatchLive: () => true,
    isSeptember2026MarketPatchLive: () => mocks.september,
}));

import {
    patientTickPrice,
    isPatientTickOn,
    patientTickSettingFor,
    PATIENT_TICK_SETTING_KEYS,
    PATIENT_TICK_BUY_SETTING,
    PATIENT_TICK_SELL_SETTING,
} from './patient-tick.js';

beforeEach(() => {
    mocks.tickBuy = true;
    mocks.tickSell = true;
    mocks.band = null;
    mocks.september = false;
});

describe('the per-side tick settings', () => {
    test('one key per side, listed together for listeners', () => {
        expect(PATIENT_TICK_BUY_SETTING).toBe('profitCalc_patientTickBuy');
        expect(PATIENT_TICK_SELL_SETTING).toBe('profitCalc_patientTickSell');
        expect(PATIENT_TICK_SETTING_KEYS).toEqual([PATIENT_TICK_BUY_SETTING, PATIENT_TICK_SELL_SETTING]);
        expect(patientTickSettingFor('buy')).toBe(PATIENT_TICK_BUY_SETTING);
        expect(patientTickSettingFor('sell')).toBe(PATIENT_TICK_SELL_SETTING);
        expect(patientTickSettingFor('average')).toBeNull();
    });

    test('isPatientTickOn reads only the side it is asked about', () => {
        mocks.tickBuy = true;
        mocks.tickSell = false;
        expect(isPatientTickOn('buy')).toBe(true);
        expect(isPatientTickOn('sell')).toBe(false);

        mocks.tickBuy = false;
        mocks.tickSell = true;
        expect(isPatientTickOn('buy')).toBe(false);
        expect(isPatientTickOn('sell')).toBe(true);

        expect(isPatientTickOn(undefined)).toBe(false);
    });

    test('the schema, the migration and the display label all name these same keys', async () => {
        // core/ cannot import this module, so config.js and settings-storage.js
        // repeat the literals; the schema is the one they must agree with
        const { settingsGroups } = await import('../core/settings-schema.js');
        const schema = Object.assign({}, ...Object.values(settingsGroups).map((group) => group.settings));
        for (const key of PATIENT_TICK_SETTING_KEYS) {
            expect(schema[key]).toMatchObject({ id: key, type: 'checkbox', default: false });
        }
        expect(schema.profitCalc_patientTick).toBeUndefined();
    });
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
        mocks.tickBuy = false;
        mocks.tickSell = false;
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100 })).toBe(1000);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900 })).toBe(1000);
    });

    test('the buy tick moves buys only, the sell tick sells only', () => {
        mocks.tickSell = false;
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100 })).toBe(1005);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900 })).toBe(1000);

        mocks.tickBuy = false;
        mocks.tickSell = true;
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100 })).toBe(1000);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900 })).toBe(998);
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

describe('patientTickPrice under the September 2026 market patch', () => {
    test('ticks by the new bin gap, five times wider for an enhanced item', () => {
        mocks.september = true;
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100 })).toBe(1004);
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900 })).toBe(996);
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1100, itemHrid: '/items/x', enhancementLevel: 4 })).toBe(
            1020
        );
        expect(patientTickPrice(1000, 'sell', 'ask', { bid: 900, itemHrid: '/items/x', enhancementLevel: 4 })).toBe(
            980
        );
    });

    test('a wider enhanced tick that would reach the other side stays put', () => {
        mocks.september = true;
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1010, enhancementLevel: 2 })).toBe(1000);
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1010 })).toBe(1004);
    });
});

describe('patientTickPrice against an off-grid book (pre-patch listings)', () => {
    test('ticks from an old-ladder price to the nearest new bin past it', () => {
        mocks.september = true;
        expect(patientTickPrice(1005, 'sell', 'ask', { bid: 900 })).toBe(1004);
        expect(patientTickPrice(1005, 'buy', 'bid', { ask: 1100 })).toBe(1008);
        expect(patientTickPrice(1003, 'sell', 'ask', { bid: 900, enhancementLevel: 2 })).toBe(1000);
    });

    test('an off-grid other side one new bin away still blocks the cross', () => {
        mocks.september = true;
        expect(patientTickPrice(1000, 'buy', 'bid', { ask: 1003 })).toBe(1000);
        expect(patientTickPrice(1005, 'sell', 'ask', { bid: 1004 })).toBe(1005);
    });
});
