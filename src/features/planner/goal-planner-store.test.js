/**
 * That the goal list belongs to the character who wrote it.
 *
 * The failure this guards against is quiet: a bare key works perfectly until
 * the second character logs in and inherits the first one's ambitions. So the
 * assertions are about *where* things land in storage, not only about what
 * comes back out.
 *
 * The storage and data-manager doubles follow `utils/character-key.test.js`.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockDataManager = vi.hoisted(() => ({
    currentCharacterId: 'market123',
    currentGameMode: 'standard',
    getCurrentCharacterId: vi.fn(() => mockDataManager.currentCharacterId),
    getCurrentCharacterGameMode: vi.fn(() => mockDataManager.currentGameMode),
}));

const mockStorage = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            mockStorage.unavailable = false;
        },
        get: vi.fn(async (key, storeName = 'settings', defaultValue = null) => {
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : defaultValue;
        }),
        tryGet: vi.fn(async (key, storeName = 'settings') => {
            if (mockStorage.unavailable) return null;
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null
                ? { found: true, value: structuredClone(store.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            if (mockStorage.unavailable) return false;
            storeFor(storeName).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, storeName = 'settings') => {
            storeFor(storeName).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (storeName = 'settings') => Array.from(storeFor(storeName).keys())),
    };
});

vi.mock('../../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../../core/storage.js', () => ({ default: mockStorage }));

const {
    loadGoals,
    saveGoals,
    addGoal,
    removeGoal,
    loadSnapshot,
    saveSnapshot,
    loadCombatGear,
    saveCombatGear,
    flushGoalWrites,
    GOALS_KEY,
    SNAPSHOT_KEY,
    COMBAT_GEAR_KEY,
} = await import('./goal-planner-store.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const settings = () => mockStorage.storeFor('settings');

beforeEach(() => {
    mockStorage.reset();
    mockDataManager.currentCharacterId = 'market123';
    mockDataManager.currentGameMode = 'standard';
    _resetAdoptionCache();
});

describe('where goals are written', () => {
    test('under this character, never bare', async () => {
        await saveGoals([{ type: 'gold', amount: 500 }]);

        expect(settings().has(`${GOALS_KEY}_market123`)).toBe(true);
        expect(settings().has(GOALS_KEY)).toBe(false);
    });

    test('the iron cow does not read the market character list', async () => {
        await addGoal({ type: 'gold', amount: 500_000_000 });
        expect(await loadGoals()).toHaveLength(1);

        mockDataManager.currentCharacterId = 'ironcow456';
        expect(await loadGoals()).toEqual([]);

        await addGoal({ type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 110 });
        expect(await loadGoals()).toHaveLength(1);

        mockDataManager.currentCharacterId = 'market123';
        const back = await loadGoals();
        expect(back).toHaveLength(1);
        expect(back[0].type).toBe('gold');
    });

    test('the snapshot is scoped the same way', async () => {
        await saveSnapshot([{ goalId: 'g1', steps: [] }]);

        expect(settings().has(`${SNAPSHOT_KEY}_market123`)).toBe(true);
        expect((await loadSnapshot()).plans).toHaveLength(1);

        mockDataManager.currentCharacterId = 'ironcow456';
        expect(await loadSnapshot()).toBeNull();
    });
});

describe('the goal list', () => {
    test('drops anything that no longer plans, rather than keeping a dead row', async () => {
        settings().set(`${GOALS_KEY}_market123`, [
            { id: 'a', type: 'gold', amount: 500 },
            { id: 'b', type: 'gold', amount: 0 },
            { id: 'c', type: 'nonsense' },
        ]);

        const goals = await loadGoals();
        expect(goals.map((goal) => goal.id)).toEqual(['a']);
    });

    test('a second press of Add is a mistake, not a second goal', async () => {
        await addGoal({ type: 'house', roomHrid: '/house_rooms/observatory', targetLevel: 8 });
        const after = await addGoal({ type: 'house', roomHrid: '/house_rooms/observatory', targetLevel: 8 });

        expect(after).toHaveLength(1);
    });

    test('but a different level is a different goal', async () => {
        await addGoal({ type: 'house', roomHrid: '/house_rooms/observatory', targetLevel: 8 });
        const after = await addGoal({ type: 'house', roomHrid: '/house_rooms/observatory', targetLevel: 6 });

        expect(after).toHaveLength(2);
    });

    test('removing one leaves the rest', async () => {
        await addGoal({ id: 'keep', type: 'gold', amount: 100 });
        await addGoal({ id: 'drop', type: 'gold', amount: 200 });

        const after = await removeGoal('drop');
        expect(after.map((goal) => goal.id)).toEqual(['keep']);
        expect(settings().get(`${GOALS_KEY}_market123`)).toHaveLength(1);
    });

    test('a legacy bare list is not inherited by anybody', async () => {
        // Nothing ever wrote one, and if something does it belongs to whoever
        // wrote it — goals are authored, not derived
        settings().set(GOALS_KEY, [{ id: 'legacy', type: 'gold', amount: 999 }]);

        expect(await loadGoals()).toEqual([]);
        expect(settings().has(GOALS_KEY)).toBe(false);
    });
});

describe('the combat gear record', () => {
    test('starts empty rather than undefined, so nothing has to guard it', async () => {
        expect(await loadCombatGear()).toEqual({ preferred: null, baseline: null });
    });

    test('a patch leaves the half it did not touch alone', async () => {
        await saveCombatGear({ preferred: 'Ranged' });
        await saveCombatGear({ baseline: { savedAt: 12, signature: 'sword+5' } });

        expect(await loadCombatGear()).toEqual({
            preferred: 'Ranged',
            baseline: { savedAt: 12, signature: 'sword+5' },
        });
    });

    test('belongs to the character who fights in it', async () => {
        await saveCombatGear({ preferred: 'Ranged' });
        expect(settings().has(`${COMBAT_GEAR_KEY}_market123`)).toBe(true);

        mockDataManager.currentCharacterId = 'other456';
        expect(await loadCombatGear()).toEqual({ preferred: null, baseline: null });
    });

    test('a baseline with no timestamp is not a baseline', async () => {
        settings().set(`${COMBAT_GEAR_KEY}_market123`, { baseline: { signature: 'sword+5' } });
        expect((await loadCombatGear()).baseline).toBeNull();
    });
});

describe('the goal list and a store that cannot be read', () => {
    const goalsKey = () => `${GOALS_KEY}_market123`;
    const ids = (goals) => goals.map((goal) => goal.id);

    test('a load that cannot be made keeps the list in hand rather than blanking it', async () => {
        await saveGoals([{ id: 'a', type: 'gold', amount: 500 }]);
        expect(ids(await loadGoals())).toEqual(['a']);

        mockStorage.unavailable = true;
        expect(ids(await loadGoals())).toEqual(['a']);
    });

    test("but not another character's list", async () => {
        await saveGoals([{ id: 'a', type: 'gold', amount: 500 }]);
        await loadGoals();
        mockDataManager.currentCharacterId = 'ironcow456';
        mockStorage.unavailable = true;
        expect(await loadGoals()).toEqual([]);
    });

    test('adding a goal while the store cannot be read writes nothing over it', async () => {
        settings().set(goalsKey(), [{ id: 'a', type: 'gold', amount: 500 }]);
        mockStorage.unavailable = true;

        const after = await addGoal({ id: 'b', type: 'gold', amount: 900 });
        // What the caller sees is the goal it added on top of what could be
        // had; what is stored is untouched
        expect(ids(after)).toEqual(['b']);
        mockStorage.unavailable = false;
        expect(ids(settings().get(goalsKey()))).toEqual(['a']);
    });

    test('a save before the list was read back loses no stored goal', async () => {
        settings().set(goalsKey(), [{ id: 'a', type: 'gold', amount: 500 }]);
        mockStorage.unavailable = true;
        await loadGoals();
        mockStorage.unavailable = false;

        await saveGoals([{ id: 'b', type: 'gold', amount: 900 }]);
        await flushGoalWrites();
        expect(ids(settings().get(goalsKey())).sort()).toEqual(['a', 'b']);
    });

    test('after a readable load a removal sticks', async () => {
        settings().set(goalsKey(), [
            { id: 'a', type: 'gold', amount: 500 },
            { id: 'b', type: 'gold', amount: 900 },
        ]);
        await removeGoal('a');
        expect(ids(settings().get(goalsKey()))).toEqual(['b']);
    });

    test('once storage is back, the next save lands', async () => {
        settings().set(goalsKey(), [{ id: 'a', type: 'gold', amount: 500 }]);
        mockStorage.unavailable = true;
        await addGoal({ id: 'b', type: 'gold', amount: 900 });
        expect(ids(settings().get(goalsKey()))).toEqual(['a']);

        mockStorage.unavailable = false;
        // The list is read back fresh, so the add is made against the real
        // list this time and lands beside it
        await addGoal({ id: 'b', type: 'gold', amount: 900 });
        expect(ids(settings().get(goalsKey())).sort()).toEqual(['a', 'b']);
    });
});
