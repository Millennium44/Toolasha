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

    return { getJSON, show };
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
