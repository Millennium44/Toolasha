import { describe, test, expect, beforeEach, vi } from 'vitest';

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
        ready: Promise.resolve(true),
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

vi.mock('../core/storage.js', () => ({ default: storageMock }));
vi.mock('../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

/** The record the goals live in, as the storage layer holds it for char1 */
const stored = {
    get record() {
        return storageMock.storeFor('settings').get('equipmentSavings_char1') ?? null;
    },
    set record(value) {
        if (value === null) storageMock.storeFor('settings').delete('equipmentSavings_char1');
        else storageMock.storeFor('settings').set('equipmentSavings_char1', value);
    },
    get writes() {
        return storageMock.set.mock.calls.map(([, value]) => value);
    },
};

const {
    upgradeCost,
    craftCost,
    savingsProgress,
    timeToAffordSeconds,
    totalSavings,
    orderTargets,
    abilityBookHrid,
    abilityGoalLabel,
    abilityGoalReached,
    abilityGoals,
    abilityGoalFor,
    hasAbilityGoal,
    addAbilityGoal,
    removeAbilityGoal,
    resetAbilityGoals,
    houseGoalLabel,
    houseGoalReached,
    houseGoals,
    houseGoalFor,
    hasHouseGoal,
    addHouseGoal,
    removeHouseGoal,
    resetHouseGoals,
    MAX_HOUSE_ROOM_LEVEL,
    loadSavingsRecord,
    saveSavingsRecord,
    flushSavingsWrites,
} = await import('./equipment-savings.js');

beforeEach(() => {
    storageMock.reset();
    storageMock.set.mockClear();
    dataManagerMock.characterId = 'char1';
    resetAbilityGoals();
    resetHouseGoals();
});

describe('upgradeCost', () => {
    test('the ask less what the old piece fetches', () => {
        // Reading the ask alone overstates every upgrade by the value of the
        // gear you are already wearing
        expect(upgradeCost({ targetAsk: 500_000_000, equippedBid: 400_000_000 })).toBe(100_000_000);
    });

    test('keeping the old piece means paying the whole ask', () => {
        expect(upgradeCost({ targetAsk: 500_000_000, equippedBid: 400_000_000, noSell: true })).toBe(500_000_000);
    });

    test('an empty slot has nothing to trade in', () => {
        expect(upgradeCost({ targetAsk: 500 })).toBe(500);
    });

    test('an upgrade worth less than what you wear costs nothing, not less than nothing', () => {
        // A negative cost would make a progress bar meaningless
        expect(upgradeCost({ targetAsk: 100, equippedBid: 900 })).toBe(0);
    });

    test('a target nobody is selling has no cost rather than a cost of nothing', () => {
        // Zero would report it as already affordable, which is the most
        // misleading thing this could say
        expect(upgradeCost({ targetAsk: 0, equippedBid: 100 })).toBeNull();
        expect(upgradeCost({ targetAsk: null })).toBeNull();
    });
});

describe('savingsProgress', () => {
    test('how far along, and how much is left', () => {
        expect(savingsProgress(1000, 250)).toEqual({ fraction: 0.25, affordable: false, needed: 750 });
    });

    test('the bar caps at full but the shortfall does not', () => {
        const progress = savingsProgress(1000, 4000);
        expect(progress.fraction).toBe(1);
        expect(progress.affordable).toBe(true);
        expect(progress.needed).toBe(0);
    });

    test('exactly enough is affordable', () => {
        expect(savingsProgress(1000, 1000).affordable).toBe(true);
    });

    test('nothing to save for is already there rather than a division by zero', () => {
        expect(savingsProgress(0, 0)).toEqual({ fraction: 1, affordable: true, needed: 0 });
    });

    test('an unpriced target has no progress to report', () => {
        expect(savingsProgress(null, 10_000)).toEqual({ fraction: null, affordable: false, needed: null });
    });
});

describe('timeToAffordSeconds', () => {
    test('what is left over what you earn', () => {
        expect(timeToAffordSeconds(200, 100)).toBe(2 * 86400);
    });

    test('already affordable is no time at all', () => {
        expect(timeToAffordSeconds(0, 100)).toBe(0);
    });

    test('no income is unmeasurable rather than never', () => {
        // A figure here would be a claim about the future
        expect(timeToAffordSeconds(500, 0)).toBeNull();
        expect(timeToAffordSeconds(500, -1)).toBeNull();
    });

    test('an unpriced target has no arrival time', () => {
        expect(timeToAffordSeconds(null, 100)).toBe(0);
    });
});

describe('totalSavings', () => {
    test('sums what it can price and counts what it cannot', () => {
        expect(totalSavings([{ cost: 100 }, { cost: 250 }, { cost: null }])).toEqual({ cost: 350, unpriced: 1 });
    });

    test('nothing watched is zero rather than nothing', () => {
        expect(totalSavings([])).toEqual({ cost: 0, unpriced: 0 });
    });
});

describe('craftCost', () => {
    const priceOf = (hrid) => ({ '/items/shard': 1000, '/items/base': 500_000, '/items/rare': 0 })[hrid] ?? null;

    test('materials only, for a base piece you already own', () => {
        // The usual reason to craft rather than buy: a spear you already hold
        // becomes a refined one for the price of the shards
        const cost = craftCost({ inputItems: [{ itemHrid: '/items/shard', count: 30 }], priceOf });
        expect(cost).toBe(30_000);
    });

    test('the base piece is a cost when it has to be bought', () => {
        const cost = craftCost({
            inputItems: [{ itemHrid: '/items/shard', count: 30 }],
            priceOf,
            haveBase: false,
            upgradeAsk: 500_000,
        });
        expect(cost).toBe(530_000);
    });

    test('a recipe that makes several splits the cost between them', () => {
        const cost = craftCost({ inputItems: [{ itemHrid: '/items/shard', count: 30 }], priceOf, outputCount: 3 });
        expect(cost).toBe(10_000);
    });

    test('one unpriced ingredient makes the whole recipe unpriced', () => {
        // Totalling only what it can price reports a cheaper craft than is
        // possible, which is worse than saying nothing
        const cost = craftCost({
            inputItems: [
                { itemHrid: '/items/shard', count: 30 },
                { itemHrid: '/items/rare', count: 1 },
            ],
            priceOf,
        });
        expect(cost).toBeNull();
    });

    test('no recipe is not a craft', () => {
        expect(craftCost({ inputItems: [], priceOf })).toBeNull();
        expect(craftCost({ priceOf })).toBeNull();
    });
});

describe('orderTargets', () => {
    const targets = [
        { name: 'far', cost: 100, fraction: 0.1, affordable: false },
        { name: 'near', cost: 100, fraction: 0.9, affordable: false },
        { name: 'unpriced', cost: null, fraction: null, affordable: false },
        { name: 'done', cost: 100, fraction: 1, affordable: true },
    ];

    test('affordable first, then nearest to done, then unpriced', () => {
        // Insertion order says nothing; cost order buries the piece you are two
        // days from behind one you are two months from
        expect(orderTargets(targets).map((target) => target.name)).toEqual(['done', 'near', 'far', 'unpriced']);
    });

    test('it does not modify the array it was given', () => {
        orderTargets(targets);
        expect(targets[0].name).toBe('far');
    });
});

describe('ability goals', () => {
    test('a goal is the ability, the level, the cost and how it reads', async () => {
        await addAbilityGoal({
            abilityHrid: '/abilities/fierce_aura',
            targetLevel: 46,
            cost: 250_000_000,
            label: 'Fierce Aura Lv46',
        });

        expect(abilityGoals()).toEqual([
            {
                abilityHrid: '/abilities/fierce_aura',
                targetLevel: 46,
                cost: 250_000_000,
                label: 'Fierce Aura Lv46',
                updatedAt: expect.any(Number),
            },
        ]);
        expect(hasAbilityGoal('/abilities/fierce_aura')).toBe(true);
    });

    test('adding one for an ability that has one replaces it rather than stacking', async () => {
        // A later sim run has costed the same intention more accurately, and two
        // rows for one ability would show both and total both
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 250_000_000 });
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 51, cost: 400_000_000 });

        expect(abilityGoals()).toHaveLength(1);
        expect(abilityGoalFor('/abilities/fierce_aura')).toMatchObject({ targetLevel: 51, cost: 400_000_000 });
    });

    test('an unpriced goal costs nothing known rather than nothing', async () => {
        // Zero would report it as already affordable, which is the most
        // misleading thing this could say
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: null });
        expect(abilityGoalFor('/abilities/fierce_aura').cost).toBeNull();

        await addAbilityGoal({ abilityHrid: '/abilities/toxic_pollen', targetLevel: 30 });
        expect(abilityGoalFor('/abilities/toxic_pollen').cost).toBeNull();
    });

    test('a goal with no ability is not a goal', async () => {
        await addAbilityGoal({ targetLevel: 46, cost: 1 });
        await addAbilityGoal();
        expect(abilityGoals()).toEqual([]);
    });

    test('a label is derived when none was supplied', async () => {
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });
        expect(abilityGoalFor('/abilities/fierce_aura').label).toBe('Fierce Aura Lv46');
    });

    test('removing one takes it off the list', async () => {
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });
        await addAbilityGoal({ abilityHrid: '/abilities/toxic_pollen', targetLevel: 30, cost: 2 });

        await removeAbilityGoal('/abilities/fierce_aura');

        expect(abilityGoals().map((goal) => goal.abilityHrid)).toEqual(['/abilities/toxic_pollen']);
        expect(hasAbilityGoal('/abilities/fierce_aura')).toBe(false);
    });

    test('removing one that is not there writes nothing', async () => {
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });
        const writes = stored.writes.length;

        await removeAbilityGoal('/abilities/nothing');
        expect(stored.writes).toHaveLength(writes);
    });
});

describe('house room goals', () => {
    test('a goal is the room, the level, the cost and how it reads', async () => {
        await addHouseGoal({
            houseRoomHrid: '/house_rooms/mystical_study',
            targetLevel: 5,
            cost: 40_000_000,
            label: 'Mystical Study Lv5',
        });

        expect(houseGoals()).toEqual([
            {
                houseRoomHrid: '/house_rooms/mystical_study',
                targetLevel: 5,
                cost: 40_000_000,
                label: 'Mystical Study Lv5',
                updatedAt: expect.any(Number),
            },
        ]);
        expect(hasHouseGoal('/house_rooms/mystical_study')).toBe(true);
    });

    test('adding one for a room that has one replaces it rather than stacking', async () => {
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 5, cost: 40_000_000 });
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 7, cost: 90_000_000 });

        expect(houseGoals()).toHaveLength(1);
        expect(houseGoalFor('/house_rooms/dojo')).toMatchObject({ targetLevel: 7, cost: 90_000_000 });
    });

    test('an unpriced goal costs nothing known rather than nothing', async () => {
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 5, cost: null });
        expect(houseGoalFor('/house_rooms/dojo').cost).toBeNull();

        await addHouseGoal({ houseRoomHrid: '/house_rooms/gym', targetLevel: 5 });
        expect(houseGoalFor('/house_rooms/gym').cost).toBeNull();
    });

    test('a level above what the game builds is capped rather than stored', async () => {
        // Costing levels that cannot be built would price a goal that can never
        // be reached, so it sits on the list forever at a made-up figure
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 12, cost: 1 });
        expect(houseGoalFor('/house_rooms/dojo').targetLevel).toBe(MAX_HOUSE_ROOM_LEVEL);
    });

    test('a goal with no room is not a goal', async () => {
        await addHouseGoal({ targetLevel: 5, cost: 1 });
        await addHouseGoal();
        expect(houseGoals()).toEqual([]);
    });

    test('a label is derived when none was supplied', async () => {
        await addHouseGoal({ houseRoomHrid: '/house_rooms/mystical_study', targetLevel: 5, cost: 1 });
        expect(houseGoalFor('/house_rooms/mystical_study').label).toBe('Mystical Study Lv5');
    });

    test('removing one takes it off the list', async () => {
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 5, cost: 1 });
        await addHouseGoal({ houseRoomHrid: '/house_rooms/gym', targetLevel: 4, cost: 2 });

        await removeHouseGoal('/house_rooms/dojo');

        expect(houseGoals().map((goal) => goal.houseRoomHrid)).toEqual(['/house_rooms/gym']);
        expect(hasHouseGoal('/house_rooms/dojo')).toBe(false);
    });

    test('removing one that is not there writes nothing', async () => {
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 5, cost: 1 });
        const writes = stored.writes.length;

        await removeHouseGoal('/house_rooms/nothing');
        expect(stored.writes).toHaveLength(writes);
    });

    test('a room goal is reached at the level it was built to', () => {
        expect(houseGoalReached({ targetLevel: 5 }, 5)).toBe(true);
        expect(houseGoalReached({ targetLevel: 5 }, 4)).toBe(false);
        expect(houseGoalReached({ targetLevel: 0 }, 3)).toBe(false);
    });

    test('a label names the room and the level it is going to', () => {
        expect(houseGoalLabel('/house_rooms/mystical_study', 5)).toBe('Mystical Study Lv5');
        expect(houseGoalLabel('/house_rooms/mystical_study', 5, 'Mystical Study')).toBe('Mystical Study Lv5');
    });
});

describe('a goal that has happened', () => {
    test('is reached at the level, not only past it', () => {
        expect(abilityGoalReached({ targetLevel: 46 }, 46)).toBe(true);
        expect(abilityGoalReached({ targetLevel: 46 }, 47)).toBe(true);
        expect(abilityGoalReached({ targetLevel: 46 }, 45)).toBe(false);
    });

    test('a goal of nothing is not something to have reached', () => {
        expect(abilityGoalReached({ targetLevel: 0 }, 10)).toBe(false);
        expect(abilityGoalReached(null, 10)).toBe(false);
    });
});

describe('the book, and how a goal reads', () => {
    test('the book is the item of the same name', () => {
        expect(abilityBookHrid('/abilities/fierce_aura')).toBe('/items/fierce_aura');
    });

    test('a label names the ability and the level it is going to', () => {
        expect(abilityGoalLabel('/abilities/fierce_aura', 46)).toBe('Fierce Aura Lv46');
        expect(abilityGoalLabel('/abilities/fierce_aura', 46, 'Fierce Aura')).toBe('Fierce Aura Lv46');
    });
});

describe('the stored record', () => {
    test('a record written before ability goals existed loads unchanged', async () => {
        stored.record = {
            targets: { '/items/holy_sword': { enhancementLevel: 3 } },
            noSell: true,
            marketValue: false,
            selected: '/items/holy_sword',
            locked: true,
        };

        const gear = await loadSavingsRecord();

        expect(gear).toEqual({
            targets: { '/items/holy_sword': { enhancementLevel: 3 } },
            noSell: true,
            marketValue: false,
            selected: '/items/holy_sword',
            locked: true,
        });
        expect(abilityGoals()).toEqual([]);
        expect(houseGoals()).toEqual([]);
    });

    test('room goals are absorbed rather than handed back with the gear', async () => {
        stored.record = {
            targets: {},
            houses: { '/house_rooms/dojo': { targetLevel: 6, cost: 40_000_000, label: 'Dojo Lv6' } },
        };

        const gear = await loadSavingsRecord();

        expect(gear.houses).toBeUndefined();
        expect(houseGoalFor('/house_rooms/dojo')).toMatchObject({ targetLevel: 6, cost: 40_000_000 });
    });

    test('gear, abilities and rooms all survive one write, because there is one writer', async () => {
        await saveSavingsRecord({ targets: { '/items/holy_sword': { enhancementLevel: 0 } } });
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 6, cost: 2 });

        expect(stored.record.targets['/items/holy_sword']).toBeDefined();
        expect(stored.record.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);
        expect(stored.record.houses['/house_rooms/dojo'].targetLevel).toBe(6);

        await saveSavingsRecord({ targets: {} });
        expect(stored.record.houses['/house_rooms/dojo'].targetLevel).toBe(6);
    });

    test('garbage in the room goals is skipped rather than drawn', async () => {
        stored.record = { houses: { '/house_rooms/dojo': null, '/house_rooms/gym': { targetLevel: 4 } } };
        await loadSavingsRecord();

        expect(houseGoals().map((goal) => goal.houseRoomHrid)).toEqual(['/house_rooms/gym']);
    });

    test('a room goal added before anything was loaded still finds what is stored', async () => {
        stored.record = { targets: { '/items/holy_sword': { enhancementLevel: 0 } } };
        resetHouseGoals({ loaded: false });

        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 6, cost: 1 });

        expect(stored.record.targets).toEqual({ '/items/holy_sword': { enhancementLevel: 0 } });
        expect(stored.record.houses['/house_rooms/dojo']).toBeDefined();
    });

    test('goals are absorbed rather than handed back with the gear', async () => {
        stored.record = {
            targets: { '/items/holy_sword': { enhancementLevel: 0 } },
            abilities: { '/abilities/fierce_aura': { targetLevel: 46, cost: 250_000_000, label: 'Fierce Aura Lv46' } },
        };

        const gear = await loadSavingsRecord();

        expect(gear.abilities).toBeUndefined();
        expect(abilityGoalFor('/abilities/fierce_aura')).toMatchObject({ targetLevel: 46, cost: 250_000_000 });
    });

    test('nothing stored for this character is nothing rather than an empty record', async () => {
        expect(await loadSavingsRecord()).toBeNull();
    });

    test('saving the gear keeps the goals, and saving a goal keeps the gear', async () => {
        // Two writers of one key lose each other's edits, which is why there is
        // only the one
        await saveSavingsRecord({ targets: { '/items/holy_sword': { enhancementLevel: 0 } }, noSell: true });
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 250_000_000 });

        expect(stored.record.targets).toEqual({ '/items/holy_sword': { enhancementLevel: 0 } });
        expect(stored.record.noSell).toBe(true);
        expect(stored.record.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);

        await saveSavingsRecord({ targets: {}, noSell: false });
        expect(stored.record.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);
    });

    test('a goal added before anything was loaded still finds what is stored', async () => {
        stored.record = { targets: { '/items/holy_sword': { enhancementLevel: 0 } } };
        resetAbilityGoals({ loaded: false });

        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });

        expect(stored.record.targets).toEqual({ '/items/holy_sword': { enhancementLevel: 0 } });
        expect(stored.record.abilities['/abilities/fierce_aura']).toBeDefined();
    });

    test('garbage in the goals is skipped rather than drawn', async () => {
        stored.record = {
            abilities: { '/abilities/fierce_aura': null, '/abilities/toxic_pollen': { targetLevel: 30 } },
        };
        await loadSavingsRecord();

        expect(abilityGoals().map((goal) => goal.abilityHrid)).toEqual(['/abilities/toxic_pollen']);
    });
});

describe('the stored record and a store that cannot be read', () => {
    test('a load that cannot be made keeps the goals in hand rather than blanking them', async () => {
        stored.record = { targets: { '/items/holy_sword': { enhancementLevel: 0 } } };
        await loadSavingsRecord();
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });
        expect(hasAbilityGoal('/abilities/fierce_aura')).toBe(true);

        storageMock.unavailable = true;
        const gear = await loadSavingsRecord();
        expect(hasAbilityGoal('/abilities/fierce_aura')).toBe(true);
        expect(gear).toEqual({ targets: { '/items/holy_sword': { enhancementLevel: 0 } } });
    });

    test("but not another character's goals", async () => {
        await addAbilityGoal({ abilityHrid: '/abilities/fierce_aura', targetLevel: 46, cost: 1 });
        dataManagerMock.characterId = 'char2';
        storageMock.unavailable = true;
        expect(await loadSavingsRecord()).toBeNull();
        expect(abilityGoals()).toEqual([]);
    });

    test('a write over a store that cannot be read is skipped, and what is stored stays', async () => {
        stored.record = { abilities: { '/abilities/fierce_aura': { targetLevel: 46, cost: 1 } } };
        storageMock.unavailable = true;
        await addHouseGoal({ houseRoomHrid: '/house_rooms/dojo', targetLevel: 6, cost: 2 });
        storageMock.unavailable = false;

        expect(stored.record.houses).toBeUndefined();
        expect(stored.record.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);
        // The goal is still held, and lands with the next write
        expect(hasHouseGoal('/house_rooms/dojo')).toBe(true);
        await addHouseGoal({ houseRoomHrid: '/house_rooms/gym', targetLevel: 3, cost: 2 });
        expect(stored.record.houses['/house_rooms/dojo'].targetLevel).toBe(6);
        expect(stored.record.houses['/house_rooms/gym'].targetLevel).toBe(3);
        expect(stored.record.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);
    });

    test('a write before the record was read back loses no stored goal', async () => {
        stored.record = {
            targets: { '/items/holy_sword': { enhancementLevel: 0 } },
            abilities: { '/abilities/fierce_aura': { targetLevel: 46, cost: 1 } },
        };
        storageMock.unavailable = true;
        await loadSavingsRecord();
        storageMock.unavailable = false;

        await addAbilityGoal({ abilityHrid: '/abilities/toxic_pollen', targetLevel: 30, cost: 2 });
        await flushSavingsWrites();

        expect(Object.keys(stored.record.abilities).sort()).toEqual([
            '/abilities/fierce_aura',
            '/abilities/toxic_pollen',
        ]);
        expect(stored.record.targets).toEqual({ '/items/holy_sword': { enhancementLevel: 0 } });
    });

    test('after a readable load a removed goal stays removed', async () => {
        stored.record = {
            abilities: {
                '/abilities/fierce_aura': { targetLevel: 46, cost: 1 },
                '/abilities/toxic_pollen': { targetLevel: 30, cost: 2 },
            },
        };
        await loadSavingsRecord();
        await removeAbilityGoal('/abilities/fierce_aura');
        expect(Object.keys(stored.record.abilities)).toEqual(['/abilities/toxic_pollen']);
    });
});

describe('two switches close enough together to overlap', () => {
    test('a slow read for the character switched away from does not land on top of the one switched to', async () => {
        // One main and three ironcows in one browser: switching through them
        // fast enough that the first character's storage read is still in
        // flight when the second switch's own read starts is exactly the
        // "1 main + 3 ironcow" scenario this exists for.
        dataManagerMock.characterId = 'char2';
        storageMock.storeFor('settings').set('equipmentSavings_char2', {
            abilities: { '/abilities/toxic_pollen': { targetLevel: 20, cost: 2, label: 'Toxic Pollen Lv20' } },
        });

        let releaseChar2Read;
        const gate = new Promise((resolve) => {
            releaseChar2Read = resolve;
        });
        storageMock.tryGet.mockImplementationOnce(async (key, store = 'settings') => {
            await gate;
            if (storageMock.unavailable) return null;
            const map = storageMock.storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        });

        // char2's read starts, and is parked on the gate before it can commit
        const staleLoad = loadSavingsRecord();
        // Let it run up to (and stall on) the gated storage read before the
        // character is switched again — otherwise this call would itself
        // observe the character-3 switch below and the race would never be
        // set up
        await Promise.resolve();
        await Promise.resolve();

        // The player switches on again, to char3, before char2's read lands
        dataManagerMock.characterId = 'char3';
        storageMock.storeFor('settings').set('equipmentSavings_char3', {
            abilities: { '/abilities/fierce_aura': { targetLevel: 55, cost: 3, label: 'Fierce Aura Lv55' } },
        });
        await loadSavingsRecord();

        expect(abilityGoals().map((goal) => goal.abilityHrid)).toEqual(['/abilities/fierce_aura']);

        // Now char2's stale read is allowed to land
        releaseChar2Read();
        const result = await staleLoad;

        // It must not have been allowed to commit: char3's goals are what the
        // screen is showing, and must still be what it shows afterwards
        expect(result).toBeUndefined();
        expect(abilityGoals().map((goal) => goal.abilityHrid)).toEqual(['/abilities/fierce_aura']);
        expect(abilityGoalFor('/abilities/fierce_aura')).toMatchObject({ targetLevel: 55 });
        expect(hasAbilityGoal('/abilities/toxic_pollen')).toBe(false);
    });
});
