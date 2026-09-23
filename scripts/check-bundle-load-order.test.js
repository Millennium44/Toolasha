import { describe, expect, test } from 'vitest';
import { findLoadOrderViolations, libraryLoadOrder, loadTimeReferences } from './check-bundle-load-order.mjs';

describe('bundle load-order check', () => {
    test('reads the library order from the @require lines', () => {
        const header = [
            '// @require      https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js',
            '// @require      https://x/dist/libraries/toolasha-core.js',
            '// @require      https://x/dist/libraries/toolasha-actions.js',
            '// @require      https://x/dist/libraries/toolasha-combat.js',
        ].join('\n');
        expect(libraryLoadOrder(header)).toEqual(['core', 'actions', 'combat']);
    });

    test('reads the namespaces in the iife call arguments only', () => {
        const bundle =
            '!function(e,t){const a=window.Toolasha.Combat?.late;}' +
            '(Toolasha.Core.config,Toolasha.Market.marketHistoryAPI,Toolasha.Combat.guildTokenValue);';
        expect([...loadTimeReferences(bundle)].sort()).toEqual(['combat', 'core', 'market']);
    });

    test('flags a bundle that reads a library loading after it — the 3.58.0 break', () => {
        const order = ['core', 'market', 'actions', 'combat', 'ui'];
        const refs = new Map([
            ['actions', new Set(['core', 'market', 'combat'])],
            ['ui', new Set(['core', 'combat'])],
        ]);
        expect(findLoadOrderViolations(order, refs)).toEqual([{ bundle: 'actions', references: 'combat' }]);
    });

    test('passes when every reference is to an earlier library', () => {
        const order = ['core', 'utils', 'combat', 'ui'];
        const refs = new Map([
            ['utils', new Set(['core'])],
            ['ui', new Set(['core', 'utils', 'combat'])],
        ]);
        expect(findLoadOrderViolations(order, refs)).toEqual([]);
    });
});
