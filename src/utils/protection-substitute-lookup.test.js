import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/data-manager.js', () => ({
    default: { getInitClientData: vi.fn() },
}));
vi.mock('../features/market/expected-value-calculator.js', () => ({
    default: { getDropPriceInfo: vi.fn() },
}));

const { default: dataManager } = await import('../core/data-manager.js');
const { default: expectedValueCalculator } = await import('../features/market/expected-value-calculator.js');
const { isProtectionSubstitute, suggestProtectionSubstituteProxyPrice } =
    await import('./protection-substitute-lookup.js');

beforeEach(() => {
    vi.clearAllMocks();
    dataManager.getInitClientData.mockReturnValue({
        itemDetailMap: {
            '/items/sinister_cape': {
                protectionItemHrids: ['/items/chimerical_quiver', '/items/enchanted_cloak'],
            },
            '/items/enchanted_cloak': {
                protectionItemHrids: ['/items/chimerical_quiver', '/items/sinister_cape'],
            },
            '/items/mirror_of_protection': {},
        },
    });
});

describe('isProtectionSubstitute', () => {
    test("true for an item appearing in some other item's protectionItemHrids", () => {
        expect(isProtectionSubstitute('/items/chimerical_quiver')).toBe(true);
    });

    test('false for an item that is not listed as a protection substitute anywhere', () => {
        expect(isProtectionSubstitute('/items/jade')).toBe(false);
    });

    test('false when game data is unavailable', () => {
        dataManager.getInitClientData.mockReturnValue(null);
        expect(isProtectionSubstitute('/items/chimerical_quiver')).toBe(false);
    });
});

describe('suggestProtectionSubstituteProxyPrice', () => {
    test("returns the universal protection item's price and hrid for a known substitute", () => {
        expectedValueCalculator.getDropPriceInfo.mockReturnValue({ value: 192000, needsTax: true });

        const result = suggestProtectionSubstituteProxyPrice('/items/chimerical_quiver');

        expect(result).toEqual({ price: 192000, viaItemHrid: '/items/mirror_of_protection' });
        expect(expectedValueCalculator.getDropPriceInfo).toHaveBeenCalledWith('/items/mirror_of_protection');
    });

    test('returns null for an item that is not a known protection substitute', () => {
        const result = suggestProtectionSubstituteProxyPrice('/items/jade');

        expect(result).toBeNull();
        expect(expectedValueCalculator.getDropPriceInfo).not.toHaveBeenCalled();
    });

    test('returns null when the universal protection item itself has no price data', () => {
        expectedValueCalculator.getDropPriceInfo.mockReturnValue({ value: null, needsTax: false });

        expect(suggestProtectionSubstituteProxyPrice('/items/chimerical_quiver')).toBeNull();
    });
});
