/**
 * The account cannot be asked which of its characters are iron cows — the game
 * only ever describes the one you are logged into — so the answer is a pile of
 * things written down at previous logins, and the failure that matters is
 * treating "never seen" as "not an iron cow". A copy aimed at the iron cows
 * that silently misses one is worse than one that says which it skipped.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    characterId: 'char-1',
    gameMode: 'standard',
    store: new Map(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => mocks.characterId,
        getCurrentCharacterGameMode: () => mocks.gameMode,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback = null) => (mocks.store.has(key) ? mocks.store.get(key) : fallback),
        setJSON: async (key, value) => {
            mocks.store.set(key, value);
            return true;
        },
    },
}));

const {
    CHARACTER_MODES_KEY,
    isIronCowGameMode,
    getCharacterGameModes,
    recordCurrentCharacterGameMode,
    selectIronCowTargets,
    characterLabel,
    describeIronCowCopy,
} = await import('./character-modes.js');

const CHARACTERS = [
    { id: 'char-1', name: 'Main' },
    { id: 'char-2', name: 'Bessie' },
    { id: 'char-3', name: 'Daisy' },
    { id: 'char-4', name: 'Alt' },
    { id: 'char-5', name: 'char-5' },
];

beforeEach(() => {
    mocks.store = new Map();
    mocks.characterId = 'char-1';
    mocks.gameMode = 'standard';
});

describe('what counts as an iron cow', () => {
    test('both of the game\'s iron cow modes do, and "standard" does not', () => {
        expect(isIronCowGameMode('ironcow')).toBe(true);
        expect(isIronCowGameMode('legacy_ironcow')).toBe(true);
        expect(isIronCowGameMode('standard')).toBe(false);
    });

    test('anything that is not a mode string is not one', () => {
        expect(isIronCowGameMode(undefined)).toBe(false);
        expect(isIronCowGameMode(null)).toBe(false);
        expect(isIronCowGameMode('')).toBe(false);
        expect(isIronCowGameMode({ mode: 'ironcow' })).toBe(false);
    });
});

describe('recording the mode of whoever is logged in', () => {
    test('it writes the current character down', async () => {
        mocks.gameMode = 'ironcow';
        expect(await recordCurrentCharacterGameMode()).toEqual({ id: 'char-1', mode: 'ironcow' });
        expect(await getCharacterGameModes()).toEqual({ 'char-1': 'ironcow' });
    });

    test('each character joins the others rather than replacing them', async () => {
        mocks.gameMode = 'standard';
        await recordCurrentCharacterGameMode();
        mocks.characterId = 'char-2';
        mocks.gameMode = 'ironcow';
        await recordCurrentCharacterGameMode();

        expect(await getCharacterGameModes()).toEqual({ 'char-1': 'standard', 'char-2': 'ironcow' });
    });

    test('an unchanged mode is not written again', async () => {
        mocks.gameMode = 'ironcow';
        await recordCurrentCharacterGameMode();
        mocks.store.set(CHARACTER_MODES_KEY, { 'char-1': 'ironcow', sentinel: 'kept' });

        await recordCurrentCharacterGameMode();
        expect(mocks.store.get(CHARACTER_MODES_KEY).sentinel).toBe('kept');
    });

    test('before login there is nothing to record', async () => {
        mocks.characterId = '';
        expect(await recordCurrentCharacterGameMode()).toBe(null);
        mocks.characterId = 'char-1';
        mocks.gameMode = null;
        expect(await recordCurrentCharacterGameMode()).toBe(null);
        expect(await getCharacterGameModes()).toEqual({});
    });
});

describe('choosing who a copy goes to', () => {
    const modes = {
        'char-1': 'standard',
        'char-2': 'ironcow',
        'char-3': 'legacy_ironcow',
        'char-4': 'standard',
    };

    test('only the recorded iron cows, and never yourself', () => {
        const { targets } = selectIronCowTargets(CHARACTERS, modes, 'char-1');
        expect(targets.map((c) => c.id)).toEqual(['char-2', 'char-3']);
    });

    test('an iron cow you are logged into is still not a target — it is already saved', () => {
        const { targets } = selectIronCowTargets(CHARACTERS, modes, 'char-2');
        expect(targets.map((c) => c.id)).toEqual(['char-3']);
    });

    test('a character never seen is unknown rather than assumed', () => {
        const { targets, unknown, others } = selectIronCowTargets(CHARACTERS, modes, 'char-1');
        expect(unknown.map((c) => c.id)).toEqual(['char-5']);
        expect(others.map((c) => c.id)).toEqual(['char-4']);
        expect(targets.map((c) => c.id)).not.toContain('char-5');
    });

    test('no recorded modes at all means everything is unknown, not everything is a cow', () => {
        const { targets, unknown } = selectIronCowTargets(CHARACTERS, {}, 'char-1');
        expect(targets).toEqual([]);
        expect(unknown).toHaveLength(4);
    });

    test('nothing to choose from is not an error', () => {
        expect(selectIronCowTargets(null, null, '')).toEqual({ targets: [], unknown: [], others: [] });
    });
});

describe('what the copy says afterwards', () => {
    test('the plain case is a count', () => {
        expect(describeIronCowCopy(2)).toBe('Settings copied to 2 iron cow characters.');
        expect(describeIronCowCopy(1)).toBe('Settings copied to 1 iron cow character.');
    });

    test('the skipped characters are named, because a count is not actionable', () => {
        const message = describeIronCowCopy(2, [{ id: 'char-5', name: 'char-5' }]);
        expect(message).toContain('Settings copied to 2 iron cow characters.');
        expect(message).toContain('Character char-5');
        expect(message).toContain('log in');
    });

    test('a character with a real name is called by it', () => {
        expect(characterLabel({ id: 'char-2', name: 'Bessie' })).toBe('Bessie');
        expect(characterLabel({ id: 'char-5', name: 'char-5' })).toBe('Character char-5');
    });
});
