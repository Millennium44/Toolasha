/** @vitest-environment happy-dom
 *
 * The per-item ask and bid badges follow the Toolasha text size and font through the custom properties
 * text-appearance publishes, so a settings change restyles them without a re-render.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_INVBADGE_ASK: '#0f0',
        COLOR_INVBADGE_BID: '#f00',
        getSetting: () => false,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('./inventory-badge-manager.js', () => ({ default: {} }));
vi.mock('./inventory-sort.js', () => ({ default: {} }));

const { default: inventoryBadgePrices } = await import('./inventory-badge-prices.js');

describe('InventoryBadgePrices.renderPriceBadge text appearance', () => {
    test.each(['ask', 'bid'])('the %s badge reads the zoom (capped) and font variables', (type) => {
        const tile = document.createElement('div');
        const inner = document.createElement('div');
        inner.className = 'Item_item__abc';
        tile.appendChild(inner);
        document.body.appendChild(tile);

        inventoryBadgePrices.renderPriceBadge(tile, 1200, type);

        const css = tile.querySelector(`.mwi-badge-price-${type}`).style.cssText;
        expect(css).toContain('--toolasha-text-zoom, 1');
        expect(css).toContain('min(');
        // Two badges share the row, so they never grow past their size at 100%
        expect(css).toMatch(/min\(var\(--toolasha-text-zoom, 1\),\s*1\)/);
        expect(css).toContain('--toolasha-font-stack');
        tile.remove();
    });
});
