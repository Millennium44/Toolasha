/** @vitest-environment happy-dom */

/**
 * The gathering profit section and the scroll selection. The chips are their own row on the panel
 * (scroll-chips-panel.js), not part of this section: the section draws none, and redraws with the
 * new selection armed whenever the selection changes, whether or not the section drew any chips.
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
        // True for what the last call to setScrollSimulation armed, as the real data manager does
        isBuffBeingSimulated: (type, buff) => (game.armed.at(-1) ?? []).includes(buff),
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
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
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

describe('the gathering profit section follows the scroll selection', () => {
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

    test('draws no chips of its own, with simulation on or off', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
        expect(panel.querySelector('.mwi-scroll-chips')).toBeNull();

        game.values.simulateScrollEffects = false;
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('.mwi-scroll-chips')).toBeNull();
        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
    });

    test('with simulation on and nothing selected, nothing is armed: the figures are the real ones', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');

        expect(game.armed.at(-1)).toEqual([]);
    });

    test('a selection saved elsewhere (a chip, the Loadouts popup) recalculates with it armed, in one fresh section', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        const callsBefore = calculateGatheringProfitMock.mock.calls.length;

        await scrollSimulator.saveScrollsForLoadout(null, [EFF]);
        await vi.waitFor(() => expect(calculateGatheringProfitMock.mock.calls.length).toBe(callsBefore + 1));

        expect(game.armed.at(-1)).toEqual([EFF]);
        expect(panel.querySelectorAll('#mwi-foraging-profit')).toHaveLength(1);
    });

    test('switching simulation off redraws the section with nothing armed', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, [EFF]);
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(game.armed.at(-1)).toEqual([EFF]);
        const callsBefore = calculateGatheringProfitMock.mock.calls.length;

        game.values.simulateScrollEffects = false;
        document.dispatchEvent(
            new CustomEvent('toolasha:scroll-selection-changed', { detail: { key: null, setting: true } })
        );

        await vi.waitFor(() => expect(calculateGatheringProfitMock.mock.calls.length).toBe(callsBefore + 1));
        expect(game.armed.at(-1)).toEqual([]);
    });

    test('a panel with no Repeat box and a saved selection says in the section that the profit is simulated', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, [EFF]);
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');

        const note = panel.querySelector('#mwi-foraging-profit .mwi-scroll-simulated-note');
        expect(note.textContent).toBe('Simulated, not active: Efficiency scroll');
        // Shown with the section collapsed: it is a sibling of the header, not inside the hidden content
        expect(note.closest('.mwi-section-content')).toBeNull();
        expect(panel.querySelector('#mwi-foraging-profit .mwi-section-content').contains(note)).toBe(false);
    });

    test('no note with nothing selected, or with simulation off', async () => {
        const panel = makePanel();
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('.mwi-scroll-simulated-note')).toBeNull();

        await scrollSimulator.saveScrollsForLoadout(null, [EFF]);
        game.values.simulateScrollEffects = false;
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('.mwi-scroll-simulated-note')).toBeNull();
    });

    test('the note goes when the selection is cleared, and is never stacked by redraws', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, [EFF]);
        const panel = makePanel();
        for (let i = 0; i < 3; i++) await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelectorAll('.mwi-scroll-simulated-note')).toHaveLength(1);

        await scrollSimulator.saveScrollsForLoadout(null, []);
        await vi.waitFor(() => expect(panel.querySelector('.mwi-scroll-simulated-note')).toBeNull());
    });

    test('the profit section goes after the chips row when the row sits in the run of sections', async () => {
        const panel = makePanel();
        const level = document.createElement('div');
        level.className = 'mwi-collapsible-section';
        const chips = document.createElement('div');
        chips.className = 'mwi-scroll-chips';
        panel.append(level, chips);

        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');

        expect(chips.nextElementSibling?.id).toBe('mwi-foraging-profit');
    });

    test('re-rendering does not stack listeners: one selection change recalculates once', async () => {
        const panel = makePanel();
        for (let i = 0; i < 4; i++) {
            await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        }
        const callsBefore = calculateGatheringProfitMock.mock.calls.length;

        await scrollSimulator.saveScrollsForLoadout(null, [EFF]);
        await vi.waitFor(() => expect(calculateGatheringProfitMock.mock.calls.length).toBeGreaterThan(callsBefore));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calculateGatheringProfitMock.mock.calls.length).toBe(callsBefore + 1);
    });
});
