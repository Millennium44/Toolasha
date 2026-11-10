import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const io = vi.hoisted(() => ({ handlers: new Map(), flush: vi.fn(), writes: [], records: new Map() }));
vi.mock('./websocket.js', () => ({
    default: {
        on: (type, fn) => {
            if (!io.handlers.has(type)) io.handlers.set(type, new Set());
            io.handlers.get(type).add(fn);
        },
        off: (type, fn) => io.handlers.get(type)?.delete(fn),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
    },
}));
vi.mock('./storage.js', () => ({
    default: {
        get: vi.fn(async (_key, _store, fallback) => fallback),
        set: vi.fn(async () => true),
        getJSON: vi.fn(async (key, _store, fallback) => io.records.get(key) ?? fallback),
        setJSON: vi.fn(async (key, value) => {
            io.writes.push([key, structuredClone(value)]);
            return true;
        }),
        flushAll: () => io.flush(),
    },
}));
vi.mock('./config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../utils/bundle-bridge.js', () => ({
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
    webSocketHook: () => null,
}));

import dataManager from './data-manager.js';
import loadoutSnapshot from '../features/combat/loadout-snapshot.js';
import { cleanOrphanedBindings } from '../features/inventory/custom-tabs/custom-tabs-data.js';

const loadout = (id, name) => ({ characterID: id, name, wearableMap: {}, drinkItemHrids: [], foodItemHrids: [] });
const initial = (id, loadoutMap) => ({
    character: { id, name: id },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
    characterLoadoutMap: loadoutMap,
});
const dispatch = (type, data, socket) => {
    const jobs = [...(io.handlers.get(type) || [])].map((handler) => handler(data, { socket }));
    return Promise.all(jobs);
};
let snapshots;
let socketA;
let socketB;

beforeEach(async () => {
    io.flush.mockReset().mockResolvedValue(undefined);
    io.writes = [];
    io.records.clear();
    dataManager.eventListeners.clear();
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
    dataManager.activeSocketCharacterId = null;
    dataManager._pendingLoadoutsUpdate = null;
    dataManager.isCharacterSwitching = false;
    dataManager.lastCharacterSwitchTime = 0;
    socketA = {};
    socketB = {};
    await dispatch('init_character_data', initial('a', { 1: loadout('a', 'A build') }), socketA);
    snapshots = new loadoutSnapshot.constructor();
    await snapshots.initialize();
    io.writes = [];
});
afterEach(async () => {
    snapshots.disable();
    await dataManager._switchChain;
    dataManager.eventListeners.clear();
});

describe('loadout updates during a real character transition', () => {
    test.each(['before queued init', 'during flush'])(
        'an arriving empty map %s cannot delete the departing character cache or tab bindings',
        async (timing) => {
            let release;
            io.flush.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    })
            );
            let tabs = {
                version: 1,
                tabs: [{ id: 'gear', items: ['/items/sword'], loadoutBindings: { 'A build': ['/items/sword'] } }],
            };
            const onUpdate = vi.fn(() => {
                tabs = cleanOrphanedBindings(
                    tabs,
                    'gear',
                    new Set(snapshots.getAllSnapshots().map((s) => s.name))
                ).config;
            });
            snapshots.onUpdate(onUpdate);
            const pending = dispatch(
                'init_character_data',
                initial('b', { 2: loadout('b', 'Older B build') }),
                socketB
            );
            if (timing === 'during flush') await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            await dispatch('loadouts_updated', { characterLoadoutMap: {} }, socketB);

            try {
                expect(dataManager.currentCharacterId).toBe('a');
                expect(snapshots.getAllSnapshots().map((s) => s.name)).toEqual(['A build']);
                expect(tabs.tabs[0].items).toEqual(['/items/sword']);
                expect(onUpdate).not.toHaveBeenCalled();
                expect(io.writes).toEqual([]);
            } finally {
                await vi.waitFor(() => expect(release).toBeTypeOf('function'));
                release();
                await pending;
            }
            expect(dataManager.characterData.characterLoadoutMap).toEqual({});
            snapshots.disable();
            await snapshots.initialize();
            expect(snapshots.getAllSnapshots()).toEqual([]);
        }
    );
    test('the newest arriving map survives the older init snapshot without changing departing loadouts', async () => {
        let release;
        io.flush.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );
        const pending = dispatch('init_character_data', initial('b', { 2: loadout('b', 'Initial B') }), socketB);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const latest = { 3: loadout('b', 'Newest B') };
        try {
            await dispatch('loadouts_updated', { characterLoadoutMap: {} }, socketB);
            await dispatch('loadouts_updated', { characterLoadoutMap: latest }, socketB);
            await dispatch('loadouts_updated', { characterLoadoutMap: { 1: loadout('a', 'Old A') } }, socketA);
            expect(dataManager.characterData.characterLoadoutMap).toEqual({ 1: loadout('a', 'A build') });
            expect(snapshots.getAllSnapshots().map((s) => s.name)).toEqual(['A build']);
            expect(io.writes).toEqual([]);
        } finally {
            release();
            await pending;
        }
        expect(dataManager.characterData.characterLoadoutMap).toEqual(latest);
        snapshots.disable();
        await snapshots.initialize();
        expect(snapshots.getAllSnapshots().map((s) => s.name)).toEqual(['Newest B']);
    });

    test('C updates during A to B teardown are consumed only by C, not the intervening B init', async () => {
        let release;
        io.flush.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );
        const observed = [];
        dataManager.on('character_initialized', (data) =>
            observed.push({ id: data.character.id, map: data.characterLoadoutMap })
        );
        const pendingB = dispatch('init_character_data', initial('b', { 2: loadout('b', 'Initial B') }), socketB);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const socketC = {};
        const latest = { 3: loadout('c', 'Newest C') };
        const pendingC = dispatch('init_character_data', initial('c', { 4: loadout('c', 'Initial C') }), socketC);
        await dispatch('loadouts_updated', { characterLoadoutMap: latest }, socketC);
        release();
        await Promise.all([pendingB, pendingC]);
        await vi.waitFor(() => expect(observed.some((event) => event.id === 'c')).toBe(true));

        expect(observed.find((event) => event.id === 'b').map).toEqual({ 2: loadout('b', 'Initial B') });
        expect(observed.find((event) => event.id === 'c').map).toEqual(latest);
        expect(dataManager.characterData.characterLoadoutMap).toEqual(latest);
    });

    test('a same-character reconnect keeps an update newer than its queued init', async () => {
        const replacementSocket = {};
        const pending = dispatch(
            'init_character_data',
            initial('a', { 1: loadout('a', 'Old reconnect') }),
            replacementSocket
        );
        await dispatch('loadouts_updated', { characterLoadoutMap: {} }, replacementSocket);
        await pending;

        expect(dataManager.characterData.characterLoadoutMap).toEqual({});
    });

    test("a failed earlier init cannot discard a later connection's pending map", async () => {
        const real = dataManager._handleInitCharacterData.bind(dataManager);
        const handling = vi
            .spyOn(dataManager, '_handleInitCharacterData')
            .mockImplementationOnce(async () => {
                throw new Error('failed B init');
            })
            .mockImplementation(real);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pendingB = dispatch('init_character_data', initial('b', {}), socketB);
        await dispatch('loadouts_updated', { characterLoadoutMap: { 2: loadout('b', 'New B') } }, socketB);
        const socketC = {};
        const pendingC = dispatch('init_character_data', initial('c', { 4: loadout('c', 'Initial C') }), socketC);
        const latest = { 3: loadout('c', 'Newest C') };
        await dispatch('loadouts_updated', { characterLoadoutMap: latest }, socketC);
        try {
            await Promise.all([pendingB, pendingC]);
            expect(dataManager.characterData.characterLoadoutMap).toEqual(latest);
        } finally {
            handling.mockRestore();
            log.mockRestore();
        }
    });

    test('an initialized active character still accepts intentional deletion immediately', async () => {
        await dispatch('loadouts_updated', { characterLoadoutMap: {} }, socketA);
        expect(dataManager.characterData.characterLoadoutMap).toEqual({});
        expect(snapshots.getAllSnapshots()).toEqual([]);
        expect(io.writes).toEqual([['loadout_snapshots_a', {}]]);
    });
    test('two queued inits for the same socket and character preserve the newest update', async () => {
        const first = dispatch('init_character_data', initial('a', { 1: loadout('a', 'First init') }), socketA);
        const second = dispatch('init_character_data', initial('a', { 2: loadout('a', 'Second init') }), socketA);
        const latest = { 3: loadout('a', 'Newest update') };
        await dispatch('loadouts_updated', { characterLoadoutMap: latest }, socketA);
        await Promise.all([first, second]);
        expect(dataManager.characterData.characterLoadoutMap).toEqual(latest);
    });

    test('an invalid init does not block later valid updates from the installed connection', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await dispatch('init_character_data', { character: { id: 'a' } }, socketA);
            await dispatch('loadouts_updated', { characterLoadoutMap: {} }, socketA);
            expect(dataManager.characterData.characterLoadoutMap).toEqual({});
            expect(snapshots.getAllSnapshots()).toEqual([]);
        } finally {
            log.mockRestore();
        }
    });

    test('a failed older init cannot clear a newer same-socket same-character update', async () => {
        const real = dataManager._handleInitCharacterData.bind(dataManager);
        const handling = vi
            .spyOn(dataManager, '_handleInitCharacterData')
            .mockImplementationOnce(async () => {
                throw new Error('first init failed');
            })
            .mockImplementation(real);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const first = dispatch('init_character_data', initial('a', {}), socketA);
        const second = dispatch('init_character_data', initial('a', { 2: loadout('a', 'Second init') }), socketA);
        const latest = { 3: loadout('a', 'Newest update') };
        await dispatch('loadouts_updated', { characterLoadoutMap: latest }, socketA);
        try {
            await Promise.all([first, second]);
            expect(dataManager.characterData.characterLoadoutMap).toEqual(latest);
        } finally {
            handling.mockRestore();
            log.mockRestore();
        }
    });
});
