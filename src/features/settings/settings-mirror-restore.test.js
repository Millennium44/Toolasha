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

const { settingsStorageMock } = vi.hoisted(() => ({
    settingsStorageMock: {
        storageKey: 'script_settingsMap',
        storageArea: 'settings',
        setCharacterId: vi.fn(),
        importSettings: vi.fn(async () => ({ imported: 1, skipped: 0 })),
    },
}));
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

    test('a thrown error anywhere is caught, not propagated', async () => {
        settingsMirrorMock.getMirroredEntry.mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(settingsMirrorRestore.maybeOffer('char1', 'Hero')).resolves.toBeUndefined();
    });
});
