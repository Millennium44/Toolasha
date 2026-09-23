/**
 * Sessions recorded before the 2026-09-23 tracker fixes carry no
 * `trackerVersion` stamp. All three history windows mark them in the session
 * list, and the totals table can leave them out behind a checkbox that
 * defaults to including them and is remembered per window.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const INPUT_HRID = '/items/gem';
const OUTPUT_HRID = '/items/dust';

const mocks = vi.hoisted(() => ({ stored: new Map() }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (mocks.stored.has(key) ? mocks.stored.get(key) : fallback),
        set: async (key, value) => {
            mocks.stored.set(key, value);
            return true;
        },
    },
}));

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { loadSessions: async () => [] },
}));
vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { loadSessions: async () => [] },
}));
vi.mock('./coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: { loadSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => {
    const prices = { '/items/gem': 1000, '/items/dust': 300 };
    return {
        getItemPrice: (hrid) => prices[hrid] ?? null,
        getItemPriceInfo: (hrid) => ({ price: prices[hrid] ?? null, source: 'book', estimated: false }),
        getItemPrices: () => null,
        getPricingMode: () => 'ask',
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (hrid) =>
            hrid === '/items/gem'
                ? {
                      name: 'Gem',
                      itemLevel: 10,
                      sellPrice: 1000,
                      alchemyDetail: {
                          bulkMultiplier: 1,
                          decomposeItems: [{ itemHrid: '/items/dust', count: 1 }],
                      },
                  }
                : { name: hrid.split('/').pop() },
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');
const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');
const { PRE_FIX_MARKER } = await import('./alchemy-pre-fix-sessions.js');

/**
 * @param {string} id
 * @param {number} attempts
 * @param {boolean} stamped - Whether the session was recorded after the fix
 * @returns {Object} A session every window can read
 */
function session(id, attempts, stamped) {
    return {
        id,
        startTime: Date.UTC(2026, 8, 20) + attempts,
        inputItemHrid: INPUT_HRID,
        enhancementLevel: 0,
        bulkMultiplier: 1,
        totalAttempts: attempts,
        totalSuccesses: attempts,
        totalCoinsEarned: attempts * 500,
        results: { [OUTPUT_HRID]: { count: attempts, totalValue: attempts * 300, priceEach: 300 } },
        catalystsUsed: {},
        catalystOfDecompositionUsed: 0,
        catalystOfCoinificationUsed: 0,
        primeCatalystUsed: 0,
        ...(stamped ? { trackerVersion: 2 } : {}),
    };
}

const VIEWERS = [
    ['transmute', transmuteHistoryViewer],
    ['decompose', decomposeHistoryViewer],
    ['coinify', coinifyHistoryViewer],
];

/**
 * Draw a viewer's modal over the given sessions.
 * @param {Object} viewer
 * @param {Array<Object>} sessions
 */
function draw(viewer, sessions) {
    viewer.sessions = sessions;
    viewer.profitCache.clear();
    if (!viewer.modal) viewer.createModal();
    viewer.applyFilters();
    viewer.renderTable();
}

/**
 * @param {Object} viewer
 * @returns {HTMLElement} The totals container
 */
function totalsContainer(viewer) {
    return viewer.modal.querySelector('[class$="-history-totals-container"]');
}

/**
 * The "All items" row's Attempts cell, as a number.
 * @param {Object} viewer
 * @returns {number}
 */
function allItemsAttempts(viewer) {
    const rows = Array.from(totalsContainer(viewer).querySelectorAll('tbody tr'));
    const overall = rows.find((row) => row.cells[0].textContent.includes('All items'));
    return Number(overall.cells[2].textContent);
}

beforeEach(() => {
    mocks.stored.clear();
});

afterEach(() => {
    for (const [, viewer] of VIEWERS) {
        viewer.includePreFix = true;
        viewer.modal?.remove();
        viewer.modal = null;
    }
});

describe.each(VIEWERS)('%s history: sessions recorded before the tracker fix', (kind, viewer) => {
    test('only an unstamped session carries the marker', () => {
        draw(viewer, [session('old', 3, false), session('new', 5, true)]);

        const rows = Array.from(viewer.modal.querySelectorAll('.mwi-' + kind + '-history-table-container tbody tr'));
        const marked = rows.filter((row) => row.querySelector('.mwi-alchemy-pre-fix-marker'));
        expect(marked).toHaveLength(1);
        expect(marked[0].cells[0].textContent).toContain(PRE_FIX_MARKER);
        expect(marked[0].querySelector('.mwi-alchemy-pre-fix-marker').title).toContain('2026-09-23');
    });

    test('the legend explains the marker', () => {
        draw(viewer, [session('old', 3, false)]);
        expect(totalsContainer(viewer).textContent).toContain(`${PRE_FIX_MARKER} recorded before the 2026-09-23`);
    });

    test('totals include pre-fix sessions by default', async () => {
        viewer.includePreFix = await (await import('./alchemy-pre-fix-sessions.js')).loadIncludePreFix(kind);
        draw(viewer, [session('old', 3, false), session('new', 5, true)]);

        const checkbox = totalsContainer(viewer).querySelector('.mwi-alchemy-pre-fix-toggle input');
        expect(checkbox.checked).toBe(true);
        expect(allItemsAttempts(viewer)).toBe(8);
    });

    test('unticked, totals sum only the stamped sessions, and the list still shows both', () => {
        draw(viewer, [session('old', 3, false), session('new', 5, true), session('new2', 7, true)]);
        const checkbox = totalsContainer(viewer).querySelector('.mwi-alchemy-pre-fix-toggle input');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change'));

        expect(allItemsAttempts(viewer)).toBe(12);
        const included = viewer.computeInputItemTotals();
        expect(included.reduce((sum, group) => sum + group.attempts, 0)).toBe(12);
        expect(included.reduce((sum, group) => sum + group.sessionCount, 0)).toBe(2);
        expect(viewer.modal.querySelectorAll('.mwi-' + kind + '-history-table-container tbody tr')).toHaveLength(3);
        expect(mocks.stored.get(`alchemyHistory_includePreFix_${kind}`)).toBe(false);
        expect(totalsContainer(viewer).textContent).not.toMatch(/NaN|undefined|Infinity/);
    });

    test('unticked with only pre-fix sessions, the totals show an empty state and keep the box', () => {
        viewer.includePreFix = false;
        draw(viewer, [session('old', 3, false)]);

        const container = totalsContainer(viewer);
        expect(container.querySelector('.mwi-alchemy-totals-empty').textContent).toContain('tick the box');
        expect(container.querySelector('.mwi-alchemy-pre-fix-toggle input').checked).toBe(false);
        expect(container.querySelector('table')).toBeNull();
        expect(container.textContent).not.toMatch(/NaN|undefined|Infinity/);
    });

    test('no toggle when nothing in view predates the fix', () => {
        draw(viewer, [session('new', 5, true)]);
        expect(totalsContainer(viewer).querySelector('.mwi-alchemy-pre-fix-toggle')).toBeNull();
    });
});
