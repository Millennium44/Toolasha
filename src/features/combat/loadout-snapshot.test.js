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

const game = vi.hoisted(() => ({ items: [], characterId: 'char1', loadoutMap: undefined, writes: [] }));

/** The store, with `getJSON` swappable so a test can land a switch inside a read */
const store = vi.hoisted(() => ({ getJSON: async () => null }));

// Records every subscription so the tests can see *when* the module attaches
// its handler — the point of the lazy hookup is that importing costs nothing.
const ws = vi.hoisted(() => ({ onCalls: [] }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => ws.onCalls.push({ event, handler }),
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        setJSON: (key, value) => game.writes.push({ key, value }),
        getJSON: (...args) => store.getJSON(...args),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterItems() {
            return game.items;
        },
        getCurrentCharacterId: () => game.characterId,
        get characterData() {
            return game.loadoutMap ? { characterLoadoutMap: game.loadoutMap } : {};
        },
        // initialize() re-reads under the character-scoped key when this fires
        on: () => {},
        off: () => {},
    },
}));

const {
    default: loadoutSnapshot,
    highestOwnedEnhancements,
    resolveEnhancementLevel,
} = await import('./loadout-snapshot.js');

// Snapshot taken before any test touches the store: what importing alone cost
const subscriptionsAtImport = ws.onCalls.length;

const CAPE = '/items/gatherer_cape_refined';
const owned = (hrid, enhancementLevel, count = 1) => ({ itemHrid: hrid, enhancementLevel, count });

beforeEach(() => {
    game.items = [];
    game.characterId = 'char1';
    game.loadoutMap = undefined;
    game.writes = [];
    store.getJSON = async () => null;
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

    test('getSnapshotForSkill wears the resolved levels, not the stored ones', () => {
        // The path every calculator reads gear through. Unresolved, the
        // enhancing outfit was quoted at the level it had when the loadout was
        // last saved — +12 gear the character had long since taken to +20.
        game.items = [owned(CAPE, 20)];
        const store = new loadoutSnapshot.constructor();
        store.snapshotsReady = true;
        store.snapshots = {
            Enhancing: {
                name: 'Enhancing',
                actionTypeHrid: '/action_types/enhancing',
                isDefault: true,
                useExactEnhancement: false,
                equipment: [{ itemLocationHrid: '/item_locations/back', itemHrid: CAPE, enhancementLevel: 12 }],
            },
        };

        const map = store.getSnapshotForSkill('/action_types/enhancing');
        expect(map.get('/item_locations/back').enhancementLevel).toBe(20);
    });
});

/**
 * This module is inlined into every production bundle, but only the combat
 * bundle's copy is ever read — the rest are dead weight, and a constructor-time
 * WebSocket subscription had all of them rebuilding private caches on every
 * loadouts_updated message. The subscription is paid for on first use instead.
 */
describe('lazy websocket subscription', () => {
    test('importing the module subscribes to nothing', () => {
        expect(subscriptionsAtImport).toBe(0);
    });

    test('constructing a store subscribes to nothing', () => {
        const before = ws.onCalls.length;
        new loadoutSnapshot.constructor();
        expect(ws.onCalls.length).toBe(before);
    });

    test('the first read subscribes, once, and data then flows in', () => {
        const store = new loadoutSnapshot.constructor();
        const before = ws.onCalls.length;

        expect(store.getAllSnapshots()).toEqual([]);
        expect(ws.onCalls.length).toBe(before + 1);
        expect(ws.onCalls[before].event).toBe('loadouts_updated');

        // A second read does not stack another handler
        store.getAllSnapshots();
        expect(ws.onCalls.length).toBe(before + 1);

        // The handler the read attached is live: a message fills the store
        ws.onCalls[before].handler({ characterLoadoutMap: { 1: { name: 'Fighting' } } });
        expect(store.getAllSnapshots().map((s) => s.name)).toEqual(['Fighting']);
    });

    // The server's own characterLoadoutID (the characterLoadoutMap key each
    // loadout arrived under) is carried onto the snapshot itself, not just
    // kept as `snapshots`'s own object key — a caller holding only
    // `getAllSnapshots()`'s flat array (the Combat Simulator's per-sweep
    // loadout pickers, say) needs a persistent identity two same-named
    // loadouts don't offer, and an array index doesn't survive a reorder or
    // another loadout's deletion.
    test('a snapshot carries the server loadout id it arrived under', () => {
        const store = new loadoutSnapshot.constructor();
        const before = ws.onCalls.length;
        store.getAllSnapshots();

        ws.onCalls[before].handler({
            characterLoadoutMap: { 42: { name: 'Fighting' }, 7: { name: 'Skilling' } },
        });

        const byName = Object.fromEntries(store.getAllSnapshots().map((s) => [s.name, s.id]));
        expect(byName).toEqual({ Fighting: '42', Skilling: '7' });
    });

    test('a read after disable() subscribes again', () => {
        const store = new loadoutSnapshot.constructor();
        store.getAllSnapshots();
        store.disable();
        const before = ws.onCalls.length;

        store.getAllSnapshots();

        expect(ws.onCalls.length).toBe(before + 1);
    });
});

/**
 * An empty `snapshots` is two different states wearing the same face: a
 * character with no loadouts, and a store that has not finished reading
 * IndexedDB. A consumer that cannot tell them apart simulates the wrong gear
 * and reports the result as fact, so the store says which one it is.
 */
describe('whether the store has actually loaded', () => {
    test('starts unloaded and a wait is still pending', async () => {
        const store = new loadoutSnapshot.constructor();
        expect(store.snapshotsReady).toBe(false);

        let settled = false;
        store.whenReady(50_000).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
    });

    test('a loadouts message marks it loaded and releases the wait', async () => {
        const store = new loadoutSnapshot.constructor();
        const waited = store.whenReady(50_000);

        store._onLoadoutsUpdated({ characterLoadoutMap: { 1: { name: 'Fighting' } } });

        await expect(waited).resolves.toBe(true);
        expect(store.snapshotsReady).toBe(true);
    });

    test('initializing marks it loaded even when the character has no loadouts', async () => {
        const store = new loadoutSnapshot.constructor();
        await store.initialize();
        expect(store.snapshotsReady).toBe(true);
        // An empty store that has spoken is an answer, not a pending question
        expect(store.snapshots).toEqual({});
    });

    test('a wait cannot hang forever when nothing ever loads', async () => {
        vi.useFakeTimers();
        try {
            const store = new loadoutSnapshot.constructor();
            const waited = store.whenReady(5000);
            await vi.advanceTimersByTimeAsync(5000);
            await expect(waited).resolves.toBe(true);
            expect(store.snapshotsReady).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * disable() is the teardown half of a character switch — feature-registry
 * calls it before the next character's initialize() runs. initialize()'s
 * "only load if empty" guard (so a `loadouts_updated` message that arrived
 * first is not clobbered by a slower storage read) assumes an empty cache
 * means "nothing has loaded yet". Left un-cleared across a switch, that
 * assumption is false: the next character's initialize() sees the previous
 * character's snapshots still sitting there, treats the store as already
 * loaded, and never reads the new character's storage key at all.
 */
describe('switching characters', () => {
    test('disable clears the cached snapshots, not just the listeners', () => {
        const store = new loadoutSnapshot.constructor();
        store._onLoadoutsUpdated({ characterLoadoutMap: { 1: { name: 'Fighting' } } });
        expect(store.snapshots).not.toEqual({});

        store.disable();

        expect(store.snapshots).toEqual({});
    });

    test('disable resets the ready flag, so the next character waits for its own load', () => {
        const store = new loadoutSnapshot.constructor();
        store._onLoadoutsUpdated({ characterLoadoutMap: { 1: { name: 'Fighting' } } });
        expect(store.snapshotsReady).toBe(true);

        store.disable();

        expect(store.snapshotsReady).toBe(false);
    });

    test('a load that lands after the switch does not put the departing character’s gear back', async () => {
        const snapshots = new loadoutSnapshot.constructor();
        // The read was issued under char1 and answers with char1's loadouts,
        // but the player is on char2 by the time it lands
        store.getJSON = async () => {
            game.characterId = 'char2';
            return { 1: { name: 'Fighting', wearableHash: '' } };
        };

        await snapshots.initialize();

        // Adopting them would make the "already loaded" guard skip char2's own
        // read, and every write below would then file char1's loadouts under
        // char2's key
        expect(snapshots.getAllSnapshots()).toHaveLength(0);
        expect(snapshots.snapshots).toEqual({});
    });

    test('initialize after disable loads again instead of keeping the old character’s cache', async () => {
        const store = new loadoutSnapshot.constructor();
        await store.initialize();
        store._onLoadoutsUpdated({ characterLoadoutMap: { 1: { name: 'Fighting' } } });
        expect(store.getAllSnapshots()).toHaveLength(1);

        store.disable();
        await store.initialize();

        // Storage is mocked empty for every character in this file, so a
        // genuine reload lands back at nothing — the old bug instead left
        // the previous character's one snapshot in place because the
        // "already loaded" guard skipped the read entirely.
        expect(store.getAllSnapshots()).toHaveLength(0);
    });
});

describe('the login data corrects a saved copy', () => {
    const NECK = '/item_locations/neck';
    const SOLD = '/items/necklace_of_speed';
    const WORN = '/items/philosophers_necklace';
    // The game's shape: keyed by loadout id, the wearable as a hash that usually says +0
    const serverLoadout = (itemHrid, extra = {}) => ({
        id: 39837,
        characterID: 'char1',
        actionTypeHrid: '/action_types/combat',
        name: 'Melee - Stab',
        isDefault: true,
        useExactEnhancement: false,
        ordinal: 1,
        wearableMap: { [NECK]: `char1::/item_locations/inventory::${itemHrid}::0` },
        foodItemHrids: ['/items/gummy'],
        drinkItemHrids: [],
        abilityMap: {},
        ...extra,
    });
    const fresh = async () => {
        const instance = new loadoutSnapshot.constructor();
        await instance.initialize();
        return instance;
    };
    const neckOf = (instance) =>
        Object.values(instance.snapshots)[0].equipment.find((e) => e.itemLocationHrid === NECK);
    const saved = (instance, itemHrid, level = 5) => {
        instance._onLoadoutsUpdated({ characterLoadoutMap: { 39837: serverLoadout(itemHrid) } });
        const stored = JSON.parse(JSON.stringify(instance.snapshots));
        stored[39837].equipment[0].enhancementLevel = level;
        stored[39837].savedAt = 1;
        game.writes = [];
        return stored;
    };

    test('gear sold while this script missed the update leaves every loadout at login', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        store.getJSON = async () => stored;
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        const instance = await fresh();

        expect(neckOf(instance).itemHrid).toBe(WORN);
        expect(game.writes.at(-1).key).toBe('loadout_snapshots_char1');
        expect(game.writes.at(-1).value[39837].equipment[0].itemHrid).toBe(WORN);
    });

    test('so does a stale copy when the character-scoped read comes back later', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        const instance = await fresh();
        const updates = [];
        instance.onUpdate(() => updates.push(neckOf(instance).itemHrid));
        store.getJSON = async () => stored;
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        await instance.characterInitializedHandler();

        expect(updates).toEqual([WORN]);
    });

    test('an ordinary login writes nothing and keeps the level already worked out', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), WORN);
        store.getJSON = async () => stored;
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        const instance = await fresh();

        expect(game.writes).toEqual([]);
        expect(neckOf(instance).enhancementLevel).toBe(5);
    });

    test('one loadout changing keeps the worked-out level of the others, and of what stays worn', async () => {
        const instance = new loadoutSnapshot.constructor();
        const CAPE_SLOT = '/item_locations/back';
        const wearing = (cape, neck) => ({
            [CAPE_SLOT]: `char1::/item_locations/inventory::${cape}::0`,
            [NECK]: `char1::/item_locations/inventory::${neck}::0`,
        });
        instance._onLoadoutsUpdated({
            characterLoadoutMap: {
                39837: serverLoadout(SOLD, { wearableMap: wearing(CAPE, SOLD) }),
                40000: serverLoadout(WORN, { id: 40000, name: 'Ranged', wearableMap: wearing(CAPE, WORN) }),
            },
        });
        const stored = JSON.parse(JSON.stringify(instance.snapshots));
        for (const id of ['39837', '40000']) {
            for (const equip of stored[id].equipment) equip.enhancementLevel = 7;
        }
        store.getJSON = async () => stored;
        game.loadoutMap = {
            39837: serverLoadout(WORN, { wearableMap: wearing(CAPE, WORN) }),
            40000: serverLoadout(WORN, { id: 40000, name: 'Ranged', wearableMap: wearing(CAPE, WORN) }),
        };

        const { snapshots } = await fresh();
        const levels = (id) => Object.fromEntries(snapshots[id].equipment.map((e) => [e.itemHrid, e.enhancementLevel]));

        // The new necklace starts from what the game says; everything that stayed keeps its +7
        expect(levels('39837')).toEqual({ [CAPE]: 7, [WORN]: 0 });
        expect(levels('40000')).toEqual({ [CAPE]: 7, [WORN]: 7 });
    });

    test('an item with no earlier level starts from the best copy owned, not the hash +0', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        store.getJSON = async () => stored;
        game.items = [owned(WORN, 10), owned(WORN, 3), owned(WORN, 0)];
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        expect(neckOf(await fresh()).enhancementLevel).toBe(10);
    });

    test('a loadout switched from a pinned level to highest owned does not keep the pinned level', async () => {
        const instance = new loadoutSnapshot.constructor();
        instance._onLoadoutsUpdated({
            characterLoadoutMap: { 39837: serverLoadout(WORN, { useExactEnhancement: true }) },
        });
        store.getJSON = async () => JSON.parse(JSON.stringify(instance.snapshots));
        game.items = [owned(WORN, 10)];
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        expect(neckOf(await fresh()).enhancementLevel).toBe(10);
    });

    test('an item nothing owns stays at what the game says', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        store.getJSON = async () => stored;
        game.items = [];
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        expect(neckOf(await fresh()).enhancementLevel).toBe(0);
    });

    test('a listener that throws neither stops the others nor the rest of startup', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        store.getJSON = async () => stored;
        game.loadoutMap = { 39837: serverLoadout(WORN) };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const instance = new loadoutSnapshot.constructor();
        const reached = [];
        instance.onUpdate(() => {
            throw new Error('a panel failed');
        });
        instance.onUpdate(() => reached.push('second'));

        await instance.initialize();

        expect(reached).toEqual(['second']);
        expect(instance.characterInitializedHandler).toBeTypeOf('function');
        vi.restoreAllMocks();
    });

    test('a level the loadout is pinned to does count as a change', async () => {
        const instance = new loadoutSnapshot.constructor();
        instance._onLoadoutsUpdated({
            characterLoadoutMap: { 39837: serverLoadout(WORN, { useExactEnhancement: true }) },
        });
        const stored = JSON.parse(JSON.stringify(instance.snapshots));
        stored[39837].equipment[0].enhancementLevel = 5;
        store.getJSON = async () => stored;
        game.loadoutMap = { 39837: serverLoadout(WORN, { useExactEnhancement: true }) };

        expect(neckOf(await fresh()).enhancementLevel).toBe(0);
    });

    test('a loadout deleted elsewhere goes, and one added elsewhere comes', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), WORN);
        store.getJSON = async () => stored;
        game.loadoutMap = { 40000: serverLoadout(WORN, { id: 40000, name: 'Ranged' }) };

        const instance = await fresh();

        expect(Object.keys(instance.snapshots)).toEqual(['40000']);
    });

    test('a character with every loadout deleted ends with none, an empty map being the server’s word', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), WORN);
        store.getJSON = async () => stored;
        game.loadoutMap = {};

        expect((await fresh()).snapshots).toEqual({});
    });

    test('with no map to read the saved copy stands', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        store.getJSON = async () => stored;

        expect(neckOf(await fresh()).itemHrid).toBe(SOLD);
        expect(game.writes).toEqual([]);
    });

    test('another character’s map never lands under this character’s key', async () => {
        const stored = saved(new loadoutSnapshot.constructor(), SOLD);
        store.getJSON = async () => stored;
        game.loadoutMap = { 39837: serverLoadout(WORN, { characterID: 'someone-else' }) };

        expect(neckOf(await fresh()).itemHrid).toBe(SOLD);
        expect(game.writes).toEqual([]);
    });

    test('a store with nothing saved is filled from the login data', async () => {
        game.loadoutMap = { 39837: serverLoadout(WORN) };

        expect(neckOf(await fresh()).itemHrid).toBe(WORN);
    });
});
