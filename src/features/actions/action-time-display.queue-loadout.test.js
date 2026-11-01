/**
 * A queued action is timed with the loadout it was queued under.
 *
 * Every entry in `characterActions` carries `characterLoadoutID`: a saved loadout's id, or 0 for
 * "No Loadout" (the gear worn now). The queue rows and the queue walks used to time every row
 * with the worn gear and the skill's default-loadout drinks, whatever the row's own loadout was.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ statsCalls: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => [],
        getEquipment: () => new Map([['/item_locations/main_hand', { itemHrid: '/items/worn' }]]),
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/artisan_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
                },
            },
        }),
        getItemDetails: () => null,
        getActionDrinkSlots: () => [],
        getInventory: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: (_details, options) => {
        game.statsCalls.push(options);
        return { actionTime: 10, totalEfficiency: 0 };
    },
}));

// The real resolver is covered in action-context.test.js; here only which one is asked matters.
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map([['d', { itemHrid: '/items/default' }]]), drinks: [] }),
    resolveLoadoutContext: (type, id) => ({
        equipment: new Map([['l', { itemHrid: `/items/loadout_${id}` }]]),
        drinks: id > 0 ? [{ itemHrid: '/items/artisan_tea' }] : [],
    }),
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, f) => f, COLOR_TOOLTIP_INFO: '#abc' },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

const DETAILS = { hrid: '/actions/cooking/cake', type: '/action_types/cooking', inputItems: [], outputItems: [] };

const row = (extra) => ({ id: 1, actionHrid: DETAILS.hrid, hasMaxCount: true, maxCount: 5, currentCount: 0, ...extra });

const wornOf = (call) => [...call.actionContext.equipment.values()].map((e) => e.itemHrid);

describe("calculateActionTime uses the queued action's own loadout", () => {
    beforeEach(() => {
        game.statsCalls.length = 0;
    });

    test('a saved loadout id times the row with that loadout', () => {
        actionTimeDisplay.calculateActionTime(DETAILS, DETAILS.hrid, row({ characterLoadoutID: 30284 }));

        expect(wornOf(game.statsCalls[0])).toEqual(['/items/loadout_30284']);
    });

    test('id 0 (No Loadout) is its own context too, not the default-loadout resolution', () => {
        actionTimeDisplay.calculateActionTime(DETAILS, DETAILS.hrid, row({ characterLoadoutID: 0 }));

        expect(wornOf(game.statsCalls[0])).toEqual(['/items/loadout_0']);
    });

    test('an action with no loadout id keeps the old resolution; an explicit context still wins', () => {
        actionTimeDisplay.calculateActionTime(DETAILS, DETAILS.hrid, row({}));
        expect(game.statsCalls[0].actionContext).toBeNull();

        const explicit = { equipment: new Map(), drinks: [] };
        actionTimeDisplay.calculateActionTime(DETAILS, DETAILS.hrid, row({ characterLoadoutID: 7 }), explicit);
        expect(game.statsCalls[1].actionContext).toBe(explicit);
    });
});

describe('the Artisan discount follows the loadout drinks of the row', () => {
    test('a row queued under the Artisan tea loadout gets the discount, a No Loadout row does not', () => {
        const saved = actionTimeDisplay.getArtisanBonusForAction(DETAILS, row({ characterLoadoutID: 30284 }));
        const none = actionTimeDisplay.getArtisanBonusForAction(DETAILS, row({ characterLoadoutID: 0 }));

        expect(saved).toBeCloseTo(0.1);
        expect(none).toBe(0);
    });
});
