/**
 * Every reader of the net-worth enhancement cost cache validates it the same way: against the book
 * and against the pricing stamp (modes, base-crafting setting, custom prices).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ stamp: 'a', marketData: { x: [{ a: 1, b: 1 }] }, hashes: 0 }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'alice', on: () => {} },
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        get marketData() {
            return state.marketData;
        },
    },
}));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({ pricingStamp: () => state.stamp }));

const networthCache = (await import('./networth-cache.js')).default;
const { validateNetworthCache } = await import('./networth-cache-validation.js');

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 12, 0, 0));
    state.stamp = 'a';
    networthCache.clear();
    validateNetworthCache();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('validateNetworthCache', () => {
    test('a changed stamp (a custom price, the crafting setting, a mode) empties the cache', () => {
        networthCache.set('/items/sword', 10, 5000);
        validateNetworthCache();
        expect(networthCache.get('/items/sword', 10)).toBe(5000);

        state.stamp = 'b';
        validateNetworthCache();
        expect(networthCache.get('/items/sword', 10)).toBeNull();
    });

    test('the badge path trusts a check made moments ago, but never past a changed stamp', () => {
        networthCache.set('/items/sword', 10, 5000);
        const spy = vi.spyOn(networthCache, 'checkAndInvalidate');

        validateNetworthCache({ force: false });
        expect(spy).not.toHaveBeenCalled();

        state.stamp = 'b';
        validateNetworthCache({ force: false });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(networthCache.get('/items/sword', 10)).toBeNull();

        vi.advanceTimersByTime(3000);
        validateNetworthCache({ force: false });
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
