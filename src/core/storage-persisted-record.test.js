/**
 * A threeWay curated record run through the real Storage: the probe, the debounce and the fold that
 * lands the write, against a hand-rolled fake IDBDatabase (fake-indexeddb is not set up here). The
 * record's own suite uses a storage double whose `set` folds at once; this one holds the write for
 * the real debounce window, which is where another tab's commit can land in between.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const character = vi.hoisted(() => ({ id: 'A' }));
vi.mock('./data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentCharacterName: () => 'Main',
        on: () => {},
    },
}));
vi.mock('../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'A',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: storage } = await import('./storage.js');
const { createCuratedRecord, mergeById } = await import('../utils/persisted-record.js');
const { mergePins } = await import('../utils/item-picker-pins.js');
const { mergeWatchlists, entryKey, WATCHLIST_KEY } = await import('../utils/watchlist.js');
const { addGoal, removeGoal, loadGoals, _resetGoalsRecord, GOALS_KEY, MAX_GOALS } =
    await import('../features/planner/goal-planner-store.js');

/**
 * A fake IDBDatabase over one object store. Values are copied on the way in and out, as IndexedDB
 * does, so a record's live memory is never what "storage" holds.
 * @param {Record<string, *>} initial - Seed values by key
 * @returns {{db: object, data: Map<string, *>, holds: {start: ?Promise, answer: ?Promise}}} The fake, its backing
 *   data, and what it is waiting on: `start` stops a transaction before it reads or writes anything, `answer` lets
 *   it reach the data and stops it reporting (a write that commits but whose report comes too late)
 */
function createFakeDb(initial) {
    const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
    const holds = { start: null, answer: null };
    const db = {
        objectStoreNames: ['settings'],
        transaction() {
            const queue = [];
            const txn = { oncomplete: null, onerror: null, onabort: null };
            const store = {
                get(key) {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    queue.push(() => {
                        request.result = data.has(key) ? structuredClone(data.get(key)) : undefined;
                        request.onsuccess?.();
                    });
                    return request;
                },
                put(value, key) {
                    const request = { onsuccess: null, onerror: null };
                    queue.push(() => {
                        data.set(key, structuredClone(value));
                        request.onsuccess?.();
                    });
                    return request;
                },
                delete(key) {
                    const request = { onsuccess: null, onerror: null };
                    queue.push(() => {
                        data.delete(key);
                        request.onsuccess?.();
                    });
                    return request;
                },
            };
            const answer = async () => {
                if (holds.answer) await holds.answer;
                txn.oncomplete?.();
            };
            const run = () => {
                // A request may queue another (a fold's put follows its get), so drain until empty
                while (queue.length > 0) queue.shift()();
                queueMicrotask(answer);
            };
            if (holds.start) holds.start.then(run);
            else queueMicrotask(run);
            return {
                ...txn,
                objectStore: () => store,
                set oncomplete(fn) {
                    txn.oncomplete = fn;
                },
                set onerror(fn) {
                    txn.onerror = fn;
                },
                set onabort(fn) {
                    txn.onabort = fn;
                },
            };
        },
    };
    return { db, data, holds };
}

const KEY = 'fav';
const tab = () => createCuratedRecord({ base: KEY, scoped: false, empty: () => ({}), threeWay: true, label: 'Test' });

/**
 * Run a save through the debounce window and the write that ends it.
 * @param {Promise<boolean>} pending - The record's save
 * @returns {Promise<boolean>} Whether it landed
 */
async function landed(pending) {
    await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
    return pending;
}

describe('a threeWay record through the real debounced fold', () => {
    let data;

    beforeEach(() => {
        vi.useFakeTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        const fake = createFakeDb({ [KEY]: { milk: true } });
        storage.db = fake.db;
        data = fake.data;
    });

    afterEach(() => {
        vi.useRealTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        storage.db = null;
    });

    test('what another tab commits inside the debounce window is kept, and so is its later removal', async () => {
        const a = tab();
        const b = tab();
        await a.load();
        await b.load();

        // a's save is held for the debounce; another tab commits meanwhile
        a.get().eggs = true;
        const first = a.save();
        await vi.advanceTimersByTimeAsync(10);
        data.set(KEY, { milk: true, butter: true });
        expect(await landed(first)).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true });

        // The other tab removes butter; a's next, unrelated edit must not bring it back
        data.set(KEY, { milk: true, eggs: true });
        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, eggs: true, jam: true });
    });

    test('what another tab commits inside the debounce window survives every later save of this tab', async () => {
        const a = tab();
        await a.load();

        a.get().eggs = true;
        const first = a.save();
        await vi.advanceTimersByTimeAsync(10);
        data.set(KEY, { milk: true, butter: true });
        expect(await landed(first)).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true });

        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true, jam: true });
    });

    test('an owner holding its own state: the same, committed before the save or inside its window', async () => {
        const record = tab();
        await record.load();
        const state = { ...record.get() };
        const save = () => {
            record.set({ ...state });
            return record.save();
        };
        data.set(KEY, { milk: true, butter: true });

        state.eggs = true;
        const first = save();
        await vi.advanceTimersByTimeAsync(10);
        data.set(KEY, { milk: true, butter: true, tea: true });
        expect(await landed(first)).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, tea: true, eggs: true });

        state.jam = true;
        expect(await landed(save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, tea: true, eggs: true, jam: true });

        // Its own removal still goes through, and leaves the other tab's items alone
        delete state.milk;
        expect(await landed(save())).toBe(true);
        expect(data.get(KEY)).toEqual({ butter: true, tea: true, eggs: true, jam: true });
    });

    test('a write that fails keeps the edit, and the next save still keeps what the other tab added', async () => {
        const a = tab();
        await a.load();
        data.set(KEY, { milk: true, butter: true });

        // The write's transaction is refused
        const transaction = storage.db.transaction;
        let opened = 0;
        storage.db.transaction = function (...args) {
            opened += 1;
            if (opened === 1) throw new Error('refused');
            return transaction.apply(this, args);
        };
        a.get().eggs = true;
        expect(await landed(a.save())).toBe(false);
        storage.db.transaction = transaction;
        expect(data.get(KEY)).toEqual({ milk: true, butter: true });

        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true, jam: true });

        a.get().tea = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true, jam: true, tea: true });
    });

    test('an item the other tab added and later removed is not revived by this tab, which never held it', async () => {
        const a = tab();
        const b = tab();
        await a.load();
        await b.load();

        b.get().butter = true;
        expect(await landed(b.save())).toBe(true);
        a.get().eggs = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true });
        expect(a.get()).toEqual({ milk: true, eggs: true });

        await b.load({ authoritative: true });
        delete b.get().butter;
        expect(await landed(b.save())).toBe(true);
        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, eggs: true, jam: true });
    });
});

describe('a threeWay record whose save has not landed yet', () => {
    const PINS_A = 'pins_A';
    const PINS_B = 'pins_B';
    const GOALS_A = `${GOALS_KEY}_A`;
    const pinsTab = () =>
        createCuratedRecord({
            base: 'pins',
            empty: () => ({}),
            merge: mergePins,
            threeWay: { idOf: (hrid) => hrid },
            label: 'Test',
        });
    /** As the item pins read theirs: a reset, a load, and the list adopted */
    const readPins = async (record) => {
        record.reset();
        await record.load();
        return record.get().act || [];
    };
    /** As the item pins write theirs: a fresh copy handed over, nobody waiting for the debounce */
    const writePins = (record, list) => {
        record.set({ act: [...list] });
        return record.save();
    };
    const pinned = (key) => data.get(key)?.act;
    const goal = (id, amount) => ({ id, type: 'gold', amount, createdAt: amount });
    const goalAmounts = () => data.get(GOALS_A).map((entry) => entry.amount);
    /** A player's press: it starts, and the debounce it waits on does not hold up the next press */
    const press = async (action) => {
        const pressed = action();
        await vi.advanceTimersByTimeAsync(5);
        return pressed;
    };
    const settle = async () => {
        // A landing could wake a save behind it, which has a debounce of its own
        for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
    };
    /** Refuse the next transaction anything opens */
    const refuseNextTransaction = () => {
        const transaction = storage.db.transaction;
        storage.db.transaction = function () {
            storage.db.transaction = transaction;
            throw new Error('refused');
        };
    };

    let data;
    let holds;
    const seed = (values) => {
        const fake = createFakeDb(values);
        storage.db = fake.db;
        data = fake.data;
        holds = fake.holds;
    };
    /**
     * The next read of the record is made now and delivered when released, so that what it says is
     * older than what happens in between. Storage is real for everything else.
     * @param {string} key - What it reads
     * @param {boolean} [readable=true] - False for a read that could not be made
     * @returns {() => void} Delivers it
     */
    const holdNextRead = (key, readable = true) => {
        const found = data.has(key);
        const snapshot = found ? { found, value: structuredClone(data.get(key)) } : { found, value: null };
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const spy = vi.spyOn(storage, 'tryGet').mockImplementationOnce(async () => {
            spy.mockRestore();
            await gate;
            return readable ? snapshot : null;
        });
        return release;
    };
    /**
     * Hold every transaction opened from now on at one of the fake's two points.
     * @param {'start'|'answer'} point
     * @returns {() => void} Lets them go
     */
    const hold = (point) => {
        let release;
        holds[point] = new Promise((resolve) => {
            release = () => {
                holds[point] = null;
                resolve();
            };
        });
        return release;
    };
    /** The debounce runs out, and the write it starts is refused */
    const writeIsRefused = async () => {
        refuseNextTransaction();
        await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
    };

    const writeTimeoutMs = storage.writeTimeoutMs;

    beforeEach(() => {
        vi.useFakeTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        storage._flushFailures.clear();
        character.id = 'A';
        _resetGoalsRecord();
    });

    afterEach(() => {
        vi.useRealTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        storage._flushFailures.clear();
        storage.writeTimeoutMs = writeTimeoutMs;
        storage.db = null;
    });

    describe('a switch inside an unreadable goals read', () => {
        const GOALS_B = `${GOALS_KEY}_B`;

        test("the departed character's list is not put back into the new character's record", async () => {
            seed({ [GOALS_A]: [goal('a1', 1)], [GOALS_B]: [goal('b1', 2)] });
            await loadGoals();

            const releaseA = holdNextRead(GOALS_A, false);
            const loadingA = loadGoals();
            await vi.advanceTimersByTimeAsync(5);
            const releaseB = holdNextRead(GOALS_B);
            character.id = 'B';
            const loadingB = loadGoals();
            await vi.advanceTimersByTimeAsync(5);
            // A's read comes back unreadable after the switch, while B's is still on its way
            releaseA();
            await vi.advanceTimersByTimeAsync(5);
            await loadingA;
            releaseB();
            await vi.advanceTimersByTimeAsync(5);
            expect((await loadingB).map((entry) => entry.amount)).toEqual([2]);

            press(() => addGoal(goal('b2', 3)));
            await settle();
            expect(data.get(GOALS_B).map((entry) => entry.amount)).toEqual([2, 3]);
            expect(data.get(GOALS_A).map((entry) => entry.amount)).toEqual([1]);
        });

        test('a list that really is unreadable for the same character keeps what was held', async () => {
            seed({ [GOALS_A]: [goal('a1', 1)] });
            await loadGoals();

            holdNextRead(GOALS_A, false)();
            expect((await loadGoals()).map((entry) => entry.amount)).toEqual([1]);
        });
    });

    describe('across a character switch', () => {
        test('two pins, then a switch to a character with the second pinned: each list keeps its own', async () => {
            seed({ [PINS_A]: { act: ['a'] }, [PINS_B]: { act: ['z'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['a', 'y']);
            await vi.advanceTimersByTimeAsync(1000);
            writePins(record, ['a', 'y', 'z']);
            await vi.advanceTimersByTimeAsync(10);

            // What the switch does: it flushes storage, moves the character, and the owner reads again
            await storage.flushAll();
            character.id = 'B';
            expect(await readPins(record)).toEqual(['z']);
            await settle();

            expect(pinned(PINS_A)).toEqual(['a', 'y', 'z']);
            expect(pinned(PINS_B)).toEqual(['z']);
        });

        test('a save queued when the arriving character loads lands on its own key, against its own copy', async () => {
            seed({ [PINS_A]: { act: ['a', 'r'] }, [PINS_B]: { act: ['a', 'r', 'z'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['a', 'y']);
            await vi.advanceTimersByTimeAsync(10);

            // No flush at all: the arriving character reads while the departing save waits
            character.id = 'B';
            expect(await readPins(record)).toEqual(['a', 'r', 'z']);
            await settle();

            expect(pinned(PINS_A)).toEqual(['a', 'y']);
            expect(pinned(PINS_B)).toEqual(['a', 'r', 'z']);

            // And the arriving character's own edit reads against the arriving character's copy
            writePins(record, ['a', 'r', 'z', 'q']);
            await settle();
            expect(pinned(PINS_B)).toEqual(['a', 'r', 'z', 'q']);
            expect(pinned(PINS_A)).toEqual(['a', 'y']);
        });

        test('a pin pressed after the character moved, before the next read, stays with its own list', async () => {
            seed({ [PINS_A]: { act: ['a'] }, [PINS_B]: { act: ['z'] } });
            const record = pinsTab();
            await readPins(record);
            character.id = 'B';
            writePins(record, ['a', 'y']);
            await settle();

            expect(pinned(PINS_A)).toEqual(['a', 'y']);
            expect(pinned(PINS_B)).toEqual(['z']);
        });

        test('a write that failed before the switch lands later on its own key', async () => {
            seed({ [PINS_A]: { act: ['a'] }, [PINS_B]: { act: ['z'] } });
            const record = pinsTab();
            await readPins(record);
            refuseNextTransaction();
            const failed = writePins(record, ['a', 'y']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
            expect(await failed).toBe(false);
            expect(pinned(PINS_A)).toEqual(['a']);

            character.id = 'B';
            expect(await readPins(record)).toEqual(['z']);
            await storage.flushAll();

            expect(pinned(PINS_A)).toEqual(['a', 'y']);
            expect(pinned(PINS_B)).toEqual(['z']);
        });

        test('a save asked after the reset, on the same key, does not drop the one still waiting there', async () => {
            seed({ [PINS_A]: { act: ['a'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['a', 'y']);
            await vi.advanceTimersByTimeAsync(10);

            // The watchlist resets in the switch's cleanup; a write in that gap holds only the emptied list
            record.reset();
            writePins(record, ['q']);
            await settle();

            expect(pinned(PINS_A).sort()).toEqual(['a', 'q', 'y']);
        });

        test('coming back to the character whose save still waits shows it, and loses nothing', async () => {
            seed({ [PINS_A]: { act: ['a'] }, [PINS_B]: { act: ['z'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['a', 'y']);
            await vi.advanceTimersByTimeAsync(10);

            character.id = 'B';
            await readPins(record);
            character.id = 'A';
            expect(await readPins(record)).toEqual(['a', 'y']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['a', 'y']);
            expect(pinned(PINS_B)).toEqual(['z']);
        });
    });

    describe('in the same tab, through the goal planner', () => {
        const stored = () => [goal('s', 1)];

        test('add, add, then add again after the first landed: all three stand', async () => {
            seed({ [GOALS_A]: stored() });
            press(() => addGoal(goal('x', 10)));
            await vi.advanceTimersByTimeAsync(1000);
            press(() => addGoal(goal('y', 20)));
            await vi.advanceTimersByTimeAsync(2500);
            const view = press(() => addGoal(goal('z', 30)));
            await settle();

            expect(goalAmounts()).toEqual([1, 10, 20, 30]);
            expect((await view).map((entry) => entry.amount)).toEqual([1, 10, 20, 30]);
        });

        test('add, add: the second press sees the first, and both land', async () => {
            seed({ [GOALS_A]: stored() });
            press(() => addGoal(goal('x', 10)));
            await vi.advanceTimersByTimeAsync(1000);
            const view = press(() => addGoal(goal('y', 20)));
            await settle();

            expect((await view).map((entry) => entry.amount)).toEqual([1, 10, 20]);
            expect(goalAmounts()).toEqual([1, 10, 20]);
        });

        test('add, add, then remove something else after the first landed: both adds stand', async () => {
            seed({ [GOALS_A]: [...stored(), goal('r', 2)] });
            press(() => addGoal(goal('x', 10)));
            await vi.advanceTimersByTimeAsync(1000);
            press(() => addGoal(goal('y', 20)));
            await vi.advanceTimersByTimeAsync(2500);
            press(() => removeGoal('r'));
            await settle();

            expect(goalAmounts()).toEqual([1, 10, 20]);
        });

        test('add, then remove it before it landed: it is gone, and stays gone', async () => {
            seed({ [GOALS_A]: stored() });
            press(() => addGoal(goal('x', 10)));
            await vi.advanceTimersByTimeAsync(1000);
            press(() => removeGoal('x'));
            await settle();
            expect(goalAmounts()).toEqual([1]);

            expect((await loadGoals()).map((entry) => entry.amount)).toEqual([1]);
        });

        test('add, remove it after it landed: gone too', async () => {
            seed({ [GOALS_A]: stored() });
            press(() => addGoal(goal('x', 10)));
            await settle();
            expect(goalAmounts()).toEqual([1, 10]);
            press(() => removeGoal('x'));
            await settle();
            expect(goalAmounts()).toEqual([1]);
        });

        test('a second press of Add spaced past the first read is still a double press', async () => {
            seed({ [GOALS_A]: [] });
            const form = { type: 'gold', amount: 10 };
            press(() => addGoal(form));
            await vi.advanceTimersByTimeAsync(1000);
            press(() => addGoal(form));
            await settle();

            expect(goalAmounts()).toEqual([10]);
        });

        test('over the cap: the fold keeps every goal, a new one is refused, and none drops out', async () => {
            // Amounts start above the two the test adds (100 and 200), so they never clash with a stored goal
            const full = Array.from({ length: MAX_GOALS }, (_, i) => goal(`g${i}`, i + 1000));
            seed({ [GOALS_A]: full.slice(0, MAX_GOALS - 1) });
            press(() => addGoal(goal('mine', 100)));
            await vi.advanceTimersByTimeAsync(10);
            // Another tab took the last place while this one's was waiting
            data.set(GOALS_A, full);
            await settle();
            expect(data.get(GOALS_A)).toHaveLength(MAX_GOALS + 1);

            press(() => addGoal(goal('late', 200)));
            await settle();
            expect(data.get(GOALS_A)).toHaveLength(MAX_GOALS + 1);
            expect(goalAmounts()).not.toContain(200);

            press(() => removeGoal('g0'));
            await settle();
            expect(data.get(GOALS_A)).toHaveLength(MAX_GOALS);
            expect(goalAmounts()).toContain(100);
            expect(goalAmounts()).toContain(1000 + MAX_GOALS - 1);
        });
    });

    describe('a load in between, with another tab writing', () => {
        test('a bare load keeps the waiting edit in the view, and it lands', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            await record.load();
            expect(record.get().act).toEqual(['s', 'x']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
        });

        test('a load that starts from nothing, as the goal list does, is the same', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            record.set({});
            await record.load();
            expect(record.get().act).toEqual(['s', 'x']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
        });

        test('what another tab commits before the load survives the waiting edit landing', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            data.set(PINS_A, { act: ['s', 't'] });
            expect(await readPins(record)).toEqual(['s', 'x', 't']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['s', 't', 'x']);
        });

        test('what another tab commits after the load survives too, and so does what it removes', async () => {
            seed({ [PINS_A]: { act: ['s', 'r'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'r', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            await readPins(record);
            data.set(PINS_A, { act: ['s', 't'] });
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['s', 't', 'x']);
        });

        test('a waiting removal stays removed through a load, in the view and in storage', async () => {
            seed({ [PINS_A]: { act: ['s', 'r'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s']);
            await vi.advanceTimersByTimeAsync(10);

            data.set(PINS_A, { act: ['s', 'r', 't'] });
            expect((await readPins(record)).sort()).toEqual(['s', 't']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['s', 't']);
        });

        test('an edit carried through a load and landed can then be undone with no further load', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);
            await record.load();
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);

            writePins(record, ['s']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s']);
        });

        test('a load the waiting save lands during still shows the edit, which can then be undone', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            const loading = record.load();
            const flushing = storage.flushAll();
            await Promise.all([loading, flushing]);
            expect(record.get().act).toEqual(['s', 'x']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);

            writePins(record, ['s']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s']);
        });

        test('a load that could not read leaves the waiting save to land', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            refuseNextTransaction();
            expect(await record.load()).toBe(false);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
        });

        test('a save before any load, then the load: nothing stored or held is lost', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            writePins(record, ['x']);
            await vi.advanceTimersByTimeAsync(10);

            await record.load();
            expect(record.get().act.sort()).toEqual(['s', 'x']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['s', 'x']);
        });

        test('nothing stored yet: the waiting edit is in the view and lands', async () => {
            seed({});
            const record = createCuratedRecord({
                base: 'list',
                scoped: false,
                empty: () => [],
                merge: mergeById((row) => row.id),
                threeWay: { idOf: (row) => row.id },
                label: 'Test',
            });
            await record.load();
            record.set([{ id: 1 }, { id: 2 }, { id: 3 }]);
            record.save();
            await vi.advanceTimersByTimeAsync(10);

            await record.load();
            expect(record.get()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
            await settle();
            expect(data.get('list')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        });

        test('the view a load hands back is the owner own: editing it does not reach the waiting write', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            await record.load();
            record.get().act.push('unsaved');
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
        });
    });

    describe('what a landing, a failure and a coalesced save leave behind', () => {
        test('a save is in the storage queue as it is asked, so one flush at page close lands the last pin', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(1000);
            writePins(record, ['s', 'x', 'y']);

            expect(storage.pendingWrites.get('settings:pins_A').value.act).toEqual(['s', 'x', 'y']);
            await storage.flushAll();
            expect(pinned(PINS_A)).toEqual(['s', 'x', 'y']);
        });

        test('coalesced saves all answer true, and the copy afterwards is the newest view', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            const first = writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(1000);
            const second = writePins(record, ['s', 'x', 'y']);
            await settle();
            expect(await first).toBe(true);
            expect(await second).toBe(true);
            expect(pinned(PINS_A)).toEqual(['s', 'x', 'y']);

            // Both now read as this tab's own: taking them off sticks
            writePins(record, ['s']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s']);
        });

        test('a failed write moves nothing: its edit lands from the next save, beside the other tab', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            refuseNextTransaction();
            const failed = writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
            expect(await failed).toBe(false);

            data.set(PINS_A, { act: ['s', 't'] });
            writePins(record, ['s', 'x', 'y']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['s', 't', 'x', 'y']);
        });

        test('a failed write is carried through a load', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            refuseNextTransaction();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);

            expect(await readPins(record)).toEqual(['s', 'x']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
        });

        test('a failed write that lands from its requeue costs at worst a removal coming back', async () => {
            seed({ [PINS_A]: { act: ['s', 'r'] } });
            const record = pinsTab();
            await record.load();
            refuseNextTransaction();
            writePins(record, ['s', 'x', 'k']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
            await storage.flushAll();
            expect(pinned(PINS_A)).toEqual(['s', 'r', 'x', 'k']);

            // The mild direction: x, taken off now, stays stored until the next load
            writePins(record, ['s', 'k', 'y']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['k', 'r', 's', 'x', 'y']);

            // The severe direction: r, put back, is not read as something another tab took off
            writePins(record, ['s', 'k', 'y', 'r']);
            await settle();
            expect(pinned(PINS_A)).toContain('r');
            expect(await readPins(record)).toContain('r');
        });

        test('after a landing the other tab item stays out of the copy, so its later removal stands', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);
            data.set(PINS_A, { act: ['s', 't'] });
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['s', 't', 'x']);

            data.set(PINS_A, { act: ['s', 'x'] });
            writePins(record, ['s', 'x', 'y']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x', 'y']);
        });

        test('a clear replaces the save waiting, and a load then has nothing to carry', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);
            record.clear();
            await settle();
            expect(data.get(PINS_A)).toEqual({});

            expect(await readPins(record)).toEqual([]);
            await settle();
            expect(data.get(PINS_A)).toEqual({});
        });

        test('a save asked during a flush lands after it, and still moves the copy', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await record.load();
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            const flushing = storage.flushAll();
            writePins(record, ['s', 'x', 'y']);
            await flushing;
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x', 'y']);

            writePins(record, ['s']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s']);
        });

        test('a fold that throws at landing keeps the stored copy and answers false', async () => {
            seed({ list: ['a'] });
            const idOf = (element) => {
                if (element === 'bad') throw new Error('no identity');
                return element;
            };
            const record = createCuratedRecord({
                base: 'list',
                scoped: false,
                empty: () => [],
                merge: mergeById(idOf),
                threeWay: { idOf },
                label: 'Test',
            });
            await record.load();
            record.set(['a', 'c']);
            const saving = record.save();
            await vi.advanceTimersByTimeAsync(10);
            data.set('list', ['a', 'b', 'bad']);
            await settle();
            expect(await saving).toBe(false);
            expect(data.get('list')).toEqual(['a', 'b', 'bad']);

            // That wrote nothing, so the copy is as good as it was: a removal still takes
            data.set('list', ['a', 'b']);
            record.set(['c']);
            expect(await landed(record.save())).toBe(true);
            expect(data.get('list')).toEqual(['c', 'b']);
        });
    });

    describe('a list whose write failed folds as a union until its next load', () => {
        const refused = async (record, list) => {
            const failed = writePins(record, list);
            await writeIsRefused();
            expect(await failed).toBe(false);
        };

        test('unpin, the write fails, a flush lands it, pin again: the pin survives a reload', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a']);
            await storage.flushAll();

            writePins(record, ['a', 'Y']);
            await settle();
            expect(pinned(PINS_A)).toContain('Y');
            expect((await readPins(record)).sort()).toEqual(['Y', 'a']);
        });

        test('pin landed, the unpin fails, a flush, pin again: the pin survives a reload', async () => {
            seed({ [PINS_A]: { act: ['a'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['a', 'X']);
            await settle();
            await refused(record, ['a']);
            await storage.flushAll();

            writePins(record, ['a', 'X']);
            await settle();
            expect(pinned(PINS_A)).toContain('X');
            expect((await readPins(record)).sort()).toEqual(['X', 'a']);
        });

        test('a write that wedges before it starts and commits late, reported failed: the pin survives', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] } });
            storage.writeTimeoutMs = 50;
            const record = pinsTab();
            await readPins(record);
            const release = hold('start');
            const failed = writePins(record, ['a']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 100);
            expect(await failed).toBe(false);
            release();
            await vi.advanceTimersByTimeAsync(1);

            writePins(record, ['a', 'Y']);
            await settle();
            expect(pinned(PINS_A)).toContain('Y');
            expect((await readPins(record)).sort()).toEqual(['Y', 'a']);
        });

        test('a removal that committed but reported failed, then pinned again: the pin survives', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] } });
            storage.writeTimeoutMs = 50;
            const record = pinsTab();
            await readPins(record);
            const release = hold('answer');
            const failed = writePins(record, ['a']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 100);
            expect(await failed).toBe(false);
            // The fold ran before anyone knew, so this removal did reach the disk
            expect(pinned(PINS_A)).toEqual(['a']);
            release();
            await vi.advanceTimersByTimeAsync(1);

            writePins(record, ['a', 'Y']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['Y', 'a']);
            expect((await readPins(record)).sort()).toEqual(['Y', 'a']);
        });

        test('watchlist: remove the +5 row, it fails, a flush, add it back: both rows stay', async () => {
            const row = (hrid, level) => ({
                hrid,
                name: hrid,
                source: null,
                ...(level ? { enhancementLevel: level } : {}),
            });
            const tome = '/items/enchanted_tome';
            const emptyList = () => ({ entries: [], zones: {}, chests: {}, sortBy: 'value', direction: 'desc' });
            const key = `${WATCHLIST_KEY}_A`;
            seed({ [key]: { ...emptyList(), entries: [row(tome, 0), row(tome, 5)], zones: { '/actions/x': true } } });
            const record = createCuratedRecord({
                base: WATCHLIST_KEY,
                empty: emptyList,
                merge: (stored, memory) => ({ ...emptyList(), ...mergeWatchlists(stored, memory) }),
                threeWay: { idOf: entryKey },
                label: 'Test',
            });
            await record.load();
            const state = structuredClone(record.get());
            const persist = () => {
                record.set({ ...state });
                return record.save();
            };

            state.entries = state.entries.filter((entry) => !entry.enhancementLevel);
            const failed = persist();
            await writeIsRefused();
            expect(await failed).toBe(false);
            await storage.flushAll();

            state.entries = [...state.entries, row(tome, 5)];
            persist();
            await settle();
            expect(data.get(key).entries.map(entryKey).sort()).toEqual(
                [row(tome, 0), row(tome, 5)].map(entryKey).sort()
            );
            expect(data.get(key).zones).toEqual({ '/actions/x': true });
        });

        test('the failed removal, restated at a re-init, does not delete the second tab pin', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a']);
            await storage.flushAll();

            const other = pinsTab();
            await readPins(other);
            writePins(other, ['a', 'Y']);
            await settle();
            expect(pinned(PINS_A)).toContain('Y');

            expect((await readPins(record)).sort()).toEqual(['Y', 'a']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['Y', 'a']);
        });

        test('the same removal, restated on switching back, does not delete the second tab pin', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] }, [PINS_B]: { act: ['z'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a']);
            await storage.flushAll();
            character.id = 'B';
            expect(await readPins(record)).toEqual(['z']);

            character.id = 'A';
            const other = pinsTab();
            await readPins(other);
            writePins(other, ['a', 'Y']);
            await settle();

            expect((await readPins(record)).sort()).toEqual(['Y', 'a']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['Y', 'a']);
            expect(pinned(PINS_B)).toEqual(['z']);
        });

        test('a save after a reset, over the failed one, does not delete the second tab pin', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a']);
            await storage.flushAll();

            const other = pinsTab();
            await readPins(other);
            writePins(other, ['a', 'Y']);
            await settle();

            record.reset();
            writePins(record, ['q']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['Y', 'a', 'q']);
        });

        test('a failed clear that lands from its requeue, then an item added back: it stays', async () => {
            seed({ list: ['a', 'Y'] });
            const record = createCuratedRecord({
                base: 'list',
                scoped: false,
                empty: () => [],
                merge: mergeById((hrid) => hrid),
                threeWay: { idOf: (hrid) => hrid },
                label: 'Test',
            });
            await record.load();
            const failed = record.clear();
            await vi.advanceTimersByTimeAsync(5);
            await writeIsRefused();
            expect(await failed).toBe(false);
            await storage.flushAll();
            expect(data.get('list')).toEqual([]);

            record.set(['Y']);
            record.save();
            await settle();
            expect(data.get('list')).toEqual(['Y']);
        });

        test('a goal whose removal failed comes back at the next press, and adding it again makes one', async () => {
            seed({ [GOALS_A]: [goal('s', 1), goal('r', 2)] });
            press(() => removeGoal('r'));
            await vi.advanceTimersByTimeAsync(10);
            await writeIsRefused();
            await storage.flushAll();
            expect(goalAmounts()).toEqual([1, 2]);

            press(() => addGoal({ type: 'gold', amount: 2 }));
            await settle();
            expect(goalAmounts()).toEqual([1, 2]);

            // That press read the list again, so the next removal takes
            press(() => removeGoal('r'));
            await settle();
            expect(goalAmounts()).toEqual([1]);
        });

        test('a removal made after the failure and the recovery waits for the load, and then one takes', async () => {
            seed({ [PINS_A]: { act: ['a', 'Y', 'Z'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a', 'Z']);
            await storage.flushAll();

            // Storage works again, and the write lands, but this list cannot yet say what it may take out
            expect(await landed(writePins(record, ['a']))).toBe(true);
            expect(pinned(PINS_A).sort()).toEqual(['Y', 'Z', 'a']);

            expect((await readPins(record)).sort()).toEqual(['Y', 'Z', 'a']);
            writePins(record, ['a', 'Y']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['a', 'Y']);
        });

        test('a load reads behind the requeue: nothing is lost, and the list it starts is trusted', async () => {
            seed({ [PINS_A]: { act: ['a', 'Y'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a', 'X']);

            expect(pinned(PINS_A)).toEqual(['a', 'Y']);
            expect((await readPins(record)).sort()).toEqual(['X', 'Y', 'a']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['X', 'Y', 'a']);

            writePins(record, ['a']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['a']);
        });

        test('the requeue lands after the read was made: nothing is lost, and what the read missed stays', async () => {
            seed({ [PINS_A]: { act: ['a', 'Y'] } });
            const record = pinsTab();
            await readPins(record);
            await refused(record, ['a', 'X']);

            const release = holdNextRead(PINS_A);
            const loading = readPins(record);
            await vi.advanceTimersByTimeAsync(1);
            await storage.flushAll();
            expect(pinned(PINS_A).sort()).toEqual(['X', 'Y', 'a']);
            release();
            expect((await loading).sort()).toEqual(['X', 'Y', 'a']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['X', 'Y', 'a']);
        });

        test('a write that fails while the load is reading is held to the same rule', async () => {
            seed({ [PINS_A]: { act: ['Y', 'a'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['a']);
            await vi.advanceTimersByTimeAsync(10);

            const release = holdNextRead(PINS_A);
            const loading = readPins(record);
            await writeIsRefused();
            release();
            expect((await loading).sort()).toEqual(['Y', 'a']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['Y', 'a']);
        });

        test('three failed flushes drop the write: the load still has the pin, and it lands', async () => {
            seed({ [PINS_A]: { act: ['a'] } });
            const record = pinsTab();
            await readPins(record);
            const transaction = storage.db.transaction;
            storage.db.transaction = () => {
                throw new Error('refused');
            };
            writePins(record, ['a', 'X']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
            for (let i = 0; i < 4; i += 1) await storage.flushAll();
            storage.db.transaction = transaction;
            expect(storage.pendingWrites.size).toBe(0);
            expect(pinned(PINS_A)).toEqual(['a']);

            expect(await readPins(record)).toEqual(['a', 'X']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['a', 'X']);
        });
    });

    describe('what a load in flight holds on to', () => {
        test('a save that lands while the load reads an older copy is in the view, against its old base', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            const release = holdNextRead(PINS_A);
            const loading = readPins(record);
            await vi.advanceTimersByTimeAsync(1);
            await storage.flushAll();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
            release();

            expect(await loading).toEqual(['s', 'x']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
        });

        test('a save asked while the load reads is the one it carries', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await readPins(record);
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(10);

            const release = holdNextRead(PINS_A);
            const loading = record.load();
            writePins(record, ['s', 'x', 'y']);
            // As the goal list does when a load begins
            record.set({});
            release();
            await loading;

            expect(record.get().act).toEqual(['s', 'x', 'y']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x', 'y']);
        });

        test('the save it carries folds against the base as the load began, past one landing meanwhile', async () => {
            seed({ [PINS_A]: { act: ['s'] } });
            const record = pinsTab();
            await readPins(record);
            const go = hold('start');
            writePins(record, ['s', 'x']);
            await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
            writePins(record, ['s', 'x', 'y']);

            // The older of the two lands inside the load, and moves the base past what the load read
            const release = holdNextRead(PINS_A);
            const loading = readPins(record);
            go();
            await vi.advanceTimersByTimeAsync(1);
            expect(pinned(PINS_A)).toEqual(['s', 'x']);
            release();

            expect(await loading).toEqual(['s', 'x', 'y']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s', 'x', 'y']);
        });

        test('the character moves while the load reads: its line stays on the key it read', async () => {
            seed({ [PINS_A]: { act: ['a'] }, [PINS_B]: { act: ['z'] } });
            const record = pinsTab();
            await readPins(record);

            const release = holdNextRead(PINS_A);
            const loading = record.load();
            character.id = 'B';
            release();
            await loading;

            writePins(record, ['a', 'y']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['a', 'y']);
            expect(pinned(PINS_B)).toEqual(['z']);
        });

        test('a load a reset and a newer load overtook leaves the newer one in charge: a removal takes', async () => {
            seed({ [PINS_A]: { act: ['s', 'r'] } });
            const record = pinsTab();
            await readPins(record);

            const release = holdNextRead(PINS_A);
            const overtaken = readPins(record);
            await readPins(record);
            release();
            await overtaken;

            writePins(record, ['s']);
            await settle();
            expect(pinned(PINS_A)).toEqual(['s']);
        });

        test('a readable load overtaken by an unreadable one does not make the list trusted', async () => {
            seed({ [PINS_A]: { act: ['s', 'r'] } });
            const record = pinsTab();
            await readPins(record);

            const first = holdNextRead(PINS_A);
            const overtaken = record.load();
            const second = holdNextRead(PINS_A, false);
            const newest = record.load();
            second();
            expect(await newest).toBe(false);
            first();
            await overtaken;

            writePins(record, ['s']);
            await settle();
            expect(pinned(PINS_A).sort()).toEqual(['r', 's']);
        });
    });
});
