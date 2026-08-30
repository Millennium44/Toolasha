/** @vitest-environment happy-dom */

/**
 * The calibration panel, built rather than reasoned about.
 *
 * `createPanel` swallows a draw failure into "could not be drawn" so one bad
 * section does not blank the rest, which means a renamed helper or a field that
 * stopped existing shows up as a quiet grey line and nothing else. Asserting
 * that string is absent is the only check that catches it — no arithmetic test
 * can, because the arithmetic would still be right.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ records: [], enhancing: [] }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: (definition) => store.rows.push(definition) }));
vi.mock('./prediction-calibration.js', () => ({
    predictionCalibration: {
        getCachedRecords: () => store.records,
        getRecords: async () => store.records,
    },
}));
vi.mock('./enhancement-calibration.js', () => ({
    enhancementCalibration: {
        getCachedRecords: () => store.enhancing,
        getRecords: async () => store.enhancing,
    },
}));

store.rows = [];

const { calibrationPanel, registerCalibrationRow } = await import('./calibration-panel.js');

const HOUR = 3600_000;
const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A recorded pair.
 * @param {string} actionType - Skill
 * @param {number} predicted - Predicted per hour
 * @param {number} actual - Actual per hour
 * @param {number} hoursAgo - When it finished
 * @returns {Object}
 */
const pair = (actionType, predicted, actual, hoursAgo = 1) => ({
    id: `${actionType}-${hoursAgo}-${actual}`,
    actionType,
    actionCount: 120,
    predicted,
    actual,
    t: now - hoursAgo * HOUR,
});

/** What the open panel says. */
const text = () => calibrationPanel.panel?.textContent || '';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    store.records = [];
    store.enhancing = [];
    store.rows = [];
});

afterEach(() => {
    calibrationPanel.hide({ remember: false });
    vi.useRealTimers();
});

describe('the panel', () => {
    test('says so plainly when no run has been measured', () => {
        calibrationPanel.show({ remember: false });
        expect(text()).toContain('No finished runs measured yet');
        expect(text()).not.toContain('could not be drawn');
    });

    test('draws every section when there are pairs', () => {
        store.records = [
            ...Array.from({ length: 6 }, (_, i) => pair('milking', 1_000_000, 500_000, i + 1)),
            ...Array.from({ length: 3 }, (_, i) => pair('cooking', 1_000_000, 990_000, 26 + i)),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Overall (9 runs)');
        expect(text()).toContain('Milking');
        expect(text()).toContain('Cooking');
        expect(text()).toContain('Recent runs');
        // Six runs agreeing that the forecast is double what the run paid
        expect(text()).toContain('Persistent gap');
        expect(text()).toContain('-50.0%');
    });

    test('waits rather than claiming there is nothing, while the read is in flight', () => {
        store.records = null;
        calibrationPanel.show({ remember: false });
        expect(text()).toContain('Reading history');
    });

    test('draws combat as a group, carrying its provenance flags', () => {
        store.records = Array.from({ length: 3 }, (_, i) => ({
            ...pair('combat', 1_000_000, 800_000, i + 1),
            actionHrid: '/actions/combat/rat_cave',
            difficultyTier: 1,
            snapshotAgeMs: 2 * 24 * HOUR,
            fingerprintMatch: i !== 0,
        }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Combat');
        // The forecast's provenance sits with the figures, not behind them
        expect(text()).toContain('Forecast: all-zones sim');
        expect(text()).toContain('1 of 3 in different gear');
        // Recent runs name the zone and mark the mismatched pair
        expect(text()).toContain('Rat cave T1');
        expect(text()).toContain('⚠');
    });

    test('draws enhancement runs as percentiles, even with no rate pairs at all', () => {
        store.enhancing = [
            {
                id: 's1:8',
                t: now - HOUR,
                itemHrid: '/items/cheese_sword',
                itemName: 'Cheese Sword',
                targetLevel: 8,
                expectedAttempts: 41,
                observedAttempts: 63,
                tailProbability: 0.08,
            },
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Enhancing (1 runs)');
        expect(text()).toContain('Median outcome percentile');
        expect(text()).toContain('92%');
        expect(text()).toContain('Cheese Sword +8');
        // The percentile is the headline, never a bare predicted-vs-actual gap
        expect(text()).toContain('8% take ≥');
        expect(text()).not.toContain('No finished runs measured yet');
    });
});

describe('the overlay tile', () => {
    test('is only put up when asked, and opens the panel', () => {
        expect(store.rows).toHaveLength(0);
        registerCalibrationRow();

        const [tile] = store.rows;
        expect(tile.key).toBe('predictionCalibration');
        expect(typeof tile.onOpen).toBe('function');

        store.records = Array.from({ length: 6 }, (_, i) => pair('milking', 1_000_000, 500_000, i + 1));
        const container = document.createElement('div');
        tile.render(container);

        expect(container.textContent).toContain('Milking');
        expect(container.textContent).toContain('-50.0%');
        expect(container.title).toContain('This gap has held');
    });

    test('draws nothing rather than zeroes when there is no history', () => {
        registerCalibrationRow();
        const container = document.createElement('div');
        store.records = [];
        store.rows[0].render(container);
        expect(container.textContent.trim()).toBe('');
    });
});

describe('the combat card’s verdicts', () => {
    /**
     * A combat pair, with the gear flag and both rates under the test's control.
     * @param {number} index - Makes the id unique
     * @param {Object} fields - `{goldDeviation, xpDeviation, fingerprintMatch}`
     * @returns {Object}
     */
    const combat = (index, { goldDeviation, xpDeviation = null, fingerprintMatch = true }) => ({
        ...pair('combat', 1_000_000, 1_000_000 * (1 + goldDeviation / 100), index + 1),
        id: `combat-${index}`,
        actionHrid: '/actions/combat/rat_cave',
        difficultyTier: 1,
        snapshotAgeMs: 2 * 24 * HOUR,
        fingerprintMatch,
        predictedXpPerHour: xpDeviation === null ? null : 500_000,
        actualXpPerHour: xpDeviation === null ? null : 500_000 * (1 + xpDeviation / 100),
    });

    test('XP landing while gold does not sends the reader to drops and prices', () => {
        store.records = Array.from({ length: 8 }, (_, i) => combat(i, { goldDeviation: -30, xpDeviation: -2 }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('XP deviation (median of 8)');
        expect(text()).toContain('XP pairs');
        expect(text()).toContain('8 of 8');
        expect(text()).toContain('the gap is drops or prices');
    });

    test('both rates off the same way indicts the fight model instead', () => {
        store.records = Array.from({ length: 8 }, (_, i) => combat(i, { goldDeviation: -30, xpDeviation: -27 }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('mis-models the fight itself');
    });

    test('pairs with no XP rate are counted aside, and too few is a refusal', () => {
        store.records = [
            ...Array.from({ length: 3 }, (_, i) => combat(i, { goldDeviation: -30, xpDeviation: -2 })),
            ...Array.from({ length: 5 }, (_, i) => combat(i + 3, { goldDeviation: -30 })),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('5 without XP');
        expect(text()).toContain('Too few XP pairs to call');
    });

    test('the gear split is drawn beside the caveats, not instead of them', () => {
        store.records = [
            ...Array.from({ length: 7 }, (_, i) => combat(i, { goldDeviation: -2, fingerprintMatch: true })),
            ...Array.from({ length: 7 }, (_, i) => combat(i + 7, { goldDeviation: -31, fingerprintMatch: false })),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        // The existing caveat lines survive
        expect(text()).toContain('Forecast: all-zones sim');
        expect(text()).toContain('7 of 14 in different gear');
        // And the split says what the pooled median could not
        expect(text()).toContain('matched -2.0% (7)');
        expect(text()).toContain('mismatched -31.0% (7)');
        expect(text()).toContain('the gear it never saw');
    });

    test('a thin cohort refuses rather than issuing a split verdict', () => {
        store.records = [
            ...Array.from({ length: 10 }, (_, i) => combat(i, { goldDeviation: -2, fingerprintMatch: true })),
            ...Array.from({ length: 2 }, (_, i) => combat(i + 10, { goldDeviation: -31, fingerprintMatch: false })),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Too few per cohort to call');
        expect(text()).not.toContain('the gear it never saw');
    });
});
