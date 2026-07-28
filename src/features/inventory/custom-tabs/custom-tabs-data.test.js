/**
 * Tests for custom tabs loadout binding sync
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../../core/storage.js', () => ({ default: {} }));

const { syncLoadoutBinding, cleanOrphanedBindings, getBaseHrid } = await import('./custom-tabs-data.js');

function buildConfig(tab) {
    return {
        version: 1,
        selectedTabId: null,
        tabs: [{ children: [], ...tab }],
    };
}

describe('getBaseHrid', () => {
    test('strips numeric enhancement suffix', () => {
        expect(getBaseHrid('/items/sword+7')).toBe('/items/sword');
    });

    test('leaves plain hrids untouched', () => {
        expect(getBaseHrid('/items/sword')).toBe('/items/sword');
    });
});

describe('syncLoadoutBinding', () => {
    test('removes an item replaced in the loadout', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/ring_a+5', '/items/hat'],
            loadoutBindings: { Zone1: ['/items/ring_a+5', '/items/hat'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', [
            '/items/ring_b+5',
            '/items/hat',
        ]);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).not.toContain('/items/ring_a+5');
        expect(next.tabs[0].items).toContain('/items/ring_b+5');
    });

    test('keeps a replaced item still referenced by another binding on the tab', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/ring_a+5', '/items/hat'],
            loadoutBindings: {
                Zone1: ['/items/ring_a+5', '/items/hat'],
                Zone2: ['/items/ring_a+5'],
            },
        });

        // Zone1 replaces ring_a with ring_b; Zone2 still uses ring_a
        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', [
            '/items/ring_b+5',
            '/items/hat',
        ]);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/ring_a+5');
        expect(next.tabs[0].items).toContain('/items/ring_b+5');
        expect(next.tabs[0].loadoutBindings.Zone2).toContain('/items/ring_a+5');
    });

    test('keeps an old enhancement level still referenced by another binding', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8'],
            loadoutBindings: {
                Zone1: ['/items/sword+8'],
                Zone2: ['/items/sword+8'],
            },
        });

        // Zone1 bumps the sword to +10; Zone2 still uses the +8
        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/sword+8');
        expect(next.tabs[0].items).toContain('/items/sword+10');
    });

    test('swaps enhancement level in place when no other binding references it', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8'],
            loadoutBindings: { Zone1: ['/items/sword+8'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/sword+10']);
    });

    test('does not duplicate when the new level already exists in the tab', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8', '/items/sword+10'],
            loadoutBindings: { Zone1: ['/items/sword+8'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/sword+10']);
    });

    test('appends items newly added to the loadout', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat'],
            loadoutBindings: { Zone1: ['/items/hat'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/hat', '/items/boots+3']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/boots+3');
        expect(next.tabs[0].loadoutBindings.Zone1).toEqual(['/items/hat', '/items/boots+3']);
    });

    test('reports no change when the snapshot matches the binding', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat'],
            loadoutBindings: { Zone1: ['/items/hat'] },
        });

        const { changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/hat']);

        expect(changed).toBe(false);
    });
});

describe('cleanOrphanedBindings', () => {
    test('removes orphaned binding items unless still bound elsewhere', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat', '/items/ring_a+5'],
            loadoutBindings: {
                Deleted: ['/items/hat', '/items/ring_a+5'],
                Kept: ['/items/hat'],
            },
        });

        const { config: next, changed } = cleanOrphanedBindings(config, 'tab1', new Set(['Kept']));

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/hat']);
        expect(next.tabs[0].loadoutBindings.Deleted).toBeUndefined();
        expect(next.tabs[0].loadoutBindings.Kept).toEqual(['/items/hat']);
    });
});
