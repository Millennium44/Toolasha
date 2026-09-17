/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach } from 'vitest';
import { transmuteHistoryViewer } from './transmute-history-viewer.js';

/**
 * Builds the minimal modal DOM renderTable() expects: the table container,
 * controls, badges and pagination hosts it queries for by class.
 * @returns {HTMLElement}
 */
function buildModal() {
    const modal = document.createElement('div');
    modal.innerHTML = `
        <div class="mwi-transmute-history-controls"></div>
        <div class="mwi-transmute-history-badges"></div>
        <div class="mwi-transmute-history-table-container"></div>
        <div class="mwi-transmute-history-totals-container"></div>
        <div class="mwi-transmute-history-pagination"></div>
    `;
    document.body.appendChild(modal);
    return modal;
}

describe('transmute history viewer - icon-only control accessibility', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        transmuteHistoryViewer.modal = buildModal();
        transmuteHistoryViewer.sessions = [];
        transmuteHistoryViewer.filteredSessions = [];
        transmuteHistoryViewer.filters = {
            dateFrom: null,
            dateTo: null,
            selectedInputItems: [],
            resultsSearch: '',
        };
    });

    // Unlike decompose/coinify history, this viewer's column headers are all
    // plain text (no icon-only catalyst columns) - nothing to fix here, but the
    // per-row delete button has the same icon-only shape as the other two viewers.
    test('per-row delete button exposes an accessible name matching its tooltip', () => {
        const session = {
            id: 's1',
            startTime: Date.now(),
            inputItemHrid: '/items/coin',
            totalAttempts: 10,
            totalSuccesses: 5,
        };
        transmuteHistoryViewer.sessions = [session];
        transmuteHistoryViewer.filteredSessions = [session];
        // Pre-seed the profit cache so renderTable doesn't need to recompute
        // profit from full market/pricing data for this row.
        transmuteHistoryViewer.profitCache.set(session.id, {
            profit: 10,
            revenue: 100,
            inputUnpriced: true,
            netConsumed: 1,
            coinCost: 0,
            catalystEntries: [],
            catalystUnrecorded: false,
            catalystEstimated: false,
        });

        transmuteHistoryViewer.renderTable();

        const deleteBtn = transmuteHistoryViewer.modal.querySelector('tbody button[aria-label="Delete this session"]');
        expect(deleteBtn).not.toBeNull();
        expect(deleteBtn.title).toBe('Delete this session');
    });
});
