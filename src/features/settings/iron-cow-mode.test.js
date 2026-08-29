/**
 * Iron Cow mode's snapshot key, and when it is decided.
 *
 * `disable()` reads the snapshot, restores every managed setting from it and
 * then deletes it. The read and the delete are separated by awaits, and the key
 * is per-character — so a key derived after those awaits is derived against
 * whichever character the pointer names *then*. A player toggling the mode off
 * as a character switch lands would have the departing character's snapshot
 * left behind and the arriving character's deleted.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    characterId: 'char1',
    /** `storeName::key` → value */
    store: new Map(),
    /** Every key `delete` was called with, in order */
    deleted: [],
    /** Settings written back by `disable()` */
    restored: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const k = `${store}::${key}`;
            // The read is where the switch lands: the player clicked the toggle
            // and the character pointer moved while IndexedDB was answering.
            const value = world.store.has(k) ? world.store.get(k) : fallback;
            world.characterId = 'char2';
            return value;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            world.store.set(`${store}::${key}`, value);
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            world.deleted.push(key);
            world.store.delete(`${store}::${key}`);
            return true;
        }),
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        settingsMap: { invWorth: { type: 'checkbox', isTrue: true } },
        getSetting: () => true,
        setSetting: (id, value) => world.restored.push([id, value]),
        setSettingValue: (id, value) => world.restored.push([id, value]),
    },
}));

const { default: ironCowMode } = await import('./iron-cow-mode.js');

describe('iron cow mode — the snapshot key survives a mid-teardown character switch', () => {
    beforeEach(() => {
        world.characterId = 'char1';
        world.store = new Map();
        world.deleted = [];
        world.restored = [];
    });

    test('disable() deletes the snapshot it read, not the arriving character’s', async () => {
        world.store.set('settings::toolasha_ironCowSnapshot_char1', {
            invWorth: { type: 'checkbox', value: true },
        });
        world.store.set('settings::toolasha_ironCowSnapshot_char2', {
            invWorth: { type: 'checkbox', value: false },
        });

        await ironCowMode.disable();

        // The snapshot that was consumed is the one that is removed
        expect(world.restored).toEqual([['invWorth', true]]);
        expect(world.deleted).toEqual(['toolasha_ironCowSnapshot_char1']);
        // ...and the character who just arrived still has theirs
        expect(world.store.has('settings::toolasha_ironCowSnapshot_char2')).toBe(true);
    });
});
