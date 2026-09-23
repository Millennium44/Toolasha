/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach } from 'vitest';
import { coinifyHistoryViewer } from './coinify-history-viewer.js';

/**
 * Builds the minimal modal DOM renderTable() expects: the table container,
 * controls, badges and pagination hosts it queries for by class.
 * @returns {HTMLElement}
 */
function buildModal() {
    const modal = document.createElement('div');
    modal.innerHTML = `
        <div class="mwi-coinify-history-controls"></div>
        <div class="mwi-coinify-history-badges"></div>
        <div class="mwi-coinify-history-table-container"></div>
        <div class="mwi-coinify-history-pagination"></div>
    `;
    document.body.appendChild(modal);
    return modal;
}

describe('coinify history viewer - icon-only header accessibility', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        coinifyHistoryViewer.modal = buildModal();
        coinifyHistoryViewer.sessions = [];
        coinifyHistoryViewer.filteredSessions = [];
        coinifyHistoryViewer.filters = {
            dateFrom: null,
            dateTo: null,
            selectedInputItems: [],
        };
    });

    test('Catalyst of Coinification column header exposes its label as an accessible name', () => {
        coinifyHistoryViewer.renderTable();

        const headers = Array.from(coinifyHistoryViewer.modal.querySelectorAll('thead th'));
        // Column order: Session Start, Input Item, Enh. Level, Attempts, Successes,
        // Success Rate, Expected, Coins Earned, Catalyst of Coinification, Prime Catalyst, Profit, (delete)
        const catalystHeader = headers[8];

        expect(catalystHeader.getAttribute('aria-label')).toBe('Catalyst of Coinification');
        expect(catalystHeader.title).toBe('Catalyst of Coinification');
        expect(catalystHeader.textContent.trim()).toBe('');
    });

    test('Prime Catalyst column header exposes its label as an accessible name', () => {
        coinifyHistoryViewer.renderTable();

        const headers = Array.from(coinifyHistoryViewer.modal.querySelectorAll('thead th'));
        const primeCatalystHeader = headers[9];

        expect(primeCatalystHeader.getAttribute('aria-label')).toBe('Prime Catalyst');
        expect(primeCatalystHeader.title).toBe('Prime Catalyst');
        expect(primeCatalystHeader.textContent.trim()).toBe('');
    });

    test('per-row delete button exposes an accessible name matching its tooltip', () => {
        const session = {
            id: 's1',
            startTime: Date.now(),
            inputItemHrid: '/items/coin',
            enhancementLevel: 0,
            totalAttempts: 10,
            totalSuccesses: 5,
            totalCoinsEarned: 100,
            catalystOfCoinificationUsed: 0,
            primeCatalystUsed: 0,
        };
        coinifyHistoryViewer.sessions = [session];
        coinifyHistoryViewer.filteredSessions = [session];
        // Pre-seed the profit cache so renderTable doesn't need to recompute
        // profit from full market/pricing data for this row.
        coinifyHistoryViewer.profitCache.set(session.id, {
            profit: 10,
            revenue: 100,
            inputUnpriced: true,
            netConsumed: 1,
            catalystCost: 0,
        });

        coinifyHistoryViewer.renderTable();

        const deleteBtn = coinifyHistoryViewer.modal.querySelector('tbody button[aria-label="Delete this session"]');
        expect(deleteBtn).not.toBeNull();
        expect(deleteBtn.title).toBe('Delete this session');
    });
});
