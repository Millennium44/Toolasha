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

const store = vi.hoisted(() => ({ records: [] }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({
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
