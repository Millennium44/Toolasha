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
        reset() {
            stores.clear();
        },
        get: vi.fn(async (key, storeName = 'settings', defaultValue = null) => {
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : defaultValue;
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            storeFor(storeName).set(key, value);
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
