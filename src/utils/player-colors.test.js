/**
 * Player colours: legible, stable, and distinct inside one party.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {}, gets: 0, sets: [], release: null }));

vi.mock('../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            store.gets += 1;
            if (store.release) await store.release;
            return store.data[key] ?? fallback;
        },
        set: async (key, value, storeName) => {
            store.sets.push({ key, value, storeName });
            store.data[key] = value;
        },
    },
}));

const {
    PLAYER_PALETTE,
    PANEL_GROUND,
    MIN_CONTRAST,
    contrastRatio,
    legibleColor,
    normalizeHex,
    hashName,
    resolveRosterColors,
    playerColor,
    setPlayerColor,
    loadPlayerColors,
    _resetPlayerColors,
} = await import('./player-colors.js');

beforeEach(() => {
    store.data = {};
    store.gets = 0;
    store.sets = [];
    store.release = null;
    _resetPlayerColors();
});

describe('legible on the dark panels', () => {
    test('every palette colour clears AA contrast against the panel ground', () => {
        for (const color of PLAYER_PALETTE) {
            expect(contrastRatio(color, PANEL_GROUND), color).toBeGreaterThanOrEqual(MIN_CONTRAST);
        }
        expect(new Set(PLAYER_PALETTE).size).toBe(PLAYER_PALETTE.length);
    });

    test('a dark pick is lifted until it reads, and a readable one is left alone', () => {
        const lifted = legibleColor('#000000');
        expect(contrastRatio(lifted, PANEL_GROUND)).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(legibleColor('#ffa726')).toBe('#ffa726');
        expect(legibleColor('#abc')).toBe('#aabbcc');
        expect(legibleColor('red')).toBeNull();
        expect(normalizeHex('#ABCDEF')).toBe('#abcdef');
    });
});

describe('assignment', () => {
    test('the hash ignores case and surrounding space', () => {
        expect(hashName(' Estevao ')).toBe(hashName('estevao'));
    });

    test('a party of up to twelve never shares a colour', () => {
        const names = Array.from({ length: 12 }, (_, i) => `Player${i}`);
        const colors = resolveRosterColors(names);
        expect(new Set(colors.values()).size).toBe(12);
        for (const name of names) expect(playerColor(name)).toBe(colors.get(name.toLowerCase()));
    });

    test('the same roster resolves the same way whatever order it is listed in', () => {
        const a = resolveRosterColors(['Cara', 'Abe', 'Bo']);
        _resetPlayerColors();
        const b = resolveRosterColors(['Bo', 'Cara', 'Abe']);
        expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    });

    test('someone joining does not recolour the players already on screen', () => {
        const before = resolveRosterColors(['Abe', 'Bo', 'Cara']);
        const after = resolveRosterColors(['Abe', 'Bo', 'Cara', 'Dee', 'Eve', 'Fay']);
        for (const [key, color] of before) expect(after.get(key)).toBe(color);
    });
});

describe('a picked colour', () => {
    test('wins over the hash and is stored by name', async () => {
        await setPlayerColor('Abe', '#FFA726');
        expect(playerColor('abe')).toBe('#ffa726');
        expect(store.sets.at(-1)).toMatchObject({ key: 'playerColors', storeName: 'settings' });
        expect(store.sets.at(-1).value.abe.value).toBe('#ffa726');

        // Another player hashing onto the same slot is moved off it
        const colors = resolveRosterColors(['Abe', 'Bo', 'Cara', 'Dee']);
        const others = [...colors.entries()].filter(([key]) => key !== 'abe').map(([, color]) => color);
        expect(others).not.toContain('#ffa726');
    });

    test('clearing it hands the player back to the palette', async () => {
        await setPlayerColor('Abe', '#123456');
        await setPlayerColor('Abe', null);
        expect(PLAYER_PALETTE).toContain(playerColor('Abe'));
        expect(store.data.playerColors.abe).toBeUndefined();
    });

    test('a pick made while the stored map is still loading is not undone by it, nor does it erase the rest', async () => {
        store.data.playerColors = { bo: { value: '#42a5f5', at: 1 }, abe: { value: '#ef5350', at: 1 } };
        let open;
        store.release = new Promise((resolve) => {
            open = resolve;
        });

        const loading = loadPlayerColors();
        const writing = setPlayerColor('Abe', '#66bb6a');
        expect(playerColor('Abe')).toBe('#66bb6a');

        open();
        await loading;
        await writing;

        expect(playerColor('Abe')).toBe('#66bb6a');
        expect(playerColor('Bo')).toBe('#42a5f5');
        expect(store.data.playerColors.bo.value).toBe('#42a5f5');
        expect(store.data.playerColors.abe.value).toBe('#66bb6a');
    });

    test('an invalid stored value is ignored rather than drawn', async () => {
        store.data.playerColors = { abe: { value: 'javascript:alert(1)', at: 1 } };
        await loadPlayerColors();
        expect(PLAYER_PALETTE).toContain(playerColor('Abe'));
    });
});
