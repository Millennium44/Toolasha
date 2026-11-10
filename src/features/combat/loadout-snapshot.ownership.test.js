import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ characterId: 'char-b', activeSocket: {}, characterData: null }));
const io = vi.hoisted(() => ({ getJSON: vi.fn(), setJSON: vi.fn(), handlers: new Map() }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        get characterData() {
            return state.characterData;
        },
        characterItems: [],
        isFromActiveSocket: (context) => !state.activeSocket || context?.socket === state.activeSocket,
        on: vi.fn(),
        off: vi.fn(),
    },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: io.getJSON, setJSON: io.setJSON } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => io.handlers.set(type, fn),
        off: (type, fn) => {
            if (io.handlers.get(type) === fn) io.handlers.delete(type);
        },
    },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
    webSocketHook: () => null,
}));

import loadoutSnapshot from './loadout-snapshot.js';

const loadout = (characterID, name = 'Saved combat') => ({
    id: 39837,
    characterID,
    name,
    actionTypeHrid: '/action_types/combat',
    wearableMap: {
        '/item_locations/neck': `${characterID}::/item_locations/inventory::/items/philosophers_necklace::10`,
    },
    useExactEnhancement: true,
    foodItemHrids: ['/items/gummy'],
    drinkItemHrids: [],
    abilityMap: {},
});
let instance;

beforeEach(() => {
    state.characterId = 'char-b';
    state.activeSocket = {};
    state.characterData = null;
    io.getJSON.mockReset().mockResolvedValue(null);
    io.setJSON.mockReset().mockResolvedValue(true);
    io.handlers.clear();
    instance = new loadoutSnapshot.constructor();
});
afterEach(() => instance.disable());

describe('loadout messages keep the active character cache isolated', () => {
    test.each([false, true])('an old socket cannot replace or clear current snapshots (empty=%s)', async (empty) => {
        await instance.initialize();
        const receive = io.handlers.get('loadouts_updated');
        receive({ characterLoadoutMap: { 39837: loadout('char-b', 'Current build') } }, { socket: state.activeSocket });
        const current = structuredClone(instance.snapshots);
        const listener = vi.fn();
        instance.onUpdate(listener);
        io.setJSON.mockClear();

        receive({ characterLoadoutMap: empty ? {} : { 39837: loadout('char-a', 'Other character') } }, { socket: {} });

        expect(instance.snapshots).toEqual(current);
        expect(io.setJSON).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
    });

    test('a mismatched character payload is rejected before any current-character write', async () => {
        await instance.initialize();
        const receive = io.handlers.get('loadouts_updated');
        receive({ characterLoadoutMap: { 39837: loadout('char-b', 'Current build') } }, { socket: state.activeSocket });
        const current = structuredClone(instance.snapshots);
        io.setJSON.mockClear();

        receive({ characterLoadoutMap: { 39837: loadout('char-a') } }, { socket: state.activeSocket });

        expect(instance.snapshots).toEqual(current);
        expect(io.setJSON).not.toHaveBeenCalled();
    });

    test('an old connection for the same character cannot roll back its new connection', async () => {
        await instance.initialize();
        const receive = io.handlers.get('loadouts_updated');
        receive(
            { characterLoadoutMap: { 39837: loadout('char-b', 'New connection') } },
            { socket: state.activeSocket }
        );
        const current = structuredClone(instance.snapshots);
        io.setJSON.mockClear();

        receive({ characterLoadoutMap: { 39837: loadout('char-b', 'Old connection') } }, { socket: {} });

        expect(instance.snapshots).toEqual(current);
        expect(io.setJSON).not.toHaveBeenCalled();
    });

    test('a mixed-character payload does not partially replace the current map', async () => {
        await instance.initialize();
        const receive = io.handlers.get('loadouts_updated');
        receive({ characterLoadoutMap: { 39837: loadout('char-b', 'Current build') } }, { socket: state.activeSocket });
        const current = structuredClone(instance.snapshots);
        io.setJSON.mockClear();

        receive(
            { characterLoadoutMap: { 1: loadout('char-b', 'Partial'), 2: loadout('char-a') } },
            { socket: state.activeSocket }
        );

        expect(instance.snapshots).toEqual(current);
        expect(io.setJSON).not.toHaveBeenCalled();
    });

    test('numeric and string forms of the current character still update and notify', async () => {
        state.characterId = 32;
        await instance.initialize();
        const listener = vi.fn();
        instance.onUpdate(listener);
        io.handlers.get('loadouts_updated')(
            { characterLoadoutMap: { 39837: loadout('32') } },
            { socket: state.activeSocket }
        );

        expect(instance.getSnapshotById(39837).name).toBe('Saved combat');
        expect(io.setJSON).toHaveBeenCalledWith('loadout_snapshots_32', instance.snapshots, 'settings');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('without a bound connection a matching early message can still initialize the store', () => {
        state.activeSocket = null;
        instance.getAllSnapshots();
        io.handlers.get('loadouts_updated')({ characterLoadoutMap: { 39837: loadout('char-b') } });

        expect(instance.getSnapshotById(39837).name).toBe('Saved combat');
        expect(instance.snapshotsReady).toBe(true);
        expect(io.setJSON).toHaveBeenCalledWith('loadout_snapshots_char-b', instance.snapshots, 'settings');
    });

    test('a stale message cannot declare a still-loading snapshot store ready', () => {
        instance.getAllSnapshots();
        expect(instance.snapshotsReady).toBe(false);
        io.handlers.get('loadouts_updated')({ characterLoadoutMap: {} }, { socket: {} });
        expect(instance.snapshotsReady).toBe(false);
        expect(io.setJSON).not.toHaveBeenCalled();
    });

    test('a matching early map without row character IDs retains backward-compatible acceptance', () => {
        state.activeSocket = null;
        instance.getAllSnapshots();
        const legacy = loadout('char-b');
        delete legacy.characterID;
        io.handlers.get('loadouts_updated')({ characterLoadoutMap: { 39837: legacy } });
        expect(instance.getSnapshotById(39837).name).toBe('Saved combat');
        expect(instance.snapshotsReady).toBe(true);
    });

    test('a current-socket empty map still intentionally removes every saved snapshot', async () => {
        await instance.initialize();
        const receive = io.handlers.get('loadouts_updated');
        receive({ characterLoadoutMap: { 39837: loadout('char-b') } }, { socket: state.activeSocket });
        io.setJSON.mockClear();

        receive({ characterLoadoutMap: {} }, { socket: state.activeSocket });

        expect(instance.snapshots).toEqual({});
        expect(io.setJSON).toHaveBeenCalledWith('loadout_snapshots_char-b', {}, 'settings');
    });
});
