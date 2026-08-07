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

/**
 * A stateful singleton reached through the bundle bridge.
 *
 * Some singletons are not in rollup's externals map. They are published to the
 * namespace at runtime (`window.Toolasha.Market.treasureTracker`) and read back
 * through a `bundle-bridge.js` accessor. A caller in another bundle that instead
 * default-imports the module gets a second, empty instance: its `initialize()`
 * never runs, so it never subscribes to the websocket and its state stays empty.
 * That is invisible in the dev standalone build (one bundle, one instance) and
 * breaks only in production — the shape the treasure-tracker Settings button and
 * the loadout-snapshot sim both shipped.
 *
 * The rule that stops it recurring: a file in a bundle other than the owner may
 * keep a default import of the module only as a dev-standalone fallback, and
 * must read the live copy through the bridge accessor. So a cross-bundle default
 * import is allowed only alongside an import of that accessor from
 * `bundle-bridge.js`.
 *
 * Read from `bundle-bridge.js`, the library sources and the import graph, so it
 * cannot drift from them.
 */
function bridgeAccessors() {
    const source = readFileSync(join(ROOT, 'src/utils/bundle-bridge.js'), 'utf8');
    const accessors = [];
    for (const match of source.matchAll(/export function (\w+)\(\)\s*{([\s\S]*?)}/g)) {
        const [, name, body] = match;
        const root = /toolashaRoot\(\)([\s\S]*?)(?:\|\||;|$)/.exec(body);
        if (!root) continue; // toolashaRoot itself, or a non-namespace accessor
        const segments = [...root[1].matchAll(/\?\.(\w+)|\.(\w+)/g)].map((m) => m[1] || m[2]);
        if (segments.length === 0) continue;
        accessors.push({ name, prop: segments[segments.length - 1] });
    }
    return accessors;
}

/**
 * The module a library default-imports under `prop`, and the bundle that owns
 * it — that is the live, namespace-published copy.
 * @param {string} prop - The namespace property the accessor reads
 * @returns {{file: string, owner: string} | null}
 */
function bridgeOwnerOf(prop) {
    for (const owner of LIBRARIES) {
        const libPath = `src/libraries/${owner}.js`;
        let source;
        try {
            source = readFileSync(join(ROOT, libPath), 'utf8');
        } catch {
            continue;
        }
        const match = new RegExp(`import\\s+${prop}\\s+from\\s*'(\\.[^']+\\.js)'`).exec(source);
        if (!match) continue;
        return { file: relative(ROOT, resolve(dirname(join(ROOT, libPath)), match[1])), owner };
    }
    return null;
}

/**
 * Files that default-import a module (i.e. reach for its singleton instance),
 * matched by basename. Named-only imports (`import { helper } from …`) do not
 * grab the instance and are not counted.
 * @param {string} file - Repo-relative path of the singleton module
 * @returns {Array<string>}
 */
function defaultImportersOf(file) {
    const basename = file.split('/').pop().replace(/\./g, '\\.');
    const pattern = new RegExp(`import\\s+\\w+\\s*(?:,\\s*{[^}]*})?\\s*from\\s*'[^']*/${basename}'`);
    return files.filter((path) => path !== file && pattern.test(readFileSync(join(ROOT, path), 'utf8')));
}

/**
 * Whether a file imports the named accessor from bundle-bridge.js.
 * @param {string} path - Repo-relative path
 * @param {string} name - Accessor name
 * @returns {boolean}
 */
function readsBridgeAccessor(path, name) {
    const match = /import\s*{([^}]*)}\s*from\s*'[^']*\/bundle-bridge\.js'/.exec(readFileSync(join(ROOT, path), 'utf8'));
    if (!match) return false;
    return match[1].split(',').some(
        (binding) =>
            binding
                .trim()
                .split(/\s+as\s+/)[0]
                .trim() === name
    );
}

/**
 * Bundle membership as the production build actually resolves it: walking out
 * from the entry but treating an externalised module as a cut. Rollup replaces
 * such a module with a global read, so it is not bundled in and its own imports
 * pull nothing further into this bundle. The plain `bundle()` above over-counts
 * for this purpose because it follows every import regardless — fine for the
 * externals test (which only asks whether a binding is exposed), wrong for
 * asking whether a file is genuinely duplicated across bundles.
 * @param {string} library - e.g. `combat`
 * @param {Set<string>} externalFiles - Repo-relative paths of externalised modules
 * @returns {Set<string>}
 */
function bundleCuttingExternals(library, externalFiles) {
    const seen = new Set();
    const queue = [`src/libraries/${library}.js`];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file) || externalFiles.has(file)) continue;
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

describe('a stateful singleton behind the bundle bridge', () => {
    const externalFiles = new Set(externals().map((entry) => entry.file));
    const strictBundles = Object.fromEntries(
        LIBRARIES.map((library) => [library, bundleCuttingExternals(library, externalFiles)])
    );

    const checks = bridgeAccessors()
        .map((accessor) => ({ ...accessor, ...(bridgeOwnerOf(accessor.prop) || {}) }))
        // An externalised module is shared through rollup's global, not the
        // bridge — a direct import of it is rewritten, never duplicated, so it
        // is the cross-bundle-globals check above that governs it, not this one.
        .filter((accessor) => accessor.file && !externalFiles.has(accessor.file));

    test('there are some, so this is testing something', () => {
        expect(checks.length).toBeGreaterThan(0);
    });

    for (const entry of checks) {
        const name = entry.file.split('/').pop();

        test(`${name} is read through the bridge by callers outside the ${entry.owner} bundle`, () => {
            // A default import that lands in another bundle mints a second, empty
            // instance. It is tolerable only as a dev fallback, which means the
            // file must also read the live copy through the bridge accessor.
            // The bug shape is a file that can only ever see the empty
            // duplicate: it lands in a bundle other than the owner's and is
            // never co-bundled with the live copy. A file that is also in the
            // owner bundle resolves the direct import to the live copy there;
            // its presence in another bundle is a plain duplication concern, not
            // this stale-state one, and is out of scope here.
            const offenders = defaultImportersOf(entry.file).filter((path) => {
                const inOwnerBundle = strictBundles[entry.owner]?.has(path);
                const inOtherBundle = LIBRARIES.some(
                    (library) => library !== entry.owner && strictBundles[library].has(path)
                );
                return inOtherBundle && !inOwnerBundle && !readsBridgeAccessor(path, entry.name);
            });
            expect(
                offenders,
                `${name} is default-imported across a bundle boundary without reading ${entry.name}() from the bridge in: ${offenders.join(', ')}`
            ).toEqual([]);
        });
    }
});
