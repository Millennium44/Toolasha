/** @vitest-environment happy-dom
 *
 * The PFormance panel's one button.
 *
 * There is a single button for this panel, in Toolasha's settings, and it used
 * to only ever open. Pressing it again raised a panel that was already up,
 * which on a phone — where the panel's own ✕ is the first thing to fall off a
 * narrow header — left no way to close it at all.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));

const { default: pformancePanel } = await import('./pformance-panel.js');

/** @returns {HTMLElement|null} The panel, if it is up */
const onScreen = () => document.getElementById('toolasha-pformance-panel');

/** The monitor the panel switches on while it is open */
const monitor = {
    enabled: false,
    getAllStats: () => new Map(),
    getSnapshots: () => new Map(),
    getSpans: () => [],
    getMarks: () => [],
};

beforeEach(() => {
    window.Toolasha = { Core: { performanceMonitor: monitor } };
    monitor.enabled = false;
});

afterEach(() => {
    pformancePanel.hide();
    document.body.replaceChildren();
    delete window.Toolasha;
});

describe('opening and closing', () => {
    test('the first press opens it and the second closes it', () => {
        pformancePanel.toggle();
        expect(onScreen()).not.toBe(null);
        expect(pformancePanel.isVisible()).toBe(true);

        pformancePanel.toggle();
        expect(onScreen()).toBe(null);
        expect(pformancePanel.isVisible()).toBe(false);
    });

    test('closing stops the measuring it turned on', () => {
        pformancePanel.toggle();
        expect(monitor.enabled).toBe(true);

        pformancePanel.toggle();
        expect(monitor.enabled).toBe(false);
    });

    test('the ✕ in its header does the same thing the button does', () => {
        pformancePanel.show();
        const close = [...onScreen().querySelectorAll('button')].find((button) => button.textContent === '✕');

        close.click();

        expect(onScreen()).toBe(null);
    });

    test('closing a panel that was never opened is not a crash', () => {
        expect(() => pformancePanel.hide()).not.toThrow();
    });

    test('and neither is opening one with no monitor to switch on', () => {
        // The panel can be opened from contexts where the script's global is
        // not published, and an assignment through nothing took the open with it
        delete window.Toolasha;

        expect(() => pformancePanel.toggle()).not.toThrow();
        expect(onScreen()).not.toBe(null);
    });
});
