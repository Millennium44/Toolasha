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

    test('Catalyst of Transmutation and Prime Catalyst column headers expose their label as an accessible name', () => {
        transmuteHistoryViewer.renderTable();

        const headers = Array.from(transmuteHistoryViewer.modal.querySelectorAll('thead th'));
        // Column order: Session Start, Input Item, Attempts, Successes, Expected, Results,
        // Catalyst of Transmutation, Prime Catalyst, Profit, (delete)
        const catalystHeader = headers[6];
        const primeCatalystHeader = headers[7];

        expect(catalystHeader.getAttribute('aria-label')).toBe('Catalyst of Transmutation');
        expect(catalystHeader.title).toBe('Catalyst of Transmutation');
        expect(catalystHeader.textContent.trim()).toBe('');

        expect(primeCatalystHeader.getAttribute('aria-label')).toBe('Prime Catalyst');
        expect(primeCatalystHeader.title).toBe('Prime Catalyst');
        expect(primeCatalystHeader.textContent.trim()).toBe('');
    });

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

describe('transmute history viewer - catalyst and expected columns', () => {
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

    function seedSession(id, detail) {
        const session = {
            id,
            startTime: Date.now(),
            inputItemHrid: '/items/coin',
            totalAttempts: 10,
            totalSuccesses: 6,
            predictedRate: detail.predictedRate,
        };
        transmuteHistoryViewer.sessions.push(session);
        transmuteHistoryViewer.filteredSessions.push(session);
        transmuteHistoryViewer.profitCache.set(id, {
            profit: 10,
            revenue: 100,
            inputUnpriced: false,
            netConsumed: 1,
            coinCost: 0,
            catalystEntries: detail.catalystEntries || [],
            catalystUnrecorded: detail.catalystUnrecorded || false,
            catalystEstimated: detail.catalystEstimated || false,
        });
        return session;
    }

    test('renders a recorded catalyst count with its icon', () => {
        seedSession('s1', {
            catalystEntries: [{ hrid: '/items/catalyst_of_transmutation', count: 6, cost: 60, unpriced: false }],
        });

        transmuteHistoryViewer.renderTable();

        const cells = transmuteHistoryViewer.modal.querySelectorAll('tbody tr')[0].querySelectorAll('td');
        // Session Start, Input Item, Attempts, Successes, Expected, Results, Catalyst of Transmutation, ...
        const catalystCell = cells[6];
        expect(catalystCell.textContent).toContain('6');
        expect(catalystCell.textContent).not.toContain('NaN');
        expect(catalystCell.textContent).not.toContain('undefined');
    });

    test('renders a dash for a catalyst that was not used this session', () => {
        seedSession('s1', {
            catalystEntries: [{ hrid: '/items/catalyst_of_transmutation', count: 6, cost: 60, unpriced: false }],
        });

        transmuteHistoryViewer.renderTable();

        const cells = transmuteHistoryViewer.modal.querySelectorAll('tbody tr')[0].querySelectorAll('td');
        const primeCatalystCell = cells[7]; // no entry for prime catalyst
        expect(primeCatalystCell.textContent).toBe('—');
    });

    test('renders a dash with an "unrecorded" tooltip for a session that predates catalyst tracking', () => {
        seedSession('s1', { catalystEntries: [], catalystUnrecorded: true });

        transmuteHistoryViewer.renderTable();

        const cells = transmuteHistoryViewer.modal.querySelectorAll('tbody tr')[0].querySelectorAll('td');
        const catalystCell = cells[6];
        expect(catalystCell.textContent).toBe('—');
        expect(catalystCell.querySelector('span').title).toMatch(/unknown, not zero/);
    });

    test('Expected column shows attempts × predicted rate and the delta', () => {
        seedSession('s1', { predictedRate: 0.6, catalystEntries: [] });

        transmuteHistoryViewer.renderTable();

        const cells = transmuteHistoryViewer.modal.querySelectorAll('tbody tr')[0].querySelectorAll('td');
        const expectedCell = cells[4]; // Session Start, Input Item, Attempts, Successes, Expected
        // 10 attempts x 0.6 = 6.0 expected; 6 actual successes => +0.0 delta
        expect(expectedCell.textContent).toBe('6.0 (+0.0)');
    });

    test('Expected column shows a dash when the session has no predicted rate', () => {
        seedSession('s1', { catalystEntries: [] });

        transmuteHistoryViewer.renderTable();

        const cells = transmuteHistoryViewer.modal.querySelectorAll('tbody tr')[0].querySelectorAll('td');
        expect(cells[4].textContent).toBe('—');
    });
});
