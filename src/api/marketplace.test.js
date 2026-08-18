import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const createMocks = (isConnected) => {
    vi.doMock('../core/connection-state.js', () => ({
        default: {
            isConnected: vi.fn(() => isConnected),
        },
    }));

    const getJSON = vi.fn();
    vi.doMock('../core/storage.js', () => ({
        default: {
            getJSON,
            setJSON: vi.fn(),
        },
    }));

    const show = vi.fn();
    vi.doMock('../features/market/network-alert.js', () => ({
        default: {
            hide: vi.fn(),
            show,
        },
    }));

    // The band module is late-bound off window.Toolasha.Utils (Core loads
    // before Utils, so the API cannot import it) — tests install it the same
    // way the page does. Pass-through by default; swap `band.current` in.
    const band = { current: null };
    globalThis.window = globalThis.window || globalThis;
    globalThis.window.Toolasha = {
        Utils: {
            marketValues: {
                refreshMarketValues: vi.fn(),
                clampToBand: (price) => {
                    if (typeof price !== 'number' || !band.current) return price ?? null;
                    return Math.min(Math.max(price, band.current.min), band.current.max);
                },
            },
        },
    };

    return { getJSON, show, band };
};

describe('MarketAPI fetch', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('returns cached data when disconnected', async () => {
        // Arrange
        const cachedPayload = {
            marketData: { items: [] },
            timestamp: 123,
        };
        const { getJSON } = createMocks(false);
        getJSON.mockResolvedValue(cachedPayload);

        const { default: marketAPI } = await import('./marketplace.js');

        // Act
        const result = await marketAPI.fetch(true);

        // Assert
        expect(result).toEqual(cachedPayload.marketData);
        expect(getJSON).toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    test('returns null when disconnected without cache', async () => {
        // Arrange
        const { getJSON } = createMocks(false);
        getJSON.mockResolvedValue(null);

        const { default: marketAPI } = await import('./marketplace.js');

        // Act
        const result = await marketAPI.fetch(true);

        // Assert
        expect(result).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    test('surfaces a 403 rate-limit plainly and falls back instead of throwing', async () => {
        // Arrange: connected, the API returns a CloudFront rate-limit block, and
        // there is no cache to fall back to.
        const { getJSON, show } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        fetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });

        const { default: marketAPI } = await import('./marketplace.js');

        // Act
        const result = await marketAPI.fetch(true);

        // Assert: it does not throw, it names the rate-limit in the console, and
        // it shows a rate-limit-specific network alert rather than a generic one.
        expect(result).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'));
        expect(show).toHaveBeenCalledWith(expect.stringMatching(/rate-limited/i));

        warn.mockRestore();
        error.mockRestore();
    });
});

describe('MarketAPI getPrice bands', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('snapshot prices outside the tradable range are clamped to its edges', async () => {
        const { band } = createMocks(true);
        band.current = { min: 900, max: 1100 };
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 5000, b: 100 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1100, bid: 900 });
    });

    test('patched (write-through) prices are banded the same way', async () => {
        const { band } = createMocks(true);
        band.current = { min: 900, max: 1100 };
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = { '/items/x:0': { a: 5000, b: 100, timestamp: 2000 } };
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1100, bid: 900 });
    });

    test('a missing side stays null — the band never invents a price', async () => {
        const { band } = createMocks(true);
        band.current = { min: 900, max: 1100 };
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 1000, b: -1 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1000, bid: null });
    });

    test('without a band everything passes through untouched', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 5000, b: 100 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 5000, bid: 100 });
    });

    test('before the Utils bundle lands, prices pass through as they always did', async () => {
        createMocks(true);
        delete globalThis.window.Toolasha;
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 5000, b: 100 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 5000, bid: 100 });
    });
});

describe('MarketAPI getPriceTimestamp', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('reports the snapshot time when no fresher patch exists', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(1000);
    });

    test('a patch newer than the snapshot wins', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = { '/items/x:0': { a: 1, b: 2, timestamp: 2000 } };
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(2000);
    });

    test('a patch older than the snapshot is ignored', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 5000;
        marketAPI.pricePatchs = { '/items/x:0': { a: 1, b: 2, timestamp: 2000 } };
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(5000);
    });

    test('null when nothing has been fetched', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 0;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBeNull();
    });
});
