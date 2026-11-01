/**
 * Queue rows resolve gear from the loadout they were queued under: the async profit pass, the
 * enhancing prediction (time and attempts) and the alchemy success rate.
 *
 * A queued action carries `characterLoadoutID`: a saved loadout's id, or 0 for "No Loadout" (the
 * gear worn now, even when a default loadout exists). A row with no id keeps the per-skill
 * default resolution it always had.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    details: {},
    gatheringCalls: [],
    productionCalls: [],
    predictionCalls: [],
    successCalls: [],
    penaltyCalls: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => [],
        getEquipment: () => new Map(),
        getInitClientData: () => ({ itemDetailMap: {} }),
        getItemDetails: () => null,
        getActionDetails: (hrid) => game.details[hrid] || null,
        getActionDrinkSlots: () => [],
        getInventory: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ tag: 'default', equipment: new Map(), drinks: [] }),
    resolveLoadoutContext: (type, id) => ({ tag: `loadout_${id}`, equipment: new Map(), drinks: [], tea: id * 0.01 }),
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
vi.mock('./gathering-profit.js', () => ({
    calculateGatheringProfit: async (hrid, options) => {
        game.gatheringCalls.push([hrid, options]);
        return null;
    },
}));
vi.mock('../market/profit-calculator.js', () => ({
    default: {
        calculateProfit: async (item, options) => {
            game.productionCalls.push([item, options]);
            return null;
        },
    },
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({
    calculateEnhancementPredictions: (...args) => {
        game.predictionCalls.push(args);
        return { expectedAttempts: 10, expectedProtections: 0, perActionTime: 5, successMultiplier: 1 };
    },
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        baseSuccessRateFor: () => 0.5,
        catalystSuccessBonus: () => 0,
        getUnderLevelPenalty: (...args) => {
            game.penaltyCalls.push(args);
            return 0;
        },
        // The context's own tea, as the real calculator reads the context's drinks
        successBonusFromContext: (ctx) => (ctx ? ctx.tea : null),
        calculateSuccessRateBreakdown: (base, catalyst, teaOverride, penalty) => {
            game.successCalls.push(teaOverride);
            const tea = teaOverride !== null ? teaOverride : 0.2; // 0.2: the live buff map
            return { total: base * (1 + catalyst + penalty + tea) };
        },
    },
}));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

const CHEESE = '/actions/cheesesmithing/cheese';
const FORAGE = '/actions/foraging/egg';
const ENHANCE = '/actions/enhancing/enhance';
const COINIFY = '/actions/alchemy/coinify';

beforeEach(() => {
    game.gatheringCalls.length = 0;
    game.productionCalls.length = 0;
    game.predictionCalls.length = 0;
    game.successCalls.length = 0;
    game.penaltyCalls.length = 0;
    game.details = {
        [CHEESE]: {
            hrid: CHEESE,
            type: '/action_types/cheesesmithing',
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        },
        [FORAGE]: {
            hrid: FORAGE,
            type: '/action_types/foraging',
            outputItems: [{ itemHrid: '/items/egg', count: 1 }],
        },
        [ENHANCE]: { hrid: ENHANCE, type: '/action_types/enhancing' },
        [COINIFY]: { hrid: COINIFY, type: '/action_types/alchemy' },
    };
});

describe('the queue profit pass costs each row with its own loadout', () => {
    test('duplicate rows under different loadouts each get their own context', async () => {
        await actionTimeDisplay.calculateProfitForAction({ actionHrid: CHEESE, count: 3, characterLoadoutID: 30284 });
        await actionTimeDisplay.calculateProfitForAction({ actionHrid: CHEESE, count: 3, characterLoadoutID: 0 });

        expect(game.gatheringCalls.map(([, o]) => o.actionContext.tag)).toEqual(['loadout_30284', 'loadout_0']);
        expect(game.productionCalls.map(([, o]) => o.actionContext.tag)).toEqual(['loadout_30284', 'loadout_0']);
    });

    test('a row with no loadout id keeps the per-skill default (no context handed over)', async () => {
        await actionTimeDisplay.calculateProfitForAction({ actionHrid: CHEESE, count: 3 });

        expect(game.gatheringCalls[0][1].actionContext).toBeNull();
        expect(game.productionCalls[0][1].actionContext).toBeNull();
    });

    test('a gathering row asks the gathering calculator with its loadout too', async () => {
        await actionTimeDisplay.calculateProfitForAction({ actionHrid: FORAGE, count: 5, characterLoadoutID: 77 });

        expect(game.gatheringCalls[0][0]).toBe(FORAGE);
        expect(game.gatheringCalls[0][1].actionContext.tag).toBe('loadout_77');
    });
});

describe('enhancing rows are predicted on their own loadout', () => {
    const enhanceRow = (extra) => ({
        id: 1,
        actionHrid: ENHANCE,
        primaryItemHash: 'c::/item_locations/inventory::/items/sword::0',
        enhancingMaxLevel: 5,
        enhancingProtectionMinLevel: 0,
        hasMaxCount: false,
        ...extra,
    });

    test('a saved loadout rolls and times on that loadout, not the live buff maps', () => {
        actionTimeDisplay.calculateEnhancingQueueTime(
            enhanceRow({ characterLoadoutID: 30284 }),
            game.details[ENHANCE],
            { byHrid: {}, byEnhancedKey: {} }
        );

        const options = game.predictionCalls[0][4];
        expect(options.actionContext.tag).toBe('loadout_30284');
        expect(options.timeFromContext).toBe(true);
    });

    test('No Loadout (id 0) is the worn gear: its context, but the live buff maps still time it', () => {
        actionTimeDisplay.calculateEnhancingQueueTime(enhanceRow({ characterLoadoutID: 0 }), game.details[ENHANCE], {
            byHrid: {},
            byEnhancedKey: {},
        });

        const options = game.predictionCalls[0][4];
        expect(options.actionContext.tag).toBe('loadout_0');
        expect(options.timeFromContext).toBe(false);
    });

    test('a row with no loadout id keeps the old call shape', () => {
        actionTimeDisplay.calculateEnhancingQueueTime(enhanceRow({}), game.details[ENHANCE], {
            byHrid: {},
            byEnhancedKey: {},
        });

        expect(game.predictionCalls[0][4]).toEqual({});
    });
});

describe('the queued alchemy success rate follows the row loadout', () => {
    const alchemyDetails = { itemLevel: 10 };
    const row = (extra) => ({ actionHrid: COINIFY, ...extra });

    test('a saved loadout supplies the tea and the penalty context; a bare row keeps the live buffs', () => {
        const saved = actionTimeDisplay.getAlchemyQueuedSuccessRate(
            game.details[COINIFY],
            alchemyDetails,
            row({ characterLoadoutID: 10 })
        );
        const bare = actionTimeDisplay.getAlchemyQueuedSuccessRate(game.details[COINIFY], alchemyDetails, row({}));

        expect(saved).toBeCloseTo(0.5 * 1.1); // tea 0.10 from loadout_10
        expect(bare).toBeCloseTo(0.5 * 1.2); // live tea
        expect(game.successCalls).toEqual([0.1, null]);
        // the under-level penalty is measured at the loadout's alchemy level too
        expect(game.penaltyCalls[0][2]).toMatchObject({ drinkSlots: [] });
        expect(game.penaltyCalls[1]).toHaveLength(1);
    });

    test('No Loadout (id 0) reads the context for id 0, not the live map', () => {
        actionTimeDisplay.getAlchemyQueuedSuccessRate(
            game.details[COINIFY],
            alchemyDetails,
            row({ characterLoadoutID: 0 })
        );
        expect(game.successCalls).toEqual([0]);
    });
});
