#!/usr/bin/env node
/**
 * Production-vs-dev value parity check.
 *
 * check-bundle-smoke proves the split bundles are wired together; this proves they COMPUTE the same
 * numbers. The two are different failure classes: PR #671 put a Task Crystal price in the utils
 * bundle that read a market singleton through a bundler-inlined, never-initialized private copy, so
 * every library loaded, every namespace was published and every bridge identity held — and the
 * crystal still priced as null on the release, while unit tests (one module graph, one singleton)
 * and the dev build (one bundle, one singleton) stayed green. Only running the SAME inputs through
 * the production libraries and the dev bundle, and comparing the answers, sees that.
 *
 * What it does, with no game, no registry start-up and no network:
 * 1. loads the seven production libraries (the smoke test's loader) into one fresh happy-dom window
 *    and the single dev bundle into another;
 * 2. feeds each the same small game-shaped world through the PUBLISHED singletons (init client data on
 *    `Toolasha.Core.dataManager`, a price snapshot on `Toolasha.Core.marketAPI`) and initializes the
 *    expected-value calculator the way the entrypoint does;
 * 3. computes golden values through the published namespaces, the same entry points the features call;
 * 4. fails if production and dev disagree on any of them, or if a value reached through the utils
 *    bundle disagrees with the same value from its owner module within one build.
 *
 * Run after both builds: `node scripts/check-bundle-parity.mjs`. Outside gates it skips with exit 0
 * when a bundle is not built; `--require-build` (gates and CI) makes that a failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { libraryLoadOrder, loadBundles } from './check-bundle-smoke.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const COIN = '/items/coin';
const TASK_TOKEN = '/items/task_token';
const CRYSTAL = '/items/task_crystal';
const GEM = '/items/parity_gem';
const JUNK = '/items/parity_junk';
const INNER_CRATE = '/items/parity_inner_crate';
const OUTER_CHEST = '/items/parity_outer_chest';
const CACHE = '/items/parity_task_cache';
const BADGE = '/items/parity_task_badge';

/**
 * The game-shaped fixture world: what `init_client_data` carries for these items, and a price snapshot
 * in `marketplace.json`'s shape (`{ hrid: { level: { a: ask, b: bid } } }`).
 * @returns {{initClientData: Object, marketData: Object}} The world
 */
export function fixtureWorld() {
    const initClientData = {
        itemDetailMap: {
            [COIN]: { hrid: COIN, name: 'Coin', isTradable: true, sellPrice: 1 },
            [TASK_TOKEN]: { hrid: TASK_TOKEN, name: 'Task Token', isTradable: false, sellPrice: 1 },
            [CRYSTAL]: { hrid: CRYSTAL, name: 'Task Crystal', isTradable: false, sellPrice: 1 },
            [GEM]: { hrid: GEM, name: 'Parity Gem', isTradable: true, sellPrice: 100 },
            [JUNK]: { hrid: JUNK, name: 'Parity Junk', isTradable: true, sellPrice: 5 },
            // A crate that opens into a gem and coins, and a chest that holds that crate among its drops
            [INNER_CRATE]: { hrid: INNER_CRATE, name: 'Parity Inner Crate', isOpenable: true, isTradable: true },
            [OUTER_CHEST]: { hrid: OUTER_CHEST, name: 'Parity Outer Chest', isOpenable: true, isTradable: true },
            [CACHE]: { hrid: CACHE, name: 'Parity Task Cache', isOpenable: true, isTradable: false },
            // One crystal and coin per attempt; the crystal is untradable, so only the Task Shop can price it
            [BADGE]: {
                hrid: BADGE,
                name: 'Parity Task Badge',
                itemLevel: 50,
                isTradable: true,
                enhancementCosts: [
                    { itemHrid: CRYSTAL, count: 2 },
                    { itemHrid: COIN, count: 1000 },
                ],
            },
        },
        openableLootDropMap: {
            [INNER_CRATE]: [
                { itemHrid: GEM, dropRate: 0.25, minCount: 1, maxCount: 3 },
                { itemHrid: COIN, dropRate: 1, minCount: 200, maxCount: 400 },
            ],
            [OUTER_CHEST]: [
                { itemHrid: GEM, dropRate: 0.5, minCount: 1, maxCount: 1 },
                { itemHrid: JUNK, dropRate: 1, minCount: 2, maxCount: 4 },
                { itemHrid: INNER_CRATE, dropRate: 0.5, minCount: 1, maxCount: 2 },
                { itemHrid: COIN, dropRate: 1, minCount: 100, maxCount: 100 },
            ],
            [CACHE]: [
                { itemHrid: GEM, dropRate: 1, minCount: 3, maxCount: 3 },
                { itemHrid: INNER_CRATE, dropRate: 0.2, minCount: 1, maxCount: 1 },
            ],
        },
        // The shape the game sends: a single `cost` (a `costs` array is handled by the same reader)
        taskShopItemDetailMap: {
            '/shop_items/parity_task_cache': { itemHrid: CACHE, cost: { itemHrid: TASK_TOKEN, count: 40 } },
            '/shop_items/task_crystal': { itemHrid: CRYSTAL, cost: { itemHrid: TASK_TOKEN, count: 50 } },
        },
        actionDetailMap: {},
        shopItemDetailMap: {},
    };
    const quote = (ask, bid) => ({ 0: { a: ask, b: bid } });
    const marketData = {
        [GEM]: quote(20000, 18000),
        [JUNK]: quote(400, 300),
        [INNER_CRATE]: quote(60000, 52000),
        [OUTER_CHEST]: quote(90000, 80000),
        [BADGE]: quote(5000000, 4800000),
    };
    return { initClientData, marketData };
}

/**
 * Hand the fixture world to a loaded build through its published singletons, the way the live game
 * does: the data manager holds the init client data, the market API holds the snapshot.
 * @param {Object} root - `window.Toolasha`
 * @param {{initClientData: Object, marketData: Object}} world - From fixtureWorld
 * @returns {void}
 */
export function installWorld(root, world) {
    const { dataManager, marketAPI } = root.Core;
    dataManager.initClientData = world.initClientData;
    marketAPI.marketData = world.marketData;
    marketAPI.lastFetchTimestamp = Date.parse('2026-10-31T00:00:00Z');
}

/**
 * Compute the golden values through one build's published namespaces. Every entry names the path it
 * took, so a disagreement says which module read a stale singleton.
 * @param {Object} root - `window.Toolasha`
 * @returns {Promise<Object<string, *>>} Name → value (numbers, null for "unpriced", or 'THREW: …')
 */
export async function computeGolden(root) {
    const out = {};
    const record = (name, fn) => {
        try {
            const value = fn();
            out[name] = value === undefined ? null : value;
        } catch (error) {
            out[name] = `THREW: ${error?.message || error}`;
        }
    };

    // The entrypoint initializes the owner exactly once, with the data and prices already held
    const owner = root.Market.expectedValueCalculator;
    await owner.initialize();
    record('owner.initialized', () => owner.isInitialized);

    // 1. Container EV, from the owner (the market bundle's calculator)
    record('owner.ev.innerCrate', () => owner.calculateExpectedValue(INNER_CRATE)?.expectedValue);
    record('owner.ev.outerChest(nested)', () => owner.calculateExpectedValue(OUTER_CHEST)?.expectedValue);
    record('owner.ev.taskCache', () => owner.calculateExpectedValue(CACHE)?.expectedValue);

    // 2. The same containers reached through the utils bundle: a bonus-drop table pricing an openable
    const bonusFor = (itemHrid) => {
        const itemDetailMap = root.Core.dataManager.getInitClientData().itemDetailMap;
        const result = root.Utils.bonusRevenueCalculator.calculateBonusRevenue(
            {
                type: '/action_types/foraging',
                essenceDropTable: [{ itemHrid, dropRate: 1, minCount: 1, maxCount: 1 }],
                rareDropTable: [],
            },
            1,
            new Map(),
            itemDetailMap
        );
        return result.bonusDrops?.[0]?.priceEach ?? null;
    };
    record('utils.bonusRevenue.innerCrate', () => bonusFor(INNER_CRATE));
    record('utils.bonusRevenue.outerChest(nested)', () => bonusFor(OUTER_CHEST));

    // 3. The Task Shop: the best coins-per-token line, and the Task Crystal priced through it
    record('utils.taskShop.bestPerToken', () => root.Utils.taskShopValue.findBestTaskShopValue()?.perToken);
    record('utils.taskShop.crystalToken', () => root.Utils.taskShopValue.taskShopTokenPrice(CRYSTAL)?.price);
    record('utils.priceMaterial.crystal', () => root.Utils.enhancementInputPricing.priceMaterial(CRYSTAL)?.price);
    record('utils.priceMaterial.crystal.tokenValued', () =>
        Boolean(root.Utils.enhancementInputPricing.priceMaterial(CRYSTAL)?.tokenValued)
    );

    // 4. An enhancement path's per-attempt bill (crystal x2 + coin), both rules
    const badge = root.Core.dataManager.getInitClientData().itemDetailMap[BADGE];
    record('utils.enhancementInput.perAttempt', () => {
        const cost = root.Utils.enhancementInputPricing.perAttemptMaterialCost(badge);
        return cost.hasMissingPrices ? null : cost.cost;
    });

    return out;
}

/**
 * Disagreements between one build's utils-bundle reads and the same value from the owner module.
 * @param {Object<string, *>} golden - From computeGolden
 * @returns {string[]} Failures
 */
export function withinBuildFailures(golden) {
    const failures = [];
    const same = (utilsKey, ownerKey, what) => {
        if (golden[utilsKey] !== golden[ownerKey]) {
            failures.push(
                `${what}: ${utilsKey} = ${golden[utilsKey]}, but the owner says ${ownerKey} = ${golden[ownerKey]}`
            );
        }
    };
    same(
        'utils.bonusRevenue.innerCrate',
        'owner.ev.innerCrate',
        'a bonus-drop container priced through the utils bundle'
    );
    same(
        'utils.bonusRevenue.outerChest(nested)',
        'owner.ev.outerChest(nested)',
        'a nested bonus-drop container priced through the utils bundle'
    );
    if (typeof golden['utils.priceMaterial.crystal'] !== 'number' || !(golden['utils.priceMaterial.crystal'] > 0)) {
        failures.push(`the Task Crystal priced as ${golden['utils.priceMaterial.crystal']} instead of its token value`);
    }
    same('utils.priceMaterial.crystal', 'utils.taskShop.crystalToken', 'the Task Crystal price');
    const perToken = golden['utils.taskShop.bestPerToken'];
    const cacheEv = golden['owner.ev.taskCache'];
    if (typeof perToken === 'number' && typeof cacheEv === 'number' && Math.abs(perToken - cacheEv / 40) > 1e-9) {
        failures.push(`the best token value ${perToken} is not the cache's owner EV / 40 (${cacheEv / 40})`);
    }
    return failures;
}

/**
 * Every golden value that differs between two builds.
 * @param {Object<string, *>} prod - Production libraries
 * @param {Object<string, *>} dev - Dev standalone bundle
 * @returns {string[]} Failures
 */
export function crossBuildFailures(prod, dev) {
    const failures = [];
    for (const key of new Set([...Object.keys(prod), ...Object.keys(dev)])) {
        if (JSON.stringify(prod[key]) !== JSON.stringify(dev[key])) {
            failures.push(`${key}: production = ${JSON.stringify(prod[key])}, dev = ${JSON.stringify(dev[key])}`);
        }
    }
    return failures;
}

async function main() {
    const requireBuild = process.argv.includes('--require-build');
    const order = libraryLoadOrder(readFileSync(join(projectRoot, 'library-headers/entrypoint.txt'), 'utf8'));
    const libraryPath = (name) => join(projectRoot, `dist/libraries/toolasha-${name}.js`);
    const devPath = join(projectRoot, 'dist/Toolasha-dev.user.js');
    const missing = [
        ...order.filter((name) => !existsSync(libraryPath(name))).map((name) => `dist/libraries/toolasha-${name}.js`),
        ...(existsSync(devPath) ? [] : ['dist/Toolasha-dev.user.js']),
    ];
    if (missing.length > 0) {
        const message = `not built (missing ${missing.join(', ')})`;
        if (requireBuild) {
            console.error(`[check-bundle-parity] FAILED: ${message} — run both builds first.`);
            process.exit(1);
        }
        console.log(
            `[check-bundle-parity] SKIPPED: ${message}. Run \`npm run build:dev\` and \`npm run build\` first.`
        );
        return;
    }

    const require = createRequire(join(projectRoot, 'package.json'));
    const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href);
    const started = Date.now();

    const failures = [];
    const goldens = {};
    const builds = [
        ['production', order, (name) => readFileSync(libraryPath(name), 'utf8')],
        ['dev', ['dev'], () => readFileSync(devPath, 'utf8')],
    ];
    for (const [label, names, read] of builds) {
        const { window, errors } = loadBundles(names, read, { Window, setup: stubStartupSurface });
        // The dev bundle also runs the entrypoint, which hooks the game socket at load time; that is
        // start-up, not what is compared. Anything thrown BEFORE the namespaces exist is a real failure.
        const fatal = errors.filter((e) => !window.Toolasha?.Market?.expectedValueCalculator);
        if (fatal.length > 0 || !window.Toolasha?.Market?.expectedValueCalculator) {
            failures.push(`${label}: could not load — ${errors.map((e) => `${e.library}: ${e.error}`).join('; ')}`);
            await window.happyDOM.close();
            continue;
        }
        installWorld(window.Toolasha, fixtureWorld());
        goldens[label] = await computeGolden(window.Toolasha);
        for (const failure of withinBuildFailures(goldens[label])) failures.push(`${label}: ${failure}`);
        await window.happyDOM.close();
    }
    if (goldens.production && goldens.dev) failures.push(...crossBuildFailures(goldens.production, goldens.dev));

    if (failures.length > 0) {
        console.error('');
        console.error('[check-bundle-parity] FAILED: the production libraries and the dev bundle disagree.');
        for (const failure of failures) console.error(`  - ${failure}`);
        console.error('');
        console.error('The dev build is one bundle, so a module that inlines its own copy of a singleton another');
        console.error('bundle owns only goes wrong in the split build. Read the owner at call time through');
        console.error('src/utils/bundle-bridge.js instead of importing it.');
        console.error('');
        process.exit(1);
    }
    if (process.argv.includes('--show')) console.log(JSON.stringify(goldens.production, null, 2));
    const count = Object.keys(goldens.production).length;
    console.log(
        `[check-bundle-parity] OK: ${count} golden values identical in production and dev (${Date.now() - started} ms).`
    );
}

/**
 * The page surface the dev bundle's entrypoint touches at load, which happy-dom lacks: the socket hook
 * reads the `data` accessor of MessageEvent. Stubbed so start-up proceeds quietly; nothing is sent.
 * @param {Object} window - happy-dom window
 * @returns {void}
 */
export function stubStartupSurface(window) {
    const proto = window.MessageEvent?.prototype;
    if (proto && !Object.getOwnPropertyDescriptor(proto, 'data')) {
        Object.defineProperty(proto, 'data', { configurable: true, get: () => null });
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
