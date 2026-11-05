/**
 * The Total Profit tile's skilling estimate.
 *
 * The risks are all about a figure arriving late or for the wrong thing: a
 * calculator answer that lands after the character switched, after the action
 * changed, or for a pricing mode that is no longer the one in force. Each is a
 * case below, along with every way the estimate can end.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    handlers: {},
    actions: [],
    details: {},
    characterId: 'char1',
    settings: { profitCalc_pricingMode: 'hybrid', profitCalc_excludeSellTax: false },
    gather: null,
    produce: null,
    bridgeUp: true,
    context: () => null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.details[hrid],
        getCurrentCharacterId: () => game.characterId,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => game.settings[key] ?? fallback },
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveRunningContext: (...args) => game.context(...args),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
    gatheringProfit: () => (game.bridgeUp ? { calculateGatheringProfit: (...args) => game.gather(...args) } : null),
    productionProfit: () => (game.bridgeUp ? { calculateProductionProfit: (...args) => game.produce(...args) } : null),
}));

const { runningSkillingProfit, skillingProfitVersion } = await import('./skilling-profit-estimate.js');

const FORAGING = '/actions/foraging/star_fruit';
const CRAFTING = '/actions/crafting/wooden_bow';
const ENHANCING = '/actions/enhancing/enhance';
const ALCHEMY = '/actions/alchemy/coinify';
const COMBAT = '/actions/combat/golem_cave';

/** A calculator answer in the shape the real ones return */
const profit = (profitPerHour, extra = {}) => ({
    profitPerHour,
    hasMissingPrices: false,
    pricingMode: 'hybrid',
    ...extra,
});

/** Let every promise the estimate started run out */
async function settle() {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function run(actionHrid, type, name = 'Star Fruit') {
    game.details[actionHrid] = { type, name };
    game.actions = [{ actionHrid, isDone: false, ordinal: 0 }];
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    game.handlers.character_switching();
    game.actions = [];
    game.details = {};
    game.characterId = 'char1';
    game.settings = { profitCalc_pricingMode: 'hybrid', profitCalc_excludeSellTax: false };
    game.bridgeUp = true;
    game.context = () => null;
    game.gather = vi.fn(async () => profit(1_310_000));
    game.produce = vi.fn(async () => profit(250_000));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('which actions get an estimate', () => {
    test('idle when nothing is running, so the tile keeps its combat reading', () => {
        expect(runningSkillingProfit()).toEqual({ state: 'idle' });
    });

    test('idle while a fight runs, even with a skilling action queued behind it', () => {
        game.details[COMBAT] = { type: '/action_types/combat', name: 'Golem Cave' };
        game.details[FORAGING] = { type: '/action_types/foraging', name: 'Star Fruit' };
        game.actions = [
            { actionHrid: FORAGING, isDone: false, ordinal: 9 },
            { actionHrid: COMBAT, isDone: false, ordinal: 1 },
        ];
        expect(runningSkillingProfit()).toEqual({ state: 'idle' });
        expect(game.gather).not.toHaveBeenCalled();
    });

    test('a gathering action goes to the gathering calculator and a crafting one to the production calculator', async () => {
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        expect(game.gather).toHaveBeenCalledWith(FORAGING, { actionContext: null });
        expect(game.produce).not.toHaveBeenCalled();

        game.handlers.character_switching();
        run(CRAFTING, '/action_types/crafting', 'Wooden Bow');
        runningSkillingProfit();
        expect(game.produce).toHaveBeenCalledWith(CRAFTING, { upgradeItemLevel: 0, actionContext: null });
        await settle();
    });

    test('an upgrade craft is priced at the +N stack its primaryItemHash names, and a different level is a different answer', async () => {
        const UPGRADE = '/items/wooden_bow';
        game.details[CRAFTING] = { type: '/action_types/crafting', name: 'Bow', upgradeItemHrid: UPGRADE };
        const queue = (hash) => {
            game.actions = [{ actionHrid: CRAFTING, isDone: false, ordinal: 0, primaryItemHash: hash }];
        };
        queue(`1::/item_locations/inventory::${UPGRADE}::5`);
        runningSkillingProfit();
        expect(game.produce).toHaveBeenLastCalledWith(CRAFTING, { upgradeItemLevel: 5, actionContext: null });
        await settle();
        const five = runningSkillingProfit();
        expect(five).toMatchObject({ state: 'ready' });

        // Another level must not be served the +5 answer
        queue(`1::/item_locations/inventory::${UPGRADE}::7`);
        expect(runningSkillingProfit().state).toBe('pending');
        expect(game.produce).toHaveBeenLastCalledWith(CRAFTING, { upgradeItemLevel: 7, actionContext: null });
        await settle();
        expect(skillingProfitVersion(runningSkillingProfit())).not.toBe(skillingProfitVersion(five));

        // A hash naming some other item leaves the +0 stack
        queue('1::/item_locations/inventory::/items/other::9');
        runningSkillingProfit();
        expect(game.produce).toHaveBeenLastCalledWith(CRAFTING, { upgradeItemLevel: 0, actionContext: null });
        await settle();
    });

    test.each([
        ['Enhancing', ENHANCING, '/action_types/enhancing'],
        ['Alchemy', ALCHEMY, '/action_types/alchemy'],
    ])('%s has no estimate and never calls a calculator', (skill, hrid, type) => {
        run(hrid, type, skill);
        expect(runningSkillingProfit()).toMatchObject({ state: 'none', skillName: skill });
        expect(game.gather).not.toHaveBeenCalled();
        expect(game.produce).not.toHaveBeenCalled();
    });

    test('a calculator that returns nothing, or no finite figure, settles as no estimate', async () => {
        run(FORAGING, '/action_types/foraging');
        game.gather = vi.fn(async () => null);
        expect(runningSkillingProfit().state).toBe('pending');
        await settle();
        expect(runningSkillingProfit()).toMatchObject({ state: 'none', failed: false });

        game.handlers.character_switching();
        game.gather = vi.fn(async () => profit(Number.NaN));
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit().state).toBe('none');
    });

    test('zero revenue with missing prices is no estimate, not a green zero', async () => {
        run(FORAGING, '/action_types/foraging');
        game.gather = vi.fn(async () => profit(0, { hasMissingPrices: true, revenuePerHour: 0 }));
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit()).toMatchObject({ state: 'none', failed: false });

        // Some revenue with a price still missing is a partial figure, drawn as one
        game.handlers.character_switching();
        game.gather = vi.fn(async () => profit(500, { hasMissingPrices: true, revenuePerHour: 900 }));
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit()).toMatchObject({ state: 'ready' });

        // Zero revenue with every price known really is an action that earns nothing
        game.handlers.character_switching();
        game.gather = vi.fn(async () => profit(-40, { revenuePerHour: 0 }));
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit()).toMatchObject({ state: 'ready' });
    });

    test('a calculator that throws settles as no estimate, flagged as failed, without a hot retry loop', async () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        run(FORAGING, '/action_types/foraging');
        game.gather = vi.fn(async () => {
            throw new Error('boom');
        });
        runningSkillingProfit();
        await settle();

        expect(runningSkillingProfit()).toMatchObject({ state: 'none', failed: true });
        runningSkillingProfit();
        runningSkillingProfit();
        expect(game.gather).toHaveBeenCalledTimes(1);
        quiet.mockRestore();
    });

    test('the market bundle not being up is no estimate rather than a thrown error', async () => {
        game.bridgeUp = false;
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit().state).toBe('none');
    });
});

describe('pending, priced, partly priced and a loss', () => {
    test('the first seconds are pending, then the figure lands', async () => {
        run(FORAGING, '/action_types/foraging');

        const first = runningSkillingProfit();
        expect(first).toMatchObject({ state: 'pending', actionName: 'Star Fruit', skillName: 'Foraging' });
        const before = skillingProfitVersion(first);

        await settle();
        const landed = runningSkillingProfit();
        expect(landed).toMatchObject({ state: 'ready', estimate: { profitPerHour: 1_310_000 } });
        // The row's version must move when the figure lands, or the 1 s tick never redraws it
        expect(skillingProfitVersion(landed)).not.toBe(before);
    });

    test('a partly priced result keeps its flag and shows in the version', async () => {
        game.gather = vi.fn(async () => profit(400_000, { hasMissingPrices: true, revenuePerHour: 450_000 }));
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        await settle();

        const reading = runningSkillingProfit();
        expect(reading.estimate.hasMissingPrices).toBe(true);
        expect(skillingProfitVersion(reading)).toContain('|1|');
    });

    test('a loss stays negative', async () => {
        game.gather = vi.fn(async () => profit(-52_000));
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit().estimate.profitPerHour).toBe(-52_000);
    });

    test('it is asked once per key, not once per redraw, and again after the memo expires', async () => {
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        runningSkillingProfit();
        await settle();
        runningSkillingProfit();
        expect(game.gather).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 16_000);
        // The held figure is for the same key, so it is still drawn while it is refreshed
        expect(runningSkillingProfit().state).toBe('ready');
        await settle();
        expect(game.gather).toHaveBeenCalledTimes(2);
    });
});

describe('nothing stale is drawn', () => {
    test('changing the pricing mode asks again and draws nothing for the old mode meanwhile', async () => {
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit().state).toBe('ready');

        game.settings.profitCalc_pricingMode = 'conservative';
        game.gather = vi.fn(async () => profit(900_000, { pricingMode: 'conservative' }));
        expect(runningSkillingProfit().state).toBe('pending');
        await settle();
        expect(runningSkillingProfit()).toMatchObject({
            state: 'ready',
            estimate: { profitPerHour: 900_000, pricingMode: 'conservative' },
        });
    });

    test('the sell-tax exclusion is part of the key', async () => {
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        await settle();

        game.settings.profitCalc_excludeSellTax = true;
        expect(runningSkillingProfit().state).toBe('pending');
    });

    test('a different action is pending, not the previous action’s figure', async () => {
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();
        await settle();

        run(CRAFTING, '/action_types/crafting', 'Wooden Bow');
        expect(runningSkillingProfit()).toMatchObject({ state: 'pending', actionName: 'Wooden Bow' });
    });

    test('an answer for an action that is no longer running is dropped when it lands', async () => {
        let release;
        game.gather = vi.fn(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(profit(1_310_000));
                })
        );
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();

        // The player switches to crafting before the first answer arrives
        run(CRAFTING, '/action_types/crafting', 'Wooden Bow');
        runningSkillingProfit();
        release();
        await settle();

        expect(runningSkillingProfit()).toMatchObject({ state: 'ready', actionName: 'Wooden Bow' });
        expect(runningSkillingProfit().estimate.profitPerHour).toBe(250_000);
    });

    test('an answer that lands after a character switch is dropped, and the new character starts clean', async () => {
        let release;
        game.gather = vi.fn(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(profit(1_310_000));
                })
        );
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();

        game.handlers.character_switching();
        game.characterId = 'char2';
        game.gather = vi.fn(async () => profit(77_000));
        expect(runningSkillingProfit().state).toBe('pending');
        release();
        await settle();

        expect(runningSkillingProfit().estimate.profitPerHour).toBe(77_000);
    });

    test('a switch whose event has not fired yet is still caught by the identity check after the await', async () => {
        let release;
        game.gather = vi.fn(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(profit(1_310_000));
                })
        );
        run(FORAGING, '/action_types/foraging');
        runningSkillingProfit();

        game.characterId = 'char2';
        release();
        await settle();

        game.gather = vi.fn(async () => profit(5_000));
        expect(runningSkillingProfit().state).toBe('pending');
    });
});

describe("the running action's own loadout", () => {
    const ctx = (tea) => ({
        equipment: new Map([['/item_locations/main_hand', { itemHrid: '/items/pan', enhancementLevel: 0 }]]),
        drinks: [{ itemHrid: tea }],
    });

    test('the context is passed to both calculators and a different loadout is a different answer', async () => {
        game.context = vi.fn((type, id) => (id === 0 ? ctx('/items/a') : ctx('/items/b')));
        run(FORAGING, '/action_types/foraging');
        game.actions[0].characterLoadoutID = 0;
        runningSkillingProfit();
        expect(game.gather).toHaveBeenLastCalledWith(FORAGING, { actionContext: ctx('/items/a') });
        await settle();
        const zero = skillingProfitVersion(runningSkillingProfit());

        game.actions[0].characterLoadoutID = 30284;
        expect(runningSkillingProfit().state).toBe('pending');
        expect(game.gather).toHaveBeenLastCalledWith(FORAGING, { actionContext: ctx('/items/b') });
        await settle();
        expect(skillingProfitVersion(runningSkillingProfit())).not.toBe(zero);

        game.handlers.character_switching();
        run(CRAFTING, '/action_types/crafting', 'Wooden Bow');
        game.actions[0].characterLoadoutID = 30284;
        runningSkillingProfit();
        expect(game.produce).toHaveBeenLastCalledWith(CRAFTING, {
            upgradeItemLevel: 0,
            actionContext: ctx('/items/b'),
        });
        await settle();
    });

    test('edited drinks under the same id are not served the old answer', async () => {
        let tea = '/items/a';
        game.context = () => ctx(tea);
        run(FORAGING, '/action_types/foraging');
        game.actions[0].characterLoadoutID = 30284;
        runningSkillingProfit();
        await settle();
        expect(runningSkillingProfit().state).toBe('ready');
        tea = '/items/c';
        expect(runningSkillingProfit().state).toBe('pending');
        await settle();
    });

    test('a character switch while pending drops the answer worked out for the old loadout', async () => {
        let release;
        game.gather = vi.fn(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(profit(1));
                })
        );
        game.context = () => ctx('/items/a');
        run(FORAGING, '/action_types/foraging');
        game.actions[0].characterLoadoutID = 30284;
        runningSkillingProfit();
        game.handlers.character_switching();
        game.characterId = 'char2';
        release();
        await settle();
        game.gather = vi.fn(async () => profit(2));
        expect(runningSkillingProfit().state).toBe('pending');
    });
});
