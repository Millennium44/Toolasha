/**
 * The panel's own state, and the two rules it keeps.
 *
 * Every key is per character — an iron cow's plan is not the main's — and the
 * only thing that can be stored is a tick that is on. A tick turned off is
 * removed rather than written as `false`, so a stale `false` can never sit in
 * storage arguing with a stage the character has since finished.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({ values: {} }));

vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, _store, fallback) => (base in disk.values ? disk.values[base] : fallback),
    writeScoped: async (base, value) => {
        disk.values[base] = value;
        return true;
    },
}));

const { loadOverrides, setOverride, loadSnapshot, saveSnapshot, OVERRIDES_KEY, SNAPSHOT_KEY } =
    await import('./ironcow-store.js');

beforeEach(() => {
    disk.values = {};
});

describe('the stage ticks', () => {
    test('start empty', async () => {
        await expect(loadOverrides()).resolves.toEqual({});
    });

    test('a tick round-trips', async () => {
        await setOverride('rooms', true);
        expect(disk.values[OVERRIDES_KEY]).toEqual({ rooms: true });
        await expect(loadOverrides()).resolves.toEqual({ rooms: true });
    });

    test('unticking removes the key rather than storing a false', async () => {
        await setOverride('rooms', true);
        await setOverride('rooms', false);
        expect(disk.values[OVERRIDES_KEY]).toEqual({});
    });

    test('anything stored that is not a tick is dropped on the way in', async () => {
        disk.values[OVERRIDES_KEY] = { rooms: true, jewelry: false, alchemy: 'yes' };
        await expect(loadOverrides()).resolves.toEqual({ rooms: true });
    });

    test('a stored shape that is not a map at all is nothing, not a crash', async () => {
        disk.values[OVERRIDES_KEY] = ['rooms'];
        await expect(loadOverrides()).resolves.toEqual({});
        disk.values[OVERRIDES_KEY] = 'rooms';
        await expect(loadOverrides()).resolves.toEqual({});
    });
});

describe('the last costed loop', () => {
    test('is nothing until one has been costed', async () => {
        await expect(loadSnapshot()).resolves.toBeNull();
    });

    test('round-trips', async () => {
        await saveSnapshot({ goldPerHour: 277_500, computedAt: 1 });
        expect(disk.values[SNAPSHOT_KEY]).toMatchObject({ goldPerHour: 277_500 });
        await expect(loadSnapshot()).resolves.toMatchObject({ goldPerHour: 277_500 });
    });

    test('a null result clears rather than half-writes', async () => {
        await saveSnapshot({ goldPerHour: 1 });
        await saveSnapshot(null);
        await expect(loadSnapshot()).resolves.toBeNull();
    });
});
