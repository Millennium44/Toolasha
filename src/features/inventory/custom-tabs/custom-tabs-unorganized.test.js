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
