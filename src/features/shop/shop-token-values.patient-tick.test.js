import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    tickOn: false,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            shopItemDetailMap: {
                a: {
                    itemHrid: '/items/essence',
                    costs: [{ itemHrid: '/items/chimerical_token', count: 10 }],
                    outputCount: 1,
                },
            },
            labyrinthShopItemDetailMap: {},
            itemDetailMap: {},
        }),
        getItemDetails: () => null,
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid, { mode } = {}) => (hrid === '/items/essence' ? (mode === 'bid' ? 800 : 1000) : null),
    getItemPriceInfo: (hrid, { mode } = {}) => ({ price: mode === 'bid' ? 800 : 1000, source: 'book' }),
    getItemPrices: () => ({ ask: 1000, bid: 800 }),
}));
// The patient sell tick: one coin under the ask, on a live ask only
vi.mock('../../utils/patient-tick.js', () => ({
    PATIENT_TICK_SETTING_KEYS: ['profitCalc_patientTickBuy', 'profitCalc_patientTickSell'],
    isPatientTickOn: (side) => side === 'sell' && mocks.tickOn,
    patientTickPrice: (price) => price - 1,
}));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.96 }));
vi.mock('../../utils/untradable-cape-cost.js', () => ({ getUntradableCapeBaseCost: () => null }));

const { shopLineValues } = await import('./shop-token-values-logic.js');
const { tokenPriceOf } = await import('../../utils/token-valuation.js');

const CHIM = '/items/chimerical_token';

beforeEach(() => {
    mocks.settings = { profitCalc_pricingMode: 'hybrid', expectedValue_respectPricingMode: true };
    mocks.tickOn = false;
});

describe('badges quote the token valuation price', () => {
    const badge = () => shopLineValues(CHIM)[0].perToken;
    const valuation = () =>
        (tokenPriceOf('profitCalc_pricingMode', 'expectedValue_respectPricingMode')('/items/essence') * 0.96) / 10;

    test('with the patient sell tick on and respect-mode on, the badge is the valuation figure, tick included', () => {
        mocks.tickOn = true;
        expect(badge()).toBeCloseTo(valuation(), 10);
        // The ask less the tick, not the bare ask
        expect(badge()).toBeCloseTo((999 * 0.96) / 10, 10);
    });

    test('flipping the tick off changes the figure the same way the valuation changes', () => {
        mocks.tickOn = true;
        const withTick = badge();
        mocks.tickOn = false;
        expect(badge()).toBeCloseTo(valuation(), 10);
        expect(badge()).toBeGreaterThan(withTick);
    });

    test('with respect-mode off the bid is quoted and no tick applies', () => {
        mocks.tickOn = true;
        mocks.settings.expectedValue_respectPricingMode = false;
        expect(badge()).toBeCloseTo((800 * 0.96) / 10, 10);
        expect(badge()).toBeCloseTo(valuation(), 10);
    });
});
