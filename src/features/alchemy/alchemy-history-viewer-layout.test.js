/**
 * The Alchemy History window fits a phone-width screen, whichever type's pane
 * is in it.
 *
 * Each of the three windows it replaced was `min-width: 500px` under `max-width: 95vw`; a min-width beats a
 * max-width, so on a ~390px phone the dialog was 540px wide with its padding
 * and the overlay's `align-items: center` hung it off both edges (left edge
 * -75px), where nothing can scroll to the clipped part. happy-dom does no
 * layout, so this pins the declarations; the fit was measured in Firefox,
 * Chromium and WebKit at 360 and 390px wide, and 1280px unchanged.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => true },
}));
vi.mock('./transmute-history-tracker.js', () => ({ transmuteHistoryTracker: { loadSessions: async () => [] } }));
vi.mock('./decompose-history-tracker.js', () => ({ decomposeHistoryTracker: { loadSessions: async () => [] } }));
vi.mock('./coinify-history-tracker.js', () => ({ coinifyHistoryTracker: { loadSessions: async () => [] } }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => {
    return {
        getItemPrice: () => null,
        getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
        getItemPrices: () => null,
        getPricingMode: () => 'ask',
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (hrid) => ({
            name: hrid.split('/').pop(),
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/dust', count: 1 }] },
        }),
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');
const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');
const { alchemyHistoryViewer } = await import('./alchemy-history-viewer.js');

describe.each([
    ['transmute', transmuteHistoryViewer],
    ['decompose', decomposeHistoryViewer],
    ['coinify', coinifyHistoryViewer],
])('%s history window on a phone-width screen', (kind, viewer) => {
    test('has no fixed min-width wider than a phone; both bounds leave room for padding', () => {
        viewer.createModal();
        const content = viewer.modal.closest('.mwi-alchemy-history-content');
        expect(content).not.toBeNull();
        expect(alchemyHistoryViewer.modal.contains(viewer.modal)).toBe(true);
        expect(viewer.modal.closest(`.mwi-${kind}-history-pane`)).toBe(viewer.modal);
        // 500px stays the floor on a desktop, but only while the screen has room for it.
        expect(content.style.minWidth).toBe('min(500px, calc(100% - 56px))');
        expect(content.style.maxWidth).toBe('min(95vw, calc(100% - 56px))');
        viewer.modal.remove();
        viewer.modal = null;
        alchemyHistoryViewer.unregister(kind);
    });
});
