/** @vitest-environment happy-dom */

/**
 * The detailed production-profit panel must price the same upgrade stack as the action bar
 * and queue rows (`getProductionUpgradeLevel`): the enhancement level named in the queued
 * action's `primaryItemHash`. Without it the panel priced +0 and disagreed with them.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: { actionPanel_showProfitDetail: true } }));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_LOSS: '#f00',
        SCRIPT_COLOR_ALERT: '#ff0',
        getSetting: (key, fallback) => (key in settings.values ? settings.values[key] : (fallback ?? true)),
        getSettingValue: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
        getPricingModeDisplayLabel: (mode) => mode,
    },
}));

const game = vi.hoisted(() => ({ actions: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (actionHrid) => ({
            type: '/action_types/crafting',
            upgradeItemHrid: actionHrid.includes('upgrade') ? '/items/sword' : null,
        }),
        getCurrentActions: () => game.actions,
        getItemDetails: () => null,
        getInitClientData: () => null,
        setScrollSimulation: () => {},
        clearScrollSimulation: () => {},
        isBuffBeingSimulated: () => false,
    },
}));

const formatRunningActionProfitTextMock = vi.hoisted(() => vi.fn());
vi.mock('./unlimited-action-estimate.js', () => ({
    estimateUnlimitedAction: vi.fn(),
    formatUnlimitedProfitText: vi.fn(() => '∞'),
    formatRunningActionProfitText: formatRunningActionProfitTextMock,
}));

const calculateGatheringProfitMock = vi.hoisted(() => vi.fn());
const calculateProductionProfitMock = vi.hoisted(() => vi.fn());
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: calculateGatheringProfitMock }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: calculateProductionProfitMock }));

vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
    scrollSimulator: () => null,
}));
vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => [] },
}));
vi.mock('../../utils/market-data.js', () => ({
    isPriceOverridden: () => false,
    isPriceEstimated: () => false,
    getPriceAgeString: () => '',
}));
vi.mock('../../utils/calibration-badge.js', () => ({
    appendCalibrationBadge: () => {},
}));

const { displayProductionProfit } = await import('./profit-display.js');

const UPGRADE = '/actions/crafting/upgrade_sword';
const PLAIN = '/actions/crafting/plank';
const hash = (item, level) => `1::/item_locations/inventory::${item}::${level}`;

function profitData() {
    return {
        profitPerHour: 1000,
        profitPerAction: 10,
        profitPerDay: 24000,
        itemsPerHour: 100,
        itemHrid: '/items/plank',
        itemName: 'Plank',
        outputPrice: 12,
        priceAfterTax: 11,
        gourmetBonusItems: 0,
        gourmetBonus: 0,
        materialCostPerHour: 200,
        totalMaterialCost: 2,
        totalTeaCostPerHour: 0,
        actionsPerHour: 100,
        totalEfficiency: 0,
        levelEfficiency: 0,
        houseEfficiency: 0,
        teaEfficiency: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        communityEfficiency: 0,
        personalEfficiency: 0,
        achievementEfficiency: 0,
        artisanBonus: 0,
        efficiencyMultiplier: 1,
        materialCosts: [],
        teaCosts: [],
        bonusRevenue: { bonusDrops: [], hasMissingPrices: false },
        hasMissingPrices: false,
        pricingMode: 'hybrid',
    };
}

async function levelPassed(actionHrid) {
    calculateProductionProfitMock.mockResolvedValue(profitData());
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    await displayProductionProfit(panel, actionHrid, '.drop-table');
    return calculateProductionProfitMock.mock.calls[0][1]?.upgradeItemLevel;
}

describe('the production panel prices the queued upgrade stack', () => {
    afterEach(() => {
        game.actions = [];
        calculateProductionProfitMock.mockReset();
        document.body.innerHTML = '';
    });

    test('passes the enhancement level of the queued upgrade item', async () => {
        game.actions = [{ actionHrid: UPGRADE, ordinal: 1, isDone: false, primaryItemHash: hash('/items/sword', 5) }];
        expect(await levelPassed(UPGRADE)).toBe(5);
    });

    test('the copy the game runs first decides, not the first in the array', async () => {
        game.actions = [
            { actionHrid: UPGRADE, ordinal: 9, isDone: false, primaryItemHash: hash('/items/sword', 2) },
            { actionHrid: UPGRADE, ordinal: 3, isDone: false, primaryItemHash: hash('/items/sword', 7) },
        ];
        expect(await levelPassed(UPGRADE)).toBe(7);
    });

    test('a hash naming another item, or no queued copy, is the +0 stack', async () => {
        game.actions = [{ actionHrid: UPGRADE, ordinal: 1, isDone: false, primaryItemHash: hash('/items/other', 5) }];
        expect(await levelPassed(UPGRADE)).toBe(0);
        calculateProductionProfitMock.mockReset();
        game.actions = [];
        expect(await levelPassed(UPGRADE)).toBe(0);
    });

    test('an action without an upgrade item never gets a level', async () => {
        game.actions = [{ actionHrid: PLAIN, ordinal: 1, isDone: false, primaryItemHash: hash('/items/sword', 5) }];
        expect(await levelPassed(PLAIN)).toBe(0);
    });
});
