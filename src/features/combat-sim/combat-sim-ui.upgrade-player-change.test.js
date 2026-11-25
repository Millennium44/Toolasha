/** @vitest-environment happy-dom */

/**
 * Combat Sim panel: the parts that are about state rather than arithmetic —
 * what survives a cancelled analysis, what the status line is allowed to say
 * while a run is in flight, and whether the budget planner's combat rows still
 * mean anything to a planner written for the labyrinth.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('../profile/build-score-row.js', () => ({
    readOwnScore: () => null,
    ensureOwnScore: async () => null,
    ownProfileData: () => null,
    buildFingerprint: () => null,
    scorePricingStamp: () => '',
}));
vi.mock('../profile/score-calculator.js', () => ({ calculateCombatScore: async () => null }));

const mocks = vi.hoisted(() => ({
    /** Background work held back, as it is while features start; `mocks.runBackground()` lets it go */
    bgJobs: [],
    /** What the scroll table reads as the best gold/token; null means the shop prices nothing */
    scrollRate: null,
    upgradeResult: { baseline: null, results: [], food: null },
    onRun: null,
    /** Called inside the editor stub's applyTriggerValueChanges, to change the build the way a real apply does */
    onApply: null,
    /** Called inside the trigger optimizer mock, before it answers (may return a promise) */
    onTrigger: null,
    triggerEstimate: null,
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
    /** Every all-zones run's params, in order — a Solo zones + party dungeons run makes two */
    allZonesArgsLog: [],
    /** Optional (params) → results, for a test whose sweeps must answer differently */
    allZonesResultFor: null,
    /** Optional (simResult, playerHrid) → revenue, standing in for calculateSimRevenue's answer */
    revenueFor: null,
    /** itemHrid → unit price, what `resolveItemPrice` answers with */
    itemPrices: {},
    /** The Bestiary as `getCharacterMonsters` hands it back; null until the tab has loaded it */
    monsters: null,
    /** Dungeon runs the bridge's run-history store answers with */
    dungeonRuns: [],
    /** What SimEditor#getEditedDTOs() hands back; null unless a test opts in */
    editedDTOs: null,
    /** The options the panel built the editor stub with (its onRender listener) */
    editorOptions: null,
    /** hrid -> the name the editor reports for it (the hrid itself when unset) */
    playerNames: null,
    /** Names of party members with no loaded profile */
    missingMembers: null,
    /** Builds the result of each `runUpgradeAnalysis` call from its args; unset answers `upgradeResult` */
    upgradeResultFor: null,
    /** What SimEditor#getSelfHrid() hands back */
    editorSelfHrid: null,
    /** What SimEditor#getActiveEditPlayer() hands back — the tab open in the editor */
    editorActivePlayer: null,
    /** What SimEditor#getSoloMode() hands back */
    editorSoloMode: false,
    /** What runSimulation() resolves with; null falls back to `{}` */
    simResult: null,
    /** The params object the last runSimulation() call was made with */
    simRunArgs: null,
    simRuns: 0,
    allZonesRuns: 0,
    /** playerHrid each calculateSimRevenue() call was made with, in order */
    revenueCalls: [],
    /** The options object each calculateSimRevenue() call was made with, in order */
    revenueOptions: [],
    /** The sale tax rate argument of each taxedDropValue() call, in order (null: the live rate) */
    taxedDropRates: [],
    /** How many upgrade-advisor runs and worker cancellations were requested */
    upgradeRuns: 0,
    cancelActiveCalls: 0,
    /** Who is logged in; a test moves it mid-run to stage a character switch */
    characterId: 'char1',
    /** Whether the House Upgrade target grid omits skilling-only rooms */
    skipSkillingRooms: false,
    /** `combatSim_partyFinder`: off unless a test turns the Party tab on */
    partyFinder: false,
    /** `combatSim_talismanLineRanking`, and whether the section may be drawn (test server + talisman tables) */
    talismanRanking: true,
    talismanAvailable: false,
    /** `isTestServer()` */
    testServer: true,
    settingChangeCallbacks: new Map(),
    /** The `getSettingValue` mock's `profitCalc_keyPricingMode`, for the pricing quick-settings row */
    keyPricingMode: 'ask',
    /** What `loadoutSnapshot()` (the bundle bridge) hands back; null means the store has not loaded */
    loadoutStore: null,
    /** What SimEditor#getSelectedLoadoutName() hands back */
    editorLoadoutName: '',
    /** What SimEditor#getLoadoutNameFor(hrid) hands back, keyed by hrid */
    editorLoadoutNameFor: {},
    editorLoadoutIdFor: {},
    /** What SimEditor#getOriginalDTO(hrid) hands back — the pre-loadout, current-gear
     *  DTO for that player — keyed by hrid */
    editorOriginalDTOs: {},
    /** Every `applyLoadoutSnapshotToDTO` call, in order: {hrid, snapshotName} */
    loadoutApplications: [],
    /** Optional snapshotName → food array, so a mocked loadout application can carry its own food */
    loadoutFood: null,
    /** Callbacks registered via the loadoutSnapshot() mock's onUpdate, so a test can fire one */
    loadoutUpdateListeners: [],
    /** What `runTriggerOptimization` resolves with, and every call it was made with */
    triggerResult: null,
    triggerRuns: [],
    /** Every list of changes handed to the editor's `applyTriggerValueChanges` */
    triggerApplied: [],
    /** When set, `runTriggerOptimization` throws it */
    triggerFail: null,
    /** When set, the SimEditor stub answers `applyTriggerValueChanges` with this */
    applyOutcome: null,
    /** Every list handed to the editor's `applyTriggerRowChanges`, and an optional outcome to answer it with */
    rowApplied: [],
    rowOutcome: null,
    /** The `combatSim_autoVerifyCloseCalls` setting */
    autoVerify: false,
    /** Every `verifyCombatCandidates` call's params, and an optional (params) => outcome standing in for it */
    verifyCalls: [],
    verifyImpl: null,
    /** Every `verifyTriggerChanges` call's params, and an optional (params) => outcome */
    triggerVerifyCalls: [],
    triggerVerifyImpl: null,
}));

vi.mock('./trigger-optimizer.js', () => ({
    STREAM_WIDTH: 64,
    concurrency: () => 1,
    createLimiter: () => (task) => task(),
    triggerUseFromResult: () => ({}),
    sampleFromResult: () => ({}),
    monsterMaxHpReader: () => () => 0,
    estimateTriggerRun: (params) =>
        mocks.triggerEstimate?.(params) ?? {
            tunables: [],
            wholeParty: false,
            condition: { slots: 0, counts: [], sims: 0 },
            thresholdSims: 0,
            total: 1,
        },
    runTriggerOptimization: async (params) => {
        mocks.triggerRuns.push(params);
        await mocks.onTrigger?.(params);
        if (mocks.triggerFail) throw mocks.triggerFail;
        return mocks.triggerResult;
    },
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
            if (key === 'combatSim_autoVerifyCloseCalls') return mocks.autoVerify;
            return fallback;
        },
        getSetting: (key, fallback = false) => {
            if (key === 'combatSim_upgradeSkipSkillingRooms') return mocks.skipSkillingRooms;
            if (key === 'combatSim_partyFinder') return mocks.partyFinder;
            if (key === 'combatSim_talismanLineRanking') return mocks.talismanRanking;
            return fallback;
        },
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
                // A wedged database answers the default, as `storage.get` does
                if (mocks.unreadable) return fallback;
                const value = mocks.store.get(keyOf(key, store));
                return value === undefined ? fallback : value;
            },
            // A read that says whether it worked: `mocks.unreadable` makes every one fail, as a wedged database does
            tryGet: async (key, store) => {
                if (mocks.unreadable) return null;
                const value = mocks.store.get(keyOf(key, store));
                return value == null ? { found: false, value: null } : { found: true, value };
            },
            // One transaction, not through the per-key reads, so a spy on those sees only single reads. A
            // wedged database answers null per key, and tryGetMany is all or nothing
            getMany: async (keys, store) =>
                new Map(
                    keys.map((key) => {
                        const value = mocks.unreadable ? undefined : mocks.store.get(keyOf(key, store));
                        return [key, value === undefined ? null : value];
                    })
                ),
            tryGetMany: async (keys, store) => {
                if (mocks.unreadable) return null;
                return new Map(
                    keys.map((key) => {
                        const value = mocks.store.get(keyOf(key, store));
                        return [key, value == null ? { found: false, value: null } : { found: true, value }];
                    })
                );
            },
            set: async (key, value, store) => {
                mocks.setLog?.push(keyOf(key, store));
                mocks.store.set(keyOf(key, store), value);
                return true;
            },
            parseJSON: (raw, _key, fallback) => (raw === null ? fallback : raw),
            getJSON: async (key, store, fallback) => {
                const value = mocks.store.get(keyOf(key, store));
                return value === undefined ? fallback : value;
            },
            setJSON: async (key, value, store) => {
                mocks.store.set(keyOf(key, store), value);
                return true;
            },
            update: async (key, mutate, store) => {
                const next = mutate(mocks.store.get(keyOf(key, store)), mocks.store.has(keyOf(key, store)));
                if (next !== undefined) mocks.store.set(keyOf(key, store), next);
                return { written: next !== undefined, value: next };
            },
            updateMany: async (store, keys, mutate) => {
                const values = {};
                for (const key of keys) values[key] = mocks.store.get(keyOf(key, store));
                const entries = mutate({ ...values });
                const written = Object.keys(entries || {});
                for (const key of written) {
                    mocks.store.set(keyOf(key, store), entries[key]);
                    values[key] = entries[key];
                }
                return { values, written };
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
            guildShrineDetailMap: mocks.guildShrineDetailMap,
            // Only the self-enhanced (cape) tests put items here; everything
            // else is unknown to the map and keeps the ordinary market path
            itemDetailMap: mocks.itemDetailMap || {},
            actionDetailMap: mocks.actionDetails || undefined,
        }),
        // `characterItems`, read by the Enhance button to pick a held copy
        getInventory: () => mocks.inventory ?? null,
        // The live character's own house room level — used only as a display
        // fallback before any DTO has loaded; a loaded DTO (self, imported, or a
        // party member's) must never fall through to this for a room it lacks
        getHouseRoomLevel: (hrid) => mocks.houseRoomLevels?.[hrid] || 0,
        getCharacterMonsters: () => mocks.monsters,
        getCharacterMonstersAt: () => mocks.monstersAt ?? null,
        getActionDetails: (hrid) => mocks.actionDetails?.[hrid] ?? null,
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
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
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
    // onUpdate/offUpdate default to no-ops so a test that only cares about
    // getAllSnapshots (most of them) doesn't also have to stub the update
    // subscription buildPanel()/destroy() now use; a test that does care
    // (the live-update tests) overrides them explicitly.
    // onUpdate/offUpdate default to a real (if minimal) subscription list —
    // most tests never touch it (they only care about getAllSnapshots), but
    // the live-update tests fire a captured listener to simulate the
    // snapshot store emitting a change while the sim panel is open.
    loadoutSnapshot: () =>
        mocks.loadoutStore
            ? {
                  onUpdate: (fn) => mocks.loadoutUpdateListeners.push(fn),
                  offUpdate: (fn) => {
                      mocks.loadoutUpdateListeners = mocks.loadoutUpdateListeners.filter((l) => l !== fn);
                  },
                  ...mocks.loadoutStore,
              }
            : null,
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => mocks.prices[hrid] || { bid: 0, ask: 0 } },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        calculateExpectedValue: () => null,
        getCachedValue: () => null,
        calculateSingleContainer: (hrid) => mocks.openableValues?.[hrid] ?? null,
        calculateContainerValueAtTaxRate: () => null,
    },
}));

vi.mock('../../utils/background-work.js', () => ({
    runInBackground: (_name, work) =>
        new Promise((resolve) => {
            mocks.bgJobs.push(async () => resolve(await work()));
        }),
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

vi.mock('./combat-sim-adapter.js', async () => {
    const { getItemPrice } = await import('../../utils/market-data.js');
    const evc = (await import('../market/expected-value-calculator.js')).default;
    // Faithful to the real one: coin untaxed, cowbell 18%, everything else the
    // 5% patch-live market rate the suite runs under; another player's explicit
    // rate (0 for an Iron Cow, bags included) when one is passed
    const taxedDropValue = (hrid, v, rate = null) => {
        mocks.taxedDropRates.push(rate);
        if (!(v > 0) || hrid === '/items/coin') return v;
        if (Number.isFinite(rate))
            return rate === 0 ? v : v * (1 - (hrid === '/items/bag_of_10_cowbells' ? 0.18 : rate));
        return v * (1 - (hrid === '/items/bag_of_10_cowbells' ? 0.18 : 0.05));
    };
    // The real dropUnitValue over the mocked price book and expected-value calculator
    const dropUnitValue = (hrid, rate = null) => {
        if (hrid === '/items/coin') return { priced: true, unitValue: 1 };
        const gross = getItemPrice(hrid, { context: 'profit', side: 'sell' });
        let unitValue = taxedDropValue(hrid, gross ?? 0, rate);
        if (unitValue === 0) {
            const ev = Number.isFinite(rate)
                ? evc.calculateContainerValueAtTaxRate(hrid, rate)
                : evc.getCachedValue(hrid) || evc.calculateSingleContainer(hrid);
            if (ev !== null && ev > 0) unitValue = ev;
        }
        return { priced: gross != null, unitValue };
    };
    return {
        seedSimPriceCache: (cache) => cache,

        buildGameDataPayload: () => mocks.gameData,
        // The Party tab reads the live build only when asked to (Copy my build, or simming as yourself)
        buildPlayerDTO: () => null,
        buildAllPlayerDTOs: async () =>
            mocks.buildPlayerDTOs
                ? mocks.buildPlayerDTOs()
                : { players: mocks.playerDTOs, playerInfo: [], selfHrid: 'player1', missingMembers: [] },
        getCombatZones: () => mocks.zones,
        getCurrentCombatZone: () => null,
        getCommunityBuffs: () => ({}),
        calculateExpectedDrops: () => mocks.drops,
        calculateDungeonKeyCosts: () => [],
        calculateSimRevenue: (simResult, gameData, playerHrid, _hours, options) => {
            mocks.revenueCalls.push(playerHrid);
            mocks.revenueOptions.push(options);
            return mocks.revenueFor?.(simResult, playerHrid) || { netPerHour: 0, costPerHour: 0, revenuePerHour: 0 };
        },
        taxedDropValue,
        dropUnitValue,
        getZonesThatDropItem: () => [],
        getGuildBuffDetailMap: () => mocks.guildBuffDetailMap || {},
        guildBuffMaxLevel: (detail) => detail?.maxLevel ?? 20,
        parseShykaiImport: () => null,
        buildShykaiExportPlayer: () => ({}),
        recomputeLevelGapDebuffs: () => {},
        // Stands in for the real loadout-applying mutation: tags the DTO with
        // which loadout was "applied" (and records the call) rather than
        // resolving real equipment, which these tests have no game data for.
        applyLoadoutSnapshotToDTO: (dto, snapshotName) => {
            mocks.loadoutApplications.push({ hrid: dto?.hrid, snapshotName });
            dto.appliedLoadout = snapshotName;
            // Real applyLoadoutSnapshotToDTO overwrites food/drinks wholesale;
            // opted into per test via mocks.loadoutFood so the max-tier-food
            // ordering tests can prove the substitution sees the loadout's own
            // food, not whatever the DTO carried before the loadout ran.
            // Keyed by name either way: the per-sweep pickers now hand this the
            // actual snapshot object (see _resolveSoloPartyLoadout), not just its
            // name, so a plain string key would never match one.
            const foodKey = snapshotName && typeof snapshotName === 'object' ? snapshotName.name : snapshotName;
            if (mocks.loadoutFood?.[foodKey]) dto.food = mocks.loadoutFood[foodKey];
            return true;
        },
    };
});

vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: async (params) => {
        mocks.simRuns++;
        mocks.simRunArgs = params;
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
    // The 4% market sell tax a resale pays
    calculatePriceAfterTax: (price, rate = 0.04) => price * (1 - rate),
    outputTaxRate: (rate = 0.04) => rate,

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
vi.mock('../../utils/enhancement-calculator.js', () => ({
    calculateEnhancement: () => ({}),
    blessedMirrorChance: () => 0,
    mirrorLandingOdds: (usedMirror) => usedMirror.map(() => 1),
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({}),
    getAutoDetectedParams: () => ({}),
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: () => 0,
    getProductionCost: () => 0,
}));
vi.mock('../../utils/enhancement-pricing.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getProductionCost: () => 0,
}));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    // 1,000 XP a level, 500 XP a book — enough arithmetic for a book count
    explainAbilityLevelUpCost: (abilityHrid, level, xp, targetLevel) => ({
        books: (1000 * targetLevel - xp) / 500,
    }),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: () => ({}) }));
// The section itself is tested in talisman-line-ranking-ui.test.js; here only how the panel builds and drops it
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => mocks.testServer,
}));
vi.mock('./talisman-line-ranking-ui.js', () => ({
    talismanRankingAvailable: () => mocks.talismanAvailable,
    TalismanLineRankingSection: class {
        constructor(host) {
            this.host = host;
            this.root = null;
            this.busy = false;
        }
        mount(container) {
            this.root = document.createElement('div');
            this.root.className = 'mwi-csim-talisman-rank-test';
            container.appendChild(this.root);
        }
        detach() {
            this.root?.remove();
            this.root = null;
        }
        isBusy() {
            return this.busy;
        }
        onShow() {}
    },
}));

vi.mock('./all-zones-runner.js', () => ({
    runAllZonesSimulation: async (params) => {
        mocks.allZonesRuns++;
        mocks.allZonesArgs = params;
        mocks.allZonesArgsLog.push(params);
        if (params.onProgress) params.onProgress(100);
        return mocks.allZonesResultFor ? mocks.allZonesResultFor(params) : mocks.allZonesResult;
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
    hasMeasuredVolume: () => false,
    itemDailyVolume: async (itemHrid) => ({ itemHrid, unitsPerDay: 0, days: 0, known: false }),
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
        constructor(options) {
            mocks.editorOptions = options;
        }
        getEditedDTOs() {
            return mocks.editedDTOs;
        }
        getSelfHrid() {
            return mocks.editorSelfHrid;
        }
        getActiveEditPlayer() {
            return mocks.editorActivePlayer;
        }
        getSoloMode() {
            return mocks.editorSoloMode;
        }
        setSoloMode(value) {
            mocks.editorSoloMode = value;
        }
        getSelectedLoadoutName() {
            return mocks.editorLoadoutName;
        }
        getLoadoutNameFor(playerHrid) {
            return mocks.editorLoadoutNameFor?.[playerHrid] || '';
        }
        getLoadoutIdFor(playerHrid) {
            return mocks.editorLoadoutIdFor?.[playerHrid] || '';
        }
        getOriginalDTO(playerHrid) {
            return mocks.editorOriginalDTOs?.[playerHrid] || null;
        }
        getPlayerInfo() {
            return mocks.editedDTOs
                ? Object.keys(mocks.editedDTOs).map((hrid) => ({ hrid, name: mocks.playerNames?.[hrid] ?? hrid }))
                : [];
        }
        getMissingMembers() {
            return mocks.missingMembers || [];
        }
        applyTriggerValueChanges(changes) {
            mocks.triggerApplied.push(changes);
            mocks.onApply?.(changes);
            return mocks.applyOutcome || { applied: changes.length, skipped: [] };
        }
        applyTriggerRowChanges(changes) {
            mocks.rowApplied.push(changes);
            return mocks.rowOutcome || { applied: changes.length, skipped: [], appliedChanges: changes };
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
        generateSimLabel(playerHrid) {
            mocks.labelPlayer = playerHrid;
            return 'Current Gear';
        }
        reset() {}
    },
}));

vi.mock('./scroll-pricing.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, scrollTokenRate: () => mocks.scrollRate };
});
// The engine's classifiers stay real; the simulations behind them are the part that is stood in for
vi.mock('./verify-runner.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        verifyCombatCandidates: async (params) => {
            mocks.verifyCalls.push(params);
            return mocks.verifyImpl ? mocks.verifyImpl(params) : { rows: [], refused: 'rows' };
        },
        verifyTriggerChanges: async (params) => {
            mocks.triggerVerifyCalls.push(params);
            return mocks.triggerVerifyImpl ? mocks.triggerVerifyImpl(params) : { rows: [], refused: 'nothing' };
        },
    };
});
vi.mock('./upgrade-advisor.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        runUpgradeAnalysis: async (...args) => {
            mocks.upgradeRuns++;
            mocks.onRun?.(...args);
            // A distinct result per call, when a test needs to tell the players' runs apart
            if (mocks.upgradeResultFor) return mocks.upgradeResultFor(...args);
            return mocks.upgradeResult;
        },
        confirmUpgradeBudgetPlan: async (...args) => {
            mocks.onConfirm?.(...args);
            return mocks.confirmResult;
        },
    };
});

const { default: ui, DEFAULT_SCORE_DEPTH } = await import('./combat-sim-ui.js');

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
    // Held background jobs are closures over the panel and its results; left queued they pile up for the whole file
    mocks.bgJobs.length = 0;
    ui._upgradeSort = null;
    ui._upgradeLevelSort = null;
    ui._unpricedSort = null;
    ui._upgradeHiddenColumns = null;
    ui._upgradeScoreKeys = null;
    ui._upgradeScoreDepth = DEFAULT_SCORE_DEPTH;
    ui._upgradeLevelScoreScale = undefined;
    ui._upgradeScoreGradient = false;
});

/**
 * The Upgrade tab when the sim is handed a different player.
 *
 * The rows belong to the roster they were measured for. A profile, a party or a pasted roster replacing that
 * roster used to leave them on screen under an "analysis is out of date" banner, as if the other character's
 * numbers described the build now loaded. They are dropped; the remembered record stays the owner's.
 */
describe('Upgrade results when another player is loaded into the sim', () => {
    const settle = async () => {
        for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const milk = { hrid: 'player1', name: 'Milkman', equipment: { '/item_locations/body': { itemHrid: '/items/a' } } };
    const bessie = { hrid: 'player1', name: 'Bessie', equipment: { '/item_locations/body': { itemHrid: '/items/b' } } };
    const sameNamed = { ...bessie, name: 'Milkman' };
    const replaced = () => mocks.editorOptions.onScenarioReplaced();
    const rows = () => ui.panel.querySelector('#mwi-csim-upgrade-results');
    const note = () => ui.panel.querySelector('#mwi-csim-analysis-note');
    const storedKeys = () => [...mocks.store.keys()].filter((k) => k.includes('combatSimUpgradeResults'));

    async function analyzeSelf() {
        ui.buildPanel();
        await settle();
        selectZone();
        mocks.editedDTOs = { player1: structuredClone(milk) };
        mocks.editorSelfHrid = 'player1';
        mocks.upgradeResult = {
            baseline: BASELINE,
            results: [row('Main gear')],
            food: null,
            context: { gameData: {} },
        };
        await ui._onUpgradeAnalyze();
        await settle();
    }

    beforeEach(async () => {
        const { default: config } = await import('../../core/config.js');
        vi.spyOn(config, 'getSetting').mockImplementation((key, fallback = false) =>
            key === 'combatSim_rememberUpgradeResults' ? true : fallback
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        ui.destroy();
        mocks.editedDTOs = null;
        mocks.editorSelfHrid = null;
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.store.clear();
    });

    test('another character loaded: their rows are gone, no banner over a stranger', async () => {
        await analyzeSelf();
        expect(text()).toContain('Main gear');
        replaced();
        mocks.editedDTOs = { player1: structuredClone(bessie) };
        expect(ui._upgradeResultsData).toBeNull();
        expect(rows().textContent).not.toContain('Main gear');
        expect(note().style.display).toBe('none');
        expect(note().textContent).toBe('');
    });

    test('a same-named stranger is told apart by the load, not the name', async () => {
        await analyzeSelf();
        replaced();
        mocks.editedDTOs = { player1: structuredClone(sameNamed) };
        expect(ui._upgradeResultsData).toBeNull();
        expect(rows().textContent).not.toContain('Main gear');
    });

    test('the owner saved record is neither read nor rewritten by the drop', async () => {
        await analyzeSelf();
        const before = storedKeys().map((k) => [k, JSON.stringify(mocks.store.get(k))]);
        expect(before.length).toBeGreaterThan(0);
        replaced();
        await settle();
        expect(storedKeys().map((k) => [k, JSON.stringify(mocks.store.get(k))])).toEqual(before);
    });

    test('an in-place edit of the same player keeps the rows and shows the banner', async () => {
        await analyzeSelf();
        mocks.editedDTOs = { player1: { ...structuredClone(milk), equipment: {} } };
        ui._refreshAnalysisNote();
        expect(ui._upgradeResultsData).not.toBeNull();
        expect(text()).toContain('Main gear');
        expect(note().style.display).toBe('block');
        expect(note().textContent).toContain('measured before the build changed');
    });

    test('a run in progress is left alone', async () => {
        await analyzeSelf();
        ui._upgradeRunning = true;
        const html = rows().innerHTML;
        replaced();
        expect(rows().innerHTML).toBe(html);
        expect(ui._upgradeResultsData).not.toBeNull();
        ui._upgradeRunning = false;
    });

    test('nothing on screen: nothing to do, nothing thrown', async () => {
        ui.buildPanel();
        await settle();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => replaced()).not.toThrow();
        expect(errors).not.toHaveBeenCalled();
        expect(ui._upgradeResultsData).toBeNull();
    });

    test('an All players analysis is dropped whole, including its sections', async () => {
        await analyzeSelf();
        ui._allPlayersRun = { entries: [{ hrid: 'player1', results: ui._upgradeResultsData }], active: 'player1' };
        replaced();
        expect(ui._allPlayersRun).toBeNull();
        expect(ui._upgradeResultsData).toBeNull();
        expect(rows().innerHTML).toBe('');
    });

    test('a remembered table drawn after a restore is dropped too', async () => {
        await analyzeSelf();
        ui.destroy();
        ui.buildPanel();
        await settle();
        for (const job of mocks.bgJobs.splice(0)) await job();
        await settle();
        expect(ui._rememberedResults).not.toBeNull();
        replaced();
        await settle();
        expect(ui._rememberedResults).toBeNull();
        expect(ui._restoredUpgradeAt).toBeNull();
        expect(rows().textContent).not.toContain('Main gear');
    });

    test('a fresh analysis after the load draws again', async () => {
        await analyzeSelf();
        replaced();
        mocks.editedDTOs = { player1: structuredClone(bessie) };
        await ui._onUpgradeAnalyze();
        await settle();
        expect(ui._upgradeResultsData).not.toBeNull();
        expect(text()).toContain('Main gear');
    });
});

/**
 * Whose analysis is remembered, and whose rows are drawn.
 *
 * The remembered record is per logged-in character and has no undo. A run for an imported profile or a pasted
 * party used to replace it (and restored under the owner's name on the next reload), and Reset to Me left that
 * stranger's rows on screen.
 */
describe('Upgrade results and the remembered record across rosters', () => {
    const KEY = 'combatExport:combatSimUpgradeResults_char1';
    const settle = async () => {
        for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const rows = () => ui.panel.querySelector('#mwi-csim-upgrade-results');
    const note = () => ui.panel.querySelector('#mwi-csim-analysis-note');
    const ownRecord = (extra = {}) => ({
        data: { baseline: BASELINE, results: [row('Owner gear')], ranFor: { hrid: 'player1', name: 'Me' } },
        savedAt: 5,
        characterName: 'Me',
        ...extra,
    });
    const stranger = {
        hrid: 'player1',
        name: 'NikuDango',
        equipment: { '/item_locations/body': { itemHrid: '/items/z' } },
    };
    const me = { hrid: 'player1', name: 'Me', equipment: { '/item_locations/body': { itemHrid: '/items/a' } } };

    /** The seeded owner record is still the owner's: the mock store returns the live object, which a draw annotates */
    const expectOwnerRecord = () => {
        const record = mocks.store.get(KEY);
        expect(record.savedAt).toBe(5);
        expect(record.characterName).toBe('Me');
        expect(record.data.results.map((r) => r.candidate.description)).toEqual(['Owner gear']);
    };

    async function analyze({ dtos = { player1: structuredClone(me) }, names, selfHrid, label = 'Fresh gear' }) {
        mocks.editedDTOs = dtos;
        mocks.playerNames = names || { player1: 'Me' };
        mocks.editorSelfHrid = selfHrid;
        mocks.upgradeResult = { baseline: BASELINE, results: [row(label)], food: null, context: { gameData: {} } };
        await ui._onUpgradeAnalyze();
        await settle();
    }
    async function openPanel() {
        ui.buildPanel();
        await settle();
        for (const job of mocks.bgJobs.splice(0)) await job();
        await settle();
        selectZone();
    }

    beforeEach(async () => {
        mocks.store.clear();
        mocks.characterId = 'char1';
        mocks.characterName = 'Me';
        const { default: config } = await import('../../core/config.js');
        vi.spyOn(config, 'getSetting').mockImplementation((key, fallback = false) =>
            key === 'combatSim_rememberUpgradeResults' ? true : fallback
        );
    });
    afterEach(() => {
        vi.restoreAllMocks();
        ui.destroy();
        mocks.editedDTOs = null;
        mocks.editorSelfHrid = null;
        mocks.playerNames = null;
        mocks.characterName = undefined;
        mocks.onRun = null;
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.store.clear();
    });

    test('own analysis: drawn, saved for the owner with their id', async () => {
        await openPanel();
        await analyze({ selfHrid: 'player1' });
        expect(rows().textContent).toContain('Fresh gear');
        const saved = mocks.store.get(KEY);
        expect(saved.data.results[0].candidate.description).toBe('Fresh gear');
        expect(saved.ownerId).toBe('char1');
    });

    test('party with the live character as player 1: a partner run is saved too', async () => {
        await openPanel();
        await analyze({
            dtos: { player1: structuredClone(me), player2: { ...structuredClone(stranger), hrid: 'player2' } },
            names: { player1: 'Me', player2: 'Partner' },
            selfHrid: 'player1',
        });
        expect(mocks.store.get(KEY).ownerId).toBe('char1');
    });

    test('external analysis: drawn, never saved, the owner record is byte-identical', async () => {
        mocks.store.set(KEY, ownRecord());
        await openPanel();
        await analyze({
            dtos: { player1: structuredClone(stranger) },
            names: { player1: 'NikuDango' },
            selfHrid: null,
        });
        expect(rows().textContent).toContain('Fresh gear');
        expectOwnerRecord();
    });

    test('pasted party (nobody is the live character): drawn, never saved', async () => {
        await openPanel();
        await analyze({
            dtos: { player1: structuredClone(stranger), player2: { ...structuredClone(me), hrid: 'player2' } },
            names: { player1: 'NikuDango', player2: 'Me' },
            selfHrid: null,
        });
        expect(mocks.store.has(KEY)).toBe(false);
    });

    test('external then Reset to Me: the stranger rows go and the owner record is drawn', async () => {
        mocks.store.set(KEY, ownRecord());
        await openPanel();
        await analyze({
            dtos: { player1: structuredClone(stranger) },
            names: { player1: 'NikuDango' },
            selfHrid: null,
        });
        expect(rows().textContent).toContain('Fresh gear');
        // The editor holds the live character again by the time it says so
        mocks.editedDTOs = { player1: structuredClone(me) };
        mocks.editorSelfHrid = 'player1';
        mocks.editorOptions.onRosterReloaded();
        await settle();
        expect(rows().textContent).not.toContain('Fresh gear');
        expect(rows().textContent).toContain('Owner gear');
        expect(note().style.display).toBe('none');
    });

    test('external then Reset to Me with nothing saved: an empty tab', async () => {
        await openPanel();
        await analyze({
            dtos: { player1: structuredClone(stranger) },
            names: { player1: 'NikuDango' },
            selfHrid: null,
        });
        mocks.editorOptions.onRosterReloaded();
        await settle();
        expect(ui._upgradeResultsData).toBeNull();
        expect(rows().textContent).toBe('');
    });

    test('own rows on screen: Fetch or Reset keeps rows and banner', async () => {
        await openPanel();
        await analyze({ selfHrid: 'player1' });
        mocks.editedDTOs = { player1: { ...structuredClone(me), equipment: {} } };
        mocks.editorOptions.onRosterReloaded();
        await settle();
        expect(rows().textContent).toContain('Fresh gear');
        ui._refreshAnalysisNote();
        expect(note().style.display).toBe('block');
    });

    test('external then reload: the owner record is what comes back', async () => {
        mocks.store.set(KEY, ownRecord());
        await openPanel();
        await analyze({
            dtos: { player1: structuredClone(stranger) },
            names: { player1: 'NikuDango' },
            selfHrid: null,
        });
        ui.destroy();
        // A reload starts with the live character in the editor
        mocks.editedDTOs = null;
        mocks.editorSelfHrid = null;
        await openPanel();
        expect(rows().textContent).toContain('Owner gear');
        expect(rows().textContent).not.toContain('Fresh gear');
    });

    describe('a record already in storage', () => {
        const restoreWith = async (record) => {
            mocks.store.set(KEY, record);
            await openPanel();
            return rows().textContent;
        };

        test('overwritten before this fix (another character as player 1): not drawn, left in storage', async () => {
            const record = ownRecord({
                characterName: 'NikuDango',
                data: {
                    baseline: BASELINE,
                    results: [row('Stranger gear')],
                    ranFor: { hrid: 'player1', name: 'NikuDango' },
                },
            });
            expect(await restoreWith(record)).not.toContain('Stranger gear');
            expect(mocks.store.get(KEY)).toEqual(record);
        });

        test('a partner run from an older build (player 2) still restores for the owner', async () => {
            const record = ownRecord({
                characterName: 'Partner',
                data: {
                    baseline: BASELINE,
                    results: [row('Partner gear')],
                    ranFor: { hrid: 'player2', name: 'Partner' },
                },
            });
            expect(await restoreWith(record)).toContain('Partner gear');
        });

        test('an older record with no name or ranFor still restores', async () => {
            const record = { data: { baseline: BASELINE, results: [row('Plain gear')] }, savedAt: 1 };
            expect(await restoreWith(record)).toContain('Plain gear');
        });

        test('a same-named other character cannot be told apart: the record is shown', async () => {
            expect(await restoreWith(ownRecord())).toContain('Owner gear');
        });

        test('a record stamped for another character id is not drawn', async () => {
            expect(await restoreWith(ownRecord({ ownerId: 'char2' }))).not.toContain('Owner gear');
        });
    });

    describe('a run in progress while the roster is swapped', () => {
        test('owner roster, swapped to a stranger meanwhile: not drawn, still saved for the owner', async () => {
            mocks.store.set(KEY, ownRecord());
            await openPanel();
            mocks.onRun = () => {
                // A profile is opened: the editor now holds a stranger
                mocks.editedDTOs = { player1: structuredClone(stranger) };
                mocks.editorSelfHrid = null;
                mocks.editorOptions.onScenarioReplaced();
            };
            await analyze({ selfHrid: 'player1', label: 'Mid-run gear' });
            expect(rows().textContent).not.toContain('Mid-run gear');
            expect(ui._upgradeResultsData).toBeNull();
            expect(mocks.store.get(KEY).data.results[0].candidate.description).toBe('Mid-run gear');
            expect(mocks.store.get(KEY).ownerId).toBe('char1');
        });

        test('stranger roster, swapped back to the owner meanwhile: not drawn, not saved', async () => {
            mocks.store.set(KEY, ownRecord());
            await openPanel();
            mocks.onRun = () => mocks.editorOptions.onScenarioReplaced();
            await analyze({
                dtos: { player1: structuredClone(stranger) },
                names: { player1: 'NikuDango' },
                selfHrid: null,
                label: 'Mid-run gear',
            });
            expect(rows().textContent).not.toContain('Mid-run gear');
            expectOwnerRecord();
        });

        test('a run with no swap still draws', async () => {
            await openPanel();
            await analyze({ selfHrid: 'player1' });
            expect(rows().textContent).toContain('Fresh gear');
        });

        test('a character switch mid-run saves nothing under the arriving character', async () => {
            await openPanel();
            mocks.onRun = () => {
                mocks.characterId = 'char2';
            };
            await analyze({ selfHrid: 'player1' });
            expect(mocks.store.has(KEY)).toBe(false);
            expect(mocks.store.has('combatExport:combatSimUpgradeResults_char2')).toBe(false);
        });
    });

    test('All players rows are stamped by their roster, and a stranger roster is dropped on Reset', async () => {
        await openPanel();
        const results = { baseline: BASELINE, results: [row('Everyone gear')], food: null };
        ui._stampUpgradeResults(results, {
            buildSigs: new Map(),
            upgradeModes: ['equipment'],
            playerDTO: stranger,
            ranFor: { hrid: 'player1', name: 'NikuDango' },
            ownRoster: false,
        });
        ui._renderUpgradeResults(results);
        expect(rows().textContent).toContain('Everyone gear');
        mocks.editorOptions.onRosterReloaded();
        await settle();
        expect(rows().textContent).not.toContain('Everyone gear');
    });
});

/**
 * Review round: the callbacks the real paths fire. Reset to Me and Fetch fire `onRosterReloaded`, never
 * `onScenarioReplaced`; a profile or party load fires the latter.
 */
describe('Upgrade results, review round', () => {
    const KEY = 'combatExport:combatSimUpgradeResults_char1';
    const settle = async () => {
        for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const rows = () => ui.panel.querySelector('#mwi-csim-upgrade-results');
    const me = { hrid: 'player1', equipment: {} };
    const stranger = { hrid: 'player1', equipment: { '/item_locations/body': { itemHrid: '/items/z' } } };
    const ownRecord = () => ({
        data: { baseline: BASELINE, results: [row('Owner gear')], ranFor: { hrid: 'player1', name: 'Me' } },
        savedAt: 5,
        characterName: 'Me',
        ownerId: 'char1',
    });
    const holdSelf = () => {
        mocks.editedDTOs = { player1: structuredClone(me) };
        mocks.editorSelfHrid = 'player1';
        mocks.playerNames = { player1: 'Me' };
    };
    const holdStranger = () => {
        mocks.editedDTOs = { player1: structuredClone(stranger) };
        mocks.editorSelfHrid = null;
        mocks.playerNames = { player1: 'NikuDango' };
    };
    const runWith = async (label) => {
        mocks.upgradeResult = { baseline: BASELINE, results: [row(label)], food: null, context: { gameData: {} } };
        await ui._onUpgradeAnalyze();
        await settle();
    };
    const openPanel = async () => {
        ui.buildPanel();
        await settle();
        for (const job of mocks.bgJobs.splice(0)) await job();
        await settle();
        selectZone();
    };

    beforeEach(async () => {
        mocks.store.clear();
        mocks.characterId = 'char1';
        mocks.characterName = 'Me';
        const { default: config } = await import('../../core/config.js');
        vi.spyOn(config, 'getSetting').mockImplementation((key, fallback = false) =>
            key === 'combatSim_rememberUpgradeResults' ? true : fallback
        );
    });
    afterEach(() => {
        vi.restoreAllMocks();
        ui.destroy();
        mocks.editedDTOs = null;
        mocks.editorSelfHrid = null;
        mocks.playerNames = null;
        mocks.characterName = undefined;
        mocks.onRun = null;
        mocks.upgradeResultFor = null;
        mocks.buildPlayerDTOs = null;
        mocks.upgradeResult = { baseline: null, results: [], food: null };
        mocks.store.clear();
    });

    test('1: a stranger run still going when Reset to Me is pressed is not drawn, and the owner record comes back', async () => {
        mocks.store.set(KEY, ownRecord());
        holdStranger();
        await openPanel();
        mocks.onRun = () => {
            holdSelf();
            mocks.editorOptions.onRosterReloaded();
        };
        await runWith('Mid-run gear');
        expect(rows().textContent).not.toContain('Mid-run gear');
        expect(rows().textContent).toContain('Owner gear');
        expect(mocks.store.get(KEY).data.results[0].candidate.description).toBe('Owner gear');
    });

    test('2: a restore that lands after a profile was opened does not draw the owner record over it', async () => {
        mocks.store.set(KEY, ownRecord());
        ui.buildPanel();
        await settle();
        holdStranger();
        mocks.editorOptions.onScenarioReplaced();
        for (const job of mocks.bgJobs.splice(0)) await job();
        await settle();
        expect(rows().textContent).not.toContain('Owner gear');
    });

    test('2: a sync pull with a profile loaded does not draw the owner record either', async () => {
        mocks.store.set(KEY, ownRecord());
        await openPanel();
        holdStranger();
        mocks.editorOptions.onScenarioReplaced();
        await ui._restoreUpgradeResults({ replace: true });
        expect(rows().textContent).not.toContain('Owner gear');
    });

    test('3: Reset to Me with no analysis made reads the owner record back', async () => {
        mocks.store.set(KEY, ownRecord());
        holdSelf();
        await openPanel();
        expect(rows().textContent).toContain('Owner gear');
        holdStranger();
        mocks.editorOptions.onScenarioReplaced();
        expect(rows().textContent).not.toContain('Owner gear');
        holdSelf();
        mocks.editorOptions.onRosterReloaded();
        await settle();
        expect(rows().textContent).toContain('Owner gear');
    });

    test('4: a record saved after a mid-run swap names the player the run was for', async () => {
        holdSelf();
        await openPanel();
        mocks.onRun = () => {
            holdStranger();
            mocks.editorOptions.onScenarioReplaced();
        };
        await runWith('Mid-run gear');
        const saved = mocks.store.get(KEY);
        expect(saved.characterName).toBe('Me');
        expect(saved.ownerId).toBe('char1');
    });

    test('5: a swap during the editor-not-ready load is seen by the run', async () => {
        mocks.editedDTOs = null;
        await openPanel();
        mocks.buildPlayerDTOs = () => {
            holdStranger();
            mocks.editorOptions.onScenarioReplaced();
            return { players: [structuredClone(me)], playerInfo: [], selfHrid: 'player1', missingMembers: [] };
        };
        await runWith('Late gear');
        expect(rows().textContent).not.toContain('Late gear');
    });

    test('the Player box follows the roster the editor holds, not the one the tab was last shown with', async () => {
        holdStranger();
        await openPanel();
        ui._populateUpgradePlayerSelector();
        const names = () => [...ui.panel.querySelectorAll('#mwi-csim-upgrade-player option')].map((o) => o.textContent);
        expect(names()).toEqual(['NikuDango']);
        holdSelf();
        mocks.editorOptions.onRender();
        expect(names()).toEqual(['Me']);
    });

    describe('All players', () => {
        const roster = () => ({
            player1: { hrid: 'player1', equipment: {} },
            player2: { hrid: 'player2', equipment: {} },
        });
        const chooseAll = () => {
            ui._populateUpgradePlayerSelector();
            const select = ui.panel.querySelector('#mwi-csim-upgrade-player');
            select.value = 'all';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const perPlayer = ({ playerDTOs, playerIndex }) => ({
            baseline: BASELINE,
            results: [row(`${playerDTOs[playerIndex].hrid} gear`)],
            candidateCount: 1,
            food: null,
            context: { playerHrid: playerDTOs[playerIndex].hrid, playerIndex, playerDTOs },
        });
        const prepare = async (selfHrid) => {
            await openPanel();
            mocks.editedDTOs = roster();
            mocks.editorSelfHrid = selfHrid;
            mocks.playerNames = { player1: 'Ann', player2: 'Bob' };
            mocks.upgradeResultFor = perPlayer;
            chooseAll();
        };

        test("6: the owner's All players run is not drawn over a profile loaded meanwhile", async () => {
            await prepare('player1');
            mocks.onRun = () => mocks.editorOptions.onScenarioReplaced();
            await ui._onUpgradeAnalyze();
            await settle();
            expect(rows().textContent).not.toContain('player1 gear');
            expect(ui._allPlayersRun).toBeNull();
        });

        test("6: a stranger's All players run is not drawn after Reset to Me meanwhile", async () => {
            await prepare(null);
            mocks.onRun = () => {
                mocks.editorSelfHrid = 'player1';
                mocks.editorOptions.onRosterReloaded();
            };
            await ui._onUpgradeAnalyze();
            await settle();
            expect(rows().textContent).not.toContain('player1 gear');
            expect(ui._allPlayersRun).toBeNull();
        });

        test('an All players run with no swap still draws, and a load keeps the Player box choice', async () => {
            await prepare('player1');
            await ui._onUpgradeAnalyze();
            await settle();
            expect(rows().textContent).toContain('player1 gear');
            ui._upgradeAllChosenFlag = true;
            mocks.editorOptions.onScenarioReplaced();
            expect(ui._upgradeAllChosenFlag).toBe(true);
        });
    });
});
