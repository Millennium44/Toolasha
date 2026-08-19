import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
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
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
const game = vi.hoisted(() => ({ characterId: 'char1' }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        characterData: null,
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    default: labyrinthRunLedger,
    gridSize,
    roomsFullClear,
    roomsRush,
    torchesForPlan,
    rushFloorTable,
    foldSighting,
} = await import('./labyrinth-run-ledger.js');

describe('the grid arithmetic, straight from the game guide', () => {
    test('floor 1 is 4×4, one wider per floor, capped at 8×8 from floor 5', () => {
        expect(gridSize(1)).toBe(4);
        expect(gridSize(2)).toBe(5);
        expect(gridSize(4)).toBe(7);
        expect(gridSize(5)).toBe(8);
        expect(gridSize(17)).toBe(8);
    });

    test('a full clear enters the whole grid; a rush the corner-to-corner path', () => {
        expect(roomsFullClear(1)).toBe(16);
        expect(roomsFullClear(5)).toBe(64);
        expect(roomsRush(1)).toBe(7); // 4+4−1 rooms along the shortest path
        expect(roomsRush(5)).toBe(15);
    });

    test('the plan sums rushed floors as paths and the rest as full grids', () => {
        // Rush ≤2, deepest 3: 7 + 9 + 36
        expect(torchesForPlan(2, 3)).toBe(52);
        // Rush nothing: full clears only
        expect(torchesForPlan(0, 2)).toBe(16 + 25);
    });

    test('the advisor table marks which rush floors fit the capacity', () => {
        const rows = rushFloorTable(3, 60);
        expect(rows).toHaveLength(4); // rush 0..3
        expect(rows[0]).toEqual({ rushFloor: 0, torches: 77, fits: false });
        expect(rows[2].torches).toBe(52);
        expect(rows[2].fits).toBe(true);
    });
});

describe('foldSighting', () => {
    const active = (over = {}) => ({
        isActive: true,
        startedAt: '2026-08-18T00:00:00Z',
        currentFloor: 3,
        torchCount: 120,
        shroudCount: 4,
        beaconCount: 5,
        torchItemHrid: '/items/expert_torch',
        ...over,
    });
    const start = { phase: 'unknown', run: null };

    test('an active run is tracked at its deepest floor and last-seen counts', () => {
        let s = foldSighting(start, active(), 1000).state;
        s = foldSighting(s, active({ currentFloor: 5, torchCount: 80 }), 2000).state;
        expect(s.run.floor).toBe(5);
        expect(s.run.left.torch).toBe(80);
        expect(s.run.itemHrids.torch).toBe('/items/expert_torch');
    });

    test('the ending records the run once, off the active→ended edge', () => {
        let s = foldSighting(start, active({ torchCount: 61 }), 1000).state;
        const { state, ended } = foldSighting(s, { isActive: false }, 2000);
        expect(ended).toMatchObject({ floor: 3, left: { torch: 61 }, endedAt: 2000 });
        // The server re-sends after a run ends; a second ended sighting records nothing
        expect(foldSighting(state, { isActive: false }, 3000).ended).toBeNull();
    });

    test('a payload that says nothing about the run is not the run ending', () => {
        const s = foldSighting(start, active(), 1000).state;
        expect(foldSighting(s, {}, 2000).ended).toBeNull();
        expect(foldSighting(s, {}, 2000).state.phase).toBe('active');
    });
});

describe('the ring survives a failed read and a second tab', () => {
    const KEY = 'labyrinthRunLedger_char1';
    const stored = () => storageMock.storeFor('labyrinth').get(KEY);
    const ending = (key, endedAt = Number(key)) => ({ key, floor: 3, endedAt });

    beforeEach(() => {
        storageMock.reset();
        game.characterId = 'char1';
        labyrinthRunLedger.ledgerOwner = null;
        labyrinthRunLedger.recorded.clear();
    });

    test('an ending is appended newest first under the character key', async () => {
        await labyrinthRunLedger._append(ending('1'));
        await labyrinthRunLedger._append(ending('2'));

        expect(stored().map((run) => run.key)).toEqual(['2', '1']);
        expect((await labyrinthRunLedger.runs()).map((run) => run.key)).toEqual(['2', '1']);
    });

    test('a read that cannot be made keeps the ring in memory instead of truncating it', async () => {
        await labyrinthRunLedger._append(ending('1'));
        storageMock.unavailable = true;

        await labyrinthRunLedger._append(ending('2'));

        expect((await labyrinthRunLedger.runs()).map((run) => run.key)).toEqual(['2', '1']);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        await labyrinthRunLedger._append(ending('1'));
        storageMock.unavailable = true;

        expect(await labyrinthRunLedger._append(ending('2'))).toBe(false);

        storageMock.unavailable = false;
        expect(stored().map((run) => run.key)).toEqual(['1']);
    });

    test('a save folds in endings another tab recorded meanwhile', async () => {
        await labyrinthRunLedger._append(ending('1'));
        storageMock.storeFor('labyrinth').set(KEY, [ending('3'), ending('1')]);

        await labyrinthRunLedger._append(ending('2'));

        expect(stored().map((run) => run.key)).toEqual(['3', '2', '1']);
    });

    test('once storage reads again the next save lands everything', async () => {
        storageMock.unavailable = true;
        await labyrinthRunLedger._append(ending('1'));
        await labyrinthRunLedger._append(ending('2'));
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        await labyrinthRunLedger._append(ending('3'));

        expect(stored().map((run) => run.key)).toEqual(['3', '2', '1']);
    });

    test('a character switch forgets the departing character’s endings', async () => {
        await labyrinthRunLedger._append(ending('1'));
        game.characterId = 'char2';

        await labyrinthRunLedger._append(ending('9'));

        expect(
            storageMock
                .storeFor('labyrinth')
                .get('labyrinthRunLedger_char2')
                .map((run) => run.key)
        ).toEqual(['9']);
        expect(stored().map((run) => run.key)).toEqual(['1']);
    });
});
