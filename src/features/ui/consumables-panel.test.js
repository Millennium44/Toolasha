/** @vitest-environment happy-dom
 *
 * The one setting the Consumables panel has, and whether it survives a reload.
 *
 * The target duration changes every figure in the panel, so a panel that
 * forgets it does not merely lose a preference — it shows you a day's shortfall
 * when you asked for a week's, and looks right while doing it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getItemDetails: () => null } }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({}) }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {} }),
}));
vi.mock('../../utils/order-book.js', () => ({ estimateFillSeconds: () => null }));
vi.mock('./consumables-shopping-list.js', () => ({ openShoppingList: () => {} }));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({ default: { getLatestData: () => null } }));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({ calculatePlayerStats: () => ({}) }));

const { consumablesPanel } = await import('./consumables-panel.js');
const { wasOpen } = await import('../../utils/panel-geometry.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    store.data = {};
    consumablesPanel.hide({ remember: false });
    consumablesPanel.targetIndex = 1;
});

describe('the target duration', () => {
    test('a chosen target is written down', async () => {
        consumablesPanel.targetIndex = 3;
        consumablesPanel._saveSettings();
        await settled();

        expect(store.data.consumablesSettings).toEqual({ targetSeconds: 7 * 86400 });
    });

    test('and read back, so the panel opens on the one you picked', async () => {
        store.data.consumablesSettings = { targetSeconds: 8 * 3600 };

        await consumablesPanel.loadSettings();

        expect(consumablesPanel.target.label).toBe('8 hours');
    });

    test('nothing stored leaves the default alone', async () => {
        await consumablesPanel.loadSettings();

        expect(consumablesPanel.target.label).toBe('1 day');
    });

    test('a target the list no longer has does not blank it', async () => {
        // The list is code; a stored value from an older one must not win
        store.data.consumablesSettings = { targetSeconds: 999 };

        await consumablesPanel.loadSettings();

        expect(consumablesPanel.target.label).toBe('1 day');
    });
});

describe('whether the panel was open', () => {
    test('opening it is remembered', async () => {
        consumablesPanel.show();
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(true);
    });

    test('and closing it is', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel.hide();
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(false);
    });

    test('going to the marketplace is not closing it', async () => {
        // The panel gets out of the way so the marketplace is not underneath it.
        // You went shopping; you did not put the panel away.
        consumablesPanel.show();
        await settled();
        consumablesPanel._openShoppingList([]);
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(true);
    });
});
