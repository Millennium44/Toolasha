/** @vitest-environment happy-dom */
/**
 * The three alchemy history modals share one type scale.
 *
 * They used to carry 11px, 13px, 14px, 16px and 24px inline on different
 * elements with no relationship between them, while the session table and the
 * totals table simply inherited whatever size the page handed them — so a
 * footnote sat five pixels below body text and the panel read as three
 * unrelated things stacked. This pins the result: table text is body size in
 * every one of them, and none of the three quietly drifts back.
 *
 * It also exercises the case the viewers' own tests create by accident — a
 * modal with no totals container. `renderTable` now calls `renderTotals`, and a
 * partial modal must not take the whole table down with it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { HISTORY_TYPE_SCALE } from './history-totals-table.js';

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
}));
vi.mock('./coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
}));
vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 100,
    getItemPriceInfo: () => ({ price: 100, source: 'book', estimated: false }),
    getItemPrices: () => ({ ask: 100, bid: 100, average: 100 }),
    getPricingMode: () => 'ask',
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (itemHrid) => ({
            name: itemHrid.split('/').pop(),
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [], transmuteDropTable: [] },
        }),
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');
const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');

const PANELS = [
    { name: 'transmute', viewer: transmuteHistoryViewer, slug: 'transmute' },
    { name: 'coinify', viewer: coinifyHistoryViewer, slug: 'coinify' },
    { name: 'decompose', viewer: decomposeHistoryViewer, slug: 'decompose' },
];

/**
 * The hosts `renderTable` queries for by class — deliberately WITHOUT a totals
 * container, so the missing-host path is exercised as well.
 * @param {string} slug
 */
function buildModal(slug) {
    const modal = document.createElement('div');
    modal.innerHTML = `
        <div class="mwi-${slug}-history-controls"></div>
        <div class="mwi-${slug}-history-badges"></div>
        <div class="mwi-${slug}-history-table-container"></div>
        <div class="mwi-${slug}-history-pagination"></div>
    `;
    document.body.appendChild(modal);
    return modal;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe.each(PANELS)('$name history modal type scale', ({ viewer, slug }) => {
    beforeEach(() => {
        viewer.modal = buildModal(slug);
        viewer.sessions = [];
        viewer.filteredSessions = [];
        viewer.profitCache = new Map();
        viewer.filters = { dateFrom: null, dateTo: null, selectedInputItems: [], resultsSearch: '' };
    });

    test('renders with no totals container rather than taking the table down with it', () => {
        expect(() => viewer.renderTable()).not.toThrow();
        expect(viewer.modal.querySelector(`.mwi-${slug}-history-table-container table`)).not.toBeNull();
    });

    test('the session table is body size, not whatever the page happened to inherit', () => {
        viewer.renderTable();

        const table = viewer.modal.querySelector(`.mwi-${slug}-history-table-container table`);
        expect(table.style.fontSize).toBe(HISTORY_TYPE_SCALE.body);
    });

    test('the session-count line sits on the same body size as the table it describes', () => {
        viewer.renderTable();

        const stats = viewer.modal.querySelector(`.mwi-${slug}-history-controls span`);
        expect(stats.style.fontSize).toBe(HISTORY_TYPE_SCALE.body);
    });
});
