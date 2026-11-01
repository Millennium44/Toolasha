/**
 * The running action's items/hr reads the gathering tea and Gourmet bonuses from the drinks of
 * the loadout the action was queued under, the same context as its speed, efficiency and Artisan
 * figures. It used to read the slotted (worn) drinks straight off the character, so a loadout
 * without the tea still counted it, and a slotted tea with no stock left still counted too.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const GATHERING_TEA = '/items/gathering_tea';
const GOURMET_TEA = '/items/gourmet_tea';

const game = vi.hoisted(() => ({ action: null, details: null, wornDrinks: [], loadoutDrinks: [], calls: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => ({ hrid, name: hrid }),
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => game.wornDrinks,
        getActionDetails: () => game.details,
        getCurrentActions: () => [game.action],
        getEquipment: () => new Map(),
        getSkills: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getIsCharacterSwitching: () => false,
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        characterSettingsLoaded: true,
        getSetting: (key) => key === 'actionBar_showActionsPerHour',
        getSettingValue: (key, fallback) => (key === 'actionBar_showTimeRemaining' ? 'none' : fallback),
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: (details, options) => {
        game.calls.push(options.actionContext);
        return { actionTime: 3.6, totalEfficiency: 0 };
    },
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: game.wornDrinks }),
    resolveLoadoutContext: () => ({ equipment: new Map(), drinks: game.loadoutDrinks }),
}));
vi.mock('../../utils/tea-parser.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getDrinkConcentration: () => 0,
    parseGatheringBonus: (drinks) => ((drinks || []).some((d) => d.itemHrid === GATHERING_TEA) ? 1 : 0),
    parseGourmetBonus: (drinks) => ((drinks || []).some((d) => d.itemHrid === GOURMET_TEA) ? 1 : 0),
}));
vi.mock('../../utils/community-buffs.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getCommunityGatheringQuantity: () => 0,
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

const FORAGE = {
    hrid: '/actions/foraging/egg',
    name: 'Egg',
    type: '/action_types/foraging',
    dropTable: [{ itemHrid: '/items/egg', dropRate: 1, minCount: 1, maxCount: 1 }],
};
const COOK = {
    hrid: '/actions/cooking/donut',
    name: 'Donut',
    type: '/action_types/cooking',
    coinCost: 0,
    inputItems: [],
    outputItems: [{ itemHrid: '/items/donut', count: 1 }],
};

function stats() {
    return document.querySelector('.Header_actionName_abc123').textContent;
}

describe('the running action reads its tea bonuses from its own loadout', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="Header_actionName_abc123">Egg</div>';
        actionTimeDisplay.displayElement = null;
        actionTimeDisplay.profitElement = null;
        actionTimeDisplay.runElement = null;
        actionTimeDisplay.actionNameObserver = null;
        actionTimeDisplay.updateActionBarProfit = () => {};
        actionTimeDisplay.updateRunSoFar = () => {};
        game.calls = [];
        game.action = {
            id: 7,
            actionHrid: FORAGE.hrid,
            hasMaxCount: true,
            maxCount: 100,
            currentCount: 0,
            ordinal: 0,
            isDone: false,
            characterLoadoutID: 0,
        };
    });

    test('a gathering tea slotted but not in the loadout context is not counted', () => {
        game.details = FORAGE;
        game.wornDrinks = [{ itemHrid: GATHERING_TEA }];
        game.loadoutDrinks = [];
        actionTimeDisplay.updateDisplay();
        // 3.6s → 1000 actions/hr, one egg each, no tea doubling
        expect(stats()).toContain('1000 actions/hr (1000 items/hr)');
    });

    test('a gathering tea in the loadout context is counted', () => {
        game.details = FORAGE;
        game.wornDrinks = [];
        game.loadoutDrinks = [{ itemHrid: GATHERING_TEA }];
        actionTimeDisplay.updateDisplay();
        expect(stats()).toContain('(2000 items/hr)');
    });

    test('Gourmet comes from the loadout context too', () => {
        document.body.innerHTML = '<div class="Header_actionName_abc123">Donut</div>';
        game.details = COOK;
        game.action.actionHrid = COOK.hrid;
        game.wornDrinks = [{ itemHrid: GOURMET_TEA }];
        game.loadoutDrinks = [];
        actionTimeDisplay.updateDisplay();
        expect(stats()).toContain('(1000 items/hr)');
    });

    test('speed and efficiency get the same context', () => {
        game.details = FORAGE;
        game.loadoutDrinks = [{ itemHrid: GATHERING_TEA }];
        actionTimeDisplay.updateDisplay();
        expect(game.calls.at(-1)?.drinks).toEqual(game.loadoutDrinks);
    });
});
