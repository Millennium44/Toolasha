/**
 * talismans_updated: keeping characterData.characterTalismans current.
 *
 * Shapes are the ones measured on the test server (2026-11-12; slotIndex is 1-based, 0 = unslotted): a row is
 * {id, characterID, talismanTypeHrid, modifiers:[{hrid, grade}], pendingModifiers,
 * lockedModifierHrid, slotIndex}; the message is {endCharacterTalismans, deletedTalismanIds}.
 * Live servers have neither the field nor the message, so "absent" must read as empty.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

let webSocketHandlers = new Map();

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
            saveCombatSimSnapshot: vi.fn(() => true),
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

const initPayload = (overrides = {}) => ({
    character: { id: 'char-1', name: 'Tester' },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
    ...overrides,
});

// The real row from the survey, so a second row of the SAME type can prove merges key on id
const talisman = (overrides = {}) => ({
    id: 2624,
    characterID: 'char-1',
    talismanTypeHrid: '/talisman_types/combat',
    modifiers: [{ hrid: '/talisman_modifiers/max_hitpoints', grade: 2 }],
    pendingModifiers: null,
    lockedModifierHrid: '',
    slotIndex: 1,
    ...overrides,
});

let dataManager;

async function login(overrides = {}) {
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
    await webSocketHandlers.get('init_character_data')(initPayload(overrides));
}

beforeEach(async () => {
    ({ default: dataManager } = await import('./data-manager.js'));
    dataManager.currentCharacterId = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
});

describe('talismans_updated', () => {
    test('init without characterTalismans reads as empty, and not loaded', async () => {
        await login();
        expect(dataManager.getCharacterTalismans()).toEqual([]);
        expect(dataManager.getSlottedTalismans()).toEqual([]);
        expect(dataManager.hasTalismansLoaded()).toBe(false);
    });

    test('with no character at all the accessors return empty arrays', () => {
        expect(dataManager.getCharacterTalismans()).toEqual([]);
        expect(dataManager.getSlottedTalismans()).toEqual([]);
    });

    test('a login list is readable, and an owned-but-empty list counts as loaded', async () => {
        await login({ characterTalismans: [] });
        expect(dataManager.hasTalismansLoaded()).toBe(true);
        await login({ characterTalismans: [talisman()] });
        expect(dataManager.getCharacterTalismans()).toHaveLength(1);
        expect(dataManager.getSlottedTalismans()).toHaveLength(1);
    });

    test('a message creates, updates by id, and deletes, and tells listeners each time', async () => {
        await login();
        const listener = vi.fn();
        dataManager.on('talismans_updated', listener);

        webSocketHandlers.get('talismans_updated')({ endCharacterTalismans: [talisman()], deletedTalismanIds: [] });
        expect(dataManager.getCharacterTalismans().map((t) => t.id)).toEqual([2624]);

        // Unslotted and regraded: same id, so one row, not two
        webSocketHandlers.get('talismans_updated')({
            endCharacterTalismans: [
                talisman({ slotIndex: 0, modifiers: [{ hrid: '/talisman_modifiers/max_hitpoints', grade: 3 }] }),
            ],
            deletedTalismanIds: [],
        });
        expect(dataManager.getCharacterTalismans()).toHaveLength(1);
        expect(dataManager.getCharacterTalismans()[0].modifiers[0].grade).toBe(3);
        expect(dataManager.getSlottedTalismans()).toEqual([]);

        webSocketHandlers.get('talismans_updated')({ endCharacterTalismans: [], deletedTalismanIds: [2624] });
        expect(dataManager.getCharacterTalismans()).toEqual([]);
        expect(dataManager.hasTalismansLoaded()).toBe(true);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
    });

    test('two talismans of one type stay two, and slotted ones come back in slot order', async () => {
        await login({ characterTalismans: [talisman({ id: 1, slotIndex: 3 })] });
        webSocketHandlers.get('talismans_updated')({
            endCharacterTalismans: [talisman({ id: 2, slotIndex: 1 }), talisman({ id: 3, slotIndex: 0 })],
            deletedTalismanIds: [],
        });
        expect(dataManager.getCharacterTalismans()).toHaveLength(3);
        expect(dataManager.getSlottedTalismans().map((t) => t.id)).toEqual([2, 1]);

        // A delete-only message (no endCharacterTalismans key) removes one and leaves its sibling
        webSocketHandlers.get('talismans_updated')({ deletedTalismanIds: [1] });
        expect(dataManager.getCharacterTalismans().map((t) => t.id)).toEqual([2, 3]);
    });

    test('the real slot message carries deletedTalismanIds: null, which means no deletions', async () => {
        await login({ characterTalismans: [talisman({ slotIndex: 0 })] });
        webSocketHandlers.get('talismans_updated')({
            type: 'talismans_updated',
            endCharacterTalismans: [talisman({ slotIndex: 2 })],
            deletedTalismanIds: null,
        });
        expect(dataManager.getSlottedTalismans().map((t) => t.slotIndex)).toEqual([2]);
        expect(dataManager.getCharacterTalismans()).toHaveLength(1);
    });

    test('a missing slotIndex is unslotted, and 0 is the unslotted value (slots are 1-based)', async () => {
        const { slotIndex: _slot, ...bare } = talisman({ id: 7 });
        await login({ characterTalismans: [bare] });
        expect(dataManager.getSlottedTalismans()).toEqual([]);
    });

    test('a row naming another character is ignored', async () => {
        await login({ characterTalismans: [talisman()] });
        webSocketHandlers.get('talismans_updated')({
            endCharacterTalismans: [talisman({ id: 99, characterID: 'someone-else' })],
            deletedTalismanIds: [],
        });
        expect(dataManager.getCharacterTalismans().map((t) => t.id)).toEqual([2624]);
    });

    test('a message from a socket that is not the active one is ignored', async () => {
        await login({ characterTalismans: [talisman()] });
        const listener = vi.fn();
        dataManager.on('talismans_updated', listener);
        dataManager.activeSocket = { name: 'active' };
        webSocketHandlers.get('talismans_updated')(
            { endCharacterTalismans: [], deletedTalismanIds: [2624] },
            { socket: { name: 'departing' } }
        );
        expect(dataManager.getCharacterTalismans()).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(listener).not.toHaveBeenCalled();
    });

    test('an empty or malformed message changes nothing and emits nothing', async () => {
        await login();
        const listener = vi.fn();
        dataManager.on('talismans_updated', listener);
        webSocketHandlers.get('talismans_updated')({});
        webSocketHandlers.get('talismans_updated')(null);
        webSocketHandlers.get('talismans_updated')({ endCharacterTalismans: 'x', deletedTalismanIds: 5 });
        expect(dataManager.hasTalismansLoaded()).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(listener).not.toHaveBeenCalled();
    });
});
