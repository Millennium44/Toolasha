/** @vitest-environment happy-dom */

/**
 * Combat Sim panel: the parts that are about state rather than arithmetic —
 * what survives a cancelled analysis, what the status line is allowed to say
 * while a run is in flight, and whether the budget planner's combat rows still
 * mean anything to a planner written for the labyrinth.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    upgradeResult: { baseline: null, results: [], food: null },
    onRun: null,
    zones: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSettingValue: (_key, fallback) => fallback,
        getPricingModeLabel: () => 'Hybrid',
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        set: async () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: () => null, getSkills: () => [] },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: () => ({ bid: 0, ask: 0 }) },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: { calculateExpectedValue: () => null },
}));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({ itemDetailMap: {} }),
    buildAllPlayerDTOs: async () => ({ players: [{ hrid: 'player1', equipment: {} }] }),
    getCombatZones: () => mocks.zones,
    getCurrentCombatZone: () => null,
    getCommunityBuffs: () => ({}),
    calculateExpectedDrops: () => new Map(),
    calculateDungeonKeyCosts: () => [],
    calculateSimRevenue: () => ({ netPerHour: 0, costPerHour: 0, revenuePerHour: 0 }),
    getZonesThatDropItem: () => [],
}));

vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: async () => ({}),
    runLabyrinthSimulation: async () => ({}),
    cancelSimulation: () => {},
    getMaxWorkers: () => 4,
    plannedWorkerCount: () => 1,
}));

// The upgrade advisor is kept real for `planWithinBudget`, which drags in the
// market and enhancement stack behind it — none of which this file is about
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: () => 0 }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({}) }));
vi.mock('../../utils/enhancement-calculator.js', () => ({ calculateEnhancement: () => ({}) }));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({}),
    getAutoDetectedParams: () => ({}),
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: () => 0,
    getProductionCost: () => 0,
}));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    calculateAbilityLevelUpCost: () => 0,
    explainAbilityLevelUpCost: () => null,
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: () => ({}) }));

vi.mock('./all-zones-runner.js', () => ({
    runAllZonesSimulation: async () => [],
    cancelAllZonesSimulation: () => {},
}));

vi.mock('./sim-editor.js', () => ({
    SimEditor: class {
        getEditedDTOs() {
            return null;
        }
        isInitialized() {
            return true;
        }
        initEditor() {}
        generateSimLabel() {
            return 'Current Gear';
        }
        reset() {}
    },
}));

vi.mock('./upgrade-advisor.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        runUpgradeAnalysis: async (...args) => {
            mocks.onRun?.(...args);
            return mocks.upgradeResult;
        },
    };
});

const { default: ui, planUpgradeBudget, columnMenuLabel, UPGRADE_PLAN_METRICS } = await import('./combat-sim-ui.js');

/** A result row shaped like the upgrade advisor's output. */
function row(description, { slot = '/equipment_types/body', cost = 100, profitGain = 0, dps = 100, type } = {}) {
    return {
        candidate: { description, slot, type, upgradeHrid: `/items/${description}`, cost },
        cost,
        metrics: { dps, xpPerHour: 1000, profitPerHour: 1000 + profitGain, deathsPerHour: 0, encountersPerHour: 10 },
        deltas: { dps: 1, xp: 0, profit: 1, deaths: 0, encounters: 0 },
        goldPer: { dps: cost, xp: Infinity, profit: cost, deaths: Infinity, encounters: Infinity },
        economics: { profitGainPerHour: profitGain, paybackHours: 1, repayHours: 1, roiAnnualPct: 1 },
    };
}

const BASELINE = { dps: 100, xpPerHour: 1000, profitPerHour: 1000, deathsPerHour: 0, encountersPerHour: 10 };

function text() {
    return ui.panel?.textContent || '';
}

/** Give the Upgrade tab the zone and candidate set it refuses to run without. */
function selectZone() {
    const zone = ui.panel.querySelector('#mwi-csim-zone');
    zone.innerHTML = '<option value="/zones/a">A</option>';
    zone.value = '/zones/a';
    ui.panel.querySelector('[data-upgrade-mode="equipment"]').checked = true;
}

describe('columnMenuLabel', () => {
    test('joins the qualifier on, so the five Gold/0.01% columns differ', () => {
        expect(columnMenuLabel({ label: 'Gold/0.01%', sub: 'DPS' })).toBe('Gold/0.01% DPS');
        expect(columnMenuLabel({ label: 'Gold/0.01%', sub: 'Profit' })).toBe('Gold/0.01% Profit');
    });

    test('leaves a column with no qualifier alone', () => {
        expect(columnMenuLabel({ label: 'Repay' })).toBe('Repay');
    });
});

describe('planUpgradeBudget', () => {
    test('buys what fits, best value first', () => {
        const rows = [
            row('Cheap ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 }),
            row('Pricey neck', { slot: '/equipment_types/neck', cost: 1000, profitGain: 60 }),
        ];
        const plan = planUpgradeBudget(rows, 500, { baseline: BASELINE });

        expect(plan.picks.map((p) => p.candidate.description)).toEqual(['Cheap ring']);
        expect(plan.totalCost).toBe(100);
        expect(plan.gainTotal).toBeCloseTo(50);
    });

    test('never buys two pieces for the same slot', () => {
        const rows = [
            row('Body A', { slot: '/equipment_types/body', cost: 100, profitGain: 40 }),
            row('Body B', { slot: '/equipment_types/body', cost: 100, profitGain: 60 }),
        ];
        const plan = planUpgradeBudget(rows, 1000, { baseline: BASELINE });

        expect(plan.picks).toHaveLength(1);
        expect(plan.picks[0].candidate.description).toBe('Body B');
        expect(plan.totalCost).toBe(100);
    });

    test('ignores upgrades that do not improve the chosen axis', () => {
        const rows = [row('No help', { cost: 100, profitGain: 0 })];
        expect(planUpgradeBudget(rows, 1000, { baseline: BASELINE }).picks).toHaveLength(0);
    });

    test('shops a different list for DPS than for profit', () => {
        const rows = [
            row('Damage ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 0, dps: 150 }),
            row('Gold neck', { slot: '/equipment_types/neck', cost: 100, profitGain: 50, dps: 100 }),
        ];
        const byProfit = planUpgradeBudget(rows, 100, { baseline: BASELINE, metricKey: 'profit' });
        const byDps = planUpgradeBudget(rows, 100, { baseline: BASELINE, metricKey: 'dps' });

        expect(byProfit.picks.map((p) => p.candidate.description)).toEqual(['Gold neck']);
        expect(byDps.picks.map((p) => p.candidate.description)).toEqual(['Damage ring']);
        expect(byDps.gainTotal).toBeCloseTo(50);
    });

    test('leaves combat levels out — they are not purchases', () => {
        const rows = [
            row('Attack +5', { type: 'combat_level', cost: 0, profitGain: 500, slot: 'attack' }),
            row('Ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 10 }),
        ];
        const plan = planUpgradeBudget(rows, 1000, { baseline: BASELINE });
        expect(plan.picks.map((p) => p.candidate.description)).toEqual(['Ring']);
    });

    test('an unreadable budget plans nothing rather than throwing', () => {
        const plan = planUpgradeBudget([row('Ring')], NaN, { baseline: BASELINE });
        expect(plan.picks).toHaveLength(0);
    });

    test('every offered axis knows how to read a gain and say it', () => {
        for (const metric of UPGRADE_PLAN_METRICS) {
            const gain = metric.gain(row('X', { profitGain: 5, dps: 105 }), BASELINE);
            expect(Number.isFinite(gain)).toBe(true);
            expect(typeof metric.format(gain)).toBe('string');
        }
    });
});

describe('the panel', () => {
    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onRun = null;
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        vi.restoreAllMocks();
    });

    test('keeps the progress bar and Stop outside the tab bodies', () => {
        const progress = ui.panel.querySelector('#mwi-csim-progress-container');
        const resultsContent = ui.panel.querySelector('#mwi-csim-results-content');

        expect(progress.parentElement).toBe(ui.panel);
        expect(resultsContent.contains(progress)).toBe(false);
        expect(progress.querySelector('#mwi-csim-stop')).toBeTruthy();
    });

    test('a tab switch mid-run does not overwrite the running status', () => {
        ui.isRunning = true;
        ui._setStatus('Simulating (Solo)... 3.0s');
        ui._switchTab('configure');
        expect(text()).toContain('Simulating (Solo)... 3.0s');

        ui.isRunning = false;
        ui._switchTab('configure');
        expect(text()).toContain('Select a zone and click Simulate.');
    });

    test('a tab switch mid-analysis does not overwrite it either', () => {
        ui._upgradeRunning = true;
        ui._setStatus('Simulating 40 upgrades');
        ui._switchTab('seek');
        expect(text()).toContain('Simulating 40 upgrades');
        ui._upgradeRunning = false;
    });

    test('a cancelled analysis still shows the candidates that finished', async () => {
        mocks.upgradeResult = {
            baseline: BASELINE,
            results: [row('Cheap ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 })],
            food: null,
        };
        selectZone();
        // Stop, pressed while the analysis is in flight — the real button, so
        // this is also the wiring that sets the abort flag
        mocks.onRun = () => ui.panel.querySelector('#mwi-csim-upgrade-stop').click();

        await ui._onUpgradeAnalyze();

        expect(text()).toContain('Analysis cancelled — showing 1 completed candidate.');
        expect(ui.panel.querySelector('#mwi-csim-upgrade-results').textContent).toContain('Cheap ring');
        expect(ui._upgradeRunning).toBe(false);
    });

    test('a cancelled analysis with nothing finished says only that', async () => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        selectZone();
        mocks.onRun = () => ui.panel.querySelector('#mwi-csim-upgrade-stop').click();

        await ui._onUpgradeAnalyze();

        expect(text()).toContain('Analysis cancelled.');
    });

    test('upgrade results carry a budget planner, a CSV export and legible column names', () => {
        const rows = [
            row('Cheap ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 }),
            row('Pricey neck', { slot: '/equipment_types/neck', cost: 1000, profitGain: 60 }),
        ];
        ui._upgradeBudgetText = '500';
        ui._upgradeBudget = 500;
        ui._upgradeColumnMenuOpen = true;
        ui._renderUpgradeResults({ baseline: BASELINE, results: rows, food: null });

        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
        expect(container.querySelector('#mwi-csim-budget-input')?.value).toBe('500');
        expect(container.querySelector('[data-csv-export]')).toBeTruthy();
        // The plan fits the ring and not the necklace
        const plan = container.querySelector('#mwi-csim-upgrade-budget').textContent;
        expect(plan).toContain('Cheap ring');
        expect(plan).not.toContain('Pricey neck');

        const menu = container.querySelector('#mwi-csim-upgrade-cols-menu').textContent;
        expect(menu).toContain('Gold/0.01% DPS');
        expect(menu).toContain('Gold/0.01% Profit');
        expect(menu).toContain('Gold/0.01% DPH');

        ui._upgradeBudgetText = '';
        ui._upgradeBudget = 0;
        ui._upgradeColumnMenuOpen = false;
    });

    test('a re-render replaces the export bar rather than stacking them', () => {
        const results = { baseline: BASELINE, results: [row('Ring', { slot: '/equipment_types/ring' })], food: null };
        ui._renderUpgradeResults(results);
        ui._renderUpgradeResults(results);

        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
        expect(container.querySelectorAll('[data-csv-export]')).toHaveLength(1);
    });

    test('the seek table exports the zone and tier as their own columns', () => {
        const rows = [
            {
                zone: { name: 'Smelly Planet', difficultyTier: 2 },
                itemsPerHour: 1.5,
                profitPerHour: 200,
                costPerHour: 10,
                costPerDrop: 6.6,
            },
        ];
        const saved = [];
        ui._wireCsvButton = ((original) => (button, stem, build) => {
            saved.push({ stem, build });
            return original.call(ui, button, stem, build);
        })(ui._wireCsvButton);

        ui._displaySeekResults(rows, 'Sulfur');

        const seek = saved.find((entry) => entry.stem === 'combatsim-seek');
        expect(seek).toBeTruthy();
        expect(seek.build().rows[0]).toMatchObject({ zone: 'Smelly Planet', tier: 2, itemsPerHour: 1.5 });
        delete ui._wireCsvButton;
    });
});
