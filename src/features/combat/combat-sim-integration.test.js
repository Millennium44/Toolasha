/**
 * Tests for the GM-storage bridge ownership guard as wired into combat-sim-integration.js.
 *
 * The guard logic itself (checkBridgeStamp) is exercised in depth in combat-sim-export.test.js;
 * these tests confirm this file's own GM fallbacks (getCharacterDataFromStorage /
 * getClientDataFromStorage — the Skill Calculator's data source when running on the Shykai
 * page) call it with the right key/enforcement, and that a mismatch is refused instead of
 * silently handing back another character's data.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { dataManagerMock } = vi.hoisted(() => ({
    dataManagerMock: {
        characterData: null,
        battleData: null,
        characterEquipment: new Map(),
        getInitClientData: vi.fn(() => null),
        getCurrentCharacterId: vi.fn(() => null),
    },
}));

vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));

vi.mock('../../core/storage.js', () => ({
    default: {
        available: false,
        getJSON: vi.fn(async () => null),
        setJSON: vi.fn(async () => {}),
    },
}));

const { getCharacterDataFromStorage, getClientDataFromStorage } = await import('./combat-sim-integration.js');
const { getLastBridgeIssue } = await import('./combat-sim-export.js');

function metaFor(characterId, { characterName = 'Hero', writtenAt = Date.now() } = {}) {
    return JSON.stringify({ characterId, characterName, writtenAt });
}

beforeEach(() => {
    dataManagerMock.characterData = null;
    dataManagerMock.battleData = null;
    dataManagerMock.getInitClientData.mockReset().mockReturnValue(null);
    dataManagerMock.getCurrentCharacterId.mockReset().mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    delete globalThis.GM_getValue;
    vi.restoreAllMocks();
});

describe('getCharacterDataFromStorage', () => {
    test('prefers live dataManager data and never touches GM storage', () => {
        dataManagerMock.characterData = { character: { id: 'char-1', name: 'Live' } };
        globalThis.GM_getValue = vi.fn();

        const result = getCharacterDataFromStorage();

        expect(result).toEqual({ character: { id: 'char-1', name: 'Live' } });
        expect(globalThis.GM_getValue).not.toHaveBeenCalled();
    });

    test('falls back to GM storage and returns it unchanged when the stamp matches this tab', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-1');
        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-1', name: 'Me' } });
            }
            if (key === 'toolasha_init_character_data_meta') {
                return metaFor('char-1', { characterName: 'Me' });
            }
            return null;
        });

        const result = getCharacterDataFromStorage();

        expect(result).toEqual({ character: { id: 'char-1', name: 'Me' } });
    });

    test('refuses a GM value stamped for a different character and warns instead of returning it', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-2');
        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-1', name: 'OtherToon' } });
            }
            if (key === 'toolasha_init_character_data_meta') {
                return metaFor('char-1', { characterName: 'OtherToon' });
            }
            return null;
        });

        const result = getCharacterDataFromStorage();

        expect(result).toBeNull();
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('OtherToon'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OtherToon'));
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No character data'));
    });

    test('accepts a legacy value with no meta stamp rather than breaking', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-1');
        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-1', name: 'Legacy' } });
            }
            return null; // no _meta key at all — pre-stamp write
        });

        const result = getCharacterDataFromStorage();

        expect(result).toEqual({ character: { id: 'char-1', name: 'Legacy' } });
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy, unverified'));
    });
});

describe('getClientDataFromStorage', () => {
    test('does not refuse a mismatched writer, since client data is character-independent', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-2');
        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_client_data') {
                return JSON.stringify({ levelExperienceTable: [0, 100] });
            }
            if (key === 'toolasha_init_client_data_meta') {
                return metaFor('char-1');
            }
            return null;
        });

        const result = getClientDataFromStorage();

        expect(result).toEqual({ levelExperienceTable: [0, 100] });
    });
});
