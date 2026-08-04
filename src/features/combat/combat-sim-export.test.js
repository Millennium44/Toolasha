/**
 * Tests for the GM-storage bridge ownership guard in combat-sim-export.js.
 *
 * Covers the read side of the character-clobber fix: websocket.js stamps every GM-bridged
 * payload with a sibling `${key}_meta` key ({characterId, characterName, writtenAt}); these
 * tests exercise checkBridgeStamp()'s pass-through / refuse / stale-warn / legacy-accept
 * behavior, plus one end-to-end check through constructExportObject() to confirm the guard is
 * actually wired into the character-data read path that feeds the "Import from Toolasha" button.
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

const { checkBridgeStamp, getLastBridgeIssue, constructExportObject } = await import('./combat-sim-export.js');

function metaFor(characterId, { characterName = 'Hero', writtenAt = Date.now() } = {}) {
    return JSON.stringify({ characterId, characterName, writtenAt });
}

beforeEach(() => {
    dataManagerMock.characterData = null;
    dataManagerMock.battleData = null;
    dataManagerMock.characterEquipment = new Map();
    dataManagerMock.getInitClientData.mockReset().mockReturnValue(null);
    dataManagerMock.getCurrentCharacterId.mockReset().mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    delete globalThis.GM_getValue;
    vi.restoreAllMocks();
});

describe('checkBridgeStamp', () => {
    test('no GM_getValue available (non-Tampermonkey context) is treated as safe to use', () => {
        expect(checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true })).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('legacy unstamped value (no meta key at all) is accepted with a "legacy, unverified" note', () => {
        globalThis.GM_getValue = vi.fn(() => null);

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy, unverified'));
    });

    test('matching read (stamp characterId equals the current character) passes through unchanged', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-1');
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1'));

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('mismatched read refuses with a clear console warning and a user-facing message', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-2');
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1', { characterName: 'OtherToon' }));

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(false);
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('OtherToon'));
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('another tab'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Refusing'));
    });

    test('mismatch is not refused when enforceOwner is false (e.g. client data / profile list)', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-2');
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1'));

        const ok = checkBridgeStamp('toolasha_init_client_data', 'Client data', { enforceOwner: false });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('a stale payload warns but does not block, even when the character matches', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-1');
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1', { writtenAt: twoHoursAgo }));

        const ok = checkBridgeStamp('toolasha_new_battle', 'Battle data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('may be stale'));
    });

    test('a corrupt meta value is treated the same as no stamp (legacy, unverified)', () => {
        globalThis.GM_getValue = vi.fn(() => '{not valid json');

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy, unverified'));
    });
});

describe('constructExportObject with the GM-storage fallback', () => {
    test('refuses and returns null when the character-data bridge belongs to another character', async () => {
        dataManagerMock.characterData = null; // force the GM fallback
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-mine');

        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-theirs', name: 'NotMe' }, characterSkills: [] });
            }
            if (key === 'toolasha_init_character_data_meta') {
                return metaFor('char-theirs', { characterName: 'NotMe' });
            }
            return null;
        });

        const result = await constructExportObject();

        expect(result).toBeNull();
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('NotMe'));
    });

    test('uses the GM fallback normally when its stamp matches the current character', async () => {
        dataManagerMock.characterData = null;
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-mine');

        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-mine', name: 'Me' }, characterSkills: [] });
            }
            if (key === 'toolasha_init_character_data_meta') {
                return metaFor('char-mine', { characterName: 'Me' });
            }
            return null;
        });

        const result = await constructExportObject();

        expect(result).not.toBeNull();
        expect(result.playerIDs[0]).toBe('Me');
        expect(getLastBridgeIssue()).toBeNull();
    });
});
