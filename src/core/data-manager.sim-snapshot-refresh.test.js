/**
 * The simulator snapshot (`toolasha_init_character_data`) is written when the player opens a simulator
 * through Toolasha's link. A simulator imports talismans and the belt from it, so once a snapshot exists
 * this session, a talismans_updated (or a belt change) rewrites it, once per burst.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

let webSocketHandlers = new Map();
const saveSnapshot = vi.hoisted(() => vi.fn(() => true));
const lightSnapshot = vi.hoisted(() => vi.fn(() => true));

vi.mock('./websocket.js', () => {
    webSocketHandlers = new Map();

    return {
        default: {
            on: vi.fn((event, handler) => {
                webSocketHandlers.set(event, handler);
            }),
            off: vi.fn(),
            onSocketEvent: vi.fn(),
            offSocketEvent: vi.fn(),
            saveCombatSimSnapshot: saveSnapshot,
            writeCombatSimCharacterSnapshot: lightSnapshot,
        },
    };
});

vi.mock('./storage.js', () => ({
    default: {
        getJSON: async (_key, _store, fallback) => fallback,
        setJSON: async () => true,
        get: async (_key, _store, fallback = null) => fallback,
        set: async () => true,
        flushAll: async () => {},
    },
}));

const initPayload = (id = 'char-1') => ({
    character: { id, name: `Tester ${id}` },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
});

const talismanMessage = (grade = 1) => ({
    endCharacterTalismans: [
        {
            id: 2624,
            characterID: 'char-1',
            talismanTypeHrid: '/talisman_types/combat',
            modifiers: [{ hrid: '/talisman_modifiers/max_hitpoints', grade }],
            slotIndex: 1,
        },
    ],
    deletedTalismanIds: [],
});

let dataManager;

async function login(id) {
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
    await webSocketHandlers.get('init_character_data')(initPayload(id));
}

beforeEach(async () => {
    ({ default: dataManager } = await import('./data-manager.js'));
    dataManager.currentCharacterId = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
    dataManager.isCharacterSwitching = false;
    dataManager._simSnapshotCharacterId = null;
    dataManager._simSnapshotRefreshTimer = null;
    saveSnapshot.mockClear();
    lightSnapshot.mockClear();
});

afterEach(() => {
    dataManager.cleanupIntervals();
    vi.useRealTimers();
});

const writes = () => lightSnapshot.mock.calls.length + saveSnapshot.mock.calls.length;

async function openedSimFor(id) {
    await login(id);
    expect(dataManager.saveSimulatorSnapshot()).toBe(true);
    saveSnapshot.mockClear();
    lightSnapshot.mockClear();
}

describe('simulator snapshot refresh', () => {
    test('no snapshot has been written this session, so a talismans_updated writes nothing', async () => {
        await login('char-1');
        vi.useFakeTimers();
        webSocketHandlers.get('talismans_updated')(talismanMessage());
        await vi.advanceTimersByTimeAsync(10000);
        expect(writes()).toBe(0);
    });

    test('a burst settles into one light write, after the last update, with the latest talismans', async () => {
        await openedSimFor('char-1');
        vi.useFakeTimers();

        // Updates every 2 s (a reroll session) keep restarting the wait: nothing is written mid-burst
        for (let grade = 1; grade <= 4; grade++) {
            webSocketHandlers.get('talismans_updated')(talismanMessage(grade));
            await vi.advanceTimersByTimeAsync(2000);
        }
        expect(writes()).toBe(0);
        await vi.advanceTimersByTimeAsync(3000);

        expect(lightSnapshot).toHaveBeenCalledTimes(1);
        expect(lightSnapshot.mock.calls[0][0].characterTalismans[0].modifiers[0].grade).toBe(4);
        expect(lightSnapshot.mock.calls[0][1]).toMatchObject({ characterId: 'char-1' });
        // Not the client-data or battle bridges: the full write is the sim-link path only
        expect(saveSnapshot).not.toHaveBeenCalled();

        webSocketHandlers.get('talismans_updated')(talismanMessage(5));
        await vi.advanceTimersByTimeAsync(5000);
        expect(lightSnapshot).toHaveBeenCalledTimes(2);
    });

    test('a belt change refreshes it too, and another equipment slot does not', async () => {
        await openedSimFor('char-1');
        vi.useFakeTimers();

        dataManager.updateEquipmentMap([
            { itemLocationHrid: '/item_locations/body', itemHrid: '/items/plate_body', count: 1 },
        ]);
        await vi.advanceTimersByTimeAsync(6000);
        expect(writes()).toBe(0);

        dataManager.updateEquipmentMap([
            { itemLocationHrid: '/item_locations/belt', itemHrid: '/items/large_talisman_belt', count: 1 },
        ]);
        await vi.advanceTimersByTimeAsync(6000);
        expect(lightSnapshot).toHaveBeenCalledTimes(1);
    });

    test('a character switch before the timer fires cancels the write', async () => {
        await openedSimFor('char-1');
        vi.useFakeTimers();

        webSocketHandlers.get('talismans_updated')(talismanMessage());
        dataManager.isCharacterSwitching = true;
        await vi.advanceTimersByTimeAsync(6000);
        expect(writes()).toBe(0);
    });

    test("another character's session never refreshes the previous character's snapshot", async () => {
        await openedSimFor('char-1');
        await login('char-2');
        vi.useFakeTimers();

        webSocketHandlers.get('talismans_updated')(talismanMessage());
        await vi.advanceTimersByTimeAsync(6000);
        expect(writes()).toBe(0);
    });

    test('switching A to B and back to A does not re-arm A until a snapshot is written again', async () => {
        await openedSimFor('char-1');
        await webSocketHandlers.get('init_character_data')(initPayload('char-2'));
        await webSocketHandlers.get('init_character_data')(initPayload('char-1'));
        expect(dataManager._simSnapshotCharacterId).toBeNull();
        vi.useFakeTimers();

        webSocketHandlers.get('talismans_updated')(talismanMessage());
        await vi.advanceTimersByTimeAsync(6000);
        expect(writes()).toBe(0);

        // Opening a simulator again for A arms it again
        expect(dataManager.saveSimulatorSnapshot()).toBe(true);
        lightSnapshot.mockClear();
        webSocketHandlers.get('talismans_updated')(talismanMessage(2));
        await vi.advanceTimersByTimeAsync(6000);
        expect(lightSnapshot).toHaveBeenCalledTimes(1);
    });
});
