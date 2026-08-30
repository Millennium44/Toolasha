/**
 * @vitest-environment happy-dom
 *
 * The Unorganized bucket collects every tile no tab claimed. A tile is
 * registered in the tile map under both its base hrid and its enhanced
 * `hrid+level` key, so an unassigned enhanced item is reachable through two keys
 * — and used to be collected through both, double-counting it in the
 * "Unorganized (N)" header and placing it twice. This pins the dedupe (upstream
 * Celasha/Toolasha#627).
 */

import { describe, test, expect, vi } from 'vitest';

// The method under test only reads `this._config` (through the real, pure
// getAssignedItemSet) and each tile's DOM, so the class's heavy singleton
// imports are stubbed just enough for the module to load.
vi.mock('../../../core/config.js', () => ({ default: {} }));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));
vi.mock('../inventory-sort.js', () => ({ default: {} }));
vi.mock('../inventory-badge-manager.js', () => ({ default: {} }));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');
const { getAssignedItemSet } = await import('./custom-tabs-data.js');

/** A DOM tile carrying an item name and, optionally, an enhancement badge */
function tile(name, level = 0) {
    const el = document.createElement('div');
    el.className = 'Item_itemContainer__abc';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-label', name);
    el.appendChild(svg);
    if (level > 0) {
        const badge = document.createElement('div');
        badge.className = 'Item_enhancementLevel__xyz';
        badge.textContent = `+${level}`;
        el.appendChild(badge);
    }
    return el;
}

/** Invoke the method with a minimal `this` — no full instance needed */
function collect(tileMap, config = { tabs: [] }) {
    return CustomTabsUI.prototype._collectUnassignedTileEntries.call({ _config: config }, tileMap);
}

/**
 * A stand-in for one layout pass: seed the assigned-hrid set the way
 * `_applyLayoutSync` does, let each tab claim in top-to-bottom order, then
 * collect whatever no tab took.
 */
function layout(tileMap, config) {
    const ctx = { _config: config, _assignedHrids: getAssignedItemSet(config) };
    const claimed = new Map();
    const walk = (tabs) => {
        for (const tab of tabs) {
            const tiles = [];
            for (const hrid of tab.items) {
                tiles.push(...CustomTabsUI.prototype._claimTilesForHrid.call(ctx, hrid, tileMap));
            }
            claimed.set(tab.id, tiles);
            walk(tab.children || []);
        }
    };
    walk(config.tabs);
    return { claimed, unorganized: collect(tileMap, config) };
}

describe('_collectUnassignedTileEntries dedupe', () => {
    test('an unassigned enhanced tile registered under both keys is counted once', () => {
        // buildTileMap registers an enhanced tile under its base key first, then
        // its enhanced key — the exact double-registration that was double-counted.
        const enhanced = tile('Sword', 3);
        const tileMap = new Map([
            ['/items/sword', [enhanced]],
            ['/items/sword+3', [enhanced]],
        ]);

        const entries = collect(tileMap);
        const total = entries.reduce((sum, e) => sum + e.tiles.length, 0);

        expect(total).toBe(1);
        // It stays grouped under the base key (inserted first)
        expect(entries).toHaveLength(1);
        expect(entries[0].hrid).toBe('/items/sword');
    });

    test('an enhanced copy of an assigned base item belongs to that tab, not Unorganized', () => {
        // `_buildTileMap` registers every enhanced tile under its `+N` key
        // whether or not any tab asked for that level, and the base-hrid claim
        // treated that registration as a reservation by "a tab that specifically
        // requested that level". No tab requested it here, so the +3 sword was
        // withheld from the tab that assigned the base hrid — which is documented
        // to claim all enhancement levels — and shown under Unorganized instead.
        const enhanced = tile('Sword', 3);
        const tileMap = new Map([
            ['/items/sword', [enhanced]],
            ['/items/sword+3', [enhanced]],
        ]);
        const cfg = { tabs: [{ id: 'gear', items: ['/items/sword'], children: [] }] };

        const { claimed, unorganized } = layout(tileMap, cfg);

        expect(claimed.get('gear')).toEqual([enhanced]);
        expect(unorganized).toEqual([]);
    });

    test('a tab that names the level still outranks one that names the base', () => {
        // The reservation exists for this: a lower tab asking for +3 by name beats
        // an upper tab asking for the base. That has to keep working.
        const plain = tile('Sword');
        const enhanced = tile('Sword', 3);
        const tileMap = new Map([
            ['/items/sword', [plain, enhanced]],
            ['/items/sword+3', [enhanced]],
        ]);
        const cfg = {
            tabs: [
                { id: 'gear', items: ['/items/sword'], children: [] },
                { id: 'boss', items: ['/items/sword+3'], children: [] },
            ],
        };

        const { claimed, unorganized } = layout(tileMap, cfg);

        expect(claimed.get('gear')).toEqual([plain]);
        expect(claimed.get('boss')).toEqual([enhanced]);
        expect(unorganized).toEqual([]);
    });

    test('a tile claimed through its base key is not collected again through its +N key', () => {
        // The enhanced branch drops claimed tiles from the base key; the base
        // branch has to do the mirror image, or the same physical tile is placed
        // once by its tab and once by the Unorganized bucket, which wins on order.
        const enhanced = tile('Sword', 3);
        const tileMap = new Map([
            ['/items/sword', [enhanced]],
            ['/items/sword+3', [enhanced]],
        ]);
        const cfg = { tabs: [{ id: 'gear', items: ['/items/sword'], children: [] }] };

        layout(tileMap, cfg);

        expect([...tileMap.keys()]).toEqual([]);
    });

    test('distinct tiles are all kept', () => {
        const plain = tile('Cheese');
        const enhanced = tile('Sword', 3);
        const tileMap = new Map([
            ['/items/cheese', [plain]],
            ['/items/sword', [enhanced]],
            ['/items/sword+3', [enhanced]],
        ]);

        const total = collect(tileMap).reduce((sum, e) => sum + e.tiles.length, 0);

        expect(total).toBe(2);
    });
});
