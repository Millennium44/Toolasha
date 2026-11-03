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

const {
    default: marketHistoryAPI,
    HISTORY_HOST,
    normaliseMooket1Rows,
    REQUEST_PACE_MS,
    PACE_LOCK_PREFIX,
    PACE_LOCK_MAX_WAIT_MS,
} = await import('./market-history-api.js');

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
    // The suites below test what a lookup returns, one after another; pacing has its own suite
    marketHistoryAPI.paceIntervalMs = 0;
    marketHistoryAPI.paceNextAt?.clear();
    marketHistoryAPI.paceWaiters?.clear();
    // Node has real Web Locks; the suites below drive their own clocks, so no lock unless a suite installs one
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true, writable: true });
});

afterEach(() => {
    delete globalThis.navigator.locks;
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

describe('on the CN mirror', () => {
    test.each(['www.milkywayidlecn.com', 'milkywayidlecn.com', 'test.milkywayidlecn.com'])(
        '%s opens no socket and reports nothing',
        (host) => {
            on(host);

            marketHistoryAPI.connect();
            marketHistoryAPI.report({ marketItemOrderBooks: { '/items/cheese': {} } });

            expect(sockets).toHaveLength(0);
        }
    );

    test('reading history still works', async () => {
        on('www.milkywayidlecn.com');
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [{ time: 1, ask: 5 }] }));
        globalThis.fetch = fetchMock;

        const rows = await marketHistoryAPI.fetchHistory('/items/cheese', 0, 7);

        expect(rows).toEqual([{ time: 1, ask: 5 }]);
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

describe('request pacing', () => {
    // A bound on requests in flight is not a bound on rate: measured live, one
    // planner goal sent about 168 requests in about 5 seconds and three failed.
    // Every request that goes to the network now waits its turn; the clock is
    // driven by hand so none of this takes real time.
    const rows = [{ a: 5, b: 4, p: 4.5, v: 10, time: 1 }];

    /** A fetch that answers at once and notes when it was asked */
    function recordingFetch() {
        const sentAt = [];
        const urls = [];
        const mock = vi.fn(async (url) => {
            sentAt.push(Date.now());
            urls.push(url);
            return { ok: true, json: async () => rows };
        });
        return { mock, sentAt, urls };
    }

    beforeEach(() => {
        on('www.milkywayidle.com');
        vi.useFakeTimers();
        marketHistoryAPI.paceIntervalMs = REQUEST_PACE_MS;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a lone request after a quiet spell goes at once', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;

        expect(await marketHistoryAPI.fetchHistory('/items/a', 0, 7)).toEqual(rows);
        expect(mock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 3);
        expect(await marketHistoryAPI.fetchHistory('/items/b', 0, 7)).toEqual(rows);
        expect(mock).toHaveBeenCalledTimes(2);
    });

    test('a burst is spread out, duplicates and cache hits take no turn on the network', async () => {
        const { mock, sentAt } = recordingFetch();
        globalThis.fetch = mock;
        marketHistoryAPI.remember('mooket2:/items/cached:0:7', rows);

        const keys = ['a', 'b', 'a', 'c', 'cached', 'd', 'b', 'e', 'f', 'g'];
        const started = Date.now();
        const done = Promise.all(keys.map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));
        await vi.advanceTimersByTimeAsync(0);
        // The first request is immediate and the cache hit has already answered
        expect(mock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * keys.length);
        const results = await done;

        expect(results.every((r) => Array.isArray(r))).toBe(true);
        // 7 distinct uncached keys: a b c d e f g. The repeats find the answer their twin cached.
        expect(mock).toHaveBeenCalledTimes(7);
        for (let i = 1; i < sentAt.length; i += 1) {
            expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(REQUEST_PACE_MS);
        }
        expect(sentAt[0]).toBe(started);
    });

    test('a failure mid-burst that trips the cool-down ends every wait at once, with nothing more sent', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const mock = vi.fn(async () => {
            if (mock.mock.calls.length === 1) return { ok: true, json: async () => rows };
            throw new TypeError('Failed to fetch');
        });
        globalThis.fetch = mock;

        const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const done = Promise.all(keys.map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));

        // a answers; b fails at 200ms; c fails at 400ms and trips the cool-down
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 2);
        const results = await done;

        expect(mock).toHaveBeenCalledTimes(3);
        expect(results.slice(0, 1)).toEqual([rows]);
        expect(results.slice(1)).toEqual(new Array(7).fill(null));
        expect(marketHistoryAPI.cooldownRemainingMs('mooket2')).toBeGreaterThan(0);
        // d to h did not sit out their turns, and nothing is left running for them
        expect(vi.getTimerCount()).toBe(0);
        expect(marketHistoryAPI.paceWaiters.size).toBe(0);
    });

    test('a cool-down that begins while requests wait is honored when their turn comes', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;

        const done = Promise.all(['a', 'b', 'c'].map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));
        await vi.advanceTimersByTimeAsync(0);
        expect(mock).toHaveBeenCalledTimes(1);

        marketHistoryAPI.cooldownUntil = Date.now() + 30_000;
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 3);

        expect(await done).toEqual([rows, null, null]);
        expect(mock).toHaveBeenCalledTimes(1);
    });

    test('turning pooled history off while requests wait sends nothing more', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;

        const done = Promise.all(['a', 'b', 'c'].map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));
        await vi.advanceTimersByTimeAsync(0);
        settings.market_pooledHistory = false;
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 3);

        expect(await done).toEqual([rows, null, null]);
        expect(mock).toHaveBeenCalledTimes(1);
    });

    test('the timeout starts when a request is sent, not while it waits', async () => {
        const aborted = [];
        globalThis.fetch = vi.fn(
            (url, { signal }) =>
                new Promise((resolve, reject) => {
                    const index = aborted.length;
                    aborted.push(false);
                    signal.addEventListener('abort', () => {
                        aborted[index] = true;
                        reject(new DOMException('aborted', 'AbortError'));
                    });
                })
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // Keep the two failures below the cool-down threshold's reach for this test
        marketHistoryAPI.consecutiveFailures = -10;

        const done = Promise.all(['a', 'b', 'c'].map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 2); // all three are sent: at 0, 200, 400

        await vi.advanceTimersByTimeAsync(10_000 - REQUEST_PACE_MS * 2 + 100); // t = 10_100
        expect(aborted).toEqual([true, false, false]);

        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 3);
        expect(aborted).toEqual([true, true, true]);
        await done;
    });

    test('a waiting request follows the source switch to the other pool, which has its own pace', async () => {
        const { mock, urls } = recordingFetch();
        globalThis.fetch = mock;
        mock.mockImplementation(async (url) => {
            urls.push(url);
            return { ok: true, json: async () => (url.includes('qi-e') ? { ask: [], bid: [] } : rows) };
        });

        const done = Promise.all(['a', 'b', 'c'].map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));
        await vi.advanceTimersByTimeAsync(0);
        expect(urls).toHaveLength(1);

        settings.market_historySource = 'mooket1';
        // The other pool's first request is not queued behind the first pool's burst
        const other = marketHistoryAPI.fetchHistory('/items/z', 0, 7);
        await vi.advanceTimersByTimeAsync(0);
        expect(urls).toHaveLength(2);
        expect(urls[1]).toContain('mooket.qi-e.top');
        await other;

        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 4);
        await done;
        // The two that were waiting went to the pool selected when their turn came
        expect(urls.slice(2).every((u) => u.includes('mooket.qi-e.top'))).toBe(true);
        expect(urls).toHaveLength(4);
    });

    test('nothing wanted means nothing waits', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;

        expect(await Promise.all([])).toEqual([]);
        expect(await marketHistoryAPI.fetchHistory('', 0, 7)).toBeNull();
        expect(mock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('request pacing across tabs', () => {
    // Each tab keeps its own clock, so several open tabs together sent several times the intended rate to the one
    // pool. The turn to send is now a Web Lock every tab queues on, held for one pace interval after a send.
    const rows = [{ a: 5, b: 4, p: 4.5, v: 10, time: 1 }];
    const LOCK = `${PACE_LOCK_PREFIX}mooket2`;

    /** A minimal first-in-first-out, exclusive Web Lock manager, with abort, as the browser's */
    function installLocks() {
        const queues = new Map();
        const grants = [];
        const queueOf = (name) => {
            if (!queues.has(name)) queues.set(name, { held: false, waiters: [] });
            return queues.get(name);
        };
        const next = (name) => {
            const queue = queueOf(name);
            const waiter = queue.waiters.shift();
            if (waiter) waiter();
        };
        const manager = {
            request(name, options, callback) {
                return new Promise((resolve, reject) => {
                    const queue = queueOf(name);
                    const run = async () => {
                        queue.held = true;
                        grants.push({ name, at: Date.now() });
                        try {
                            resolve(await callback({ name }));
                        } catch (error) {
                            reject(error);
                        } finally {
                            queue.held = false;
                            next(name);
                        }
                    };
                    options?.signal?.addEventListener('abort', () => {
                        const index = queue.waiters.indexOf(run);
                        if (index < 0) return;
                        queue.waiters.splice(index, 1);
                        reject(new DOMException('aborted', 'AbortError'));
                    });
                    if (queue.held) queue.waiters.push(run);
                    else run();
                });
            },
        };
        Object.defineProperty(globalThis.navigator, 'locks', { value: manager, configurable: true, writable: true });
        return { manager, grants, queueOf };
    }

    /** Another tab holding the turn until `release()` */
    function otherTabHolds(manager, name = LOCK) {
        let release = () => {};
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const granted = new Promise((resolve) => {
            manager.request(name, {}, () => {
                resolve();
                return held;
            });
        });
        return { release, granted };
    }

    function recordingFetch() {
        const sentAt = [];
        const mock = vi.fn(async (url) => {
            sentAt.push({ url, at: Date.now() });
            return { ok: true, json: async () => (url.includes('qi-e') ? { ask: [], bid: [] } : rows) };
        });
        return { mock, sentAt };
    }

    let locks;
    beforeEach(() => {
        on('www.milkywayidle.com');
        vi.useFakeTimers();
        marketHistoryAPI.paceIntervalMs = REQUEST_PACE_MS;
        locks = installLocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a request waits while another tab holds the turn, and goes once it is released', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        const other = otherTabHolds(locks.manager);
        await other.granted;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(1000);
        expect(mock).not.toHaveBeenCalled();

        other.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(mock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS);
        expect(await done).toEqual(rows);
    });

    test('the turn is held for one pace interval after the send, not until the answer', async () => {
        let answer = () => {};
        const mock = vi.fn(
            () =>
                new Promise((resolve) => {
                    answer = () => resolve({ ok: true, json: async () => rows });
                })
        );
        globalThis.fetch = mock;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(0);
        expect(mock).toHaveBeenCalledTimes(1);

        // Another tab asks for the turn right after: it gets it one interval after the send, with the answer
        // still outstanding
        let otherGrantedAt = null;
        const sentAt = Date.now();
        locks.manager.request(LOCK, {}, () => {
            otherGrantedAt = Date.now();
        });
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS - 1);
        expect(otherGrantedAt).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(otherGrantedAt).toBe(sentAt + REQUEST_PACE_MS);

        answer();
        expect(await done).toEqual(rows);
    });

    test('two tabs sweeping at once are spaced by the pace interval between every send', async () => {
        const { mock, sentAt } = recordingFetch();
        globalThis.fetch = mock;

        // This tab's sweep, and a second tab's sends taken from the same queue
        const mine = Promise.all(['a', 'b', 'c'].map((k) => marketHistoryAPI.fetchHistory(`/items/${k}`, 0, 7)));
        const theirs = [];
        for (let i = 0; i < 3; i += 1) {
            theirs.push(
                locks.manager.request(LOCK, {}, async () => {
                    sentAt.push({ url: `other-${i}`, at: Date.now() });
                    await new Promise((resolve) => setTimeout(resolve, REQUEST_PACE_MS));
                })
            );
        }
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 12);
        await Promise.all([mine, ...theirs]);

        expect(sentAt).toHaveLength(6);
        const times = sentAt.map((s) => s.at).sort((x, y) => x - y);
        for (let i = 1; i < times.length; i += 1) {
            expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(REQUEST_PACE_MS);
        }
    });

    test('a request that waited too long for the turn sends anyway, and leaves nothing running', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        const other = otherTabHolds(locks.manager);
        await other.granted;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(PACE_LOCK_MAX_WAIT_MS - 1);
        expect(mock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await done).toEqual(rows);
        expect(mock).toHaveBeenCalledTimes(1);

        other.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('turning pooled history off while waiting for the turn sends nothing and gives the turn back', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        const other = otherTabHolds(locks.manager);
        await other.granted;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(10);
        settings.market_pooledHistory = false;
        other.release();
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 2);

        expect(await done).toBeNull();
        expect(mock).not.toHaveBeenCalled();
        expect(locks.queueOf(LOCK).held).toBe(false);
    });

    test('a cool-down that begins while waiting for the turn is honored, and the turn goes back', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        const other = otherTabHolds(locks.manager);
        await other.granted;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(10);
        marketHistoryAPI.cooldownUntil = Date.now() + 30_000;
        other.release();
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 2);

        expect(await done).toBeNull();
        expect(mock).not.toHaveBeenCalled();
        expect(locks.queueOf(LOCK).held).toBe(false);
    });

    test('an answer a twin cached while waiting for the turn is used instead of asking again', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        const other = otherTabHolds(locks.manager);
        await other.granted;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(10);
        marketHistoryAPI.remember('mooket2:/items/a:0:7', rows);
        other.release();
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 2);

        expect(await done).toEqual(rows);
        expect(mock).not.toHaveBeenCalled();
        expect(locks.queueOf(LOCK).held).toBe(false);
    });

    test('a forced refresh still asks the pool even when an answer is cached', async () => {
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        marketHistoryAPI.remember('mooket2:/items/a:0:7', [{ a: 1, b: 1, p: 1, v: 1, time: 0 }]);

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7, { force: true });
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS);
        expect(await done).toEqual(rows);
        expect(mock).toHaveBeenCalledTimes(1);
    });

    test('a source switch while waiting sends to the pool selected when the turn came, on that pool’s own turn', async () => {
        const { mock, sentAt } = recordingFetch();
        globalThis.fetch = mock;
        const other = otherTabHolds(locks.manager);
        await other.granted;

        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(10);
        settings.market_historySource = 'mooket1';
        other.release();
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 3);
        await done;

        expect(sentAt).toHaveLength(1);
        expect(sentAt[0].url).toContain('mooket.qi-e.top');
    });

    test('the other pool is not held up by a turn taken on this one', async () => {
        const { mock, sentAt } = recordingFetch();
        globalThis.fetch = mock;
        settings.market_historySource = 'mooket1';
        const other = otherTabHolds(locks.manager, LOCK);
        await other.granted;

        await vi.advanceTimersByTimeAsync(0);
        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(0);
        expect(sentAt).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS);
        await done;
        other.release();
    });

    test('a failed request still hands the turn on', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });
        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await vi.advanceTimersByTimeAsync(REQUEST_PACE_MS * 2);
        expect(await done).toBeNull();
        expect(locks.queueOf(LOCK).held).toBe(false);
    });

    test('without Web Locks a request does not yield before sending, as before', async () => {
        Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true, writable: true });
        const { mock } = recordingFetch();
        globalThis.fetch = mock;
        const done = marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        expect(mock).toHaveBeenCalledTimes(1);
        expect(await done).toEqual(rows);
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
