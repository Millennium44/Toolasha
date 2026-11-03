/** @vitest-environment happy-dom */
/**
 * The panel that breaks the last pull down by store: a record written whole is
 * named, the way a folded one is, so a report of "1 written whole" says which.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const shell = vi.hoisted(() => ({ draw: null }));

vi.mock('../../utils/simple-panel.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        createPanel: ({ draw }) => {
            shell.draw = draw;
            return { show: () => {}, hide: () => {} };
        },
    };
});

const { buildPullSummary, rememberPullSummary, clearPullSummary } = await import('./pull-summary.js');
const { openPullSummaryPanel, copyPullReport, currentPullReport } = await import('./pull-summary-panel.js');

/** The panel's text after one draw */
const drawn = () => {
    openPullSummaryPanel();
    const body = document.createElement('div');
    shell.draw(body);
    return body.textContent;
};

beforeEach(() => {
    clearPullSummary();
});

describe('the pull summary panel', () => {
    test('names each key a store wrote whole', () => {
        rememberPullSummary(
            buildPullSummary({
                expected: { networthHistory: 1 },
                writtenWholeKeys: [{ store: 'networthHistory', key: 'networthDetail_30404' }],
            })
        );

        const text = drawn();

        expect(text).toContain('networthDetail_30404 — written whole');
    });

    test('counts the rest once a store wrote more than it is worth naming', () => {
        const keys = Array.from({ length: 35 }, (_, index) => ({ store: 'networthHistory', key: `k_${index}` }));
        rememberPullSummary(buildPullSummary({ expected: { networthHistory: 35 }, writtenWholeKeys: keys }));

        const text = drawn();

        expect(text).toContain('k_29 — written whole');
        expect(text).not.toContain('k_30 — written whole');
        expect(text).toContain('and 5 more written whole');
    });
});

describe('the Copy report button', () => {
    const SENTINEL = 'SECRET-VALUE-9f3a';

    /** Draw the panel and return its body */
    const draw = () => {
        openPullSummaryPanel();
        const body = document.createElement('div');
        shell.draw(body);
        return body;
    };

    beforeEach(() => {
        rememberPullSummary(
            buildPullSummary({
                expected: { settings: 1 },
                writtenWholeKeys: [{ store: 'settings', key: 'script_settingsMap' }],
                latchedKeys: [{ store: 'settings', key: 'script_settingsMap' }],
                latched: 1,
                payload: { v: SENTINEL },
            })
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('writes the report to the clipboard from the click and says Copied', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const body = draw();
        const button = body.querySelector('button.toolasha-pull-report-copy');
        expect(button.textContent).toBe('Copy report');

        button.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const text = writeText.mock.calls[0][0];
        expect(text).toContain('Contains key names and counts only, no saved values.');
        expect(text).toContain('script_settingsMap');
        expect(text).not.toContain(SENTINEL);
        expect(draw().querySelector('button.toolasha-pull-report-copy').textContent).toBe('Copied');
    });

    test('falls back to a selectable textarea when the clipboard rejects', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const body = draw();

        body.querySelector('button.toolasha-pull-report-copy').click();
        await vi.waitFor(() => expect(body.querySelector('textarea.toolasha-pull-report-text')).not.toBeNull());

        const area = body.querySelector('textarea.toolasha-pull-report-text');
        expect(area.value).toContain('script_settingsMap');
        expect(area.value).not.toContain(SENTINEL);
        expect(await copyPullReport()).toBe(false);
    });

    test('a fallback from one pull does not render under the next pull', async () => {
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
        await copyPullReport();
        expect(draw().querySelector('textarea.toolasha-pull-report-text')).not.toBeNull();

        rememberPullSummary(buildPullSummary({ expected: { settings: 0 } }));

        expect(draw().querySelector('textarea.toolasha-pull-report-text')).toBeNull();
    });

    test('the Copied label does not outlive its pull', async () => {
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
        await copyPullReport();
        expect(draw().querySelector('button.toolasha-pull-report-copy').textContent).toBe('Copied');

        rememberPullSummary(buildPullSummary({ expected: { settings: 0 } }));

        expect(draw().querySelector('button.toolasha-pull-report-copy').textContent).toBe('Copy report');
    });
});

describe('the report the panel writes', () => {
    const repairLine = () =>
        currentPullReport()
            .split('\n')
            .find((line) => line.startsWith('Ledger repair'));

    beforeEach(() => {
        rememberPullSummary(buildPullSummary({ expected: { settings: 0 } }));
    });

    afterEach(() => {
        delete globalThis.window.Toolasha;
    });

    test('says the ledger repair is unknown when the market bundle is not there to ask', () => {
        expect(repairLine()).toBe('Ledger repair this session: unknown');
    });

    test('asks the ledger store through the bridge and tells not-run-yet from zero from a count', () => {
        const stats = { charId: '30404', runs: 0, cut: 0 };
        globalThis.window.Toolasha = { Market: { tradeLedgerStore: { repairStats: () => ({ ...stats }) } } };
        expect(repairLine()).toBe('Ledger repair this session (character 30404): not run yet');

        Object.assign(stats, { runs: 2, cut: 0 });
        expect(repairLine()).toBe('Ledger repair this session (character 30404): 0 listings cut (2 runs)');

        Object.assign(stats, { runs: 2, cut: 3 });
        expect(repairLine()).toBe('Ledger repair this session (character 30404): 3 listings cut (2 runs)');
    });

    test('a store that throws, or has no repairStats, costs the line and nothing else', () => {
        globalThis.window.Toolasha = {
            Market: {
                tradeLedgerStore: {
                    repairStats: () => {
                        throw new Error('boom');
                    },
                },
            },
        };
        expect(repairLine()).toBe('Ledger repair this session: unknown');
        globalThis.window.Toolasha = { Market: { tradeLedgerStore: {} } };
        expect(repairLine()).toBe('Ledger repair this session: unknown');
        expect(currentPullReport()).toContain('Stores:');
    });

    test('a stall the heartbeat recorded after the pull ended reaches the report through storage diagnostics', async () => {
        const { default: storage } = await import('../../core/storage.js');
        const startPerf = performance.now() - 5000;
        rememberPullSummary(
            buildPullSummary({
                expected: { settings: 0 },
                timing: {
                    startPerf,
                    endPerf: startPerf + 3000,
                    sinceLoadMs: 1000,
                    durationMs: 3000,
                    visibility: 'visible',
                    stall: { status: 'none', lostMs: null, visibility: null },
                },
            })
        );
        const real = storage.diagnostics;
        storage.diagnostics = () => ({
            lostTime: {
                running: true,
                totalMs: 2500,
                windows: [{ perfAt: startPerf + 3500, lostMs: 2500, visibilityState: 'hidden' }],
            },
        });
        try {
            expect(currentPullReport()).toContain('Longest stall overlapping the pull: 2500 ms (tab hidden)');
            // A diagnostics call that throws leaves the stored answer
            storage.diagnostics = () => {
                throw new Error('blocked');
            };
            expect(currentPullReport()).toContain('Longest stall overlapping the pull: none');
        } finally {
            storage.diagnostics = real;
        }
    });
});
