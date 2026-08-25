/** @vitest-environment happy-dom
 *
 * The Diagnostics section, at the level a player opening it sees: a status
 * line that says what build this is, a button that runs the checks and shows
 * what they found, the errors the script caught, and a report that can be
 * pasted into a bug report without leaking any settings.
 *
 * The checks and the error log are injected — what is under test is that the
 * section shows their answers, not the answers themselves.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { isFeatureEnabled: () => true, getSettingValue: () => null } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterName: () => 'Tester' } }));
vi.mock('../../core/feature-registry.js', () => ({
    default: { getAllFeatures: () => [], checkFeatureHealth: () => [] },
}));
vi.mock('../dev/health-status.js', () => ({
    buildDiagnosticReport: () => 'health report (mocked)',
    refreshStorageFacts: async () => {},
}));

const { createDiagnosticsSection, buildReport, statusLine, timeAgo, buildStampFrom, allClear } =
    await import('./diagnostics-section.js');

const NOW = Date.parse('2026-08-22T12:00:00Z');

/** A fake error log the test fills and drains */
function fakeErrorLog(initial = []) {
    let entries = [...initial];
    const listeners = new Set();
    return {
        getEntries: () => [...entries],
        clear: () => {
            entries = [];
            for (const fn of listeners) fn([]);
        },
        subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        listenerCount: () => listeners.size,
        push: (entry) => {
            entries = [entry, ...entries];
            for (const fn of listeners) fn([...entries]);
        },
    };
}

const status = () => ({
    version: '3.19.0',
    build: '2026-08-22 11:00:00',
    server: 'live',
    character: 'Tester',
    enabled: 40,
    total: 52,
});

/** Checks that all pass */
const cleanChecks = () => ({
    health: async () => 'Toolasha health report\nnone',
    canary: () => [],
    schema: () => [],
    selectorAudit: () => ({ classes: 900, checked: 60, broken: [], unchecked: ['EXTRA_TAB'] }),
});

/** Checks that find trouble */
const brokenChecks = () => ({
    health: async () => 'Toolasha health report\n- Net Worth [networth]: Health check returned false',
    canary: () => [{ key: 'canaryHeaderTotalLevel', name: 'Header (total level)', reason: 'selector missing' }],
    schema: () => [{ key: 'schemaItemDetailMap', name: 'itemDetailMap', reason: 'data shape changed' }],
    selectorAudit: () => ({
        classes: 900,
        checked: 60,
        broken: [{ name: 'TOTAL_LEVEL', selector: '[class*="Header_totalLevel"]', missing: 'Header_totalLevel' }],
        unchecked: [],
    }),
});

let copied;
const writeClipboard = async (text) => {
    copied = text;
    return true;
};

/** Let click handlers' promises settle. @returns {Promise<void>} */
async function settle() {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Draw a section into the document.
 * @param {Object} overrides - createDiagnosticsSection options
 * @returns {Object} The section plus a text() helper
 */
function draw(overrides = {}) {
    const section = createDiagnosticsSection({
        status,
        checks: cleanChecks(),
        errorLog: fakeErrorLog(),
        writeClipboard,
        now: () => NOW,
        ...overrides,
    });
    document.body.appendChild(section.element);
    return { ...section, text: () => section.element.textContent };
}

beforeEach(() => {
    copied = null;
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('opening the section', () => {
    test('starts collapsed and empty, builds itself on the first open', () => {
        const { element, text } = draw();
        expect(element.classList.contains('collapsed')).toBe(true);
        expect(element.querySelector('.toolasha-diagnostics-status')).toBeNull();
        element.querySelector('.toolasha-settings-group-header').click();
        expect(element.classList.contains('collapsed')).toBe(false);
        expect(text()).toContain('Toolasha 3.19.0 (build 2026-08-22 11:00:00)');
        expect(text()).toContain('live server');
        expect(text()).toContain('Tester');
        expect(text()).toContain('features 40/52 enabled');
        expect(text()).toContain('errors captured: 0');
        expect(text()).toContain('Captured errors: none this session');
    });

    test('does not run any check until the button is pressed', async () => {
        const checks = cleanChecks();
        const calls = [];
        for (const name of Object.keys(checks)) {
            const run = checks[name];
            checks[name] = (...args) => {
                calls.push(name);
                return run(...args);
            };
        }
        const { element, open } = draw({ checks });
        open();
        await settle();
        expect(calls).toEqual([]);
        element.querySelector('.toolasha-diagnostics-run').click();
        await settle();
        expect(calls.sort()).toEqual(['canary', 'health', 'schema', 'selectorAudit']);
    });
});

describe('running the checks', () => {
    test('says all clear when every check is empty, and shows the health report', async () => {
        const { element, open, text } = draw();
        open();
        element.querySelector('.toolasha-diagnostics-run').click();
        await settle();
        expect(text()).toContain('All clear');
        expect(element.querySelector('.toolasha-diagnostics-health').textContent).toContain('Toolasha health report');
        expect(text()).toContain('60 selectors checked against 900 game classes');
        expect(text()).toContain('Unchecked');
        expect(text()).toContain('EXTRA_TAB');
    });

    test('lists what the canaries and the audit found', async () => {
        const { element, open, text } = draw({ checks: brokenChecks() });
        open();
        element.querySelector('.toolasha-diagnostics-run').click();
        await settle();
        expect(text()).toContain('Problems found');
        expect(text()).toContain('Selector canary (1)');
        expect(text()).toContain('Header (total level) [canaryHeaderTotalLevel]: selector missing');
        expect(text()).toContain('Schema canary (1)');
        expect(text()).toContain('itemDetailMap');
        expect(text()).toContain('Broken selectors (1)');
        expect(text()).toContain('TOTAL_LEVEL');
        expect(text()).toContain('missing Header_totalLevel');
    });

    test('a check that throws is reported, not fatal', async () => {
        const checks = cleanChecks();
        checks.selectorAudit = () => {
            throw new Error('no stylesheets');
        };
        const { element, open, text } = draw({ checks });
        open();
        element.querySelector('.toolasha-diagnostics-run').click();
        await settle();
        expect(text()).toContain('Problems found');
        expect(text()).toContain('Checks that could not run');
        expect(text()).toContain('selectorAudit: no stylesheets');
        expect(text()).toContain('Toolasha health report');
    });
});

describe('captured errors', () => {
    const entries = [
        {
            ts: NOW - 5 * 60_000,
            kind: 'console',
            module: 'Networth',
            message: '[Networth] Recompute failed: Error: boom',
            stack: 'Error: boom\n    at recompute (toolasha-market.js:1:1)',
            count: 3,
        },
        {
            ts: NOW - 3 * 3600_000,
            kind: 'rejection',
            module: null,
            message: 'Error: late',
            stack: '',
            count: 1,
        },
    ];

    test('lists them newest first with module badge, time ago and count, and expands the stack on click', () => {
        const { element, open, text } = draw({ errorLog: fakeErrorLog(entries) });
        open();
        expect(text()).toContain('errors captured: 2');
        expect(text()).toContain('Captured errors (2, newest first)');
        const rows = element.querySelectorAll('.toolasha-diagnostics-error');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('.toolasha-diagnostics-module').textContent).toBe('Networth');
        expect(rows[0].textContent).toContain('5m ago');
        expect(rows[0].querySelector('.toolasha-diagnostics-count').textContent).toBe('×3');
        expect(rows[0].querySelector('.toolasha-diagnostics-message').textContent).toContain('Recompute failed');
        expect(rows[1].querySelector('.toolasha-diagnostics-module').textContent).toBe('rejection');
        expect(rows[1].textContent).toContain('3h ago');
        expect(rows[1].querySelector('.toolasha-diagnostics-stack')).toBeNull();

        const stack = rows[0].querySelector('.toolasha-diagnostics-stack');
        expect(stack.style.display).toBe('none');
        rows[0].click();
        expect(stack.style.display).toBe('block');
        expect(stack.textContent).toContain('at recompute');
    });

    test('follows the log live and clears on the button', () => {
        const log = fakeErrorLog([]);
        const { element, open, text } = draw({ errorLog: log });
        open();
        expect(text()).toContain('errors captured: 0');
        log.push({ ts: NOW, kind: 'console', module: 'Tasks', message: '[Tasks] oops', stack: '', count: 1 });
        expect(text()).toContain('errors captured: 1');
        expect(element.querySelectorAll('.toolasha-diagnostics-error')).toHaveLength(1);
        element.querySelector('.toolasha-diagnostics-clear').click();
        expect(text()).toContain('errors captured: 0');
        expect(element.querySelectorAll('.toolasha-diagnostics-error')).toHaveLength(0);
    });
});

describe('the report', () => {
    test('carries the status line, the check results and the errors, and nothing else', async () => {
        const log = fakeErrorLog([
            { ts: NOW - 60_000, kind: 'console', module: 'Tasks', message: '[Tasks] oops', stack: '', count: 2 },
        ]);
        const { element, open } = draw({ errorLog: log, checks: brokenChecks() });
        open();
        element.querySelector('.toolasha-diagnostics-run').click();
        await settle();
        element.querySelector('.toolasha-diagnostics-copy').click();
        await settle();
        expect(copied).toContain('Toolasha diagnostics');
        expect(copied).toContain(statusLine(status(), 1));
        expect(copied).toContain('Checks: problems found');
        expect(copied).toContain('Header (total level)');
        expect(copied).toContain('TOTAL_LEVEL');
        expect(copied).toContain('Toolasha health report');
        expect(copied).toContain('Captured errors (1 of 1, newest first)');
        expect(copied).toContain('console ×2: [Tasks] oops');
        expect(copied).toContain('(1m ago)');
        expect(element.querySelector('.toolasha-diagnostics-copy').textContent).toBe('Copied ✓');
    });

    test('before the checks run it says so, and caps the errors at fifty', () => {
        const errors = Array.from({ length: 70 }, (_, i) => ({
            ts: NOW - i * 1000,
            kind: 'console',
            module: 'Many',
            message: `[Many] failure ${i}`,
            stack: '',
            count: 1,
        }));
        const report = buildReport({ status: status(), results: null, errors, now: NOW });
        expect(report).toContain('Checks: not run');
        expect(report).toContain('Captured errors (50 of 70, newest first)');
        expect(report).toContain('[Many] failure 49');
        expect(report).not.toContain('[Many] failure 50');
    });
});

describe('helpers', () => {
    test('timeAgo', () => {
        expect(timeAgo(NOW, NOW)).toBe('just now');
        expect(timeAgo(NOW - 4 * 60_000, NOW)).toBe('4m ago');
        expect(timeAgo(NOW - 5 * 3600_000, NOW)).toBe('5h ago');
        expect(timeAgo(NOW - 3 * 86400_000, NOW)).toBe('3d ago');
    });

    test('buildStampFrom reads the dev build stamp and nothing else', () => {
        expect(buildStampFrom('3.19.0.20260822153000')).toBe('2026-08-22 15:30:00');
        expect(buildStampFrom('3.19.0')).toBeNull();
        expect(buildStampFrom(null)).toBeNull();
    });

    test('allClear', () => {
        expect(allClear({ canary: [], schema: [], selectorAudit: { broken: [] }, errors: [] })).toBe(true);
        expect(allClear({ canary: [], schema: [], selectorAudit: null, errors: [] })).toBe(true);
        expect(allClear({ canary: [{}], schema: [], selectorAudit: null, errors: [] })).toBe(false);
    });
});

describe('letting go once the settings tab is gone', () => {
    test('React taking the tab away unsubscribes on the next error', () => {
        // `destroy` only runs on a character switch or a re-injection, and React
        // unmounts the settings panel long before either — so the subscription
        // outlived the section and rebuilt a list inside a detached tree for the
        // rest of the session, once per section ever opened
        const log = fakeErrorLog([]);
        const { element, open } = draw({ errorLog: log });
        open();
        expect(log.listenerCount()).toBe(1);

        element.remove();
        log.push({ ts: NOW, kind: 'console', module: 'Tasks', message: '[Tasks] oops', stack: '', count: 1 });

        expect(log.listenerCount()).toBe(0);
        expect(element.querySelectorAll('.toolasha-diagnostics-error')).toHaveLength(0);
    });

    test('a section still on the page keeps following the log', () => {
        const log = fakeErrorLog([]);
        const { element, open } = draw({ errorLog: log });
        open();

        log.push({ ts: NOW, kind: 'console', module: 'Tasks', message: '[Tasks] oops', stack: '', count: 1 });

        expect(log.listenerCount()).toBe(1);
        expect(element.querySelectorAll('.toolasha-diagnostics-error')).toHaveLength(1);
    });

    test('building a section the caller has not appended yet still draws', () => {
        // The guard must not fire during `build`: the section is legitimately
        // detached until whoever asked for it puts it on the page
        const section = createDiagnosticsSection({
            status,
            checks: cleanChecks(),
            errorLog: fakeErrorLog([
                { ts: NOW, kind: 'console', module: 'Tasks', message: '[Tasks] oops', stack: '', count: 1 },
            ]),
            writeClipboard,
            now: () => NOW,
        });
        section.open();

        expect(section.element.querySelectorAll('.toolasha-diagnostics-error')).toHaveLength(1);
        section.destroy();
    });
});
