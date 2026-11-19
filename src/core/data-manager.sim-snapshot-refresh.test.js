/**
 * The simulator snapshot (`toolasha_init_character_data`) is written when the player opens a simulator
 * through Toolasha's link. A simulator imports talismans and the belt from it, so once a snapshot exists
 * this session, a talismans_updated (or a belt change) rewrites it, once per burst.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

let webSocketHandlers = new Map();
const saveSnapshot = vi.hoisted(() => vi.fn(() => true));

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
});

afterEach(() => {
    dataManager.cleanupIntervals();
    vi.useRealTimers();
});

describe('simulator snapshot refresh', () => {
    test('no snapshot has been written this session, so a talismans_updated writes nothing', async () => {
        await login('char-1');
        vi.useFakeTimers();
        webSocketHandlers.get('talismans_updated')(talismanMessage());
        await vi.advanceTimersByTimeAsync(5000);
        expect(saveSnapshot).not.toHaveBeenCalled();
    });

    test('after a snapshot, a burst of updates rewrites it once', async () => {
        await login('char-1');
        expect(dataManager.saveSimulatorSnapshot()).toBe(true);
        saveSnapshot.mockClear();
        vi.useFakeTimers();

        webSocketHandlers.get('talismans_updated')(talismanMessage(1));
        await vi.advanceTimersByTimeAsync(500);
        webSocketHandlers.get('talismans_updated')(talismanMessage(2));
        webSocketHandlers.get('talismans_updated')(talismanMessage(3));
        expect(saveSnapshot).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2500);

        expect(saveSnapshot).toHaveBeenCalledTimes(1);
        // The snapshot carries the latest talismans of the burst
        expect(saveSnapshot.mock.calls[0][0].characterTalismans[0].modifiers[0].grade).toBe(3);

        // A later burst writes again
        webSocketHandlers.get('talismans_updated')(talismanMessage(4));
        await vi.advanceTimersByTimeAsync(2500);
        expect(saveSnapshot).toHaveBeenCalledTimes(2);
    });

    test('a belt change refreshes it too, and another equipment slot does not', async () => {
        await login('char-1');
        dataManager.saveSimulatorSnapshot();
        saveSnapshot.mockClear();
        vi.useFakeTimers();

        dataManager.updateEquipmentMap([
            { itemLocationHrid: '/item_locations/body', itemHrid: '/items/plate_body', count: 1 },
        ]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(saveSnapshot).not.toHaveBeenCalled();

        dataManager.updateEquipmentMap([
            { itemLocationHrid: '/item_locations/belt', itemHrid: '/items/large_talisman_belt', count: 1 },
        ]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(saveSnapshot).toHaveBeenCalledTimes(1);
    });

    test('a character switch before the timer fires cancels the write', async () => {
        await login('char-1');
        dataManager.saveSimulatorSnapshot();
        saveSnapshot.mockClear();
        vi.useFakeTimers();

        webSocketHandlers.get('talismans_updated')(talismanMessage());
        dataManager.isCharacterSwitching = true;
        await vi.advanceTimersByTimeAsync(3000);
        expect(saveSnapshot).not.toHaveBeenCalled();
    });

    test("another character's session never refreshes the previous character's snapshot", async () => {
        await login('char-1');
        dataManager.saveSimulatorSnapshot();
        await login('char-2');
        saveSnapshot.mockClear();
        vi.useFakeTimers();

        webSocketHandlers.get('talismans_updated')(talismanMessage());
        await vi.advanceTimersByTimeAsync(3000);
        expect(saveSnapshot).not.toHaveBeenCalled();
    });
});
