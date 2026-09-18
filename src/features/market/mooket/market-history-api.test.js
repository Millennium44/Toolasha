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
    marketHistoryAPI.consecutiveFailures = 0;
    marketHistoryAPI.cooldownUntil = 0;
    marketHistoryAPI.cooldownStreak = 0;
    marketHistoryAPI.lastFailureAt = 0;
    marketHistoryAPI.backoffSourceKey = null;
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

describe('the shared cool-down', () => {
    // The refusal this guards against arrives with no CORS headers, so it never
    // reaches `response.ok` — the fetch promise itself rejects, same as any
    // other network failure. That opacity is exactly why the module cannot key
    // off a status code and has to count failures instead.
    function refusal() {
        return vi.fn(async () => {
            throw new TypeError('NetworkError when attempting to fetch resource.');
        });
    }

    beforeEach(() => {
        on('www.milkywayidle.com');
    });

    test('a refusal alone does not trip it, but a second one in a row does', async () => {
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        expect(await marketHistoryAPI.fetchHistory('/items/a', 0, 7)).toBeNull();
        expect(marketHistoryAPI.cooldownUntil).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        expect(await marketHistoryAPI.fetchHistory('/items/b', 0, 7)).toBeNull();
        expect(marketHistoryAPI.cooldownUntil).toBeGreaterThan(Date.now());
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('while it is in force, no further fetches are issued and every lookup answers null', async () => {
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // A pool of unrelated items asked about while the cool-down holds
        const results = await Promise.all(
            ['c', 'd', 'e'].map((letter) => marketHistoryAPI.fetchHistory(`/items/${letter}`, 0, 7))
        );

        expect(results).toEqual([null, null, null]);
        expect(fetchMock).toHaveBeenCalledTimes(2); // no new requests went out
    });

    test('it expires, and a normal lookup afterwards resumes fetching', async () => {
        vi.useFakeTimers();
        try {
            const fetchMock = refusal();
            globalThis.fetch = fetchMock;

            await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
            await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it
            expect(fetchMock).toHaveBeenCalledTimes(2);

            const cooldownMs = marketHistoryAPI.cooldownUntil - Date.now();
            vi.advanceTimersByTime(cooldownMs + 1);

            const rows = [{ a: 5, b: 4, p: 4.5, v: 10, time: 1 }];
            fetchMock.mockImplementation(async () => ({ ok: true, json: async () => rows }));

            expect(await marketHistoryAPI.fetchHistory('/items/c', 0, 7)).toEqual(rows);
            expect(fetchMock).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a success resets the failure count, so a single later refusal does not trip it', async () => {
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;
        await marketHistoryAPI.fetchHistory('/items/a', 0, 7); // one failure, not tripped

        const rows = [{ a: 5, b: 4, p: 4.5, v: 10, time: 1 }];
        fetchMock.mockImplementation(async () => ({ ok: true, json: async () => rows }));
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // succeeds, clears the count

        fetchMock.mockImplementation(refusal());
        await marketHistoryAPI.fetchHistory('/items/c', 0, 7); // one failure again

        expect(marketHistoryAPI.cooldownUntil).toBe(0);
    });

    test('repeated cool-downs with no success between them grow, up to the ceiling', async () => {
        vi.useFakeTimers();
        try {
            const fetchMock = refusal();
            globalThis.fetch = fetchMock;

            const seen = [];
            for (let round = 0; round < 4; round += 1) {
                await marketHistoryAPI.fetchHistory(`/items/${round}-a`, 0, 7);
                await marketHistoryAPI.fetchHistory(`/items/${round}-b`, 0, 7); // trips it
                seen.push(marketHistoryAPI.cooldownUntil - Date.now());
                vi.advanceTimersByTime(seen[seen.length - 1] + 1); // clear it for the next round
            }

            // 30s, 60s, 120s, 240s — each about double the last
            expect(seen[0]).toBeCloseTo(30_000, -2);
            expect(seen[1]).toBeCloseTo(60_000, -2);
            expect(seen[2]).toBeCloseTo(120_000, -2);
            expect(seen[3]).toBeCloseTo(240_000, -2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('two failures far apart are not a burst, and do not trip it', async () => {
        // FAILURE_THRESHOLD's whole justification is that a rate-limited
        // sweep fails every request within milliseconds of the last, which an
        // ordinary one-off drop does not. A bare counter cannot tell those
        // apart: a blip while a chart loads, then an unrelated one an hour
        // later, would otherwise turn price history off for thirty seconds on
        // the strength of an hour-stale failure.
        vi.useFakeTimers();
        try {
            globalThis.fetch = refusal();

            await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
            expect(marketHistoryAPI.cooldownUntil).toBe(0);

            vi.advanceTimersByTime(60 * 60 * 1000); // an hour of nothing going wrong

            await marketHistoryAPI.fetchHistory('/items/b', 0, 7);
            expect(marketHistoryAPI.cooldownUntil).toBe(0);

            // A real burst still trips it on its second request
            await marketHistoryAPI.fetchHistory('/items/c', 0, 7);
            expect(marketHistoryAPI.cooldownUntil).toBeGreaterThan(Date.now());
        } finally {
            vi.useRealTimers();
        }
    });

    test('switching to the other pool does not serve the first pool’s sentence', async () => {
        // The two sources are different hosts run by different people, and
        // switching to the other one is exactly what a player does when the
        // selected pool is unhealthy. Carrying the cool-down across that
        // switch answers null for the whole window from a server nobody
        // asked.
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it on mooket2
        expect(marketHistoryAPI.cooldownUntil).toBeGreaterThan(Date.now());
        expect(fetchMock).toHaveBeenCalledTimes(2);

        settings.market_historySource = 'mooket1';
        fetchMock.mockImplementation(async () => ({
            ok: true,
            json: async () => ({ ask: [{ time: 1, price: 5 }], bid: [{ time: 1, price: 4 }] }),
        }));

        const rows = await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        expect(rows).toEqual([{ a: 5, b: 4, p: 4.5, v: 0, time: 1 }]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(marketHistoryAPI.cooldownUntil).toBe(0);
    });

    test('one line is logged for the cool-down, not one per refused item', async () => {
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        // A concurrent burst, the way `VOLUME_CONCURRENCY` in market-liquidity.js
        // fires several lookups at once rather than one at a time
        const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        await Promise.all(items.map((letter) => marketHistoryAPI.fetchHistory(`/items/${letter}`, 0, 7)));

        const backoffLines = errorLog.mock.calls.filter((call) => String(call[0]).includes('backing off'));
        expect(backoffLines).toHaveLength(1);
        expect(errorLog.mock.calls.length).toBeLessThan(items.length);
    });
});

describe('cooldownRemainingMs', () => {
    // fetchHistory answers null for reasons a caller cannot otherwise tell
    // apart: the setting is off, no item was given, a lone refusal that did not
    // trip the cool-down, or the cool-down itself. This is what a caller — the
    // history chart, the My Listings refresh button — asks afterwards to find
    // out whether it was the cool-down, so it can say so instead of drawing an
    // empty result.
    function refusal() {
        return vi.fn(async () => {
            throw new TypeError('NetworkError when attempting to fetch resource.');
        });
    }

    beforeEach(() => {
        on('www.milkywayidle.com');
    });

    test('is 0 for a source that has never been asked about', () => {
        expect(marketHistoryAPI.cooldownRemainingMs('mooket2')).toBe(0);
    });

    test('is 0 after an ordinary null — a single refusal that did not trip the cool-down', async () => {
        globalThis.fetch = refusal();
        expect(await marketHistoryAPI.fetchHistory('/items/a', 0, 7)).toBeNull();
        expect(marketHistoryAPI.cooldownRemainingMs('mooket2')).toBe(0);
    });

    test('is positive, and roughly the cool-down length, once the cool-down trips', async () => {
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it

        const remaining = marketHistoryAPI.cooldownRemainingMs('mooket2');
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(marketHistoryAPI.cooldownUntil - Date.now() + 1);
    });

    test('is 0 for a source other than the one that is cooling down', async () => {
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it on mooket2
        expect(marketHistoryAPI.cooldownRemainingMs('mooket2')).toBeGreaterThan(0);
        expect(marketHistoryAPI.cooldownRemainingMs('mooket1')).toBe(0);
    });

    test('falls back to 0 once the cool-down expires', async () => {
        vi.useFakeTimers();
        try {
            const fetchMock = refusal();
            globalThis.fetch = fetchMock;

            await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
            await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it

            vi.advanceTimersByTime(marketHistoryAPI.cooldownUntil - Date.now() + 1);
            expect(marketHistoryAPI.cooldownRemainingMs('mooket2')).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    test('called with no source key, defaults to the current source instead of reading as healthy', async () => {
        // The two existing callers always pass a key explicitly. A future
        // caller that forgets it must not silently compare `undefined` against
        // `backoffSourceKey` and answer 0 — "not backed off" — while the
        // current source is actively cooling down. That is exactly the
        // "surface silently drawing blank" failure this method exists to catch.
        const fetchMock = refusal();
        globalThis.fetch = fetchMock;

        await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7); // trips it on mooket2 (the current source)

        expect(marketHistoryAPI.currentSource().key).toBe('mooket2');
        expect(marketHistoryAPI.cooldownRemainingMs()).toBeGreaterThan(0);
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
