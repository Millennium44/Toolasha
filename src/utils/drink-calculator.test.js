/**
 * Tests for the drink and queue time estimates shown on non-combat skill panels.
 *
 * The one thing worth being careful about here is Drink Concentration: it strengthens a buff but
 * burns through drinks faster, so a stack of teas covers *less* wall-clock time. Every other
 * number on the panel goes up with concentration and this one goes down, which is exactly the
 * kind of sign that gets flipped.
 *
 * Expected values are hand-computed in comments.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    drinkSlots: [],
    inventory: [],
    /** How many times the inventory has been read */
    inventoryReads: 0,
    skills: [],
    currentActions: [],
    /** actionHrid → action details */
    actions: {},
}));

const parsers = vi.hoisted(() => ({
    concentration: 0,
    /** actionDetails → stats, or null to refuse */
    stats: { actionTime: 20, totalEfficiency: 0 },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getActionDrinkSlots: () => game.drinkSlots,
        getInventory: () => {
            game.inventoryReads++;
            return game.inventory;
        },
        getSkills: () => game.skills,
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actions[hrid] || null,
    },
}));

vi.mock('./tea-parser.js', () => ({
    getDrinkConcentration: () => parsers.concentration,
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: [], drinks: [] }),
}));

vi.mock('./action-calculator.js', () => ({
    calculateActionStats: () => parsers.stats,
}));

const { calculateDrinkRemainingSeconds, calculateQueueTimeSeconds, artisanTeaShortfall } =
    await import('./drink-calculator.js');

const WOODCUTTING = '/action_types/woodcutting';
const MINUTE_NS = 60_000_000_000;

/**
 * An item whose buff lasts `minutes`.
 * @param {string} name
 * @param {number} minutes
 * @returns {Object}
 */
const tea = (name, minutes) => ({
    name,
    consumableDetail: { buffs: [{ duration: minutes * MINUTE_NS }] },
});

beforeEach(() => {
    game.initClientData = { itemDetailMap: {} };
    game.drinkSlots = [];
    game.inventory = [];
    game.inventoryReads = 0;
    game.skills = [{ skillHrid: '/skills/woodcutting', level: 50 }];
    game.currentActions = [];
    game.actions = {};
    parsers.concentration = 0;
    parsers.stats = { actionTime: 20, totalEfficiency: 0 };
});

describe('calculateDrinkRemainingSeconds', () => {
    beforeEach(() => {
        game.initClientData.itemDetailMap = {
            '/items/wisdom_tea': tea('Wisdom Tea', 5),
            '/items/gathering_tea': tea('Gathering Tea', 5),
        };
    });

    test('a stack of teas covers its count times the buff duration', () => {
        // 12 teas × 5 min = 60 min = 3600s, with nothing left on the current activation
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: false, duration: 999 * MINUTE_NS }];
        game.inventory = [{ itemHrid: '/items/wisdom_tea', count: 12 }];

        const [drink] = calculateDrinkRemainingSeconds(WOODCUTTING);
        expect(drink.name).toBe('Wisdom Tea');
        expect(drink.totalSeconds).toBeCloseTo(3600, 6);
    });

    test('the current activation counts only while the drink is actually active', () => {
        // 2 min left on the pour + 2 teas × 5 min = 12 min = 720s
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: true, duration: 2 * MINUTE_NS }];
        game.inventory = [{ itemHrid: '/items/wisdom_tea', count: 2 }];

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(720, 6);
    });

    test('concentration shortens the coverage each drink buys', () => {
        // Drinks are consumed 1 + DC times as fast: 10 × 5 min / 1.5 = 33.333 min = 2000s
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: false, duration: 0 }];
        game.inventory = [{ itemHrid: '/items/wisdom_tea', count: 10 }];
        parsers.concentration = 0.5;

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(2000, 6);
    });

    test('concentration does not shorten the pour already in progress', () => {
        // The server is counting that one down at its own rate: 3 min + 10 × 5/1.5 min = 2180s
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: true, duration: 3 * MINUTE_NS }];
        game.inventory = [{ itemHrid: '/items/wisdom_tea', count: 10 }];
        parsers.concentration = 0.5;

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(180 + 2000, 6);
    });

    test('an item with no buff duration falls back to five minutes', () => {
        game.initClientData.itemDetailMap['/items/mystery_tea'] = { name: 'Mystery Tea' };
        game.drinkSlots = [{ itemHrid: '/items/mystery_tea', isActive: false, duration: 0 }];
        game.inventory = [{ itemHrid: '/items/mystery_tea', count: 4 }];

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(1200, 6);
    });

    test('the inventory is read once for all slots, and each slot gets its own count', () => {
        game.drinkSlots = [
            { itemHrid: '/items/wisdom_tea', isActive: false, duration: 0 },
            { itemHrid: '/items/gathering_tea', isActive: false, duration: 0 },
        ];
        game.inventory = [
            { itemHrid: '/items/wisdom_tea', count: 12 },
            { itemHrid: '/items/unrelated', count: 50 },
            { itemHrid: '/items/gathering_tea', count: 6 },
        ];

        const drinks = calculateDrinkRemainingSeconds(WOODCUTTING);
        expect(game.inventoryReads).toBe(1);
        expect(drinks.map((d) => [d.name, d.totalSeconds])).toEqual([
            ['Wisdom Tea', 3600],
            ['Gathering Tea', 1800],
        ]);
    });

    test('a missing inventory counts as empty rather than throwing', () => {
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: true, duration: 2 * MINUTE_NS }];
        game.inventory = null;

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(120, 6);
    });

    test('inventory stacks of the same drink are summed', () => {
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: false, duration: 0 }];
        game.inventory = [
            { itemHrid: '/items/wisdom_tea', count: 3 },
            { itemHrid: '/items/wisdom_tea', count: 9 },
            { itemHrid: '/items/gathering_tea', count: 100 },
        ];

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(3600, 6);
    });

    test('the same drink slotted twice is reported once', () => {
        // Otherwise the panel double-counts a stack that is only drunk once
        game.drinkSlots = [
            { itemHrid: '/items/wisdom_tea', isActive: true, duration: MINUTE_NS },
            { itemHrid: '/items/wisdom_tea', isActive: true, duration: MINUTE_NS },
        ];
        game.inventory = [{ itemHrid: '/items/wisdom_tea', count: 1 }];

        const drinks = calculateDrinkRemainingSeconds(WOODCUTTING);
        expect(drinks).toHaveLength(1);
        expect(drinks[0].totalSeconds).toBeCloseTo(60 + 300, 6);
    });

    test('each different drink gets its own row, in slot order', () => {
        game.drinkSlots = [
            { itemHrid: '/items/gathering_tea', isActive: false, duration: 0 },
            { itemHrid: '/items/wisdom_tea', isActive: false, duration: 0 },
        ];
        game.inventory = [
            { itemHrid: '/items/wisdom_tea', count: 1 },
            { itemHrid: '/items/gathering_tea', count: 2 },
        ];

        expect(calculateDrinkRemainingSeconds(WOODCUTTING).map((d) => d.name)).toEqual(['Gathering Tea', 'Wisdom Tea']);
    });

    test('a slotted drink you have none of still shows whatever is pouring', () => {
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: true, duration: 90_000_000_000 }];
        game.inventory = [];

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBeCloseTo(90, 6);
    });

    test('empty slots, unknown items, and missing data all yield nothing rather than throwing', () => {
        game.drinkSlots = [null, {}, { itemHrid: '/items/not_in_game_data' }];
        expect(calculateDrinkRemainingSeconds(WOODCUTTING)).toEqual([]);

        game.drinkSlots = [];
        expect(calculateDrinkRemainingSeconds(WOODCUTTING)).toEqual([]);

        game.initClientData = null;
        expect(calculateDrinkRemainingSeconds(WOODCUTTING)).toEqual([]);
    });

    test('a missing inventory is treated as empty', () => {
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: false, duration: 0 }];
        game.inventory = null;

        expect(calculateDrinkRemainingSeconds(WOODCUTTING)[0].totalSeconds).toBe(0);
    });
});

describe('calculateQueueTimeSeconds', () => {
    const CHOP = '/actions/woodcutting/tree';

    beforeEach(() => {
        game.actions[CHOP] = { type: WOODCUTTING, baseTimeCost: 20e9 };
    });

    test('a finite queue is its remaining actions at the action time', () => {
        // 100 remaining × 20s, no efficiency
        game.currentActions = [{ actionHrid: CHOP, hasMaxCount: true, maxCount: 100, currentCount: 0 }];

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBeCloseTo(2000, 6);
    });

    test('progress already made is deducted', () => {
        game.currentActions = [{ actionHrid: CHOP, hasMaxCount: true, maxCount: 100, currentCount: 40 }];

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBeCloseTo(1200, 6);
    });

    test('efficiency shortens the queue, because it completes actions for free', () => {
        // 50% efficiency → ×1.5 output, so 120 actions take 120/1.5 = 80 time-consuming ones × 20s
        game.currentActions = [{ actionHrid: CHOP, hasMaxCount: true, maxCount: 120, currentCount: 0 }];
        parsers.stats = { actionTime: 20, totalEfficiency: 50 };

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBeCloseTo(1600, 6);
    });

    test('an infinite queue contributes nothing, rather than an infinite estimate', () => {
        game.currentActions = [{ actionHrid: CHOP, hasMaxCount: false, maxCount: 0, currentCount: 0 }];

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);
    });

    test('queued actions of other skills are not counted', () => {
        game.actions['/actions/cooking/stew'] = { type: '/action_types/cooking', baseTimeCost: 20e9 };
        game.currentActions = [
            { actionHrid: '/actions/cooking/stew', hasMaxCount: true, maxCount: 500, currentCount: 0 },
            { actionHrid: CHOP, hasMaxCount: true, maxCount: 10, currentCount: 0 },
        ];

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBeCloseTo(200, 6);
    });

    test('several queued actions of the same skill add together', () => {
        game.actions['/actions/woodcutting/oak'] = { type: WOODCUTTING, baseTimeCost: 20e9 };
        game.currentActions = [
            { actionHrid: CHOP, hasMaxCount: true, maxCount: 10, currentCount: 0 },
            { actionHrid: '/actions/woodcutting/oak', hasMaxCount: true, maxCount: 5, currentCount: 0 },
        ];

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBeCloseTo(300, 6);
    });

    test('a finished or over-counted entry contributes nothing, never a negative', () => {
        game.currentActions = [
            { actionHrid: CHOP, hasMaxCount: true, maxCount: 10, currentCount: 10 },
            { actionHrid: CHOP, hasMaxCount: true, maxCount: 10, currentCount: 25 },
        ];

        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);
    });

    test('an unknown action or one the calculator refuses is skipped', () => {
        game.currentActions = [
            { actionHrid: '/actions/woodcutting/ghost', hasMaxCount: true, maxCount: 9, currentCount: 0 },
        ];
        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);

        game.currentActions = [{ actionHrid: CHOP, hasMaxCount: true, maxCount: 9, currentCount: 0 }];
        parsers.stats = null;
        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);
    });

    test('missing game data or skills yield zero rather than throwing', () => {
        game.currentActions = [{ actionHrid: CHOP, hasMaxCount: true, maxCount: 9, currentCount: 0 }];

        game.skills = null;
        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);

        game.skills = [];
        game.initClientData = null;
        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);
    });

    test('an empty queue is zero', () => {
        expect(calculateQueueTimeSeconds(WOODCUTTING)).toBe(0);
    });
});

describe('artisanTeaShortfall', () => {
    const CHOP = '/actions/woodcutting/tree';
    const ARTISAN_TEA = '/items/artisan_tea';

    beforeEach(() => {
        game.actions[CHOP] = { type: WOODCUTTING };
        game.initClientData.itemDetailMap[ARTISAN_TEA] = {
            name: 'Artisan Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1, duration: 5 * MINUTE_NS }] },
        };
        // 20s/craft at 0 efficiency (parsers.stats default), matching the other describe block
        parsers.stats = { actionTime: 20, totalEfficiency: 0 };
    });

    test('no numActions, no action, or no game data all yield nothing rather than throwing', () => {
        expect(artisanTeaShortfall(CHOP, 0)).toEqual([]);
        expect(artisanTeaShortfall('/actions/woodcutting/ghost', 10)).toEqual([]);
        game.initClientData = null;
        expect(artisanTeaShortfall(CHOP, 10)).toEqual([]);
    });

    test('nothing slotted, or nothing with the artisan buff type, is not a shortfall', () => {
        game.drinkSlots = [];
        expect(artisanTeaShortfall(CHOP, 100)).toEqual([]);

        // Wisdom Tea has no artisan buff — this feature does not warn about it
        game.initClientData.itemDetailMap['/items/wisdom_tea'] = tea('Wisdom Tea', 5);
        game.drinkSlots = [{ itemHrid: '/items/wisdom_tea', isActive: false, duration: 0 }];
        game.inventory = [{ itemHrid: '/items/wisdom_tea', count: 1 }];
        expect(artisanTeaShortfall(CHOP, 100)).toEqual([]);
    });

    test('a tea that lasts the whole run is not a shortfall', () => {
        // 4 teas × 5 min = 1200s of tea; 50 crafts × 20s = 1000s of run
        game.drinkSlots = [{ itemHrid: ARTISAN_TEA, isActive: false, duration: 0 }];
        game.inventory = [{ itemHrid: ARTISAN_TEA, count: 4 }];

        expect(artisanTeaShortfall(CHOP, 50)).toEqual([]);
    });

    test('a tea that runs dry mid-run reports how many crafts it actually covers', () => {
        // Same 1200s of tea; 100 crafts × 20s = 2000s of run — dry at craft 60
        game.drinkSlots = [{ itemHrid: ARTISAN_TEA, isActive: false, duration: 0 }];
        game.inventory = [{ itemHrid: ARTISAN_TEA, count: 4 }];

        expect(artisanTeaShortfall(CHOP, 100)).toEqual([
            { itemHrid: ARTISAN_TEA, name: 'Artisan Tea', craftsSustained: 60, shortfall: 40 },
        ]);
    });

    test('a tea already fully spent and unbuffed is left to the out-of-stock warning, not this one', () => {
        // Nothing in the bag and nothing currently pouring: totalSeconds is 0
        game.drinkSlots = [{ itemHrid: ARTISAN_TEA, isActive: false, duration: 0 }];
        game.inventory = [];

        expect(artisanTeaShortfall(CHOP, 100)).toEqual([]);
    });
});
