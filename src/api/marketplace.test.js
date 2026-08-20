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
            get: vi.fn(async () => null),
            set: vi.fn(async () => {}),
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

describe('MarketAPI fetch in-flight dedup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** A fetch response the API accepts, resolvable when the test says so */
    function deferredResponse() {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        fetch.mockImplementation(async () => {
            await gate;
            return { ok: true, json: async () => ({ marketData: { items: [] }, timestamp: 123 }) };
        });
        return () => release();
    }

    test('two concurrent callers share one network request', async () => {
        // The startup case: several features fetch behind nothing but an
        // isLoaded() check, and the endpoint rate-limits bursts
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const release = deferredResponse();

        const { default: marketAPI } = await import('./marketplace.js');

        const first = marketAPI.fetch();
        const second = marketAPI.fetch();
        release();
        const [a, b] = await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(a).toEqual({ items: [] });
        expect(b).toEqual({ items: [] });
    });

    test('a later fetch after the first settles is its own request', async () => {
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const release = deferredResponse();

        const { default: marketAPI } = await import('./marketplace.js');

        const first = marketAPI.fetch();
        release();
        await first;
        // No cache mock change: getCachedData still returns null, so this goes out again
        await marketAPI.fetch(true);

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('a force request behind a plain one waits it out, then refreshes — never in parallel', async () => {
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);

        const { default: marketAPI } = await import('./marketplace.js');

        // Track how many requests are ever airborne at once
        let active = 0;
        let peak = 0;
        fetch.mockImplementation(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 0));
            active -= 1;
            return { ok: true, json: async () => ({ marketData: { items: [] }, timestamp: 123 }) };
        });

        const plain = marketAPI.fetch();
        const forced = marketAPI.fetch(true);
        await Promise.all([plain, forced]);

        expect(fetch).toHaveBeenCalledTimes(2); // the force still refreshes...
        expect(peak).toBe(1); // ...but sequentially — never a burst
    });

    test('a failed shared fetch clears the slot so the next call retries', async () => {
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'boom' });

        const { default: marketAPI } = await import('./marketplace.js');

        const [a, b] = await Promise.all([marketAPI.fetch(), marketAPI.fetch()]);
        expect(a).toBeNull();
        expect(b).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);

        await marketAPI.fetch();
        expect(fetch).toHaveBeenCalledTimes(2);

        error.mockRestore();
        warn.mockRestore();
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
