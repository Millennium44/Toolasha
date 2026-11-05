/**
 * The skilling tea forecast.
 *
 * What matters here is the figures a player buys from: a rate that follows drink concentration, a
 * time left that agrees with the drink timer, and every way a tea can be short, unpriced or
 * unrated saying so instead of reading as zero.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const FORAGING = '/action_types/foraging';
const MINUTE_NS = 60_000_000_000;
const INV = '/item_locations/inventory';

const game = vi.hoisted(() => ({
    clientData: null,
    characterData: null,
    inventory: [],
    slots: [],
    actions: [],
    actionDetails: {},
    items: {},
    gearConcentration: 0,
    prices: {},
    map: new Map(),
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getInventory: () => game.inventory,
        getActionDrinkSlots: () => game.slots,
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.actionDetails[hrid] || null,
        getItemDetails: (hrid) => game.items[hrid] || null,
        get characterData() {
            return game.characterData;
        },
        get actionTypeDrinkSlotsMap() {
            return game.map;
        },
        getEquipment: () => new Map(),
    },
}));
vi.mock('./tea-parser.js', () => ({ getDrinkConcentration: () => game.gearConcentration }));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));
vi.mock('./action-calculator.js', () => ({ calculateActionStats: () => null }));
vi.mock('./market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] ?? null }));

const forecastMod = await import('./consumable-forecast.js');
const { skillingConsumables, skillingActionTypes, isSkillingActionType, runningActionTypeHrid, actionTypeLabel } =
    await import('./skilling-consumables.js');
const { calculateDrinkRemainingSeconds } = await import('./drink-calculator.js');

const tea = (name, minutes) => ({ name, consumableDetail: { buffs: [{ duration: minutes * MINUTE_NS }] } });
const slot = (itemHrid, extra = {}) => ({
    actionTypeHrid: FORAGING,
    characterID: 1,
    consumableSlotTypeHrid: '/consumable_slot_types/drink',
    duration: 0,
    isActive: false,
    itemHrid,
    slotIndex: 0,
    ...extra,
});
const stack = (itemHrid, count) => ({ itemHrid, count, itemLocationHrid: INV, enhancementLevel: 0 });
const runForaging = () => {
    game.actions = [{ actionHrid: '/actions/foraging/farmland', isDone: false, ordinal: 1 }];
    game.actionDetails['/actions/foraging/farmland'] = { type: FORAGING };
};

beforeEach(() => {
    game.clientData = { itemDetailMap: {} };
    game.characterData = { noncombatStats: { drinkConcentration: 0.129 } };
    game.inventory = [];
    game.slots = [];
    game.actions = [];
    game.actionDetails = {};
    game.gearConcentration = 0;
    game.prices = {};
    game.map = new Map();
    game.items = {
        '/items/gathering_tea': tea('Gathering Tea', 5),
        '/items/efficiency_tea': tea('Efficiency Tea', 5),
        '/items/mystery_tea': { name: 'Mystery Tea' },
    };
    game.clientData.itemDetailMap = game.items;
});

describe('the rate', () => {
    test('follows drink concentration: 300 s at 12.9% is one tea every 265.7 s', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea'), null, null];
        game.inventory = [stack('/items/gathering_tea', 100)];

        const [entry] = skillingConsumables(FORAGING).forecasts;
        expect(entry.rateKnown).toBe(true);
        expect(entry.perDay).toBeCloseTo(86400 / (300 / 1.129), 6);
        expect(entry.secondsLeft).toBeCloseTo(100 * (300 / 1.129), 6);
    });

    test('concentration 0 is the plain buff duration, not an unknown', () => {
        runForaging();
        game.characterData = { noncombatStats: { drinkConcentration: 0 } };
        game.slots = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 10)];

        const view = skillingConsumables(FORAGING);
        expect(view.concentration).toBe(0);
        expect(view.forecasts[0].perDay).toBeCloseTo(288, 6);
    });

    test('the running skill uses the character stat; another skill reads its gear', () => {
        game.slots = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 10)];
        game.gearConcentration = 0.2;

        expect(skillingConsumables(FORAGING).concentrationSource).toBe('gear');
        expect(skillingConsumables(FORAGING).concentration).toBe(0.2);

        runForaging();
        expect(skillingConsumables(FORAGING).concentrationSource).toBe('character');
        expect(skillingConsumables(FORAGING).concentration).toBe(0.129);
    });

    test('a character stat of null is not read as zero', () => {
        runForaging();
        game.characterData = { noncombatStats: { drinkConcentration: null } };
        game.gearConcentration = 0.2;
        game.slots = [slot('/items/gathering_tea')];

        expect(skillingConsumables(FORAGING).concentration).toBe(0.2);
    });

    test('a tea with no buff duration has an unknown rate, never a made-up one', () => {
        runForaging();
        game.slots = [slot('/items/mystery_tea'), slot('/items/ghost_tea')];
        game.inventory = [stack('/items/mystery_tea', 5)];

        const { forecasts } = skillingConsumables(FORAGING);
        expect(forecasts).toHaveLength(2);
        for (const entry of forecasts) {
            expect(entry.rateKnown).toBe(false);
            expect(entry.perDay).toBeNull();
            expect(entry.secondsLeft).toBeNull();
        }
        expect(forecasts[1].name).toBe('ghost tea');
    });
});

describe('time left agrees with the drink timer', () => {
    // The timer reads concentration off gear and the forecast off the character stat; the two are the
    // same number for the same character
    beforeEach(() => {
        game.gearConcentration = 0.129;
    });

    test('the running activation counts, with the held stack on top', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea', { isActive: true, duration: 120 * 1e9 })];
        game.inventory = [stack('/items/gathering_tea', 4)];

        const [entry] = skillingConsumables(FORAGING).forecasts;
        const [timer] = calculateDrinkRemainingSeconds(FORAGING);
        expect(entry.secondsLeft).toBeCloseTo(timer.totalSeconds, 6);
        expect(entry.activeSeconds).toBe(120);
    });

    test('an inactive slot contributes no activation, as the timer has it', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea', { isActive: false, duration: 120 * 1e9 })];
        game.inventory = [stack('/items/gathering_tea', 4)];

        const [entry] = skillingConsumables(FORAGING).forecasts;
        const [timer] = calculateDrinkRemainingSeconds(FORAGING);
        expect(entry.secondsLeft).toBeCloseTo(timer.totalSeconds, 6);
        expect(entry.activeSeconds).toBe(0);
    });
});

describe('every ending', () => {
    test('a tea held at zero is kept, with its whole shortfall', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea')];

        const view = skillingConsumables(FORAGING);
        expect(view.forecasts).toHaveLength(1);
        expect(view.forecasts[0].held).toBe(0);
        expect(view.forecasts[0].secondsLeft).toBe(0);
        // A day of it, rounded up, with nothing held to subtract
        expect(forecastMod.refillFor(view.forecasts[0], 86400).count).toBe(Math.ceil(86400 / (300 / 1.129)));
    });

    test('the same tea in two slots is one entry', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea', { slotIndex: 0 }), slot('/items/gathering_tea', { slotIndex: 1 })];
        game.inventory = [stack('/items/gathering_tea', 3), stack('/items/gathering_tea', 2)];

        const view = skillingConsumables(FORAGING);
        expect(view.forecasts).toHaveLength(1);
        // Both stacks are held, counted once
        expect(view.forecasts[0].held).toBe(5);
        expect(view.held).toBe(5);
        expect(view.slotted).toBe(1);
    });

    test('null slots are skipped; an empty array is nothing slotted', () => {
        runForaging();
        game.slots = [null, null, null];
        expect(skillingConsumables(FORAGING)).toMatchObject({ ready: true, slotted: 0, forecasts: [] });
        game.slots = [];
        expect(skillingConsumables(FORAGING)).toMatchObject({ ready: true, slotted: 0, forecasts: [] });
    });

    test('no character data yet is not ready, rather than a held count of zero', () => {
        game.slots = [slot('/items/gathering_tea')];
        game.characterData = null;
        expect(skillingConsumables(FORAGING).ready).toBe(false);

        game.characterData = {};
        game.inventory = null;
        expect(skillingConsumables(FORAGING).ready).toBe(false);

        game.inventory = [];
        game.clientData = null;
        expect(skillingConsumables(FORAGING).ready).toBe(false);
    });

    test('a skill that is not running is frozen', () => {
        game.slots = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 3)];

        expect(skillingConsumables(FORAGING)).toMatchObject({ running: false, frozen: true, held: 3 });
        runForaging();
        expect(skillingConsumables(FORAGING)).toMatchObject({ running: true, frozen: false });
    });

    test('a queued foraging action behind a running fight does not make foraging the running skill', () => {
        game.actions = [
            { actionHrid: '/actions/foraging/farmland', isDone: false, ordinal: 5 },
            { actionHrid: '/actions/combat/fly', isDone: false, ordinal: 1 },
        ];
        game.actionDetails['/actions/foraging/farmland'] = { type: FORAGING };
        game.actionDetails['/actions/combat/fly'] = { type: '/action_types/combat' };

        expect(runningActionTypeHrid()).toBe('/action_types/combat');
    });

    test('an unpriced tea is counted unpriced, on both sides, never as free', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea'), slot('/items/efficiency_tea')];
        game.inventory = [stack('/items/gathering_tea', 5), stack('/items/efficiency_tea', 5)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        game.prices['/items/efficiency_tea'] = null;

        const { forecasts } = skillingConsumables(FORAGING);
        const sides = forecastMod.costPerDaySides(forecasts);
        const perDay = 86400 / (300 / 1.129);
        expect(sides.ask).toBeCloseTo(perDay * 1000, 3);
        expect(sides.bid).toBeCloseTo(perDay * 900, 3);
        expect(sides.askUnpriced).toBe(1);
        expect(sides.bidUnpriced).toBe(1);
        expect(forecasts[1].price).toBeNull();
        expect(forecastMod.refillFor(forecasts[1], 86400).cost).toBeNull();
    });

    test('nothing priced at all leaves the total unknown, not zero', () => {
        runForaging();
        game.slots = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 5)];

        const sides = forecastMod.costPerDaySides(skillingConsumables(FORAGING).forecasts);
        expect(sides.ask).toBeNull();
        expect(sides.askUnpriced).toBe(1);
    });

    test('an unrated tea is counted unknown in the cost, not priced at nothing', () => {
        runForaging();
        game.slots = [slot('/items/mystery_tea')];
        game.prices['/items/mystery_tea'] = { ask: 500, bid: 400 };

        const sides = forecastMod.costPerDaySides(skillingConsumables(FORAGING).forecasts);
        expect(sides.ask).toBeNull();
        expect(sides.askUnknown).toBe(1);
    });
});

describe('the helpers', () => {
    test('skilling types are in the game order, and unnumbered ones follow by name', () => {
        game.map = new Map([
            ['/action_types/woodcutting', []],
            ['/action_types/brewing', []],
            ['/action_types/milking', []],
            ['/action_types/alchemy', []],
            ['/action_types/zzz_new_skill', []],
            ['/action_types/aaa_new_skill', []],
            ['/action_types/foraging', []],
        ]);
        game.clientData = {
            actionTypeDetailMap: {
                '/action_types/milking': { sortIndex: 1 },
                '/action_types/foraging': { sortIndex: 2 },
                '/action_types/woodcutting': { sortIndex: 3 },
                '/action_types/brewing': { sortIndex: 8 },
                '/action_types/alchemy': { sortIndex: 9 },
            },
        };
        expect(skillingActionTypes()).toEqual([
            '/action_types/milking',
            '/action_types/foraging',
            '/action_types/woodcutting',
            '/action_types/brewing',
            '/action_types/alchemy',
            '/action_types/aaa_new_skill',
            '/action_types/zzz_new_skill',
        ]);
    });

    test('skilling types leave out combat, labyrinth and special, by name', () => {
        game.map = new Map([
            ['/action_types/woodcutting', []],
            ['/action_types/combat', []],
            ['/action_types/labyrinth', []],
            ['/action_types/special', []],
            ['/action_types/foraging', []],
        ]);
        expect(skillingActionTypes()).toEqual(['/action_types/foraging', '/action_types/woodcutting']);
        expect(isSkillingActionType('/action_types/combat')).toBe(false);
        expect(isSkillingActionType('/action_types/labyrinth')).toBe(false);
        expect(isSkillingActionType(null)).toBe(false);
        expect(isSkillingActionType(FORAGING)).toBe(true);
        expect(actionTypeLabel('/action_types/foraging')).toBe('Foraging');
    });
});
