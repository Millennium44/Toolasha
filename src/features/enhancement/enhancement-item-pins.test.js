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

const { togglePin, orderTiles, sameOrder, mergePins, default: pins } = await import('./enhancement-item-pins.js');

/** Stand-ins for tiles; the ordering never touches the DOM */
const tile = (hrid) => ({ hrid });
const hridOf = (t) => t.hrid;

describe('togglePin', () => {
    test('pins and unpins within the one bucket', () => {
        const pinned = togglePin({}, 'enhance', '/items/cheese_sword');
        expect(pinned.enhance).toEqual(['/items/cheese_sword']);
        expect(togglePin(pinned, 'enhance', '/items/cheese_sword').enhance).toEqual([]);
    });

    test('a new pin goes to the end, not the front', () => {
        const pins = togglePin(togglePin({}, 'enhance', '/items/a'), 'enhance', '/items/b');
        expect(pins.enhance).toEqual(['/items/a', '/items/b']);
    });
});

describe('orderTiles', () => {
    const tiles = ['/items/a', '/items/b', '/items/c', '/items/d'].map(tile);

    test('pinned first, in pin order', () => {
        const out = orderTiles(tiles, ['/items/c', '/items/a'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/c', '/items/a', '/items/b', '/items/d']);
    });

    test('a pin for an item not on screen changes nothing', () => {
        const out = orderTiles(tiles, ['/items/zzz'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/a', '/items/b', '/items/c', '/items/d']);
    });

    test('a cell standing for no item keeps the front', () => {
        const withRemove = [tile(''), ...tiles];
        const out = orderTiles(withRemove, ['/items/c'], hridOf);
        expect(out.map(hridOf)).toEqual(['', '/items/c', '/items/a', '/items/b', '/items/d']);
    });

    test('no pins leaves the order alone', () => {
        expect(orderTiles(tiles, [], hridOf)).toEqual(tiles);
    });
});

describe('sameOrder', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(tile);

    test('recognises an order that has not moved', () => {
        expect(sameOrder([a, b, c], [a, b, c])).toBe(true);
    });

    test('spots a move', () => {
        expect(sameOrder([a, b, c], [b, a, c])).toBe(false);
    });
});

describe('mergePins', () => {
    test('keeps the stored order and appends what was pinned since', () => {
        const merged = mergePins({ enhance: ['/items/a', '/items/b'] }, { enhance: ['/items/b', '/items/c'] });
        expect(merged).toEqual({ enhance: ['/items/a', '/items/b', '/items/c'] });
    });
});

describe('the stored pins', () => {
    const KEY = 'enhancementItemPins_char1';
    const stored = () => storageMock.storeFor('settings').get(KEY);
    const seed = (value) => storageMock.storeFor('settings').set(KEY, value);

    beforeEach(() => {
        storageMock.reset();
        dataManagerMock.characterId = 'char1';
        pins.pins = {};
        pins.pinsOwner = null;
    });

    test("reads this character's pins back and writes them under the same key", async () => {
        seed({ enhance: ['/items/a'] });
        expect(await pins.loadPins()).toBe(true);
        expect(pins.pins).toEqual({ enhance: ['/items/a'] });

        pins.pins = togglePin(pins.pins, 'enhance', '/items/b');
        await pins.savePins();
        expect(stored()).toEqual({ enhance: ['/items/a', '/items/b'] });
    });

    test('a load that cannot be made keeps the pins in hand rather than blanking them', async () => {
        seed({ enhance: ['/items/a'] });
        await pins.loadPins();
        storageMock.unavailable = true;
        expect(await pins.loadPins()).toBe(false);
        expect(pins.pins).toEqual({ enhance: ['/items/a'] });
    });

    test("but not another character's pins", async () => {
        seed({ enhance: ['/items/a'] });
        await pins.loadPins();
        dataManagerMock.characterId = 'char2';
        storageMock.unavailable = true;
        await pins.loadPins();
        expect(pins.pins).toEqual({});
    });

    test('a save over a store that cannot be read is skipped, and what is stored stays', async () => {
        seed({ enhance: ['/items/a'] });
        storageMock.unavailable = true;
        await pins.loadPins();
        pins.pins = togglePin(pins.pins, 'enhance', '/items/b');
        expect(await pins.savePins()).toBe(false);
        storageMock.unavailable = false;
        expect(stored()).toEqual({ enhance: ['/items/a'] });
    });

    test('after a readable load an unpin sticks', async () => {
        seed({ enhance: ['/items/a', '/items/b'] });
        await pins.loadPins();
        pins.pins = togglePin(pins.pins, 'enhance', '/items/a');
        await pins.savePins();
        expect(stored()).toEqual({ enhance: ['/items/b'] });
    });

    test('once storage is back, the next save lands', async () => {
        storageMock.unavailable = true;
        await pins.loadPins();
        pins.pins = togglePin(pins.pins, 'enhance', '/items/a');
        expect(await pins.savePins()).toBe(false);

        storageMock.unavailable = false;
        expect(await pins.savePins()).toBe(true);
        expect(stored()).toEqual({ enhance: ['/items/a'] });
    });
});
