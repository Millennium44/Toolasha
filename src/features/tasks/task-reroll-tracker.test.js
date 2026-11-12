/** @vitest-environment happy-dom */

/**
 * The reroll ledger is one character's spend.
 *
 * Under a bare key the market cow's gold rerolls and the iron cow's cowbell
 * rerolls landed in the same map, keyed only by task id — and task ids do not
 * say whose task they were. These cover the scoping, and the one-time adoption
 * of the pre-scoping record: a merged map cannot be partitioned after the fact,
 * so the whole of it goes to the main character rather than being split by a
 * guess or thrown away.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
}));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const mock = {
        stores,
        storeFor,
        unavailable: false,
        reset: () => {
            stores.clear();
            mock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null ? fallback : held;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (mock.unavailable) return null;
            const held = storeFor(store).get(key);
            return held === undefined || held === null
                ? { found: false, value: null }
                : { found: true, value: structuredClone(held) };
        }),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null ? fallback : held;
        }),
        // As the real one: a fold runs against what is stored when the write lands
        set: vi.fn(async (key, value, store = 'settings', _immediate = false, options = {}) => {
            if (mock.unavailable) return false;
            const held = storeFor(store).get(key);
            const next = options?.fold && held !== undefined ? options.fold(structuredClone(held), value) : value;
            storeFor(store).set(key, structuredClone(next));
            return true;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, value);
            return true;
        }),
        updateMany: async (store, keys, mutate) => {
            const map = storeFor(store);
            const values = {};
            for (const key of keys) values[key] = map.get(key);
            const entries = mutate({ ...values });
            const written = Object.keys(entries || {});
            for (const key of written) {
                map.set(key, entries[key]);
                values[key] = entries[key];
            }
            return { values, written };
        },
        delete: vi.fn(async (key, store = 'settings') => storeFor(store).delete(key)),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
    return mock;
});

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => game.gameMode,
        getInitClientData: () => ({}),
        characterData: null,
        characterQuests: [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, COLOR_TEXT_SECONDARY: '#888' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const { default: tracker, mergeLiveMap, HISTORY_CAP } = await import('./task-reroll-tracker.js');
const { default: dataManager } = await import('../../core/data-manager.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const spend = () => storageMock.storeFor('rerollSpending');

beforeEach(() => {
    storageMock.reset();
    game.characterId = 'market123';
    game.gameMode = 'standard';
    _resetAdoptionCache();
    tracker.taskRerollData.clear();
    tracker.dataRecord.reset();
    tracker.historyRecord.reset();
    tracker.knownTaskIds.clear();
    tracker.droppedTaskIds.clear();
    dataManager.characterData = null;
    dataManager.characterQuests = [];
});

/**
 * Retirement reads the live quest list.
 *
 * `characterData.characterQuests` is the array as it stood when the character
 * loaded; the claimed-quest filter rebinds `characterQuests` to a new one, so
 * the snapshot stops moving after the first claim. Reading it retired every
 * task drawn afterwards.
 */
describe('retiring tasks against the live quest list', () => {
    test('a task the snapshot never saw is not retired', async () => {
        const stale = [{ id: 1 }];
        // The character loaded with task 1; a claim rebound the live list and
        // task 7 was drawn since. The snapshot still holds only task 1.
        dataManager.characterData = { characterQuests: stale };
        dataManager.characterQuests = [{ id: 7 }];
        tracker.taskRerollData.set(7, { coinRerollCount: 3, cowbellRerollCount: 0 });

        await tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(true);
    });

    test('a task gone from the live list is still retired', async () => {
        dataManager.characterQuests = [{ id: 7 }];
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });
        tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0 });

        await tracker.cleanupOldTasks();

        expect([...tracker.taskRerollData.keys()]).toEqual([7]);
    });

    test('a task the server named moments ago survives a list that has not caught up', async () => {
        dataManager.characterQuests = [];
        tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0, seenAt: Date.now() });

        await tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(true);
    });

    test('the grace runs out, and a long-unseen task retires', async () => {
        dataManager.characterQuests = [];
        tracker.taskRerollData.set(7, {
            coinRerollCount: 1,
            cowbellRerollCount: 0,
            seenAt: Date.now() - 60 * 60 * 1000,
        });

        await tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(false);
    });

    test('no quest list at all retires nothing', async () => {
        dataManager.characterQuests = null;
        tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0 });

        await tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(true);
    });
});

describe('scoping', () => {
    test('a load reads this character’s map, not another’s', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        spend().set('taskRerollData_iron456', { 9: { coinRerollCount: 7, cowbellRerollCount: 0 } });

        await tracker.loadFromStorage();

        expect([...tracker.taskRerollData.keys()]).toEqual([1]);
    });

    test('a save writes under the key of whoever is current, resolved at write time', async () => {
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });
        await tracker.saveToStorage();

        game.characterId = 'iron456';
        tracker.taskRerollData.clear();
        tracker.taskRerollData.set(9, { coinRerollCount: 1, cowbellRerollCount: 0 });
        await tracker.saveToStorage();

        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);
        expect(Object.keys(spend().get('taskRerollData_iron456'))).toEqual(['9']);
    });

    test('the history is scoped the same way', async () => {
        await tracker.appendToHistory([{ taskId: 1, goldSpent: 10000 }]);

        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        expect(spend().has('taskRerollHistory')).toBe(false);
    });
});

describe('adopting the pre-scoping record', () => {
    test('the main character inherits the merged map exactly once', async () => {
        spend().set('taskRerollData', { 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });

        await tracker.loadFromStorage();

        expect(tracker.taskRerollData.get(1)).toEqual({ coinRerollCount: 3, cowbellRerollCount: 1 });
        expect(spend().get('taskRerollData_market123')).toEqual({ 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });
        expect(spend().has('taskRerollData')).toBe(false);
    });

    test('the history is adopted alongside it', async () => {
        spend().set('taskRerollHistory', [{ taskId: 1, goldSpent: 10000 }]);

        expect(await tracker.loadHistory()).toEqual([{ taskId: 1, goldSpent: 10000 }]);
        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        expect(spend().has('taskRerollHistory')).toBe(false);
    });

    test('an iron cow starts clean and leaves the legacy record for the main', async () => {
        game.characterId = 'iron456';
        game.gameMode = 'ironcow';
        spend().set('taskRerollData', { 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });

        await tracker.loadFromStorage();

        expect(tracker.taskRerollData.size).toBe(0);
        expect(spend().get('taskRerollData')).toEqual({ 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });
        expect(spend().has('taskRerollData_iron456')).toBe(false);
    });
});

describe('cleanup', () => {
    test('drops the map, so the next character does not save this one’s rows', () => {
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });

        tracker.cleanup();

        expect(tracker.taskRerollData.size).toBe(0);
    });
});

describe('the live map when another tab has written it', () => {
    const KEY = 'taskRerollData_market123';
    const row = (coinRerollCount, cowbellRerollCount = 0, extra = {}) => ({
        coinRerollCount,
        cowbellRerollCount,
        monsterHrid: '/monsters/jerry',
        actionHrid: '/actions/combat/jerry',
        goalCount: 100,
        ...extra,
    });
    const stored = () => spend().get(KEY);
    const loaded = async (map) => {
        spend().set(KEY, map);
        await tracker.loadFromStorage();
    };

    test('a stale tab adding its own task keeps the task the other tab added', async () => {
        await loaded({ 1: row(1) });
        // The other tab draws task 2 and saves; this one has not heard
        spend().set(KEY, { 1: row(1), 2: row(3) });

        tracker.taskRerollData.set(5, row(1));
        await tracker.saveToStorage();

        expect(Object.keys(stored())).toEqual(['1', '2', '5']);
        expect(stored()[2].coinRerollCount).toBe(3);
    });

    test('what it finds it takes in, so the badge reads the other tab’s spend', async () => {
        await loaded({ 1: row(1) });
        spend().set(KEY, { 1: row(4, 2), 2: row(3) });

        tracker.taskRerollData.set(5, row(1));
        await tracker.saveToStorage();

        expect(tracker.taskRerollData.get(2).coinRerollCount).toBe(3);
        expect(tracker.taskRerollData.get(1)).toMatchObject({ coinRerollCount: 4, cowbellRerollCount: 2 });
    });

    test('the same task in both: the higher count of each kind stands, whichever tab saved last', () => {
        const a = { 7: row(5, 0, { seenAt: 100 }) };
        const b = { 7: row(2, 3, { seenAt: 200 }) };
        for (const merged of [mergeLiveMap(a, b), mergeLiveMap(b, a)]) {
            expect(merged[7]).toMatchObject({ coinRerollCount: 5, cowbellRerollCount: 3, seenAt: 200 });
        }
    });

    test('a task this tab retired is not brought back by the other tab’s stale copy', async () => {
        await loaded({ 1: row(1), 2: row(2) });
        dataManager.characterQuests = [{ id: 2 }];
        await tracker.cleanupOldTasks();
        await vi.waitFor(() => expect(stored()[1]).toBeUndefined());

        // The stale tab, still holding the retired task, writes its whole copy
        spend().set(KEY, { 1: row(1), 2: row(2) });
        tracker.taskRerollData.get(2).coinRerollCount = 3;
        await tracker.saveToStorage();

        expect(Object.keys(stored())).toEqual(['2']);
        expect(stored()[2].coinRerollCount).toBe(3);
        expect(tracker.taskRerollData.has(1)).toBe(false);
    });

    test('a task retired here and then named by the server again goes back on the map', async () => {
        await loaded({ 1: row(1) });
        tracker.taskRerollData.delete(1);
        await tracker.saveToStorage();
        expect(stored()[1]).toBeUndefined();

        tracker.taskRerollData.set(1, row(2));
        await tracker.saveToStorage();
        expect(stored()[1].coinRerollCount).toBe(2);
        // ...and a later copy of it is not treated as dropped
        spend().set(KEY, { 1: row(6) });
        await tracker.saveToStorage();
        expect(stored()[1].coinRerollCount).toBe(6);
    });

    test('another tab retiring a task this one still holds: it stays until this tab retires it too', async () => {
        await loaded({ 1: row(1), 2: row(2) });
        spend().set(KEY, { 2: row(2) });

        await tracker.saveToStorage();
        expect(Object.keys(stored())).toEqual(['1', '2']);

        dataManager.characterQuests = [{ id: 2 }];
        await tracker.cleanupOldTasks();
        await vi.waitFor(() => expect(Object.keys(stored())).toEqual(['2']));
    });

    test('a pull from another device: this device’s next save folds it, and a replay changes nothing', async () => {
        await loaded({ 1: row(1) });
        // A pull writes the other device's whole map under the running page
        const pulled = { 1: row(3), 9: row(1, 4) };
        spend().set(KEY, pulled);

        await tracker.saveToStorage();
        const once = structuredClone(stored());
        expect(once).toMatchObject({ 1: { coinRerollCount: 3 }, 9: { cowbellRerollCount: 4 } });

        spend().set(KEY, pulled);
        await tracker.saveToStorage();
        expect(stored()).toEqual(once);
        await tracker.saveToStorage();
        expect(stored()).toEqual(once);
    });

    test('an edit followed by new data: a rise after the fold is kept, and an older copy cannot lower it', async () => {
        await loaded({ 1: row(1) });
        spend().set(KEY, { 1: row(3) });
        await tracker.saveToStorage();

        tracker.taskRerollData.get(1).coinRerollCount = 8;
        await tracker.saveToStorage();
        spend().set(KEY, { 1: row(3) });
        await tracker.saveToStorage();
        expect(stored()[1].coinRerollCount).toBe(8);
    });

    test('a write that lands between this tab’s read and its write is folded in the transaction', async () => {
        await loaded({ 1: row(1) });
        const { tryGet } = storageMock;
        const pass = tryGet.getMockImplementation();
        tryGet.mockImplementationOnce(async (...args) => {
            const answer = await pass(...args);
            spend().set(KEY, { 1: row(1), 2: row(5) });
            return answer;
        });

        tracker.taskRerollData.set(3, row(1));
        await tracker.saveToStorage();
        expect(Object.keys(stored())).toEqual(['1', '2', '3']);
    });

    test('nothing stored, an empty map and a refused save each leave what they should', async () => {
        await tracker.loadFromStorage();
        await tracker.saveToStorage();
        expect(stored()).toEqual({});

        tracker.taskRerollData.set(1, row(1));
        storageMock.unavailable = true;
        await tracker.saveToStorage();
        expect(stored()).toEqual({});
        expect(tracker.taskRerollData.get(1).coinRerollCount).toBe(1);
        storageMock.unavailable = false;
    });

    test('a character switch forgets what the departing character dropped', async () => {
        await loaded({ 1: row(1) });
        tracker.taskRerollData.delete(1);
        await tracker.saveToStorage();
        expect(tracker.droppedTaskIds.has('1')).toBe(true);

        tracker.cleanup();
        expect(tracker.droppedTaskIds.size).toBe(0);
        expect(tracker.knownTaskIds.size).toBe(0);

        // The arriving character happens to hold the same id: its row is its own
        game.characterId = 'iron456';
        spend().set('taskRerollData_iron456', { 1: row(9) });
        await tracker.loadFromStorage();
        await tracker.saveToStorage();
        expect(spend().get('taskRerollData_iron456')[1].coinRerollCount).toBe(9);
    });
});

describe('the stored records survive a read that cannot be made', () => {
    test('a load while storage is unreadable keeps the map in hand, not an empty one', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        tracker.taskRerollData.set(5, { coinRerollCount: 1, cowbellRerollCount: 0 });
        storageMock.unavailable = true;

        await tracker.loadFromStorage();

        expect([...tracker.taskRerollData.keys()]).toEqual([5]);
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);
    });

    test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        storageMock.unavailable = true;
        tracker.taskRerollData.set(5, { coinRerollCount: 1, cowbellRerollCount: 0 });

        await tracker.saveToStorage();
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);

        storageMock.unavailable = false;
        await tracker.saveToStorage();
        // Never read back, so the stored row is kept alongside the new one
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1', '5']);
    });

    test('once read back, a task dropped from the map stays dropped', async () => {
        spend().set('taskRerollData_market123', {
            1: { coinRerollCount: 2, cowbellRerollCount: 0 },
            2: { coinRerollCount: 1, cowbellRerollCount: 0 },
        });
        await tracker.loadFromStorage();
        tracker.taskRerollData.delete(1);

        await tracker.saveToStorage();
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['2']);
    });

    test('an append to the history folds in what another tab retired, by task', async () => {
        await tracker.appendToHistory([{ taskId: 1, retiredAt: 10, goldSpent: 100 }]);
        spend().set('taskRerollHistory_market123', [
            { taskId: 1, retiredAt: 10, goldSpent: 100 },
            { taskId: 2, retiredAt: 20, goldSpent: 200 },
        ]);

        await tracker.appendToHistory([{ taskId: 3, retiredAt: 30, goldSpent: 300 }]);

        expect(
            spend()
                .get('taskRerollHistory_market123')
                .map((entry) => entry.taskId)
        ).toEqual([1, 2, 3]);
        expect(await tracker.loadHistory()).toHaveLength(3);
    });

    test('a strict load tells a history it could not read from one with no rerolls in it', async () => {
        spend().set('taskRerollHistory_market123', [{ taskId: 1, retiredAt: 10, goldSpent: 100 }]);
        storageMock.unavailable = true;

        expect(await tracker.loadHistory({ strict: true })).toBeNull();
        // The plain load keeps its old answer for callers that only list
        expect(await tracker.loadHistory()).toEqual([]);

        storageMock.unavailable = false;
        expect(await tracker.loadHistory({ strict: true })).toHaveLength(1);
        // Once read, a later hiccup still answers with what is held
        storageMock.unavailable = true;
        expect(await tracker.loadHistory({ strict: true })).toHaveLength(1);
    });

    test('a history that is genuinely empty is an empty list, not an unreadable one', async () => {
        expect(await tracker.loadHistory({ strict: true })).toEqual([]);
    });

    test('an append while storage is unreadable is kept in hand and lands with the next one', async () => {
        spend().set('taskRerollHistory_market123', [{ taskId: 1, retiredAt: 10, goldSpent: 100 }]);
        storageMock.unavailable = true;

        await tracker.appendToHistory([{ taskId: 2, retiredAt: 20, goldSpent: 200 }]);
        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        // And a read that cannot be made does not hand back an empty history
        expect((await tracker.loadHistory()).map((entry) => entry.taskId)).toEqual([2]);

        storageMock.unavailable = false;
        await tracker.appendToHistory([{ taskId: 3, retiredAt: 30, goldSpent: 300 }]);
        expect(
            spend()
                .get('taskRerollHistory_market123')
                .map((entry) => entry.taskId)
        ).toEqual([1, 2, 3]);
    });

    test('the history stays capped after a fold', async () => {
        const many = Array.from({ length: HISTORY_CAP }, (_, i) => ({ taskId: i + 1, retiredAt: i + 1 }));
        spend().set('taskRerollHistory_market123', many);

        await tracker.appendToHistory([{ taskId: 90001, retiredAt: 90001 }]);

        const saved = spend().get('taskRerollHistory_market123');
        expect(saved).toHaveLength(HISTORY_CAP);
        expect(saved.at(-1).taskId).toBe(90001);
        expect(saved[0].taskId).toBe(2);
    });

    test('eight weeks of a heavy rerolling day (twenty tasks retired a day) fit without losing a row', async () => {
        // The completion tracker keeps eight weeks of claims; a history shorter than that leaves the oldest
        // claims with no spend to net against
        expect(HISTORY_CAP).toBeGreaterThanOrEqual(8 * 7 * 20);
        const rows = Array.from({ length: 8 * 7 * 20 }, (_, i) => ({
            taskId: i + 1,
            retiredAt: i + 1,
            goldSpent: 10000,
        }));
        spend().set('taskRerollHistory_market123', rows.slice(0, -1));

        await tracker.appendToHistory([rows.at(-1)]);

        const saved = spend().get('taskRerollHistory_market123');
        expect(saved).toHaveLength(rows.length);
        expect(saved[0].taskId).toBe(1);
    });

    test('an exact-cap list plus a duplicate of an old row keeps its length and its newest rows', async () => {
        const full = Array.from({ length: HISTORY_CAP }, (_, i) => ({ taskId: i + 1, retiredAt: i + 1, goldSpent: 1 }));
        spend().set('taskRerollHistory_market123', full);

        await tracker.appendToHistory([{ taskId: 1, retiredAt: 1, goldSpent: 5 }]);

        const saved = spend().get('taskRerollHistory_market123');
        expect(saved).toHaveLength(HISTORY_CAP);
        expect(saved[0]).toMatchObject({ taskId: 1, goldSpent: 5 });
    });

    test('an empty history takes its first row', async () => {
        await tracker.appendToHistory([{ taskId: 1, retiredAt: 1 }]);
        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
    });
});

describe('a cross-device sync pull combines the retired-task history', () => {
    test('the registered merge is the union by task, not the downloaded copy', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

        // Both key shapes the record can be stored under: the scoped one every
        // account writes today, and the bare pre-scoping key still sitting on
        // accounts that never triggered the adoption
        for (const key of ['taskRerollHistory', 'taskRerollHistory_market123']) {
            const registration = mergeForKey('rerollSpending', key);
            expect(registration, `rerollSpending/${key} has no sync merge`).toBeTruthy();

            // This device retired task 1; the phone retired task 2. A whole-key
            // write would leave the pull with only the phone's row, and the
            // gold spent on task 1 would simply stop having been spent
            const local = [{ taskId: 1, retiredAt: 10, goldSpent: 10000 }];
            const incoming = [{ taskId: 2, retiredAt: 20, goldSpent: 20000 }];

            expect(registration.merge(local, incoming).map((entry) => entry.taskId)).toEqual([1, 2]);
        }
    });

    describe('one task on two rows', () => {
        const row = (over) => ({
            taskId: 1,
            retiredAt: 100,
            coinRerollCount: 5,
            cowbellRerollCount: 0,
            goldSpent: 310000,
            cowbellsSpent: 0,
            monsterHrid: '/monsters/jerry',
            actionHrid: '/actions/combat/jerry',
            goalCount: 100,
            ...over,
        });
        const seenAgain = row({
            retiredAt: 900,
            coinRerollCount: 2,
            cowbellRerollCount: 1,
            goldSpent: 30000,
            cowbellsSpent: 1,
        });
        const kept = row({ cowbellRerollCount: 1, cowbellsSpent: 1 });

        const merge = async () => {
            const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
            return mergeForKey('rerollSpending', 'taskRerollHistory_market123').merge;
        };

        test('the highest counts and the earliest time stand, whichever copy is which', async () => {
            const fold = await merge();
            expect(fold([row()], [seenAgain])).toEqual([kept]);
            expect(fold([seenAgain], [row()])).toEqual([kept]);
        });

        test('a replay, and a third device, change nothing more', async () => {
            const fold = await merge();
            const once = fold([row()], [seenAgain]);
            expect(fold(once, [seenAgain])).toEqual(once);
            expect(fold(once, once)).toEqual(once);
            expect(fold(once, [row({ retiredAt: 50, coinRerollCount: 1, goldSpent: 10000 })])[0]).toMatchObject({
                retiredAt: 50,
                coinRerollCount: 5,
                goldSpent: 310000,
            });
        });

        test('new data after: a row with more spend than the fold raises it and keeps the first time', async () => {
            const fold = await merge();
            const once = fold([row()], [seenAgain]);
            expect(fold(once, [row({ retiredAt: 950, coinRerollCount: 6, goldSpent: 630000 })])[0]).toMatchObject({
                retiredAt: 100,
                coinRerollCount: 6,
                goldSpent: 630000,
            });
        });

        test('a row with no time, or a blank name, does not wipe what the other holds', async () => {
            const fold = await merge();
            const [merged] = fold([row()], [{ taskId: 1, monsterHrid: '', actionHrid: '', goalCount: 0 }]);
            expect(merged).toEqual(row());
        });

        test('a retired task a stale copy brought back does not lower its row when it retires again', async () => {
            spend().set('taskRerollHistory_market123', [row()]);
            spend().set('taskRerollData_market123', {});
            await tracker.loadFromStorage();
            await tracker.loadHistory();

            // A stale pull puts the task back on the map with its old, lower count
            spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
            tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0, seenAt: Date.now() });
            await tracker.saveToStorage();
            expect(tracker.taskRerollData.get(1).coinRerollCount).toBe(2);

            dataManager.characterQuests = [{ id: 7 }];
            await tracker.cleanupOldTasks();
            await tracker.historyRecord.flushed();

            const [saved] = spend().get('taskRerollHistory_market123');
            expect(saved).toMatchObject({ taskId: 1, retiredAt: 100, coinRerollCount: 5, goldSpent: 310000 });
            expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        });

        test('a different task is untouched, and order stays oldest first', async () => {
            const fold = await merge();
            const merged = fold([row({ taskId: 2, retiredAt: 500 })], [seenAgain, row()]);
            expect(merged.map((entry) => entry.taskId)).toEqual([1, 2]);
            expect(merged[0].retiredAt).toBe(100);
        });
    });

    test('the live reroll map is deliberately not merged', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        // Curated: a task is dropped from it on purpose when it retires, so a
        // union would resurrect rows the tracker has finished with
        expect(mergeForKey('rerollSpending', 'taskRerollData_market123')).toBeNull();
    });
});

describe('retiring a task is a durable move', () => {
    const LIVE = 'taskRerollData_market123';
    const HISTORY = 'taskRerollHistory_market123';
    const originalSet = storageMock.set.getMockImplementation();
    afterEach(() => storageMock.set.mockImplementation(originalSet));
    const live = () => spend().get(LIVE);
    const history = () => spend().get(HISTORY);
    const task = (coin, extra = {}) => ({ coinRerollCount: coin, cowbellRerollCount: 0, actionHrid: '/a', ...extra });

    /** Writes to the history key return false and store nothing, until `heal()` */
    const failHistoryWrites = () => {
        const real = originalSet;
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (key === HISTORY) return false;
            return real(key, ...rest);
        });
        return () => storageMock.set.mockImplementation(real);
    };

    beforeEach(async () => {
        spend().set(LIVE, { 7: task(2), 8: task(1), 9: task(3) });
        await tracker.loadFromStorage();
        dataManager.characterQuests = [{ id: 9 }];
    });

    test('a failed history write keeps the task on the live map and in storage', async () => {
        failHistoryWrites();
        await tracker.cleanupOldTasks();

        expect([...tracker.taskRerollData.keys()].sort()).toEqual([7, 8, 9]);
        expect(Object.keys(live()).sort()).toEqual(['7', '8', '9']);
        expect(history()).toBeUndefined();
    });

    test('the retry after recovery moves every task once, with the spend unchanged', async () => {
        const heal = failHistoryWrites();
        await tracker.cleanupOldTasks();
        heal();
        await tracker.cleanupOldTasks();
        await tracker.cleanupOldTasks();

        expect(Object.keys(live())).toEqual(['9']);
        expect(
            history()
                .map((entry) => entry.taskId)
                .sort()
        ).toEqual([7, 8]);
        expect(history().find((entry) => entry.taskId === 7)).toMatchObject({ coinRerollCount: 2, goldSpent: 30000 });
    });

    test('disable between the failed write and a retry loses nothing already saved', async () => {
        failHistoryWrites();
        await tracker.cleanupOldTasks();
        tracker.disable();

        expect(Object.keys(live()).sort()).toEqual(['7', '8', '9']);
    });

    test('a disable while the history write is out leaves the live rows alone', async () => {
        const release = {};
        const real = originalSet;
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (key === HISTORY) await new Promise((resolve) => (release.go = resolve));
            return real(key, ...rest);
        });
        const pending = tracker.cleanupOldTasks();
        await vi.waitFor(() => expect(release.go).toBeTypeOf('function'));
        tracker.disable();
        release.go();
        await pending;

        expect(Object.keys(live()).sort()).toEqual(['7', '8', '9']);
        expect(
            history()
                .map((entry) => entry.taskId)
                .sort()
        ).toEqual([7, 8]);
    });

    test('a second cleanup while the first is out does not queue the same rows again', async () => {
        const release = {};
        const real = originalSet;
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (key === HISTORY) await new Promise((resolve) => (release.go = resolve));
            return real(key, ...rest);
        });
        const first = tracker.cleanupOldTasks();
        await vi.waitFor(() => expect(release.go).toBeTypeOf('function'));
        await tracker.cleanupOldTasks();
        release.go();
        await first;

        expect(storageMock.set.mock.calls.filter(([key]) => key === HISTORY)).toHaveLength(1);
        expect(history()).toHaveLength(2);
    });

    test('a task counted again while the write was out stays on the map', async () => {
        const release = {};
        const real = originalSet;
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (key === HISTORY) await new Promise((resolve) => (release.go = resolve));
            return real(key, ...rest);
        });
        const pending = tracker.cleanupOldTasks();
        await vi.waitFor(() => expect(release.go).toBeTypeOf('function'));
        tracker.taskRerollData.get(7).coinRerollCount = 3;
        release.go();
        await pending;

        expect([...tracker.taskRerollData.keys()].sort()).toEqual([7, 9]);
        expect(live()[7].coinRerollCount).toBe(3);
    });

    test('nothing to retire writes nothing', async () => {
        dataManager.characterQuests = [{ id: 7 }, { id: 8 }, { id: 9 }];
        await tracker.cleanupOldTasks();
        expect(history()).toBeUndefined();
        expect(Object.keys(live()).sort()).toEqual(['7', '8', '9']);
    });
});
