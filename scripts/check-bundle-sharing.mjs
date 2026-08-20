#!/usr/bin/env node
/**
 * Bundle-sharing check.
 *
 * The production build splits the script into several iife bundles, and any
 * `src/utils/**` module that two bundles both reach is silently copied into
 * each of them unless `rollup.config.js` declares it external (the
 * `utilsExternalGlobals` map) and `src/libraries/utils.js` exports it. Two
 * copies means divergent state — the config's own comments record the
 * casualties (duplicated watch timers, stale geometry caches, a second toast
 * stack) — and nothing used to notice until a panel misbehaved.
 *
 * This script makes the rule executable: it walks the static import graph from
 * every production bundle entry, using the same `external` predicates the
 * build itself uses, and fails loudly on any `src/utils/**` module that ends
 * up bundled inline into two or more bundles without being allowlisted.
 *
 * What "inline" means here: a module an `external` predicate exempts is not
 * traversed for that bundle — it arrives at runtime through the shared
 * `Toolasha.*` global, which is the whole point. A module the predicate does
 * not exempt is compiled into the bundle, so reaching it from two bundles is
 * two copies.
 *
 * Deliberately out of scope:
 * - `?worker` imports: a Web Worker is its own realm with no `window.Toolasha`,
 *   so its graph is bundled inline per worker by design and cannot share.
 * - `?raw` imports: CSS text, no graph behind it.
 * - bare specifiers (node_modules): vendored per bundle on purpose; only
 *   `src/utils/**` sharing is this script's business.
 * - `rollup.config.enhancement.js`: the standalone enhancement build is a
 *   separate script, not one of the cooperating production bundles.
 *
 * Run standalone: `node scripts/check-bundle-sharing.mjs`
 * Wired into: `npm run build` (runs before rollup).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, normalize, relative, basename } from 'path';
import { fileURLToPath } from 'url';
import { init as initLexer, parse as parseModule } from 'es-module-lexer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

/**
 * Modules that are allowed to be bundled inline into more than one bundle.
 *
 * Every entry needs a justification. The bar: the module must be stateless by
 * design (constants or pure functions, no module-level mutable state, no DOM
 * or storage side effects at import time), so a second copy is only weight —
 * never a second, divergent truth. Anything stateful belongs in the externals
 * map instead.
 *
 * Keys are project-relative paths with forward slashes.
 */
const ALLOWLIST = new Map([
    [
        'src/utils/market-listings.js',
        // One exported pure function (mergeMarketListings), no module state.
        // Imported by core/data-manager.js, and the core bundle loads before
        // the utils bundle so it cannot reference Toolasha.Utils.* — the copy
        // in core is unavoidable and harmless.
        'stateless pure function; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/scroll-buff-values.js',
        // Exported constants only. Same core-loads-first situation as
        // market-listings: data-manager needs it before the utils bundle exists.
        'constants only; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/bundle-bridge.js',
        // Null-safe accessors over window.Toolasha with no state of their own —
        // every call reads the live namespace, so each copy gives identical
        // answers. core/settings-schema.js uses it and core loads before the
        // utils bundle, so the copy in core is unavoidable.
        'stateless accessors over the live namespace; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/panel-minimize.js',
        // attachMinimize is a pure factory: all its state is per-call closure
        // state on the panel it is given, and the only persistence goes through
        // panel-geometry (itself a shared external, so one source of truth). No
        // module-level mutable state, no import-time side effects. Imported by
        // panels across every bundle, so a copy in each is only weight.
        'stateless factory; persistence delegated to the shared panel-geometry global',
    ],
    [
        'src/utils/class-inference.js',
        // Constants (the bucket table) and pure functions over arguments the
        // caller owns: newCastLog hands back a plain object, noteCast mutates
        // the one it is given, and inferClass reads game data passed in. No
        // module-level mutable state and no import-time side effects — the
        // accumulated evidence lives on guildTrialAbilities, which is a single
        // instance in the combat bundle. The trial panels are in the ui bundle
        // and the trial stream is in combat, so both reach it.
        'constants and pure functions; the accumulated state lives on the caller, not here',
    ],
]);

/** Import suffixes handled by custom rollup plugins; their targets are not part of the shared JS graph */
const PLUGIN_SUFFIXES = ['?raw', '?worker'];

/**
 * Extract static import/re-export specifiers from a module's source.
 * @param {string} filePath - Absolute path of the module
 * @returns {string[]} Raw specifiers as written
 */
function importSpecifiers(filePath) {
    const source = readFileSync(filePath, 'utf-8');
    const [imports] = parseModule(source, filePath);
    const specifiers = [];
    for (const record of imports) {
        // record.n is the specifier when statically analysable; dynamic
        // import(expr) has no n and the codebase has none in src/
        if (record.n) specifiers.push(record.n);
    }
    return specifiers;
}

/**
 * Resolve a specifier relative to its importer, or null when it is not part
 * of the bundled project graph (bare, virtual, or plugin-suffixed).
 * @param {string} specifier - As written in the import statement
 * @param {string} importer - Absolute path of the importing module
 * @returns {string|null} Absolute path, or null to skip
 */
function resolveSpecifier(specifier, importer) {
    if (PLUGIN_SUFFIXES.some((suffix) => specifier.endsWith(suffix))) return null;
    if (!specifier.startsWith('.')) return null; // bare (node_modules) or virtual: module
    const resolved = normalize(join(dirname(importer), specifier));
    if (!existsSync(resolved)) {
        console.warn(`[check-bundle-sharing] Unresolvable import '${specifier}' in ${relative(projectRoot, importer)}`);
        return null;
    }
    return resolved;
}

/**
 * Walk one bundle's import graph, honoring its external predicate.
 * @param {string} entry - Absolute path of the bundle entry module
 * @param {(id: string) => boolean} isExternal - The bundle's external predicate
 * @returns {Set<string>} Absolute paths of every module bundled inline
 */
function walkBundle(entry, isExternal) {
    const inline = new Set();
    const queue = [entry];
    while (queue.length > 0) {
        const current = queue.pop();
        if (inline.has(current)) continue;
        inline.add(current);
        for (const specifier of importSpecifiers(current)) {
            const resolved = resolveSpecifier(specifier, current);
            if (!resolved) continue;
            if (isExternal(resolved)) continue; // arrives via the shared global
            if (!inline.has(resolved)) queue.push(resolved);
        }
    }
    return inline;
}

async function main() {
    await initLexer;

    // The real build config, so the check can never drift from what rollup
    // actually does. BUILD_MODE selects the multi-bundle production array.
    process.env.BUILD_MODE = 'production';
    const configs = (await import('../rollup.config.js')).default;
    if (!Array.isArray(configs)) {
        console.error('[check-bundle-sharing] Expected the production config array from rollup.config.js');
        process.exit(2);
    }

    // module path -> Set of bundle names that carry it inline
    const inlineIn = new Map();

    for (const config of configs) {
        const entry = normalize(join(projectRoot, config.input));
        const bundleName = basename(config.input, '.js');
        const isExternal = typeof config.external === 'function' ? config.external : () => false;
        for (const modulePath of walkBundle(entry, isExternal)) {
            const relPath = relative(projectRoot, modulePath).split('\\').join('/');
            if (!relPath.startsWith('src/utils/')) continue;
            if (!inlineIn.has(relPath)) inlineIn.set(relPath, new Set());
            inlineIn.get(relPath).add(bundleName);
        }
    }

    const violations = [];
    for (const [modulePath, bundles] of inlineIn) {
        if (bundles.size < 2) continue;
        if (ALLOWLIST.has(modulePath)) continue;
        violations.push({ modulePath, bundles: [...bundles].sort() });
    }
    violations.sort((a, b) => a.modulePath.localeCompare(b.modulePath));

    if (violations.length > 0) {
        console.error('');
        console.error('[check-bundle-sharing] FAILED: utils modules duplicated across production bundles.');
        console.error('');
        for (const { modulePath, bundles } of violations) {
            console.error(`  ${modulePath}`);
            console.error(`      bundled inline into: ${bundles.join(', ')}`);
        }
        console.error('');
        console.error('Each bundle above carries its own copy, with its own module state.');
        console.error('Fix by sharing one copy (the liquidity-cap entry is the precedent):');
        console.error('  1. add the module to utilsExternalGlobals in rollup.config.js, and');
        console.error('  2. import + export it in src/libraries/utils.js so the global exists.');
        console.error('Only a module that is stateless by design may instead be allowlisted');
        console.error('in scripts/check-bundle-sharing.mjs, with a justification.');
        console.error('');
        process.exit(1);
    }

    console.log(`[check-bundle-sharing] OK: no unshared cross-bundle src/utils modules (${inlineIn.size} checked).`);
}

await main();
