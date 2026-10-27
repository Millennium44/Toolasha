/**
 * The action bar's time for a counted run (a craft queued for N) is the time the inputs can
 * actually pay for, like every queue row. It used to read the full request, so a run asking
 * for 500 with inputs for 40 showed the time for 500 in the bar while the queue panel's line
 * for the same running action showed 40.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const CHEESE = '/items/cheese';
const MILK = '/items/milk';
const ACTION_HRID = '/actions/cheesesmithing/cheese';

const game = vi.hoisted(() => ({ inventory: [], action: null }));

vi.mock('../../core/data-manager.js', () => {
    const details = {
        hrid: '/actions/cheesesmithing/cheese',
        name: 'Cheese',
        type: '/action_types/cheesesmithing',
        coinCost: 0,
        inputItems: [{ itemHrid: '/items/milk', count: 2 }],
        outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
    };
    return {
        default: {
            getItemDetails: (hrid) => ({ hrid, name: hrid === '/items/cheese' ? 'Cheese' : 'Milk' }),
            getInventory: () => game.inventory,
            getInitClientData: () => ({ itemDetailMap: {} }),
            getActionDrinkSlots: () => [],
            getActionDetails: () => details,
            getCurrentActions: () => [game.action],
            getEquipment: () => new Map(),
            getSkills: () => [],
            getElapsedSecondsInCurrentUnit: () => 0,
            getIsCharacterSwitching: () => false,
            on: () => () => {},
        },
    };
});

vi.mock('../../core/config.js', () => ({
    default: {
        characterSettingsLoaded: true,
        getSetting: (key) => key === 'actionBar_showTimeRemaining' || key === 'actionBar_showQueueCount',
        getSettingValue: (key, fallback) => (key === 'actionBar_showTimeRemaining' ? 'relative' : fallback),
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 10, totalEfficiency: 0 }),
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
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

const stack = (itemHrid, count) => ({
    itemHrid,
    count,
    enhancementLevel: 0,
    itemLocationHrid: '/item_locations/inventory',
});

describe('the action bar time for a counted run', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="Header_actionName_abc123">Cheese (100)</div>';
        actionTimeDisplay.displayElement = null;
        actionTimeDisplay.profitElement = null;
        actionTimeDisplay.runElement = null;
        actionTimeDisplay.actionNameObserver = null;
        actionTimeDisplay.updateActionBarProfit = () => {};
        game.action = {
            id: 7,
            actionHrid: ACTION_HRID,
            hasMaxCount: true,
            maxCount: 500,
            currentCount: 0,
            ordinal: 0,
            isDone: false,
        };
    });

    test('is capped at what the inputs pay for', () => {
        // Milk for 40 crafts (2 per craft), 10s each: 400s, not the 5000s the request implies
        game.inventory = [stack(MILK, 80)];
        actionTimeDisplay.updateDisplay();

        expect(actionTimeDisplay.displayElement.textContent).toContain('6m 40s');
    });

    test('is the full request when the inputs cover it', () => {
        game.inventory = [stack(MILK, 100000)];
        actionTimeDisplay.updateDisplay();

        expect(actionTimeDisplay.displayElement.textContent).toContain('1h 23m');
    });

    test('shows no time when the inputs cover nothing', () => {
        game.inventory = [stack(CHEESE, 5)];
        actionTimeDisplay.updateDisplay();

        expect(actionTimeDisplay.displayElement.textContent).not.toMatch(/\d+[smh]/);
    });
});
