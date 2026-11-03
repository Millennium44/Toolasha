import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (key, store, fallback) => fallback),
    set: vi.fn(),
    delete: vi.fn(async () => true),
    getMany: vi.fn(async (keys) => new Map(keys.map((key) => [key, null]))),
    getAllKeys: vi.fn(async () => []),
    tryGetAllKeys: vi.fn(async () => []),
    putAll: vi.fn(async () => 0),
    isQuotaExceeded: vi.fn(() => false),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'char-1' } }));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => true } }));

const { default: networthHistory, pruneHistory, seriesStore } = await import('./networth-history.js');
const { default: networthMovers } = await import('./networth-movers.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LAB = 'networth_includeLabyrinthTokens';
const TOKEN = '/items/labyrinth_token';

const marker = (step, id = LAB, extra = {}) => ({
    changes: [{ id, from: false, to: true }],
    step,
    stepCounted: step,
    unseparated: [],
    raw: step,
    ...extra,
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    storageMock.set.mockReset();
    networthHistory.history = [];
    networthHistory.characterId = 'char-1';
    networthHistory.markerState = null;
    networthMovers.reset();
    seriesStore.forget();
});

afterEach(() => {
    vi.useRealTimers();
});

const reading = (labOn, { excludedAmount = 0, tokenPriced = true } = {}) => {
    const tokenValue = labOn && tokenPriced ? 400 : 0;
    return {
        totalNetworth: 1000 + (excludedAmount ? 0 : tokenValue),
        coins: 100,
        excluded: {
            total: excludedAmount,
            items: excludedAmount
                ? [{ type: 'item', value: TOKEN, name: 'Labyrinth Token', amount: excludedAmount }]
                : [],
        },
        currentAssets: {
            inventory: {
                value: 10,
                breakdown: excludedAmount
                    ? []
                    : [{ itemHrid: TOKEN, enhancementLevel: 0, count: 8, value: tokenValue }],
            },
            equipped: { value: 0, breakdown: [] },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            houses: { totalCost: 0, breakdown: [] },
            abilities: { totalCost: 0, breakdown: [] },
            abilityBooks: { totalCost: 0, breakdown: [] },
        },
        valuation: { [LAB]: labOn },
    };
};

const take = async (data) => {
    networthHistory.networthFeature = { currentData: data };
    vi.advanceTimersByTime(HOUR);
    await networthHistory.takeSnapshot();
    return networthHistory.history.at(-1);
};

describe('deleting a marked point', () => {
    test('its marker moves to the next surviving point, so later totals still leave the step out', async () => {
        const now = Date.now();
        networthHistory.history = [
            { t: now - 3 * HOUR, total: 1000, nonExcluded: 1000 },
            { t: now - 2 * HOUR, total: 1400, nonExcluded: 1400, marker: marker(400) },
            { t: now - HOUR, total: 1450, nonExcluded: 1450 },
        ];
        await networthHistory.deleteSnapshot(now - 2 * HOUR);

        expect(networthHistory.history.map((p) => p.t)).toEqual([now - 3 * HOUR, now - HOUR]);
        expect(networthHistory.history[1].marker.step).toBe(400);
        expect(networthHistory.getGrowthHistory().map((p) => p.total)).toEqual([1000, 1050]);
    });

    test('merged with a marker the next point already has, not replacing it', async () => {
        const now = Date.now();
        networthHistory.history = [
            { t: now - 3 * HOUR, total: 1000 },
            { t: now - 2 * HOUR, total: 1400, marker: marker(400) },
            { t: now - HOUR, total: 1500, marker: marker(50, 'networth_includeTaskTokens') },
        ];
        await networthHistory.deleteSnapshot(now - 2 * HOUR);
        const kept = networthHistory.history[1].marker;
        expect(kept.step).toBe(450);
        expect(kept.changes.map((c) => c.id)).toEqual([LAB, 'networth_includeTaskTokens']);
    });

    test('the same change the next point already carries is not added twice', async () => {
        const now = Date.now();
        networthHistory.history = [
            { t: now - 3 * HOUR, total: 1000 },
            { t: now - 2 * HOUR, total: 1400, marker: marker(400) },
            { t: now - HOUR, total: 1400, marker: marker(400) },
        ];
        await networthHistory.deleteSnapshot(now - 2 * HOUR);
        expect(networthHistory.history[1].marker.step).toBe(400);
    });

    test('a change the next point carries in a bigger batch is not added twice either', async () => {
        const now = Date.now();
        const batch = {
            changes: [
                { id: LAB, from: false, to: true, step: 400, stepCounted: 400 },
                { id: 'networth_includeCowbells', from: false, to: true, step: 100, stepCounted: 100 },
            ],
            step: 500,
            stepCounted: 500,
            unseparated: [],
            raw: 500,
        };
        networthHistory.history = [
            { t: now - 3 * HOUR, total: 1000, nonExcluded: 1000 },
            { t: now - 2 * HOUR, total: 1400, nonExcluded: 1400, marker: marker(400) },
            { t: now - HOUR, total: 1500, nonExcluded: 1500, marker: batch },
        ];
        await networthHistory.deleteSnapshot(now - 2 * HOUR);
        expect(networthHistory.history[1].marker).toEqual(batch);

        // The other way round: the bigger batch is the one deleted, and only the cowbells are left to carry
        networthHistory.history = [
            { t: now - 3 * HOUR, total: 1000, nonExcluded: 1000 },
            { t: now - 2 * HOUR, total: 1500, nonExcluded: 1500, marker: batch },
            { t: now - HOUR, total: 1500, nonExcluded: 1500, marker: marker(400) },
        ];
        await networthHistory.deleteSnapshot(now - 2 * HOUR);
        const kept = networthHistory.history[1].marker;
        expect(kept.step).toBe(500);
        expect(kept.changes.map((c) => c.id).sort()).toEqual([LAB, 'networth_includeCowbells'].sort());
        expect(networthHistory.getGrowthHistory().map((p) => p.total)).toEqual([1000, 1000]);
    });

    test('a pull that brings two batches, read straight through: growth takes the shared change out once', async () => {
        const now = Date.now();
        const mine = { t: now - 2 * HOUR, total: 1400, nonExcluded: 1400, marker: marker(400) };
        const theirs = {
            t: now - HOUR,
            total: 1500,
            nonExcluded: 1500,
            marker: {
                changes: [
                    { id: LAB, from: false, to: true, step: 400, stepCounted: 400 },
                    { id: 'networth_includeCowbells', from: false, to: true, step: 100, stepCounted: 100 },
                ],
                step: 500,
                stepCounted: 500,
                unseparated: [],
                raw: 500,
            },
        };
        networthHistory.history = [{ t: now - 3 * HOUR, total: 1000, nonExcluded: 1000 }, mine, theirs];
        expect(networthHistory.getGrowthHistory().map((p) => p.total)).toEqual([1000, 1000, 1000]);
        expect(networthHistory.getForecastHistory().at(-1).total).toBe(1500);
    });

    test('with no later point the remembered settings go back, so the change is pending and is marked again', async () => {
        networthHistory.markerState = { t: Date.now(), settings: { [LAB]: true } };
        networthHistory.history = [
            { t: Date.now() - 3 * HOUR, total: 1000 },
            { t: Date.now() - HOUR, total: 1400, marker: marker(400) },
        ];
        await networthHistory.deleteSnapshot(Date.now() - HOUR);

        expect(networthHistory.markerState.settings[LAB]).toBe(false);
        expect(networthHistory.pendingChanges(reading(true)).map((c) => c.id)).toEqual([LAB]);

        await networthMovers.load('char-1');
        const again = await take(reading(true));
        expect(again.marker.changes).toEqual([{ id: LAB, from: false, to: true }]);
        // The item map of the reading before is gone, so the step is not invented
        expect(again.marker.step).toBe(null);
    });

    test('deleting an unmarked point changes nothing about markers', async () => {
        networthHistory.history = [
            { t: 1, total: 5 },
            { t: 2, total: 6, marker: marker(1) },
        ];
        await networthHistory.deleteSnapshot(1);
        expect(networthHistory.history).toHaveLength(1);
        expect(networthHistory.history[0].marker.step).toBe(1);
    });
});

describe('pruning keeps the steps', () => {
    test('the daily thinning of year-old points keeps a marked point', () => {
        const now = Date.parse('2026-11-02T12:00:00Z');
        const old = now - 400 * DAY;
        const points = [
            { t: old, total: 1 },
            { t: old + HOUR, total: 2, marker: marker(1) },
            { t: old + 2 * HOUR, total: 3 },
            { t: now - HOUR, total: 4 },
        ];
        const out = pruneHistory(points, now);
        expect(out.map((p) => p.t)).toContain(old + HOUR);
        expect(out.find((p) => p.t === old + HOUR).marker.step).toBe(1);
    });

    test('over the cap the dropped points steps move to the oldest survivor, once', () => {
        const now = Date.parse('2026-11-02T12:00:00Z');
        const points = Array.from({ length: 12_003 }, (_, i) => ({ t: now - (12_003 - i) * 600_000, total: 1000 + i }));
        points[0] = { ...points[0], marker: marker(300) };
        points[1] = { ...points[1], marker: marker(40, 'networth_includeTaskTokens') };
        const out = pruneHistory(points, now);
        expect(out).toHaveLength(12_000);
        expect(out[0].marker.step).toBe(340);
        // pruning what is already pruned adds nothing
        expect(pruneHistory(out, now)[0].marker.step).toBe(340);
    });

    test('over the cap a dropped batch that overlaps the survivor adds only what the survivor lacks', () => {
        const now = Date.parse('2026-11-02T12:00:00Z');
        const points = Array.from({ length: 12_001 }, (_, i) => ({ t: now - (12_001 - i) * 600_000, total: 1000 + i }));
        points[0] = {
            ...points[0],
            marker: {
                changes: [
                    { id: LAB, from: false, to: true, step: 400, stepCounted: 400 },
                    { id: 'networth_includeCowbells', from: false, to: true, step: 100, stepCounted: 100 },
                ],
                step: 500,
                stepCounted: 500,
                unseparated: [],
                raw: 500,
            },
        };
        points[1] = { ...points[1], marker: marker(400) };
        const out = pruneHistory(points, now);
        expect(out).toHaveLength(12_000);
        expect(out[0].marker.step).toBe(500);
        expect(pruneHistory(out, now)[0].marker.step).toBe(500);
    });
});

describe('the remembered settings follow the point to disk', () => {
    test('a save that did not land leaves the stored state alone, and the retry does not mark twice', async () => {
        await networthMovers.load('char-1');
        await take(reading(false));
        await vi.advanceTimersByTimeAsync(10_000);
        storageMock.set.mockClear();

        storageMock.set.mockImplementation(async () => {
            throw new Error('write failed');
        });
        const marked = await take(reading(true));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(marked.marker.step).toBe(400);
        expect(storageMock.set.mock.calls.some(([key]) => key === 'networthMarkerState_char-1')).toBe(false);

        // The next reading finds the in-memory marked point and does not mark the same change again
        storageMock.set.mockReset();
        const next = await take(reading(true));
        expect(next.marker).toBeUndefined();
        expect(networthHistory.history.filter((p) => p.marker)).toHaveLength(1);
    });
});

describe('exclusions and unpriced tokens', () => {
    test('a token excluded by name moves the total but not the counted line', async () => {
        await networthMovers.load('char-1');
        await take(reading(false));
        const marked = await take(reading(true, { excludedAmount: 400 }));
        expect(marked.marker.step).toBe(400);
        expect(marked.marker.stepCounted).toBe(0);
        const out = networthHistory.getGrowthHistory();
        expect(out.at(-1).total).toBe(networthHistory.history[0].total);
        expect(out.at(-1).nonExcluded).toBe(networthHistory.history.at(-1).nonExcluded);
    });

    test('switching a token on when nothing prices it is a floor, never an exact zero', async () => {
        await networthMovers.load('char-1');
        await take(reading(false, { tokenPriced: false }));
        const marked = await take(reading(true, { tokenPriced: false }));
        expect(marked.marker.step).toBe(0);
        expect(marked.marker.floor).toEqual([LAB]);
    });
});

describe('settings that cannot matter', () => {
    test('a cape-base change with no untradable cape held is neither marked nor pending', async () => {
        const data = (cape) => ({
            ...reading(false),
            valuation: { [LAB]: false, untradableCapeBaseValue: cape },
            valuationFacts: { capeHeld: false },
        });
        await networthMovers.load('char-1');
        await take(data('zero'));
        expect(networthHistory.pendingChanges(data('mirror'))).toEqual([]);
        const next = await take(data('mirror'));
        expect(next.marker).toBeUndefined();
    });
});
