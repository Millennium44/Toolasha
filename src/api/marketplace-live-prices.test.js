import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

describe('MarketAPI live-server prices on the test server', () => {
    const MIRROR_KEY = 'Toolasha_marketAPI_livePrices';
    const TEST_URL = 'https://test.milkywayidle.com/game_data/marketplace.json';
    const LIVE_URL = 'https://www.milkywayidle.com/game_data/marketplace.json';
    const hadLocation = 'location' in globalThis;
    const originalLocation = globalThis.location;
    let store;
    let fetchMock;

    const payload = (ask) => ({
        marketData: { '/items/cheese': { 0: { a: ask, b: ask - 1 } } },
        timestamp: Math.floor(Date.now() / 1000),
    });

    const load = async (origin) => {
        globalThis.location = { origin, hostname: new URL(origin).hostname };
        vi.resetModules();
        vi.doMock('../core/connection-state.js', () => ({ default: { isConnected: () => true } }));
        vi.doMock('../features/market/network-alert.js', () => ({ default: { hide: vi.fn(), show: vi.fn() } }));
        vi.doMock('../core/storage.js', () => ({
            default: {
                get: vi.fn(async (key) => store.get(key) ?? null),
                getJSON: vi.fn(async (key, _s, fallback) => (store.has(key) ? store.get(key) : fallback)),
                set: vi.fn(async (key, value) => void store.set(key, value)),
                setJSON: vi.fn(async (key, value) => void store.set(key, value)),
            },
        }));
        const { default: marketAPI } = await import('./marketplace.js');
        return marketAPI;
    };

    beforeEach(() => {
        store = new Map();
        fetchMock = vi.fn(async (url) => ({
            ok: true,
            json: async () => payload(url === LIVE_URL ? 500 : 100),
        }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (hadLocation) globalThis.location = originalLocation;
        else delete globalThis.location;
    });

    test('on the test server with the setting off, the test copy is read', async () => {
        const marketAPI = await load('https://test.milkywayidle.com');
        await marketAPI.fetch(true);
        expect(fetchMock).toHaveBeenCalledWith(TEST_URL);
        expect(marketAPI.liveSourced).toBe(false);
    });

    test('on the test server with the setting on, the live copy is read', async () => {
        store.set(MIRROR_KEY, true);
        const marketAPI = await load('https://test.milkywayidle.com');
        await marketAPI.fetch(true);
        expect(fetchMock).toHaveBeenCalledWith(LIVE_URL);
        expect(marketAPI.liveSourced).toBe(true);
        expect(marketAPI.getPrice('/items/cheese').ask).toBe(500);
    });

    test('the CN test server reads the CN live copy', async () => {
        store.set(MIRROR_KEY, true);
        const marketAPI = await load('https://test.milkywayidlecn.com');
        await marketAPI.fetch(true);
        expect(fetchMock).toHaveBeenCalledWith('https://www.milkywayidlecn.com/game_data/marketplace.json');
    });

    test('on www the setting is ignored', async () => {
        store.set(MIRROR_KEY, true);
        const marketAPI = await load('https://www.milkywayidle.com');
        await marketAPI.fetch(true);
        expect(fetchMock).toHaveBeenCalledWith(LIVE_URL);
        expect(marketAPI.liveSourced).toBe(false);
        expect(store.has('Toolasha_marketAPI_json')).toBe(true);
        expect(store.has('Toolasha_marketAPI_json_live')).toBe(false);
    });

    test('the two sources never share a cache', async () => {
        const first = await load('https://test.milkywayidle.com');
        await first.fetch(true);
        expect(store.has('Toolasha_marketAPI_json')).toBe(true);
        expect(store.has('Toolasha_marketAPI_json_live')).toBe(false);

        // Setting turned on and the page reloaded: the fresh test-keyed cache must not be served
        store.set(MIRROR_KEY, true);
        fetchMock.mockClear();
        const second = await load('https://test.milkywayidle.com');
        await second.fetch();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(LIVE_URL);
        expect(second.getPrice('/items/cheese').ask).toBe(500);
        expect(store.get('Toolasha_marketAPI_json').marketData['/items/cheese'][0].a).toBe(100);
        expect(store.get('Toolasha_marketAPI_json_live').marketData['/items/cheese'][0].a).toBe(500);

        // And back off: the test copy is still its own, served from cache with no request
        store.set(MIRROR_KEY, false);
        fetchMock.mockClear();
        const third = await load('https://test.milkywayidle.com');
        await third.fetch();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(third.getPrice('/items/cheese').ask).toBe(100);
    });

    test('flipping the setting mid-session drops the other source from memory', async () => {
        const marketAPI = await load('https://test.milkywayidle.com');
        await marketAPI.fetch(true);
        marketAPI.updatePrices([{ itemHrid: '/items/cheese', enhancementLevel: 0, ask: 90, bid: 80 }]);
        store.set(MIRROR_KEY, true);
        await marketAPI.fetch(true);
        expect(marketAPI.getPrice('/items/cheese')).toMatchObject({ ask: 500, bid: 499 });
    });

    test('test-server order-book patches are not applied while live-sourced', async () => {
        store.set(MIRROR_KEY, true);
        const marketAPI = await load('https://test.milkywayidle.com');
        await marketAPI.fetch(true);
        marketAPI.updatePrices([{ itemHrid: '/items/cheese', enhancementLevel: 0, ask: 90, bid: 80 }], {
            pageOrderBook: true,
        });
        expect(marketAPI.getPrice('/items/cheese').ask).toBe(500);
        expect(Object.keys(store.get('Toolasha_marketAPI_patches_live') ?? {})).toEqual([]);
        expect(store.has('Toolasha_marketAPI_patches')).toBe(false);
    });

    test('order-book patches still apply when not live-sourced', async () => {
        const marketAPI = await load('https://test.milkywayidle.com');
        await marketAPI.fetch(true);
        marketAPI.updatePrices([{ itemHrid: '/items/cheese', enhancementLevel: 0, ask: 90, bid: 80 }], {
            pageOrderBook: true,
        });
        expect(marketAPI.getPrice('/items/cheese').ask).toBe(90);
    });
});
