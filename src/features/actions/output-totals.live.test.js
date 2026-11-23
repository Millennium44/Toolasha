/** @vitest-environment happy-dom */

/**
 * Switching `actionPanel_outputTotals` back on mid-session: a detail panel that
 * is already open never dispatches to a new subscriber, so initialize() has to
 * attach to it directly.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), isFeatureEnabled: vi.fn(() => true) },
}));

import outputTotals from './output-totals.js';

/** An open detail panel with an action-count input. */
function openPanel() {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__x';
    panel.innerHTML =
        '<div class="SkillActionDetail_maxActionCountInput__y"><input value="100"></div>' +
        '<div class="SkillActionDetail_dropTable__z"><div class="SkillActionDetail_outputItems__w">' +
        '<div><span>1.5</span><span>100%</span></div></div></div>';
    document.body.appendChild(panel);
    return panel;
}

describe('output totals started with a panel already open', () => {
    afterEach(() => {
        outputTotals.disable();
        document.body.innerHTML = '';
    });

    test('attaches to the open panel on initialize', () => {
        const panel = openPanel();
        outputTotals.initialize();
        expect(outputTotals.observedInputs.has(panel.querySelector('input'))).toBe(true);
    });

    test('disable then initialize attaches to the open panel again', () => {
        const panel = openPanel();
        outputTotals.initialize();
        outputTotals.disable();
        expect(outputTotals.observedInputs.size).toBe(0);
        outputTotals.initialize();
        expect(outputTotals.observedInputs.has(panel.querySelector('input'))).toBe(true);
    });
});
