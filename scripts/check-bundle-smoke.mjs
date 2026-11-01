#!/usr/bin/env node
/**
 * Split-bundle smoke test.
 *
 * The production script is seven library bundles (dist/libraries/toolasha-*.js) loaded in a fixed
 * order, wired together only through `window.Toolasha.*`. The dev build is ONE bundle, so tests and
 * the dev loader never exercise that wiring — and a wiring bug ships silently: PR #671 moved code
 * into the utils bundle that imported the market bundle's expected-value calculator, the utils
 * bundle inlined its own never-initialized copy, and the function returned null for every player
 * on the release while every test and the dev build passed.
 *
 * This loads the real built bundles, in @require order, into one window context with just enough
 * GM_ and unsafeWindow stubs for them to register (no game, no feature registry, no initialize()), and
 * checks the cross-bundle wiring:
 * - every library loads without throwing and publishes its `Toolasha.<Library>` namespace;
 * - every singleton a later bundle reads through bundle-bridge is the OWNER's live module;
 * - a utils function that reaches a market singleton through the bridge sees the exact instance the
 *   market bundle published (not a private copy).
 *
 * Run after the production build: `node scripts/check-bundle-smoke.mjs`. Outside gates it skips with
 * exit 0 when dist/libraries is not built; `--require-build` (gates and CI) makes that a failure.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Library names in @require order, from the entrypoint header.
 * @param {string} headerText - Contents of library-headers/entrypoint.txt
 * @returns {string[]} e.g. ['core', 'utils', 'sim', …]
 */
export function libraryLoadOrder(headerText) {
    const order = [];
    for (const match of headerText.matchAll(/@require\s+\S*\/toolasha-([a-z]+)\.js/g)) order.push(match[1]);
    return order;
}

/**
 * Names `bundle-bridge.js` reads off a `Toolasha.<Library>` namespace, by exported accessor.
 * @param {string} bridgeSource - Source of src/utils/bundle-bridge.js
 * @returns {Array<{accessor: string, library: string, key: string}>} e.g. expectedValueCalculator → Market.expectedValueCalculator
 */
export function bridgeReads(bridgeSource) {
    const reads = [];
    const accessorPattern =
        /export function (\w+)\(\)\s*\{\s*return toolashaRoot\(\)\?\.(\w+)\?\.(\w+)\s*\|\|\s*null;?\s*\}/g;
    for (const match of bridgeSource.matchAll(accessorPattern)) {
        reads.push({ accessor: match[1], library: match[2], key: match[3] });
    }
    return reads;
}

/**
 * Every non-test source file under a directory, as `{path, text}`.
 * @param {string} dir - Absolute directory
 * @returns {Array<{path: string, text: string}>} Sources
 */
export function sourceFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...sourceFiles(path));
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
            files.push({ path, text: readFileSync(path, 'utf8') });
    }
    return files;
}

/**
 * Mark each bridge read with whether anything calls its accessor and whether the owner assigns the
 * key after load (e.g. `Toolasha.Sim.x = …` inside initialize()).
 * @param {Array<{accessor: string, key: string}>} reads - From bridgeReads
 * @param {Array<{path: string, text: string}>} sources - From sourceFiles
 * @returns {Array<Object>} The reads with `used` and `publishedLater`
 */
export function annotateReads(reads, sources) {
    return reads.map((read) => {
        const callPattern = new RegExp(`\\b${read.accessor}\\(`);
        const assignPattern = new RegExp(`Toolasha[\\w?.]*\\.${read.key}\\s*=[^=]`);
        const used = sources.some((s) => !s.path.endsWith('bundle-bridge.js') && callPattern.test(s.text));
        const publishedLater = sources.some((s) => assignPattern.test(s.text));
        return { ...read, used, publishedLater };
    });
}

/**
 * A module published for others to call is a module, not the feature registry's record of it: a
 * record is `{ name, initialize, cleanup, … }` with no domain methods. True when the value has at
 * least one function beyond the feature-interface keys, or is not a plain feature record at all.
 * @param {*} value - What the namespace holds
 * @returns {boolean} True when it looks like the module itself
 */
export function isModuleNotRecord(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'function') return true;
    if (typeof value !== 'object') return false;
    const recordKeys = new Set(['name', 'initialize', 'cleanup', 'disable', 'enable', 'init']);
    const proto = Object.getPrototypeOf(value);
    // A class instance carries its methods on a prototype that itself has a parent. A plain object's
    // prototype is a realm's root Object.prototype (parentless), and the bundles run in another realm,
    // so identity with this realm's Object.prototype cannot be the test.
    const inherited = proto && Object.getPrototypeOf(proto) !== null ? Object.getOwnPropertyNames(proto) : [];
    const own = new Set([...Object.keys(value), ...inherited]);
    for (const key of own) {
        if (key === 'constructor' || recordKeys.has(key)) continue;
        if (typeof value[key] === 'function') return true;
    }
    return false;
}

/**
 * Run the built bundles in order inside one fresh window and report what they published.
 * @param {string[]} order - Library names in load order
 * @param {(name: string) => string} readBundle - Returns a bundle's source
 * @param {Object} deps - { Window } happy-dom's Window constructor; optional { setup(window) } to add page
 *   surface a bundle needs at load before it runs
 * @returns {{window: Object, errors: Array<{library: string, error: string}>}} The shared window and per-bundle load errors
 */
export function loadBundles(order, readBundle, { Window, setup }) {
    const window = new Window({ url: 'https://test.milkywayidle.com/game', width: 1280, height: 800 });
    const store = new Map();
    const quiet = { log() {}, info() {}, debug() {}, warn() {}, error() {} };

    // The Tampermonkey surface the bundles touch at load time. Anything a bundle needs only after
    // initialize() (storage, sockets, the game's DOM) is deliberately absent: nothing here starts the game.
    const grants = {
        GM_addStyle: () => {},
        GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        GM_setValue: (key, value) => void store.set(key, value),
        GM_deleteValue: (key) => void store.delete(key),
        GM_registerMenuCommand: () => {},
        GM_notification: () => {},
        GM_xmlhttpRequest: () => {},
        GM: { xmlHttpRequest: () => {}, getValue: async () => undefined, setValue: async () => {} },
        unsafeWindow: window,
    };
    Object.assign(window, grants);
    if (setup) setup(window);

    const context = vm.createContext(window);
    const errors = [];
    for (const library of order) {
        try {
            // Console is silenced per bundle so a passing run prints nothing; failures are reported explicitly.
            const realConsole = window.console;
            window.console = quiet;
            try {
                vm.runInContext(readBundle(library), context, { filename: `toolasha-${library}.js` });
            } finally {
                window.console = realConsole;
            }
        } catch (error) {
            errors.push({ library, error: `${error?.stack || error}`.split('\n').slice(0, 4).join('\n') });
            break; // the real userscript manager keeps loading, but every later bundle depends on this one
        }
    }
    return { window, errors };
}

/**
 * Every wiring check, as plain failure strings. Empty means the wiring holds.
 * @param {Object} args
 * @param {string[]} args.order - Library names in load order
 * @param {Object} args.root - `window.Toolasha` after loading
 * @param {Array<{accessor: string, library: string, key: string}>} args.reads - Bridge accessors
 * @returns {string[]} Failures
 */
export function wiringFailures({ order, root, reads }) {
    const failures = [];
    if (!root) return ['window.Toolasha is not defined after loading the bundles'];

    // The core bundle publishes its pieces under Core; every other library under its own name.
    const namespaceOf = (library) => (library === 'ui' ? 'UI' : library.charAt(0).toUpperCase() + library.slice(1));
    for (const library of order) {
        const namespace = namespaceOf(library);
        const published = root[namespace];
        if (!published || typeof published !== 'object' || Object.keys(published).length === 0) {
            failures.push(`toolasha-${library}.js did not publish a non-empty Toolasha.${namespace}`);
        }
    }

    for (const { accessor, library, key, used = true, publishedLater = false } of reads) {
        const namespace = root[library];
        if (!namespace) continue; // reported above when the library is one of the seven; otherwise not ours to check
        const value = namespace[key];
        // An accessor nobody calls cannot break anything, and a key the owner assigns after initialize()
        // is legitimately absent at load time; both are reported by the run's notes, not failed.
        if ((value === undefined || value === null) && (!used || publishedLater)) continue;
        if (value === undefined || value === null) {
            failures.push(`bundle-bridge.${accessor}() reads Toolasha.${library}.${key}, which is ${value}`);
        } else if (!isModuleNotRecord(value)) {
            failures.push(
                `Toolasha.${library}.${key} (bundle-bridge.${accessor}) holds a feature registry record, not the module ` +
                    `(keys: ${Object.keys(value).join(', ')})`
            );
        }
    }
    return failures;
}

/**
 * The built-artifact half of the singleton-ownership rule (the static half is check-bundle-sharing):
 * a singleton's class must be declared only in its owner's bundle, apart from documented copies. This
 * reads the shipped text, so it also catches a copy the source-graph walk cannot see.
 * @param {Object} args
 * @param {Array<{modulePath: string, className: string, owners: Set<string>}>} args.singletons - Owned singletons
 * @param {string[]} args.order - Library names
 * @param {(library: string) => string} args.readBundle - A bundle's source text
 * @param {Map<string, Map<string, string>>} args.allowlist - Tolerated copies (module → bundle → reason)
 * @returns {string[]} Failures
 */
export function duplicateSingletonFailures({ singletons, order, readBundle, allowlist }) {
    const failures = [];
    for (const { modulePath, className, owners } of singletons) {
        const declaration = new RegExp(`\\bclass ${className}\\b`);
        for (const library of order) {
            if (owners.has(library) || allowlist.get(modulePath)?.has(library)) continue;
            if (declaration.test(readBundle(library))) {
                failures.push(
                    `toolasha-${library}.js carries its own class ${className} (${modulePath}), owned by ` +
                        `${[...owners].join('/')} — a second, never-initialized instance`
                );
            }
        }
    }
    return failures;
}

/**
 * Every owned singleton must actually be published where the build's stand-ins and externals look for it.
 * A mistyped global in `singletonOwnership` (rollup.config.js) or a missing export in the owner's
 * src/libraries file would leave every other bundle reading `undefined` for the whole release.
 * @param {Object} root - `window.Toolasha`
 * @param {Map<string, {global: string, named?: string[]}>} ownership - rollup.config.js's `singletonOwnership`
 * @returns {string[]} Failures
 */
export function ownershipFailures(root, ownership) {
    const failures = [];
    for (const [modulePath, { global, named = [] }] of ownership) {
        const [, library, key] = global.split('.');
        const published = root?.[library]?.[key];
        if (published === undefined || published === null) {
            failures.push(`${global} is not published, but ${modulePath} is routed to it`);
            continue;
        }
        for (const name of named) {
            if (typeof published[name] !== 'function') failures.push(`${global}.${name} is not a function`);
        }
    }
    return failures;
}

/**
 * The labyrinth run ledger's pure helpers must reach the ui bundle from their own module.
 *
 * The ledger singleton is published as `Toolasha.Combat.labyrinthRunLedger` and the ui bundle's import of that
 * module is the iife external, i.e. the INSTANCE: it has no `sparkText`/`observedUse`. The Consumables panel
 * uses those through `labyrinth-run-ledger-math.js`, which the ui bundle compiles itself; calling them through
 * the instance made the whole Labyrinth section vanish in the release (the panel's try/catch swallowed
 * "observedUse is not a function"). Checks both halves: the instance really lacks the helper (so the routing
 * could not have served it) and the ui bundle carries the helper's own code (the spark glyph ladder).
 * @param {Object} root - `window.Toolasha`
 * @param {string} uiText - The built ui bundle
 * @returns {string[]} Failures
 */
export function ledgerHelperFailures(root, uiText) {
    const failures = [];
    const ledger = root?.Combat?.labyrinthRunLedger;
    if (!ledger) return ['Toolasha.Combat.labyrinthRunLedger is not published'];
    for (const name of ['sparkText', 'observedUse', 'rushFloorTable']) {
        if (typeof ledger[name] === 'function') {
            failures.push(`the ledger instance now has ${name}(); the math module split in the ui bundle is moot`);
        }
    }
    if (!uiText.includes('▁')) {
        failures.push(
            'toolasha-ui.js does not carry the ledger math (spark glyph ladder missing): its helpers are gone'
        );
    }
    return failures;
}

/**
 * The bridge as the utils bundle ships it, run against the live namespace, must hand back the exact
 * instances the owners published — the property #671 lost for the one module it imported instead.
 * @param {Object} root - `window.Toolasha`
 * @param {Array<{accessor: string, library: string, key: string}>} reads - Bridge accessors
 * @returns {string[]} Failures
 */
export function bridgeIdentityFailures(root, reads) {
    const bridge = root?.Utils?.bundleBridge;
    if (!bridge) return ['Toolasha.Utils.bundleBridge is not published, so cross-bundle reads cannot be checked'];
    const failures = [];
    for (const { accessor, library, key } of reads) {
        const owned = root[library]?.[key];
        if (owned === undefined || owned === null) continue; // reported (or tolerated) by wiringFailures
        let seen;
        try {
            seen = bridge[accessor]();
        } catch (error) {
            failures.push(`Utils.bundleBridge.${accessor}() threw: ${error?.message || error}`);
            continue;
        }
        if (seen !== owned) {
            failures.push(
                `Utils.bundleBridge.${accessor}() did not return the instance Toolasha.${library}.${key} holds`
            );
        }
    }
    const market = root.Market?.expectedValueCalculator;
    if (!market || typeof market.calculateSingleContainer !== 'function') {
        failures.push(
            'Toolasha.Market.expectedValueCalculator is not the calculator module (no calculateSingleContainer)'
        );
    } else if (bridge.expectedValueCalculator?.() !== market) {
        failures.push(
            "a utils bundle caller of the expected-value calculator would not see the market bundle's instance"
        );
    }
    return failures;
}

async function main() {
    const requireBuild = process.argv.includes('--require-build');
    const order = libraryLoadOrder(readFileSync(join(projectRoot, 'library-headers/entrypoint.txt'), 'utf8'));
    const bundlePath = (name) => join(projectRoot, `dist/libraries/toolasha-${name}.js`);
    const missing = order.filter((name) => !existsSync(bundlePath(name)));
    if (missing.length > 0) {
        const message = `dist/libraries is not built (missing ${missing.map((n) => `toolasha-${n}.js`).join(', ')})`;
        if (requireBuild) {
            console.error(`[check-bundle-smoke] FAILED: ${message} — run the production build first.`);
            process.exit(1);
        }
        console.log(`[check-bundle-smoke] SKIPPED: ${message}. Run \`npm run build\` first.`);
        return;
    }

    const require = createRequire(join(projectRoot, 'package.json'));
    const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href);

    const started = Date.now();
    const { window, errors } = loadBundles(order, (name) => readFileSync(bundlePath(name), 'utf8'), { Window });
    const reads = annotateReads(
        bridgeReads(readFileSync(join(projectRoot, 'src/utils/bundle-bridge.js'), 'utf8')),
        sourceFiles(join(projectRoot, 'src'))
    );

    const failures = errors.map(({ library, error }) => `toolasha-${library}.js threw while loading:\n${error}`);
    if (errors.length === 0) {
        failures.push(...wiringFailures({ order, root: window.Toolasha, reads }));
        failures.push(...bridgeIdentityFailures(window.Toolasha, reads));
    }

    process.env.BUILD_MODE = 'production';
    const rollupConfig = await import(pathToFileURL(join(projectRoot, 'rollup.config.js')).href);
    if (errors.length === 0)
        failures.push(...ledgerHelperFailures(window.Toolasha, readFileSync(bundlePath('ui'), 'utf8')));
    if (errors.length === 0) failures.push(...ownershipFailures(window.Toolasha, rollupConfig.singletonOwnership));
    const configs = rollupConfig.default;
    const { ownedSingletons, FOREIGN_COPY_ALLOWLIST } = await import('./check-bundle-sharing.mjs');
    failures.push(
        ...duplicateSingletonFailures({
            singletons: ownedSingletons(configs, rollupConfig.singletonOwnership),
            order,
            readBundle: (name) => readFileSync(bundlePath(name), 'utf8'),
            allowlist: FOREIGN_COPY_ALLOWLIST,
        })
    );

    await window.happyDOM.close();

    if (failures.length > 0) {
        console.error('');
        console.error('[check-bundle-smoke] FAILED: the split bundles are not wired together.');
        for (const failure of failures) console.error(`  - ${failure}`);
        console.error('');
        console.error('The dev build is one bundle, so only the production libraries show this. A bundle that');
        console.error('inlines its own copy of a singleton another bundle owns reads an uninitialized instance —');
        console.error('read the owner at call time through src/utils/bundle-bridge.js instead of importing it.');
        console.error('');
        process.exit(1);
    }
    console.log(
        `[check-bundle-smoke] OK: ${order.length} bundles loaded in order, ${reads.length} bridge reads resolve to ` +
            `their owners' modules (${Date.now() - started} ms).`
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
