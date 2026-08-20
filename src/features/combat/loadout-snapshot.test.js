/**
 * What a loadout is really wearing.
 *
 * A snapshot is parsed from the game's wearable hash, and that hash carries the
 * enhancement level from the moment the loadout was last saved — usually 0. The
 * game itself equips the highest copy you own unless the loadout is pinned to an
 * exact enhancement, so reading the stored number back reports a refined cape at
 * +0 while the character is standing there wearing it at +10.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: [] }));

vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({ default: { setJSON: () => {}, getJSON: async () => null } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterItems() {
            return game.items;
        },
        getCurrentCharacterId: () => 'char1',
    },
}));

const {
    default: loadoutSnapshot,
    highestOwnedEnhancements,
    resolveEnhancementLevel,
} = await import('./loadout-snapshot.js');

const CAPE = '/items/gatherer_cape_refined';
const owned = (hrid, enhancementLevel, count = 1) => ({ itemHrid: hrid, enhancementLevel, count });

beforeEach(() => {
    game.items = [];
});

describe('the best copy owned', () => {
    test('is the highest of the ones you have', () => {
        game.items = [owned(CAPE, 3), owned(CAPE, 10), owned(CAPE, 7)];

        expect(highestOwnedEnhancements().get(CAPE)).toBe(10);
    });

    test('counts what is worn as well as what is in the bag', () => {
        // Equipped pieces sit in characterItems alongside the loose ones, which
        // is exactly what "highest owned" means to the game
        game.items = [{ itemHrid: CAPE, enhancementLevel: 10, count: 1, itemLocationHrid: '/item_locations/back' }];

        expect(highestOwnedEnhancements().get(CAPE)).toBe(10);
    });

    test('and not one you no longer hold', () => {
        game.items = [owned(CAPE, 14, 0), owned(CAPE, 5)];

        expect(highestOwnedEnhancements().get(CAPE)).toBe(5);
    });

    test('an equipped copy with no count field still counts', () => {
        // Equipped items don't reliably carry a count the way stacked inventory
        // items do — a missing count must not let a lower duplicate in the bag
        // outrank the actually-equipped higher copy
        game.items = [
            { itemHrid: CAPE, enhancementLevel: 12, itemLocationHrid: '/item_locations/back' },
            owned(CAPE, 5),
        ];

        expect(highestOwnedEnhancements().get(CAPE)).toBe(12);
    });

    test('an item you own none of is absent rather than zero', () => {
        expect(highestOwnedEnhancements().has(CAPE)).toBe(false);
    });
});

describe('what one slot ends up at', () => {
    const equip = { itemHrid: CAPE, enhancementLevel: 0 };

    test('the best owned, where the loadout takes the highest', () => {
        const level = resolveEnhancementLevel({ useExactEnhancement: false }, equip, new Map([[CAPE, 10]]));

        expect(level).toBe(10);
    });

    test('even when the stored level is a stale non-zero', () => {
        // Enhancing the cape after saving the loadout does not rewrite the hash
        const stale = { itemHrid: CAPE, enhancementLevel: 10 };
        const level = resolveEnhancementLevel({ useExactEnhancement: false }, stale, new Map([[CAPE, 14]]));

        expect(level).toBe(14);
    });

    test('but a pinned loadout wears exactly what it says', () => {
        const pinned = { itemHrid: CAPE, enhancementLevel: 3 };
        const level = resolveEnhancementLevel({ useExactEnhancement: true }, pinned, new Map([[CAPE, 14]]));

        expect(level).toBe(3);
    });

    test('including a pinned bare one, which is a choice and not a gap', () => {
        const pinned = { itemHrid: CAPE, enhancementLevel: 0 };

        expect(resolveEnhancementLevel({ useExactEnhancement: true }, pinned, new Map([[CAPE, 14]]))).toBe(0);
    });

    test('and an inventory that has not loaded never lowers a known level', () => {
        // An empty map is "we do not know yet", not "you own nothing" — dropping
        // a known +10 to 0 on the strength of it is worse than being stale
        const known = { itemHrid: CAPE, enhancementLevel: 10 };

        expect(resolveEnhancementLevel({}, known, new Map())).toBe(10);
        expect(resolveEnhancementLevel({}, known, undefined)).toBe(10);
    });
});

describe('a whole loadout at once', () => {
    test('every slot resolved, the rest of the entry untouched', () => {
        game.items = [owned(CAPE, 10), owned('/items/eye_watch', 14)];
        const snapshot = {
            useExactEnhancement: false,
            equipment: [
                { itemLocationHrid: '/item_locations/back', itemHrid: CAPE, enhancementLevel: 0 },
                { itemLocationHrid: '/item_locations/trinket', itemHrid: '/items/eye_watch', enhancementLevel: 0 },
            ],
        };

        const resolved = loadoutSnapshot.resolveEquipment(snapshot);

        expect(resolved.map((e) => e.enhancementLevel)).toEqual([10, 14]);
        expect(resolved[0].itemLocationHrid).toBe('/item_locations/back');
    });

    test('the snapshot itself is not rewritten', () => {
        // Snapshots are persisted; resolving is a read, and a loadout that
        // silently gained levels on disk could never be told from one the player
        // actually re-saved
        game.items = [owned(CAPE, 10)];
        const snapshot = { equipment: [{ itemHrid: CAPE, enhancementLevel: 0 }] };

        loadoutSnapshot.resolveEquipment(snapshot);

        expect(snapshot.equipment[0].enhancementLevel).toBe(0);
    });

    test('no equipment is an empty list rather than a throw', () => {
        expect(loadoutSnapshot.resolveEquipment(null)).toEqual([]);
        expect(loadoutSnapshot.resolveEquipment({})).toEqual([]);
    });
});
