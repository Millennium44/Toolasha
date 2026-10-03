/** @vitest-environment happy-dom */

/**
 * Scroll chips inside the gathering profit section: a click saves the selection and
 * runs the same display again, with the new selection armed for the calculation.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    saved: {},
    armed: [],
    values: { actionPanel_showProfitDetail: true, simulateScrollEffects: true },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_LOSS: '#f00',
        SCRIPT_COLOR_ALERT: '#ff0',
        getSetting: (key, fallback) => (key in game.values ? game.values[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.values ? game.values[key] : fallback),
        getPricingModeDisplayLabel: (mode) => mode,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => ({ type: '/action_types/foraging' }),
        getCurrentCharacterId: () => 'char1',
        getInitClientData: () => ({
            personalBuffTypeDetailMap: {
                '/personal_buff_types/efficiency': {
                    hrid: '/personal_buff_types/efficiency',
                    usableInActionTypeMap: { '/action_types/foraging': true },
                    buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
                },
            },
        }),
        on: () => {},
        setScrollSimulation: (type, set) => game.armed.push([...set]),
        clearScrollSimulation: () => {},
        isBuffBeingSimulated: () => false,
    },
}));

const profitDataFor = (outputCount) => ({
    profitPerHour: 1000,
    profitPerAction: 10,
    profitPerDay: 24000,
    revenuePerHour: 1200,
    drinkCostPerHour: 0,
    drinkCosts: [],
    actionsPerHour: 100,
    baseOutputs: Array.from({ length: outputCount }, (_, i) => ({
        itemHrid: `/items/output_${i}`,
        name: `Output ${i}`,
        itemsPerHour: 10,
        dropRate: 1 / outputCount,
        priceEach: 100,
        revenuePerHour: 1000 / outputCount,
        missingPrice: false,
    })),
    gourmetBonuses: [],
    totalEfficiency: 0,
    efficiencyMultiplier: 1,
    speedBonus: 0,
    bonusRevenue: { bonusDrops: [], hasMissingPrices: false },
    gourmetBonus: 0,
    processingBonus: 0,
    processingRevenueBonus: 0,
    processingConversions: [],
    processingRevenueBonusPerAction: 0,
    gourmetRevenueBonus: 0,
    gourmetRevenueBonusPerAction: 0,
    gatheringQuantity: 0,
    hasMissingPrices: false,
    pricingMode: 'hybrid',
    details: {
        levelEfficiency: 0,
        houseEfficiency: 0,
        teaEfficiency: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        achievementEfficiency: 0,
        personalEfficiency: 0,
        communityBuffQuantity: 0,
        gatheringTeaBonus: 0,
        achievementGathering: 0,
        personalGathering: 0,
    },
});

const calculateGatheringProfitMock = vi.hoisted(() => vi.fn());
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: calculateGatheringProfitMock }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: vi.fn() }));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, store, fallback) => game.saved[key] ?? fallback,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => null,
    scrollSimulator: () => null,
}));
vi.mock('../../utils/market-data.js', () => ({
    isPriceOverridden: () => false,
    isPriceEstimated: () => false,
    getPriceAgeString: () => '',
}));
vi.mock('../../utils/calibration-badge.js', () => ({
    appendCalibrationBadge: () => {},
}));

const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const { displayGatheringProfit } = await import('./profit-display.js');

const EFF = '/buff_types/efficiency';

describe('scroll chips in the gathering profit section', () => {
    beforeEach(async () => {
        game.saved = {};
        game.armed = [];
        game.values = { actionPanel_showProfitDetail: true, simulateScrollEffects: true };
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.initialized = false;
        scrollSimulator.switchHandler = null;
        scrollSimulator.owner = null;
        await scrollSimulator.initialize();
        calculateGatheringProfitMock.mockResolvedValue(profitDataFor(1));
    });

    afterEach(() => {
        calculateGatheringProfitMock.mockReset();
        document.body.innerHTML = '';
    });

    function makePanel() {
        const panel = document.createElement('div');
        document.body.appendChild(panel);
        return panel;
    }

    test('draws the chips in the profit section, and none when the master toggle is off', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelectorAll('#mwi-foraging-profit .mwi-scroll-chips button[data-buff]')).toHaveLength(1);

        game.values.simulateScrollEffects = false;
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('.mwi-scroll-chips')).toBeNull();
        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
    });

    test('switching simulation on brings the chips into a panel that is already open', async () => {
        game.values.simulateScrollEffects = false;
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('.mwi-scroll-chips')).toBeNull();

        // What the setting's change handler sends
        game.values.simulateScrollEffects = true;
        document.dispatchEvent(
            new CustomEvent('toolasha:scroll-selection-changed', { detail: { key: null, setting: true } })
        );

        await vi.waitFor(() => expect(panel.querySelector('.mwi-scroll-chips')).toBeTruthy());
        expect(panel.querySelectorAll('#mwi-foraging-profit')).toHaveLength(1);
    });

    test('switching simulation off takes the chips out of an open panel', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('.mwi-scroll-chips')).toBeTruthy();

        game.values.simulateScrollEffects = false;
        document.dispatchEvent(
            new CustomEvent('toolasha:scroll-selection-changed', { detail: { key: null, setting: true } })
        );

        await vi.waitFor(() => expect(panel.querySelector('.mwi-scroll-chips')).toBeNull());
    });

    test('no chips when the profit section is hidden', async () => {
        game.values.actionPanel_showProfitDetail = false;
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');

        expect(panel.querySelector('.mwi-scroll-chips')).toBeNull();
    });

    test('a click saves, then recalculates with the scroll armed, in one fresh section', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        const callsBefore = calculateGatheringProfitMock.mock.calls.length;
        expect(game.armed.at(-1)).toEqual([]);

        panel.querySelector(`button[data-buff="${EFF}"]`).click();
        await vi.waitFor(() => expect(calculateGatheringProfitMock.mock.calls.length).toBe(callsBefore + 1));
        await vi.waitFor(() => expect(panel.querySelector(`button[data-buff="${EFF}"]`)?.dataset.on).toBe('true'));

        expect(game.armed.at(-1)).toEqual([EFF]);
        expect(panel.querySelectorAll('#mwi-foraging-profit')).toHaveLength(1);
        expect(panel.querySelectorAll('.mwi-scroll-chips')).toHaveLength(1);
    });

    test('re-rendering does not stack listeners: one click recalculates once', async () => {
        const panel = makePanel();
        for (let i = 0; i < 4; i++) {
            await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        }
        const callsBefore = calculateGatheringProfitMock.mock.calls.length;

        panel.querySelector(`button[data-buff="${EFF}"]`).click();
        await vi.waitFor(() => expect(calculateGatheringProfitMock.mock.calls.length).toBeGreaterThan(callsBefore));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calculateGatheringProfitMock.mock.calls.length).toBe(callsBefore + 1);
    });
});
