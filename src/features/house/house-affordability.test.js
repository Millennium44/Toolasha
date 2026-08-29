import { describe, test, expect, afterEach, vi } from 'vitest';

const roomDetails = {
    '/house_rooms/dojo': { name: 'Dojo' },
    '/house_rooms/gym': { name: 'Gym' },
};

// Mutable so the character-switch race test can move the active character
// mid-flight, the way a real switch does.
let currentCharacterId = 'char1';

// What the Houses tile reads: the rooms the character has, and the coins the
// affordability comparison is against
const game = vi.hoisted(() => ({ combined: {}, rows: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ houseRoomDetailMap: roomDetails }),
        getCombinedData: () => game.combined,
        // The untracked list is keyed per character, and the module asks to be
        // told when that changes
        getCurrentCharacterId: () => currentCharacterId,
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));

// Cumulative cost to reach a level: 100 per level for the dojo, 1000 for the gym
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateHouseBuildCost: (hrid, level) => (hrid === '/house_rooms/dojo' ? 100 : 1000) * level,
}));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));
vi.mock('../../utils/formatters.js', () => ({ formatLargeNumber: (n) => String(n) }));
vi.mock('../../utils/market-data.js', () => ({
    // ask/bid genuinely differ, so a call site that forwards `side` incorrectly
    // (e.g. through an unrecognised `context` that always resolves to ask) is
    // caught by asserting the two actually differ.
    getItemPrice: (_hrid, options = {}) => (options.mode === 'bid' ? 2 : 1),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
// Per-key data and per-key artificial delays, so a race test can make one
// character's read resolve after another's despite starting first.
const storageState = vi.hoisted(() => ({ data: new Map(), delays: new Map() }));

vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        getJSON: async (_k, _s, fallback) => fallback,
        setJSON: async () => true,
        get: async (key, _s, fallback = null) => {
            const delay = storageState.delays.get(key);
            if (delay) await delay;
            return storageState.data.has(key) ? storageState.data.get(key) : fallback;
        },
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));

const { nextLevelCost, affordableUpgrades, setRoomTracked, isRoomTracked, materialsCost, loadUntrackedRooms } =
    await import('./house-affordability.js');

describe('nextLevelCost', () => {
    test('is the difference between two cumulative totals, not a cumulative total', () => {
        // The calculator returns the cost of getting to a level from nothing;
        // charging that for one upgrade would overstate it several times over
        expect(nextLevelCost('/house_rooms/dojo', 3)).toBe(100);
    });

    test('a maxed room has nothing left to buy', () => {
        expect(nextLevelCost('/house_rooms/dojo', 8)).toBe(0);
        expect(nextLevelCost('/house_rooms/dojo', 9)).toBe(0);
    });

    test('an unpriceable upgrade counts as nothing rather than negative', () => {
        expect(nextLevelCost('/house_rooms/unknown', 0)).toBeGreaterThanOrEqual(0);
    });
});

describe('affordableUpgrades', () => {
    const rooms = { '/house_rooms/dojo': { level: 3 }, '/house_rooms/gym': { level: 2 } };

    test('counts rooms you have not bought yet', () => {
        // characterHouseRoomMap holds only rooms already bought. A character
        // with one maxed room and the rest unbuilt has fifteen upgrades to
        // consider, not none — reading only the owned map showed nothing at all
        const onlyOwned = { '/house_rooms/dojo': { level: 8 } };
        const result = affordableUpgrades(onlyOwned, 100000);
        expect(result.total).toBe(1);
        expect(result.cheapest).toEqual({ name: 'Gym', cost: 1000 });
    });

    test('counts each upgrade against your coins on its own', () => {
        // Dojo's next level is 100, the gym's is 1000
        expect(affordableUpgrades(rooms, 500)).toMatchObject({ affordable: 1, total: 2 });
        expect(affordableUpgrades(rooms, 5000)).toMatchObject({ affordable: 2, total: 2 });
        expect(affordableUpgrades(rooms, 50)).toMatchObject({ affordable: 0, total: 2 });
    });

    test('names the cheapest upgrade', () => {
        expect(affordableUpgrades(rooms, 0).cheapest).toEqual({ name: 'Dojo', cost: 100 });
    });

    test('maxed rooms are not counted as upgrades you declined', () => {
        const maxed = { '/house_rooms/dojo': { level: 8 }, '/house_rooms/gym': { level: 8 } };
        expect(affordableUpgrades(maxed, 0).total).toBe(0);
    });

    test('a room at level zero still has a next level', () => {
        expect(affordableUpgrades({ '/house_rooms/dojo': { level: 0 } }, 100).affordable).toBe(1);
    });

    test('a character who owns nothing still sees every room', () => {
        // The common case for a new character, and the one that used to draw a
        // blank row
        expect(affordableUpgrades(null, 100000)).toMatchObject({ affordable: 2, total: 2 });
    });
});

describe('rooms you are not saving for', () => {
    const rooms = { '/house_rooms/dojo': { level: 3 }, '/house_rooms/gym': { level: 2 } };

    afterEach(async () => {
        await setRoomTracked('/house_rooms/gym', true);
        await setRoomTracked('/house_rooms/dojo', true);
    });

    test('an untracked room leaves both halves of the count', () => {
        // Not "1 of 2 affordable" with the gym permanently unaffordable — a room
        // you have declined is not one you are failing to afford, and leaving it
        // in the denominator makes the figure about somebody else's character
        expect(affordableUpgrades(rooms, 500)).toMatchObject({ affordable: 1, total: 2 });

        return setRoomTracked('/house_rooms/gym', false).then(() => {
            expect(affordableUpgrades(rooms, 500)).toMatchObject({ affordable: 1, total: 1 });
        });
    });

    test('and it stops being the cheapest, since it is not a candidate', async () => {
        await setRoomTracked('/house_rooms/dojo', false);

        expect(affordableUpgrades(rooms, 5000).cheapest).toEqual({ name: 'Gym', cost: 1000 });
    });

    test('everything counts until told otherwise', () => {
        expect(isRoomTracked('/house_rooms/dojo')).toBe(true);
        expect(isRoomTracked('/house_rooms/anything')).toBe(true);
    });

    test('switching one back on restores it', async () => {
        await setRoomTracked('/house_rooms/gym', false);
        await setRoomTracked('/house_rooms/gym', true);

        expect(affordableUpgrades(rooms, 5000).total).toBe(2);
    });
});

describe('a character switch mid-read', () => {
    afterEach(() => {
        currentCharacterId = 'char1';
        storageState.data.clear();
        storageState.delays.clear();
    });

    test('a slow read for the departed character does not overwrite the arriving one', async () => {
        // char1's read is artificially slow (imagine a legacy-adoption check or
        // a busy IndexedDB transaction); char2's is instant. Both
        // `character_initialized`/`character_switched` handlers fire
        // unawaited, so char2's call can finish and render before char1's
        // stale answer comes back.
        storageState.data.set('housesUntracked_char1', ['/house_rooms/dojo']);
        storageState.data.set('housesUntracked_char2', ['/house_rooms/gym']);
        storageState.delays.set('housesUntracked_char1', new Promise((resolve) => setTimeout(resolve, 20)));

        currentCharacterId = 'char1';
        const staleRead = loadUntrackedRooms();

        // Flush microtasks so char1's call runs past `await storage.ready` and
        // computes its scoped key (`characterKey()`, live off
        // `getCurrentCharacterId()`) *while it is still the active character*,
        // then parks on the delayed `storage.get`. Without this flush the
        // character flip below would happen before char1's call ever reaches
        // that computation, and both calls would end up reading char2's key —
        // masking the bug this test exists to catch.
        await new Promise((resolve) => setTimeout(resolve, 0));

        currentCharacterId = 'char2';
        await loadUntrackedRooms();

        expect(isRoomTracked('/house_rooms/gym')).toBe(false);
        expect(isRoomTracked('/house_rooms/dojo')).toBe(true);

        // Let char1's late answer land. It must not clobber char2's set.
        await staleRead;

        expect(isRoomTracked('/house_rooms/gym')).toBe(false);
        expect(isRoomTracked('/house_rooms/dojo')).toBe(true);
    });
});

// JHouse's room → skill associations moved to `utils/room-skills.js`, which both
// this panel and the equipment savings row now draw their icons from; the tests
// for them went with it

describe('both sides of the book', () => {
    const materials = [
        { itemHrid: '/items/birch_lumber', count: 300 },
        { itemHrid: '/items/coin', count: 5000 },
    ];

    test('coins count at face value rather than being looked up', () => {
        // A coin has no bid and no ask; dropping it would understate the level
        // by exactly the coin part
        expect(materialsCost(materials, 'ask')).toBe(300 + 5000);
    });

    test('nothing to price is nothing, not NaN', () => {
        expect(materialsCost([], 'ask')).toBe(0);
        expect(materialsCost(null, 'bid')).toBe(0);
        expect(materialsCost([{ itemHrid: '/items/x' }], 'ask')).toBe(0);
    });

    test('bid actually prices at bid, not silently at ask', () => {
        // Regression: `priceOfMaterial` used to call `getItemPrice` with
        // `{ context: 'cost', side }`, a context `getPricingMode` does not
        // recognise, so it always fell through to its 'ask' default and the
        // bid column matched the ask column on every room.
        const priced = [{ itemHrid: '/items/birch_lumber', count: 300 }];
        expect(materialsCost(priced, 'bid')).not.toBe(materialsCost(priced, 'ask'));
        expect(materialsCost(priced, 'bid')).toBe(300 * 2);
    });
});

/**
 * The Houses tile's `version()`.
 *
 * The overlay redraws every visible tile once a second and skips a row whose
 * version has not moved. This row's render walks every room in the game and
 * prices each one's next level, so the memo is worth having — and worth being
 * exact about, since a room built or a coin spent has to show.
 */
describe('the Houses tile summarises its own inputs', () => {
    const version = () => game.rows.houses.version();

    afterEach(() => {
        game.combined = {};
    });

    test('no house data at all is one settled version', () => {
        game.combined = {};
        expect(version()).toBe('blank');
        expect(version()).toBe(version());
    });

    test('it holds still while the rooms and the coins do', () => {
        game.combined = {
            characterHouseRoomMap: { '/house_rooms/dojo': { level: 2 } },
            characterItems: [{ itemHrid: '/items/coin', count: 500 }],
        };
        expect(version()).toBe(version());
    });

    test('a level gained moves it', () => {
        game.combined = {
            characterHouseRoomMap: { '/house_rooms/dojo': { level: 2 } },
            characterItems: [{ itemHrid: '/items/coin', count: 500 }],
        };
        const before = version();

        game.combined = {
            characterHouseRoomMap: { '/house_rooms/dojo': { level: 3 } },
            characterItems: [{ itemHrid: '/items/coin', count: 500 }],
        };
        expect(version()).not.toBe(before);
    });

    test('coins moving moves it, because the whole tile is a comparison against them', () => {
        game.combined = {
            characterHouseRoomMap: { '/house_rooms/dojo': { level: 2 } },
            characterItems: [{ itemHrid: '/items/coin', count: 500 }],
        };
        const before = version();

        game.combined = {
            characterHouseRoomMap: { '/house_rooms/dojo': { level: 2 } },
            characterItems: [{ itemHrid: '/items/coin', count: 5_000_000 }],
        };
        expect(version()).not.toBe(before);
    });

    test('so does saying you are no longer saving for a room', () => {
        game.combined = {
            characterHouseRoomMap: { '/house_rooms/dojo': { level: 2 } },
            characterItems: [{ itemHrid: '/items/coin', count: 500 }],
        };
        // The switch-race suite above may have left the gym untracked; the
        // move under test is tracked → untracked, so start from tracked
        setRoomTracked('/house_rooms/gym', true);
        const before = version();

        setRoomTracked('/house_rooms/gym', false);
        expect(version()).not.toBe(before);
        setRoomTracked('/house_rooms/gym', true);
    });
});
