/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach } from 'vitest';
import { decomposeHistoryViewer } from './decompose-history-viewer.js';

/**
 * Builds the minimal modal DOM renderTable() expects: the table container,
 * controls, badges and pagination hosts it queries for by class.
 * @returns {HTMLElement}
 */
function buildModal() {
    const modal = document.createElement('div');
    modal.innerHTML = `
        <div class="mwi-decompose-history-controls"></div>
        <div class="mwi-decompose-history-badges"></div>
        <div class="mwi-decompose-history-table-container"></div>
        <div class="mwi-decompose-history-pagination"></div>
    `;
    document.body.appendChild(modal);
    return modal;
}

describe('decompose history viewer - icon-only header accessibility', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        decomposeHistoryViewer.modal = buildModal();
        decomposeHistoryViewer.sessions = [];
        decomposeHistoryViewer.filteredSessions = [];
        decomposeHistoryViewer.filters = {
            dateFrom: null,
            dateTo: null,
            selectedInputItems: [],
            resultsSearch: '',
        };
    });

    test('Catalyst of Decomposition column header exposes its label as an accessible name', () => {
        decomposeHistoryViewer.renderTable();

        const headers = Array.from(decomposeHistoryViewer.modal.querySelectorAll('thead th'));
        // Column order: Session Start, Input Item, Enh. Level, Attempts, Successes,
        // Success Rate, Results, Catalyst of Decomposition, Prime Catalyst, Profit, (delete)
        const catalystHeader = headers[7];

        expect(catalystHeader.getAttribute('aria-label')).toBe('Catalyst of Decomposition');
        expect(catalystHeader.title).toBe('Catalyst of Decomposition');
        // The icon itself carries no text, so the header's own text is empty —
        // the accessible name must come from the attributes above, not the subtree
        expect(catalystHeader.textContent.trim()).toBe('');
    });

    test('Prime Catalyst column header exposes its label as an accessible name', () => {
        decomposeHistoryViewer.renderTable();

        const headers = Array.from(decomposeHistoryViewer.modal.querySelectorAll('thead th'));
        const primeCatalystHeader = headers[8];

        expect(primeCatalystHeader.getAttribute('aria-label')).toBe('Prime Catalyst');
        expect(primeCatalystHeader.title).toBe('Prime Catalyst');
        expect(primeCatalystHeader.textContent.trim()).toBe('');
    });

    test('per-row delete button exposes an accessible name matching its tooltip', () => {
        decomposeHistoryViewer.sessions = [
            {
                id: 's1',
                startTime: Date.now(),
                inputItemHrid: '/items/coin',
                enhancementLevel: 0,
                totalAttempts: 10,
                totalSuccesses: 5,
                results: {},
                catalystOfDecompositionUsed: 0,
                primeCatalystUsed: 0,
            },
        ];
        decomposeHistoryViewer.filteredSessions = decomposeHistoryViewer.sessions;

        decomposeHistoryViewer.renderTable();

        const deleteBtn = decomposeHistoryViewer.modal.querySelector('tbody button[aria-label="Delete this session"]');
        expect(deleteBtn).not.toBeNull();
        expect(deleteBtn.title).toBe('Delete this session');
    });
});
