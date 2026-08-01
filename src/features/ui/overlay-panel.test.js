import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, clampToViewport: () => null }));

const { registerRow, registeredRows, resolveRows, moveRow } = await import('./overlay-panel.js');

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
