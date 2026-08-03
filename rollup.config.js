import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { rollup } from 'rollup';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, normalize } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the userscript headers
const userscriptHeader = readFileSync(join(__dirname, 'userscript-header.txt'), 'utf-8');
const libraryHeaderCore = readFileSync(join(__dirname, 'library-headers/core.txt'), 'utf-8');
const libraryHeaderUtils = readFileSync(join(__dirname, 'library-headers/utils.txt'), 'utf-8');
const libraryHeaderMarket = readFileSync(join(__dirname, 'library-headers/market.txt'), 'utf-8');
const libraryHeaderActions = readFileSync(join(__dirname, 'library-headers/actions.txt'), 'utf-8');
const libraryHeaderSim = readFileSync(join(__dirname, 'library-headers/sim.txt'), 'utf-8');
const libraryHeaderCombat = readFileSync(join(__dirname, 'library-headers/combat.txt'), 'utf-8');
const libraryHeaderUI = readFileSync(join(__dirname, 'library-headers/ui.txt'), 'utf-8');
const entrypointHeader = readFileSync(join(__dirname, 'library-headers/entrypoint.txt'), 'utf-8');

const normalizeModuleId = (id) => (id ? normalize(id.split('?')[0]) : id);

const coreExternalGlobals = new Map([
    [normalize(join(__dirname, 'src/core/storage.js')), 'Toolasha.Core.storage'],
    [normalize(join(__dirname, 'src/core/config.js')), 'Toolasha.Core.config'],
    [normalize(join(__dirname, 'src/core/websocket.js')), 'Toolasha.Core.webSocketHook'],
    [normalize(join(__dirname, 'src/core/dom-observer.js')), 'Toolasha.Core.domObserver'],
    [normalize(join(__dirname, 'src/core/data-manager.js')), 'Toolasha.Core.dataManager'],
    [normalize(join(__dirname, 'src/core/feature-registry.js')), 'Toolasha.Core.featureRegistry'],
    [normalize(join(__dirname, 'src/core/settings-storage.js')), 'Toolasha.Core.settingsStorage'],
    [normalize(join(__dirname, 'src/core/settings-schema.js')), 'Toolasha.Core'],
    [normalize(join(__dirname, 'src/core/profile-manager.js')), 'Toolasha.Core.profileManager'],
    [normalize(join(__dirname, 'src/api/marketplace.js')), 'Toolasha.Core.marketAPI'],
]);

const utilsExternalGlobals = new Map([
    [normalize(join(__dirname, 'src/utils/formatters.js')), 'Toolasha.Utils.formatters'],
    [normalize(join(__dirname, 'src/utils/efficiency.js')), 'Toolasha.Utils.efficiency'],
    [normalize(join(__dirname, 'src/utils/profit-helpers.js')), 'Toolasha.Utils.profitHelpers'],
    [normalize(join(__dirname, 'src/utils/profit-constants.js')), 'Toolasha.Utils.profitConstants'],
    [normalize(join(__dirname, 'src/utils/dom.js')), 'Toolasha.Utils.dom'],
    [normalize(join(__dirname, 'src/utils/dom-observer-helpers.js')), 'Toolasha.Utils.domObserverHelpers'],
    [normalize(join(__dirname, 'src/utils/timer-registry.js')), 'Toolasha.Utils.timerRegistry'],
    [normalize(join(__dirname, 'src/utils/bonus-revenue-calculator.js')), 'Toolasha.Utils.bonusRevenueCalculator'],
    [normalize(join(__dirname, 'src/utils/enhancement-multipliers.js')), 'Toolasha.Utils.enhancementMultipliers'],
    [normalize(join(__dirname, 'src/utils/experience-parser.js')), 'Toolasha.Utils.experienceParser'],
    [normalize(join(__dirname, 'src/utils/market-listings.js')), 'Toolasha.Utils.marketListings'],
    [normalize(join(__dirname, 'src/utils/action-calculator.js')), 'Toolasha.Utils.actionCalculator'],
    [normalize(join(__dirname, 'src/utils/action-panel-helper.js')), 'Toolasha.Utils.actionPanelHelper'],
    [normalize(join(__dirname, 'src/utils/tea-parser.js')), 'Toolasha.Utils.teaParser'],
    [normalize(join(__dirname, 'src/utils/buff-parser.js')), 'Toolasha.Utils.buffParser'],
    [normalize(join(__dirname, 'src/utils/selectors.js')), 'Toolasha.Utils.selectors'],
    [normalize(join(__dirname, 'src/utils/house-efficiency.js')), 'Toolasha.Utils.houseEfficiency'],
    [normalize(join(__dirname, 'src/utils/experience-calculator.js')), 'Toolasha.Utils.experienceCalculator'],
    [normalize(join(__dirname, 'src/utils/market-data.js')), 'Toolasha.Utils.marketData'],
    [normalize(join(__dirname, 'src/utils/ability-cost-calculator.js')), 'Toolasha.Utils.abilityCalc'],
    [normalize(join(__dirname, 'src/utils/equipment-parser.js')), 'Toolasha.Utils.equipmentParser'],
    [normalize(join(__dirname, 'src/utils/ui-components.js')), 'Toolasha.Utils.uiComponents'],
    [normalize(join(__dirname, 'src/utils/enhancement-config.js')), 'Toolasha.Utils.enhancementConfig'],
    [normalize(join(__dirname, 'src/utils/enhancement-gear-detector.js')), 'Toolasha.Utils.enhancementGearDetector'],
    [normalize(join(__dirname, 'src/utils/react-input.js')), 'Toolasha.Utils.reactInput'],
    [normalize(join(__dirname, 'src/utils/material-calculator.js')), 'Toolasha.Utils.materialCalculator'],
    [normalize(join(__dirname, 'src/utils/token-valuation.js')), 'Toolasha.Utils.tokenValuation'],
    [normalize(join(__dirname, 'src/utils/pricing-helper.js')), 'Toolasha.Utils.pricingHelper'],
    [normalize(join(__dirname, 'src/utils/cleanup-registry.js')), 'Toolasha.Utils.cleanupRegistry'],
    [normalize(join(__dirname, 'src/utils/house-cost-calculator.js')), 'Toolasha.Utils.houseCostCalculator'],
    [normalize(join(__dirname, 'src/utils/enhancement-calculator.js')), 'Toolasha.Utils.enhancementCalculator'],
    // Shared or the overlay's row list is duplicated per bundle and the panel renders nothing
    // Every src/utils module used by more than one bundle is declared here.
    // Anything omitted is silently copied into each bundle that imports it,
    // which is how the combat bundle grew to within 3 KB of its 2 MB ceiling.
    [normalize(join(__dirname, 'src/utils/drop-luck.js')), 'Toolasha.Utils.dropLuck'],
    [normalize(join(__dirname, 'src/utils/complex-fft.js')), 'Toolasha.Utils.complexFft'],
    [normalize(join(__dirname, 'src/utils/combat-drop-model.js')), 'Toolasha.Utils.combatDropModel'],
    [normalize(join(__dirname, 'src/utils/spawn-expectation.js')), 'Toolasha.Utils.spawnExpectation'],
    [normalize(join(__dirname, 'src/utils/chest-tally.js')), 'Toolasha.Utils.chestTally'],
    [normalize(join(__dirname, 'src/utils/floating-panel.js')), 'Toolasha.Utils.floatingPanel'],
    [normalize(join(__dirname, 'src/utils/worker-pool.js')), 'Toolasha.Utils.workerPool'],
    [normalize(join(__dirname, 'src/utils/ev-worker-manager.js')), 'Toolasha.Utils.evWorkerManager'],
    [normalize(join(__dirname, 'src/utils/enhancement-worker-manager.js')), 'Toolasha.Utils.enhancementWorkerManager'],
    [normalize(join(__dirname, 'src/utils/networth-worker-manager.js')), 'Toolasha.Utils.networthWorkerManager'],
    [normalize(join(__dirname, 'src/utils/panel-z-index.js')), 'Toolasha.Utils.panelZIndex'],
    [normalize(join(__dirname, 'src/utils/performance-monitor.js')), 'Toolasha.Utils.performanceMonitor'],
    [normalize(join(__dirname, 'src/utils/game-lookups.js')), 'Toolasha.Utils.gameLookups'],
    [normalize(join(__dirname, 'src/utils/item-navigation.js')), 'Toolasha.Utils.itemNavigation'],
    [normalize(join(__dirname, 'src/utils/marketplace-tabs.js')), 'Toolasha.Utils.marketplaceTabs'],
    [normalize(join(__dirname, 'src/utils/marketplace-autofill.js')), 'Toolasha.Utils.marketplaceAutofill'],
    [normalize(join(__dirname, 'src/utils/scroll-buff-values.js')), 'Toolasha.Utils.scrollBuffValues'],
    [normalize(join(__dirname, 'src/utils/overlay-rows.js')), 'Toolasha.Utils.overlayRows'],
    [normalize(join(__dirname, 'src/utils/overlay-layout.js')), 'Toolasha.Utils.overlayLayout'],
    [normalize(join(__dirname, 'src/utils/overlay-format.js')), 'Toolasha.Utils.overlayFormat'],
    [normalize(join(__dirname, 'src/utils/order-book.js')), 'Toolasha.Utils.orderBook'],
    [normalize(join(__dirname, 'src/utils/combat-level.js')), 'Toolasha.Utils.combatLevel'],
    [normalize(join(__dirname, 'src/utils/opanel-config.js')), 'Toolasha.Utils.opanelConfig'],
    [normalize(join(__dirname, 'src/utils/skill-progress.js')), 'Toolasha.Utils.skillProgress'],
    // A factory rather than a singleton, so sharing it changes nothing about the
    // measurements — each caller still gets its own history. It is here because
    // two bundles want it and a second copy is only weight.
    [normalize(join(__dirname, 'src/utils/skill-history.js')), 'Toolasha.Utils.skillHistory'],
    [normalize(join(__dirname, 'src/utils/experience-parser.js')), 'Toolasha.Utils.experienceParser'],
    [normalize(join(__dirname, 'src/utils/ability-books.js')), 'Toolasha.Utils.abilityBooks'],
    [normalize(join(__dirname, 'src/utils/damage-attribution.js')), 'Toolasha.Utils.damageAttribution'],
    // Shared above all for its cache: a private copy per bundle means the overlay
    // and the Treasure panel each hold a stale map of every panel's geometry, and
    // whichever saves last wipes the other's entry
    [normalize(join(__dirname, 'src/utils/panel-geometry.js')), 'Toolasha.Utils.panelGeometry'],
    [normalize(join(__dirname, 'src/utils/choice-dialog.js')), 'Toolasha.Utils.choiceDialog'],
    [normalize(join(__dirname, 'src/utils/simple-panel.js')), 'Toolasha.Utils.simplePanel'],
    // Holds the chosen target in memory, and the panel that sets it is in a
    // different bundle from the tile that colours against it. Two copies means
    // the tile never hears about a change and quietly keeps its own answer.
    [normalize(join(__dirname, 'src/utils/consumable-target.js')), 'Toolasha.Utils.consumableTarget'],
]);

// The combat simulator engine, which is its own bundle.
// About a megabyte of source reached into by four features across three bundles;
// left inline it was copied into each of them, and both the combat and the UI
// bundle carried the same `Monster` class while sitting a few kilobytes under
// the 2 MB ceiling.
const simExternalGlobals = new Map([
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim.js')), 'Toolasha.Sim.combatSim'],
    [normalize(join(__dirname, 'src/features/combat-sim/lab-sim.js')), 'Toolasha.Sim.labSim'],
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim-ui.js')), 'Toolasha.Sim.combatSimUI'],
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim-adapter.js')), 'Toolasha.Sim.combatSimAdapter'],
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim-runner.js')), 'Toolasha.Sim.combatSimRunner'],
    [normalize(join(__dirname, 'src/features/combat-sim/engine/wilson.js')), 'Toolasha.Sim.wilson'],
    [normalize(join(__dirname, 'src/features/combat-sim/engine/game-data.js')), 'Toolasha.Sim.gameData'],
    [normalize(join(__dirname, 'src/features/combat-sim/engine/monster.js')), 'Toolasha.Sim.monster'],
]);

// Combat feature modules imported cross-library (by ui)
// Must be external so they reference the shared Combat.* globals instead of bundling duplicates
const combatFeatureExternals = new Map([
    // loadout-snapshot is accessed lazily at runtime via window.Toolasha.Combat.loadoutSnapshot
    // The collector is a stateful singleton fed by the websocket: a second copy in
    // another bundle would sit there receiving nothing, so it is shared rather
    // than duplicated. The calculator comes with it because they are read together.
    [
        normalize(join(__dirname, 'src/features/combat-stats/combat-stats-data-collector.js')),
        'Toolasha.Combat.combatStatsDataCollector',
    ],
    [
        normalize(join(__dirname, 'src/features/combat-stats/combat-stats-calculator.js')),
        'Toolasha.Combat.combatStatsCalculator',
    ],
    // Both are stateful singletons fed by the websocket, so a second copy in
    // another bundle would sit there receiving nothing and report zeroes
    [normalize(join(__dirname, 'src/features/combat/combat-dps.js')), 'Toolasha.Combat.combatDPS'],
    [normalize(join(__dirname, 'src/features/combat/combat-drop-luck.js')), 'Toolasha.Combat.combatDropLuck'],
    [normalize(join(__dirname, 'src/features/combat/damage-tracker.js')), 'Toolasha.Combat.damageTracker'],
    [normalize(join(__dirname, 'src/features/combat/damage-taken-tracker.js')), 'Toolasha.Combat.damageTakenTracker'],
]);

// Market modules imported cross-library (by combat, actions, ui)
// Must be external so they reference the shared Market.* globals instead of bundling duplicates
const marketExternalGlobals = new Map([
    [
        normalize(join(__dirname, 'src/features/market/expected-value-calculator.js')),
        'Toolasha.Market.expectedValueCalculator',
    ],
    [normalize(join(__dirname, 'src/features/market/profit-calculator.js')), 'Toolasha.Market.profitCalculator'],
    [
        normalize(join(__dirname, 'src/features/market/alchemy-profit-calculator.js')),
        'Toolasha.Market.alchemyProfitCalculator',
    ],
]);

const buildGlobals = (globalsMap) => Object.fromEntries(globalsMap.entries());
const buildExternal = (globalsMap) => (id) => globalsMap.has(normalizeModuleId(id));

// Custom plugin to import CSS as raw strings
function cssRawPlugin() {
    const suffix = '?raw';
    return {
        name: 'css-raw',
        resolveId(source, importer) {
            if (source.endsWith(suffix)) {
                // Resolve relative to importer
                if (importer) {
                    const basePath = dirname(importer);
                    const cssPath = join(basePath, source.replace(suffix, ''));
                    return cssPath + suffix; // Keep marker for load phase
                }
            }
            return null;
        },
        load(id) {
            if (id.endsWith(suffix)) {
                const cssPath = id.replace(suffix, '');
                const css = readFileSync(cssPath, 'utf-8');
                return `export default ${JSON.stringify(css)};`;
            }
            return null;
        },
    };
}

/**
 * Custom plugin to bundle JS worker entry points into inline strings.
 * Import with '?worker' suffix: import code from './my-worker.js?worker';
 * The imported value is the bundled worker source as a string.
 */
function workerBundlePlugin() {
    const suffix = '?worker';
    const cache = new Map();
    return {
        name: 'worker-bundle',
        resolveId(source, importer) {
            if (source.endsWith(suffix)) {
                if (importer) {
                    const basePath = dirname(importer);
                    const workerPath = join(basePath, source.replace(suffix, ''));
                    return workerPath + suffix;
                }
            }
            return null;
        },
        async load(id) {
            if (!id.endsWith(suffix)) return null;

            const entryPath = id.replace(suffix, '');

            // Cache to avoid re-bundling on watch rebuilds within same run
            if (cache.has(entryPath)) return cache.get(entryPath);

            // Bundle the worker entry with its own rollup build
            const bundle = await rollup({
                input: entryPath,
                plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs()],
                // Suppress circular dependency warnings from heap-js
                onwarn(warning, warn) {
                    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
                    warn(warning);
                },
            });

            const { output } = await bundle.generate({
                format: 'iife',
                name: 'CombatSimWorker',
            });

            const code = output[0].code;
            const result = `export default ${JSON.stringify(code)};`;
            cache.set(entryPath, result);
            return result;
        },
    };
}

// Check if we should build for production (multi-bundle)
const isProduction = process.env.BUILD_MODE === 'production';
const buildTarget = process.env.BUILD_TARGET || 'dev';
const devOutputFile = buildTarget === 'dev-standalone' ? 'dist/Toolasha-dev.user.js' : 'dist/Toolasha.user.js';

/**
 * When this build was made.
 *
 * The dev script and the published one carry the same @name and the same
 * @version, so Tampermonkey cannot tell them apart and neither can you — a stale
 * install looks exactly like a fresh one that is missing a feature. This stamp
 * is the difference: whatever the console prints is what is actually running.
 */
const buildStamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Development build configuration (single bundle for local testing)
const devConfig = {
    input: 'src/dev-entrypoint.js',
    output: {
        file: devOutputFile,
        format: 'iife',
        name: 'Toolasha',
        banner: userscriptHeader,
        outro: `console.log('[Toolasha] dev build ${buildStamp}');`,
    },
    plugins: [
        cssRawPlugin(),
        workerBundlePlugin(),
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        commonjs(),
    ],
};

// Production build configuration (multi-bundle for Greasyfork)
const prodLibraries = [
    {
        key: 'core',
        input: 'src/libraries/core.js',
        output: {
            file: 'dist/libraries/toolasha-core.js',
            format: 'iife',
            name: 'ToolashaCore',
            banner: libraryHeaderCore,
        },
    },
    {
        key: 'utils',
        input: 'src/libraries/utils.js',
        output: {
            file: 'dist/libraries/toolasha-utils.js',
            format: 'iife',
            name: 'ToolashaUtils',
            banner: libraryHeaderUtils,
        },
    },
    {
        key: 'market',
        input: 'src/libraries/market.js',
        output: {
            file: 'dist/libraries/toolasha-market.js',
            format: 'iife',
            name: 'ToolashaMarket',
            banner: libraryHeaderMarket,
        },
    },
    {
        key: 'actions',
        input: 'src/libraries/actions.js',
        output: {
            file: 'dist/libraries/toolasha-actions.js',
            format: 'iife',
            name: 'ToolashaActions',
            banner: libraryHeaderActions,
        },
    },
    {
        key: 'sim',
        input: 'src/libraries/sim.js',
        output: {
            file: 'dist/libraries/toolasha-sim.js',
            format: 'iife',
            name: 'ToolashaSim',
            banner: libraryHeaderSim,
        },
    },
    {
        key: 'combat',
        input: 'src/libraries/combat.js',
        output: {
            file: 'dist/libraries/toolasha-combat.js',
            format: 'iife',
            name: 'ToolashaCombat',
            banner: libraryHeaderCombat,
        },
    },
    {
        key: 'ui',
        input: 'src/libraries/ui.js',
        output: {
            file: 'dist/libraries/toolasha-ui.js',
            format: 'iife',
            name: 'ToolashaUI',
            banner: libraryHeaderUI,
        },
    },
];

const prodEntrypoint = {
    input: 'src/entrypoint.js',
    output: {
        file: 'dist/Toolasha.user.js',
        format: 'iife',
        name: 'ToolashaEntrypoint',
        banner: entrypointHeader,
    },
    // Entrypoint doesn't need any plugins - it just uses window.Toolasha
    plugins: [],
};

const sharedCoreGlobals = buildGlobals(coreExternalGlobals);
const sharedFeatureGlobals = buildGlobals(new Map([...coreExternalGlobals, ...utilsExternalGlobals]));

const prodConfig = [
    ...prodLibraries.map((lib) => {
        const { key, ...libraryConfig } = lib;
        let external = null;
        let globals = null;

        if (key === 'utils') {
            external = buildExternal(coreExternalGlobals);
            globals = sharedCoreGlobals;
        } else if (key === 'sim') {
            // The engine is self-contained apart from core and utils; it must
            // NOT treat itself as external or the bundle would be empty
            external = buildExternal(new Map([...coreExternalGlobals, ...utilsExternalGlobals]));
            globals = sharedFeatureGlobals;
        } else if (key === 'market') {
            external = buildExternal(new Map([...coreExternalGlobals, ...utilsExternalGlobals, ...simExternalGlobals]));
            globals = buildGlobals(new Map([...coreExternalGlobals, ...utilsExternalGlobals, ...simExternalGlobals]));
        } else if (key !== 'core') {
            // actions, combat, ui — need core + utils + sim + market externals
            const allExternals = new Map([
                ...coreExternalGlobals,
                ...utilsExternalGlobals,
                ...simExternalGlobals,
                ...marketExternalGlobals,
            ]);
            // ui and actions also treat combat feature singletons as externals to avoid duplicate instances
            if (key === 'ui' || key === 'actions') {
                for (const [k, v] of combatFeatureExternals) allExternals.set(k, v);
            }
            external = buildExternal(allExternals);
            globals = buildGlobals(allExternals);
        }

        return {
            ...libraryConfig,
            external: external || undefined,
            output: {
                ...libraryConfig.output,
                ...(globals ? { globals } : {}),
            },
            plugins: [
                cssRawPlugin(),
                workerBundlePlugin(),
                resolve({
                    browser: true,
                    preferBuiltins: false,
                }),
                commonjs(),
            ],
        };
    }),
    prodEntrypoint,
];

export default isProduction ? prodConfig : devConfig;
