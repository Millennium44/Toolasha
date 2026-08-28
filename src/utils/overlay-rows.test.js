import { describe, test, expect } from 'vitest';

import {
    registerRow,
    registeredRows,
    resolveRows,
    moveRow,
    tileClassFor,
    emptyPolicyFor,
    compactLabel,
    CURATED_ROWS,
    TILE_CLASS,
    EMPTY_POLICY,
} from './overlay-rows.js';

const row = (key, defaultVisible = true) => ({ key, name: key, render: () => {}, defaultVisible });

describe('registerRow', () => {
    test('takes a row and hands it back', () => {
        registerRow({ key: 'alpha', name: 'Alpha', render: () => {} });
        expect(registeredRows().some((r) => r.key === 'alpha')).toBe(true);
    });

    test('registering the same key twice replaces rather than duplicates', () => {
        // A feature that re-initialises must not end up drawn twice
        registerRow({ key: 'beta', name: 'First', render: () => {} });
        registerRow({ key: 'beta', name: 'Second', render: () => {} });

        const matches = registeredRows().filter((r) => r.key === 'beta');
        expect(matches).toHaveLength(1);
        expect(matches[0].name).toBe('Second');
    });

    test('refuses a row that cannot be drawn', () => {
        const before = registeredRows().length;
        registerRow({ key: 'broken' });
        registerRow({ name: 'no key', render: () => {} });
        expect(registeredRows()).toHaveLength(before);
    });
});

describe('resolveRows', () => {
    const available = [row('a'), row('b'), row('c')];

    test('follows the saved order', () => {
        const resolved = resolveRows(available, { order: ['c', 'a', 'b'], visible: {} });
        expect(resolved.map((r) => r.key)).toEqual(['c', 'a', 'b']);
    });

    test('a row the saved order has never heard of goes to the end, not missing', () => {
        // This is what happens to every row added by an update
        const resolved = resolveRows(available, { order: ['b'], visible: {} });
        expect(resolved.map((r) => r.key)).toEqual(['b', 'a', 'c']);
    });

    test('a saved key for a row that no longer exists leaves no hole', () => {
        const resolved = resolveRows(available, { order: ['a', 'gone', 'b', 'c'], visible: {} });
        expect(resolved.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    });

    test('visibility comes from settings, falling back to the row default', () => {
        const rows = [row('on', true), row('off', false)];
        const resolved = resolveRows(rows, { order: [], visible: { on: false } });
        expect(resolved.find((r) => r.key === 'on').visible).toBe(false);
        expect(resolved.find((r) => r.key === 'off').visible).toBe(false);
    });

    test('a row explicitly switched on beats a default of off', () => {
        const resolved = resolveRows([row('x', false)], { order: [], visible: { x: true } });
        expect(resolved[0].visible).toBe(true);
    });

    test('survives no settings at all', () => {
        expect(resolveRows(available, null).map((r) => r.key)).toEqual(['a', 'b', 'c']);
    });
});

describe('resolveRows with curated defaults', () => {
    const available = [row('netWorth'), row('dps'), row('luck'), row('coins')];
    const curated = { order: [], visible: {}, curatedDefaults: true };

    test('a character who has never arranged anything gets the curated set only', () => {
        const on = resolveRows(available, curated)
            .filter((r) => r.visible)
            .map((r) => r.key);
        // Of this fixture's rows, all four are curated (netWorth/coins in Wealth,
        // dps/luck in the session cluster), and nothing outside the set turns on
        expect(on.sort()).toEqual(['coins', 'dps', 'luck', 'netWorth']);
    });

    test('and gets them in the curated order, whatever order they registered in', () => {
        const shuffled = [row('coins'), row('dps'), row('netWorth')];
        const order = resolveRows(shuffled, curated).map((r) => r.key);
        expect(order.indexOf('netWorth')).toBeLessThan(order.indexOf('coins'));
        expect(order.indexOf('coins')).toBeLessThan(order.indexOf('dps'));
    });

    test('an explicit choice still beats the curated set, both ways round', () => {
        const settings = { ...curated, visible: { dps: true, netWorth: false } };
        const resolved = resolveRows(available, settings);
        expect(resolved.find((r) => r.key === 'dps').visible).toBe(true);
        expect(resolved.find((r) => r.key === 'netWorth').visible).toBe(false);
    });

    test('without the flag every row falls back to its own default, as it always did', () => {
        // Which is what an existing player's saved settings look like
        const resolved = resolveRows(available, { order: [], visible: {} });
        expect(resolved.every((r) => r.visible)).toBe(true);
    });

    test('a saved order is left alone rather than resorted into curated order', () => {
        const settings = { ...curated, order: ['luck', 'coins', 'dps', 'netWorth'] };
        expect(resolveRows(available, settings).map((r) => r.key)).toEqual(['luck', 'coins', 'dps', 'netWorth']);
    });

    test('the curated set stays small enough to be read at a glance', () => {
        // The wall the curated set guards against is a wall of *value* tiles —
        // the ones that always draw. Those are what has to stay few. Measurements
        // hide until they have data, so a handful of session figures can ride in
        // the set without a fresh character ever seeing them as placeholders.
        const alwaysOn = CURATED_ROWS.filter((key) => tileClassFor({ key }) === TILE_CLASS.VALUE);
        expect(alwaysOn.length).toBeLessThanOrEqual(6);
        expect(CURATED_ROWS.length).toBeGreaterThanOrEqual(6);
        expect(CURATED_ROWS.length).toBeLessThanOrEqual(12);
        expect(new Set(CURATED_ROWS).size).toBe(CURATED_ROWS.length);
    });
});

describe('what a tile does when it has drawn nothing', () => {
    test('it keeps its slot and shrinks to its name, measurement or not', () => {
        // Tiles sit in a grid with saved positions, and a tile that goes away
        // does not take its slot with it — it leaves a hole in the line
        expect(tileClassFor({ key: 'dps' })).toBe(TILE_CLASS.MEASUREMENT);
        expect(emptyPolicyFor({ key: 'dps' })).toBe(EMPTY_POLICY.COMPACT);
        expect(tileClassFor({ key: 'coins' })).toBe(TILE_CLASS.VALUE);
        expect(emptyPolicyFor({ key: 'coins' })).toBe(EMPTY_POLICY.COMPACT);
    });

    test('a watch tile only says so when there is somewhere to click', () => {
        expect(emptyPolicyFor({ key: 'watchlist', onOpen: () => {} })).toBe(EMPTY_POLICY.COMPACT);
        expect(emptyPolicyFor({ key: 'equipmentWatch' })).toBe(EMPTY_POLICY.HIDE);
    });

    test('a compact tile says its own name, never its placeholder', () => {
        // Two tiles are allowed to be idle in the same words; their names are
        // the one thing that is theirs
        const watchlist = { key: 'watchlist', name: 'Watchlist', empty: 'Nothing watched', onOpen: () => {} };
        const equipment = { key: 'equipmentWatch', name: 'Equipment Watch', empty: 'Nothing watched' };
        expect(compactLabel(watchlist)).not.toBe(compactLabel(equipment));
        expect(compactLabel(equipment)).toBe('Equipment Watch');
    });

    test('a nameless row falls back to its key rather than to nothing', () => {
        expect(compactLabel({ key: 'mystery' })).toBe('mystery');
    });

    test('a row may declare its own class and its own answer', () => {
        expect(tileClassFor({ key: 'dps', tileClass: TILE_CLASS.WATCH })).toBe(TILE_CLASS.WATCH);
        expect(tileClassFor({ key: 'dps', tileClass: 'nonsense' })).toBe(TILE_CLASS.MEASUREMENT);
        expect(emptyPolicyFor({ key: 'coins', whenEmpty: EMPTY_POLICY.HIDE })).toBe(EMPTY_POLICY.HIDE);
    });

    test('the panel setting is the last word', () => {
        for (const setting of [EMPTY_POLICY.HIDE, EMPTY_POLICY.COMPACT, EMPTY_POLICY.FULL]) {
            expect(emptyPolicyFor({ key: 'dps' }, setting)).toBe(setting);
        }
        expect(emptyPolicyFor({ key: 'dps' }, 'nonsense')).toBe(EMPTY_POLICY.COMPACT);
    });

    test('registerRow carries a row’s own class and answer through', () => {
        registerRow({
            key: 'declared',
            name: 'Declared',
            render: () => {},
            tileClass: TILE_CLASS.WATCH,
            whenEmpty: EMPTY_POLICY.FULL,
        });
        const found = registeredRows().find((r) => r.key === 'declared');
        expect(emptyPolicyFor(found)).toBe(EMPTY_POLICY.FULL);
        expect(tileClassFor(found)).toBe(TILE_CLASS.WATCH);
    });
});

describe('moveRow', () => {
    test('moves a key up and down', () => {
        expect(moveRow(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
        expect(moveRow(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    });

    test('will not move past either end', () => {
        const order = ['a', 'b', 'c'];
        expect(moveRow(order, 'a', -1)).toBe(order);
        expect(moveRow(order, 'c', 1)).toBe(order);
    });

    test('ignores a key that is not in the order', () => {
        const order = ['a', 'b'];
        expect(moveRow(order, 'zzz', 1)).toBe(order);
    });

    test('leaves the order it was given alone', () => {
        const order = ['a', 'b', 'c'];
        moveRow(order, 'a', 1);
        expect(order).toEqual(['a', 'b', 'c']);
    });
});
