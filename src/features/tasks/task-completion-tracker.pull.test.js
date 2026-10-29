/**
 * A sync pull landing on the task completion tracker: the weekly records are live-safe, so a pulled week is
 * adopted under the running page instead of latching a reload prompt.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        get: vi.fn(async (key, storeName, fallback) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
            return true;
        }),
        getMany: vi.fn(async (keys) => {
            const result = new Map();
            for (const key of keys) result.set(key, store.has(key) ? store.get(key) : null);
            return result;
        }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        // Delegates to the listing above, so a test that changes how keys are
        // listed changes both. `chunked-history.js` reads through this one
        // because an unlistable store must not read as an empty history.
        tryGetAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
});

const game = vi.hoisted(() => ({
    charId: 'cow1',
    clientData: {
        combatMonsterDetailMap: { '/monsters/jungle_sprite': { name: 'Jungle Sprite' } },
        actionDetailMap: { '/actions/milking/cow': { name: 'Cow', type: '/action_types/milking' } },
    },
    quests: [],
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));

vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.charId,
        getInitClientData: () => game.clientData,
        get characterQuests() {
            return game.quests;
        },
        on: vi.fn(),
        off: vi.fn(),
    },
}));

const trackerModule = await import('./task-completion-tracker.js');
const tracker = trackerModule.default;
const { weekChunkId, WINDOW_WEEKS } = trackerModule;
const { announceSyncPullApplied, isLiveSafeKey, mergeForKey } = await import('../../utils/sync-merge-registry.js');

const claimed = (overrides = {}) => ({
    id: 101,
    category: '/quest_category/random_task',
    status: '/quest_status/claimed',
    type: '/quest_type/action',
    actionHrid: '/actions/milking/cow',
    goalCount: 300,
    currentCount: 300,
    coinRerollCount: 0,
    cowbellRerollCount: 0,
    itemRewardsJSON: JSON.stringify([{ itemHrid: '/items/coin', count: 100 }]),
    ...overrides,
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 4, 35);
const CUT = NOW - WINDOW_WEEKS * 7 * DAY;
const done = (questId, completedAt) => ({
    questId,
    name: 'Cow',
    category: 'milking',
    tokens: 4,
    coins: 100,
    completedAt,
});
const keyFor = (t, char = 'cow1') => `taskCompletionRec_${char}_${weekChunkId(t)}`;
const pull = (keys) => announceSyncPullApplied({ rerollSpending: keys }, {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    storageMock.store.clear();
    game.charId = 'cow1';
    game.quests = [];
    tracker.forget();
    tracker.subscribers.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the weekly records on a sync pull', () => {
    test('are registered live-safe', () => {
        expect(isLiveSafeKey('rerollSpending', 'taskCompletionRec_603281_2026-W35')).toBe(true);
    });

    test('a peer that trimmed a week the window cut through changes nothing on this device', () => {
        const merge = mergeForKey('rerollSpending', 'taskCompletionRec_603281_2026-W35');
        const old = done(1, CUT - 3600_000);
        const kept = done(2, CUT + 3600_000);
        const local = [old, kept];
        expect(merge.mergeForPull(local, [kept])).toBe(local);
    });

    test('a pulled week with a new completion is adopted without a reload', async () => {
        const mine = done(1, NOW - 2 * DAY);
        storageMock.store.set(keyFor(mine.completedAt), [mine]);
        await tracker.load();
        expect(tracker.entries.map((e) => e.questId)).toEqual([1]);

        const theirs = done(2, NOW - 2 * DAY + 5000);
        storageMock.store.set(keyFor(mine.completedAt), [mine, theirs]);
        pull([keyFor(mine.completedAt)]);
        await settle();

        expect(tracker.entries.map((e) => e.questId)).toEqual([1, 2]);
        expect(tracker.recordedIds.has(2)).toBe(true);
        // A claim for it arriving now is the same task, not a second completion
        expect(tracker.ingest([claimed({ id: 2 })], NOW)).toEqual([]);
        expect((await tracker.getCompletions()).length).toBe(2);
    });

    test('the same claim recorded here and on a peer counts once', async () => {
        tracker.ingest([claimed({ id: 7 })], NOW - 1000);
        await tracker.flush();
        const wk = keyFor(NOW - 1000);
        const local = storageMock.store.get(wk);
        // The peer saw the same claim a few milliseconds later
        storageMock.store.set(wk, [...local, done(7, NOW - 990)]);
        pull([wk]);
        await settle();

        expect(tracker.entries.filter((e) => e.questId === 7)).toHaveLength(1);
        expect(tracker.rates(NOW).total.completions).toBe(1);

        // And a fresh read of what is on disk does not bring the second copy back
        await tracker.flush();
        tracker.forget();
        expect((await tracker.getCompletions()).filter((e) => e.questId === 7)).toHaveLength(1);
    });

    test('a pulled entry the window has already let go of is not adopted', async () => {
        await tracker.load();
        const weekKey = keyFor(CUT + 3600_000);
        storageMock.store.set(weekKey, [done(1, CUT - 3600_000), done(2, CUT + 3600_000)]);
        pull([weekKey]);
        await settle();

        expect(tracker.entries.map((e) => e.questId)).toEqual([2]);
    });

    test('a pull landing across a character switch is dropped', async () => {
        await tracker.load();
        game.charId = 'cow2';
        tracker.forget();
        await tracker.load();
        // The departing character's week arrives after the switch
        storageMock.store.set(keyFor(NOW - DAY), [done(5, NOW - DAY)]);
        pull([keyFor(NOW - DAY)]);
        await settle();

        // A listener call that outlived the switch, naming the departing character
        tracker._adoptPulled('cow1', [done(5, NOW - DAY)], []);

        expect(tracker.entries).toEqual([]);
        expect(tracker.recordedIds.size).toBe(0);
        // The arriving character reads its own history, not the departing one's
        expect(await tracker.getCompletions()).toEqual([]);
    });

    test('a deleted duplicate does not take the copy this device keeps with it', async () => {
        const e1 = done(7, NOW - DAY);
        const e2 = done(7, NOW - DAY + 10);
        storageMock.store.set(keyFor(e1.completedAt), [e1, e2]);
        await tracker.load();
        expect(tracker.entries).toEqual([e1]);

        // The peer's tombstone for the later duplicate reaches the store as a removal of exactly that copy
        tracker._adoptPulled('cow1', [], [e2]);
        expect(tracker.entries).toEqual([e1]);

        await tracker.flush();
        tracker.ingest([claimed({ id: 8 })], NOW - 1000);
        await tracker.flush();
        const stored = Object.entries(Object.fromEntries(storageMock.store)).filter(([k]) =>
            k.startsWith('taskCompletionRec_cow1_')
        );
        expect(stored.flatMap(([, v]) => v).map((e) => e.questId)).toContain(7);
        const tombs = JSON.stringify(
            Object.entries(Object.fromEntries(storageMock.store)).filter(([k]) => k.startsWith('taskCompletionTomb_'))
        );
        expect(tombs).not.toContain(JSON.stringify(e1).replace(/"/g, '\\"'));
        tracker.forget();
        expect((await tracker.getCompletions()).map((e) => e.questId)).toContain(7);
    });

    test('a peer deleting the only copy still removes it', async () => {
        const e1 = done(7, NOW - DAY);
        storageMock.store.set(keyFor(e1.completedAt), [e1]);
        await tracker.load();
        expect(tracker.entries).toEqual([e1]);

        tracker._adoptPulled('cow1', [], [e1]);
        expect(tracker.entries).toEqual([]);
        expect(tracker.recordedIds.has(7)).toBe(false);
    });

    test('a removal arriving during the first read is applied when it commits', async () => {
        const e1 = done(7, NOW - DAY);
        const e2 = done(8, NOW - DAY + 10);
        storageMock.store.set(keyFor(e1.completedAt), [e1, e2]);
        const loading = tracker.load();
        // The first read has not committed: the removal and an addition are parked
        tracker._adoptPulled('cow1', [done(9, NOW - DAY + 20)], [e2]);
        await loading;

        expect(tracker.entries.map((e) => e.questId)).toEqual([7, 9]);
    });

    test('a peer completion a local save finds while a pull is draining reaches memory', async () => {
        // The mock store folds like the real one: stored copies are combined under the written value
        storageMock.set.mockImplementation(async (key, value, _store, _now, options) => {
            const next = options?.fold ? options.fold(storageMock.store.get(key), value) : value;
            storageMock.store.set(key, next);
            return true;
        });
        const e1 = done(1, NOW - 2 * DAY);
        const wk = keyFor(e1.completedAt);
        storageMock.store.set(wk, [e1]);
        await tracker.load();

        // The pull has put a peer's completion on disk; the local claim saves before the pull is announced
        const e2 = done(2, NOW - 2 * DAY + 5000);
        storageMock.store.set(wk, [e1, e2]);
        tracker.ingest([claimed({ id: 3 })], NOW - 2 * DAY + 9000);
        await tracker.flush();
        pull([wk]);
        await settle();

        expect(storageMock.store.get(wk).map((e) => e.questId)).toEqual([1, 2, 3]);
        expect((await tracker.getCompletions()).map((e) => e.questId)).toEqual([1, 2, 3]);
    });
});
