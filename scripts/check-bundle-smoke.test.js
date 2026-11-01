import { describe, expect, test } from 'vitest';
import { Window } from 'happy-dom';
import {
    annotateReads,
    bridgeIdentityFailures,
    bridgeReads,
    duplicateSingletonFailures,
    isModuleNotRecord,
    libraryLoadOrder,
    loadBundles,
    wiringFailures,
} from './check-bundle-smoke.mjs';

/** A bundle that publishes a namespace the way src/libraries/*.js do */
const publish = (namespace, body) =>
    `(() => { const root = window.Toolasha || {}; window.Toolasha = root; root.${namespace} = ${body}; })();`;

describe('bridge accessor parsing', () => {
    test('reads library and key from each accessor', () => {
        const source = `
export function expectedValueCalculator() {
    return toolashaRoot()?.Market?.expectedValueCalculator || null;
}
export function dataManager() {
    return toolashaRoot()?.Core?.dataManager || null;
}
export function guildTrialScoreboard() {
    return toolashaRoot()?.guildTrialScoreboard || null;
}`;
        expect(bridgeReads(source)).toEqual([
            { accessor: 'expectedValueCalculator', library: 'Market', key: 'expectedValueCalculator' },
            { accessor: 'dataManager', library: 'Core', key: 'dataManager' },
        ]);
    });

    test('marks an accessor nobody calls, and a key assigned after load', () => {
        const reads = [{ accessor: 'labSimUI', library: 'Sim', key: 'labSimUI' }];
        const unused = annotateReads(reads, [
            { path: '/src/utils/bundle-bridge.js', text: 'export function labSimUI() {}' },
        ]);
        expect(unused[0].used).toBe(false);
        const later = annotateReads(reads, [
            { path: '/src/a.js', text: 'labSimUI()' },
            { path: '/src/b.js', text: 'window.Toolasha.Sim.labSimUI = x;' },
        ]);
        expect(later[0]).toMatchObject({ used: true, publishedLater: true });
    });
});

describe('library order and module-vs-record', () => {
    test('follows the @require lines', () => {
        expect(
            libraryLoadOrder('// @require https://x/toolasha-core.js\n// @require https://x/toolasha-utils.js')
        ).toEqual(['core', 'utils']);
    });

    test('a feature registry record is not the module', () => {
        expect(isModuleNotRecord({ name: 'EV', initialize() {}, cleanup() {} })).toBe(false);
        expect(isModuleNotRecord({ name: 'EV', initialize() {}, calculateSingleContainer() {} })).toBe(true);
        class Calc {
            calculate() {}
        }
        expect(isModuleNotRecord(new Calc())).toBe(true);
        expect(isModuleNotRecord(null)).toBe(false);
    });
});

describe('loading real bundle text into one window', () => {
    const bundles = {
        core: publish('Core', '{ dataManager: { getItemDetails() {} } }'),
        utils: publish(
            'Utils',
            '{ bundleBridge: { expectedValueCalculator: () => window.Toolasha?.Market?.expectedValueCalculator || null } }'
        ),
        market: publish('Market', '{ expectedValueCalculator: { calculateSingleContainer() { return 1; } } }'),
    };
    const order = ['core', 'utils', 'market'];

    test('a healthy set loads in order and passes every check', () => {
        const { window, errors } = loadBundles(order, (name) => bundles[name], { Window });
        expect(errors).toEqual([]);
        const reads = [{ accessor: 'expectedValueCalculator', library: 'Market', key: 'expectedValueCalculator' }];
        expect(wiringFailures({ order, root: window.Toolasha, reads })).toEqual([]);
        expect(bridgeIdentityFailures(window.Toolasha, reads)).toEqual([]);
    });

    test('a bundle that throws while loading is reported and stops the run', () => {
        const broken = { ...bundles, utils: 'Toolasha.Core.nothing.here.throws();' };
        const { errors } = loadBundles(order, (name) => broken[name], { Window });
        expect(errors).toHaveLength(1);
        expect(errors[0].library).toBe('utils');
    });

    test('the #671 shape — a utils copy that is not the market instance — fails the identity check', () => {
        const stale = {
            ...bundles,
            utils: publish(
                'Utils',
                '{ bundleBridge: { expectedValueCalculator: () => ({ calculateSingleContainer() { return null; } }) } }'
            ),
        };
        const { window } = loadBundles(order, (name) => stale[name], { Window });
        const reads = [{ accessor: 'expectedValueCalculator', library: 'Market', key: 'expectedValueCalculator' }];
        expect(bridgeIdentityFailures(window.Toolasha, reads).join('\n')).toContain('would not see the market bundle');
    });

    test('a registry record in place of the module fails the wiring check', () => {
        const record = {
            ...bundles,
            market: publish('Market', '{ expectedValueCalculator: { name: "EV", initialize() {}, cleanup() {} } }'),
        };
        const { window } = loadBundles(order, (name) => record[name], { Window });
        const reads = [{ accessor: 'expectedValueCalculator', library: 'Market', key: 'expectedValueCalculator' }];
        expect(wiringFailures({ order, root: window.Toolasha, reads }).join('\n')).toContain('feature registry record');
    });
});

describe('duplicateSingletonFailures', () => {
    const singletons = [
        {
            modulePath: 'src/features/market/profit-calculator.js',
            className: 'ProfitCalculator',
            owners: new Set(['market']),
        },
    ];
    const order = ['utils', 'market'];

    test('flags a non-owner bundle that declares the class', () => {
        const readBundle = (name) => (name === 'utils' ? 'class ProfitCalculator{}' : 'class ProfitCalculator{}');
        const failures = duplicateSingletonFailures({ singletons, order, readBundle, allowlist: new Map() });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('toolasha-utils.js');
    });

    test('passes when only the owner declares it, or the copy is documented', () => {
        const ownerOnly = (name) => (name === 'market' ? 'class ProfitCalculator{}' : '');
        expect(duplicateSingletonFailures({ singletons, order, readBundle: ownerOnly, allowlist: new Map() })).toEqual(
            []
        );
        const both = () => 'class ProfitCalculator{}';
        const allowlist = new Map([['src/features/market/profit-calculator.js', new Map([['utils', 'why']])]]);
        expect(duplicateSingletonFailures({ singletons, order, readBundle: both, allowlist })).toEqual([]);
    });
});
