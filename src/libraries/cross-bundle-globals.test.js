/**
 * What a cross-bundle global has to hold.
 *
 * A module listed in rollup's externals map is not bundled into the libraries
 * that import it. Every import of it compiles to a property read off one global
 * instead — `import { damageBreakdown } from 'damage-tracker.js'` becomes
 * `Toolasha.Combat.damageTracker.damageBreakdown`. So whatever the owning
 * library puts at that global has to carry that binding, or the import silently
 * reads `undefined`.
 *
 * Silently is the problem, and it is worse than it sounds: the dev standalone
 * build has no externals at all. It bundles everything, imports resolve
 * normally, and it works. Only the production bundles break, and they break as
 * `undefined is not a function` inside a panel that catches its own errors and
 * prints "could not be drawn". The DPs panel shipped that way — it read
 * `damageBreakdown` off a feature object that had `initialize` and `cleanup` on
 * it and nothing else.
 *
 * There is more than one right answer, which is why this checks for the binding
 * rather than for a particular import style. `core.js` builds
 * `profileManager: { setCurrentProfile, … }` by hand and that is fine;
 * `settings-schema.js` is mapped to `Toolasha.Core` itself and re-exports
 * `settingsGroups` at the top level, which is also fine. What is not fine is a
 * default export sitting where a module should be.
 *
 * Everything here is read from the actual rollup config, the actual import
 * graph and the actual library sources, so none of it can drift from them.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const LIBRARIES = ['core', 'utils', 'sim', 'market', 'actions', 'combat', 'ui'];

/**
 * The modules rollup replaces with a global, and the global each becomes.
 * @returns {Array<{file: string, global: string}>}
 */
function externals() {
    const config = readFileSync(join(ROOT, 'rollup.config.js'), 'utf8');
    const pattern = /join\(__dirname,\s*'([^']+\.js)'\)\),?\s*'([\w.]+)'/g;
    return [...config.matchAll(pattern)].map((match) => ({
        file: match[1],
        global: match[2],
    }));
}

/**
 * Every relative import in a file, resolved to a repo-relative path.
 * @param {string} file - Repo-relative path
 * @returns {Array<string>} Repo-relative paths
 */
function importsOf(file) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const here = dirname(join(ROOT, file));

    return [...source.matchAll(/from\s*'(\.[^']+\.js)'|import\s*'(\.[^']+\.js)'/g)]
        .map((match) => match[1] || match[2])
        .map((specifier) => relative(ROOT, resolve(here, specifier)));
}

/**
 * Which files end up in a bundle, by walking out from its entry.
 *
 * Membership is a property of the import graph rather than of the directory a
 * file happens to sit in — `features/combat/party-luck-panel.js` is in the
 * Combat bundle because `libraries/combat.js` reaches it, and a file reached by
 * two entries is genuinely in two bundles.
 *
 * @param {string} library - e.g. `combat`
 * @returns {Set<string>} Repo-relative paths
 */
function bundle(library) {
    const seen = new Set();
    const queue = [`src/libraries/${library}.js`];

    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;

        try {
            statSync(join(ROOT, file));
        } catch {
            continue;
        }
        seen.add(file);
        queue.push(...importsOf(file));
    }
    return seen;
}

const bundles = Object.fromEntries(LIBRARIES.map((library) => [library, bundle(library)]));

/**
 * Every source file, so importers can be looked for across all of them.
 * @param {string} directory - Absolute path to start from
 * @returns {Array<string>} Repo-relative paths
 */
function sourceFiles(directory) {
    const found = [];
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
        else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) found.push(relative(ROOT, path));
    }
    return found;
}

const files = sourceFiles(join(ROOT, 'src'));

/**
 * The named bindings imported from a module by files outside the bundle that
 * owns its global.
 *
 * A default import needs nothing checked — a library that exports the default
 * export puts exactly that at the global, which is what a default import wants.
 * Only `import { x } from` reaches through the global for a property.
 *
 * @param {string} file - Repo-relative path of the externalised module
 * @param {string} owner - The library whose global it is
 * @returns {{bindings: Set<string>, importers: Array<string>}}
 */
function crossBundleNamedImports(file, owner) {
    const bindings = new Set();
    const importers = [];
    const pattern = new RegExp(`import\\s+(?:\\w+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*'[^']*/${file.split('/').pop()}'`);

    for (const path of files) {
        if (path === file) continue;

        // Same bundle means no substitution happens and the import is ordinary
        const elsewhere = LIBRARIES.some((library) => library !== owner && bundles[library].has(path));
        if (!elsewhere) continue;

        const match = readFileSync(join(ROOT, path), 'utf8').match(pattern);
        if (!match) continue;

        importers.push(path);
        for (const binding of match[1].split(',')) {
            const name = binding
                .trim()
                .split(/\s+as\s+/)[0]
                .trim();
            if (name) bindings.add(name);
        }
    }
    return { bindings, importers };
}

describe('a module behind a cross-bundle global', () => {
    const checks = externals()
        .map((entry) => {
            const owner = entry.global.split('.')[1].toLowerCase();
            return { ...entry, owner, ...crossBundleNamedImports(entry.file, owner) };
        })
        .filter((entry) => entry.bindings.size > 0);

    test('there are some, so this is testing something', () => {
        expect(checks.length).toBeGreaterThan(0);
    });

    for (const entry of checks) {
        const name = entry.file.split('/').pop();

        test(`${name} exposes what ${entry.owner}.js callers import from it`, () => {
            // Whatever shape the library uses — `import * as`, a hand-built
            // object, or a top-level re-export — every binding another bundle
            // imports has to be reachable at the global, because that is the
            // property the compiled import reads.
            const library = readFileSync(join(ROOT, 'src/libraries', `${entry.owner}.js`), 'utf8');
            const namespaced = new RegExp(`import\\s*\\*\\s*as\\s+\\w+\\s*from\\s*'[^']*/${name}'`).test(library);
            if (namespaced) return;

            const missing = [...entry.bindings].filter((binding) => !new RegExp(`\\b${binding}\\b`).test(library));
            expect(
                missing,
                `${entry.global} is missing ${missing.join(', ')}, imported by ${entry.importers.join(', ')}`
            ).toEqual([]);
        });
    }
});
