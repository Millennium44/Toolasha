import { describe, expect, test } from 'vitest';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.BUILD_MODE = 'production';
const { singletonOwnership, singletonRouting, singletonStandInPlugin } = await import('../rollup.config.js');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const abs = (rel) => normalize(join(root, rel));

describe('singletonRouting', () => {
    test('an owner that loads before the bundle is an external; one that loads after is a stand-in', () => {
        const loadout = abs('src/features/combat/loadout-snapshot.js');
        // Combat owns the loadout snapshot: ui loads after it, everything else before
        expect(singletonRouting('ui').externals.get(loadout)).toBe('Toolasha.Combat.loadoutSnapshot');
        for (const early of ['utils', 'sim', 'market', 'actions']) {
            expect(singletonRouting(early).standIns.has(loadout)).toBe(true);
            expect(singletonRouting(early).externals.has(loadout)).toBe(false);
        }
    });

    test('the owner itself compiles the module', () => {
        const loadout = abs('src/features/combat/loadout-snapshot.js');
        const routing = singletonRouting('combat');
        expect(routing.externals.has(loadout)).toBe(false);
        expect(routing.standIns.has(loadout)).toBe(false);
    });

    test('the utils bundle, which loads before market, gets stand-ins for the market calculators', () => {
        const evc = abs('src/features/market/expected-value-calculator.js');
        expect(singletonRouting('utils').standIns.has(evc)).toBe(true);
        expect(singletonRouting('sim').standIns.has(evc)).toBe(true);
        expect(singletonRouting('actions').externals.get(evc)).toBe('Toolasha.Market.expectedValueCalculator');
    });

    test('every owned singleton names a real library and a module that exists', () => {
        for (const [modulePath, { global }] of singletonOwnership) {
            expect(global).toMatch(/^Toolasha\.(Core|Utils|Sim|Market|Actions|Combat|UI)\.[A-Za-z]+$/);
            expect(modulePath.endsWith('.js')).toBe(true);
        }
    });
});

describe('singletonStandInPlugin', () => {
    const target = abs('src/features/combat/loadout-snapshot.js');
    const buildScore = abs('src/features/profile/build-score-row.js');
    const plugin = singletonStandInPlugin(
        new Map([
            [target, { global: 'Toolasha.Combat.loadoutSnapshot' }],
            [buildScore, { global: 'Toolasha.Combat.buildScoreRow', named: ['ensureOwnScore'] }],
        ])
    );

    /**
     * Evaluate a stand-in module's source with `window` provided.
     * @param {string} source - Generated module text
     * @param {Object} windowStub - The window it reads
     * @returns {Object} `{ default, ...named }`
     */
    const evaluate = (source, windowStub) => {
        const body = source
            .replace('export default new Proxy', 'const __default = new Proxy')
            .replace(/export const (\w+) =/g, 'const $1 = __named.$1 =');
        return new Function('window', `const __named = {}; ${body}; return { default: __default, ...__named };`)(
            windowStub
        );
    };

    test('resolves only the routed module, by its path from the importer', () => {
        const importer = abs('src/features/actions/profit-display.js');
        expect(plugin.resolveId('../combat/loadout-snapshot.js', importer)).toMatch(/toolasha-stand-in:/);
        expect(plugin.resolveId('../combat/scroll-simulator.js', importer)).toBeNull();
        expect(plugin.resolveId('../combat/loadout-snapshot.js', undefined)).toBeNull();
        expect(plugin.resolveId('some-package', importer)).toBeNull();
    });

    test('the default export reads the owner live on every access, binds methods and forwards writes', () => {
        const id = plugin.resolveId('../combat/loadout-snapshot.js', abs('src/features/actions/profit-display.js'));
        const source = plugin.load(id);

        const early = {};
        const standIn = evaluate(source, early).default;
        // Before the owner loads, reading gives undefined rather than throwing
        expect(standIn.snapshots).toBeUndefined();
        expect('snapshots' in standIn).toBe(false);

        const store = {
            snapshots: { a: 1 },
            read() {
                return this.snapshots;
            },
        };
        early.Toolasha = { Combat: { loadoutSnapshot: store } };
        expect(standIn.snapshots).toBe(store.snapshots);
        expect(standIn.read()).toBe(store.snapshots);
        standIn.snapshots = { b: 2 };
        expect(store.snapshots).toEqual({ b: 2 });
    });

    test('named exports forward to the owner namespace and say so plainly when it is absent', () => {
        const id = plugin.resolveId(
            '../profile/build-score-row.js',
            abs('src/features/combat-sim/party-template-tuner.js')
        );
        const win = {};
        const stub = evaluate(plugin.load(id), win);
        expect(() => stub.ensureOwnScore()).toThrow(/Combat\.buildScoreRow is not loaded/);
        win.Toolasha = { Combat: { buildScoreRow: { ensureOwnScore: (x) => `own:${x}` } } };
        expect(stub.ensureOwnScore('s')).toBe('own:s');
    });
});
