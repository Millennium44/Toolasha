import { describe, test, expect, beforeEach, vi } from 'vitest';

// The record the goals live in, as the storage layer would hand it back
const stored = vi.hoisted(() => ({ record: null, writes: [] }));

vi.mock('../core/storage.js', () => ({ default: { ready: Promise.resolve(true) } }));
vi.mock('./character-key.js', () => ({
    readScoped: async () => stored.record,
    writeScoped: async (_key, value) => {
        stored.record = value;
        stored.writes.push(value);
        return true;
    },
}));

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
    loadSavingsRecord,
    saveSavingsRecord,
} = await import('./equipment-savings.js');

beforeEach(() => {
    stored.record = null;
    stored.writes = [];
    resetAbilityGoals();
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
