/** @vitest-environment happy-dom */

/**
 * Combat Sim panel: the parts that are about state rather than arithmetic —
 * what survives a cancelled analysis, what the status line is allowed to say
 * while a run is in flight, and whether the budget planner's combat rows still
 * mean anything to a planner written for the labyrinth.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readScoped } from '../../utils/character-key.js';

const mocks = vi.hoisted(() => ({
    upgradeResult: { baseline: null, results: [], food: null },
    onRun: null,
    /** What `confirmUpgradeBudgetPlan` resolves with; null means "not called yet" */
    confirmResult: { ok: true, metrics: {}, deltas: {}, economics: {}, noise: {}, totalCost: 0 },
    /** Called with (picks, context) whenever the "Confirm together" button runs the basket */
    onConfirm: null,
    zones: [],
    saved: [],
    watched: [],
    /** The price panel the bundle bridge answers with, null when the feature is off */
    bridgePricePanel: null,
    /** Pins the price panel was asked to seed, in order */
    seededTargets: [],
    /** Ability level goals handed to Equipment Savings */
    abilityGoals: [],
    /** Marketplace navigations a row asked for */
    marketOpened: [],
    /** Calls to `openCombatZoneAtTier`, in order — the ▶ buttons' only side effect */
    openZoneCalls: [],
    /** What `openCombatZoneAtTier` resolves with for the next call */
    openZoneResult: { opened: true, tierConfirmed: true, filled: false },
    /** What the buy-modal autofill manager was told, in order */
    autofill: [],
    /** Observer ids the panel registered autofill managers under */
    autofillObservers: [],
    /** The armed quantity function, as a buy modal opening would resolve it */
    autofillPending: null,
    store: new Map(),
    /** Whether the page was left with the panel up, and what it recorded since */
    wasOpen: false,
    openCalls: [],
    // What show() asked the editor to do: build one, or bring an existing one
    // up to date with the game
    editorCalls: [],
    /** itemHrid → count, what a run is said to have dropped */
    drops: new Map(),
    /** itemHrid → { bid, ask }; anything absent is unlisted, as most things are */
    prices: {},
    /** The `getItemPrice` mock's profit pricing mode, mirroring `profitCalc_pricingMode` */
    pricingMode: 'hybrid',
    /** The `getItemPrice` mock's patient-tick switch, standing in for both per-side tick settings at once */
    patientTick: false,
    /** What `buildGameDataPayload` and `buildAllPlayerDTOs` hand the panel */
    gameData: { itemDetailMap: {} },
    playerDTOs: [{ hrid: 'player1', equipment: {} }],
    /** Optional delayed/failed profile read used by run-start lifecycle tests */
    buildPlayerDTOs: null,
    /** buffHrid → detail, what `getGuildBuffDetailMap` hands the shrine grid */
    guildBuffDetailMap: {},
    /** hrid → detail, what `dataManager.getInitClientData().houseRoomDetailMap` hands the house grid */
    houseRoomDetailMap: {},
    /** hrid → level, what `dataManager.getHouseRoomLevel` answers with (the live character's own) */
    houseRoomLevels: {},
    /** The params the last all-zones run was started with */
    allZonesArgs: null,
    /** What `runAllZonesSimulation` resolves with — one entry per selected zone/tier */
    allZonesResult: [],
    /** itemHrid → unit price, what `resolveItemPrice` answers with */
    itemPrices: {},
    /** The Bestiary as `getCharacterMonsters` hands it back; null until the tab has loaded it */
    monsters: null,
    /** Dungeon runs the bridge's run-history store answers with */
    dungeonRuns: [],
    /** What SimEditor#getEditedDTOs() hands back; null unless a test opts in */
    editedDTOs: null,
    /** What SimEditor#getSelfHrid() hands back */
    editorSelfHrid: null,
    /** What runSimulation() resolves with; null falls back to `{}` */
    simResult: null,
    simRuns: 0,
    allZonesRuns: 0,
    /** playerHrid each calculateSimRevenue() call was made with, in order */
    revenueCalls: [],
    /** How many upgrade-advisor runs and worker cancellations were requested */
    upgradeRuns: 0,
    cancelActiveCalls: 0,
    /** Who is logged in; a test moves it mid-run to stage a character switch */
    characterId: 'char1',
    /** Whether the House Upgrade target grid omits skilling-only rooms */
    skipSkillingRooms: false,
    settingChangeCallbacks: new Map(),
    /** The `getSettingValue` mock's `profitCalc_keyPricingMode`, for the pricing quick-settings row */
    keyPricingMode: 'ask',
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        // The pricing keys follow the `getItemPrice` mock's switches, so a cache stamped
        // on them sees the same change the prices do
        getSettingValue: (key, fallback) => {
            if (key === 'profitCalc_pricingMode') return mocks.pricingMode;
            if (key === 'profitCalc_patientTickBuy' || key === 'profitCalc_patientTickSell') return mocks.patientTick;
            if (key === 'profitCalc_keyPricingMode') return mocks.keyPricingMode;
            return fallback;
        },
        getSetting: (key, fallback = false) =>
            key === 'combatSim_upgradeSkipSkillingRooms' ? mocks.skipSkillingRooms : fallback,
        // Real `setSetting`/`setSettingValue` fire the registered change callback
        // synchronously; the pricing quick-settings row (and the dropdowns it is
        // built from) depend on that to resync themselves after their own write.
        setSetting: (key, value) => {
            if (key === 'profitCalc_patientTickBuy' || key === 'profitCalc_patientTickSell') mocks.patientTick = value;
            mocks.settingChangeCallbacks.get(key)?.(key, value);
        },
        setSettingValue: (key, value) => {
            if (key === 'profitCalc_pricingMode') mocks.pricingMode = value;
            if (key === 'profitCalc_keyPricingMode') mocks.keyPricingMode = value;
            mocks.settingChangeCallbacks.get(key)?.(key, value);
        },
        onSettingChange: (key, callback) => {
            mocks.settingChangeCallbacks.set(key, callback);
            return () => mocks.settingChangeCallbacks.delete(key);
        },
        onSettingsLoaded: () => () => {},
        getPricingModeLabel: () => 'Hybrid',
        getPricingModeDisplayLabel: () => 'Hybrid',
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
            delete: async (key, store) => {
                mocks.store.delete(keyOf(key, store));
                return true;
            },
            getAllKeys: async () => [],
        },
    };
});

// Ability goals live beside the gear targets in Equipment Savings; this file is
// about what the row hands over, not about how the goal is stored
vi.mock('../../utils/equipment-savings.js', () => ({
    addAbilityGoal: async (goal) => {
        mocks.abilityGoals.push(goal);
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (itemHrid, enhancementLevel) => mocks.marketOpened.push({ itemHrid, enhancementLevel }),
}));

// The ▶ buttons in the all-zones table and the Bestiary plan both call
// through this — what matters here is what they asked it to do, not the DOM
// dance inside it (that lives in `combat-zone-open.test.js`).
vi.mock('../../utils/combat-zone-open.js', () => ({
    openCombatZoneAtTier: (zoneHrid, tier, options) => {
        mocks.openZoneCalls.push({ zoneHrid, tier, options });
        return Promise.resolve(mocks.openZoneResult);
    },
}));

// The autofill manager watches the document for buy modals, which this file has
// none of. What matters is what the row arms it with, so the stub records that
// and answers `armedQuantity()` the way the real modal handler would.
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: (observerId) => {
        mocks.autofillObservers.push(observerId);
        return {
            initialize: () => mocks.autofill.push({ event: 'initialize' }),
            cleanup: () => {
                mocks.autofill.push({ event: 'cleanup' });
                mocks.autofillPending = null;
            },
            setQuantity: (quantity, options) => {
                mocks.autofill.push({ event: 'setQuantity', quantity, options });
                mocks.autofillPending = () => quantity;
            },
            setPendingCalculation: (fn, options) => {
                mocks.autofill.push({ event: 'setPendingCalculation', options });
                mocks.autofillPending = fn;
            },
            clearQuantity: () => {
                mocks.autofill.push({ event: 'clearQuantity' });
                mocks.autofillPending = null;
            },
        };
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getSkills: () => [],
        getCurrentCharacterId: () => mocks.characterId,
        getCurrentCharacterName: () => mocks.characterName ?? 'Me',
        getCurrentCharacterGameMode: () => 'standard',
        getLearnedAbilities: () => mocks.learned || [],
        getInitClientData: () => ({
            levelExperienceTable: Array.from({ length: 201 }, (_, level) => 1000 * level),
            houseRoomDetailMap: mocks.houseRoomDetailMap || {},
        }),
        // The live character's own house room level — used only as a display
        // fallback before any DTO has loaded; a loaded DTO (self, imported, or a
        // party member's) must never fall through to this for a room it lacks
        getHouseRoomLevel: (hrid) => mocks.houseRoomLevels?.[hrid] || 0,
        getCharacterMonsters: () => mocks.monsters,
        // Kept so a test can fire an event the panel listens for
        on: (event, handler) => {
            mocks.dataListeners = mocks.dataListeners || new Map();
            mocks.dataListeners.set(event, handler);
        },
        off: (event) => mocks.dataListeners?.delete(event),
    },
}));

// The missing-materials tabs live in another bundle; reached through the bridge
vi.mock('../../utils/bundle-bridge.js', () => ({
    expectedValueCalculator: () => null,
    missingMaterialsButton: () => mocks.bridgeMissingMats,
    dungeonTrackerStorage: () => ({ getAllRuns: async () => mocks.dungeonRuns }),
    marketHistoryPanel: () => mocks.bridgePricePanel,
    // The two handoff targets are module-scope panels of their own, and the sim
    // bundle reaches them only through the bridge — this file is about what the
    // sim panel hands over, not about their storage or their DOM
    marketWatchTarget: () => (itemHrid, enhancementLevel, quote) =>
        mocks.saved.push({ itemHrid, enhancementLevel, quote }),
    marketWatchItem: () => (itemHrid, name, enhancementLevel) => mocks.watched.push({ itemHrid, enhancementLevel }),
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => mocks.prices[hrid] || { bid: 0, ask: 0 } },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        calculateExpectedValue: () => null,
        getCachedValue: () => null,
        calculateSingleContainer: () => null,
    },
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
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => mocks.gameData,
    buildAllPlayerDTOs: async () =>
        mocks.buildPlayerDTOs
            ? mocks.buildPlayerDTOs()
            : { players: mocks.playerDTOs, playerInfo: [], selfHrid: 'player1', missingMembers: [] },
    getCombatZones: () => mocks.zones,
    getCurrentCombatZone: () => null,
    getCommunityBuffs: () => ({}),
    calculateExpectedDrops: () => mocks.drops,
    calculateDungeonKeyCosts: () => [],
    calculateSimRevenue: (simResult, gameData, playerHrid) => {
        mocks.revenueCalls.push(playerHrid);
        return { netPerHour: 0, costPerHour: 0, revenuePerHour: 0 };
    },
    // Faithful to the real one: coin untaxed, cowbell 18%, everything else the
    // 5% patch-live market rate the suite runs under
    taxedDropValue: (hrid, v) =>
        v > 0 && hrid !== '/items/coin' ? v * (1 - (hrid === '/items/bag_of_10_cowbells' ? 0.18 : 0.05)) : v,
    getZonesThatDropItem: () => [],
    getGuildBuffDetailMap: () => mocks.guildBuffDetailMap || {},
    guildBuffMaxLevel: (detail) => detail?.maxLevel ?? 20,
}));

vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: async () => {
        mocks.simRuns++;
        return mocks.simResult || {};
    },
    runLabyrinthSimulation: async () => ({}),
    cancelSimulation: () => {},
    cancelActiveSimulations: () => {
        mocks.cancelActiveCalls++;
    },
    getMaxWorkers: () => 4,
    plannedWorkerCount: () => 1,
}));

// The upgrade advisor is kept real for `planWithinBudget`, which drags in the
// market and enhancement stack behind it — none of which this file is about
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
// The real one returns `{ price, source }`; the food substitution reads `.price`
// off it, so the stub has to be that shape rather than a bare number
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: (hrid) => ({ price: mocks.itemPrices[hrid] ?? 0 }),
}));
// A minimal stand-in for the real pricing-mode/patient-tick resolution: reads
// straight off `mocks.prices` (which already stands in for marketAPI.getPrice)
// so the Results detail view's `_getSellPrice`/`_getBuyPrice` — which now route
// through this instead of mapping ask/bid themselves — keep working, and the
// tick tests below can flip `mocks.patientTick` to prove they honour it.
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: () => ({}),
    getItemPrice: (hrid, options = {}) => {
        const price = mocks.prices[hrid] || { bid: 0, ask: 0 };
        const side = options.side === 'buy' ? 'buy' : 'sell';
        let book;
        switch (mocks.pricingMode) {
            case 'conservative':
                book = side === 'buy' ? 'ask' : 'bid';
                break;
            case 'optimistic':
                book = side === 'buy' ? 'bid' : 'ask';
                break;
            case 'patientBuy':
                book = 'bid';
                break;
            default:
                book = 'ask';
        }
        const raw = price[book];
        if (!(raw > 0)) return null;
        // A buy priced at the bid moves up a tick, a sell priced at the ask
        // moves down one — the same patient leg `patientTickPrice` improves.
        const patientLeg = (side === 'buy' && book === 'bid') || (side === 'sell' && book === 'ask');
        if (mocks.patientTick && patientLeg) {
            return side === 'buy' ? raw + 1 : raw - 1;
        }
        return raw;
    },
}));
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
    // 1,000 XP a level, 500 XP a book — enough arithmetic for a book count
    explainAbilityLevelUpCost: (abilityHrid, level, xp, targetLevel) => ({
        books: (1000 * targetLevel - xp) / 500,
    }),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: () => ({}) }));

vi.mock('./all-zones-runner.js', () => ({
    runAllZonesSimulation: async (params) => {
        mocks.allZonesRuns++;
        mocks.allZonesArgs = params;
        if (params.onProgress) params.onProgress(100);
        return mocks.allZonesResult;
    },
    cancelAllZonesSimulation: () => {},
}));

/**
 * The market-volume cap, as a per-item throttle map. Its arithmetic is
 * utils/liquidity-cap.js's tested business; this file proves the wiring — the
 * zones table ranks and scores the *capped* Profit/day, draws the marker, and
 * the snapshot keeps the raw claim.
 */
const liquidity = vi.hoisted(() => ({ throttleByItem: {}, calls: [] }));

vi.mock('../../utils/liquidity-cap.js', () => ({
    // Synchronous, like the real cache-only variant — never starts a lookup,
    // so the wiring test can prove the table issues none of its own.
    capProfitRateCached: ({ goldPerHour, sells }) => {
        liquidity.calls.push({ type: 'cap', items: (sells || []).map((sold) => sold.itemHrid) });
        for (const sold of sells || []) {
            const throttle = liquidity.throttleByItem[sold.itemHrid];
            if (throttle !== undefined && throttle < 1) {
                return {
                    goldPerHour: goldPerHour * throttle,
                    capped: true,
                    limit: {
                        kind: 'volume',
                        note: 'limited by market volume (~1/week)',
                        detail: `${sold.name || sold.itemHrid} trades ~1/week, and you are not the only seller.`,
                        itemHrid: sold.itemHrid,
                        throttle,
                    },
                };
            }
        }
        return { goldPerHour, capped: false, limit: null };
    },
    liquidityMarkerHtml: (limit, { compact = false } = {}) =>
        limit ? `<span title="${limit.note} — ${limit.detail}">${compact ? 'vol-capped' : limit.note}</span>` : '',
}));

vi.mock('./sim-editor.js', () => ({
    SimEditor: class {
        getEditedDTOs() {
            return mocks.editedDTOs;
        }
        getSelfHrid() {
            return mocks.editorSelfHrid;
        }
        getPlayerInfo() {
            return mocks.editedDTOs ? Object.keys(mocks.editedDTOs).map((hrid) => ({ hrid, name: hrid })) : [];
        }
        getMissingMembers() {
            return [];
        }
        isInitialized() {
            return true;
        }
        initEditor() {
            mocks.editorCalls.push('init');
        }
        refreshFromGame() {
            mocks.editorCalls.push('refresh');
            return false;
        }
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
            mocks.upgradeRuns++;
            mocks.onRun?.(...args);
            return mocks.upgradeResult;
        },
        confirmUpgradeBudgetPlan: async (...args) => {
            mocks.onConfirm?.(...args);
            return mocks.confirmResult;
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
    abilityBookCount,
    cleanupUpgradeMarketAutofill,
    scoreDepthPlaces,
    scoreDepthLabel,
    scoreGradientColor,
    scorePlaces,
    metricPlaces,
    gradientLadders,
    SCORE_DEPTHS,
    DEFAULT_SCORE_DEPTH,
    SCORE_GRADIENT_PLACES,
    visibleAllZonesSkillColumns,
    scoreAllZoneRows,
    bestAllZoneRows,
    isSkillingGearItem,
    isAuraAbility,
    skillingGearWarnings,
    duplicateAuraWarnings,
    partyLintWarnings,
    runMatchesSimParty,
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

/**
 * A row shaped like the one the budget planner used to throw away.
 *
 * Taken from a real Upgrade tab: "Berserk Lv65 → Lv70", 140.6M of books, a
 * profit delta of four-tenths of a percent that the per-encounter error model
 * cannot possibly call significant. Everything about it is affordable, priced
 * and positive — and the plan for a 500M budget came back empty.
 *
 * @param {string} name - Ability name
 * @param {Object} over - `{ hrid, cost, profitGain, books, level }`
 * @returns {Object} A result row
 */
function abilityRow(name, { hrid, cost = 140_600_000, profitGain = 3_000_000, books = 40, level = 70 } = {}) {
    return {
        candidate: {
            description: `${name} Lv65 → Lv${level}`,
            type: 'ability_level',
            slot: 'ability_2',
            upgradeHrid: hrid,
            upgradeLevel: level,
        },
        cost,
        costSource: 'books',
        costDetail: { books: { books, bookName: name } },
        metrics: {
            dps: 100.4,
            xpPerHour: 1001,
            profitPerHour: 1000 + profitGain,
            deathsPerHour: 0,
            encountersPerHour: 10,
        },
        deltas: { dps: 0.4, xp: 0.1, profit: 0.41, deaths: 0, encounters: 0 },
        goldPer: { dps: cost, xp: Infinity, profit: 3_400_000, deaths: Infinity, encounters: Infinity },
        economics: { profitGainPerHour: profitGain, paybackHours: 47, repayHours: 47, roiAnnualPct: 180 },
        noise: { dps: 2.2, xp: 2.2, profit: 2.2, deaths: 40, encounters: 2.2 },
        // Nothing on a run this size clears 1.96 × 2.2%, which is the whole point
        significantBy: { dps: false, xp: false, profit: false, deaths: false, encounters: false },
        significant: false,
    };
}

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

// The panel is a singleton and its table preferences — which columns are
// hidden, what the Score is scored on, how each table is sorted — are
// deliberately remembered across a destroy and persisted to storage, which the
// in-memory storage mock keeps for the rest of the file. So a test that sorts a
// column or turns the Score gradient on hands the next one a panel that has
// been used, and tests written against a fresh panel read a table sorted and
// colored by something they never asked for. Every test starts from a panel
// nobody has opened before.
beforeEach(() => {
    mocks.store.clear();
    ui._upgradeSort = null;
    ui._upgradeLevelSort = null;
    ui._unpricedSort = null;
    ui._upgradeHiddenColumns = null;
    ui._upgradeScoreKeys = null;
    ui._upgradeScoreDepth = DEFAULT_SCORE_DEPTH;
    ui._upgradeScoreGradient = false;
});

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

    test('an affordable ability upgrade is bought even though its profit gain is inside the noise', () => {
        // The bug this reproduces: 500M of budget, a 140.6M ability row with a
        // positive profit delta sitting right there in the table, and a planner
        // answering "nothing in the list both fits 500.0M and improves Profit/hr"
        const plan = planUpgradeBudget([abilityRow('Berserk', { hrid: '/abilities/berserk' })], 500_000_000, {
            baseline: BASELINE,
            metricKey: 'profit',
        });

        expect(plan.picks.map((p) => p.candidate.description)).toEqual(['Berserk Lv65 → Lv70']);
        expect(plan.totalCost).toBe(140_600_000);
        // ...and it says so, rather than passing an estimate off as a measurement
        expect(plan.provisional).toBe(true);
    });

    test('two different abilities are two purchases, and both fit', () => {
        const plan = planUpgradeBudget(
            [
                abilityRow('Berserk', { hrid: '/abilities/berserk', profitGain: 3_000_000 }),
                abilityRow('Penetrating Strike', {
                    hrid: '/abilities/penetrating_strike',
                    cost: 200_000_000,
                    profitGain: 2_000_000,
                }),
            ],
            500_000_000,
            { baseline: BASELINE, metricKey: 'profit' }
        );

        expect(plan.picks).toHaveLength(2);
        expect(plan.totalCost).toBe(340_600_000);
    });

    test('but two targets for one ability are the same purchase twice, so only the better goes in', () => {
        const plan = planUpgradeBudget(
            [
                abilityRow('Berserk', { hrid: '/abilities/berserk', level: 70, cost: 140_600_000 }),
                abilityRow('Berserk', {
                    hrid: '/abilities/berserk',
                    level: 75,
                    cost: 300_000_000,
                    profitGain: 3_100_000,
                }),
            ],
            500_000_000,
            { baseline: BASELINE, metricKey: 'profit' }
        );

        expect(plan.picks).toHaveLength(1);
        expect(plan.totalCost).toBe(140_600_000);
    });

    test('and a row that genuinely does not fit still buys nothing', () => {
        const plan = planUpgradeBudget(
            [abilityRow('Berserk', { hrid: '/abilities/berserk', cost: 900_000_000 })],
            5e8,
            {
                baseline: BASELINE,
                metricKey: 'profit',
            }
        );

        expect(plan.picks).toHaveLength(0);
        expect(plan.provisional).toBe(false);
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
        mocks.buildPlayerDTOs = null;
        mocks.upgradeRuns = 0;
        mocks.cancelActiveCalls = 0;
        mocks.wasOpen = false;
        mocks.openCalls = [];
        mocks.editorCalls = [];
        ui.buildPanel();
    });

    test('opening the panel brings an already-built editor up to date with the game', () => {
        // The reported bug: shrines upgraded while the panel was closed still
        // read their old levels on the next opening, because an initialized
        // editor is never rebuilt. It is not rebuilt now either — the loadout on
        // screen is the user's scenario — but it is asked to adopt whatever the
        // game moved and nobody has edited.
        mocks.editorCalls = [];
        ui.show();

        expect(mocks.editorCalls).toEqual(['refresh']);
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

    test('a second click before player loading resolves does not start a concurrent analysis', async () => {
        selectZone();

        const first = ui._onUpgradeAnalyze();
        const second = ui._onUpgradeAnalyze();
        await Promise.all([first, second]);

        expect(mocks.upgradeRuns).toBe(1);
    });

    test('upgrade Stop terminates the simulation already in flight', () => {
        ui.panel.querySelector('#mwi-csim-upgrade-stop').dispatchEvent(new window.Event('click'));

        expect(ui._upgradeAborted).toBe(true);
        expect(mocks.cancelActiveCalls).toBe(1);
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

    test('the remembered-run banner Clear button forgets the saved run and removes itself', async () => {
        ui._restoredUpgradeAt = Date.now();
        ui._restoredUpgradeMeta = { characterName: 'Millennium44', zoneName: null };
        ui._renderUpgradeResults({
            baseline: BASELINE,
            results: [row('Cheap ring', { slot: '/equipment_types/ring' })],
            food: null,
        });

        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
        const clearBtn = container.querySelector('[data-clear-remembered-upgrade]');
        expect(clearBtn).toBeTruthy();
        expect(container.textContent).toContain('Showing results remembered from');

        clearBtn.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(ui._restoredUpgradeAt).toBeNull();
        expect(ui._restoredUpgradeMeta).toBeNull();
        expect(container.querySelector('[data-clear-remembered-upgrade]')).toBeNull();
        expect(container.textContent).not.toContain('Showing results remembered from');
        // The table itself is untouched — Clear forgets the saved copy, not
        // what is already on screen
        expect(container.textContent).toContain('Cheap ring');
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

    describe('the Δ columns tooltip the exact arithmetic', () => {
        // ΔDPS is hidden by default (DEFAULT_HIDDEN_COLUMNS) — show it so the
        // column, and its tooltip, are actually on the table to inspect
        beforeEach(() => {
            ui._upgradeHiddenColumns = new Set();
        });
        afterEach(() => {
            ui._upgradeHiddenColumns = null;
        });

        test('names the baseline, the upgraded value and the difference', () => {
            ui._renderUpgradeResults({
                baseline: BASELINE,
                results: [row('Cheap ring', { slot: '/equipment_types/ring', dps: 142.314, profitGain: 231 })],
                food: null,
            });

            const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
            const header = [...container.querySelectorAll('thead th')].findIndex((th) =>
                th.textContent.startsWith('ΔDPS')
            );
            const dpsCell = container.querySelector(`[data-upgrade-row="0"] td:nth-child(${header + 1}) span[title]`);
            expect(dpsCell.getAttribute('title')).toBe('100.00 baseline → 142.31 with this upgrade = +42.31');
        });

        test('is silent rather than fabricating arithmetic for a non-finite measurement', () => {
            ui._renderUpgradeResults({
                baseline: { ...BASELINE, dps: NaN },
                results: [row('Cheap ring', { slot: '/equipment_types/ring' })],
                food: null,
            });

            const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
            const header = [...container.querySelectorAll('thead th')].findIndex((th) =>
                th.textContent.startsWith('ΔDPS')
            );
            const dpsCell = container.querySelector(`[data-upgrade-row="0"] td:nth-child(${header + 1})`);
            expect(dpsCell.querySelector('span[title]')).toBeNull();
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

/**
 * Regression: the persisted rate used to be read off `Object.keys(...)[0]` of
 * `consumablesUsed`, which is party-slot order, not "self". A character who
 * joined a party after another member sits at a later slot, so their own
 * consumption used to be filed under whichever member happened to occupy slot
 * one — silently corrupting the Consumables panel's auto-rate feature with
 * someone else's numbers.
 */
describe('persisted consumable rates name the character explicitly', () => {
    beforeEach(() => {
        mocks.store.clear();
    });

    afterEach(() => {
        ui.destroy();
        mocks.editedDTOs = null;
        mocks.editorSelfHrid = null;
        mocks.simResult = null;
        mocks.zones = [];
    });

    test('the rate is filed under the hrid the caller names, not the first key in consumablesUsed', async () => {
        const simResult = {
            simulatedTime: 3600 * 1e9,
            zoneName: '/actions/combat/fly',
            difficultyTier: 0,
            // player1 (a party member ahead of self in slot order) used far more
            // than self (player2) — the old first-key read would have filed
            // player1's rate under "the sim's own character"
            consumablesUsed: {
                player1: { '/items/mystery_stew': 100 },
                player2: { '/items/cheese': 5 },
            },
        };

        ui._persistConsumableRates(simResult, 'player2', 'char1');
        await Promise.resolve();
        await Promise.resolve();

        const stored = await readScoped('simConsumableRates', 'combatExport', null);
        expect(stored.perHour).toEqual({ '/items/cheese': 5 });
    });

    test('the rate is stamped with the build that simulated it', async () => {
        // A rate is an engine output, so the readers have to be able to tell a
        // rate this build produced from one an older engine produced. The
        // stamp is null outside the userscript sandbox; that the field is
        // written at all is what a reader needs
        globalThis.GM_info = { script: { version: '9.9.9' } };
        try {
            const simResult = {
                simulatedTime: 3600 * 1e9,
                zoneName: '/actions/combat/fly',
                difficultyTier: 0,
                consumablesUsed: { player1: { '/items/cheese': 5 } },
            };

            ui._persistConsumableRates(simResult, 'player1', 'char1');
            await Promise.resolve();
            await Promise.resolve();

            const stored = await readScoped('simConsumableRates', 'combatExport', null);
            expect(stored.scriptVersion).toBe('9.9.9');
            const byZone = await readScoped('simConsumableRatesByZone', 'combatExport', {});
            expect(byZone['/actions/combat/fly|0'].scriptVersion).toBe('9.9.9');
        } finally {
            delete globalThis.GM_info;
        }
    });

    test('a null selfHrid — an imported profile simmed alone — persists nothing', async () => {
        // openWithExternalDTO leaves the editor's selfHrid null: nobody in this
        // run is the live character. Falling back to the first key (the old
        // behaviour this describe block is about) would file the imported
        // stranger's own consumption under the live character's saved rate
        const simResult = {
            simulatedTime: 3600 * 1e9,
            zoneName: '/actions/combat/fly',
            difficultyTier: 0,
            consumablesUsed: { player1: { '/items/mystery_stew': 100 } },
        };

        ui._persistConsumableRates(simResult, null, 'char1');
        await Promise.resolve();
        await Promise.resolve();

        const stored = await readScoped('simConsumableRates', 'combatExport', null);
        expect(stored).toBeNull();
    });

    test('running a simmed-from-profile import end to end persists nothing', async () => {
        // openWithExternalDTO: one player, and getSelfHrid() null — the wiring
        // in _onSimulate must carry that null through as the *true* self
        // rather than defaulting to the only loaded player, which is what
        // `selfHrid` (used for the results tab) is allowed to do
        mocks.editedDTOs = { player1: { hrid: 'player1', equipment: {}, food: [null, null, null] } };
        mocks.editorSelfHrid = null;
        mocks.zones = [{ hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0 }];
        mocks.simResult = {
            simulatedTime: 3600 * 1e9,
            zoneName: '/actions/combat/fly',
            difficultyTier: 0,
            consumablesUsed: { player1: { '/items/mystery_stew': 100 } },
            experienceGained: { player1: {} },
        };
        ui.buildPanel();
        selectZone();

        await ui._onSimulate();

        const stored = await readScoped('simConsumableRates', 'combatExport', null);
        expect(stored).toBeNull();
    });
});

/**
 * A run takes minutes, and everything it persists afterwards is filed under
 * whoever is logged in at the moment of the write. A character switch inside
 * that window handed the departing character's results to the arriving one —
 * overwriting results the arriving character had waited just as long for.
 */
describe('results outliving the character they were run for', () => {
    beforeEach(() => {
        mocks.store.clear();
        mocks.characterId = 'char1';
        mocks.buildPlayerDTOs = null;
        mocks.upgradeRuns = 0;
    });

    afterEach(() => {
        ui.destroy();
        mocks.characterId = 'char1';
        mocks.simResult = null;
        mocks.zones = [];
        mocks.allZonesResult = [];
        mocks.onRun = null;
        mocks.buildPlayerDTOs = null;
        vi.restoreAllMocks();
    });

    test('the by-zone consumable map is not rewritten under the arriving character', async () => {
        // The alt has their own ratings for two zones. The main's read of its
        // own (empty) map is already in flight when the switch lands, and the
        // write that follows it used to resolve the alt's key — replacing both
        // of the alt's ratings with the main's single new one.
        mocks.store.set('combatExport:simConsumableRatesByZone_char2', {
            'a|0': { perHour: { '/items/cheese': 1 } },
            'b|0': { perHour: { '/items/cheese': 2 } },
        });

        ui._persistConsumableRates(
            {
                simulatedTime: 3600 * 1e9,
                zoneName: '/actions/combat/fly',
                difficultyTier: 0,
                consumablesUsed: { player1: { '/items/mystery_stew': 6 } },
            },
            'player1',
            'char1'
        );
        mocks.characterId = 'char2';
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(Object.keys(mocks.store.get('combatExport:simConsumableRatesByZone_char2'))).toEqual(['a|0', 'b|0']);
    });

    test('an all-zones sweep finishing after a switch does not overwrite the arriving character’s snapshot', async () => {
        mocks.store.set('combatExport:allZonesSnapshot_char2', { zones: [{ zoneHrid: '/actions/combat/alt' }] });
        mocks.zones = [{ hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0 }];
        mocks.allZonesResult = [
            {
                simulatedTime: 3600 * 1e9,
                encounters: 10,
                deaths: { player1: 0 },
                experienceGained: { player1: { defense: 100 } },
            },
        ];
        ui.buildPanel();
        ui._allZonesMode = 'group';
        ui._updateAllZonesUI();
        // The switch lands during the finalization pass, after the workers are
        // done and before the snapshot is written
        vi.spyOn(ui, '_displayAllZonesResults').mockImplementation(async () => {
            mocks.characterId = 'char2';
        });

        await ui._onSimulateAllZones();

        expect(mocks.store.get('combatExport:allZonesSnapshot_char2').zones).toEqual([
            { zoneHrid: '/actions/combat/alt' },
        ]);
        expect(mocks.store.get('combatExport:allZonesSnapshot_char1')).toBeUndefined();
    });

    test('a pricing change during the sweep re-prices the saved snapshot, not just the screen', async () => {
        mocks.zones = [{ hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0 }];
        mocks.allZonesResult = [
            {
                simulatedTime: 3600 * 1e9,
                encounters: 10,
                deaths: { player1: 0 },
                experienceGained: { player1: { defense: 100 } },
            },
        ];
        ui.buildPanel();
        ui._allZonesMode = 'group';
        ui._updateAllZonesUI();
        // The change lands in the finalization window, after the rows were priced
        vi.spyOn(ui, '_displayAllZonesResults').mockImplementation(async () => {
            ui._redisplayLastResults();
        });
        const savedWhenRepriced = [];
        const reprice = ui._repriceZoneEntries.bind(ui);
        vi.spyOn(ui, '_repriceZoneEntries').mockImplementation((...args) => {
            savedWhenRepriced.push(mocks.store.has('combatExport:allZonesSnapshot_char1'));
            return reprice(...args);
        });

        await ui._onSimulateAllZones();

        // The first reprice is of the snapshot rows, before the snapshot is written
        expect(savedWhenRepriced[0]).toBe(false);
        expect(mocks.store.has('combatExport:allZonesSnapshot_char1')).toBe(true);
    });

    test('an upgrade analysis finishing after a switch does not replace the arriving character’s remembered run', async () => {
        const { default: config } = await import('../../core/config.js');
        vi.spyOn(config, 'getSetting').mockImplementation((key, fallback = false) =>
            key === 'combatSim_rememberUpgradeResults' ? true : fallback
        );
        mocks.store.set('combatExport:combatSimUpgradeResults_char2', {
            data: { results: [{ candidate: { description: 'the alt’s own run' } }] },
            savedAt: 1,
        });
        mocks.upgradeResult = { baseline: BASELINE, results: [row('Main gear')], food: null };
        mocks.onRun = () => {
            mocks.characterId = 'char2';
        };
        ui.buildPanel();
        selectZone();

        await ui._onUpgradeAnalyze();

        expect(
            mocks.store.get('combatExport:combatSimUpgradeResults_char2').data.results[0].candidate.description
        ).toBe('the alt’s own run');
    });

    test('an upgrade analysis waiting for player profiles does not start after a character switch', async () => {
        let releaseProfiles;
        mocks.buildPlayerDTOs = () =>
            new Promise((resolve) => {
                releaseProfiles = resolve;
            });
        ui.buildPanel();
        selectZone();

        const analysis = ui._onUpgradeAnalyze();
        mocks.characterId = 'char2';
        releaseProfiles({ players: mocks.playerDTOs });
        await analysis;

        expect(mocks.upgradeRuns).toBe(0);
        expect(ui._upgradeRunning).toBe(false);
    });
});

describe('runs waiting for live player profiles', () => {
    const profileResult = () => ({
        players: mocks.playerDTOs,
        playerInfo: [],
        selfHrid: 'player1',
        missingMembers: [],
    });

    let releaseProfiles;

    beforeEach(() => {
        mocks.characterId = 'char1';
        mocks.editedDTOs = null;
        ui._allZonesMode = null;
        mocks.simRuns = 0;
        mocks.allZonesRuns = 0;
        mocks.allZonesResult = [];
        mocks.zones = [{ hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0 }];
        mocks.simResult = {
            simulatedTime: 3600 * 1e9,
            zoneName: '/actions/combat/fly',
            difficultyTier: 0,
            encounters: 10,
            deaths: { player1: 0 },
            experienceGained: { player1: { defense: 100 } },
            consumablesUsed: { player1: {} },
        };
        mocks.buildPlayerDTOs = () =>
            new Promise((resolve) => {
                releaseProfiles = resolve;
            });
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        mocks.characterId = 'char1';
        mocks.buildPlayerDTOs = null;
        mocks.simResult = null;
        mocks.zones = [];
        mocks.allZonesResult = [];
        vi.restoreAllMocks();
    });

    const configureSingle = () => selectZone();

    const configureAllZones = () => {
        ui._allZonesMode = 'group';
        ui._updateAllZonesUI();
    };

    const configureSeek = async () => {
        const input = ui.panel.querySelector('#mwi-csim-seek-input');
        input.value = 'Cheese';
        ui._seekItems = [{ itemHrid: '/items/cheese', name: 'Cheese' }];
        ui._seekSelectedItem = { itemHrid: '/items/cheese', name: 'Cheese' };
        const adapter = await import('./combat-sim-adapter.js');
        return vi
            .spyOn(adapter, 'getZonesThatDropItem')
            .mockReturnValue([{ zoneHrid: '/actions/combat/fly', name: 'Fly', difficultyTier: 0 }]);
    };

    test('rapid Single Sim clicks start only one worker run', async () => {
        configureSingle();

        const first = ui._onSimulate();
        const second = ui._onSimulate();
        releaseProfiles(profileResult());
        await Promise.all([first, second]);

        expect(mocks.simRuns).toBe(1);
    });

    test('Single Sim does not start after the character changes during profile loading', async () => {
        configureSingle();

        const run = ui._onSimulate();
        mocks.characterId = 'char2';
        releaseProfiles(profileResult());
        await run;

        expect(mocks.simRuns).toBe(0);
    });

    test('a load from a destroyed panel cannot overtake a newer same-character run', async () => {
        configureSingle();
        const staleRun = ui._onSimulate();
        const releaseStale = releaseProfiles;

        ui.destroy();
        ui.buildPanel();
        configureSingle();
        const currentRun = ui._onSimulate();
        const releaseCurrent = releaseProfiles;

        releaseStale(profileResult());
        await staleRun;
        expect(mocks.simRuns).toBe(0);

        releaseCurrent(profileResult());
        await currentRun;
        expect(mocks.simRuns).toBe(1);
    });

    test('rapid All Zones clicks start only one worker sweep', async () => {
        configureAllZones();

        const first = ui._onSimulateAllZones();
        const second = ui._onSimulateAllZones();
        releaseProfiles(profileResult());
        await Promise.all([first, second]);

        expect(mocks.allZonesRuns).toBe(1);
    });

    test('All Zones does not start after the character changes during profile loading', async () => {
        configureAllZones();

        const run = ui._onSimulateAllZones();
        mocks.characterId = 'char2';
        releaseProfiles(profileResult());
        await run;

        expect(mocks.allZonesRuns).toBe(0);
    });

    test('rapid Seek clicks start only one worker sweep', async () => {
        const dropSpy = await configureSeek();

        const first = ui._onSeek();
        const second = ui._onSeek();
        releaseProfiles(profileResult());
        await Promise.all([first, second]);
        dropSpy.mockRestore();

        expect(mocks.allZonesRuns).toBe(1);
    });

    test('Seek does not start after the character changes during profile loading', async () => {
        const dropSpy = await configureSeek();

        const run = ui._onSeek();
        mocks.characterId = 'char2';
        releaseProfiles(profileResult());
        await run;
        dropSpy.mockRestore();

        expect(mocks.allZonesRuns).toBe(0);
    });

    test('normal run modes stay idle while an upgrade analysis owns the workers', async () => {
        configureSingle();
        ui._upgradeRunning = true;
        await ui._onSimulate();

        configureAllZones();
        await ui._onSimulateAllZones();

        const dropSpy = await configureSeek();
        await ui._onSeek();
        dropSpy.mockRestore();
        ui._upgradeRunning = false;

        expect(mocks.simRuns).toBe(0);
        expect(mocks.allZonesRuns).toBe(0);
        expect(ui._runStarting).toBe(false);
    });

    test('a cancelled worker from a destroyed panel cannot release a newer run', async () => {
        const runner = await import('./combat-sim-runner.js');
        let rejectOld;
        let resolveCurrent;
        const worker = vi
            .spyOn(runner, 'runSimulation')
            .mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectOld = reject)))
            .mockImplementationOnce(() => new Promise((resolve) => (resolveCurrent = resolve)));
        configureSingle();
        const oldRun = ui._onSimulate();
        releaseProfiles(profileResult());
        await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));

        ui.destroy();
        ui.buildPanel();
        configureSingle();
        const currentRun = ui._onSimulate();
        releaseProfiles(profileResult());
        await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
        const status = vi.spyOn(ui, '_setStatus');

        rejectOld(new Error('Cancelled'));
        await oldRun;
        try {
            expect(ui.isRunning).toBe(true);
            expect(ui.panel.querySelector('#mwi-csim-run').disabled).toBe(true);
            expect(status).not.toHaveBeenCalledWith('Simulation cancelled.');
        } finally {
            resolveCurrent(mocks.simResult);
            await currentRun;
        }
    });

    test('a completed worker from the departing character cannot repopulate the new panel', async () => {
        const runner = await import('./combat-sim-runner.js');
        let resolveOld;
        const worker = vi
            .spyOn(runner, 'runSimulation')
            .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
        configureSingle();
        const oldRun = ui._onSimulate();
        releaseProfiles(profileResult());
        await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());

        ui.destroy();
        mocks.characterId = 'char2';
        ui.buildPanel();
        const status = vi.spyOn(ui, '_setStatus');
        resolveOld(mocks.simResult);
        await oldRun;

        expect(ui._lastSimResult).toBeNull();
        expect(ui._simHistory).toEqual([]);
        expect(status).not.toHaveBeenCalled();
    });

    test('all-zones finalization cannot save or release a newer same-character run', async () => {
        let releaseDisplay;
        const display = vi
            .spyOn(ui, '_buildBestiaryPlanZones')
            .mockImplementationOnce(() => new Promise((resolve) => (releaseDisplay = resolve)));
        configureAllZones();
        const oldRun = ui._onSimulateAllZones();
        releaseProfiles(profileResult());
        await vi.waitFor(() => expect(display).toHaveBeenCalledOnce());

        ui.destroy();
        ui.buildPanel();
        const currentPlans = [{ zoneName: 'Current plan' }];
        ui._bestiaryPlanZones = currentPlans;
        ui.isRunning = true;
        const status = vi.spyOn(ui, '_setStatus');
        mocks.store.clear();
        releaseDisplay([]);
        await oldRun;

        expect(ui._bestiaryPlanZones).toBe(currentPlans);
        expect(await loadAllZonesSnapshot()).toBeNull();
        expect(ui.isRunning).toBe(true);
        expect(status).not.toHaveBeenCalled();
    });

    test('a departed Seek worker cannot replace the next panel results', async () => {
        const runner = await import('./all-zones-runner.js');
        let resolveOld;
        const worker = vi
            .spyOn(runner, 'runAllZonesSimulation')
            .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
        await configureSeek();
        const oldRun = ui._onSeek();
        releaseProfiles(profileResult());
        await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());

        ui.destroy();
        ui.buildPanel();
        const currentRows = [{ zone: { name: 'Current result' } }];
        ui._seekResults = currentRows;
        ui.isRunning = true;
        const status = vi.spyOn(ui, '_setStatus');
        resolveOld([]);
        await oldRun;

        expect(ui._seekResults).toBe(currentRows);
        expect(ui.isRunning).toBe(true);
        expect(status).not.toHaveBeenCalled();
    });
});

describe('the remembered upgrade analysis across a character switch', () => {
    beforeEach(() => {
        mocks.store.clear();
        mocks.characterId = 'char1';
    });

    afterEach(() => {
        ui.destroy();
        mocks.characterId = 'char1';
        vi.restoreAllMocks();
    });

    test('the arriving character’s own remembered run still restores', async () => {
        // A switch destroys the panel and builds a new one. `_upgradeResultsData`
        // outlived that teardown, and `_restoreUpgradeResults` refuses to draw
        // over a set already in hand — so the arriving character's remembered
        // analysis silently never came back.
        const { default: config } = await import('../../core/config.js');
        vi.spyOn(config, 'getSetting').mockImplementation((key, fallback = false) =>
            key === 'combatSim_rememberUpgradeResults' ? true : fallback
        );
        mocks.store.set('combatExport:combatSimUpgradeResults_char2', {
            data: { baseline: BASELINE, results: [row('The alt’s own run')] },
            savedAt: 1,
        });
        ui.buildPanel();
        ui._renderUpgradeResults({ baseline: BASELINE, results: [row('The main’s run')], food: null });

        ui.destroy();
        mocks.characterId = 'char2';
        ui.buildPanel();
        await ui._restoreUpgradeResults();

        expect(ui.panel.querySelector('#mwi-csim-upgrade-results').textContent).toContain('The alt’s own run');
    });
});

describe('all-zones snapshot', () => {
    const HOUR_NS = 3600 * 1e9;

    const zoneResult = (name, { tier = 0, profit = 100, xp = 50, hours = 2, encounters = 400 } = {}) => ({
        zone: { zoneHrid: `/actions/combat/${name}`, name, difficultyTier: tier },
        simResult: {
            simulatedTime: hours * HOUR_NS,
            experienceGained: { player1: { attack: xp * hours, stamina: xp * hours } },
            encounters,
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

    test('carries whether the run was simulated on substituted food', async () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly')], { hours: 4, maxTierFood: true });

        expect(snapshot.maxTierFood).toBe(true);
        expect(await saveAllZonesSnapshot(snapshot)).toBe(true);
        expect((await loadAllZonesSnapshot()).maxTierFood).toBe(true);
    });

    test('says false rather than nothing for an ordinary run, so a reader can tell them apart', () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly')], { hours: 4 });

        expect(snapshot.maxTierFood).toBe(false);
        // Additive: everything a reader written before the flag looks for is untouched
        expect(snapshot.zones).toHaveLength(1);
        expect(snapshot).toMatchObject({ version: 1, hours: 4, fingerprint: null });
    });

    /**
     * The one figure that turns a zone into a duration. It is computed for the
     * results table and was thrown away with it, so nothing outside the panel
     * could say how long a given number of fights takes.
     */
    test('stores encounters per hour, on the simulator’s own clock', () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly', { hours: 2, encounters: 400 })], { hours: 10 });

        expect(snapshot.zones[0].encountersPerHour).toBeCloseTo(200);
    });

    test('a run the simulator gave no encounter count for stores null, not a zero', () => {
        const fly = zoneResult('Fly');
        delete fly.simResult.encounters;

        expect(buildAllZonesSnapshot([fly], { hours: 2 }).zones[0].encountersPerHour).toBeNull();
    });

    /**
     * `simResult.deaths` is a party-wide body count, so a Bestiary projection
     * off a stored run has to know how many players produced it. Dungeon rows
     * carried a party size; ordinary zones carried none, and a reader had no
     * way to tell a three-player run from a solo one.
     */
    test('records the party the run was simulated with, taken from the run itself', async () => {
        const trio = zoneResult('Fly');
        trio.simResult.numberOfPlayers = 3;

        const snapshot = buildAllZonesSnapshot([trio], { hours: 4 });
        expect(snapshot.partySize).toBe(3);
        expect(await saveAllZonesSnapshot(snapshot)).toBe(true);
        expect((await loadAllZonesSnapshot()).partySize).toBe(3);
    });

    test('a solo run says 1 rather than nothing, so a reader can tell it from a run that never said', () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly')], { hours: 4 });
        expect(snapshot.partySize).toBe(1);
        // Additive: a reader written before the field sees the row it always did
        expect(snapshot).toMatchObject({ version: 1, hours: 4, fingerprint: null });
        expect(snapshot.zones).toHaveLength(1);
    });

    test('records which gear the run was simulated in, and round-trips it', async () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly')], {
            hours: 4,
            loadout: { source: 'loadout', name: 'Fighting' },
        });

        expect(snapshot.loadout).toEqual({ source: 'loadout', name: 'Fighting' });
        expect(await saveAllZonesSnapshot(snapshot)).toBe(true);
        const loaded = await loadAllZonesSnapshot();
        expect(loaded.loadout).toEqual({ source: 'loadout', name: 'Fighting' });
        expect(loaded.zones[0].encountersPerHour).toBeCloseTo(200);
    });

    /**
     * A run configured from worn gear has no loadout to name, and inventing an
     * id for it would let a reader "confirm" a match that was never checked.
     */
    test('a run with no loadout behind it says so rather than inventing one', () => {
        const snapshot = buildAllZonesSnapshot([zoneResult('Fly')], { hours: 4 });
        expect(snapshot.loadout).toEqual({ source: 'unknown', name: null });

        const worn = buildAllZonesSnapshot([zoneResult('Fly')], { loadout: { source: 'worn' } });
        expect(worn.loadout).toEqual({ source: 'worn', name: null });
    });

    /**
     * The Dungeon ROI board subtracts a run's keys itself (`keyCostPerRun`) and its
     * measured branch counts consumables only, so the snapshot's dungeon field has to
     * mean consumables only too. `calculateSimRevenue`'s `costPerHour` carries the keys
     * as well, and passing it through charged for them twice.
     */
    test('a dungeon’s consumable cost leaves out the keys the ROI board charges itself', () => {
        const den = zoneResult('Den');
        den.simResult.isDungeon = true;
        den.simResult.dungeonsCompleted = 10;
        den.revenue.costPerHour = 5_000;
        den.revenue.keyCostPerHour = 3_000;

        const snapshot = buildAllZonesSnapshot([den], { hours: 2 });

        expect(snapshot.zones[0].dungeon.consumableCostPerHour).toBe(2_000);
    });

    test('stores the sim’s raw profit claim plus what was sold — the cap is applied by readers, not here', () => {
        // The calibration loop compares the sim's claim against measured runs,
        // so a market-volume cap baked in here would corrupt the comparison.
        liquidity.throttleByItem['/items/rare_charm'] = 0.01;

        const fly = zoneResult('Fly', { profit: 10_000 });
        fly.revenue.dropEntries = [
            { itemHrid: '/items/rare_charm', name: 'Rare Charm', countPerHour: 20, unitValue: 500, totalValue: 10_000 },
            { itemHrid: '/items/no_value', name: 'Worthless', countPerHour: 0 },
        ];

        const snapshot = buildAllZonesSnapshot([fly], { hours: 2 });

        expect(snapshot.zones[0].profitPerHour).toBe(10_000);
        expect(snapshot.zones[0].sells).toEqual([
            { itemHrid: '/items/rare_charm', name: 'Rare Charm', unitsPerHour: 20 },
        ]);
    });
});

describe('the all-zones table', () => {
    /** A table row as `_displayAllZonesResults` builds them. */
    const zoneRow = (zone, { totalXP = 0, profitDay = 0, tier = 0, ...skills } = {}) => ({
        zone,
        tier,
        encounters: 10,
        deaths: 0,
        totalXP,
        profitDay,
        stamina: 0,
        intelligence: 0,
        attack: 0,
        melee: 0,
        defense: 0,
        ranged: 0,
        magic: 0,
        ...skills,
    });

    describe('columns nobody trains', () => {
        test('a skill with a rate in one zone keeps its column', () => {
            const keys = visibleAllZonesSkillColumns([
                zoneRow('A', { defense: 0 }),
                zoneRow('B', { defense: 1200 }),
            ]).map((c) => c.key);

            expect(keys).toEqual(['defense']);
        });

        test('the six that read zero everywhere are dropped', () => {
            // The single-style build in the report: only Def carries XP
            const keys = visibleAllZonesSkillColumns([
                zoneRow('A', { defense: 900 }),
                zoneRow('B', { defense: 1200 }),
            ]).map((c) => c.key);

            expect(keys).toEqual(['defense']);
            expect(keys).not.toContain('magic');
        });

        test('a run that trains nothing at all drops every per-skill column', () => {
            expect(visibleAllZonesSkillColumns([zoneRow('A'), zoneRow('B')])).toEqual([]);
        });

        test('and no rows is not a crash', () => {
            expect(visibleAllZonesSkillColumns([])).toEqual([]);
            expect(visibleAllZonesSkillColumns(null)).toEqual([]);
        });
    });

    describe('the Score', () => {
        test('a zone that wins both metrics scores full marks', () => {
            const rows = [
                zoneRow('Best', { totalXP: 1000, profitDay: 5000 }),
                zoneRow('Mid', { totalXP: 500, profitDay: 2000 }),
                zoneRow('Worst', { totalXP: 100, profitDay: 100 }),
            ];
            scoreAllZoneRows(rows);

            expect(rows[0].score).toBe(100);
            expect(rows[2].score).toBe(0);
            expect(rows[1].score).toBeGreaterThan(rows[2].score);
            expect(rows[1].score).toBeLessThan(rows[0].score);
        });

        test('winning one metric and losing the other lands in the middle', () => {
            const rows = [
                zoneRow('XP zone', { totalXP: 1000, profitDay: 0 }),
                zoneRow('Gold zone', { totalXP: 0, profitDay: 5000 }),
            ];
            scoreAllZoneRows(rows);

            expect(rows[0].score).toBe(50);
            expect(rows[1].score).toBe(50);
        });

        test('zones that measure identically cannot be separated by list order', () => {
            const rows = [
                zoneRow('First', { totalXP: 500, profitDay: 500 }),
                zoneRow('Second', { totalXP: 500, profitDay: 500 }),
            ];
            scoreAllZoneRows(rows);

            expect(rows[0].score).toBe(rows[1].score);
        });

        test('a lone zone is the best of what was simulated', () => {
            const rows = [zoneRow('Only', { totalXP: 5, profitDay: 5 })];
            expect(scoreAllZoneRows(rows)[0].score).toBe(100);
        });
    });

    describe('the two winners', () => {
        test('are picked per metric, not by one blended ranking', () => {
            const rows = [
                zoneRow('XP zone', { totalXP: 1000, profitDay: 10 }),
                zoneRow('Gold zone', { totalXP: 10, profitDay: 9000 }),
            ];
            const best = bestAllZoneRows(rows);

            expect(best.xp.zone).toBe('XP zone');
            expect(best.profit.zone).toBe('Gold zone');
        });

        test('nothing is badged when every zone earns the same', () => {
            const rows = [zoneRow('A', { totalXP: 100, profitDay: 100 }), zoneRow('B', { totalXP: 100, profitDay: 0 })];
            const best = bestAllZoneRows(rows);

            expect(best.xp).toBeNull();
            expect(best.profit.zone).toBe('A');
        });

        test('a single zone is not declared a winner over itself', () => {
            expect(bestAllZoneRows([zoneRow('Only', { totalXP: 1, profitDay: 1 })])).toEqual({
                xp: null,
                profit: null,
            });
        });
    });

    describe('what gets drawn', () => {
        const HOUR_NS = 3600 * 1e9;
        const result = (name, { xp = {}, profit = 0, tier = 0, dropEntries = [] } = {}) => ({
            zone: { name, difficultyTier: tier, zoneHrid: `/actions/combat/${name}` },
            simResult: {
                simulatedTime: HOUR_NS,
                encounters: 10,
                deaths: { player1: 0 },
                experienceGained: { player1: xp },
            },
            revenue: { netPerHour: profit, revenuePerHour: profit, costPerHour: 0, dropEntries },
        });

        beforeEach(() => {
            ui.buildPanel();
            ui._allZonesSortCol = null;
            liquidity.throttleByItem = {};
            liquidity.calls = [];
        });

        afterEach(() => {
            ui.destroy();
        });

        test('drops the untrained skill headers and keeps the headline ones', async () => {
            await ui._displayAllZonesResults(
                [result('Fly', { xp: { defense: 900 }, profit: 100 }), result('Jungle', { xp: { defense: 1500 } })],
                1,
                {}
            );
            const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);

            expect(headers).toContain('defense');
            expect(headers).toContain('totalXP');
            expect(headers).toContain('score');
            expect(headers).not.toContain('magic');
            expect(headers).not.toContain('stamina');
        });

        test('a party slot left selected does not follow the panel into its next opening', async () => {
            // Closing the panel while a party member's tab was up used to leave
            // that hrid as the one every table read: the next open measured a
            // character who is not in this party, whose experience and deaths
            // are simply absent, so the table drew no skill columns at all
            ui._activePlayerTab = 'player2';
            ui.destroy();
            ui.buildPanel();

            await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 100 })], 1, {});
            const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);

            expect(ui._activePlayerTab).toBe('player1');
            expect(headers).toContain('defense');
        });

        test('names both winners above the table', async () => {
            await ui._displayAllZonesResults(
                [
                    result('Fly', { xp: { defense: 900 }, profit: 10 }),
                    result('Jungle', { xp: { defense: 100 }, profit: 5000 }),
                ],
                1,
                {}
            );
            const shown = ui.panel.querySelector('#mwi-csim-results').textContent;

            expect(shown).toContain('Best XP');
            expect(shown).toContain('Best profit');
            // And the rows themselves carry the badge, so a sort keeps it with them
            expect(shown).toContain('best XP');
            expect(shown).toContain('best profit');
        });

        test('a max-tier-food run says so above the table and in the export name', async () => {
            ui._allZonesMaxTierFood = true;
            ui._allZonesFoodSwaps = [{ playerHrid: 'player1', fromName: 'Cheese', toName: 'Marsberry Cake' }];
            await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 10 })], 1, {});
            const container = ui.panel.querySelector('#mwi-csim-results');

            expect(container.textContent).toContain('max-tier food');
            // The hover names the actual swap, so the claim is checkable
            expect(container.innerHTML).toContain('Cheese → Marsberry Cake');
            expect(container.querySelector('[data-csv-export]').dataset.csvExport).toBe('combatsim-all-zones-maxfood');
        });

        test('an ordinary run carries no food note and exports under the plain name', async () => {
            ui._allZonesMaxTierFood = false;
            await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 10 })], 1, {});
            const container = ui.panel.querySelector('#mwi-csim-results');

            expect(container.textContent).not.toContain('max-tier food');
            expect(container.querySelector('[data-csv-export]').dataset.csvExport).toBe('combatsim-all-zones');
        });

        describe('a pricing change while the sweep is shown', () => {
            // Regression for `_redisplayLastResults` only ever redrawing
            // `_lastSimResult`: with a sweep on screen it either left the sweep's
            // figures stale (no earlier single run) or replaced the sweep table
            // with an unrelated single-zone result (an earlier run in hand).
            // Both are covered here. `_activeResultKind`, set by whichever of
            // `_displayResults`/`_displayAllZonesResults` last actually drew,
            // is what routes the redraw correctly.

            // `_repriceAllZonesResults` redraws through `_displayAllZonesResults`,
            // which awaits the Bestiary-plan build before touching the DOM — the
            // firing of a settings-change callback is itself synchronous, so the
            // redraw needs a tick to land.
            const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

            test('re-prices every cached zone row from calculateSimRevenue, without re-running the sim', async () => {
                mocks.revenueCalls = [];
                await ui._displayAllZonesResults(
                    [
                        result('Fly', { xp: { defense: 900 }, profit: 12_000 }),
                        result('Jungle', { xp: { defense: 500 }, profit: 8_000 }),
                    ],
                    1,
                    { some: 'gameData' }
                );
                const before = ui.panel.querySelector('#mwi-csim-results').textContent;
                // The synthetic revenue baked into `result()` above, before any
                // reprice touches it
                expect(before).toContain('288.0K'); // 12,000/hr × 24

                // Fire the same change event the row's Key select (or the main
                // Settings panel, or Party Loot's copy of the row) would
                mocks.settingChangeCallbacks.get('profitCalc_keyPricingMode')?.('profitCalc_keyPricingMode', 'craft');
                await flush();

                // The mocked calculateSimRevenue always answers netPerHour: 0 —
                // a stale redraw would still show the old 288.0K figure, so
                // landing on 0 proves each row's revenue was actually recomputed
                // from its cached simResult rather than redrawn unchanged
                const after = ui.panel.querySelector('#mwi-csim-results').textContent;
                expect(after).toContain('Fly');
                expect(after).toContain('Jungle');
                expect(after).not.toContain('288.0K');
                expect(mocks.revenueCalls.length).toBe(2); // once per cached zone, no more
                expect(mocks.allZonesRuns).toBe(0); // never re-simulated
            });

            test('a pricing change mid-run does not redraw the hidden results', async () => {
                mocks.revenueCalls = [];
                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 12_000 })], 1, {});
                ui.isRunning = true;

                mocks.settingChangeCallbacks.get('profitCalc_keyPricingMode')?.('profitCalc_keyPricingMode', 'craft');
                await flush();

                expect(mocks.revenueCalls.length).toBe(0);
                ui.isRunning = false;

                // …but replayed once the run lets go, so its final draw is not left on old prices
                ui._flushPendingReprice();
                await flush();
                expect(mocks.revenueCalls.length).toBe(1);
            });

            test('a pricing change during run start-up re-prices the still-visible results at once', async () => {
                mocks.revenueCalls = [];
                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 12_000 })], 1, {});
                // Start-up can bail (load error, party cap) without a run ever flushing
                ui._runStarting = true;

                mocks.settingChangeCallbacks.get('profitCalc_keyPricingMode')?.('profitCalc_keyPricingMode', 'craft');
                await flush();

                expect(mocks.revenueCalls.length).toBe(1);
                ui._runStarting = false;
            });

            test('the expected-value cache rebuilding after a pricing change re-prices again', async () => {
                mocks.revenueCalls = [];
                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 12_000 })], 1, {});

                // Openable drops read that cache, which rebuilds a beat after the change
                mocks.dataListeners?.get('expected_value_initialized')?.({ timestamp: 1 });
                await flush();

                expect(mocks.revenueCalls.length).toBe(1);
            });

            test('a re-priced sweep this panel saved rewrites its snapshot too', async () => {
                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 12_000 })], 1, {});
                ui._allZonesSnapshotMeta = { ownerId: mocks.characterId, meta: { hours: 1, playerHrid: 'player1' } };
                mocks.store.delete('combatExport:allZonesSnapshot_' + mocks.characterId);

                mocks.settingChangeCallbacks.get('profitCalc_keyPricingMode')?.('profitCalc_keyPricingMode', 'craft');
                await flush();
                await flush();

                expect(mocks.store.has('combatExport:allZonesSnapshot_' + mocks.characterId)).toBe(true);
                ui._allZonesSnapshotMeta = null;
            });

            test('a naming-only change resyncs the row without re-pricing the sweep', async () => {
                mocks.revenueCalls = [];
                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 12_000 })], 1, {});

                mocks.settingChangeCallbacks.get('profitCalc_pricingNaming')?.('profitCalc_pricingNaming', true);
                await flush();

                expect(mocks.revenueCalls.length).toBe(0);
            });

            test('does not swap in a stale single-zone result over the sweep', async () => {
                // An earlier single run is in hand — the case that used to make
                // `_redisplayLastResults` redraw `_lastSimResult` instead
                ui._lastSimResult = { numberOfPlayers: 1, experienceGained: { player1: {} } };
                ui._lastSimHours = 1;
                ui._lastGameData = {};

                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 100 })], 1, {});
                expect(ui._activeResultKind).toBe('allZones');

                mocks.settingChangeCallbacks.get('profitCalc_keyPricingMode')?.('profitCalc_keyPricingMode', 'craft');
                await flush();

                // Still the sweep table — a single-zone redraw shows no zone rows
                const shown = ui.panel.querySelector('#mwi-csim-results').textContent;
                expect(shown).toContain('Fly');
                expect(ui.panel.querySelectorAll('#mwi-csim-results th[data-col]').length).toBeGreaterThan(0);
            });

            test('re-prices the sweep even with no earlier single-zone run cached', async () => {
                ui._lastSimResult = null;
                await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 }, profit: 12_000 })], 1, {});

                mocks.settingChangeCallbacks.get('profitCalc_keyPricingMode')?.('profitCalc_keyPricingMode', 'craft');
                await flush();

                const shown = ui.panel.querySelector('#mwi-csim-results').textContent;
                expect(shown).toContain('Fly');
                expect(shown).not.toContain('288.0K'); // recomputed to the mock's 0, not left stale
            });
        });

        describe('the market-volume cap', () => {
            const thinLoot = [{ itemHrid: '/items/rare_charm', name: 'Rare Charm', countPerHour: 20 }];
            const liquidLoot = [{ itemHrid: '/items/meat', name: 'Meat', countPerHour: 200 }];

            /** The drawn cell for a zone row and column, by header position */
            function cell(zoneName, colKey) {
                const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);
                const index = headers.indexOf(colKey);
                const rows = [...ui.panel.querySelectorAll('#mwi-csim-results tbody tr')];
                const row = rows.find((tr) => tr.cells[0].textContent.startsWith(zoneName));
                return row?.cells[index];
            }

            test('Profit/day is ranked and drawn at the pace the market pays, marked', async () => {
                // The fantasy zone: 10,000/hr through loot the market takes a
                // hundredth of. The honest zone: 1,000/hr of liquid meat.
                liquidity.throttleByItem['/items/rare_charm'] = 0.01;
                await ui._displayAllZonesResults(
                    [
                        result('Fantasy', { profit: 10_000, dropEntries: thinLoot }),
                        result('Honest', { profit: 1_000, dropEntries: liquidLoot }),
                    ],
                    1,
                    {}
                );

                // 10,000 × 0.01 × 24 = 2,400/day, against 24,000/day honest
                expect(cell('Fantasy', 'profitDay').textContent).toContain('2.4K');
                expect(cell('Honest', 'profitDay').textContent).toContain('24.0K');

                // The capped cell says so, naming the limiting item; the liquid one is untouched
                expect(cell('Fantasy', 'profitDay').innerHTML).toContain('vol-capped');
                expect(cell('Fantasy', 'profitDay').querySelector('span[title]').title).toContain('Rare Charm');
                expect(cell('Honest', 'profitDay').innerHTML).not.toContain('vol-capped');
            });

            test('the Score blends the capped Profit/day, not the raw claim', async () => {
                liquidity.throttleByItem['/items/rare_charm'] = 0.01;
                await ui._displayAllZonesResults(
                    [
                        result('Fantasy', { xp: { defense: 100 }, profit: 10_000, dropEntries: thinLoot }),
                        result('Honest', { xp: { defense: 100 }, profit: 1_000, dropEntries: liquidLoot }),
                    ],
                    1,
                    {}
                );

                // Equal XP; on raw profit Fantasy would win the profit ladder
                // and the Score — capped, it loses both
                expect(Number(cell('Honest', 'score').textContent)).toBeGreaterThan(
                    Number(cell('Fantasy', 'score').textContent)
                );
                const shown = ui.panel.querySelector('#mwi-csim-results').textContent;
                expect(shown).toContain('Honestbest profit');
            });

            test('a liquid run draws no marker anywhere', async () => {
                await ui._displayAllZonesResults([result('Honest', { profit: 1_000, dropEntries: liquidLoot })], 1, {});

                expect(ui.panel.querySelector('#mwi-csim-results').innerHTML).not.toContain('vol-capped');
            });

            test('caps every row from the cache alone — no warm-up, no lookup of its own', async () => {
                // Two rows share the same thin-selling drop, the way a common rare
                // find shows up across several zones. The all-zones table must
                // never issue a volume lookup of its own — that was the bug this
                // closes, a lookup per distinct drop item that got the pooled
                // history host to refuse a 66-zone run outright. Capping still
                // runs per row (from whatever is already cached elsewhere), but
                // no prefetch/warm-up call happens at all.
                await ui._displayAllZonesResults(
                    [
                        result('Fantasy', { profit: 10_000, dropEntries: thinLoot }),
                        result('Also fantasy', { profit: 8_000, dropEntries: thinLoot }),
                        result('Honest', { profit: 1_000, dropEntries: liquidLoot }),
                    ],
                    1,
                    {}
                );

                const prefetches = liquidity.calls.filter((call) => call.type === 'prefetch');
                const caps = liquidity.calls.filter((call) => call.type === 'cap');

                expect(prefetches).toHaveLength(0);
                expect(caps).toHaveLength(3);
            });

            test('records a phase for each part of the render, so a slow run says which part', async () => {
                // A render that takes six seconds is a question. These spans are
                // the answer, and they are what a real account's slow run will
                // be read from — the test server could not reproduce the slow
                // case, so the figures have to come from the report instead.
                const { default: performanceMonitor } = await import('../../utils/performance-monitor.js');
                performanceMonitor.spans?.delete?.('allZones:render');

                await ui._displayAllZonesResults(
                    [
                        result('Fantasy', { profit: 10_000, dropEntries: thinLoot }),
                        result('Honest', { profit: 1_000, dropEntries: liquidLoot }),
                    ],
                    1,
                    {}
                );

                const parts = performanceMonitor.getSpans('allZones:render').map((span) => span.part);
                expect(parts).toContain('rows');
                expect(parts).not.toContain('prefetchVolumes');
                expect(parts).toContain('capProfit');
            });
        });
    });

    describe('dungeon clears, fails and average clear time', () => {
        const HOUR_NS = 3600 * 1e9;
        // Production shape, from combat-sim-adapter.js: `zone.name` is the
        // plain name ("Pirate Cove") and `zone.zoneHrid` is the full
        // snake-case action hrid the game uses (action.actionHrid) — the
        // renderer is what prefixes a dungeon row with "[D] " (see `dungeon
        // ? \`[D] ${r.zone.name}\` : r.zone.name` above). A fixture that
        // already carries "[D] " in the name would double the prefix and
        // produce an hrid the game never emits.
        const slug = (name) => name.toLowerCase().replace(/\s+/g, '_');
        // Zone/tier is not a dungeon by default; a dungeon result carries
        // isDungeon plus the counters the engine already tracks per run —
        // see sim-result.js's dungeonsCompleted/dungeonsFailed/
        // dungeonCleanClearTimeTotal/dungeonCleanClearCount.
        const dungeonResult = (
            name,
            { simHours = 1, completed = 0, failed = 0, cleanTotalNs = 0, cleanCount = 0 } = {}
        ) => ({
            zone: { name, difficultyTier: 1, zoneHrid: `/actions/combat/${slug(name)}` },
            simResult: {
                simulatedTime: HOUR_NS * simHours,
                encounters: 10,
                deaths: { player1: 0 },
                experienceGained: { player1: {} },
                isDungeon: true,
                dungeonsCompleted: completed,
                dungeonsFailed: failed,
                dungeonCleanClearTimeTotal: cleanTotalNs,
                dungeonCleanClearCount: cleanCount,
            },
            revenue: { netPerHour: 0, revenuePerHour: 0, costPerHour: 0, dropEntries: [] },
        });
        const zoneResult = (name) => ({
            zone: { name, difficultyTier: 1, zoneHrid: `/actions/combat/${slug(name)}` },
            simResult: {
                simulatedTime: HOUR_NS,
                encounters: 10,
                deaths: { player1: 0 },
                experienceGained: { player1: {} },
            },
            revenue: { netPerHour: 0, revenuePerHour: 0, costPerHour: 0, dropEntries: [] },
        });

        /** The rendered zone-name cell (column 0) for a row, matched on the plain name. */
        function zoneCell(plainName) {
            const rows = [...ui.panel.querySelectorAll('#mwi-csim-results tbody tr')];
            return rows.find((tr) => tr.cells[0].textContent.includes(plainName))?.cells[0];
        }

        /** The drawn cell for a zone row and column, by header position, matched on the plain name. */
        function cell(plainName, colKey) {
            const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);
            const index = headers.indexOf(colKey);
            const row = zoneCell(plainName)?.closest('tr');
            return row?.cells[index];
        }

        beforeEach(() => {
            ui.buildPanel();
        });

        afterEach(() => {
            ui.destroy();
        });

        test('a dungeon row is marked with exactly one [D] prefix, not a doubled one', async () => {
            await ui._displayAllZonesResults([dungeonResult('Pirate Cove', { simHours: 1 })], 1, {});

            const text = zoneCell('Pirate Cove').textContent;
            expect(text.startsWith('[D] Pirate Cove')).toBe(true);
            expect(text.match(/\[D\]/g)).toHaveLength(1);
        });

        test('a dungeon row shows clears/day, fails/day and the clean average clear time', async () => {
            // 24 completions and 8 fails over 4 simulated hours → 144/day and
            // 48/day; 600 s of clean-pair time over 6 pairs → 100 s average
            await ui._displayAllZonesResults(
                [
                    dungeonResult('Pirate Cove', {
                        simHours: 4,
                        completed: 24,
                        failed: 8,
                        cleanTotalNs: 600 * 6 * 1e9,
                        cleanCount: 6,
                    }),
                ],
                4,
                {}
            );

            expect(cell('Pirate Cove', 'clearsPerDay').textContent).toBe('144.0');
            expect(cell('Pirate Cove', 'failsPerDay').textContent).toBe('48.0');
            expect(cell('Pirate Cove', 'avgClearTime').textContent).toBe('0h 10m 00s');
        });

        test('a run with no dungeon rows at all hides the three dungeon-only columns', async () => {
            await ui._displayAllZonesResults([zoneResult('Fly')], 1, {});

            expect(zoneCell('Fly').textContent).not.toContain('[D]');
            const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);
            expect(headers).not.toEqual(expect.arrayContaining(['clearsPerDay', 'failsPerDay', 'avgClearTime']));
        });

        test('a saved sort on a now-hidden dungeon column falls back to the default Score sort', async () => {
            ui._allZonesSortCol = 'avgClearTime';
            ui._allZonesSortAsc = true;

            await ui._displayAllZonesResults([zoneResult('Fly'), zoneResult('Ant')], 1, {});

            // The column no longer exists on screen, and the UI stops trying
            // to sort by it rather than silently sorting by a hidden column.
            expect(ui._allZonesSortCol).toBe('score');
            expect(ui._allZonesSortAsc).toBe(false);
            const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);
            expect(headers).not.toEqual(expect.arrayContaining(['clearsPerDay', 'failsPerDay', 'avgClearTime']));
        });

        test('a mixed run keeps the dungeon-only columns and shows — for the non-dungeon row', async () => {
            await ui._displayAllZonesResults(
                [dungeonResult('Pirate Cove', { simHours: 1, completed: 6, failed: 0 }), zoneResult('Fly')],
                1,
                {}
            );

            const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);
            expect(headers).toEqual(expect.arrayContaining(['clearsPerDay', 'failsPerDay', 'avgClearTime']));
            expect(cell('Fly', 'clearsPerDay').textContent).toBe('—');
            expect(cell('Fly', 'failsPerDay').textContent).toBe('—');
            expect(cell('Fly', 'avgClearTime').textContent).toBe('—');
        });

        test('a dungeon with no clean pair yet (first run still in progress) reads — for the average', async () => {
            await ui._displayAllZonesResults(
                [dungeonResult('Sinister Circus', { simHours: 1, completed: 0, failed: 0 })],
                1,
                {}
            );

            expect(cell('Sinister Circus', 'clearsPerDay').textContent).toBe('0.0');
            expect(cell('Sinister Circus', 'avgClearTime').textContent).toBe('—');
        });

        test('the CSV export carries the three columns as raw numbers, empty for non-dungeon rows', async () => {
            const saved = [];
            ui._wireCsvButton = ((original) => (button, stem, build) => {
                saved.push({ stem, build });
                return original.call(ui, button, stem, build);
            })(ui._wireCsvButton);

            await ui._displayAllZonesResults(
                [
                    dungeonResult('Pirate Cove', {
                        simHours: 4,
                        completed: 24,
                        failed: 8,
                        cleanTotalNs: 600 * 6 * 1e9,
                        cleanCount: 6,
                    }),
                    zoneResult('Fly'),
                ],
                4,
                {}
            );

            const exported = saved.find((entry) => entry.stem === 'combatsim-all-zones');
            const { rows, columns } = exported.build();
            const keys = columns.map((c) => c.key);
            expect(keys).toEqual(expect.arrayContaining(['clearsPerDay', 'failsPerDay', 'avgClearTime']));

            const dungeonRow = rows.find((r) => r.zone === '[D] Pirate Cove');
            const zoneRow = rows.find((r) => r.zone === 'Fly');
            expect(dungeonRow).toBeTruthy();
            expect(dungeonRow.clearsPerDay).toBeCloseTo(144);
            expect(dungeonRow.failsPerDay).toBeCloseTo(48);
            expect(dungeonRow.avgClearTime).toBeCloseTo(600);
            expect(zoneRow.clearsPerDay).toBeNull();
            expect(zoneRow.failsPerDay).toBeNull();
            expect(zoneRow.avgClearTime).toBeNull();

            delete ui._wireCsvButton;
        });

        describe('sorting missing (non-dungeon) values to the bottom', () => {
            /**
             * Plain zone names in row order, top to bottom. The zone cell's
             * name is a leading text node; badges and the ⊚/▶ buttons that
             * can follow it are separate child elements, so reading just the
             * first child node avoids picking up their symbols.
             */
            function renderedOrder() {
                return [...ui.panel.querySelectorAll('#mwi-csim-results tbody tr')].map((tr) =>
                    tr.cells[0].childNodes[0].textContent.replace(/^\[D\] /, '').trim()
                );
            }

            beforeEach(async () => {
                // A slow dungeon (long clears, few per day), a fast dungeon,
                // a dungeon that has not completed a clean pair yet (0/null),
                // and a non-dungeon zone (null on all three columns) — real
                // measured values and genuinely-missing ones side by side.
                await ui._displayAllZonesResults(
                    [
                        dungeonResult('Slow Dungeon', {
                            simHours: 1,
                            completed: 6,
                            failed: 0,
                            cleanTotalNs: 3600 * 5 * 1e9,
                            cleanCount: 5,
                        }),
                        dungeonResult('Fast Dungeon', {
                            simHours: 1,
                            completed: 60,
                            failed: 0,
                            cleanTotalNs: 60 * 50 * 1e9,
                            cleanCount: 50,
                        }),
                        dungeonResult('Fresh Dungeon', { simHours: 1, completed: 0, failed: 0 }),
                        zoneResult('Open Zone'),
                    ],
                    1,
                    {}
                );
            });

            test('ascending Avg clear puts the fastest dungeon first and non-dungeon/no-pair rows last', async () => {
                ui._allZonesSortCol = 'avgClearTime';
                ui._allZonesSortAsc = true;
                await ui._displayAllZonesResults(ui._allZonesResults, 1, {});

                const order = renderedOrder();
                expect(order.slice(0, 2)).toEqual(['Fast Dungeon', 'Slow Dungeon']);
                // The two rows with no clean-pair average (Fresh Dungeon has
                // none yet, Open Zone is not a dungeon at all) sort after
                // every measured time, in either direction — never at 0.
                expect(order.slice(2)).toEqual(expect.arrayContaining(['Fresh Dungeon', 'Open Zone']));
            });

            test('descending Avg clear still keeps the missing rows last, not first', async () => {
                ui._allZonesSortCol = 'avgClearTime';
                ui._allZonesSortAsc = false;
                await ui._displayAllZonesResults(ui._allZonesResults, 1, {});

                const order = renderedOrder();
                expect(order.slice(0, 2)).toEqual(['Slow Dungeon', 'Fast Dungeon']);
                expect(order.slice(2)).toEqual(expect.arrayContaining(['Fresh Dungeon', 'Open Zone']));
            });

            test('ascending Clears/day keeps the real zero-rate dungeon ahead of the non-dungeon blank', async () => {
                ui._allZonesSortCol = 'clearsPerDay';
                ui._allZonesSortAsc = true;
                await ui._displayAllZonesResults(ui._allZonesResults, 1, {});

                const order = renderedOrder();
                // Fresh Dungeon measured 0 clears/day — a real number — and
                // sorts with the other measured rows; Open Zone has no
                // clears/day at all (not a dungeon) and goes last regardless.
                expect(order.indexOf('Fresh Dungeon')).toBeLessThan(order.indexOf('Open Zone'));
                expect(order[order.length - 1]).toBe('Open Zone');
            });
        });
    });

    describe('the Max-tier Food checkbox', () => {
        beforeEach(() => {
            mocks.store.clear();
            ui.buildPanel();
        });

        afterEach(() => {
            ui.destroy();
        });

        test('is greyed out until an all-zones mode is picked', () => {
            const box = ui.panel.querySelector('#mwi-csim-maxfood');
            const label = ui.panel.querySelector('#mwi-csim-maxfood-label');

            expect(box.disabled).toBe(true);
            expect(label.style.opacity).toBe('0.45');

            ui._allZonesMode = 'group';
            ui._updateAllZonesUI();

            expect(box.disabled).toBe(false);
            expect(label.style.opacity).toBe('');
        });

        test('explains why low-tier food distorts the comparison', () => {
            const title = ui.panel.querySelector('#mwi-csim-maxfood-label').getAttribute('title');

            expect(title).toContain('the deaths are the food, not the zone');
            expect(title).toContain('never touched');
            // The tooltip is interpolated into an attribute; a quote in it would
            // end the attribute early and spill the rest into the markup
            expect(title).not.toContain('"');
        });

        test('is remembered across a rebuild, unlike the run-shape toggles beside it', async () => {
            ui._allZonesMode = 'group';
            ui._updateAllZonesUI();
            const box = ui.panel.querySelector('#mwi-csim-maxfood');
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            await Promise.resolve();

            expect(ui._maxTierFoodEnabled).toBe(true);

            ui.destroy();
            // What a fresh page would start from: the answer has to come back
            // out of storage, not out of the surviving singleton
            ui._maxTierFoodEnabled = false;
            ui._allZonesMode = null;
            ui.buildPanel();
            await Promise.resolve();
            await Promise.resolve();

            expect(ui._maxTierFoodEnabled).toBe(true);
            expect(ui.panel.querySelector('#mwi-csim-maxfood').checked).toBe(true);
            // Sim All Zones itself is per-session and does not come back
            expect(ui.panel.querySelector('#mwi-csim-allzones-group').checked).toBe(false);
        });
    });

    describe('what an all-zones run is actually simulated on', () => {
        const FOOD_DATA = {
            itemDetailMap: {
                '/items/cheese': {
                    name: 'Cheese',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 50, manapointRestore: 0 },
                },
                '/items/marsberry_cake': {
                    name: 'Marsberry Cake',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 240, manapointRestore: 0 },
                },
            },
        };

        beforeEach(() => {
            mocks.store.clear();
            mocks.allZonesArgs = null;
            mocks.gameData = FOOD_DATA;
            mocks.itemPrices = { '/items/cheese': 100, '/items/marsberry_cake': 400 };
            mocks.playerDTOs = [{ hrid: 'player1', equipment: {}, food: [{ hrid: '/items/cheese' }, null, null] }];
            mocks.zones = [{ hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0 }];
            ui.buildPanel();
            ui._allZonesMode = 'group';
            ui._updateAllZonesUI();
        });

        afterEach(() => {
            ui.destroy();
            mocks.gameData = { itemDetailMap: {} };
            mocks.playerDTOs = [{ hrid: 'player1', equipment: {} }];
            mocks.itemPrices = {};
            mocks.zones = [];
            mocks.allZonesResult = [];
        });

        test('the status moves off "Simulating" the moment the sweep resolves, before results finish rendering', async () => {
            // The worker pool is done and the progress bar is at 100 as soon as
            // runAllZonesSimulation resolves, but revenue/liquidity capping and
            // the table render still run inside _onSimulateAllZones afterwards.
            // A frozen "Simulating…" status through that stretch reads as a hang
            // even though the sim itself finished promptly.
            mocks.allZonesResult = [
                {
                    simulatedTime: 3600 * 1e9,
                    encounters: 10,
                    deaths: { player1: 0 },
                    experienceGained: { player1: { defense: 100 } },
                },
            ];

            const statuses = [];
            const originalSetStatus = ui._setStatus.bind(ui);
            const spy = vi.spyOn(ui, '_setStatus').mockImplementation((text) => {
                statuses.push(text);
                originalSetStatus(text);
            });

            // What the status says at the moment the finalization work actually
            // runs. Ordering assertions alone cannot tell this fix from a
            // `_setStatus('Finalizing …')` moved to just above the completion
            // line — which restores the exact freeze, since the revenue pass,
            // the table render and the snapshot save would all still happen
            // under stale "Simulating" text.
            let statusDuringRender = null;
            const originalDisplay = ui._displayAllZonesResults.bind(ui);
            const displaySpy = vi.spyOn(ui, '_displayAllZonesResults').mockImplementation(async (...args) => {
                statusDuringRender = statuses[statuses.length - 1] ?? null;
                return originalDisplay(...args);
            });

            await ui._onSimulateAllZones();
            spy.mockRestore();
            displaySpy.mockRestore();

            expect(statusDuringRender).toMatch(/^Finalizing/);

            const simulatingIdx = statuses.findLastIndex((t) => t.startsWith('Simulating'));
            const finalizingIdx = statuses.findIndex((t) => t.startsWith('Finalizing'));
            const completeIdx = statuses.findIndex((t) => t.startsWith('All zones complete'));

            // A "Finalizing" status is posted right after the sim resolves —
            // between the last "Simulating" tick and the terminal "complete"
            // message — so the panel never sits on stale "Simulating" text
            // while it is actually done simulating and just finishing up.
            expect(finalizingIdx).toBeGreaterThan(-1);
            expect(completeIdx).toBeGreaterThan(finalizingIdx);
            if (simulatingIdx > -1) expect(finalizingIdx).toBeGreaterThan(simulatingIdx);
            // The very last status the user sees is the completion message,
            // not a status frozen mid-finalization
            expect(statuses[statuses.length - 1]).toBe(statuses[completeIdx]);
        });

        test('with the option off, the run gets the food the character carries', async () => {
            ui._maxTierFoodEnabled = false;
            await ui._onSimulateAllZones();

            expect(mocks.allZonesArgs.playerDTOs[0].food[0].hrid).toBe('/items/cheese');
            expect((await loadAllZonesSnapshot()).maxTierFood).toBe(false);
        });

        test('with it on, the run gets the best food of that kind — and the real loadout does not change', async () => {
            ui._maxTierFoodEnabled = true;
            await ui._onSimulateAllZones();

            expect(mocks.allZonesArgs.playerDTOs[0].food[0].hrid).toBe('/items/marsberry_cake');
            // Sim-only: what the adapter handed over is untouched
            expect(mocks.playerDTOs[0].food[0].hrid).toBe('/items/cheese');
            expect((await loadAllZonesSnapshot()).maxTierFood).toBe(true);
            expect(ui._allZonesFoodSwaps).toHaveLength(1);
        });
    });

    describe('which player All Zones and Seek measure', () => {
        // The editor loads real DTOs on panel open, so `getEditedDTOs()` returns
        // non-null on every ordinary visit to these tabs — the `else` branch that
        // reads `buildAllPlayerDTOs()` (and sets `_activePlayerTab` from its
        // `selfHrid`) almost never runs in practice.
        beforeEach(() => {
            mocks.revenueCalls = [];
            mocks.gameData = { itemDetailMap: {} };
            mocks.zones = [{ hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0 }];
            mocks.editedDTOs = {
                player1: { hrid: 'player1', equipment: {}, food: [null, null, null] },
                player2: { hrid: 'player2', equipment: {}, food: [null, null, null] },
            };
            // Self is the second party slot — a perfectly ordinary party where
            // the character running the sim isn't the first slot in the map
            mocks.editorSelfHrid = 'player2';
            mocks.allZonesResult = [
                {
                    simulatedTime: 3600 * 1e9,
                    encounters: 10,
                    deaths: { player1: 0, player2: 0 },
                    experienceGained: { player1: { defense: 100 }, player2: { defense: 100 } },
                },
            ];
            ui.buildPanel();
            ui._allZonesMode = 'group';
            ui._updateAllZonesUI();
            // Stale leftover from viewing a party member's tab on a previous
            // single-zone result, still sitting there when All Zones/Seek run
            ui._activePlayerTab = 'player1';
        });

        afterEach(() => {
            ui.destroy();
            mocks.editedDTOs = null;
            mocks.editorSelfHrid = null;
            mocks.revenueCalls = [];
            mocks.gameData = { itemDetailMap: {} };
            mocks.zones = [];
            mocks.allZonesResult = [];
        });

        test('All Zones records the edited party roster, so recorded runs are matched against it', async () => {
            // runMatchesSimParty compares a run's team with this roster; the edited path used to
            // leave it empty, so any same-sized party's runs could pace the simulation
            ui._playerInfo = [];
            await ui._onSimulateAllZones();

            expect(ui._playerInfo.map((p) => p.hrid)).toEqual(['player1', 'player2']);
            // A snapshot, not the editor's live array
            expect(ui._playerInfo).not.toBe(ui._editor.getPlayerInfo());
        });

        test('All Zones prices the run for the character being optimized, not a stale results tab', async () => {
            await ui._onSimulateAllZones();

            // Every revenue calculation in this run must be for the self player
            // (player2) — none should have run against the stale 'player1' tab
            expect(mocks.revenueCalls.length).toBeGreaterThan(0);
            expect(mocks.revenueCalls.every((hrid) => hrid === 'player2')).toBe(true);
        });

        test('Seek prices the run for the character being optimized, not a stale results tab', async () => {
            const input = ui.panel.querySelector('#mwi-csim-seek-input');
            input.value = 'Cheese';
            ui._seekItems = [{ itemHrid: '/items/cheese', name: 'Cheese' }];
            ui._seekSelectedItem = { itemHrid: '/items/cheese', name: 'Cheese' };

            const adapter = await import('./combat-sim-adapter.js');
            const dropSpy = vi
                .spyOn(adapter, 'getZonesThatDropItem')
                .mockReturnValue([{ hrid: '/actions/combat/fly', name: 'Fly', difficultyTier: 0 }]);
            mocks.drops = new Map([['/items/cheese', 5]]);

            await ui._onSeek();
            dropSpy.mockRestore();

            expect(mocks.revenueCalls.length).toBeGreaterThan(0);
            expect(mocks.revenueCalls.every((hrid) => hrid === 'player2')).toBe(true);
        });
    });
});

describe('the all-zones row ▶ open button', () => {
    const HOUR_NS = 3600 * 1e9;
    const result = (name, { xp = {}, profit = 0, tier = 0 } = {}) => ({
        zone: { name, difficultyTier: tier, zoneHrid: `/actions/combat/${name.toLowerCase()}` },
        simResult: {
            simulatedTime: HOUR_NS,
            encounters: 10,
            deaths: { player1: 0 },
            experienceGained: { player1: xp },
        },
        revenue: { netPerHour: profit, revenuePerHour: profit, costPerHour: 0, dropEntries: [] },
    });
    const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));

    beforeEach(() => {
        ui.buildPanel();
        ui._allZonesSortCol = null;
        mocks.openZoneCalls.length = 0;
        mocks.openZoneResult = { opened: true, tierConfirmed: true, filled: false };
    });

    afterEach(() => {
        ui.destroy();
    });

    test("navigates to the row's exact zone and tier, and fills nothing — a ranking row has no honest count", async () => {
        await ui._displayAllZonesResults([result('Aqua Planet', { xp: { defense: 900 }, tier: 3 })], 1, {});
        const btn = ui.panel.querySelector('.mwi-csim-open-btn');
        expect(btn).not.toBeNull();
        expect(btn.dataset.hrid).toBe('/actions/combat/aqua planet');
        expect(btn.dataset.tier).toBe('3');

        click(btn);
        await Promise.resolve();

        expect(mocks.openZoneCalls).toEqual([{ zoneHrid: '/actions/combat/aqua planet', tier: 3, options: undefined }]);
    });

    test('a click never bubbles into the sort/target handlers behind it', async () => {
        await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 } })], 1, {});
        const btn = ui.panel.querySelector('.mwi-csim-open-btn');
        const stopSpy = vi.spyOn(Event.prototype, 'stopPropagation');

        click(btn);
        await Promise.resolve();

        expect(stopSpy).toHaveBeenCalled();
        stopSpy.mockRestore();
    });

    test('a failed navigate is left to the shared helper — the row does not retry or throw', async () => {
        mocks.openZoneResult = { opened: false, tierConfirmed: false, filled: false };
        await ui._displayAllZonesResults([result('Fly', { xp: { defense: 900 } })], 1, {});
        const btn = ui.panel.querySelector('.mwi-csim-open-btn');

        expect(() => click(btn)).not.toThrow();
        await Promise.resolve();

        expect(mocks.openZoneCalls).toHaveLength(1);
    });
});

describe('upgrade row handoff', () => {
    const candidate = (overrides) => ({ candidate: { description: 'Something', ...overrides } });

    beforeEach(() => {
        mocks.saved.length = 0;
        mocks.watched.length = 0;
        mocks.abilityGoals.length = 0;
        mocks.marketOpened.length = 0;
        mocks.seededTargets.length = 0;
        mocks.bridgePricePanel = {
            seedPriceTarget: (itemHrid, enhancementLevel, cost) => {
                mocks.seededTargets.push({ itemHrid, enhancementLevel, cost });
                return true;
            },
        };
        // Torn down before the log is cleared, so the teardown's own entries do
        // not land in the run the test is about
        cleanupUpgradeMarketAutofill();
        mocks.autofill.length = 0;
        mocks.autofillObservers.length = 0;
        mocks.autofillPending = null;
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

    test('combat levels and community buffs buy nothing', () => {
        expect(upgradeRowPurchase(candidate({ type: 'combat_level', slot: 'attack' }))).toBeNull();
        expect(upgradeRowPurchase(candidate({ type: 'community_buff', buffKey: 'comExp' }))).toBeNull();
        expect(upgradeRowPurchase(null)).toBeNull();
    });

    test('a house room buys a room-level goal rather than an item', () => {
        const buy = upgradeRowPurchase({
            cost: 4_000_000,
            candidate: {
                type: 'house',
                roomHrid: '/house_rooms/dojo',
                roomName: 'Dojo',
                currentLevel: 2,
                upgradeLevel: 5,
            },
        });

        expect(buy.savable).toBe(false);
        expect(buy.house).toEqual({
            houseRoomHrid: '/house_rooms/dojo',
            targetLevel: 5,
            cost: 4_000_000,
            label: 'Dojo Lv5',
        });
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

        expect(mocks.saved).toMatchObject([{ itemHrid: '/items/plate', enhancementLevel: 4 }]);
        expect(mocks.watched).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 4 }]);
    });

    test('the Watch button carries the enhancement level, as the Market button does', () => {
        // "Cheese Sword +5" watched as a plain Cheese Sword lands on the list
        // priced as a +0 — a fraction of what the row it came from was quoting
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/items/cheese_sword', upgradeLevel: 5, type: 'tier' })
        );
        wireUpgradeRowActions(container);

        container.querySelector('[data-buy-action="watch"]').click();
        container.querySelector('[data-buy-action="market"]').click();

        expect(mocks.watched).toEqual([{ itemHrid: '/items/cheese_sword', enhancementLevel: 5 }]);
        // The two handoffs on one row must agree about which item this is
        expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/cheese_sword', enhancementLevel: 5 }]);
    });

    test('Watch also pins the item on the price panel, targeted at the row’s own cost', () => {
        // Watching an item you were just quoted a price for almost always means
        // "tell me when it costs that"; retyping the figure would be the reader
        // doing the handoff by hand
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 4_200_000,
            candidate: { description: 'Something', upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.seededTargets).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 4, cost: 4_200_000 }]);
        // Strictly an addition: the inventory watchlist entry is made either way
        expect(mocks.watched).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 4 }]);
    });

    test('the pin is targeted at the item’s own buy price, never the net after resale', () => {
        // The row's cost is net of the resale credit for the piece it replaces,
        // and an ask never falls to net-of-YOUR-resale — an enhancement row's
        // net (target ask minus the current piece's bid) is unreachable by
        // construction. The pin fires on the item's ask, so it carries the
        // breakdown's buy line for that item instead
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 1_000_000, // 5M ask minus the 4M the worn +10 sells for
            costDetail: {
                gross: 5_000_000,
                buys: [{ hrid: '/items/plate', enhancementLevel: 12, price: 5_000_000 }],
            },
            candidate: {
                description: 'Plate +10 → +12',
                upgradeHrid: '/items/plate',
                upgradeLevel: 12,
                type: 'enhancement',
            },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.seededTargets).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 12, cost: 5_000_000 }]);
        // The Save handoff keeps the net: a savings goal is the outlay, not the ask
        container.querySelector('[data-buy-action="save"]').click();
        expect(mocks.saved[0].quote.cost).toBe(1_000_000);
    });

    test('a simulated enhancement path does not pin its material cost as a finished-item ask', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 300_000,
            costDetail: { gross: 300_000, enhancementPath: true, buys: [] },
            candidate: {
                description: 'Plate +4 → +7',
                upgradeHrid: '/items/plate',
                upgradeLevel: 7,
                type: 'enhancement',
            },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.seededTargets).toHaveLength(0);
        expect(mocks.watched).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 7 }]);
    });

    test('a target-level ask can still be pinned when only the current-level bid is missing', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 300_000,
            costDetail: { gross: 300_000, enhancementPath: true, targetAsk: 5_000_000, buys: [] },
            candidate: {
                description: 'Plate +4 → +7',
                upgradeHrid: '/items/plate',
                upgradeLevel: 7,
                type: 'enhancement',
            },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.seededTargets).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 7, cost: 5_000_000 }]);
    });

    test('an unpriced row seeds no target', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' })
        );
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.seededTargets).toHaveLength(0);
        expect(mocks.watched).toHaveLength(1);
    });

    test('Watch still works with the price panel off, which is its default state', () => {
        mocks.bridgePricePanel = null;
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 4_200_000,
            candidate: { description: 'Something', upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.watched).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 4 }]);
        expect(container.querySelector('[data-buy-action="watch"]').textContent).toBe('Watching ✓');
    });

    test('a failed pin never costs the watch that did work', () => {
        mocks.bridgePricePanel = {
            seedPriceTarget: () => {
                throw new Error('storage is out');
            },
        };
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 4_200_000,
            candidate: { description: 'Something', upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="watch"]').click();

        expect(mocks.watched).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 4 }]);
        expect(container.querySelector('[data-buy-action="watch"]').textContent).toBe('Watching ✓');
    });

    test('Save for this hands over the price the row was quoting, and whose it is', () => {
        // Without it, Equipment Savings re-derives the price with a different
        // model and the two surfaces disagree about one target
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            cost: 44_000_000,
            costDetail: { source: 'market' },
            candidate: { description: 'Plate', upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' },
        });
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="save"]').click();

        expect(mocks.saved).toEqual([
            {
                itemHrid: '/items/plate',
                enhancementLevel: 4,
                quote: { cost: 44_000_000, costSource: 'market' },
            },
        ]);
    });

    test('a row that could not be priced saves as unpriced rather than as free', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/items/plate', upgradeLevel: 4, type: 'tier' })
        );
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="save"]').click();

        expect(mocks.saved[0].quote).toEqual({ cost: null, costSource: '' });
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

    test('an ability row saves as a level goal rather than as a reserved slot', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/abilities/fireball', upgradeLevel: 20, type: 'ability_swap' })
        );

        // Not the gear route: a stack of books fills no equipment slot
        expect(container.querySelector('[data-buy-action="save"]')).toBeNull();
        expect(container.querySelector('[data-buy-action="save-ability"]')).toBeTruthy();
        expect(container.querySelector('[data-buy-action="watch"]')).toBeTruthy();
    });

    test('"Save for this" on an ability row records the goal with its book cost', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            candidate: {
                description: 'Fierce Aura Lv41 → Lv46',
                upgradeHrid: '/abilities/fierce_aura',
                upgradeLevel: 46,
                type: 'ability_level',
            },
            cost: 12_400_000,
        });
        wireUpgradeRowActions(container);

        container.querySelector('[data-buy-action="save-ability"]').click();

        expect(mocks.abilityGoals).toEqual([
            {
                abilityHrid: '/abilities/fierce_aura',
                targetLevel: 46,
                cost: 12_400_000,
                label: 'fierce aura Lv46',
            },
        ]);
        // And never as a gear target, which is a different list
        expect(mocks.saved).toEqual([]);
    });

    test('an unpriced ability row saves as unpriced rather than as free', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml({
            candidate: { upgradeHrid: '/abilities/fierce_aura', upgradeLevel: 46, type: 'ability_level' },
            cost: null,
        });
        wireUpgradeRowActions(container);

        container.querySelector('[data-buy-action="save-ability"]').click();

        expect(mocks.abilityGoals[0].cost).toBeNull();
    });

    test('Market opens the item the row buys, at the level it buys it', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/items/plate', upgradeLevel: 7, type: 'tier' })
        );
        const button = container.querySelector('[data-buy-action="market"]');

        expect(button.getAttribute('data-buy-hrid')).toBe('/items/plate');
        expect(button.getAttribute('data-buy-level')).toBe('7');

        wireUpgradeRowActions(container);
        button.click();

        expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 7 }]);
    });

    test('and on an ability row it opens the book, which is the marketable thing', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/abilities/fireball', upgradeLevel: 20, type: 'ability_level' })
        );
        wireUpgradeRowActions(container);

        container.querySelector('[data-buy-action="market"]').click();

        expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/fireball', enhancementLevel: 0 }]);
    });

    test('rows that buy nothing marketable get no Market button at all', () => {
        // They get no buttons: there is nothing to open, watch or save for
        expect(upgradeRowActionsHtml(candidate({ type: 'combat_level' }))).toBe('');
        expect(upgradeRowActionsHtml(candidate({ type: 'community_buff', buffKey: 'comExp' }))).toBe('');
    });

    test('a house row saves for the room, and never offers a watch on an item it does not buy', () => {
        const html = upgradeRowActionsHtml({
            cost: 1_000_000,
            candidate: { type: 'house', roomHrid: '/house_rooms/dojo', roomName: 'Dojo', upgradeLevel: 3 },
        });

        expect(html).toContain('data-buy-action="save-house"');
        expect(html).toContain('data-house-hrid="/house_rooms/dojo"');
        expect(html).toContain('data-house-level="3"');
        expect(html).not.toContain('data-buy-action="watch"');
    });

    test('the books an ability row needs are read off the price it was costed at', () => {
        expect(abilityBookCount({ costDetail: { books: { books: 39.2, bookName: 'Berserk' } } })).toBe(40);
        // A whole number stays whole rather than being rounded up past itself
        expect(abilityBookCount({ costDetail: { books: { books: 12 } } })).toBe(12);
        // Nothing to read, and a book you cannot count is still one book
        expect(abilityBookCount({})).toBe(1);
        expect(abilityBookCount({ costDetail: { books: { books: 0 } } })).toBe(1);
    });

    test('a row that never priced still counts its books from the character’s own progress', () => {
        mocks.learned = [{ abilityHrid: '/abilities/berserk', level: 65, experience: 65_000 }];
        try {
            // 65 → 70 is 5,000 XP at 500 a book
            expect(
                abilityBookCount({
                    candidate: { upgradeHrid: '/abilities/berserk', upgradeLevel: 70, type: 'ability_level' },
                    cost: null,
                })
            ).toBe(10);
            // Half a level read already: fewer books, rounded up to the whole one you still buy
            mocks.learned = [{ abilityHrid: '/abilities/berserk', level: 65, experience: 65_250 }];
            expect(
                abilityBookCount({
                    candidate: { upgradeHrid: '/abilities/berserk', upgradeLevel: 70, type: 'ability_level' },
                })
            ).toBe(10);
            mocks.learned = [{ abilityHrid: '/abilities/berserk', level: 65, experience: 65_600 }];
            expect(
                abilityBookCount({
                    candidate: { upgradeHrid: '/abilities/berserk', upgradeLevel: 70, type: 'ability_level' },
                })
            ).toBe(9);
        } finally {
            mocks.learned = [];
        }
    });

    test('a house Market button carries its bill, and the click opens it as tabs when the module is there', () => {
        const opened = [];
        mocks.bridgeMissingMats = { openMaterialsList: (lines) => opened.push(lines) };
        try {
            const container = document.createElement('div');
            // Markup as the house row draws it, with a bill of two lines
            container.innerHTML =
                '<button type="button" data-buy-hrid="/items/cedar_lumber" data-buy-level="0" data-buy-quantity="300" ' +
                'data-buy-action="market" data-buy-materials=\'[{"itemHrid":"/items/cedar_lumber","count":300},' +
                '{"itemHrid":"/items/linen_hat","count":16}]\'>Market</button>';
            wireUpgradeRowActions(container);
            container.querySelector('button').click();

            expect(opened).toEqual([
                [
                    { itemHrid: '/items/cedar_lumber', count: 300 },
                    { itemHrid: '/items/linen_hat', count: 16 },
                ],
            ]);
            // Not the one-item open: the tabs are the open
            expect(mocks.marketOpened).toEqual([]);
        } finally {
            mocks.bridgeMissingMats = null;
        }
    });

    test('without that module a house Market button opens its biggest line, as before', () => {
        const container = document.createElement('div');
        container.innerHTML =
            '<button type="button" data-buy-hrid="/items/cedar_lumber" data-buy-level="0" data-buy-quantity="300" ' +
            'data-buy-action="market" data-buy-materials=\'[{"itemHrid":"/items/cedar_lumber","count":300}]\'>Market</button>';
        wireUpgradeRowActions(container);
        container.querySelector('button').click();

        expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0 }]);
        expect(mocks.autofillPending()).toBe(300);
    });

    test('Market on a house row hands the whole bill to the missing-materials tabs', () => {
        const opened = [];
        mocks.bridgeMissingMats = { openMaterialsList: (lines) => opened.push(lines) };
        try {
            const container = document.createElement('div');
            container.innerHTML = upgradeRowActionsHtml({
                cost: 1_000_000,
                candidate: {
                    type: 'house',
                    roomHrid: '/house_rooms/dojo',
                    roomName: 'Dojo',
                    currentLevel: 2,
                    upgradeLevel: 3,
                },
            });
            const button = container.querySelector('[data-buy-action="market"]');
            // No game data in this test, so no materials resolve and no Market button is drawn
            if (!button) {
                expect(container.querySelector('[data-buy-action="save-house"]')).toBeTruthy();
                return;
            }
            wireUpgradeRowActions(container);
            button.click();
            expect(opened).toHaveLength(1);
            expect(mocks.marketOpened).toEqual([]);
        } finally {
            mocks.bridgeMissingMats = null;
        }
    });

    /** A two-hander swapped for a main hand plus an off hand, both at +7 */
    function crossSlotRow() {
        return {
            candidate: {
                description: 'Cursed Bow +7 → Sundering Crossbow +7 + Manticore Shield +7',
                slot: '/equipment_types/two_hand',
                currentHrid: '/items/cursed_bow',
                currentLevel: 7,
                upgradeHrid: '/items/sundering_crossbow',
                upgradeLevel: 7,
                addedSlots: {
                    '/equipment_types/main_hand': { hrid: '/items/sundering_crossbow', enhancementLevel: 7 },
                    '/equipment_types/off_hand': { hrid: '/items/manticore_shield', enhancementLevel: 7 },
                },
                clearedSlots: ['/equipment_types/two_hand'],
                removedItems: [{ hrid: '/items/cursed_bow', enhancementLevel: 7 }],
                type: 'cross_slot',
            },
            cost: 40_000_000,
        };
    }

    test('a cross-slot swap opens both pieces it buys, each at the level it buys them', () => {
        const opened = [];
        mocks.bridgeMissingMats = { openMaterialsList: (lines) => opened.push(lines) };
        try {
            const container = document.createElement('div');
            container.innerHTML = upgradeRowActionsHtml(crossSlotRow());
            const button = container.querySelector('[data-buy-action="market"]');
            wireUpgradeRowActions(container);
            button.click();

            expect(opened).toEqual([
                [
                    { itemHrid: '/items/sundering_crossbow', count: 1, enhancementLevel: 7 },
                    { itemHrid: '/items/manticore_shield', count: 1, enhancementLevel: 7 },
                ],
            ]);
            // The tabs are the open: the row must not also navigate to the
            // first item on its own and leave the shield behind
            expect(mocks.marketOpened).toEqual([]);
            expect(button.title).toContain('manticore shield +7');
        } finally {
            mocks.bridgeMissingMats = null;
        }
    });

    test('a piece the swap takes off and puts back on is not something to buy', () => {
        // `lab-armor-candidates` offers a body/legs pair as soon as ONE slot
        // differs, so the legs already worn are named in `addedSlots` — and in
        // `removedItems`. The bill counts held copies from the INVENTORY, where
        // a worn piece is not, so the tab read "Missing: 1" for trousers that
        // were already on and the row offered to buy them a second time.
        const opened = [];
        mocks.bridgeMissingMats = { openMaterialsList: (lines) => opened.push(lines) };
        try {
            const container = document.createElement('div');
            container.innerHTML = upgradeRowActionsHtml({
                candidate: {
                    description: 'Vampiric Robe Top +5 + Vampiric Robe Bottoms +5',
                    slot: '/equipment_types/body',
                    labArmor: true,
                    currentHrid: '/items/cotton_robe_top',
                    currentLevel: 0,
                    upgradeHrid: '/items/vampiric_robe_top',
                    upgradeLevel: 5,
                    addedSlots: {
                        '/equipment_types/body': { hrid: '/items/vampiric_robe_top', enhancementLevel: 5 },
                        '/equipment_types/legs': { hrid: '/items/vampiric_robe_bottoms', enhancementLevel: 5 },
                    },
                    clearedSlots: [],
                    removedItems: [
                        { hrid: '/items/cotton_robe_top', enhancementLevel: 0 },
                        { hrid: '/items/vampiric_robe_bottoms', enhancementLevel: 5 },
                    ],
                    type: 'cross_slot',
                },
                cost: 12_000_000,
            });
            const button = container.querySelector('[data-buy-action="market"]');
            wireUpgradeRowActions(container);
            button.click();

            expect(opened).toEqual([[{ itemHrid: '/items/vampiric_robe_top', count: 1, enhancementLevel: 5 }]]);
        } finally {
            mocks.bridgeMissingMats = null;
        }
    });

    test('and without that module it still opens the piece it can, as before', () => {
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(crossSlotRow());
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="market"]').click();

        expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/sundering_crossbow', enhancementLevel: 7 }]);
    });

    test('a single-piece gear row keeps the plain open, with no bill at all', () => {
        const opened = [];
        mocks.bridgeMissingMats = { openMaterialsList: (lines) => opened.push(lines) };
        try {
            const container = document.createElement('div');
            container.innerHTML = upgradeRowActionsHtml(
                candidate({
                    upgradeHrid: '/items/plate',
                    upgradeLevel: 7,
                    type: 'cross_slot',
                    addedSlots: { '/equipment_types/body': { hrid: '/items/plate', enhancementLevel: 7 } },
                })
            );
            const button = container.querySelector('[data-buy-action="market"]');
            expect(button.hasAttribute('data-buy-materials')).toBe(false);
            expect(button.getAttribute('data-buy-level')).toBe('7');

            wireUpgradeRowActions(container);
            button.click();

            expect(opened).toEqual([]);
            expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/plate', enhancementLevel: 7 }]);
        } finally {
            mocks.bridgeMissingMats = null;
        }
    });

    /** An ability row costed at 39.2 books, i.e. 40 to buy */
    function abilityRow() {
        return {
            candidate: {
                description: 'Berserk Lv65 → Lv70',
                upgradeHrid: '/abilities/berserk',
                upgradeLevel: 70,
                type: 'ability_level',
            },
            cost: 140_600_000,
            costDetail: { books: { books: 39.2, bookName: 'Berserk' } },
        };
    }

    test('Market on an ability row hands its books to the missing-materials tabs, as a one-line bill', () => {
        const opened = [];
        mocks.bridgeMissingMats = { openMaterialsList: (lines) => opened.push(lines) };
        try {
            const container = document.createElement('div');
            container.innerHTML = upgradeRowActionsHtml(abilityRow());
            const button = container.querySelector('[data-buy-action="market"]');
            expect(button.getAttribute('data-buy-quantity')).toBe('40');

            wireUpgradeRowActions(container);
            button.click();

            expect(opened).toEqual([[{ itemHrid: '/items/berserk', count: 40 }]]);
            // The tabs do the opening; the row does not also navigate itself
            expect(mocks.marketOpened).toEqual([]);
            expect(button.title).toContain('still short');
        } finally {
            mocks.bridgeMissingMats = null;
        }
    });

    test('and without that module the fallback arms one shot, for that book alone', () => {
        // The armed count used to be a standing recalculation tied to no item,
        // so 760 books left unbought went on filling the quantity box of every
        // later order modal — a dungeon key's Buy Listing included
        const container = document.createElement('div');
        container.innerHTML = upgradeRowActionsHtml(abilityRow());
        wireUpgradeRowActions(container);
        container.querySelector('[data-buy-action="market"]').click();

        expect(mocks.marketOpened).toEqual([{ itemHrid: '/items/berserk', enhancementLevel: 0 }]);
        const armed = mocks.autofill.at(-1);
        expect(armed.event).toBe('setQuantity');
        expect(armed.quantity).toBe(40);
        expect(armed.options).toEqual({ itemHrid: '/items/berserk' });
    });

    test('and Market on a gear row arms nothing, so a sword never inherits a book count', () => {
        const books = document.createElement('div');
        books.innerHTML = upgradeRowActionsHtml({
            candidate: { upgradeHrid: '/abilities/berserk', upgradeLevel: 70, type: 'ability_level' },
            costDetail: { books: { books: 39.2 } },
        });
        wireUpgradeRowActions(books);
        books.querySelector('[data-buy-action="market"]').click();

        const gear = document.createElement('div');
        gear.innerHTML = upgradeRowActionsHtml(
            candidate({ upgradeHrid: '/items/plate', upgradeLevel: 7, type: 'tier' })
        );
        expect(gear.querySelector('[data-buy-action="market"]').getAttribute('data-buy-quantity')).toBe('1');

        wireUpgradeRowActions(gear);
        gear.querySelector('[data-buy-action="market"]').click();

        expect(mocks.autofill.at(-1).event).toBe('clearQuantity');
        expect(mocks.autofillPending).toBeNull();
    });

    test('one observer for the whole panel, however many rows are handed off', () => {
        const html = upgradeRowActionsHtml({
            candidate: { upgradeHrid: '/abilities/berserk', upgradeLevel: 70, type: 'ability_level' },
            costDetail: { books: { books: 39.2 } },
        });
        for (const _ of [0, 1, 2]) {
            const container = document.createElement('div');
            container.innerHTML = html;
            wireUpgradeRowActions(container);
            container.querySelector('[data-buy-action="market"]').click();
        }

        expect(mocks.autofillObservers).toEqual(['CombatSimUpgrade-Market']);
    });

    test('Market does not also unfold the row it sits in', () => {
        const row = document.createElement('div');
        let rowClicks = 0;
        row.addEventListener('click', () => {
            rowClicks++;
        });
        row.innerHTML = upgradeRowActionsHtml(candidate({ upgradeHrid: '/items/plate', type: 'tier' }));
        wireUpgradeRowActions(row);

        row.querySelector('[data-buy-action="market"]').click();

        expect(mocks.marketOpened).toHaveLength(1);
        expect(rowClicks).toBe(0);
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

    test('the collapsed title says nothing about noise — the expanded detail does', () => {
        // A chip on the row title competed with the row's own name and never
        // said which figure was inside the error bar; the per-metric annotation
        // in the detail says exactly that, beside the number it is about
        expect(upgradeRowNotesHtml(noisy())).not.toContain('within noise');
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

    test('a free fill of an owned book says that is why it is free', () => {
        // A row costing 0 is the one a reader is right to distrust. "from Lv14"
        // explains a cost that was never paid; this says there was nothing to pay
        const html = upgradeRowNotesHtml({
            candidate: { description: 'Free slot → Ice Spear', type: 'ability_swap', fillsFreeSlot: true },
            costDetail: {
                freshBook: false,
                ownedFromLevel: 14,
                ownedNotSlotted: true,
                books: { books: 0, bookName: 'Ice Spear' },
            },
            significantBy: { dps: true, profit: true },
        });

        expect(html).toContain('book owned');
        expect(html).toContain('just not slotted');
        expect(html).toContain('Lv14');
        expect(html).not.toContain('>from Lv14<');
        expect(html).not.toContain('>fresh book<');
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

    test('shopping for profit passes over a row whose profit gain is noise while a measured one fits', () => {
        const plan = planUpgradeBudget(
            [
                mixed('Noisy ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 90 }),
                row('Measured neck', { slot: '/equipment_types/neck', cost: 100, profitGain: 50 }),
            ],
            100,
            { baseline: BASELINE, metricKey: 'profit' }
        );

        // The bigger gain loses, because it is the one that was not measured
        expect(plan.picks.map((p) => p.candidate.description)).toEqual(['Measured neck']);
        expect(plan.provisional).toBe(false);
        expect(plan.skipped.some((s) => s.reason.includes('noise'))).toBe(true);
    });

    test('but when nothing on the axis clears the noise it plans on the estimates rather than planning nothing', () => {
        // "Not proven" is not "worth zero" — an empty plan in front of a table
        // full of affordable positive rows is the wrong answer, not a cautious one
        const plan = planUpgradeBudget([mixed('Ring', { profitGain: 50 })], 1000, {
            baseline: BASELINE,
            metricKey: 'profit',
        });

        expect(plan.picks.map((p) => p.candidate.description)).toEqual(['Ring']);
        expect(plan.provisional).toBe(true);
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

/**
 * A SimResult with just the fields the Results tab reads, at rates that are
 * round numbers over one hour so an assertion can name the value it expects.
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object} SimResult-shaped object
 */
function oneHourFight(overrides = {}) {
    return {
        encounters: 1200,
        deaths: { player1: 0 },
        experienceGained: { player1: { attack: 1000, stamina: 500 } },
        consumablesUsed: { player1: {} },
        totalDamageDealt: { player1: 3600 * 500 },
        simulatedTime: 3600 * 1e9,
        playerRanOutOfMana: { player1: false },
        numberOfPlayers: 1,
        ...overrides,
    };
}

/** Put a run on screen through the real display path. */
function showFight(simResult = oneHourFight(), hours = 1) {
    ui._playerInfo = [{ hrid: 'player1', name: 'Me' }];
    ui._activePlayerTab = 'player1';
    ui._lastSimResult = simResult;
    ui._lastSimHours = hours;
    ui._lastGameData = { itemDetailMap: {} };
    ui._displayResults(simResult, hours, ui._lastGameData);
    return ui.panel.querySelector('#mwi-csim-results');
}

/** Push a finished run into the comparison history without running a sim. */
function pushHistory(label, simResult = oneHourFight(), hours = 1) {
    ui._simHistory.push({
        label,
        simResult,
        hours,
        gameData: { itemDetailMap: {} },
        metrics: null,
        timestamp: Date.now(),
    });
    ui._activeDetailIndex = ui._simHistory.length - 1;
}

describe('the summary at the top of the Results tab', () => {
    beforeEach(() => {
        mocks.drops = new Map();
        mocks.prices = {};
        mocks.pricingMode = 'hybrid';
        mocks.patientTick = false;
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        mocks.drops = new Map();
        mocks.prices = {};
        mocks.pricingMode = 'hybrid';
        mocks.patientTick = false;
    });

    test('leads with the per-day numbers, above every section that argues them', () => {
        const results = showFight();
        const shown = results.textContent;

        expect(shown).toContain('Summary');
        expect(shown).toContain('Profit/day');
        expect(shown).toContain('XP/hr');
        expect(shown).toContain('Kills/hr');
        expect(shown).toContain('Deaths/hr');
        // Up top is the whole point: burying it under Overview would be the bug
        expect(shown.indexOf('Summary')).toBeLessThan(shown.indexOf('Overview'));
        // And the marker itself must never survive into the page
        expect(results.innerHTML).not.toContain('mwi-csim-summary');
    });

    test('reports the same profit the Net Profit section works out', () => {
        // 1200 coins an hour in, 200 gold an hour of cheese out
        mocks.drops = new Map([['/items/coin', 1200]]);
        mocks.prices['/items/cheese'] = { bid: 10, ask: 10 };
        const shown = showFight(oneHourFight({ consumablesUsed: { player1: { '/items/cheese': 20 } } })).textContent;

        // (1200 − 200) × 24 = 24.0K a day
        expect(shown).toContain('24.0K');
        expect(shown).toContain('Revenue 28.8K/day');
        expect(shown).toContain('Costs 4.8K/day');
    });

    test('a patientBuy consumable cost steps one tick above the bid when the patient tick is on', () => {
        // Regression for the Results detail view mapping ask/bid itself and
        // never honouring `profitCalc_patientTickBuy`. `_getBuyPrice` now routes
        // through `getItemPrice`, so under patientBuy pricing the cheese buy
        // price sits at the bid, ticked up one when the setting is on.
        mocks.prices['/items/cheese'] = { bid: 10, ask: 12 };
        mocks.pricingMode = 'patientBuy';

        mocks.patientTick = false;
        const off = showFight(oneHourFight({ consumablesUsed: { player1: { '/items/cheese': 20 } } })).textContent;
        // 20 × 10 = 200/hr = 4.8K/day
        expect(off).toContain('Costs 4.8K/day');

        mocks.patientTick = true;
        const on = showFight(oneHourFight({ consumablesUsed: { player1: { '/items/cheese': 20 } } })).textContent;
        // 20 × 11 = 220/hr = 5.28K/day, rounded to 5.3K — this line fails
        // pre-fix, since the old local ask/bid mapping never applied the tick
        expect(on).toContain('Costs 5.3K/day');
    });

    test('an optimistic sell price steps one tick below the ask when the patient tick is on', () => {
        // Same regression on the revenue side: `_getSellPrice` now routes
        // through `getItemPrice` too, so under optimistic pricing (patient
        // sell) the drop's sell price sits at the ask, ticked down one.
        mocks.drops = new Map([['/items/cheese', 100]]);
        mocks.prices['/items/cheese'] = { bid: 8, ask: 10 };
        mocks.pricingMode = 'optimistic';

        mocks.patientTick = false;
        const off = showFight(oneHourFight()).textContent;
        // 100 × 10 ask, net of 5% market tax = 950/hr = 22.8K/day
        expect(off).toContain('Revenue 22.8K/day');

        mocks.patientTick = true;
        const on = showFight(oneHourFight()).textContent;
        // 100 × 9 ticked ask, net of 5% tax = 855/hr = 20.52K/day, rounded to
        // 20.5K — this line fails pre-fix
        expect(on).toContain('Revenue 20.5K/day');
    });

    test('the pricing quick-settings row sits above the results, with Buy/Sell/Key selects', () => {
        showFight();
        const row = ui.panel.querySelector('#mwi-csim-results-pricing');

        expect(row).toBeTruthy();
        const selects = row.querySelectorAll('select');
        expect(selects).toHaveLength(3);
        expect(selects[0].dataset.mwiPricingSide).toBe('buy');
        expect(selects[1].dataset.mwiPricingSide).toBe('sell');
        expect(selects[2].dataset.mwiKeyPricing).toBe('true');
    });

    // The reprice is coalesced into a microtask (see `_scheduleReprice`), so
    // any test that fires a pricing change lets one tick pass before reading
    // the redrawn results.
    const tick = () => Promise.resolve();

    test('choosing a Key pricing option re-prices the displayed run without a re-run', async () => {
        mocks.drops = new Map([['/items/coin', 1200]]);
        showFight();
        const simResultBefore = ui._lastSimResult;

        const keySelect = ui.panel.querySelector('#mwi-csim-results-pricing select[data-mwi-key-pricing]');
        keySelect.value = 'craft';
        keySelect.dispatchEvent(new Event('change'));
        await tick();

        // The write reached config, and the results redrew from the very same
        // cached simResult object — nothing here re-ran the simulation
        expect(mocks.keyPricingMode).toBe('craft');
        expect(ui._lastSimResult).toBe(simResultBefore);
        expect(ui.panel.querySelector('#mwi-csim-results').textContent).not.toContain('could not be drawn');
    });

    test('a Buy/Sell pricing change made elsewhere resyncs the row and re-prices the run', async () => {
        mocks.drops = new Map([['/items/cheese', 100]]);
        mocks.prices['/items/cheese'] = { bid: 8, ask: 10 };
        showFight();

        // As the main settings panel or Party Loot's copy of the row would do
        mocks.pricingMode = 'optimistic';
        mocks.settingChangeCallbacks.get('profitCalc_pricingMode')?.('profitCalc_pricingMode', 'optimistic');

        // The dropdown resync is not deferred — only the reprice is — so this
        // reflects the new setting immediately
        const buySelect = ui.panel.querySelector('#mwi-csim-results-pricing select[data-mwi-pricing-side="buy"]');
        expect(buySelect.value).toBe('patient');

        await tick();
        // Revenue moved to the ask-side price optimistic pricing implies
        expect(ui.panel.querySelector('#mwi-csim-results').textContent).toContain('Revenue 22.8K/day');
    });

    test('one Buy/Sell choice redraws the results exactly once', async () => {
        mocks.drops = new Map([['/items/cheese', 100]]);
        mocks.prices['/items/cheese'] = { bid: 8, ask: 10 };
        showFight();

        const displaySpy = vi.spyOn(ui, '_displayResults');
        // "Patient +1" writes both the combined pricing mode and that side's
        // patient tick — two settings, each with its own listener — plus the
        // row's own onChange. Before coalescing this was up to three redraws.
        const buySelect = ui.panel.querySelector('#mwi-csim-results-pricing select[data-mwi-pricing-side="buy"]');
        buySelect.value = 'patientTick';
        buySelect.dispatchEvent(new Event('change'));
        await tick();

        expect(displaySpy).toHaveBeenCalledTimes(1);
        displaySpy.mockRestore();
    });

    test('a history run priced before a pricing change is re-priced rather than compared stale', () => {
        mocks.drops = new Map([['/items/cheese', 100]]);
        mocks.prices['/items/cheese'] = { bid: 8, ask: 10 };
        mocks.pricingMode = 'optimistic';
        pushHistory('Baseline');
        const entry = ui._simHistory[ui._simHistory.length - 1];

        ui._ensureHistoryMetrics('player1');
        const before = entry.metrics.revenuePerHr;
        expect(before).toBeGreaterThan(0);

        // The live detail view now prices the drop at 9; the baseline's metrics must follow
        mocks.patientTick = true;
        ui._ensureHistoryMetrics('player1');
        expect(entry.metrics.revenuePerHr).toBeCloseTo((before * 9) / 10, 6);
    });

    test('a key pricing change alone re-prices history metrics', () => {
        mocks.drops = new Map([['/items/cheese', 100]]);
        mocks.prices['/items/cheese'] = { bid: 8, ask: 10 };
        pushHistory('Baseline');
        const entry = ui._simHistory[ui._simHistory.length - 1];

        ui._ensureHistoryMetrics('player1');
        const first = entry.metrics;

        // Dungeon key costs follow this setting, so metrics stamped before it are stale.
        // Flipped relative to whatever an earlier test left, so it is always a change
        const before = mocks.keyPricingMode;
        mocks.keyPricingMode = before === 'craft' ? 'bid' : 'craft';
        ui._ensureHistoryMetrics('player1');
        expect(entry.metrics).not.toBe(first);
        mocks.keyPricingMode = before;
    });

    test('XP/hr is the same total the XP section adds up', () => {
        // 1500 xp/hr on the tile, with the two skills still named per day beside it
        const shown = showFight().textContent;

        expect(shown).toContain('XP/hr1.5K');
        expect(shown).toContain('Attack 24.0K');
        expect(shown).toContain('Stamina 12.0K');
    });

    test('a dungeon is summarised on the average clear rather than on encounters', () => {
        // 6 clears in an hour is one every ten minutes
        const shown = showFight(
            oneHourFight({ isDungeon: true, dungeonsCompleted: 6, dungeonsFailed: 2, maxWaveReached: 9 })
        ).textContent;

        expect(shown).toContain('Avg clear0h 10m 00s');
        expect(shown).toContain('Success');
        expect(shown).toContain('75.0%');
        expect(shown).not.toContain('Kills/hr');
    });

    test('a dungeon that never completes shows no clear time rather than an infinity', () => {
        const shown = showFight(oneHourFight({ isDungeon: true, dungeonsCompleted: 0, dungeonsFailed: 4 })).textContent;

        expect(shown).toContain('Avg clear—');
        expect(shown).toContain('0.0%');
    });

    test('deaths are a daily figure, because the hourly one rounds to never', () => {
        // One death every fifty hours. Three decimals is what makes an hourly
        // rate legible here: 0.020 is a number a player can act on, where the
        // rounded "0" this used to avoid by switching to days was not
        const shown = showFight(oneHourFight({ deaths: { player1: 0.02 } })).textContent;

        expect(shown).toContain('Deaths/hr0.020');
    });

    test('the Deaths/hr delta is shown to the same decimals as the figure it annotates', () => {
        // The reported case: 0.020 deaths/hr against a baseline of 1.0 read
        // "(-1)" — a delta rounded to whole deaths beside a value in thousandths
        pushHistory('Baseline', oneHourFight({ deaths: { player1: 1 } }));
        ui._comparisonBaseline = 0;
        // Draw the passed-in run, not whatever pushHistory left selected
        ui._activeDetailIndex = null;
        const shown = showFight(oneHourFight({ deaths: { player1: 0.02 } })).textContent;

        expect(shown).toContain('Deaths/hr0.020');
        expect(shown).toContain('-0.980');
        expect(shown).not.toContain('(-1)');
    });

    test('a Deaths/hr change too small to show in the figure draws no delta', () => {
        pushHistory('Baseline', oneHourFight({ deaths: { player1: 0.0201 } }));
        ui._comparisonBaseline = 0;
        ui._activeDetailIndex = null;
        const shown = showFight(oneHourFight({ deaths: { player1: 0.02 } })).textContent;

        expect(shown).toContain('Deaths/hr0.020');
        expect(shown).not.toContain('-0.000');
    });

    test('Overview shows Deaths/hr to three decimals, so safe builds stay comparable', () => {
        // The reported case: two builds a factor of twenty apart in real death
        // rate both used to read as a rounded integer in Overview.
        const safe = showFight(oneHourFight({ deaths: { player1: 0.042 } })).textContent;
        expect(safe).toContain('Deaths/hr0.042');

        // A whole number keeps the same fixed three decimals — constant width is
        // what lets two results be read against each other digit by digit.
        const one = showFight(oneHourFight({ deaths: { player1: 1 } })).textContent;
        expect(one).toContain('Deaths/hr1.000');

        // And no deaths at all is 0.000, not a bare "0"
        const none = showFight(oneHourFight({ deaths: { player1: 0 } })).textContent;
        expect(none).toContain('Deaths/hr0.000');
    });

    test('the Summary deaths tile is hourly, to the same three decimals as Overview', () => {
        // The tile and the Overview row are the same quantity and must not be
        // the one figure on screen in a different unit
        const shown = showFight(oneHourFight({ deaths: { player1: 1 } })).textContent;
        expect(shown).toContain('Deaths/hr1.000');
    });

    /**
     * Regression: Deaths/hr, party DPS and per-player DPS coalesced a missing
     * player in the comparison run to 0 rather than "no data" — so comparing
     * against a baseline run fought by a different party drew a real green/red
     * delta badge that was purely an artifact of the player never having been
     * in that run. The XP section already got this right (it only builds a
     * previous value when the player appears in the baseline); these three
     * should follow the same rule.
     */
    test('Deaths/hr and DPS carry no delta for a player absent from the comparison run', () => {
        // Baseline: a solo run — player2 never fought in it
        pushHistory('Solo baseline', oneHourFight());
        ui._comparisonBaseline = 0;

        const partyResult = oneHourFight({
            deaths: { player1: 0, player2: 0.5 },
            totalDamageDealt: { player1: 3600 * 500, player2: 3600 * 400 },
            numberOfPlayers: 2,
        });
        ui._playerInfo = [
            { hrid: 'player1', name: 'Me' },
            { hrid: 'player2', name: 'Ally' },
        ];
        ui._activePlayerTab = 'player2';
        // Not part of history — _displayResults must draw the passed-in
        // result rather than substituting whatever pushHistory left selected
        ui._activeDetailIndex = null;

        const spy = vi.spyOn(ui, '_formatDelta');
        ui._displayResults(partyResult, 1, { itemDetailMap: {} });

        // Deaths/hr for player2: current value 0.5, higherIsBetter=false
        const deathsCall = spy.mock.calls.find((args) => args[0] === 0.5 && args[2] === false);
        expect(deathsCall?.[1]).toBeNull();

        // Party DPS: player2 missing from the baseline means the whole party
        // total is unknowable for comparison — not "player1's damage alone"
        const partyDps = (3600 * 500 + 3600 * 400) / 3600;
        const partyCall = spy.mock.calls.find((args) => args[0] === partyDps);
        expect(partyCall?.[1]).toBeNull();

        // Player2's own DPS row
        const playerDps = (3600 * 400) / 3600;
        const playerCall = spy.mock.calls.find((args) => args[0] === playerDps);
        expect(playerCall?.[1]).toBeNull();

        spy.mockRestore();
    });

    test('party lint warnings render in amber directly under the summary', () => {
        ui._lastPartyWarnings = ['Player11 has skilling gear equipped: Foraging Shears'];
        const shown = showFight().textContent;

        expect(shown).toContain('Player11 has skilling gear equipped: Foraging Shears');
        expect(shown.indexOf('Summary')).toBeLessThan(shown.indexOf('Player11 has skilling gear'));
    });

    test('and are absent entirely when there is nothing to warn about', () => {
        ui._lastPartyWarnings = [];
        const shown = showFight().textContent;

        expect(shown).not.toContain('skilling gear');
        expect(shown).not.toContain('auras do not stack');
    });

    /**
     * A run long enough to out-kill a task reports a rate averaged over the
     * part that carried the bonus and the part that did not, so the note says
     * where the line fell — per task, because two tasks end at two points.
     */
    describe('the note about a task finishing mid-run', () => {
        const GAME_DATA = {
            combatMonsterDetailMap: { '/monsters/fly': { name: 'Fly' }, '/monsters/rat': { name: 'Rat' } },
        };

        test('names each task that ran out, and how much of the run it covered', () => {
            const notes = ui._taskDamageNotes(
                {
                    taskDamageMode: 'perMonster',
                    taskDamageKills: {
                        '/monsters/fly': { onTask: 250, offTask: 750 },
                        '/monsters/rat': { onTask: 40, offTask: 60 },
                    },
                },
                GAME_DATA
            );

            expect(notes).toHaveLength(2);
            expect(notes[0]).toContain('Fly');
            expect(notes[0]).toContain('250 of 1,000');
            expect(notes[0]).toContain('25%');
            expect(notes[1]).toContain('Rat');
        });

        test('says nothing about a task that lasted the whole run', () => {
            const notes = ui._taskDamageNotes(
                { taskDamageMode: 'perMonster', taskDamageKills: { '/monsters/fly': { onTask: 90, offTask: 0 } } },
                GAME_DATA
            );

            expect(notes).toEqual([]);
        });

        test('and nothing at all in the other two modes', () => {
            const tallies = { '/monsters/fly': { onTask: 10, offTask: 90 } };

            expect(ui._taskDamageNotes({ taskDamageMode: 'off', taskDamageKills: tallies }, GAME_DATA)).toEqual([]);
            expect(ui._taskDamageNotes({ taskDamageMode: 'everyFight', taskDamageKills: tallies }, GAME_DATA)).toEqual(
                []
            );
            expect(ui._taskDamageNotes({}, GAME_DATA)).toEqual([]);
        });
    });
});

/**
 * Game data for the party lint: a skilling tool, a combat sword, a real aura,
 * a self-only special and a plain damage ability — the shapes the detectors
 * have to tell apart.
 */
const LINT_GAME_DATA = {
    itemDetailMap: {
        '/items/foraging_shears': {
            name: 'Foraging Shears',
            equipmentDetail: {
                type: '/equipment_types/foraging_tool',
                combatStats: { attackInterval: 0 },
                noncombatStats: { foragingSpeed: 0.3 },
            },
        },
        '/items/foragers_top': {
            name: "Forager's Top",
            equipmentDetail: {
                type: '/equipment_types/body',
                combatStats: {},
                noncombatStats: { foragingExperience: 0.1 },
            },
        },
        '/items/vampiric_sword': {
            name: 'Vampiric Sword',
            equipmentDetail: {
                type: '/equipment_types/main_hand',
                combatStats: { attackInterval: 3e9, lifeSteal: 0.05 },
                noncombatStats: { foragingSpeed: 0 },
            },
        },
    },
    abilityDetailMap: {
        '/abilities/fierce_aura': {
            name: 'Fierce Aura',
            isSpecialAbility: true,
            abilityEffects: [
                {
                    targetType: 'allAllies',
                    effectType: '/ability_effect_types/buff',
                    buffs: [{ uniqueHrid: '/buff_uniques/fierce_aura' }],
                },
            ],
        },
        '/abilities/vampirism': {
            name: 'Vampirism',
            isSpecialAbility: true,
            abilityEffects: [
                {
                    targetType: 'self',
                    effectType: '/ability_effect_types/buff',
                    buffs: [{ uniqueHrid: '/buff_uniques/vampirism' }],
                },
            ],
        },
        '/abilities/sweep': {
            name: 'Sweep',
            isSpecialAbility: false,
            abilityEffects: [{ targetType: 'enemy', effectType: '/ability_effect_types/damage', buffs: null }],
        },
    },
};

const LINT_INFO = [
    { hrid: 'player1', name: 'Player11' },
    { hrid: 'player2', name: 'Aster' },
    { hrid: 'player3', name: 'Tib' },
];

/** A party member DTO with just the fields the lint reads. */
function partyMember(hrid, { equipment = {}, abilities = [] } = {}) {
    return { hrid, equipment, abilities };
}

describe('linting a loaded party', () => {
    test('a member wearing skilling gear in a combat slot is named, tools are not', () => {
        // The shears live in a tool slot, which has no combat equivalent and is
        // always occupied — never a mistake. The top displaces real armour.
        const party = [
            partyMember('player1', {
                equipment: {
                    '/equipment_types/foraging_tool': { hrid: '/items/foraging_shears', enhancementLevel: 5 },
                    '/equipment_types/body': { hrid: '/items/foragers_top', enhancementLevel: 3 },
                    '/equipment_types/main_hand': { hrid: '/items/vampiric_sword', enhancementLevel: 8 },
                },
            }),
            partyMember('player2'),
        ];

        const warnings = skillingGearWarnings(party, LINT_INFO, LINT_GAME_DATA.itemDetailMap);

        expect(warnings).toEqual(["Player11 has skilling gear equipped: Forager's Top"]);
    });

    test('a party in clean combat gear is not flagged', () => {
        const party = [
            partyMember('player1', {
                equipment: { '/equipment_types/main_hand': { hrid: '/items/vampiric_sword', enhancementLevel: 8 } },
            }),
            partyMember('player2', {
                equipment: { '/equipment_types/main_hand': { hrid: '/items/vampiric_sword', enhancementLevel: 2 } },
            }),
        ];

        expect(skillingGearWarnings(party, LINT_INFO, LINT_GAME_DATA.itemDetailMap)).toEqual([]);
    });

    test('the same aura on two members is one warning naming both', () => {
        const party = [
            partyMember('player1', { abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }, null, null] }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/fierce_aura', level: 55 }, null, null] }),
        ];

        const warnings = duplicateAuraWarnings(party, LINT_INFO, LINT_GAME_DATA.abilityDetailMap);

        expect(warnings).toEqual(['Fierce Aura is equipped by Player11 and Aster — auras do not stack']);
    });

    test('one aura on one member is the correct number and says nothing', () => {
        const party = [
            partyMember('player1', { abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }, null, null] }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/sweep', level: 60 }, null, null] }),
        ];

        expect(duplicateAuraWarnings(party, LINT_INFO, LINT_GAME_DATA.abilityDetailMap)).toEqual([]);
    });

    test('a self-only special on two members is not an aura and is left alone', () => {
        // Vampirism buffs only its caster, so two copies really are two buffs
        const party = [
            partyMember('player1', { abilities: [{ hrid: '/abilities/vampirism', level: 40 }] }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/vampirism', level: 55 }] }),
        ];

        expect(duplicateAuraWarnings(party, LINT_INFO, LINT_GAME_DATA.abilityDetailMap)).toEqual([]);
    });

    test('a solo run produces no warnings at all, whatever is equipped', () => {
        const solo = [
            partyMember('player1', {
                equipment: { '/equipment_types/foraging_tool': { hrid: '/items/foraging_shears' } },
                abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }],
            }),
        ];

        expect(partyLintWarnings(solo, LINT_INFO, LINT_GAME_DATA)).toEqual([]);
    });

    test('a party collects both kinds of warning through one call', () => {
        const party = [
            partyMember('player1', {
                equipment: { '/equipment_types/body': { hrid: '/items/foragers_top' } },
                abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }],
            }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/fierce_aura', level: 55 }] }),
            partyMember('player3', { abilities: [{ hrid: '/abilities/fierce_aura', level: 12 }] }),
        ];

        expect(partyLintWarnings(party, LINT_INFO, LINT_GAME_DATA)).toEqual([
            "Player11 has skilling gear equipped: Forager's Top",
            'Fierce Aura is equipped by Player11, Aster and Tib — auras do not stack',
        ]);
    });

    test('the predicates read the stats, not the names', () => {
        expect(isSkillingGearItem(LINT_GAME_DATA.itemDetailMap['/items/foraging_shears'])).toBe(true);
        expect(isSkillingGearItem(LINT_GAME_DATA.itemDetailMap['/items/vampiric_sword'])).toBe(false);
        expect(isSkillingGearItem(undefined)).toBe(false);
        expect(isAuraAbility(LINT_GAME_DATA.abilityDetailMap['/abilities/fierce_aura'])).toBe(true);
        expect(isAuraAbility(LINT_GAME_DATA.abilityDetailMap['/abilities/vampirism'])).toBe(false);
        expect(isAuraAbility(LINT_GAME_DATA.abilityDetailMap['/abilities/sweep'])).toBe(false);
        expect(isAuraAbility(undefined)).toBe(false);
    });
});

describe('a dungeon run with no wave figure', () => {
    beforeEach(() => {
        mocks.drops = new Map();
        mocks.prices = {};
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        mocks.drops = new Map();
        mocks.prices = {};
    });

    test('says so rather than printing the word undefined', () => {
        const shown = showFight(oneHourFight({ isDungeon: true, dungeonsCompleted: 6, dungeonsFailed: 2 })).textContent;

        expect(shown).toContain('Max wave reached');
        expect(shown).not.toContain('undefined');
    });

    test('a real wave figure is still shown', () => {
        const shown = showFight(
            oneHourFight({ isDungeon: true, dungeonsCompleted: 6, dungeonsFailed: 2, maxWaveReached: 9 })
        ).textContent;

        expect(shown).toContain('Max wave reached9');
    });
});

describe('the comparison table Success column', () => {
    beforeEach(() => {
        mocks.drops = new Map();
        mocks.prices = {};
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        mocks.drops = new Map();
        mocks.prices = {};
    });

    test('its delta carries the same decimal the rate beside it is shown to', () => {
        // Rounded to whole points, a clear rate moving 75.0% -> 75.4% showed
        // nothing at all, and the same size of move the other side of a
        // boundary showed a full point. Same fault as the Deaths/hr delta.
        pushHistory('Baseline', oneHourFight({ isDungeon: true, dungeonsCompleted: 6, dungeonsFailed: 2 }));
        pushHistory('Sharper', oneHourFight({ isDungeon: true, dungeonsCompleted: 98, dungeonsFailed: 32 }));
        ui._comparisonBaseline = 0;
        ui._comparisonSlots = [1];
        ui._activeDetailIndex = null;

        const shown = showFight(oneHourFight({ isDungeon: true, dungeonsCompleted: 6, dungeonsFailed: 2 })).textContent;

        expect(shown).toContain('75.4%');
        expect(shown).toContain('+0.4');
    });
});

describe('clearing the comparison history', () => {
    beforeEach(() => {
        mocks.drops = new Map();
        mocks.prices = {};
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
        mocks.drops = new Map();
        mocks.prices = {};
    });

    test('Clear all throws away every run, baseline and comparison pick', () => {
        pushHistory('Current Gear');
        pushHistory('New Chest');
        ui._comparisonBaseline = 0;
        ui._comparisonSlots = [1];
        const results = showFight();

        expect(results.textContent).toContain('Comparison (2 runs)');
        results.querySelector('#mwi-csim-history-clear').click();

        expect(ui._simHistory).toEqual([]);
        expect(ui._comparisonBaseline).toBeNull();
        expect(ui._comparisonSlots).toEqual([]);
        expect(ui._activeDetailIndex).toBeNull();
        expect(results.style.display).toBe('none');
        expect(text()).toContain('Cleared all saved runs.');
    });

    test('a long run label shrinks the baseline select rather than the row', () => {
        // A flex child's min-width defaults to its content, and a select's
        // content width is its widest option: without min-width:0 one long
        // saved run stretched the row until Export CSV and Clear all sat past
        // the panel edge. The buttons stay unshrinkable, so the select is the
        // one that gives.
        pushHistory('Current Gear');
        pushHistory('New Chest with a saved run label long enough to stretch the whole row past the panel edge');
        ui._comparisonBaseline = 0;
        const results = showFight();

        const select = results.querySelector('#mwi-csim-baseline-select');
        expect(select.getAttribute('style')).toMatch(/min-width:\s*0/);
        expect(select.getAttribute('style')).toMatch(/flex:\s*1 1 0/);
        for (const id of ['#mwi-csim-history-csv', '#mwi-csim-history-clear']) {
            expect(results.querySelector(id).getAttribute('style')).toMatch(/flex-shrink:\s*0/);
        }
    });

    test('the per-run ✕ still removes only that run', () => {
        pushHistory('Current Gear');
        pushHistory('New Chest');
        ui._comparisonBaseline = 0;
        ui._comparisonSlots = [1];
        const results = showFight();

        results.querySelector('[data-delete-history="1"]').click();

        expect(ui._simHistory.map((e) => e.label)).toEqual(['Current Gear']);
    });

    test('clearing an empty history is a no-op rather than a status line', () => {
        showFight();
        ui._setStatus('Simulation complete.');
        ui._clearAllHistory();

        expect(text()).toContain('Simulation complete.');
    });
});

describe('the ⚙ Columns popover', () => {
    const results = () => ({
        baseline: BASELINE,
        results: [
            row('Cheap ring', { slot: '/equipment_types/ring', cost: 100 }),
            row('Pricey neck', { slot: '/equipment_types/neck', cost: 1000 }),
        ],
        food: null,
    });

    const menu = () => ui.panel.querySelector('#mwi-csim-upgrade-cols-menu');

    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onRun = null;
        ui.buildPanel();
        ui._upgradeColumnMenuOpen = false;
    });

    afterEach(() => {
        ui._setUpgradeColumnMenuOpen(false);
        ui.destroy();
    });

    test('starts closed, and a fresh render leaves it closed', () => {
        // It was drawn with `display:none` first and `display:flex` later in the
        // same style attribute, so the later declaration won and the popover
        // came back up on every sort, tick, replan and analysis
        ui._renderUpgradeResults(results());

        expect(menu().style.display).toBe('none');
    });

    test('opens on a click of its own button', () => {
        ui._renderUpgradeResults(results());
        ui.panel.querySelector('#mwi-csim-upgrade-cols-btn').click();

        expect(ui._upgradeColumnMenuOpen).toBe(true);
        expect(menu().style.display).toBe('flex');
    });

    test('and stays closed once closed, however often the table is rebuilt', () => {
        ui._renderUpgradeResults(results());
        const button = ui.panel.querySelector('#mwi-csim-upgrade-cols-btn');
        button.click();
        button.click();

        expect(ui._upgradeColumnMenuOpen).toBe(false);

        // Sorting, re-scoring and a second analysis all come back through here
        ui._renderUpgradeResults(results());
        ui._renderUpgradeResults(results());

        expect(menu().style.display).toBe('none');
    });

    test('sorting the table puts it away', () => {
        ui._renderUpgradeResults(results());
        ui.panel.querySelector('#mwi-csim-upgrade-cols-btn').click();

        ui.panel.querySelector('[data-sort-key]').click();

        expect(ui._upgradeColumnMenuOpen).toBe(false);
        expect(menu().style.display).toBe('none');
    });

    test('a new analysis does not bring it back over the results', async () => {
        ui._renderUpgradeResults(results());
        ui.panel.querySelector('#mwi-csim-upgrade-cols-btn').click();
        expect(ui._upgradeColumnMenuOpen).toBe(true);

        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        mocks.upgradeResult = results();
        await ui._onUpgradeAnalyze();

        expect(ui._upgradeColumnMenuOpen).toBe(false);
        expect(menu().style.display).toBe('none');
    });
});

describe('the budget box', () => {
    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        ui.buildPanel();
        ui._upgradeBudget = 500_000_000;
        ui._upgradePlanMetric = 'profit';
    });

    afterEach(() => {
        ui._upgradeBudget = 0;
        ui.destroy();
    });

    test('a plan made of unproven gains says so on its face', () => {
        const html = ui._renderUpgradeBudget([abilityRow('Berserk', { hrid: '/abilities/berserk' })], BASELINE);

        expect(html).toContain('Berserk Lv65 → Lv70');
        expect(html).toContain('Ranked on estimates');
        expect(html).not.toContain('Nothing in the list both fits');
    });

    test('a plan made of measured gains does not', () => {
        const measured = row('Ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 });
        const html = ui._renderUpgradeBudget([measured], BASELINE);

        expect(html).toContain('Ring');
        expect(html).not.toContain('Ranked on estimates');
    });

    test('and nothing affordable is still nothing affordable', () => {
        const html = ui._renderUpgradeBudget(
            [abilityRow('Berserk', { hrid: '/abilities/berserk', cost: 900_000_000 })],
            BASELINE
        );

        expect(html).toContain('Nothing in the list both fits');
    });
});

describe('confirming a basket together', () => {
    /** A context shaped like `runUpgradeAnalysis` hands back alongside its rows */
    const CONTEXT = {
        gameData: {},
        playerDTOs: [{ hrid: 'player1', equipment: {} }],
        playerIndex: 0,
        playerHrid: 'player1',
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        hours: 1,
        communityBuffs: {},
        seed: 7,
        precision: null,
        baselineResult: {},
        baseline: BASELINE,
    };

    const twoPickResults = () => ({
        baseline: BASELINE,
        results: [
            row('Ring', { slot: '/equipment_types/ring', cost: 100, profitGain: 50 }),
            row('Amulet', { slot: '/equipment_types/amulet', cost: 200, profitGain: 30 }),
        ],
        food: null,
        context: CONTEXT,
    });

    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onConfirm = null;
        mocks.confirmResult = {
            ok: true,
            metrics: { dps: 100, xpPerHour: 1000, profitPerHour: 1080, deathsPerHour: 0, encountersPerHour: 10 },
            deltas: {},
            economics: { profitGainPerHour: 80 },
            noise: {},
            totalCost: 300,
        };
        ui.buildPanel();
        ui._upgradeBudget = 500_000_000;
        ui._upgradePlanMetric = 'profit';
    });

    afterEach(() => {
        ui._upgradeBudget = 0;
        ui.destroy();
    });

    test('a plan does not confirm itself — the button sits there until clicked', () => {
        ui._renderUpgradeResults(twoPickResults());
        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');

        expect(container.querySelector('#mwi-csim-budget-confirm')).toBeTruthy();
        expect(container.textContent).not.toContain('summed');
        expect(mocks.onConfirm).toBeNull();
    });

    test('clicking it applies every chosen pick to one DTO and shows it is running', async () => {
        ui._renderUpgradeResults(twoPickResults());
        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
        let received = null;
        mocks.onConfirm = (picks, context) => {
            received = { picks, context };
        };

        container.querySelector('#mwi-csim-budget-confirm').click();

        // The synchronous half of the click handler runs before the sim
        // resolves — the "running" state is on screen the instant it starts,
        // not only after the first promise tick
        expect(container.textContent).toContain('Simulating the whole basket together');

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(received).toBeTruthy();
        expect(received.picks.map((p) => p.candidate.description)).toEqual(['Ring', 'Amulet']);
        expect(received.context).toBe(CONTEXT);
    });

    test('shows the summed and combined figures distinctly once the run lands', async () => {
        ui._renderUpgradeResults(twoPickResults());
        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');

        container.querySelector('#mwi-csim-budget-confirm').click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(container.textContent).toContain('summed');
        expect(container.textContent).toContain('together');
        expect(container.querySelector('#mwi-csim-budget-confirm')).toBeNull();
    });

    test('an inapplicable combination reports why instead of a number', async () => {
        mocks.confirmResult = {
            ok: false,
            reason: 'Ring and Amulet cannot both be worn at once, so this basket cannot be simulated as one loadout.',
        };
        ui._renderUpgradeResults(twoPickResults());
        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');

        container.querySelector('#mwi-csim-budget-confirm').click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(container.textContent).toContain('Could not confirm the basket together');
        expect(container.textContent).toContain('cannot both be worn at once');
        expect(container.textContent).not.toContain('summed');
    });

    test('confirming the basket does not change which picks the plan chose', async () => {
        ui._renderUpgradeResults(twoPickResults());
        const container = ui.panel.querySelector('#mwi-csim-upgrade-results');
        const picksBefore = ui._lastBudgetPlan.picks.map((p) => p.candidate.description).sort();

        container.querySelector('#mwi-csim-budget-confirm').click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const picksAfter = ui._lastBudgetPlan.picks.map((p) => p.candidate.description).sort();
        expect(picksAfter).toEqual(picksBefore);
    });
});

describe('how deep the Score pays out', () => {
    /**
     * Rows that differ on every scored ladder, so a placing is a placing rather
     * than a tie shared by the whole table.
     * @param {number} n - How many
     * @returns {Array<Object>} Result rows, best first
     */
    const scoreRows = (n) =>
        Array.from({ length: n }, (_, i) => {
            const r = row(`Row ${i}`, { slot: `/equipment_types/s${i}`, cost: (i + 1) * 100 });
            r.economics = { ...r.economics, repayHours: i + 1, roiAnnualPct: 100 - i };
            return r;
        });

    test('five by default, which is the behaviour that predates the option', () => {
        expect(DEFAULT_SCORE_DEPTH).toBe('5');
        expect(scoreDepthPlaces(DEFAULT_SCORE_DEPTH, 140)).toBe(5);
        expect(scoreDepthLabel(DEFAULT_SCORE_DEPTH)).toBe('Top 5');
    });

    test('"all" is as deep as there are rows, so nothing scored is left on zero', () => {
        expect(scoreDepthPlaces('all', 140)).toBe(140);
        // A depth key from some other build is not trusted to mean anything
        expect(scoreDepthPlaces('nonsense', 140)).toBe(5);
    });

    test('every depth on offer is a real number of places', () => {
        for (const depth of SCORE_DEPTHS) {
            expect(scoreDepthPlaces(depth.key, 20)).toBeGreaterThan(0);
            expect(typeof scoreDepthLabel(depth.key)).toBe('string');
        }
    });

    test('a row outside the top five scores nothing at five and something at ten', () => {
        const rows = scoreRows(12);
        ui._upgradeResultsData = { results: rows };

        ui._upgradeScoreDepth = '5';
        ui._rescoreUpgrades();
        expect(rows[7].score).toBe(0);

        ui._upgradeScoreDepth = '10';
        ui._rescoreUpgrades();
        expect(rows[7].score).toBeGreaterThan(0);
        // Still ordered: eighth place cannot outscore first
        expect(rows[7].score).toBeLessThan(rows[0].score);

        ui._upgradeScoreDepth = DEFAULT_SCORE_DEPTH;
        ui._upgradeResultsData = null;
    });

    test('the gradient runs green through amber to red across nine places, and stops', () => {
        expect(scoreGradientColor(1)).toBe('rgb(76, 175, 80)');
        expect(scoreGradientColor(5)).toBe('rgb(255, 152, 0)');
        expect(scoreGradientColor(SCORE_GRADIENT_PLACES)).toBe('rgb(244, 67, 54)');
        expect(scoreGradientColor(SCORE_GRADIENT_PLACES + 1)).toBeNull();
        expect(scoreGradientColor(undefined)).toBeNull();
    });

    test('places come off the scores, ties share, and an unscored row never places', () => {
        const rows = [{ score: 15 }, { score: 15 }, { score: 9 }, { score: 0 }];
        const places = scorePlaces(rows);

        expect(places.get(rows[0])).toBe(1);
        expect(places.get(rows[1])).toBe(1);
        expect(places.get(rows[2])).toBe(2);
        expect(places.has(rows[3])).toBe(false);
    });

    test('a cheaper-is-better column puts the smallest number first', () => {
        const rows = [{ v: 900 }, { v: 100 }, { v: 400 }];
        const places = metricPlaces(rows, (r) => r.v, true);

        expect(places.get(rows[1])).toBe(1);
        expect(places.get(rows[2])).toBe(2);
        expect(places.get(rows[0])).toBe(3);
    });

    test('and a higher-is-better one puts the largest first — the direction is per column', () => {
        const rows = [{ v: 900 }, { v: 100 }, { v: 400 }];
        const places = metricPlaces(rows, (r) => r.v, false);

        expect(places.get(rows[0])).toBe(1);
        expect(places.get(rows[2])).toBe(2);
        expect(places.get(rows[1])).toBe(3);
    });

    test('a row with no value in a column never places there, whichever way round it is', () => {
        const rows = [{ v: 5 }, { v: null }, { v: Infinity }, {}];

        for (const lowerIsBetter of [true, false]) {
            const places = metricPlaces(rows, (r) => r.v, lowerIsBetter);
            expect(places.get(rows[0])).toBe(1);
            expect(places.has(rows[1])).toBe(false);
            expect(places.has(rows[2])).toBe(false);
            expect(places.has(rows[3])).toBe(false);
        }
    });

    test('a ladder is built per scored column, plus the Score itself', () => {
        const rows = [
            { score: 8, goldPer: { dps: 100, xp: 900 }, economics: { repayHours: 3 } },
            { score: 4, goldPer: { dps: 900, xp: 100 }, economics: { repayHours: 1 } },
        ];
        const ladders = gradientLadders(rows, ['dps', 'xp', 'repay']);

        expect([...ladders.keys()].sort()).toEqual(['dps', 'repay', 'score', 'xp']);
        // Cheapest DPS is the first row, cheapest EXP the second — which is
        // exactly what coloring the total alone could never show
        expect(ladders.get('dps').get(rows[0])).toBe(1);
        expect(ladders.get('xp').get(rows[1])).toBe(1);
        expect(ladders.get('repay').get(rows[1])).toBe(1);
        expect(ladders.get('score').get(rows[0])).toBe(1);
    });

    test('a column the reader has excluded from the Score is not colored either', () => {
        const rows = [{ score: 8, goldPer: { dps: 100, xp: 900 } }];
        const ladders = gradientLadders(rows, ['dps']);

        expect(ladders.has('dps')).toBe(true);
        expect(ladders.has('xp')).toBe(false);
    });
});

describe('the Score column in the table', () => {
    const results = () => ({
        baseline: BASELINE,
        results: Array.from({ length: 3 }, (_, i) => {
            const r = row(`Row ${i}`, { slot: `/equipment_types/s${i}`, cost: (i + 1) * 100 });
            r.economics = { ...r.economics, repayHours: i + 1, roiAnnualPct: 100 - i };
            return r;
        }),
        food: null,
    });

    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        ui.buildPanel();
    });

    afterEach(() => {
        ui._upgradeScoreDepth = DEFAULT_SCORE_DEPTH;
        ui._upgradeScoreGradient = false;
        ui._setUpgradeColumnMenuOpen(false);
        ui.destroy();
    });

    const html = () => ui.panel.querySelector('#mwi-csim-upgrade-results').innerHTML;

    test('the header says which depth is in use', () => {
        ui._upgradeScoreDepth = '15';
        ui._renderUpgradeResults(results());

        expect(html()).toContain('Top 15');
    });

    test('no color on the Score unless it was asked for', () => {
        ui._renderUpgradeResults(results());

        expect(html()).not.toContain('rgb(76, 175, 80)');
    });

    test('and with it on, the best Score is the greenest', () => {
        ui._upgradeScoreGradient = true;
        ui._renderUpgradeResults(results());

        expect(html()).toContain('rgb(76, 175, 80)');
    });

    test('and every scored column is colored on its own ranking, not just the total', () => {
        ui._upgradeScoreGradient = true;
        ui._renderUpgradeResults(results());

        // One green cell per scored column plus the Score itself, rather than
        // the single one the Score-only gradient drew
        const greens = html().match(/rgb\(76, 175, 80\)/g) || [];
        expect(greens.length).toBeGreaterThan(1);
    });

    test('the popover carries both settings and they survive a round trip through storage', async () => {
        ui._renderUpgradeResults(results());
        ui.panel.querySelector('#mwi-csim-upgrade-cols-btn').click();

        const depth = ui.panel.querySelector('#mwi-csim-score-depth');
        depth.value = 'all';
        depth.dispatchEvent(new Event('change', { bubbles: true }));

        const gradient = ui.panel.querySelector('#mwi-csim-score-gradient');
        gradient.checked = true;
        gradient.dispatchEvent(new Event('change', { bubbles: true }));

        expect(ui._upgradeScoreDepth).toBe('all');
        expect(ui._upgradeScoreGradient).toBe(true);

        ui._upgradeScoreDepth = DEFAULT_SCORE_DEPTH;
        ui._upgradeScoreGradient = false;
        await ui._loadUpgradeColumnPrefs();

        expect(ui._upgradeScoreDepth).toBe('all');
        expect(ui._upgradeScoreGradient).toBe(true);
    });

    test('a sort survives a round trip through storage, so the table opens the same way next time', async () => {
        ui._renderUpgradeResults(results());

        // Click the Cost header twice: once to sort by it, once to flip the
        // direction, so the persisted state cannot be mistaken for the default
        ui.panel.querySelector('[data-sort-key="cost"]').click();
        ui.panel.querySelector('[data-sort-key="cost"]').click();
        await Promise.resolve();

        expect(ui._upgradeSort).toEqual({ key: 'cost', asc: false });

        ui._upgradeSort = null;
        await ui._loadUpgradeColumnPrefs();

        expect(ui._upgradeSort).toEqual({ key: 'cost', asc: false });
    });
});

describe('the guild shrine target level', () => {
    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onRun = null;
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
    });

    test('rides along with the analysis when the shrine set is checked', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="equipment"]').checked = false;
        ui.panel.querySelector('[data-upgrade-mode="ability_level"]').checked = false;
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;
        ui.panel.querySelector('#mwi-csim-shrine-target-level').value = '6';

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineTargetLevel).toBe(6);
    });

    test('blank means one level up, which the advisor reads as no target', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;
        ui.panel.querySelector('#mwi-csim-shrine-target-level').value = '';

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineTargetLevel).toBe(0);
    });

    test('its control is hidden until the shrine set is checked', () => {
        const group = ui.panel.querySelector('#mwi-csim-shrine-group');
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = false;
        ui._onUpgradeModesChanged();
        expect(group.style.display).toBe('none');

        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;
        ui._onUpgradeModesChanged();
        expect(group.style.display).toBe('inline-flex');
    });
});

/**
 * The per-shrine Targets grid, mirroring the House-targets grid: one Lv box asks
 * every combat shrine for the same absolute level, and the shrines are not at the
 * same level as each other, so a grid of per-shrine boxes overrides it.
 */
describe('the guild shrine per-shrine targets grid', () => {
    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onRun = null;
        mocks.guildBuffDetailMap = {
            '/guild_buffs/force_combat': { isCombat: true, shrineHrid: '/guild_shrines/force', maxLevel: 20 },
            '/guild_buffs/aegis_combat': { isCombat: true, shrineHrid: '/guild_shrines/aegis', maxLevel: 20 },
            // A skilling shrine, deliberately left out of the combat grid
            '/guild_buffs/gathering': { isCombat: false, shrineHrid: '/guild_shrines/gathering', maxLevel: 20 },
        };
        ui.buildPanel();
    });

    afterEach(() => {
        mocks.guildBuffDetailMap = {};
        ui.destroy();
    });

    test('the Targets toggle reveals the grid and lists only the combat shrines', () => {
        const grid = ui.panel.querySelector('#mwi-csim-shrine-targets');
        expect(grid.style.display).toBe('none');

        ui.panel.querySelector('#mwi-csim-shrine-targets-toggle').click();

        expect(grid.style.display).toBe('flex');
        const inputs = grid.querySelectorAll('[data-shrine-target]');
        const hrids = Array.from(inputs).map((input) => input.dataset.shrineTarget);
        expect(hrids).toContain('/guild_buffs/force_combat');
        expect(hrids).toContain('/guild_buffs/aegis_combat');
        expect(hrids).not.toContain('/guild_buffs/gathering');
        expect(grid.textContent).toContain('Force');
        expect(grid.textContent).toContain('Aegis');
    });

    test('chosen per-shrine targets reach the analysis inputs, overriding the uniform Lv', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="equipment"]').checked = false;
        ui.panel.querySelector('[data-upgrade-mode="ability_level"]').checked = false;
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;
        ui.panel.querySelector('#mwi-csim-shrine-target-level').value = '6';

        ui.panel.querySelector('#mwi-csim-shrine-targets-toggle').click();
        const grid = ui.panel.querySelector('#mwi-csim-shrine-targets');
        grid.querySelector('[data-shrine-target="/guild_buffs/force_combat"]').value = '9';
        grid.querySelector('[data-shrine-target="/guild_buffs/aegis_combat"]').value = '5';

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineTargets).toEqual({
            '/guild_buffs/force_combat': 9,
            '/guild_buffs/aegis_combat': 5,
        });
        // The uniform Lv still rides along; the advisor prefers the per-shrine map
        expect(seen.guildShrineTargetLevel).toBe(6);
    });

    test('an explicit 0 asks the advisor to skip that shrine, a blank box for one level up', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;

        ui.panel.querySelector('#mwi-csim-shrine-targets-toggle').click();
        const grid = ui.panel.querySelector('#mwi-csim-shrine-targets');
        grid.querySelector('[data-shrine-target="/guild_buffs/force_combat"]').value = '0';
        grid.querySelector('[data-shrine-target="/guild_buffs/aegis_combat"]').value = '';

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineTargets).toEqual({
            '/guild_buffs/force_combat': 0,
            '/guild_buffs/aegis_combat': -1,
        });
        expect(grid.textContent).toContain('0 skips the shrine');
    });

    test('the boxes accept a 0, which the number input used to refuse', () => {
        ui.panel.querySelector('#mwi-csim-shrine-targets-toggle').click();
        const input = ui.panel.querySelector('[data-shrine-target="/guild_buffs/force_combat"]');

        expect(input.getAttribute('min')).toBe('0');
    });

    test('a closed grid leaves the uniform Lv in charge', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;
        ui.panel.querySelector('#mwi-csim-shrine-target-level').value = '6';

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineTargets).toBeNull();
        expect(seen.guildShrineTargetLevel).toBe(6);
    });
});

/**
 * The Guild-allowed only checkbox: the guild's shrine buildings are what a member
 * can actually buy levels from, and the tab used to rank levels no shrine could
 * sell — a Spirit Shrine the guild has never built included.
 */
describe('the guild shrine guild-allowed cap', () => {
    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onRun = null;
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
    });

    test('defaults on and rides along with the analysis', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;

        expect(ui.panel.querySelector('#mwi-csim-shrine-cap-guild').checked).toBe(true);

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineCapToGuild).toBe(true);
    });

    test('unchecking it asks for the dream plan instead, and is remembered', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = true;

        const box = ui.panel.querySelector('#mwi-csim-shrine-cap-guild');
        box.checked = false;
        box.dispatchEvent(new Event('change'));

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineCapToGuild).toBe(false);
        expect(await readScoped('combatSimShrineCapToGuild', 'settings', true)).toBe(false);
    });

    test('and the shrine set being off leaves the flag off too', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="guild_shrine"]').checked = false;

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.guildShrineCapToGuild).toBe(false);
    });
});

/**
 * The House-targets grid: what it shows for a room a loaded player's DTO does
 * not carry.
 *
 * `characterHouseRoomMap` (and the DTO built from it) only lists rooms that
 * have actually been built, so a room nobody has bought is simply missing from
 * `dto.houseRooms` — for the live character as much as for an imported profile
 * or a party member. The grid used to read a missing key through to
 * `dataManager.getHouseRoomLevel`, which only ever knows the *live* character's
 * own rooms — so an imported stranger's unbuilt Dojo silently displayed and
 * prefilled targets from the live character's own Dojo level.
 */
describe('the House-targets grid and a room a loaded DTO does not carry', () => {
    beforeEach(() => {
        mocks.houseRoomDetailMap = {
            '/house_rooms/dojo': {
                name: 'Dojo',
                usableInActionTypeMap: { '/action_types/combat': true },
                actionBuffs: [{ typeHrid: '/buff_types/attack' }],
            },
            '/house_rooms/garden': {
                name: 'Garden',
                usableInActionTypeMap: { '/action_types/combat': true },
                actionBuffs: [{ typeHrid: '/buff_types/attack' }],
            },
        };
        // The live character's own Dojo — not the imported player's
        mocks.houseRoomLevels = { '/house_rooms/dojo': 6 };
        ui.buildPanel();
    });

    afterEach(() => {
        mocks.houseRoomDetailMap = {};
        mocks.houseRoomLevels = {};
        mocks.editedDTOs = null;
        mocks.editorSelfHrid = null;
        mocks.skipSkillingRooms = false;
        ui.destroy();
    });

    test("an imported player's unbuilt room shows level 0, not the live character's", () => {
        // Imported via "Sim Character": not self, and their DTO only carries
        // Garden — Dojo was never part of their profile
        mocks.editorSelfHrid = null;
        mocks.editedDTOs = { player1: { hrid: 'player1', houseRooms: { '/house_rooms/garden': 2 } } };

        ui.panel.querySelector('#mwi-csim-house-targets-toggle').click();
        const grid = ui.panel.querySelector('#mwi-csim-house-targets');

        expect(grid.textContent).toContain('Dojo (0)');
        expect(grid.textContent).not.toContain('Dojo (6)');
        expect(grid.textContent).toContain('Garden (2)');
    });

    test('with no DTO loaded at all, the grid still has something to show', () => {
        // Before the editor has ever initialized there is no player to read a
        // level off, so falling back to the live character is the only option
        mocks.editedDTOs = null;

        ui.panel.querySelector('#mwi-csim-house-targets-toggle').click();
        const grid = ui.panel.querySelector('#mwi-csim-house-targets');

        expect(grid.textContent).toContain('Dojo (6)');
    });

    test('with skilling rooms skipped, the grid does not offer targets the analysis will ignore', () => {
        mocks.skipSkillingRooms = true;
        mocks.houseRoomDetailMap['/house_rooms/dairy_barn'] = {
            name: 'Dairy Barn',
            globalBuffs: [{ typeHrid: '/buff_types/wisdom' }, { typeHrid: '/buff_types/rare_find' }],
            actionBuffs: [
                {
                    typeHrid: '/buff_types/efficiency',
                    usableInActionTypeMap: { '/action_types/milking': true },
                },
            ],
        };

        ui.panel.querySelector('#mwi-csim-house-targets-toggle').click();
        const grid = ui.panel.querySelector('#mwi-csim-house-targets');

        expect(grid.textContent).not.toContain('Dairy Barn');
        expect(grid.textContent).toContain('Dojo');
    });

    test('a settings change refreshes an open grid and preserves combat room targets', () => {
        mocks.houseRoomDetailMap['/house_rooms/dairy_barn'] = {
            name: 'Dairy Barn',
            globalBuffs: [{ typeHrid: '/buff_types/wisdom' }],
        };
        ui.panel.querySelector('#mwi-csim-house-targets-toggle').click();
        const grid = ui.panel.querySelector('#mwi-csim-house-targets');
        const dojo = grid.querySelector('[data-house-target="/house_rooms/dojo"]');
        dojo.value = '7';
        expect(grid.textContent).toContain('Dairy Barn');

        mocks.skipSkillingRooms = true;
        mocks.settingChangeCallbacks.get('combatSim_upgradeSkipSkillingRooms')?.(true);

        expect(grid.textContent).not.toContain('Dairy Barn');
        expect(grid.querySelector('[data-house-target="/house_rooms/dojo"]').value).toBe('7');
        expect(ui._getHouseTargets()).toMatchObject({ '/house_rooms/dojo': 7 });
        ui.destroy();
        expect(mocks.settingChangeCallbacks.has('combatSim_upgradeSkipSkillingRooms')).toBe(false);
    });
});

/**
 * The Ability Swaps sub-option.
 *
 * Swaps are now generated from the community build guide, which means there is
 * a smaller question inside the small one: the aura and the archetype's
 * signature ability are the two choices that define a build, and the rest of
 * the guide's set is what everybody runs anyway. Restricting to those two is
 * most of the run's cost, so the switch has to survive being closed.
 */
describe('the Aura-only swap option', () => {
    beforeEach(() => {
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.onRun = null;
        mocks.store.clear();
        ui.buildPanel();
    });

    afterEach(() => {
        ui.destroy();
    });

    /** Set up a runnable Upgrade tab with only the swap set checked */
    function swapsOnly() {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        for (const box of ui.panel.querySelectorAll('[data-upgrade-mode]')) {
            box.checked = box.getAttribute('data-upgrade-mode') === 'ability_swap';
        }
    }

    test('sits inside the Ability Swaps chip and is hidden until it is checked', () => {
        const group = ui.panel.querySelector('[data-mode-options="ability_swap"]');
        const chip = ui.panel.querySelector('[data-mode-chip="ability_swap"]');

        // Inside the chip, so it reads as "this option belongs to that checkbox"
        expect(chip.contains(group)).toBe(true);

        ui.panel.querySelector('[data-upgrade-mode="ability_swap"]').checked = false;
        ui._onUpgradeModesChanged();
        expect(group.style.display).toBe('none');

        ui.panel.querySelector('[data-upgrade-mode="ability_swap"]').checked = true;
        ui._onUpgradeModesChanged();
        expect(group.style.display).toBe('inline-flex');
    });

    test('rides along with the analysis', async () => {
        swapsOnly();
        ui.panel.querySelector('#mwi-csim-swap-aura-only').checked = true;

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.auraSwapsOnly).toBe(true);
    });

    test('and means nothing when swaps are not being generated at all', async () => {
        const zone = ui.panel.querySelector('#mwi-csim-zone');
        zone.innerHTML = '<option value="/zones/a">A</option>';
        zone.value = '/zones/a';
        ui.panel.querySelector('[data-upgrade-mode="ability_swap"]').checked = false;
        ui.panel.querySelector('#mwi-csim-swap-aura-only').checked = true;

        let seen = null;
        mocks.onRun = (params) => {
            seen = params;
        };
        await ui._onUpgradeAnalyze();

        expect(seen.auraSwapsOnly).toBe(false);
    });

    test('is remembered across a rebuild', async () => {
        const box = ui.panel.querySelector('#mwi-csim-swap-aura-only');
        box.checked = true;
        box.dispatchEvent(new window.Event('change'));
        await Promise.resolve();

        ui.destroy();
        ui.buildPanel();
        await Promise.resolve();
        await Promise.resolve();

        expect(ui.panel.querySelector('#mwi-csim-swap-aura-only').checked).toBe(true);
    });

    test('describes the aura group it narrows to', () => {
        const title = ui.panel.querySelector('#mwi-csim-swap-aura-label').getAttribute('title');

        expect(title).toContain('Critical Aura');
        expect(title).toContain('Mystic Aura');
        expect(title).toContain('Fierce Aura');
        // Interpolated into a title attribute: a double quote would end it early
        expect(title).not.toContain('"');
    });
});

describe('the Bestiary route planner under the all-zones table', () => {
    const HOUR_NS = 3600 * 1e9;
    /** A zone result whose monsters died `deaths` times in a one-hour sim */
    const result = (name, deaths, tier = 0) => ({
        zone: { name, difficultyTier: tier, zoneHrid: `/actions/combat/${name.toLowerCase()}` },
        simResult: {
            simulatedTime: HOUR_NS,
            encounters: 10,
            deaths: { player1: 0, ...deaths },
            experienceGained: { player1: { defense: 100 } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    const gameData = {
        combatMonsterDetailMap: {
            '/monsters/fly': { name: 'Fly' },
            '/monsters/rat': { name: 'Rat' },
            '/monsters/bee': { name: 'Bee' },
        },
    };
    const click = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));
    const planText = () => ui.panel.querySelector('#mwi-csim-bestiary-plan-out').textContent;

    beforeEach(() => {
        ui.buildPanel();
        ui._allZonesSortCol = null;
        ui._bestiaryPlanHours = undefined;
        ui._bestiaryPlanTolerance = undefined;
        mocks.monsters = null;
    });

    afterEach(() => {
        ui.destroy();
        mocks.monsters = null;
        vi.restoreAllMocks();
    });

    test('the control is drawn with the table, defaults to 24 hours, and waits for the Bestiary', async () => {
        const request = vi.spyOn(ui, '_requestBestiary').mockImplementation(() => {});
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

        const input = ui.panel.querySelector('#mwi-csim-bestiary-plan-value');
        expect(input.value).toBe('24');
        expect(planText()).toBe('');

        click('#mwi-csim-bestiary-plan-btn');
        expect(planText()).toContain('waiting for bestiary');
        expect(request).toHaveBeenCalled();
        expect(ui.panel.querySelector('#mwi-csim-bestiary-plan-copy').style.display).toBe('none');
    });

    test('a plan asked for before the Bestiary loaded fills in on the redraw', async () => {
        vi.spyOn(ui, '_requestBestiary').mockImplementation(() => {});
        const results = [result('Farm', { '/monsters/fly': 10 })];
        await ui._displayAllZonesResults(results, 1, gameData);
        click('#mwi-csim-bestiary-plan-btn');
        expect(planText()).toContain('waiting for bestiary');

        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults(results, 1, gameData);

        expect(planText()).not.toContain('waiting');
        expect(planText()).toContain('Farm T0');
    });

    test('plans the route from the sim rates and the counts, in order, with the thresholds crossed', async () => {
        // Farm (T0): fly 10 kills/hr at 8 credits (12 min to 10), rat 2/hr unmet
        // (30 min to 1). Hive is T2, so its bee's 1 kill/hr is 3 credits/hr and
        // its first credit lands in 20 min, not an hour. One hour: Farm 0:30
        // (+3), Hive 0:30 (+1).
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults(
            [result('Farm', { '/monsters/fly': 10, '/monsters/rat': 2 }), result('Hive', { '/monsters/bee': 1 }, 2)],
            1,
            gameData
        );
        const input = ui.panel.querySelector('#mwi-csim-bestiary-plan-value');
        input.value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const rows = [...ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
        );
        expect(rows).toHaveLength(2);
        // Time, then about how many fights that is at the zone's simulated rate, then points
        // The Zone cell also carries the ▶ open button — its own icon glyph
        // trails the name with no gap, since the row-open feature was added.
        // The fight count is the confidence-padded one (`utils/fight-confidence.js`):
        // the stay's binding threshold is Rat 0 → 1 at one kill in five fights,
        // and eleven fights is what lands it nine times in ten, against the
        // five fights the bare rate arithmetic quotes.
        expect(rows[0].slice(0, 5)).toEqual(['1', 'Farm T0▶', '0:30', '≈11', '+3']);
        expect(rows[0][5]).toContain('Fly 8 → 10');
        expect(rows[0][5]).toContain('Rat 0 → 1');
        expect(rows[1].slice(0, 3)).toEqual(['2', 'Hive T2▶', '0:30']);
        expect(rows[1][3]).toMatch(/^(≈[0-9,]+|—)$/);
        // A T2 kill credits three, so half an hour of bees crosses the first
        // threshold instead of falling short of it
        expect(rows[1][4]).toBe('+1');
        expect(rows[1][5]).toContain('Bee 0 → 1');

        const footer = ui.panel.querySelector('#mwi-csim-bestiary-plan-footer').textContent;
        expect(footer).toContain('4 points');
        expect(footer).toContain('best single zone Farm T0: 3');

        // The budget is remembered for next time
        expect(mocks.store.get('settings:combatSimBestiaryPlanHours')).toBe(1);
    });

    test('zones without a sim result are skipped with a note', async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults(
            [result('Farm', { '/monsters/fly': 10 }), { zone: { name: 'Broken' }, simResult: null }],
            1,
            gameData
        );
        click('#mwi-csim-bestiary-plan-btn');

        expect(planText()).toContain('1 zone without a sim result skipped');
        expect(planText()).toContain('Farm T0');
    });

    test('the setting turns the column and the planner off together, and the Bestiary is not requested', async () => {
        const { default: config } = await import('../../core/config.js');
        const valueSpy = vi
            .spyOn(config, 'getSettingValue')
            .mockImplementation((key, fallback) => (key === 'combatSim_bestiary' ? false : fallback));
        const request = vi.spyOn(ui, '_requestBestiary').mockImplementation(() => {});
        try {
            mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
            await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

            expect(ui.panel.querySelector('#mwi-csim-bestiary-plan')).toBeNull();
            const heads = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.textContent.trim());
            expect(heads.some((h) => /Bestiary/.test(h))).toBe(false);
            expect(request).not.toHaveBeenCalled();
        } finally {
            valueSpy.mockRestore();
        }
    });

    test('Copy puts the plain-text plan on the clipboard', async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults(
            [result('Farm', { '/monsters/fly': 10 }), result('Hive', { '/monsters/bee': 1 }, 2)],
            1,
            gameData
        );
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const written = [];
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async (text) => written.push(text) },
            configurable: true,
        });
        const copyBtn = ui.panel.querySelector('#mwi-csim-bestiary-plan-copy');
        expect(copyBtn.style.display).not.toBe('none');
        click('#mwi-csim-bestiary-plan-copy');
        await Promise.resolve();
        await Promise.resolve();

        expect(written).toHaveLength(1);
        const lines = written[0].split('\n');
        expect(lines[0]).toBe('Bestiary plan — 1:00 h, 3 points');
        expect(lines[1]).toBe('1. Farm T0 — 0:12 (≈2 fights) — +2 — Fly 8→10');
        // Hive is T2: three credits a bee, so the first one lands inside the stay
        expect(lines[2]).toMatch(/^2\. Hive T2 — 0:48( \(≈[0-9]+ fights\))? — \+1 — Bee 0→1$/);
        expect(lines[3]).toBe('Best single zone: Farm T0 — 2 points');
        expect(copyBtn.textContent).toBe('Copied ✓');
    });
});

describe('the score tie-break tolerance in the Bestiary planner', () => {
    const HOUR_NS = 3600 * 1e9;
    /** A zone result with its own XP, so Score can be made to differ between two otherwise-tied zones */
    const resultXP = (name, deaths, xp, tier = 0) => ({
        zone: { name, difficultyTier: tier, zoneHrid: `/actions/combat/${name.toLowerCase()}` },
        simResult: {
            simulatedTime: HOUR_NS,
            encounters: 10,
            deaths: { player1: 0, ...deaths },
            experienceGained: { player1: { defense: xp } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    const gameData = {
        combatMonsterDetailMap: {
            '/monsters/fly': { name: 'Fly' },
            '/monsters/bee': { name: 'Bee' },
        },
    };
    const click = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));
    const change = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('change', { bubbles: true }));

    beforeEach(() => {
        ui.buildPanel();
        ui._allZonesSortCol = null;
        ui._bestiaryPlanHours = undefined;
        ui._bestiaryPlanTolerance = undefined;
        mocks.monsters = null;
    });

    afterEach(() => {
        ui.destroy();
        mocks.monsters = null;
        vi.restoreAllMocks();
    });

    test('the tolerance control defaults to 10', async () => {
        await ui._displayAllZonesResults([resultXP('Farm', { '/monsters/fly': 10 }, 100)], 1, gameData);
        expect(ui.panel.querySelector('#mwi-csim-bestiary-plan-tolerance').value).toBe('10');
    });

    test('a changed tolerance is remembered', async () => {
        await ui._displayAllZonesResults([resultXP('Farm', { '/monsters/fly': 10 }, 100)], 1, gameData);
        ui.panel.querySelector('#mwi-csim-bestiary-plan-tolerance').value = '25';
        change('#mwi-csim-bestiary-plan-tolerance');
        expect(mocks.store.get('settings:combatSimBestiaryPlanTolerance')).toBe(25);
        expect(ui._bestiaryPlanTolerance).toBe(25);
    });

    test('changing the tolerance re-plans a route already on screen', async () => {
        // Farm: fly at 8, 10/hr → next point in 0.2 h. Hive: bee at 0, ~4.762/hr
        // → next point in 0.21 h, five percent slower. Hive's XP is far higher,
        // so its Score wins comfortably once the tolerance admits it.
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults(
            [resultXP('Farm', { '/monsters/fly': 10 }, 100), resultXP('Hive', { '/monsters/bee': 1 / 0.21 }, 100000)],
            1,
            gameData
        );
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';

        ui.panel.querySelector('#mwi-csim-bestiary-plan-tolerance').value = '0';
        change('#mwi-csim-bestiary-plan-tolerance');
        click('#mwi-csim-bestiary-plan-btn');
        expect(ui.panel.querySelector('#mwi-csim-bestiary-plan-out tbody tr td:nth-child(2)').textContent.trim()).toBe(
            'Farm T0▶'
        );

        ui.panel.querySelector('#mwi-csim-bestiary-plan-tolerance').value = '10';
        change('#mwi-csim-bestiary-plan-tolerance');
        const nameCell = ui.panel.querySelector('#mwi-csim-bestiary-plan-out tbody tr td:nth-child(2)');
        expect(nameCell.textContent.trim()).toContain('Hive T0');
        // Picked over the faster Farm because of Score — the table says so
        expect(nameCell.title).toContain('Score');
        expect(nameCell.innerHTML).toContain('<span');
    });
});

describe('the Bestiary plan step ▶ open button', () => {
    const HOUR_NS = 3600 * 1e9;
    const result = (name, deaths, tier = 0) => ({
        zone: { name, difficultyTier: tier, zoneHrid: `/actions/combat/${name.toLowerCase()}` },
        simResult: {
            simulatedTime: HOUR_NS,
            encounters: 10,
            deaths: { player1: 0, ...deaths },
            experienceGained: { player1: { defense: 100 } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    const gameData = { combatMonsterDetailMap: { '/monsters/fly': { name: 'Fly' }, '/monsters/bee': { name: 'Bee' } } };
    const click = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));

    beforeEach(() => {
        ui.buildPanel();
        ui._allZonesSortCol = null;
        ui._bestiaryPlanHours = undefined;
        ui._bestiaryPlanTolerance = undefined;
        mocks.monsters = null;
        mocks.openZoneCalls.length = 0;
        mocks.openZoneResult = { opened: true, tierConfirmed: true, filled: true };
    });

    afterEach(() => {
        ui.destroy();
        mocks.monsters = null;
        vi.restoreAllMocks();
    });

    test("opens the step's own zone and tier and fills the exact fight count the row shows", async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 }, 2)], 1, gameData);
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const btn = ui.panel.querySelector('.mwi-csim-plan-open-btn');
        expect(btn).not.toBeNull();
        expect(btn.dataset.hrid).toBe('/actions/combat/farm');
        expect(btn.dataset.tier).toBe('2');
        // "0:30" of Farm at 10 fights/hr (this run's simulated encounters rate)
        const shownCount = btn.dataset.count;
        expect(shownCount).toBe(
            ui.panel
                .querySelector('#mwi-csim-bestiary-plan-out tbody tr td:nth-child(4)')
                .textContent.replace(/[≈,]/g, '')
        );

        btn.dispatchEvent(new window.Event('click', { bubbles: true }));
        await Promise.resolve();

        expect(mocks.openZoneCalls).toEqual([
            { zoneHrid: '/actions/combat/farm', tier: 2, options: { count: shownCount } },
        ]);
    });

    test('fills the count baked in at render time, not a re-derived one, when the underlying data changes after render', async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const btn = ui.panel.querySelector('.mwi-csim-plan-open-btn');
        const renderedCount = btn.dataset.count;

        // Change what the plan would compute now — the mounted button must
        // not go back and ask for a fresh number
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 999 }];

        btn.dispatchEvent(new window.Event('click', { bubbles: true }));
        await Promise.resolve();

        expect(mocks.openZoneCalls[0].options.count).toBe(renderedCount);
    });

    test('a dungeon step gets an open button the same way, quoting clears as the count', async () => {
        const dungeonResult = () => ({
            zone: { name: 'Den', difficultyTier: 1, zoneHrid: '/actions/combat/den' },
            simResult: {
                simulatedTime: HOUR_NS,
                encounters: 300,
                isDungeon: true,
                dungeonsCompleted: 6,
                dungeonsFailed: 0,
                deaths: { player1: 0, '/monsters/goblin': 60 },
                experienceGained: { player1: { defense: 100 } },
            },
            revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
        });
        mocks.dungeonRuns = [];
        mocks.monsters = [{ monsterHrid: '/monsters/goblin', count: 8 }];
        await ui._displayAllZonesResults([dungeonResult()], 1, {
            combatMonsterDetailMap: { '/monsters/goblin': { name: 'Goblin' } },
        });
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const btn = ui.panel.querySelector('.mwi-csim-plan-open-btn');
        expect(btn.dataset.hrid).toBe('/actions/combat/den');
        expect(btn.dataset.tier).toBe('1');
        expect(btn.title).toContain('clears');
        mocks.dungeonRuns = [];
    });

    test('no button when a step has no fight count to quote', async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults(
            [{ zone: { name: 'Broken', difficultyTier: 0, zoneHrid: '/actions/combat/broken' }, simResult: null }],
            1,
            gameData
        );
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        // The only zone had no sim result, so the plan has nothing to draw at
        // all — no rows, and so no open buttons either
        expect(ui.panel.querySelectorAll('.mwi-csim-plan-open-btn')).toHaveLength(0);
    });

    /**
     * There is no more setting to fall back to (`combatSim_bestiaryPartySize`
     * was removed): a run whose `SimResult` never says how many players it
     * simulated is still assumed solo, but the plan says so instead of
     * treating a guess as a fact. A live run always states `numberOfPlayers`
     * (see `combat-simulator.js`'s `new SimResult(zone, players.length)`), so
     * this is a defensive path, not one a real run is expected to take.
     */
    test('a run that never recorded its party size is assumed solo, and the plan says so', async () => {
        const noPartySize = result('Farm', { '/monsters/fly': 10 });
        delete noPartySize.simResult.numberOfPlayers;
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];

        await ui._displayAllZonesResults([noPartySize], 1, gameData);

        expect(ui._bestiaryPlanZones).toHaveLength(1);
        expect(ui._bestiaryPlanZones[0].note).toContain('party size not recorded');
        // Solo, same as `creditsPerKill`'s own default — not silently doubled
        // or halved by a guess
        expect(ui._bestiaryPlanZones[0].creditsPerKill).toBe(1);
    });

    test('a run that did record its party size gets no such note', async () => {
        const trio = result('Farm', { '/monsters/fly': 10 });
        trio.simResult.numberOfPlayers = 3;
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];

        await ui._displayAllZonesResults([trio], 1, gameData);

        expect(ui._bestiaryPlanZones).toHaveLength(1);
        expect(ui._bestiaryPlanZones[0].note).toBeFalsy();
        expect(ui._bestiaryPlanZones[0].creditsPerKill).toBeCloseTo(1 / 3);
    });
});

describe('planning to a points target from the panel', () => {
    const HOUR_NS = 3600 * 1e9;
    const result = (name, deaths, tier = 0) => ({
        zone: { name, difficultyTier: tier, zoneHrid: `/actions/combat/${name.toLowerCase()}` },
        simResult: {
            simulatedTime: HOUR_NS,
            encounters: 10,
            deaths: { player1: 0, ...deaths },
            experienceGained: { player1: { defense: 100 } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    const gameData = { combatMonsterDetailMap: { '/monsters/fly': { name: 'Fly' } } };
    const click = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));
    const change = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('change', { bubbles: true }));

    beforeEach(() => {
        // The panel reads its remembered prefs as it is built, so an earlier
        // suite's budget has to be off the store before that happens
        mocks.store.set('settings:combatSimBestiaryPlanHours', 24);
        mocks.store.set('settings:combatSimBestiaryPlanMode', 'hours');
        mocks.store.set('settings:combatSimBestiaryPlanPoints', 20);
        ui.buildPanel();
        ui._allZonesSortCol = null;
        ui._bestiaryPlanMode = 'hours';
        ui._bestiaryPlanHours = 24;
        ui._bestiaryPlanPoints = 20;
        mocks.monsters = null;
    });

    afterEach(() => {
        ui.destroy();
        ui._bestiaryPlanMode = 'hours';
        mocks.monsters = null;
        vi.restoreAllMocks();
    });

    test('the mode switch relabels the one box and remembers which way round it was asked', async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

        const label = ui.panel.querySelector('#mwi-csim-bestiary-plan-label');
        const input = ui.panel.querySelector('#mwi-csim-bestiary-plan-value');
        expect(label.textContent).toBe('Hours');
        expect(input.value).toBe('24');

        ui.panel.querySelector('#mwi-csim-bestiary-plan-mode').value = 'points';
        change('#mwi-csim-bestiary-plan-mode');
        expect(label.textContent).toBe('Points wanted');
        expect(input.value).toBe('20');
        await Promise.resolve();
        expect(mocks.store.get('settings:combatSimBestiaryPlanMode')).toBe('points');
    });

    test('points mode answers in time, and the footer compares against the soonest single zone', async () => {
        // Fly at 8, 10/hr: +2 at 10 kills (0:12), +3 at 100 (9:12 more)
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

        ui.panel.querySelector('#mwi-csim-bestiary-plan-mode').value = 'points';
        change('#mwi-csim-bestiary-plan-mode');
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '2';
        click('#mwi-csim-bestiary-plan-btn');

        const rows = [...ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].slice(0, 3)).toEqual(['1', 'Farm T0▶', '0:12']);
        expect(rows[0][4]).toBe('+2');

        const footer = ui.panel.querySelector('#mwi-csim-bestiary-plan-footer').textContent;
        expect(footer).toContain('2 points');
        expect(footer).toContain('in 0:12 h');
        expect(footer).toContain('best single zone Farm T0 reaches 2 in 0:12 h');
        expect(mocks.store.get('settings:combatSimBestiaryPlanPoints')).toBe(2);
    });

    test('total mode plans for the gap between the Bestiary’s current total and the target', async () => {
        // Fly at 8 kills is worth 1 point so far (pointsFromCount(8) === 1);
        // asking for a total of 3 should ask the planner for a gap of 2, not 3.
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

        ui.panel.querySelector('#mwi-csim-bestiary-plan-mode').value = 'total';
        change('#mwi-csim-bestiary-plan-mode');
        const label = ui.panel.querySelector('#mwi-csim-bestiary-plan-label');
        expect(label.textContent).toBe('Total wanted');

        const note = ui.panel.querySelector('#mwi-csim-bestiary-plan-total-note');
        expect(note.textContent).toBe('you have 1 · need 999');

        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '3';
        click('#mwi-csim-bestiary-plan-btn');

        const plan = ui._currentBestiaryPlan();
        expect(plan.targetPoints).toBe(2);

        const footer = ui.panel.querySelector('#mwi-csim-bestiary-plan-footer').textContent;
        // Where the route ends and what was asked for: 1 + 2 gained, with 3 wanted
        expect(footer).toContain('3 total (+2, 3 wanted)');
        // The comparison and the copied text name the total goal too, not the 2-point gap
        expect(footer).not.toMatch(/reaches 2/);
        expect(ui._bestiaryPlanText()).toContain('3 total (+2, 3 wanted)');
        expect(mocks.store.get('settings:combatSimBestiaryPlanTotal')).toBe(3);

        // Typing a new target previews the gap but does not change the drawn plan or what Copy
        // copies until Plan is pressed again
        const input = ui.panel.querySelector('#mwi-csim-bestiary-plan-value');
        input.value = '5';
        input.dispatchEvent(new Event('input'));
        expect(note.textContent).toBe('you have 1 · need 4');
        expect(ui._bestiaryPlanText()).toContain('3 total (+2, 3 wanted)');
        click('#mwi-csim-bestiary-plan-btn');
        expect(ui._bestiaryPlanText()).toContain('5 wanted');
    });

    test('a target at or below the current total shows an "already at" note and no route', async () => {
        // Fly at 8 kills is worth 1 point so far; asking for a total of 1 is
        // already reached and should never reach the planner.
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

        ui.panel.querySelector('#mwi-csim-bestiary-plan-mode').value = 'total';
        change('#mwi-csim-bestiary-plan-mode');
        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        expect(ui._currentBestiaryPlan()).toBeNull();
        const out = ui.panel.querySelector('#mwi-csim-bestiary-plan-out').textContent;
        expect(out).toContain('already at 1');
        expect(ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr')).toHaveLength(0);
    });

    test('total mode persists its own mode and target separately from points mode', async () => {
        mocks.monsters = [{ monsterHrid: '/monsters/fly', count: 8 }];
        await ui._displayAllZonesResults([result('Farm', { '/monsters/fly': 10 })], 1, gameData);

        ui.panel.querySelector('#mwi-csim-bestiary-plan-mode').value = 'total';
        change('#mwi-csim-bestiary-plan-mode');
        await Promise.resolve();
        expect(mocks.store.get('settings:combatSimBestiaryPlanMode')).toBe('total');
        expect(ui._bestiaryPlanMode).toBe('total');
    });
});

describe('dungeons in the all-zones run and in the plan', () => {
    const HOUR_NS = 3600 * 1e9;
    /** A one-hour dungeon sim: six clears, sixty goblins — ten goblins a clear */
    const dungeonResult = () => ({
        zone: { name: 'Den', difficultyTier: 1, zoneHrid: '/actions/combat/den' },
        simResult: {
            simulatedTime: HOUR_NS,
            encounters: 300,
            isDungeon: true,
            dungeonsCompleted: 6,
            dungeonsFailed: 0,
            deaths: { player1: 0, '/monsters/goblin': 60 },
            experienceGained: { player1: { defense: 100 } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    const gameData = { combatMonsterDetailMap: { '/monsters/goblin': { name: 'Goblin' } } };
    const click = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));

    beforeEach(() => {
        // The panel reads its remembered prefs as it is built, so an earlier
        // suite's budget has to be off the store before that happens
        mocks.store.set('settings:combatSimBestiaryPlanHours', 24);
        mocks.store.set('settings:combatSimBestiaryPlanMode', 'hours');
        mocks.store.set('settings:combatSimBestiaryPlanPoints', 20);
        ui.buildPanel();
        ui._allZonesSortCol = null;
        ui._bestiaryPlanMode = 'hours';
        ui._bestiaryPlanHours = 24;
        ui._includeDungeons = false;
        mocks.monsters = null;
    });

    afterEach(() => {
        ui.destroy();
        ui._includeDungeons = false;
        mocks.dungeonRuns = [];
        mocks.monsters = null;
        vi.restoreAllMocks();
    });

    test('the toggle is what puts dungeons in the run, at T0-T2', () => {
        mocks.zones = [
            { hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 1, maxDifficulty: 1, isDungeon: false },
            { hrid: '/actions/combat/den', name: 'Den', maxSpawnCount: 1, maxDifficulty: 0, isDungeon: true },
        ];
        ui._allZonesMode = 'solo';
        ui._populateZoneChecklist();

        // Off: the checklist never offered the dungeon and the run does not have it
        expect(ui._getSelectedAllZones()).toEqual([
            { zoneHrid: '/actions/combat/fly', difficultyTier: 0, name: 'Fly' },
            { zoneHrid: '/actions/combat/fly', difficultyTier: 1, name: 'Fly' },
        ]);

        ui._includeDungeons = true;
        const withDungeons = ui._getSelectedAllZones();
        expect(withDungeons.filter((z) => z.zoneHrid === '/actions/combat/den').map((z) => z.difficultyTier)).toEqual([
            0, 1, 2,
        ]);
        // The ordinary zones are untouched and still come first
        expect(withDungeons.slice(0, 2)).toEqual([
            { zoneHrid: '/actions/combat/fly', difficultyTier: 0, name: 'Fly' },
            { zoneHrid: '/actions/combat/fly', difficultyTier: 1, name: 'Fly' },
        ]);
    });

    test('Sim All Dungeons is a separate mode with a selectable T0-T2 dungeon list', () => {
        mocks.zones = [
            { hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 1, maxDifficulty: 5, isDungeon: false },
            { hrid: '/actions/combat/den', name: 'Den', maxSpawnCount: 1, maxDifficulty: 0, isDungeon: true },
            { hrid: '/actions/combat/cove', name: 'Cove', maxSpawnCount: 1, maxDifficulty: 0, isDungeon: true },
        ];
        const dungeonBox = ui.panel.querySelector('#mwi-csim-allzones-dungeons');
        dungeonBox.click();

        expect(ui._allZonesMode).toBe('dungeons');
        expect(ui.panel.querySelector('#mwi-csim-allzones-group').checked).toBe(false);
        expect(ui.panel.querySelector('#mwi-csim-allzones-solo').checked).toBe(false);
        expect([...ui.panel.querySelectorAll('.mwi-csim-zone-cb')].map((box) => box.dataset.hrid)).toEqual([
            '/actions/combat/den',
            '/actions/combat/cove',
        ]);

        // The planner preference must not append a second copy to the explicit
        // dungeon-only selection, and dungeon tiers stop at T2 regardless of
        // the ordinary-zone difficulty metadata.
        ui._includeDungeons = true;
        expect(ui._getSelectedAllZones()).toEqual([
            { zoneHrid: '/actions/combat/den', difficultyTier: 0, name: 'Den' },
            { zoneHrid: '/actions/combat/den', difficultyTier: 1, name: 'Den' },
            { zoneHrid: '/actions/combat/den', difficultyTier: 2, name: 'Den' },
            { zoneHrid: '/actions/combat/cove', difficultyTier: 0, name: 'Cove' },
            { zoneHrid: '/actions/combat/cove', difficultyTier: 1, name: 'Cove' },
            { zoneHrid: '/actions/combat/cove', difficultyTier: 2, name: 'Cove' },
        ]);

        ui.panel.querySelector('#mwi-csim-allzones-group').click();
        expect(ui._allZonesMode).toBe('group');
        expect(dungeonBox.checked).toBe(false);
    });

    test('a dungeon-only sweep accepts a full five-player party', async () => {
        mocks.zones = [
            { hrid: '/actions/combat/den', name: 'Den', maxSpawnCount: 1, maxDifficulty: 0, isDungeon: true },
        ];
        mocks.playerDTOs = Array.from({ length: 5 }, (_, index) => ({
            hrid: `player${index + 1}`,
            equipment: {},
        }));
        mocks.allZonesRuns = 0;
        ui.panel.querySelector('#mwi-csim-allzones-dungeons').click();

        await ui._onSimulateAllZones();

        expect(mocks.allZonesRuns).toBe(1);
        expect(mocks.allZonesArgs.playerDTOs).toHaveLength(5);
        mocks.playerDTOs = [{ hrid: 'player1', equipment: {} }];
    });

    describe('party caps', () => {
        const party = (size) =>
            Array.from({ length: size }, (_, index) => ({ hrid: `player${index + 1}`, equipment: {} }));
        const den = { hrid: '/actions/combat/den', name: 'Den', maxSpawnCount: 1, maxDifficulty: 0, isDungeon: true };
        const fly = { hrid: '/actions/combat/fly', name: 'Fly', maxSpawnCount: 3, maxDifficulty: 0, isDungeon: false };
        let warnings;

        beforeEach(() => {
            mocks.zones = [fly, den];
            mocks.allZonesRuns = 0;
            mocks.simRuns = 0;
            warnings = [];
            vi.spyOn(ui, '_showWarning').mockImplementation((message) => warnings.push(message));
        });

        afterEach(() => {
            mocks.buildPlayerDTOs = null;
            mocks.playerDTOs = [{ hrid: 'player1', equipment: {} }];
            // The mode outlives the panel, and a leftover one would route the
            // next test's Single Sim into a sweep
            ui._allZonesMode = null;
        });

        test('a dungeon-only sweep refuses a party larger than five', async () => {
            mocks.playerDTOs = party(6);
            ui.panel.querySelector('#mwi-csim-allzones-dungeons').click();

            await ui._onSimulateAllZones();

            expect(mocks.allZonesRuns).toBe(0);
            expect(warnings).toEqual([expect.stringContaining('max 5 players')]);
        });

        test('switching to dungeon mode while players load does not lift the cap on the zones already chosen', async () => {
            let release;
            mocks.buildPlayerDTOs = () =>
                new Promise((resolve) => {
                    release = resolve;
                });
            ui.panel.querySelector('#mwi-csim-allzones-group').click();

            const run = ui._onSimulateAllZones();
            ui._allZonesMode = 'dungeons';
            release({ players: party(5), playerInfo: [], selfHrid: 'player1', missingMembers: [] });
            await run;

            expect(mocks.allZonesRuns).toBe(0);
            expect(warnings).toEqual([expect.stringContaining('max 3 players')]);
        });

        test('a sweep mixing ordinary zones with planner-added dungeons stays capped at three', async () => {
            mocks.playerDTOs = party(4);
            ui.panel.querySelector('#mwi-csim-allzones-group').click();
            ui._includeDungeons = true;

            await ui._onSimulateAllZones();

            expect(mocks.allZonesRuns).toBe(0);
            expect(warnings).toEqual([expect.stringContaining('max 3 players')]);
        });

        test('a single dungeon run refuses a party larger than five', async () => {
            mocks.playerDTOs = party(6);
            const zone = ui.panel.querySelector('#mwi-csim-zone');
            zone.innerHTML = `<option value="${den.hrid}">Den</option>`;
            zone.value = den.hrid;

            await ui._onSimulate();

            expect(mocks.simRuns).toBe(0);
            expect(warnings).toEqual([expect.stringContaining('max 5 players')]);
        });
    });

    test('a dungeon row is marked [D] and planned at the clear time the run history measured', async () => {
        // Twenty minutes a clear is three an hour, half the sim's six — so the
        // sim's 60 goblins an hour become 30
        mocks.dungeonRuns = [
            { dungeonName: 'Den', tier: 1, duration: 1_200_000, recordedBy: 'char1', team: ['Me'], teamKey: 'Me' },
            { dungeonName: 'Den', tier: 1, duration: 1_200_000, recordedBy: 'char1', team: ['Me'], teamKey: 'Me' },
        ];
        mocks.monsters = [{ monsterHrid: '/monsters/goblin', count: 8 }];
        await ui._displayAllZonesResults([dungeonResult()], 1, gameData);

        // The results table marks it the way the Configure select does
        const zoneCells = [...ui.panel.querySelectorAll('#mwi-csim-results tbody tr td:first-child')].map((td) =>
            td.textContent.trim()
        );
        expect(zoneCells.some((cell) => cell.includes('[D] Den'))).toBe(true);

        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const cells = [...ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
        );
        expect(cells[0][1]).toBe('[D] Den T1▶');
        expect(cells[0][2]).toBe('1:00');
        // Three clears an hour, your pace — not the simulator's six — and the
        // stay is quoted in clears rather than fights. Four rather than three
        // because a clear's goblins are drawn from the wave tables, so the
        // two kills this stay crosses get the same confidence padding every
        // other row gets (`utils/fight-confidence.js`).
        expect(cells[0][3]).toBe('≈4 clears');
        expect(cells[0][4]).toBe('+2');
        // Where the clear time came from rides on the row
        const fightsCell = ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr td')[3];
        expect(fightsCell.getAttribute('title')).toContain('measured (2 runs)');
    });

    test('with no recorded runs the plan says the clear time is the simulator’s', async () => {
        mocks.dungeonRuns = [];
        mocks.monsters = [{ monsterHrid: '/monsters/goblin', count: 8 }];
        await ui._displayAllZonesResults([dungeonResult()], 1, gameData);

        ui.panel.querySelector('#mwi-csim-bestiary-plan-value').value = '1';
        click('#mwi-csim-bestiary-plan-btn');

        const fightsCell = ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr td')[3];
        expect(fightsCell.getAttribute('title')).toContain('sim clear time');
        // The simulator's own six clears an hour, unrescaled — plus the one
        // clear of confidence padding a drawn kill count gets
        const cells = [...ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr td')].map((td) =>
            td.textContent.trim()
        );
        expect(cells[3]).toBe('≈7 clears');
    });
});

describe('runMatchesSimParty: whose dungeon runs may pace a simulation', () => {
    const who = { characterId: 'char1', characterName: 'Me', partySize: 3, roster: ['Me', 'Bo', 'Al'] };

    test('this character’s run with exactly the simulated party counts', () => {
        expect(runMatchesSimParty({ recordedBy: 'char1', team: ['Al', 'Bo', 'Me'], teamKey: 'Al,Bo,Me' }, who)).toBe(
            true
        );
    });

    test('another recorder, another roster or another party size does not', () => {
        expect(runMatchesSimParty({ recordedBy: 'char2', team: ['Al', 'Bo', 'Me'] }, who)).toBe(false);
        expect(runMatchesSimParty({ recordedBy: 'char1', team: ['Al', 'Cy', 'Me'] }, who)).toBe(false);
        expect(runMatchesSimParty({ recordedBy: 'char1', team: ['Me'] }, who)).toBe(false);
        expect(runMatchesSimParty({ recordedBy: 'char1' }, who)).toBe(false);
    });

    test('an unknown roster falls back to the team size alone', () => {
        const run = { recordedBy: 'char1', teamKey: 'Al,Cy,Me' };
        expect(runMatchesSimParty(run, { ...who, roster: null })).toBe(true);
        // A roster of a different length than the sim is stale, not evidence
        expect(runMatchesSimParty(run, { ...who, roster: ['Me'] })).toBe(true);
    });

    test('a legacy unstamped run is this character’s only by name on its roster', () => {
        const solo = { characterId: 'char1', characterName: 'Me', partySize: 1 };
        expect(runMatchesSimParty({ team: ['Me'] }, solo)).toBe(true);
        expect(runMatchesSimParty({ teamKey: 'Alt' }, solo)).toBe(false);
    });
});

describe('the Bestiary column and the plan read one set of dungeon rates', () => {
    const HOUR_NS = 3600 * 1e9;
    const DEN = '/actions/combat/chimerical_den';
    const COVE = '/actions/combat/pirate_cove';
    const gameData = {
        combatMonsterDetailMap: {
            '/monsters/jackalope': { name: 'Jackalope' },
            '/monsters/dodocamel': { name: 'Dodocamel' },
            '/monsters/manticore': { name: 'Manticore' },
            '/monsters/brine_marksman': { name: 'Brine Marksman' },
        },
    };
    /**
     * A 24-hour solo Chimerical Den T2 run the way the sim hands it back
     * (`sim-result.js`): 123 waves an hour, and a party that wipes often
     * enough that only 20 of 59 attempts finish. The clean completion-to-
     * completion pairs average 24 minutes a clear. `deaths` is bodies at T2.
     */
    const denT2 = () => ({
        zone: { name: 'Chimerical Den', difficultyTier: 2, zoneHrid: DEN },
        simResult: {
            simulatedTime: 24 * HOUR_NS,
            encounters: 123 * 24,
            isDungeon: true,
            dungeonsCompleted: 20,
            dungeonsFailed: 39,
            dungeonCleanClearTimeTotal: 12 * 1440 * 1e9,
            dungeonCleanClearCount: 12,
            numberOfPlayers: 1,
            deaths: {
                player1: 39,
                '/monsters/jackalope': 62,
                '/monsters/dodocamel': 40,
                '/monsters/manticore': 20,
            },
            experienceGained: { player1: { defense: 100 } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    /** Pirate Cove T1 that never finishes a run: 98 waves an hour, every attempt a wipe */
    const coveT1 = () => ({
        zone: { name: 'Pirate Cove', difficultyTier: 1, zoneHrid: COVE },
        simResult: {
            simulatedTime: 24 * HOUR_NS,
            encounters: 98 * 24,
            isDungeon: true,
            dungeonsCompleted: 0,
            dungeonsFailed: 60,
            dungeonCleanClearTimeTotal: 0,
            dungeonCleanClearCount: 0,
            numberOfPlayers: 1,
            deaths: { player1: 60, '/monsters/brine_marksman': 30 },
            experienceGained: { player1: { defense: 100 } },
        },
        revenue: { netPerHour: 1, revenuePerHour: 1, costPerHour: 0, dropEntries: [] },
    });
    const click = (selector) =>
        ui.panel.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true }));
    const bestiaryCell = (plainName) => {
        const headers = [...ui.panel.querySelectorAll('#mwi-csim-results th')].map((th) => th.dataset.col);
        const index = headers.indexOf('bestiary');
        const row = [...ui.panel.querySelectorAll('#mwi-csim-results tbody tr')].find((tr) =>
            tr.cells[0].textContent.includes(plainName)
        );
        return row?.cells[index];
    };
    const planRows = () =>
        [...ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
        );

    beforeEach(() => {
        mocks.store.set('settings:combatSimBestiaryPlanHours', 24);
        mocks.store.set('settings:combatSimBestiaryPlanMode', 'points');
        mocks.store.set('settings:combatSimBestiaryPlanPoints', 1);
        ui.buildPanel();
        ui._allZonesSortCol = null;
        ui._bestiaryPlanMode = 'points';
        ui._bestiaryPlanPoints = 1;
        ui._bestiaryPlanTolerance = 0;
        mocks.monsters = [
            { monsterHrid: '/monsters/jackalope', count: 810 },
            { monsterHrid: '/monsters/dodocamel', count: 663 },
            { monsterHrid: '/monsters/manticore', count: 496 },
            { monsterHrid: '/monsters/brine_marksman', count: 79 },
        ];
    });

    afterEach(() => {
        ui.destroy();
        ui._allZonesMode = null;
        mocks.dungeonRuns = [];
        mocks.monsters = null;
        vi.restoreAllMocks();
    });

    test('a wiping dungeon at a measured pace: the column and the plan name the same first point', async () => {
        // Ten minutes a clear at T2 is 2.4x the sim's clean 24 minutes, so the
        // Jackalope's 7.75 credits/hr (62 bodies x 3 over 24 h) become 18.6 and
        // its 190 credits to 1,000 take 10.2 h, in the column and in the plan.
        // Charging the 39 wiped attempts' kills to the 20 clears, as the plan
        // used to, made it 55.8/hr and three thresholds in a few hours while
        // the column still said a day away.
        mocks.dungeonRuns = [
            {
                dungeonName: 'Chimerical Den',
                tier: 2,
                duration: 600_000,
                recordedBy: 'char1',
                team: ['Me'],
                teamKey: 'Me',
            },
            {
                dungeonName: 'Chimerical Den',
                tier: 2,
                duration: 600_000,
                recordedBy: 'char1',
                team: ['Me'],
                teamKey: 'Me',
            },
        ];
        await ui._displayAllZonesResults([denT2()], 24, gameData);

        expect(bestiaryCell('Chimerical Den').textContent).toContain('1st 10.2h');

        click('#mwi-csim-bestiary-plan-btn');
        const rows = planRows();
        expect(rows).toHaveLength(1);
        expect(rows[0][2]).toBe('10:13');
        expect(rows[0][4]).toBe('+4');
        expect(rows[0][5]).toContain('Jackalope 810 → 1000');
        expect(rows[0][5]).not.toContain('Manticore 496 → 1000');
    });

    test('another character’s runs, or this one’s in a different party, do not set the pace', async () => {
        // An alt's fast T2 clears, and this character's own T2 clears in a
        // party of two: neither is the solo character this run simulated, so
        // the sim's own pace stands (24.5 h) instead of the alt's 10 minutes
        mocks.dungeonRuns = [
            {
                dungeonName: 'Chimerical Den',
                tier: 2,
                duration: 600_000,
                recordedBy: 'char2',
                team: ['Alt'],
                teamKey: 'Alt',
            },
            {
                dungeonName: 'Chimerical Den',
                tier: 2,
                duration: 600_000,
                recordedBy: 'char2',
                team: ['Alt'],
                teamKey: 'Alt',
            },
            {
                dungeonName: 'Chimerical Den',
                tier: 2,
                duration: 300_000,
                recordedBy: 'char1',
                team: ['Friend', 'Me'],
                teamKey: 'Friend,Me',
            },
            // A legacy run with no stamp is matched by name, and is the alt's
            { dungeonName: 'Chimerical Den', tier: 2, duration: 300_000, team: ['Alt'], teamKey: 'Alt' },
        ];
        await ui._displayAllZonesResults([denT2()], 24, gameData);

        expect(bestiaryCell('Chimerical Den').textContent).toContain('1st 24.5h');
        click('#mwi-csim-bestiary-plan-btn');
        expect(planRows()[0][2]).toBe('24:31');
        const fightsCell = ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr td')[3];
        expect(fightsCell.getAttribute('title')).toContain('sim clear time');

        // This character's own solo T2 run does set it
        mocks.dungeonRuns.push({
            dungeonName: 'Chimerical Den',
            tier: 2,
            duration: 600_000,
            recordedBy: 'char1',
            team: ['Me'],
            teamKey: 'Me',
        });
        await ui._displayAllZonesResults([denT2()], 24, gameData);
        expect(bestiaryCell('Chimerical Den').textContent).toContain('1st 10.2h');
    });

    test('another tier’s runs do not set a T2 dungeon’s pace', async () => {
        // Only T0 runs on record: a T0 clear says nothing about a T2 one, so
        // the sim's own pace stands and both read 24.5 h
        mocks.dungeonRuns = [
            {
                dungeonName: 'Chimerical Den',
                tier: 0,
                duration: 300_000,
                recordedBy: 'char1',
                team: ['Me'],
                teamKey: 'Me',
            },
            {
                dungeonName: 'Chimerical Den',
                tier: 0,
                duration: 300_000,
                recordedBy: 'char1',
                team: ['Me'],
                teamKey: 'Me',
            },
        ];
        await ui._displayAllZonesResults([denT2()], 24, gameData);

        expect(bestiaryCell('Chimerical Den').textContent).toContain('1st 24.5h');
        click('#mwi-csim-bestiary-plan-btn');
        expect(planRows()[0][2]).toBe('24:31');
        const fightsCell = ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr td')[3];
        expect(fightsCell.getAttribute('title')).toContain('sim clear time');
    });

    test('the plan quotes a dungeon in clears, never in waves', async () => {
        // 20 clears in 24 h at the sim's pace: the day-long stay is a couple
        // of dozen clears, not the three thousand waves fought in it
        await ui._displayAllZonesResults([denT2()], 24, gameData);
        click('#mwi-csim-bestiary-plan-btn');
        const quoted = planRows()[0][3];
        expect(quoted).toMatch(/clears$/);
        const clears = Number(quoted.replace(/[^0-9]/g, ''));
        // 24.5 h at 20/24 clears an hour is ~20.4; padding may add a few
        expect(clears).toBeGreaterThanOrEqual(20);
        expect(clears).toBeLessThan(40);
    });

    test('a dungeon the sim never cleared quotes no clear count, not its waves as clears', async () => {
        await ui._displayAllZonesResults([coveT1()], 24, gameData);
        click('#mwi-csim-bestiary-plan-btn');

        const rows = planRows();
        expect(rows).toHaveLength(1);
        expect(rows[0][1]).toBe('[D] Pirate Cove T1');
        expect(rows[0][3]).toBe('—');
        expect(ui.panel.querySelectorAll('.mwi-csim-plan-open-btn')).toHaveLength(0);
        const nameCell = ui.panel.querySelectorAll('#mwi-csim-bestiary-plan-out tbody tr td')[1];
        expect(nameCell.getAttribute('title')).toContain('never cleared in the sim');
    });

    test('a Dungeons run does not offer the Include dungeons switch it would ignore', async () => {
        ui._allZonesMode = 'dungeons';
        await ui._displayAllZonesResults([denT2()], 24, gameData);
        expect(ui.panel.querySelector('#mwi-csim-bestiary-plan-dungeons')).toBeNull();

        ui._allZonesMode = 'solo';
        await ui._displayAllZonesResults([denT2()], 24, gameData);
        expect(ui.panel.querySelector('#mwi-csim-bestiary-plan-dungeons')).not.toBeNull();
    });
});

describe('remembered-run banner', () => {
    test('names the character and zone with tier when meta is present', () => {
        const html = ui._restoredUpgradeNote(null, {
            characterName: 'Millennium44',
            zoneName: 'Planet Of The Eyes',
            difficultyTier: 2,
        });
        expect(html).toContain(
            'Showing results remembered from a previous session — Millennium44, Planet Of The Eyes (T2).'
        );
    });

    test('omits the tier when it is not a number', () => {
        const html = ui._restoredUpgradeNote(null, {
            characterName: 'Millennium44',
            zoneName: 'Planet Of The Eyes',
            difficultyTier: null,
        });
        expect(html).toContain('— Millennium44, Planet Of The Eyes.');
        expect(html).not.toContain('(T');
    });

    test('shows only the zone when the character name is missing', () => {
        const html = ui._restoredUpgradeNote(null, {
            characterName: null,
            zoneName: 'Smelly Planet',
            difficultyTier: 0,
        });
        expect(html).toContain('— Smelly Planet (T0).');
    });

    test('renders the legacy sentence for a payload saved before meta existed', () => {
        const html = ui._restoredUpgradeNote(null, null);
        expect(html).toContain(
            'Showing results remembered from a previous session. Run a new analysis to refresh them.'
        );
        expect(html).not.toContain('—');
    });

    test('escapes markup in the character name', () => {
        const html = ui._restoredUpgradeNote(null, { characterName: '<img src=x>', zoneName: null });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=x&gt;');
    });
});

describe('the cost basis detail', () => {
    test('an incremental enhancement path does not describe buying and reselling the same item', () => {
        const html = ui._renderUpgradeCostBasis({
            costSource: 'sim',
            costDetail: { gross: 300_000, credit: 0, enhancementPath: true },
            candidate: { type: 'enhancement' },
        });

        expect(html).toContain('Enhances for');
        expect(html).not.toContain('Buys');
        expect(html).not.toContain('resale credit');
    });

    test('a sweep-priced row names whose enhancing stats it ran on', () => {
        // Not a new column: the missing half of the sentence the basis line
        // already gives about "an expected cost over a random process"
        const html = ui._renderUpgradeCostBasis({
            costSource: 'sim',
            costDetail: {
                gross: 5_000_000,
                credit: 0,
                enhanceSource: { kind: 'pro', label: 'Pro', detail: 'Pro rates: enhancing 140' },
            },
            candidate: {},
        });

        expect(html).toContain('Enhance rates: Pro');
        expect(html).toContain('Pro rates: enhancing 140');
    });

    test('the label stands alone when the source has no detail behind it', () => {
        const html = ui._renderUpgradeCostBasis({
            costSource: 'sim',
            costDetail: { gross: 1, credit: 0, enhanceSource: { kind: 'yours', label: 'Yours', detail: null } },
            candidate: {},
        });
        expect(html).toContain('Enhance rates: Yours.');
    });

    test('a row with no sweep behind it says nothing about benches', () => {
        const html = ui._renderUpgradeCostBasis({
            costSource: 'market',
            costDetail: { gross: 5_000_000, credit: 0, enhanceSource: null },
            candidate: {},
        });
        expect(html).not.toContain('Enhance rates');
    });
});
