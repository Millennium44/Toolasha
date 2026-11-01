/**
 * The quick-input panel must size its speed and efficiency from one atomic equipment+drinks
 * context (the saved loadout when one applies), not worn gear mixed with saved-loadout drinks.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    calculateActionStats: vi.fn(),
    resolveActionContext: vi.fn(),
    getEquipment: vi.fn(),
    getActionDrinkSlots: vi.fn(),
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));
vi.mock('../../utils/action-calculator.js', () => ({ calculateActionStats: mocks.calculateActionStats }));
vi.mock('../../utils/action-context.js', () => {
    const mod = { resolveActionContext: mocks.resolveActionContext };
    return { ...mod, resolveLoadoutContext: (actionTypeHrid) => mod.resolveActionContext(actionTypeHrid) };
});
vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async () => false), set: vi.fn() },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getEquipment: mocks.getEquipment,
        getSkills: () => [],
        getActionDrinkSlots: mocks.getActionDrinkSlots,
        getInventory: () => [],
        characterData: {},
        on: () => () => {},
        off: () => {},
    },
}));

import quickInputButtons from './quick-input-buttons.js';

const loadoutEquipment = new Map([['/item_locations/back', { itemHrid: '/items/gatherer_cape' }]]);
const loadoutDrinks = [{ itemHrid: '/items/efficiency_tea' }];

describe('QuickInputButtons uses the resolved action context', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getEquipment.mockReturnValue(new Map());
        mocks.getActionDrinkSlots.mockReturnValue([]);
        mocks.resolveActionContext.mockReturnValue({ equipment: loadoutEquipment, drinks: loadoutDrinks });
        mocks.calculateActionStats.mockReturnValue({ actionTime: 10, totalEfficiency: 0 });
    });

    test('calculateActionMetrics passes the resolved context, not worn gear', () => {
        quickInputButtons.calculateActionMetrics({ hrid: '/actions/foraging/x', type: '/action_types/foraging' }, {});

        expect(mocks.resolveActionContext).toHaveBeenCalledWith('/action_types/foraging');
        const options = mocks.calculateActionStats.mock.calls[0][1];
        expect(options.equipment).toBe(loadoutEquipment);
        expect(options.actionContext.drinks).toBe(loadoutDrinks);
        expect(mocks.getEquipment).not.toHaveBeenCalled();
    });

    test('an explicit context is used as given', () => {
        const context = { equipment: new Map(), drinks: [] };

        quickInputButtons.calculateActionMetrics({ hrid: '/actions/a', type: '/action_types/foraging' }, {}, context);

        expect(mocks.resolveActionContext).not.toHaveBeenCalled();
        expect(mocks.calculateActionStats.mock.calls[0][1].actionContext).toBe(context);
    });

    test('speed breakdown tea lookup uses the supplied drinks, not current slots', () => {
        mocks.getActionDrinkSlots.mockReturnValue([{ itemHrid: '/items/enhancing_tea' }]);

        const result = quickInputButtons.getConsumableSpeed({ type: '/action_types/enhancing' }, new Map(), {}, []);

        expect(result).toEqual([]);
        expect(mocks.getActionDrinkSlots).not.toHaveBeenCalled();
    });
});
