/** @vitest-environment happy-dom */

/**
 * The report is the point of the panel.
 *
 * A user who says "the net worth number is gone" cannot say which build they are
 * on, which fork, or what the startup was waiting for — so the report has to
 * carry all of it without being asked. Everything here is a check that one of
 * those things is in the text, because each was chosen after being missing from
 * a bug report at least once.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Both reach storage, and neither is what this is about
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    PANEL_Z_CAP: 1199,
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

import healthStatusPanel, { buildDiagnosticReport, diagnosticData, reportFailures } from './health-status.js';
import { dismissAllToasts } from '../../utils/toast.js';

const FAILURES = [
    { key: 'networth', name: 'Net Worth', reason: 'Health check returned false' },
    { key: 'taskIcons', name: 'Task Icons', reason: 'Initialization threw: boom' },
];

beforeEach(() => {
    document.body.innerHTML = '';
    window.Toolasha = {
        version: '2.88.0',
        fork: 'Millennium44/Toolasha',
        Core: {
            performanceMonitor: {
                getMarks: () => [
                    { name: 'script:start', at: 0 },
                    { name: 'character:data', at: 4200 },
                ],
                getSnapshots: () => new Map([['init:networth', { duration: 120, startedAt: 4300 }]]),
                getAllStats: () => new Map(),
                spans: new Map(),
            },
        },
    };
});

afterEach(() => {
    healthStatusPanel.disable();
    dismissAllToasts();
});

describe('the diagnostic report', () => {
    test('names the build, the fork and the browser', () => {
        const report = buildDiagnosticReport(FAILURES);
        expect(report).toContain('script: 2.88.0');
        expect(report).toContain('fork: Millennium44/Toolasha');
        expect(report).toContain(navigator.userAgent);
    });

    test('lists every failure with its key and its reason', () => {
        const report = buildDiagnosticReport(FAILURES);
        expect(report).toContain('Features that did not start (2)');
        expect(report).toContain('- Net Worth [networth]: Health check returned false');
        expect(report).toContain('- Task Icons [taskIcons]: Initialization threw: boom');
    });

    test('carries the startup trace, gaps and all', () => {
        const report = buildDiagnosticReport(FAILURES);
        expect(report).toContain('Toolasha startup trace');
        expect(report).toContain('character:data');
        expect(report).toContain('script:start → character:data');
    });

    test('survives a monitor that is not there yet', () => {
        window.Toolasha.Core = {};
        expect(buildDiagnosticReport(FAILURES)).toContain('No startup trace was recorded.');
    });

    test('the machine-readable copy carries the same facts', () => {
        const data = diagnosticData(FAILURES);
        expect(data.script).toBe('2.88.0');
        expect(data.failures).toHaveLength(2);
        expect(data.startup.features[0].name).toBe('init:networth');
    });
});

describe('surfacing', () => {
    test('one toast for many failures, not one each', () => {
        reportFailures(FAILURES);
        const toasts = document.querySelectorAll('.toolasha-toast');
        expect(toasts).toHaveLength(1);
        expect(toasts[0].textContent).toContain('2 Toolasha features failed to start');
    });

    test('says nothing at all when nothing failed', () => {
        expect(reportFailures([])).toBeNull();
        expect(document.querySelectorAll('.toolasha-toast')).toHaveLength(0);
    });

    test('clicking it opens the list of what broke', () => {
        reportFailures(FAILURES);
        document.querySelector('.toolasha-toast').click();

        const panel = document.getElementById('toolasha-health-status');
        expect(panel).toBeTruthy();
        expect(panel.textContent).toContain('Net Worth');
        expect(panel.textContent).toContain('Task Icons');
        expect(panel.querySelector('.toolasha-health-copy')).toBeTruthy();
    });

    test('the copy button puts the report on the clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

        healthStatusPanel.show(FAILURES);
        document.querySelector('.toolasha-health-copy').click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

        expect(writeText.mock.calls[0][0]).toContain('- Net Worth [networth]');
    });

    test('reopening replaces the panel rather than stacking a second one', () => {
        healthStatusPanel.show(FAILURES);
        healthStatusPanel.show(FAILURES.slice(0, 1));
        expect(document.querySelectorAll('#toolasha-health-status')).toHaveLength(1);
        expect(document.getElementById('toolasha-health-status').textContent).toContain('1 feature did not start');
    });
});
