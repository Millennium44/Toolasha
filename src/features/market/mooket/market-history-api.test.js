/**
 * What the pooled-history client sends, and the one place it must not.
 *
 * Two directions leave this machine: a GET asking for an item's history, and a
 * WebSocket carrying the order books this client saw. The second is the one that
 * lands in somebody else's dataset, and a book observed on the test server is
 * not a cheap price — it is a wrong one, with nothing in it to say so.
 *
 * So the guard is tested from the outside: not "does the flag say false" but
 * "was a socket opened, was anything sent". A guard on the flag alone would
 * survive a refactor that opened the socket somewhere else.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ market_pooledHistory: true, market_historySource: 'mooket2' }));
vi.mock('../../../core/config.js', () => ({
    default: { getSetting: (key) => settings[key] },
}));

const { default: marketHistoryAPI, HISTORY_HOST, normaliseMooket1Rows } = await import('./market-history-api.js');

/** Every socket this test opened, so "none" can be asserted */
let sockets = [];

class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        this.sent = [];
        sockets.push(this);
    }
    addEventListener() {}
    close() {}
    send(payload) {
        this.sent.push(payload);
    }
}

const hadLocation = 'location' in globalThis;
const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;

/** Put the client on a host, as the page would */
function on(hostname) {
    globalThis.location = { hostname };
}

beforeEach(() => {
    sockets = [];
    settings.market_pooledHistory = true;
    settings.market_historySource = 'mooket2';
    globalThis.WebSocket = FakeSocket;
    globalThis.WebSocket.OPEN = 1;
    marketHistoryAPI.socket = null;
    marketHistoryAPI.notedTestServer = false;
    marketHistoryAPI.cache.clear();
});

afterEach(() => {
    marketHistoryAPI.disconnect();
    globalThis.WebSocket = originalWebSocket;
    if (hadLocation) globalThis.location = originalLocation;
    else delete globalThis.location;
    vi.restoreAllMocks();
});

describe('on the live server', () => {
    test('the reporting socket is opened and books are sent', () => {
        on('www.milkywayidle.com');

        marketHistoryAPI.connect();
        expect(sockets).toHaveLength(1);
        expect(sockets[0].url).toBe(`${HISTORY_HOST.replace(/^http/, 'ws')}/market/ws`);

        marketHistoryAPI.report({ marketItemOrderBooks: { '/items/cheese': {} } });
        expect(sockets[0].sent).toHaveLength(1);
        expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
            marketItemOrderBooks: { '/items/cheese': {} },
        });
    });

    test('contribution follows the selected source', () => {
        on('www.milkywayidle.com');

        marketHistoryAPI.connect();
        expect(sockets[0].url).toBe('wss://q7.nainai.eu.org/market/ws');

        // Switch source and report: the old socket is dropped and a new one opens
        // to the newly selected pool
        settings.market_historySource = 'mooket1';
        marketHistoryAPI.report({ marketItemOrderBooks: {} }); // closes the stale socket, reconnects
        marketHistoryAPI.report({ marketItemOrderBooks: { '/items/cheese': {} } }); // sends to the new one

        expect(sockets).toHaveLength(2);
        expect(sockets[1].url).toBe('wss://mooket.qi-e.top/market/ws');
        expect(sockets[0].sent).toHaveLength(0);
        expect(sockets[1].sent).toHaveLength(1);
    });

    test('the switch being off still stops everything', () => {
        on('www.milkywayidle.com');
        settings.market_pooledHistory = false;

        marketHistoryAPI.connect();
        marketHistoryAPI.report({ marketItemOrderBooks: {} });

        expect(sockets).toHaveLength(0);
    });
});

describe('on the test server', () => {
    test('no socket is opened, however many times connect is called', () => {
        on('test.milkywayidle.com');

        marketHistoryAPI.connect();
        marketHistoryAPI.connect();

        expect(sockets).toHaveLength(0);
        expect(marketHistoryAPI.socket).toBeNull();
    });

    test('reporting a book sends nothing and opens nothing', () => {
        on('test.milkywayidle.com');

        marketHistoryAPI.report({ marketItemOrderBooks: { '/items/cheese': {} } });
        marketHistoryAPI.report({ marketItemOrderBooks: { '/items/milk': {} } });

        expect(sockets).toHaveLength(0);
    });

    test('a socket left over from a live session is never sent to', () => {
        // Switching characters does not reload the page, so the socket outlives
        // the session that opened it
        on('www.milkywayidle.com');
        marketHistoryAPI.connect();
        expect(sockets).toHaveLength(1);

        on('test.milkywayidle.com');
        marketHistoryAPI.report({ marketItemOrderBooks: { '/items/cheese': {} } });

        expect(sockets[0].sent).toHaveLength(0);
    });

    test('it says so once, not once per order book', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        on('test.milkywayidle.com');

        marketHistoryAPI.connect();
        for (let i = 0; i < 20; i += 1) marketHistoryAPI.report({ marketItemOrderBooks: {} });

        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('[Mooket] test server — not sending data');
    });

    test('reading is left alone', async () => {
        // Nothing about a lookup pollutes the pool, and a test-server session
        // asking for live history gets live history
        on('test.milkywayidle.com');
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [{ time: 1, ask: 5 }] }));
        globalThis.fetch = fetchMock;

        const rows = await marketHistoryAPI.fetchHistory('/items/cheese', 0, 7);

        expect(rows).toEqual([{ time: 1, ask: 5 }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('/api/market/history');
    });
});

describe('history source', () => {
    beforeEach(() => {
        on('www.milkywayidle.com');
    });

    test('mooket II is the default and its rows pass through unchanged', async () => {
        const rows = [{ a: 5, b: 4, p: 4.5, v: 10, time: 1 }];
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => rows }));
        globalThis.fetch = fetchMock;

        const out = await marketHistoryAPI.fetchHistory('/items/cheese', 0, 7);

        expect(fetchMock.mock.calls[0][0]).toContain('/api/market/history');
        expect(out).toEqual(rows);
        expect(marketHistoryAPI.currentSource()).toMatchObject({ key: 'mooket2', hasVolume: true, avgLabel: 'Avg' });
    });

    test('an unrecognised source setting falls back to the default', () => {
        settings.market_historySource = 'no-such-pool';
        expect(marketHistoryAPI.currentSource().key).toBe('mooket2');
    });

    test('mooket I reads its own endpoint and is folded into the common row shape', async () => {
        settings.market_historySource = 'mooket1';
        const payload = {
            ask: [
                { time: 1, price: 10 },
                { time: 2, price: 12 },
            ],
            bid: [
                { time: 1, price: 8 },
                { time: 2, price: 9 },
            ],
        };
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
        globalThis.fetch = fetchMock;

        const out = await marketHistoryAPI.fetchHistory('/items/cheese', 0, 3);

        const url = fetchMock.mock.calls[0][0];
        expect(url).toContain('/market/item/history');
        expect(url).toContain(`time=${3 * 86400}`);
        expect(out).toEqual([
            { a: 10, b: 8, p: 9, v: 0, time: 1 },
            { a: 12, b: 9, p: 10.5, v: 0, time: 2 },
        ]);
        expect(marketHistoryAPI.currentSource()).toMatchObject({ key: 'mooket1', hasVolume: false, avgLabel: 'Mid' });
    });
});

describe('an answer that is not rows', () => {
    beforeEach(() => {
        on('www.milkywayidle.com');
    });

    test('a 200 carrying an error object is no answer, and is not remembered as one', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ error: 'rate limited' }) }));
        globalThis.fetch = fetchMock;

        expect(await marketHistoryAPI.fetchHistory('/items/cheese', 0, 7)).toBeNull();

        // Caching it would make the next five minutes of retries answer with the
        // same non-answer without asking the server again
        const rows = [{ a: 5, b: 4, p: 4.5, v: 10, time: 1 }];
        fetchMock.mockImplementation(async () => ({ ok: true, json: async () => rows }));
        expect(await marketHistoryAPI.fetchHistory('/items/cheese', 0, 7)).toEqual(rows);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('the fetch cache is bounded', () => {
    beforeEach(() => {
        on('www.milkywayidle.com');
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => [{ a: 1, b: 1, p: 1, v: 0, time: 1 }] }));
    });

    test('a session that browses hundreds of items does not hold all of them', async () => {
        for (let i = 0; i < 260; i += 1) {
            await marketHistoryAPI.fetchHistory(`/items/item_${i}`, 0, 7);
        }

        expect(marketHistoryAPI.cache.size).toBeLessThanOrEqual(200);
        // The newest answer is the one kept
        expect(marketHistoryAPI.cache.has('mooket2:/items/item_259:0:7')).toBe(true);
    });

    test('an expired entry is dropped rather than counted against the cap', async () => {
        vi.useFakeTimers();
        try {
            await marketHistoryAPI.fetchHistory('/items/old', 0, 7);
            vi.advanceTimersByTime(6 * 60 * 1000);
            await marketHistoryAPI.fetchHistory('/items/new', 0, 7);

            expect(marketHistoryAPI.cache.has('mooket2:/items/old:0:7')).toBe(false);
            expect(marketHistoryAPI.cache.has('mooket2:/items/new:0:7')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('normaliseMooket1Rows', () => {
    test('folds ask/bid series into rows with a midpoint and zero volume', () => {
        expect(normaliseMooket1Rows({ ask: [{ time: 1, price: 10 }], bid: [{ time: 1, price: 6 }] })).toEqual([
            { a: 10, b: 6, p: 8, v: 0, time: 1 },
        ]);
    });

    test('accepts the plural asks/bids key too', () => {
        expect(normaliseMooket1Rows({ asks: [{ time: 2, price: 4 }], bids: [{ time: 2, price: 2 }] })).toEqual([
            { a: 4, b: 2, p: 3, v: 0, time: 2 },
        ]);
    });

    test('a non-positive side is -1, and the midpoint uses the side that is there', () => {
        expect(normaliseMooket1Rows({ ask: [{ time: 1, price: 10 }], bid: [{ time: 1, price: -1 }] })).toEqual([
            { a: 10, b: -1, p: 10, v: 0, time: 1 },
        ]);
    });

    test('a moment with neither side quoted is dropped', () => {
        expect(
            normaliseMooket1Rows({
                ask: [
                    { time: 1, price: -1 },
                    { time: 2, price: 5 },
                ],
                bid: [
                    { time: 1, price: 0 },
                    { time: 2, price: 5 },
                ],
            })
        ).toEqual([{ a: 5, b: 5, p: 5, v: 0, time: 2 }]);
    });

    test('empty or malformed payloads produce no rows', () => {
        expect(normaliseMooket1Rows(null)).toEqual([]);
        expect(normaliseMooket1Rows({})).toEqual([]);
        // A quote with no timestamp cannot be placed on the axis, so it is dropped
        expect(normaliseMooket1Rows({ ask: [{ price: 5 }], bid: [{ price: 4 }] })).toEqual([]);
    });
});
