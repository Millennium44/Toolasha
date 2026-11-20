/**
 * Mooket I's prices with mooket II's volume attached (the `market_historyVolumeFromMooket2` setting).
 *
 * The worst outcome here is a volume figure that is not real: another item, level or hour's volume, or a
 * `0` standing in for "mooket II could not be reached". A missing volume is the mild failure, so every
 * path that cannot prove a volume returns `v: null`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    market_pooledHistory: true,
    market_historySource: 'mooket1',
    market_historyVolumeFromMooket2: true,
}));
vi.mock('../../../core/config.js', () => ({
    default: { getSetting: (key) => settings[key] },
}));

const {
    default: marketHistoryAPI,
    HISTORY_HOST,
    SOURCES,
    mergeMooket1Volume,
} = await import('./market-history-api.js');
const { rowsHaveVolume } = await import('./market-history-data.js');

const H = 3600;
const HOUR_100 = 100 * H;

/** Mooket I's two index-aligned series for the given [time, ask, bid] sightings (price <= 0 is an empty side) */
const mooket1Payload = (sightings) => ({
    ask: sightings.map(([time, ask]) => ({ time, price: ask })),
    bid: sightings.map(([time, , bid]) => ({ time, price: bid })),
});

/** Mooket I: hour 100 has two sightings, hour 101 none (a gap), hour 102 one */
const MOOKET1 = mooket1Payload([
    [HOUR_100 + 10, 50, 40],
    [HOUR_100 + 20, 52, 41],
    [HOUR_100 + 2 * H + 5, 55, 45],
]);

/** Mooket II: hour 100 has two rows at one timestamp (duplicates add), hour 101 a row mooket I lacks, hour 102 a real zero */
const MOOKET2 = [
    { a: 99, b: 98, p: 98, v: 3, time: HOUR_100 + 30 },
    { a: 99, b: 98, p: 98, v: 4, time: HOUR_100 + 30 },
    { a: 99, b: 98, p: 98, v: 5, time: HOUR_100 + H + 15 },
    { a: 99, b: 98, p: 98, v: 0, time: HOUR_100 + 2 * H + 1 },
];

const ok = (body) => ({ ok: true, json: async () => body });

/** A fetch that answers each host from `answers`, and records what was asked */
function route(answers = {}) {
    const calls = [];
    const fetchMock = vi.fn(async (url) => {
        calls.push(String(url));
        const host = String(url).startsWith(HISTORY_HOST) ? 'q7' : 'm1';
        const answer = answers[host];
        if (typeof answer === 'function') return answer(url);
        if (answer instanceof Error) throw answer;
        return answer ?? ok(host === 'q7' ? MOOKET2 : MOOKET1);
    });
    globalThis.fetch = fetchMock;
    return { fetchMock, calls, q7: () => calls.filter((url) => url.startsWith(HISTORY_HOST)) };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    settings.market_pooledHistory = true;
    settings.market_historySource = 'mooket1';
    settings.market_historyVolumeFromMooket2 = true;
    marketHistoryAPI.cache.clear();
    marketHistoryAPI.consecutiveFailures = 0;
    marketHistoryAPI.cooldownUntil = 0;
    marketHistoryAPI.cooldownStreak = 0;
    marketHistoryAPI.lastFailureAt = 0;
    marketHistoryAPI.backoffSourceKey = null;
    marketHistoryAPI.volumeFailures = 0;
    marketHistoryAPI.volumeCooldownStreak = 0;
    marketHistoryAPI.volumeCooldownUntil = 0;
    marketHistoryAPI.paceIntervalMs = 0;
    marketHistoryAPI.paceNextAt.clear();
    marketHistoryAPI.paceWaiters.clear();
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true, writable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    delete globalThis.navigator.locks;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

describe('the source descriptor', () => {
    test('mooket I with the setting on keeps its key and says where the volume is from', () => {
        const source = marketHistoryAPI.currentSource();
        expect(source.key).toBe('mooket1');
        expect(source.hasVolume).toBe(true);
        expect(source.volumeFrom).toBe('mooket2');
        expect(source.hasTradeSplit).toBe(false);
        expect(source.variant).toBe('+vol');
    });

    test('the setting does nothing while mooket II is the source, and nothing changes while it is off', () => {
        settings.market_historySource = 'mooket2';
        expect(marketHistoryAPI.currentSource()).toBe(SOURCES.mooket2);
        settings.market_historySource = 'mooket1';
        settings.market_historyVolumeFromMooket2 = false;
        expect(marketHistoryAPI.currentSource()).toBe(SOURCES.mooket1);
        expect(SOURCES.mooket1.hasVolume).toBe(false);
    });
});

describe('setting off', () => {
    test('no request goes to mooket II and the rows are today’s', async () => {
        settings.market_historyVolumeFromMooket2 = false;
        const { q7, calls } = route();

        const rows = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(q7()).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.v === 0)).toBe(true);
    });

    test('a caller that reads prices only gets plain rows and costs mooket II nothing, even with the setting on', async () => {
        const { q7 } = route();

        const rows = await marketHistoryAPI.fetchHistory('/items/x', 2, 1, { volume: false });

        expect(q7()).toEqual([]);
        expect(rows.every((row) => row.v === 0)).toBe(true);
    });
});

describe('setting on, mooket II answers', () => {
    test('asks for the same item, level and range, and keeps mooket I’s prices', async () => {
        const { q7, calls } = route();

        const rows = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(q7()).toEqual([
            `${HISTORY_HOST}/api/market/history?item_id=${encodeURIComponent('/items/x')}&variant=2&days=7`,
        ]);
        expect(calls.find((url) => !url.startsWith(HISTORY_HOST))).toContain('level=2');
        expect(calls.find((url) => !url.startsWith(HISTORY_HOST))).toContain(`time=${7 * 86400}`);
        // mooket I's own prices, untouched (mooket II's 99/98 never appear)
        expect(rows.filter((row) => row.a > 0).map((row) => [row.a, row.b])).toEqual([
            [50, 40],
            [52, 41],
            [55, 45],
        ]);
    });

    test('joins by UTC hour: duplicates add, one row of the hour carries it, a gap hour becomes a volume-only row, a real zero stays zero', async () => {
        route();

        const rows = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(rows.map((row) => [row.time - HOUR_100, row.v])).toEqual([
            [10, null], // earlier sighting in hour 100: no double count
            [20, 7], // the hour's volume (3 + 4) on its latest sighting
            [H + 15, 5], // hour 101: mooket I had no sighting, so a volume-only row
            [2 * H + 5, 0], // mooket II saw the hour and nothing traded: a real zero
        ]);
        const volumeOnly = rows.find((row) => row.time === HOUR_100 + H + 15);
        expect([volumeOnly.a, volumeOnly.b, volumeOnly.p]).toEqual([-1, -1, -1]);
        // each hour's volume is counted exactly once overall
        expect(rows.reduce((sum, row) => sum + (row.v || 0), 0)).toBe(12);
        expect(rowsHaveVolume(rows)).toBe(true);
    });

    test('a mooket II hour with no volume reading never becomes a zero', () => {
        const merged = mergeMooket1Volume(
            [{ a: 5, b: 4, p: 4.5, v: 0, time: HOUR_100 }],
            [
                { a: 1, b: 1, p: 1, time: HOUR_100 + 1 },
                { a: 1, b: 1, p: 1, v: null, time: HOUR_100 + 2 },
                { a: 1, b: 1, p: 1, v: '', time: HOUR_100 + 3 },
            ]
        );
        expect(merged).toEqual([{ a: 5, b: 4, p: 4.5, v: null, time: HOUR_100 }]);
    });

    test('is cached under its own variant: a second call asks neither host again', async () => {
        const { calls } = route();

        const first = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);
        const second = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(calls).toHaveLength(2);
        expect(second).toBe(first);
    });

    test('a different level is a different lookup on both hosts', async () => {
        const { q7 } = route();

        await marketHistoryAPI.fetchHistory('/items/x', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/x', 3, 7);

        expect(q7().map((url) => url.match(/variant=(\d+)/)[1])).toEqual(['0', '3']);
    });
});

describe('cache keys carry the setting', () => {
    test('a cached plain mooket I answer is not served as merged', async () => {
        settings.market_historyVolumeFromMooket2 = false;
        const { q7 } = route();
        const plain = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);
        expect(plain.every((row) => row.v === 0)).toBe(true);

        settings.market_historyVolumeFromMooket2 = true;
        const merged = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(q7()).toHaveLength(1);
        expect(rowsHaveVolume(merged)).toBe(true);
    });

    test('a cached merged answer is not served as plain', async () => {
        const { calls } = route();
        await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        settings.market_historyVolumeFromMooket2 = false;
        const plain = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(calls).toHaveLength(3); // merged: both hosts; plain: mooket I only
        expect(plain.every((row) => row.v === 0)).toBe(true);
    });
});

describe('setting on, mooket II fails', () => {
    test.each([
        ['a network error', { q7: new Error('network') }],
        ['an HTTP error', { q7: { ok: false, status: 429, json: async () => ({}) } }],
        ['a payload that is not rows', { q7: ok({ error: 'nope' }) }],
        ['no rows at all', { q7: ok([]) }],
        ['rows with no volume in them', { q7: ok([{ a: 1, b: 1, p: 1, time: HOUR_100 }]) }],
    ])('%s keeps mooket I’s rows with no volume, never zero', async (_name, answers) => {
        route(answers);

        const rows = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.v === null)).toBe(true);
        expect(rowsHaveVolume(rows)).toBe(false);
    });

    test('repeated failures cool the volume side down without stopping mooket I or its back-off state', async () => {
        const { q7 } = route({ q7: new Error('network') });

        await marketHistoryAPI.fetchHistory('/items/a', 0, 7);
        await marketHistoryAPI.fetchHistory('/items/b', 0, 7);
        expect(marketHistoryAPI.volumeCooldownUntil).toBeGreaterThan(Date.now());
        const before = q7().length;

        const rows = await marketHistoryAPI.fetchHistory('/items/c', 0, 7);

        expect(q7()).toHaveLength(before); // cooling: not asked
        expect(rows).toHaveLength(3); // mooket I still answers
        expect(rows.every((row) => row.v === null)).toBe(true);
        expect(marketHistoryAPI.cooldownUntil).toBe(0); // the read source's own back-off is untouched
    });

    test('mooket I itself failing answers null, as it does without the setting', async () => {
        route({ m1: new Error('down') });
        expect(await marketHistoryAPI.fetchHistory('/items/x', 2, 7)).toBeNull();
    });
});

describe('mooket II has data and mooket I has none', () => {
    test('the volume stands alone as volume-only rows; no price is invented', async () => {
        route({ m1: ok({ ask: [], bid: [] }) });

        const rows = await marketHistoryAPI.fetchHistory('/items/x', 2, 7);

        expect(rows.map((row) => row.v)).toEqual([7, 5, 0]);
        expect(rows.every((row) => row.a === -1 && row.b === -1 && row.p === -1)).toBe(true);
    });
});

describe('answers that arrive after things changed', () => {
    test('switching to mooket II mid-fetch drops the merged answer: it is not filed under the merged key', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        route({
            q7: async () => {
                await gate;
                return ok(MOOKET2);
            },
        });

        const pending = marketHistoryAPI.fetchHistory('/items/x', 2, 7);
        settings.market_historySource = 'mooket2';
        release();
        await pending;

        expect(marketHistoryAPI.cache.has('mooket1+vol:/items/x:2:7')).toBe(false);
        expect(marketHistoryAPI.cache.has('mooket1:/items/x:2:7')).toBe(false);
    });

    test('turning the setting off mid-fetch does not file a merged answer either', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        route({
            q7: async () => {
                await gate;
                return ok(MOOKET2);
            },
        });

        const pending = marketHistoryAPI.fetchHistory('/items/x', 2, 7);
        settings.market_historyVolumeFromMooket2 = false;
        release();
        await pending;

        expect(
            marketHistoryAPI.cache.size === 0 || ![...marketHistoryAPI.cache.keys()].some((k) => k.includes('+vol'))
        ).toBe(true);
    });

    test('the setting turned off after the volume lookup queued behind its pace slot sends nothing to mooket II', async () => {
        marketHistoryAPI.paceIntervalMs = 40;
        marketHistoryAPI.paceNextAt.set('mooket2', Date.now() + 40);
        const { q7 } = route();

        const pending = marketHistoryAPI.fetchHistory('/items/x', 2, 7);
        settings.market_historyVolumeFromMooket2 = false;
        const rows = await pending;

        expect(q7()).toEqual([]);
        expect(rows.every((row) => row.v !== 0)).toBe(true); // never a made-up zero
    });

    test('pooled history turned off while the volume lookup waits sends nothing to mooket II', async () => {
        marketHistoryAPI.paceIntervalMs = 40;
        marketHistoryAPI.paceNextAt.set('mooket2', Date.now() + 40);
        const { q7 } = route();

        const pending = marketHistoryAPI.fetchHistory('/items/x', 2, 7);
        settings.market_pooledHistory = false;
        await pending;

        expect(q7()).toEqual([]);
    });
});
