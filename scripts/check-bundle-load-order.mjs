#!/usr/bin/env node
/**
 * Bundle load-order check.
 *
 * The production script is several iife bundles, @required in a fixed order
 * (library-headers/entrypoint.txt). Each bundle receives the modules it shares
 * with others as arguments to its iife — `}(Toolasha.Core.config, …)` — and
 * those arguments are evaluated the moment the bundle loads. An argument that
 * names a bundle loading LATER reads `undefined.something` and throws, so that
 * bundle never registers and nothing after it loads either.
 *
 * 3.58.0 shipped exactly that: the Skilling Optimizer (Actions bundle) imported
 * from the upgrade advisor, which pulled `Toolasha.Combat.guildTokenValue` into
 * the Actions bundle's arguments. Combat loads after Actions. The dev build is a
 * single bundle, so nothing but the released script could show it.
 *
 * Run after `rollup -c` in production mode: `node scripts/check-bundle-load-order.mjs`
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * The `Toolasha.<Library>` namespaces a bundle's iife call arguments read.
 * @param {string} bundleText - A built library bundle
 * @returns {Set<string>} Lower-cased library names, e.g. {'core', 'utils'}
 */
export function loadTimeReferences(bundleText) {
    const tail = bundleText.slice(-20000);
    const callStart = tail.lastIndexOf('}(');
    const args = callStart === -1 ? '' : tail.slice(callStart);
    const refs = new Set();
    for (const match of args.matchAll(/Toolasha\.([A-Z][A-Za-z]*)\b/g)) refs.add(match[1].toLowerCase());
    return refs;
}

/**
 * Every load-time reference to a library that loads at or after the bundle.
 * @param {string[]} order - Library names in load order
 * @param {Map<string, Set<string>>} referencesByBundle - Bundle name → libraries its arguments read
 * @returns {Array<{bundle: string, references: string}>} Violations, empty when the order holds
 */
export function findLoadOrderViolations(order, referencesByBundle) {
    const violations = [];
    for (const [bundle, refs] of referencesByBundle) {
        const position = order.indexOf(bundle);
        for (const ref of refs) {
            const refPosition = order.indexOf(ref);
            if (refPosition === -1) continue;
            if (refPosition >= position) violations.push({ bundle, references: ref });
        }
    }
    return violations;
}

function main() {
    const order = libraryLoadOrder(readFileSync(join(projectRoot, 'library-headers/entrypoint.txt'), 'utf8'));
    const referencesByBundle = new Map();
    for (const name of order) {
        const path = join(projectRoot, `dist/libraries/toolasha-${name}.js`);
        if (!existsSync(path)) {
            console.error(`[check-bundle-load-order] FAILED: ${path} is missing — run the production build first.`);
            process.exit(1);
        }
        referencesByBundle.set(name, loadTimeReferences(readFileSync(path, 'utf8')));
    }

    const violations = findLoadOrderViolations(order, referencesByBundle);
    if (violations.length > 0) {
        console.error('');
        console.error('[check-bundle-load-order] FAILED: a bundle reads a library that has not loaded yet.');
        console.error(`  Load order: ${order.join(' → ')}`);
        for (const { bundle, references } of violations) {
            console.error(`  toolasha-${bundle}.js reads Toolasha.${references[0].toUpperCase()}${references.slice(1)}.*`);
        }
        console.error('');
        console.error('That bundle throws as it loads and nothing after it registers. Cut the import that');
        console.error('pulls the later library in (move the shared function into core/utils or a small');
        console.error('standalone module), or read the owner at call time through src/utils/bundle-bridge.js.');
        console.error('');
        process.exit(1);
    }
    console.log(`[check-bundle-load-order] OK: every bundle reads only libraries loaded before it (${order.join(' → ')}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
