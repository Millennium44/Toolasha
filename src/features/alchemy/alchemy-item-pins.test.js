import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => 'standard',
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { togglePin, orderTiles, sameOrder, mergePins, default: pins } = await import('./alchemy-item-pins.js');

/** Stand-ins for tiles; the ordering never touches the DOM */
const tile = (hrid) => ({ hrid });
const hridOf = (t) => t.hrid;

describe('togglePin', () => {
    test('pins and unpins within one action', () => {
        const pinned = togglePin({}, 'coinify', '/items/cheese');
        expect(pinned.coinify).toEqual(['/items/cheese']);
        expect(togglePin(pinned, 'coinify', '/items/cheese').coinify).toEqual([]);
    });

    test('a new pin goes to the end, not the front', () => {
        // Otherwise the list rearranges itself every time you add to it, and the
        // one you reach for most keeps moving
        const pins = togglePin(togglePin({}, 'coinify', '/items/a'), 'coinify', '/items/b');
        expect(pins.coinify).toEqual(['/items/a', '/items/b']);
    });

    test('actions keep separate lists', () => {
        // What is worth coinifying is rarely what is worth decomposing
        const pins = togglePin(togglePin({}, 'coinify', '/items/a'), 'decompose', '/items/b');
        expect(pins).toEqual({ coinify: ['/items/a'], decompose: ['/items/b'] });
    });

    test('ignores a toggle with nothing to toggle', () => {
        expect(togglePin({ coinify: ['/items/a'] }, '', '/items/b')).toEqual({ coinify: ['/items/a'] });
        expect(togglePin(null, 'coinify', '')).toEqual({});
    });
});

describe('orderTiles', () => {
    const tiles = ['/items/a', '/items/b', '/items/c', '/items/d'].map(tile);

    test('pinned first, in pin order', () => {
        const out = orderTiles(tiles, ['/items/c', '/items/a'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/c', '/items/a', '/items/b', '/items/d']);
    });

    test('everything else keeps the order the game gave it', () => {
        const out = orderTiles(tiles, ['/items/d'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/d', '/items/a', '/items/b', '/items/c']);
    });

    test('a pin for an item not on screen changes nothing', () => {
        // The filter box hides most of the list most of the time
        const out = orderTiles(tiles, ['/items/zzz'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/a', '/items/b', '/items/c', '/items/d']);
    });

    test('a cell standing for no item keeps the front', () => {
        // The Remove cell shares the grid; pinning something must not push the
        // way to clear the selection down behind it
        const withRemove = [tile(''), ...tiles];
        const out = orderTiles(withRemove, ['/items/c'], hridOf);
        expect(out.map(hridOf)).toEqual(['', '/items/c', '/items/a', '/items/b', '/items/d']);
    });

    test('no pins leaves the order alone', () => {
        expect(orderTiles(tiles, [], hridOf)).toEqual(tiles);
        expect(orderTiles(tiles, null, hridOf)).toEqual(tiles);
    });

    test('survives having no tiles', () => {
        expect(orderTiles(null, ['/items/a'], hridOf)).toEqual([]);
    });
});

describe('sameOrder', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(tile);

    test('recognises an order that has not moved', () => {
        // Reordering is itself a mutation, and the watcher that reacts to
        // mutations would never stop if it could not tell
        expect(sameOrder([a, b, c], [a, b, c])).toBe(true);
    });

    test('spots a move and a length change', () => {
        expect(sameOrder([a, b, c], [b, a, c])).toBe(false);
        expect(sameOrder([a, b], [a, b, c])).toBe(false);
    });
});

describe('mergePins', () => {
    test('keeps the stored order and appends what was pinned since', () => {
        const merged = mergePins({ coinify: ['/items/a', '/items/b'] }, { coinify: ['/items/b', '/items/c'] });
        expect(merged).toEqual({ coinify: ['/items/a', '/items/b', '/items/c'] });
    });

    test('actions only one side has are kept', () => {
        expect(mergePins({ coinify: ['/items/a'] }, { decompose: ['/items/b'] })).toEqual({
            coinify: ['/items/a'],
            decompose: ['/items/b'],
        });
        expect(mergePins(null, undefined)).toEqual({});
    });
});

describe('the stored pins', () => {
    const KEY = 'alchemyItemPins_char1';
    const stored = () => storageMock.storeFor('settings').get(KEY);
    const seed = (value) => storageMock.storeFor('settings').set(KEY, value);

    beforeEach(() => {
        storageMock.reset();
        dataManagerMock.characterId = 'char1';
        pins.pins = {};
        pins.pinsOwner = null;
    });

    test("reads this character's pins back and writes them under the same key", async () => {
        seed({ coinify: ['/items/a'] });
        expect(await pins.loadPins()).toBe(true);
        expect(pins.pins).toEqual({ coinify: ['/items/a'] });

        pins.pins = togglePin(pins.pins, 'coinify', '/items/b');
        await pins.savePins();
        expect(stored()).toEqual({ coinify: ['/items/a', '/items/b'] });
    });

    test('a load that cannot be made keeps the pins in hand rather than blanking them', async () => {
        seed({ coinify: ['/items/a'] });
        await pins.loadPins();
        storageMock.unavailable = true;
        expect(await pins.loadPins()).toBe(false);
        expect(pins.pins).toEqual({ coinify: ['/items/a'] });
    });

    test("but not another character's pins", async () => {
        seed({ coinify: ['/items/a'] });
        await pins.loadPins();
        dataManagerMock.characterId = 'char2';
        storageMock.unavailable = true;
        await pins.loadPins();
        expect(pins.pins).toEqual({});
    });

    test('a save over a store that cannot be read is skipped, and what is stored stays', async () => {
        seed({ coinify: ['/items/a'] });
        storageMock.unavailable = true;
        await pins.loadPins();
        pins.pins = togglePin(pins.pins, 'coinify', '/items/b');
        expect(await pins.savePins()).toBe(false);
        storageMock.unavailable = false;
        expect(stored()).toEqual({ coinify: ['/items/a'] });
    });

    test('a save before the pins were read back loses no stored pin', async () => {
        seed({ coinify: ['/items/a'], decompose: ['/items/z'] });
        storageMock.unavailable = true;
        await pins.loadPins();
        storageMock.unavailable = false;

        pins.pins = togglePin(pins.pins, 'coinify', '/items/b');
        await pins.savePins();
        expect(stored()).toEqual({ coinify: ['/items/a', '/items/b'], decompose: ['/items/z'] });
    });

    test('after a readable load an unpin sticks', async () => {
        seed({ coinify: ['/items/a', '/items/b'] });
        await pins.loadPins();
        pins.pins = togglePin(pins.pins, 'coinify', '/items/a');
        await pins.savePins();
        expect(stored()).toEqual({ coinify: ['/items/b'] });
    });

    test('once storage is back, the next save lands', async () => {
        storageMock.unavailable = true;
        await pins.loadPins();
        pins.pins = togglePin(pins.pins, 'coinify', '/items/a');
        expect(await pins.savePins()).toBe(false);

        storageMock.unavailable = false;
        expect(await pins.savePins()).toBe(true);
        expect(stored()).toEqual({ coinify: ['/items/a'] });
    });
});
