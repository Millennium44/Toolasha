/**
 * A history window torn down (character switch, feature off) with a column
 * filter popup open removed its modal but left the popup — appended to the
 * page body, not the modal — on screen, and its document click listener
 * attached.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

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

describe.each([
    ['transmute', transmuteHistoryViewer],
    ['decompose', decomposeHistoryViewer],
    ['coinify', coinifyHistoryViewer],
])('%s history: disabling with a filter popup open', (_kind, viewer) => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('removes the popup and its document click listener', () => {
        vi.useFakeTimers();
        viewer.sessions = [];
        viewer.createModal();
        viewer.applyFilters();
        viewer.renderTable();

        const button = document.createElement('button');
        document.body.appendChild(button);
        viewer.showFilterPopup('startTime', button);
        vi.advanceTimersByTime(20);
        const popup = viewer.activeFilterPopup;
        const handler = viewer.popupCloseHandler;
        expect(document.body.contains(popup)).toBe(true);

        const removeSpy = vi.spyOn(document, 'removeEventListener');
        viewer.disable();

        expect(document.body.contains(popup)).toBe(false);
        expect(removeSpy).toHaveBeenCalledWith('click', handler);
        expect(viewer.popupCloseHandler).toBeNull();
        removeSpy.mockRestore();
        button.remove();
    });
});

describe.each([
    ['transmute', transmuteHistoryViewer],
    ['decompose', decomposeHistoryViewer],
    ['coinify', coinifyHistoryViewer],
])('%s history: opening while being torn down', (_kind, viewer) => {
    test('draws no modal once the window has been disabled mid-load', async () => {
        viewer.isInitialized = true;
        const opening = viewer.openModal();
        viewer.disable();
        await opening;

        expect(viewer.modal).toBeNull();
        expect(document.querySelector('[class$="-history-modal"]')).toBeNull();
    });

    test('draws the modal when still initialized', async () => {
        viewer.isInitialized = true;
        await viewer.openModal();

        expect(viewer.modal).not.toBeNull();
        viewer.disable();
    });
});
