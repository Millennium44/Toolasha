/** @vitest-environment happy-dom
 *
 * The lifecycle contract every registered feature has to keep.
 *
 * A character switch tears every feature down and builds it back up. The one
 * thing that must not happen is a teardown that throws *part-way*: the feature
 * has already removed its panel, and the throw skips whatever clears its
 * `isInitialized` flag, so the rebuild returns early at its own guard and the
 * feature stays dead — tab clicks throwing on a null panel — until the page is
 * reloaded. That is a whole-session outage for one player, and it reaches them
 * as "the History tab does nothing any more" rather than as an error.
 *
 * No arithmetic test can catch it, and the unit tests could not either: the
 * bug that produced this file was a `cleanupRegistry.cleanup()` call against a
 * registry that only has `cleanupAll()`, and the feature's own test mocked the
 * registry with a `cleanup()` method the real one does not have. The mock
 * agreed with the typo.
 *
 * So the core singletons here are mocked *from the real modules* — every key
 * the real object has, functions replaced by `vi.fn()`, and nothing else. A
 * feature that calls a method the real singleton does not have gets a
 * TypeError, in this test, rather than in a player's browser on a Tuesday.
 *
 * What each feature is put through is deliberately small, because it has to
 * hold for all of them without any per-feature setup:
 *
 * - `cleanup()` on a module that was never initialised must not throw. Teardown
 *   before setup is legal and happens for real — the registry disables every
 *   feature on a switch, including the ones whose settings were off.
 * - A second `cleanup()` must not throw either. Idempotence is what makes the
 *   registry's "disable everything" safe to run twice.
 * - And afterwards the module must not still look initialised, so the rebuild
 *   is not turned away by a stale guard.
 */

import { describe, test, expect, vi } from 'vitest';

/** Every own and inherited key of an object, constructor aside. */
function allKeys(obj) {
    const keys = new Set();
    let cursor = obj;
    while (cursor && cursor !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(cursor)) if (key !== 'constructor') keys.add(key);
        cursor = Object.getPrototypeOf(cursor);
    }
    return [...keys];
}

/**
 * A stand-in with exactly the real singleton's surface — no more, no less.
 *
 * Building it from the real module is the point: a hand-written mock drifts,
 * and a mock that offers a method the real module dropped is how a misnamed
 * call survives its own unit test.
 *
 * @param {Object} real - The real singleton
 * @param {Object} [overrides] - Values for the handful of methods a feature reads at import
 * @returns {Object} The mock
 */
function surfaceOf(real, overrides = {}) {
    const mock = {};
    for (const key of allKeys(real)) {
        let value;
        try {
            value = real[key];
        } catch {
            continue;
        }
        mock[key] = typeof value === 'function' ? vi.fn() : value;
    }
    return Object.assign(mock, overrides);
}

vi.mock('./config.js', async (importOriginal) => {
    const real = (await importOriginal()).default;
    return {
        default: surfaceOf(real, {
            getSetting: vi.fn((_key, fallback) => fallback),
            getSettingValue: vi.fn((_key, fallback) => fallback),
            isFeatureEnabled: vi.fn(() => false),
            onSettingChange: vi.fn(() => () => {}),
            offSettingChange: vi.fn(),
            onSettingsLoaded: vi.fn(() => () => {}),
            loadSettings: vi.fn(async () => {}),
            applyColorSettings: vi.fn(),
        }),
    };
});

vi.mock('./storage.js', async (importOriginal) => {
    const real = (await importOriginal()).default;
    return {
        default: surfaceOf(real, {
            ready: Promise.resolve(true),
            available: true,
            get: vi.fn(async (_key, _store, fallback = null) => fallback),
            getJSON: vi.fn(async (_key, _store, fallback = null) => fallback),
            tryGet: vi.fn(async () => ({ found: false, value: null })),
            set: vi.fn(async () => true),
            setJSON: vi.fn(async () => true),
            delete: vi.fn(async () => true),
            getAll: vi.fn(async () => []),
            getAllKeys: vi.fn(async () => []),
            has: vi.fn(async () => false),
            initialize: vi.fn(async () => true),
        }),
    };
});

vi.mock('./data-manager.js', async (importOriginal) => {
    const real = (await importOriginal()).default;
    return {
        default: surfaceOf(real, {
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn(),
            initialize: vi.fn(async () => {}),
            getCurrentCharacterId: vi.fn(() => 'lifecycle-test'),
            getCurrentCharacterName: vi.fn(() => 'Lifecycle'),
            getCurrentCharacterGameMode: vi.fn(() => 'standard'),
            getIsCharacterSwitching: vi.fn(() => false),
            getInitClientData: vi.fn(() => null),
            getItemDetails: vi.fn(() => null),
            getInventory: vi.fn(() => []),
            getSkills: vi.fn(() => ({})),
            getCurrentActions: vi.fn(() => []),
            getEquipment: vi.fn(() => ({})),
        }),
    };
});

vi.mock('./websocket.js', async (importOriginal) => {
    const real = (await importOriginal()).default;
    return { default: surfaceOf(real, { on: vi.fn(), off: vi.fn(), install: vi.fn(), isHooked: false }) };
});

vi.mock('../api/marketplace.js', async (importOriginal) => {
    const real = (await importOriginal()).default;
    return {
        default: surfaceOf(real, {
            on: vi.fn(),
            off: vi.fn(),
            fetch: vi.fn(async () => null),
            isLoaded: vi.fn(() => false),
            getPrice: vi.fn(() => null),
            getPrices: vi.fn(() => null),
            getPricesBatch: vi.fn(() => ({})),
        }),
    };
});

// The four @require bundles the entrypoint reads its feature list out of. They
// publish themselves onto window.Toolasha exactly as they do in the browser, so
// importing them gives the same population the entrypoint registers, without
// having to run the bootstrap.
await import('../libraries/market.js');
await import('../libraries/actions.js');
await import('../libraries/combat.js');
await import('../libraries/ui.js');

/** Every module in the bundles that offers both halves of the lifecycle. */
const lifecycleModules = [];
for (const bundleName of ['Market', 'Actions', 'Combat', 'UI']) {
    const surface = window.Toolasha?.[bundleName] ?? {};
    for (const [exportName, module] of Object.entries(surface)) {
        if (!module || typeof module !== 'object') continue;
        const teardown =
            typeof module.disable === 'function' ? 'disable' : typeof module.cleanup === 'function' ? 'cleanup' : null;
        if (!teardown || typeof module.initialize !== 'function') continue;
        lifecycleModules.push({ name: `${bundleName}.${exportName}`, module, teardown });
    }
}

/** The flags a feature's `initialize()` guards on, as far as any of them use. */
const INIT_FLAGS = ['isInitialized', 'initialized', 'isActive'];

describe('the feature bundles', () => {
    test('export a population worth checking', () => {
        // A refactor that renames a bundle export or drops the default object
        // would otherwise turn this whole file into a silent no-op.
        expect(lifecycleModules.length).toBeGreaterThan(80);
    });
});

describe.each(lifecycleModules)('$name', ({ module, teardown }) => {
    test('tears down without throwing, twice, and does not stay initialised', async () => {
        // The wrapper swallows the return value so a rejection — sync throw or
        // async — is the only way this can fail.
        const tearDown = async () => {
            await module[teardown]();
        };
        // Teardown catches its own failures now, so a throw inside one shows up
        // as this log rather than as a rejection — which is what a misnamed
        // helper method (`cleanupRegistry.cleanup()` against a registry that
        // only has `cleanupAll()`) looks like from out here.
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(tearDown()).resolves.toBeUndefined();
            await expect(tearDown()).resolves.toBeUndefined();
            const partWay = logged.mock.calls.filter((args) => String(args[0]).includes('Disable failed part-way'));
            expect(partWay, `teardown threw part-way: ${JSON.stringify(partWay)}`).toEqual([]);
        } finally {
            logged.mockRestore();
        }

        for (const flag of INIT_FLAGS) {
            if (flag in module) expect(module[flag], `${flag} left set after ${teardown}()`).toBeFalsy();
        }
    });
});
