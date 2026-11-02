import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback) => fallback),
        set: vi.fn(),
        delete: vi.fn(async () => true),
        getMany: vi.fn(async () => new Map()),
        getAllKeys: vi.fn(async () => []),
        tryGetAllKeys: vi.fn(async () => []),
        putAll: vi.fn(async () => 0),
        isQuotaExceeded: vi.fn(() => false),
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'char-1' } }));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => true } }));

const { default: networthHistory } = await import('./networth-history.js');
const { diffRecords } = await import('./networth-movers.js');

const marker = (step) => ({
    changes: [{ id: 'networth_includeLabyrinthTokens', from: false, to: true }],
    step,
    stepCounted: step,
    unseparated: [],
    raw: step,
});
const HOUR = 3_600_000;
const NOW = Date.now();
const p0 = { t: NOW - 4 * HOUR, total: 1000 };
const marked = { t: NOW - 3 * HOUR, total: 1400, marker: marker(400) };
const successor = { t: NOW - 2 * HOUR, total: 1450 };
const last = { t: NOW - HOUR, total: 1460 };

beforeEach(() => {
    networthHistory.characterId = 'char-1';
    networthHistory.history = [p0, marked, successor, last];
});

describe('a pull that carries a marker onto an interior point (P1)', () => {
    test('the second device takes the marked replacement and drops the deleted point', () => {
        const replacement = { ...successor, marker: marker(400) };
        networthHistory._adoptPulled('char-1', [replacement], [marked, successor]);

        expect(networthHistory.history.map((p) => p.t)).toEqual([p0.t, successor.t, last.t]);
        expect(networthHistory.history[1].marker.step).toBe(400);
        // growth still leaves the step out
        expect(networthHistory.getGrowthHistory().map((p) => p.total)).toEqual([1000, 1050, 1060]);
    });

    test('replaying the same pull changes nothing', () => {
        const replacement = { ...successor, marker: marker(400) };
        networthHistory._adoptPulled('char-1', [replacement], [marked, successor]);
        const once = JSON.stringify(networthHistory.history);
        networthHistory._adoptPulled('char-1', [replacement], [marked, successor]);
        expect(JSON.stringify(networthHistory.history)).toBe(once);
    });

    test('a replacement whose marker was merged with one the successor held is taken the same way', () => {
        networthHistory.history = [p0, marked, { ...successor, marker: marker(50) }, last];
        const merged = { ...successor, marker: { ...marker(450), changes: [...marker(1).changes] } };
        networthHistory._adoptPulled('char-1', [merged], [marked, { ...successor, marker: marker(50) }]);
        expect(networthHistory.history.map((p) => p.t)).toEqual([p0.t, successor.t, last.t]);
        expect(networthHistory.history[1].marker.step).toBe(450);
    });

    test('a changed point at a timestamp nothing removes keeps the local copy, as before', () => {
        networthHistory._adoptPulled('char-1', [{ ...successor, marker: marker(9) }], []);
        expect(networthHistory.history[2].marker).toBeUndefined();
    });

    test('a plain delete with no replacement still removes the point', () => {
        networthHistory._adoptPulled('char-1', [], [successor]);
        expect(networthHistory.history.map((p) => p.t)).toEqual([p0.t, marked.t, last.t]);
    });
});

describe('ability books held as fixed assets (P2)', () => {
    const rec = (abilities, rows, total) => ({
        total,
        nonExcluded: total,
        house: 0,
        abilities,
        shrines: null,
        pm: 'ask',
        vs: 'orderBook',
        ic: null,
        cut: 0,
        rows,
    });

    test('a 100M book change is on its row only: no abilities line, no rounding', () => {
        const prev = rec(50, [['k', '/items/book', 0, 1, 50]], 1000);
        const cur = rec(100_000_050, [['k', '/items/book', 0, 2, 100_000_050]], 150_001_000 - 0 + 0);
        cur.total = 1000 + 100_000_000;
        cur.nonExcluded = cur.total;
        const diff = diffRecords(prev, cur);
        expect(diff.top[0].delta).toBe(100_000_000);
        expect(diff.rest.abilities).toBe(0);
        expect(Math.abs(diff.rest.remainder)).toBeLessThan(1);
        expect(diff.top.reduce((s, c) => s + c.delta, 0) + diff.rest.delta).toBe(diff.totalDelta);
    });

    test('real ability cost changes still show under abilities beside a book change', () => {
        const prev = rec(1000, [['k', '/items/book', 0, 1, 400]], 5000);
        const cur = rec(1600 + 100, [['k', '/items/book', 0, 1, 500]], 5000 + 700);
        const diff = diffRecords(prev, cur);
        expect(diff.rest.abilities).toBe(600);
        expect(Math.abs(diff.rest.remainder)).toBeLessThan(1);
    });

    test('books held as inventory (rows kind h, not in abilities) are unaffected', () => {
        const prev = rec(1000, [['h', '/items/book', 0, 1, 400]], 5000);
        const cur = rec(1000, [['h', '/items/book', 0, 2, 800]], 5400);
        const diff = diffRecords(prev, cur);
        expect(diff.rest.abilities).toBe(0);
        expect(diff.top[0].delta).toBe(400);
        expect(Math.abs(diff.rest.remainder)).toBeLessThan(1);
    });

    test('switching the setting between readings still sums to the total change', () => {
        const prev = rec(1400, [['k', '/items/book', 0, 1, 400]], 5000);
        const cur = rec(1000, [['h', '/items/book', 0, 1, 400]], 5000);
        const diff = diffRecords(prev, cur);
        expect(diff.top.reduce((s, c) => s + c.delta, 0) + diff.rest.delta).toBe(diff.totalDelta);
        expect(Math.abs(diff.rest.remainder)).toBeLessThan(1);
    });
});
