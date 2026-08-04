/**
 * Tests for Pricing Helper Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
    },
}));

const { selectPrice } = await import('./pricing-helper.js');

describe('selectPrice', () => {
    beforeEach(() => {
        settings.values = {};
    });

    test('returns 0 for missing price data', () => {
        expect(selectPrice(null)).toBe(0);
        expect(selectPrice(undefined)).toBe(0);
    });

    test('uses bid when mode is conservative', () => {
        settings.values['profitCalc_pricingMode'] = 'conservative';
        expect(selectPrice({ bid: 100, ask: 120 })).toBe(100);
    });

    test('uses bid when mode is patientBuy', () => {
        settings.values['profitCalc_pricingMode'] = 'patientBuy';
        expect(selectPrice({ bid: 100, ask: 120 })).toBe(100);
    });

    test('uses ask when mode is hybrid', () => {
        settings.values['profitCalc_pricingMode'] = 'hybrid';
        expect(selectPrice({ bid: 100, ask: 120 })).toBe(120);
    });

    test('uses ask when mode is optimistic', () => {
        settings.values['profitCalc_pricingMode'] = 'optimistic';
        expect(selectPrice({ bid: 100, ask: 120 })).toBe(120);
    });

    test('ignores pricing mode and always uses bid when respectPricingMode is false', () => {
        settings.values['profitCalc_pricingMode'] = 'hybrid';
        settings.values['expectedValue_respectPricingMode'] = false;
        expect(selectPrice({ bid: 100, ask: 120 })).toBe(100);
    });

    test('falls back to 0 for a missing bid/ask value', () => {
        settings.values['profitCalc_pricingMode'] = 'conservative';
        expect(selectPrice({ ask: 120 })).toBe(0);

        settings.values['profitCalc_pricingMode'] = 'hybrid';
        expect(selectPrice({ bid: 100 })).toBe(0);
    });

    test('respects custom setting keys', () => {
        settings.values['custom_mode'] = 'hybrid';
        settings.values['custom_respect'] = true;
        expect(selectPrice({ bid: 100, ask: 120 }, 'custom_mode', 'custom_respect')).toBe(120);
    });

    test('defaults to conservative (bid) when mode setting is absent', () => {
        expect(selectPrice({ bid: 100, ask: 120 })).toBe(100);
    });
});
