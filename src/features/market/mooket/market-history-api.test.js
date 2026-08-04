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

const settings = vi.hoisted(() => ({ market_pooledHistory: true }));
vi.mock('../../../core/config.js', () => ({
    default: { getSetting: (key) => settings[key] === true },
}));

const { default: marketHistoryAPI, HISTORY_HOST } = await import('./market-history-api.js');

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
