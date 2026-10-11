/** @vitest-environment happy-dom */
/**
 * The panel that breaks the last pull down by store: a record written whole is
 * named, the way a folded one is, so a report of "1 written whole" says which.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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
const { openPullSummaryPanel } = await import('./pull-summary-panel.js');

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
