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
    saved: [],
    watched: [],
    store: new Map(),
    /** Whether the page was left with the panel up, and what it recorded since */
    wasOpen: false,
    openCalls: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSettingValue: (_key, fallback) => fallback,
        getPricingModeLabel: () => 'Hybrid',
    },
}));

// An in-memory stand-in rather than a stub returning the default, so a snapshot
// written by one call is there for the next one to read
vi.mock('../../core/storage.js', () => {
    const keyOf = (key, store) => `${store}:${key}`;
    return {
        default: {
            get: async (key, store, fallback) => {
                const value = mocks.store.get(keyOf(key, store));
                return value === undefined ? fallback : value;
            },
            set: async (key, value, store) => {
                mocks.store.set(keyOf(key, store), value);
                return true;
            },
            getJSON: async (key, store, fallback) => {
                const value = mocks.store.get(keyOf(key, store));
                return value === undefined ? fallback : value;
            },
            setJSON: async (key, value, store) => {
                mocks.store.set(keyOf(key, store), value);
                return true;
            },
        },
    };
});

// The two handoff targets are module-scope panels of their own; this file is
// about what the sim panel hands them, not about their storage or their DOM
vi.mock('../inventory/equipment-savings-row.js', () => ({
    watchTarget: (itemHrid, enhancementLevel) => mocks.saved.push({ itemHrid, enhancementLevel }),
}));

vi.mock('../inventory/watchlist.js', () => ({
    watchItem: (itemHrid) => mocks.watched.push({ itemHrid }),
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

// Geometry lives in IndexedDB and is never what these tests are about — the
// open flag beside it is, so that one records what it is told
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    saveOpenState: async (panelKey, open) => {
        mocks.openCalls.push({ panelKey, open });
    },
    wasOpen: async () => mocks.wasOpen,
    reopenIfLeftOpen: async (panelKey, reopen) => {
        if (mocks.wasOpen) reopen();
    },
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

const {
    default: ui,
    planUpgradeBudget,
    columnMenuLabel,
    upgradeRowKey,
    UPGRADE_PLAN_METRICS,
    gearFingerprint,
    buildAllZonesSnapshot,
    saveAllZonesSnapshot,
    loadAllZonesSnapshot,
    upgradeRowPurchase,
    upgradeRowActionsHtml,
    wireUpgradeRowActions,
    upgradeCostCell,
    costSourceTagHtml,
    upgradeNoiseFor,
    upgradeRowNotesHtml,
} = await import('./combat-sim-ui.js');

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
        mocks.wasOpen = false;
        mocks.openCalls = [];
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        vi.restoreAllMocks();
    });

    test('a panel left open comes back up on the next load', async () => {
        // Reverses an earlier choice not to remember: a refresh mid-analysis
        // used to lose the panel, and a panel you left open is one you were
        // using. Rebuilt here because the restore happens as the panel is built.
        ui.destroy();
        mocks.wasOpen = true;
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.display).toBe('flex');
        // Restoring a panel is not itself an opening worth recording
        expect(mocks.openCalls).toEqual([]);
    });

    test('a panel left closed stays closed, and the toggle is what gets recorded', async () => {
        await Promise.resolve();
        expect(ui.panel.style.display).toBe('none');

        ui.toggle();
        ui.toggle();

        expect(mocks.openCalls).toEqual([
            { panelKey: 'combatSimPanel', open: true },
            { panelKey: 'combatSimPanel', open: false },
        ]);
    });

    test('the close button remembers the closing too', async () => {
        ui.toggle();
        mocks.openCalls = [];
        ui.panel.querySelector('#mwi-csim-close').dispatchEvent(new window.Event('click', { bubbles: true }));

        expect(ui.panel.style.display).toBe('none');
        expect(mocks.openCalls).toEqual([{ panelKey: 'combatSimPanel', open: false }]);
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

    test('an open detail row stays open when a header re-sorts the table', () => {
        const rows = [
            row('Cheap ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 }),
            row('Pricey neck', { slot: '/equipment_types/neck', cost: 1000, profitGain: 60 }),
        ];
        ui._renderUpgradeResults({ baseline: BASELINE, results: rows, food: null });

        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
        const named = (name) =>
            [...container.querySelectorAll('[data-upgrade-row]')].find((tr) => tr.textContent.includes(name));
        const detailFor = (name) => {
            const key = named(name).getAttribute('data-row-key');
            return [...container.querySelectorAll('[data-upgrade-detail]')].find(
                (tr) => tr.getAttribute('data-row-key') === key
            );
        };

        named('Cheap ring').click();
        expect(detailFor('Cheap ring').style.display).toBe('table-row');
        const indexBefore = named('Cheap ring').getAttribute('data-upgrade-row');

        // Sort by name, then flip it, so the ring genuinely changes position —
        // an index-keyed expansion would follow the position, not the candidate
        const header = container.querySelector('[data-sort-key="upgrade"]');
        header.click();
        ui.panel.querySelector('#mwi-csim-upgrade-results').querySelector('[data-sort-key="upgrade"]').click();

        expect(named('Cheap ring').getAttribute('data-upgrade-row')).not.toBe(indexBefore);
        expect(detailFor('Cheap ring').style.display).toBe('table-row');
        expect(detailFor('Pricey neck').style.display).toBe('none');
    });

    test('a candidate key survives a sort, and does not collide between candidates', () => {
        const ring = row('Cheap ring', { slot: '/equipment_types/ring' });
        const neck = row('Pricey neck', { slot: '/equipment_types/neck' });

        expect(upgradeRowKey(ring)).toBe(upgradeRowKey({ ...ring, cost: 999 }));
        expect(upgradeRowKey(ring)).not.toBe(upgradeRowKey(neck));
    });

    test('a re-render puts the scroll position back rather than jumping to the top', () => {
        const rows = [
            row('Cheap ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 }),
            row('Pricey neck', { slot: '/equipment_types/neck', cost: 1000, profitGain: 60 }),
        ];
        ui._renderUpgradeResults({ baseline: BASELINE, results: rows, food: null });

        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');

        // happy-dom keeps scrollTop across an innerHTML swap; a browser does not,
        // and without the browser's behaviour the assertion below would pass
        // whether or not anything restored it. So zero it the way a browser does.
        let scroll = 0;
        Object.defineProperty(container, 'scrollTop', {
            configurable: true,
            get: () => scroll,
            set: (value) => {
                scroll = value;
            },
        });
        let proto = Object.getPrototypeOf(container);
        while (proto && !Object.getOwnPropertyDescriptor(proto, 'innerHTML')) proto = Object.getPrototypeOf(proto);
        const inner = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
        Object.defineProperty(container, 'innerHTML', {
            configurable: true,
            get() {
                return inner.get.call(this);
            },
            set(value) {
                inner.set.call(this, value);
                scroll = 0;
            },
        });

        container.scrollTop = 240;
        container.querySelector('[data-sort-key="upgrade"]').click();

        expect(container.scrollTop).toBe(240);
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

    describe('rows that could not be priced', () => {
        test('get their own box instead of sinking below the regressions', () => {
            const rows = [
                row('Priced ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 }),
                { ...row('Community EXP buff Lv4 → Lv5', { cost: null, type: 'community_buff' }), cost: null },
            ];
            ui._renderUpgradeResults({ baseline: BASELINE, results: rows, food: null });

            const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
            expect(container.textContent).toContain('Measured, but not priced');
            // The main table holds the priced row only
            const mainRows = [...container.querySelectorAll('[data-upgrade-row]')].map((r) => r.textContent);
            expect(mainRows.join(' ')).toContain('Priced ring');
            expect(mainRows.join(' ')).not.toContain('Community EXP');

            const unpriced = [...container.querySelectorAll('[data-unpriced-row]')].map((r) => r.textContent);
            expect(unpriced.join(' ')).toContain('Community EXP');
        });

        test('and the box does not appear at all when everything has a price', () => {
            ui._renderUpgradeResults({
                baseline: BASELINE,
                results: [row('Priced ring', { slot: '/equipment_types/ring' })],
                food: null,
            });

            const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
            expect(container.textContent).not.toContain('Measured, but not priced');
        });

        test('an unpriced row still expands to the metric detail it did measure', () => {
            const rows = [{ ...row('Community EXP buff', { type: 'community_buff' }), cost: null }];
            ui._renderUpgradeResults({ baseline: BASELINE, results: rows, food: null });

            const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
            const rowEl = container.querySelector('[data-unpriced-row]');
            const detail = container.querySelector('[data-unpriced-detail]');
            expect(detail.style.display).toBe('none');

            rowEl.click();

            expect(detail.style.display).toBe('table-row');
            expect(detail.textContent).toContain('Baseline:');
        });
    });
});

describe('gearFingerprint', () => {
    const dto = (equipment, hrid = 'player1') => ({ hrid, equipment });

    test('the same loadout signs the same however the slots are ordered', () => {
        const a = dto({
            '/equipment_types/body': { hrid: '/items/plate', enhancementLevel: 5 },
            '/equipment_types/head': { hrid: '/items/helm', enhancementLevel: 0 },
        });
        const b = dto({
            '/equipment_types/head': { hrid: '/items/helm', enhancementLevel: 0 },
            '/equipment_types/body': { hrid: '/items/plate', enhancementLevel: 5 },
        });

        expect(gearFingerprint([a])).toBe(gearFingerprint([b]));
    });

    test('an enhancement level is part of the gear', () => {
        const at = (level) => dto({ '/equipment_types/body': { hrid: '/items/plate', enhancementLevel: level } });
        expect(gearFingerprint([at(5)])).not.toBe(gearFingerprint([at(6)]));
    });

    test('losing a party member changes what the run describes', () => {
        const solo = dto({ '/equipment_types/body': { hrid: '/items/plate', enhancementLevel: 0 } });
        const mate = dto({ '/equipment_types/body': { hrid: '/items/robe', enhancementLevel: 0 } }, 'player2');

        expect(gearFingerprint([solo, mate])).not.toBe(gearFingerprint([solo]));
    });

    test('nothing to sign is null rather than a signature of nothing', () => {
        expect(gearFingerprint([])).toBeNull();
        expect(gearFingerprint(null)).toBeNull();
    });
});

describe('all-zones snapshot', () => {
    const HOUR_NS = 3600 * 1e9;

    const zoneResult = (name, { tier = 0, profit = 100, xp = 50, hours = 2 } = {}) => ({
        zone: { zoneHrid: `/actions/combat/${name}`, name, difficultyTier: tier },
        simResult: {
            simulatedTime: hours * HOUR_NS,
            experienceGained: { player1: { attack: xp * hours, stamina: xp * hours } },
        },
        revenue: { netPerHour: profit },
    });

    beforeEach(() => {
        mocks.store.clear();
    });

    test('rates come off the simulator’s own clock, not the hours asked for', () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly', { xp: 50, hours: 2 })], { hours: 10 });

        expect(snapshot.zones).toHaveLength(1);
        // 100 XP in each of two skills, over the two hours actually simulated —
        // not over the ten the run was asked for
        expect(snapshot.zones[0].xpPerHour).toBeCloseTo(100);
        expect(snapshot.zones[0].profitPerHour).toBe(100);
    });

    test('round-trips through storage with its timestamp and fingerprint', async () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly'), zoneResult('Jungle', { tier: 2 })], {
            hours: 4,
            fingerprint: 'abc123',
            savedAt: 1700000000000,
        });

        expect(await saveAllZonesSnapshot(snapshot)).toBe(true);
        const loaded = await loadAllZonesSnapshot();

        expect(loaded.savedAt).toBe(1700000000000);
        expect(loaded.fingerprint).toBe('abc123');
        expect(loaded.zones.map((z) => z.zoneName)).toEqual(['Fly', 'Jungle']);
        expect(loaded.zones[1].difficultyTier).toBe(2);
    });

    test('a zone with no result is left out rather than stored as a zero', () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly'), null, { zone: { name: 'X' } }]);
        expect(snapshot.zones).toHaveLength(1);
    });

    test('nothing stored reads as nothing, not as an empty run', async () => {
        expect(await loadAllZonesSnapshot()).toBeNull();
    });
});

describe('upgrade row handoff', () => {
    const candidate = (overrides) => ({ candidate: { description: 'Something', ...overrides } });

    beforeEach(() => {
        mocks.saved.length = 0;
        mocks.watched.length = 0;
    });

    test('an equipment row buys the upgrade at its enhancement level', () => {
        const buy = upgradeRowPurchase(candidate({ upgradeHrid: '/items/plate', upgradeLevel: 7, type: 'tier' }));
        expect(buy).toMatchObject({ itemHrid: '/items/plate', enhancementLevel: 7, savable: true });
        expect(buy.name).toContain('+7');
    });

    test('an ability row buys the book, and cannot be saved for a slot', () => {
        const buy = upgradeRowPurchase(
            candidate({ upgradeHrid: '/abilities/fireball', upgradeLevel: 53, type: 'ability_level' })
        );
        expect(buy).toMatchObject({ itemHrid: '/items/fireball', enhancementLevel: 0, savable: false });
    });

    test('combat levels and house rooms buy nothing', () => {
        expect(upgradeRowPurchase(candidate({ type: 'combat_level', slot: 'attack' }))).toBeNull();
        expect(upgradeRowPurchase(candidate({ type: 'house', upgradeHrid: '/house_rooms/dairy_barn' }))).toBeNull();
        expect(upgradeRowPurchase(null)).toBeNull();
    });

    test('a row that buys nothing draws no buttons', () => {
        expect(upgradeRowActionsHtml(candidate({ type: 'combat_level' }))).toBe('');
    });

    test('the buttons add the item to savings and to the watchlist', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' })
        );
        wireUpgradeRowActions(container);

        container.querySelector('[data-buy-action="save"]').click();
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.saved).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 4 }]);
        expect(mocks.watched).toEqual([{ itemHrid: '/items/plate' }]);
    });

    test('clicking a button does not also unfold the row it sits in', () => {
        const row = document.createElement('div');
        let rowClicks = 0;
        row.addEventListener('click', () => {
            rowClicks++;
        });
        row.innerHTML = upgradeRowActionsHtml(candidate({ upgradeHrid: '/items/plate', type: 'tier' }));
        wireUpgradeRowActions(row);

        row.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.watched).toHaveLength(1);
        expect(rowClicks).toBe(0);
    });

    test('an ability row offers Watch only', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/abilities/fireball', upgradeLevel: 20, type: 'ability_swap' })
        );

        expect(container.querySelector('[data-buy-action="save"]')).toBeNull();
        expect(container.querySelector('[data-buy-action="watch"]')).toBeTruthy();
    });
});

describe('what the Cost cell is allowed to say', () => {
    test('a price is a price', () => {
        expect(upgradeCostCell({ cost: 1_000_000 }).text).toBe('1.0M');
        expect(upgradeCostCell({ cost: 1_000_000 }).color).toBe(null);
    });

    test('no price is a question mark, never a zero', () => {
        expect(upgradeCostCell({ cost: null }).text).toBe('?');
    });

    test('a swap that hands gold back reads as a credit, not as free', () => {
        const cell = upgradeCostCell({ cost: -40_000_000 });

        expect(cell.text).toBe('+40.0M');
        expect(cell.title).toContain('Pays for itself');
    });

    test('and costing nothing is its own state, distinct from both', () => {
        expect(upgradeCostCell({ cost: 0 }).text).toBe('free');
    });

    test('the basis tag names which kind of number it is', () => {
        expect(costSourceTagHtml('sim')).toContain('sim');
        expect(costSourceTagHtml('market')).toContain('mkt');
        expect(costSourceTagHtml(undefined)).toBe('');
    });
});

describe('the qualifiers a row carries', () => {
    const noisy = (over = {}) => ({
        candidate: { description: 'Thing', type: 'tier' },
        noise: { dps: 3, profit: 3 },
        significantBy: { dps: false, profit: false },
        ...over,
    });

    test('a delta inside the error is flagged rather than presented as a finding', () => {
        expect(upgradeRowNotesHtml(noisy())).toContain('within noise');
    });

    test('but a real gain on either axis is left alone', () => {
        expect(upgradeRowNotesHtml(noisy({ significantBy: { dps: true, profit: false } }))).not.toContain(
            'within noise'
        );
    });

    test('a swap of an ability you do not own says its price is a fresh book', () => {
        const html = upgradeRowNotesHtml({
            candidate: { description: 'Fireball → Ice Spear', type: 'ability_swap' },
            costDetail: { freshBook: true, ownedFromLevel: null, books: { books: 12.4, bookName: 'Ice Spear' } },
            significantBy: { dps: true, profit: true },
        });

        expect(html).toContain('fresh book');
        expect(html).toContain('13 Ice Spears');
    });

    test('and a swap of one you already own says which level it was costed from', () => {
        // The chip is the only place the reader finds out that a suspiciously
        // cheap swap is cheap because the book is already at Lv14
        const html = upgradeRowNotesHtml({
            candidate: { description: 'Fireball → Ice Spear', type: 'ability_swap' },
            costDetail: { freshBook: false, ownedFromLevel: 14, books: { books: 3.2, bookName: 'Ice Spear' } },
            significantBy: { dps: true, profit: true },
        });

        expect(html).toContain('from Lv14');
        expect(html).not.toContain('>fresh book<');
        expect(html).toContain('4 Ice Spears');
    });

    test('and a trinket says its gain is the on-task one', () => {
        const html = upgradeRowNotesHtml({
            candidate: { description: 'Task Badge → Task Crystal', type: 'tier', caveat: 'on task only' },
            significantBy: { dps: true, profit: true },
        });

        expect(html).toContain('on task');
    });

    test('a row with nothing to qualify says nothing', () => {
        expect(upgradeRowNotesHtml({ candidate: { description: 'Thing', type: 'tier' } })).toBe('');
    });
});

describe('which metric the budget planner has to believe', () => {
    /** A row whose DPS gain is real and whose profit gain is inside the noise */
    const mixed = (description, over = {}) => ({
        ...row(description, over),
        significantBy: { dps: true, profit: false, xp: true },
        significant: true,
    });

    test('shopping for profit skips a row whose profit gain is noise', () => {
        const plan = planUpgradeBudget([mixed('Ring', { profitGain: 50 })], 1000, {
            baseline: BASELINE,
            metricKey: 'profit',
        });

        expect(plan.picks).toHaveLength(0);
        expect(plan.skipped[0].reason).toContain('noise');
    });

    test('while shopping for DPS buys the same row, because that axis cleared', () => {
        const plan = planUpgradeBudget([mixed('Ring', { dps: 110 })], 1000, {
            baseline: BASELINE,
            metricKey: 'dps',
        });

        expect(plan.picks.map((p) => p.candidate.description)).toEqual(['Ring']);
    });

    test('a row from before significance existed is still planned around', () => {
        const plan = planUpgradeBudget([row('Ring', { profitGain: 50 })], 1000, {
            baseline: BASELINE,
            metricKey: 'profit',
        });

        expect(plan.picks).toHaveLength(1);
    });
});

describe('the noise a row reports for one metric', () => {
    test('reads the bar and the verdict off the row', () => {
        const read = upgradeNoiseFor({ noise: { dps: 2.5 }, significantBy: { dps: false } }, 'dps');

        expect(read).toEqual({ noisePct: 2.5, significant: false });
    });

    test('and a row that never measured it is believed rather than discarded', () => {
        expect(upgradeNoiseFor({}, 'dps')).toEqual({ noisePct: null, significant: true });
    });
});
