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
        settingsMap: {
            invWorth: { type: 'checkbox', isTrue: true },
            market_showOrderTotals: { type: 'checkbox', isTrue: true },
            market_listingDateFormat: { type: 'select', value: 'MM-DD' },
            market_listingTimeFormat: { type: 'select', value: '24hour' },
            market_listingAge: { type: 'select', value: 'both' },
            inv_valueBadges: { type: 'select', value: 'alwaysAsk' },
        },
        getSetting: () => true,
        setSetting: (id, value) => world.restored.push([id, value]),
        setSettingValue: (id, value) => world.restored.push([id, value]),
    },
}));

const { default: ironCowMode, IRON_COW_SETTINGS } = await import('./iron-cow-mode.js');

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

// A market display that is a dropdown rather than a switch still has to go off.
// "Disabled" for a select is its schema default, which is right for a row whose
// default is off and wrong for the merged listing-age row, whose default shows
// the order book — an Iron Cow character would have kept a marketplace column.
describe('iron cow mode turns the merged market dropdowns off, not to their defaults', () => {
    beforeEach(() => {
        world.characterId = 'char1';
        world.store = new Map();
        world.deleted = [];
        world.restored = [];
    });

    test('the listing-age and value-badge rows are forced to their off value', async () => {
        await ironCowMode.enable();

        const written = Object.fromEntries(world.restored);
        expect(written.market_listingAge).toBe('off');
        expect(written.inv_valueBadges).toBe('off');
    });

    test('and both are managed by the mode in the first place', () => {
        expect(IRON_COW_SETTINGS.has('market_listingAge')).toBe(true);
        expect(IRON_COW_SETTINGS.has('inv_valueBadges')).toBe(true);
    });
});

// The market_ prefix on the date/time format preferences is legacy naming: they are
// read by formatDateTime, the Character Activity collector and Pop-out Chat, none of
// which an Iron Cow character loses. Forcing them to schema defaults reset the
// player's clock and date display every time the mode was toggled.
describe('iron cow mode leaves the date and time display formats alone', () => {
    beforeEach(() => {
        world.characterId = 'char1';
        world.store = new Map();
        world.deleted = [];
        world.restored = [];
    });

    test('neither format setting is managed by the mode', () => {
        expect(IRON_COW_SETTINGS.has('market_listingDateFormat')).toBe(false);
        expect(IRON_COW_SETTINGS.has('market_listingTimeFormat')).toBe(false);
        // A genuinely marketplace-only neighbour still is
        expect(IRON_COW_SETTINGS.has('market_showOrderTotals')).toBe(true);
    });

    test('a snapshot an older build wrote does not write the formats back', async () => {
        world.store.set('settings::toolasha_ironCowSnapshot_char1', {
            market_showOrderTotals: { type: 'checkbox', value: true },
            market_listingDateFormat: { type: 'select', value: 'MM-DD' },
            market_listingTimeFormat: { type: 'select', value: '24hour' },
        });

        await ironCowMode.disable();

        expect(world.restored).toEqual([['market_showOrderTotals', true]]);
    });
});
