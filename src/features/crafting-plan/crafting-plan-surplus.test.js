import { describe, test, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
    },
}));

const { normalizePlannedSurplus } = await import('./crafting-plan-surplus.js');

const HIDE = '/items/cowhide';
const LEATHER = '/items/rough_leather';
const BOOTS = '/items/leather_boots';

/**
 * Boots <- 1 leather per craft; leather (2 per craft) <- 10 cowhide per craft. Invigoration-style bonus: the
 * mix over its outcomes is 25%, the no-proc outcome 10%.
 */
function buildPlan(leatherQuantity) {
    return {
        itemHrid: BOOTS,
        strategy: 'craft',
        quantity: leatherQuantity,
        actionHrid: '/actions/boots',
        actionsNeeded: leatherQuantity,
        outputCount: 1,
        children: [
            {
                itemHrid: LEATHER,
                itemName: 'Rough Leather',
                strategy: 'craft',
                quantity: leatherQuantity,
                actionHrid: '/actions/leather',
                actionsNeeded: Math.ceil(leatherQuantity / 2),
                outputCount: 2,
                craftInputMeta: { countPerAction: 1, artisanBonus: 0, noProcBonus: 0 },
                children: [
                    {
                        itemHrid: HIDE,
                        itemName: 'Cowhide',
                        strategy: 'buy',
                        quantity: 999,
                        unitCost: 10,
                        totalCost: 9990,
                        craftInputMeta: { countPerAction: 10, artisanBonus: 0.25, noProcBonus: 0.1 },
                        children: [],
                    },
                ],
            },
        ],
    };
}

describe('normalizePlannedSurplus', () => {
    beforeEach(() => {
        settings.values = {};
    });

    test('worst-case rounding sizes a crafted intermediate inputs with the no-proc bonus, as the plan does', () => {
        settings.values.actions_artisanMaterialMode = 'worst-case';
        // 5 leather at 2 per craft is 3 crafts; each craft bills ceil(10 x 0.9) = 9 hide, not ceil(10 x 0.75) = 8
        const normalized = normalizePlannedSurplus(buildPlan(5));
        const hide = normalized.children[0].children[0];
        expect(hide.quantity).toBe(27);
    });

    test('expected-value rounding keeps the mixed bonus', () => {
        // ceil(10 x 0.75 x 3) = 23
        const normalized = normalizePlannedSurplus(buildPlan(5));
        expect(normalized.children[0].children[0].quantity).toBe(23);
    });
});
