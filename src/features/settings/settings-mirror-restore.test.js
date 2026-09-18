/**
 * Tests for settings-mirror-restore.js — the offer to restore a character's
 * settings from the GM-side mirror when the live map is missing.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const stored = new Map();
/** When true, tryGet answers "could not be made" (null) */
const unreadable = { on: false };

vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: vi.fn(async (key) => {
            if (unreadable.on) return null;
            return stored.has(key) ? { found: true, value: stored.get(key) } : { found: false, value: null };
        }),
    },
}));

const { settingsStorageMock } = vi.hoisted(() => {
    const mock = {
        storageKey: 'script_settingsMap',
        storageArea: 'settings',
        currentCharacterId: null,
        currentCharacterName: null,
        // The real one moves `currentCharacterId`, and the restore path reads
        // it back after the dialog to check the player is still on the
        // character the offer was for — a mock that only records the call
        // cannot see that.
        setCharacterId: vi.fn((characterId, characterName) => {
            mock.currentCharacterId = characterId;
            if (characterName) mock.currentCharacterName = characterName;
        }),
        importSettings: vi.fn(async () => ({ imported: 1, skipped: 0 })),
    };
    return { settingsStorageMock: mock };
});
vi.mock('../../core/settings-storage.js', () => ({ default: settingsStorageMock }));

const { settingsMirrorMock } = vi.hoisted(() => ({
    settingsMirrorMock: { getMirroredEntry: vi.fn(() => null) },
}));
vi.mock('../../core/settings-mirror.js', () => ({ default: settingsMirrorMock }));

const { askChoiceMock } = vi.hoisted(() => ({ askChoiceMock: vi.fn(async () => null) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: askChoiceMock }));

const { default: settingsMirrorRestore } = await import('./settings-mirror-restore.js');

beforeEach(() => {
    stored.clear();
    unreadable.on = false;
    settingsStorageMock.currentCharacterId = null;
    settingsStorageMock.currentCharacterName = null;
    settingsStorageMock.setCharacterId.mockClear();
    settingsStorageMock.importSettings.mockClear();
    settingsMirrorMock.getMirroredEntry.mockReset().mockReturnValue(null);
    askChoiceMock.mockReset().mockResolvedValue(null);
});

describe('maybeOffer', () => {
    test('no-ops without a characterId', async () => {
        await settingsMirrorRestore.maybeOffer(null, 'Hero');
        expect(settingsStorageMock.importSettings).not.toHaveBeenCalled();
        expect(askChoiceMock).not.toHaveBeenCalled();
    });

    test('never offers when the character already has a live settings map', async () => {
        stored.set('script_settingsMap_char1', { theme: { id: 'theme', value: 'dark' } });
        settingsMirrorMock.getMirroredEntry.mockReturnValue({ theme: { id: 'theme', value: 'light' } });

        await settingsMirrorRestore.maybeOffer('char1', 'Hero');

        expect(askChoiceMock).not.toHaveBeenCalled();
        expect(settingsStorageMock.importSettings).not.toHaveBeenCalled();
    });

    test('never offers when the live read could not be made (unreadable, not absent)', async () => {
        unreadable.on = true;
        settingsMirrorMock.getMirroredEntry.mockReturnValue({ theme: { id: 'theme', value: 'light' } });

        await settingsMirrorRestore.maybeOffer('char1', 'Hero');

        expect(askChoiceMock).not.toHaveBeenCalled();
        expect(settingsStorageMock.importSettings).not.toHaveBeenCalled();
    });

    test('never offers when the map is absent but the mirror has nothing for this character', async () => {
        settingsMirrorMock.getMirroredEntry.mockReturnValue(null);

        await settingsMirrorRestore.maybeOffer('char1', 'Hero');

        expect(askChoiceMock).not.toHaveBeenCalled();
    });

    test('offers when the map is absent and the mirror has an entry, and does nothing on decline', async () => {
        settingsMirrorMock.getMirroredEntry.mockReturnValue({ theme: { id: 'theme', value: 'light' } });
        askChoiceMock.mockResolvedValue('skip');

        await settingsMirrorRestore.maybeOffer('char1', 'Hero');

        expect(askChoiceMock).toHaveBeenCalledTimes(1);
        expect(settingsStorageMock.importSettings).not.toHaveBeenCalled();
    });

    test('restores through importSettings on acceptance, with only the settings-map key', async () => {
        const mirroredMap = { theme: { id: 'theme', value: 'light' } };
        settingsMirrorMock.getMirroredEntry.mockReturnValue(mirroredMap);
        askChoiceMock.mockResolvedValue('restore');

        await settingsMirrorRestore.maybeOffer('char1', 'Hero');

        expect(settingsStorageMock.importSettings).toHaveBeenCalledTimes(1);
        const [payloadJson] = settingsStorageMock.importSettings.mock.calls[0];
        const payload = JSON.parse(payloadJson);
        expect(payload).toEqual({ script_settingsMap_char1: mirroredMap });
    });

    test('sets the character id before probing, so importSettings matches the right character', async () => {
        settingsMirrorMock.getMirroredEntry.mockReturnValue({ theme: { id: 'theme', value: 'light' } });
        await settingsMirrorRestore.maybeOffer('char1', 'Hero');
        expect(settingsStorageMock.setCharacterId).toHaveBeenCalledWith('char1', 'Hero');
    });

    test('a restore accepted after the player has switched characters is abandoned, not silently skipped', async () => {
        settingsMirrorMock.getMirroredEntry.mockReturnValue({ theme: { id: 'theme', value: 'light' } });
        // The player leaves the dialog open, goes out to character select and
        // picks a different character — whose own load moves the id — and only
        // then clicks Restore.
        askChoiceMock.mockImplementation(async () => {
            settingsStorageMock.setCharacterId('char2', 'Other');
            return 'restore';
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await settingsMirrorRestore.maybeOffer('char1', 'Hero');

        // importSettings would have filtered char1's key out as "another
        // character's" and reported a successful import of nothing.
        expect(settingsStorageMock.importSettings).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('a thrown error anywhere is caught, not propagated', async () => {
        settingsMirrorMock.getMirroredEntry.mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(settingsMirrorRestore.maybeOffer('char1', 'Hero')).resolves.toBeUndefined();
    });
});
