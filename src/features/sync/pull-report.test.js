/**
 * The pull report: key names and counts for a developer, never values.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { registerSyncMerge, clearSyncMerges } from '../../utils/sync-merge-registry.js';
import { buildPullSummary } from './pull-summary.js';
import { buildPullReport, stripCharacterSuffix, describeSyncKey, REPORT_PRIVACY_LINE } from './pull-report.js';

const SENTINEL = 'SECRET-VALUE-9f3a';

/** What `rememberPullSummary` stores for a pull that latched two keys, with a value-bearing payload around it */
function fixtureSummary() {
    return buildPullSummary({
        merged: [{ store: 'settings', key: 'reportLive_30404', label: 'live records' }],
        mergeHeld: [{ store: 'settings', key: 'reportHeld', label: 'held records' }],
        writtenWholeKeys: [
            { store: 'settings', key: 'reportPlain_30404' },
            { store: 'settings', key: 'script_settingsMap' },
        ],
        latchedKeys: [
            { store: 'settings', key: 'reportPlain_30404' },
            { store: 'settings', key: 'script_settingsMap' },
        ],
        latched: 2,
        expected: { settings: 3 },
        unchanged: { settings: 4 },
        at: '2026-10-14T12:00:00.000Z',
        // A stray value-bearing field must never reach the report
        payload: { stores: { settings: { reportPlain_30404: SENTINEL } } },
    });
}

beforeEach(() => {
    clearSyncMerges();
    registerSyncMerge({
        store: 'settings',
        base: 'reportLive',
        merge: (a) => a,
        label: 'live records',
        liveSafe: true,
    });
    registerSyncMerge({ store: 'settings', base: 'reportPlain', merge: (a) => a, label: 'plain records' });
});
afterEach(() => clearSyncMerges());

describe('the pull report', () => {
    test('opens with the privacy line and the environment', () => {
        const text = buildPullReport(fixtureSummary(), {
            version: '3.70.0 (dev build X)',
            host: 'www.milkywayidle.com',
        });
        expect(text.split('\n')[0]).toBe(REPORT_PRIVACY_LINE);
        expect(text).toContain('Toolasha: 3.70.0 (dev build X)');
        expect(text).toContain('Host: www.milkywayidle.com (live)');
        expect(text).toContain('Pull time: 2026-10-14T12:00:00.000Z');
        expect(text).toContain('Reload advice shown: yes (latched keys: 2)');
        expect(text).toContain('Held: settings/held records');
        expect(text).toContain('settings: 1 combined, 2 written whole');
    });

    test('names the test server', () => {
        expect(buildPullReport(fixtureSummary(), { host: 'test.milkywayidle.com' })).toContain('(test)');
    });

    test('lists latched keys with registration status, base and owner', () => {
        const text = buildPullReport(fixtureSummary(), { host: 'www.milkywayidle.com' });
        const line = text.split('\n').find((l) => l.includes('reportPlain_30404'));
        expect(line).toContain('LATCHED');
        expect(line).toContain('base=reportPlain');
        expect(line).toContain('registered="plain records" NOT live-safe');
        expect(line).toContain('not owned');
        const owned = text.split('\n').find((l) => l.includes('script_settingsMap'));
        expect(owned).toContain('unregistered');
        expect(owned).toContain('owner=prefix script_settingsMap');
    });

    test('marks a written-whole key that did not latch', () => {
        const summary = buildPullSummary({
            writtenWholeKeys: [{ store: 'settings', key: 'reportLive_30404' }],
            expected: { settings: 1 },
            latched: 0,
            latchedKeys: [],
        });
        const text = buildPullReport(summary, {});
        expect(text).toContain(
            'reportLive_30404 | written whole | base=reportLive | registered="live records" live-safe'
        );
        expect(text).toContain('Reload advice shown: no');
    });

    test('lists a failed fold per key, marked MERGE FAILED', () => {
        const summary = buildPullSummary({
            mergeFailed: [{ store: 'settings', key: 'reportLive_30404', label: 'live records' }],
            writtenWholeKeys: [{ store: 'settings', key: 'reportLive_30404' }],
            expected: { settings: 1 },
            latched: 0,
        });
        const text = buildPullReport(summary, {});
        expect(text).toContain('Merge failed: settings/live records');
        const line = text.split('\n').find((l) => l.includes('settings / reportLive_30404'));
        expect(line).toContain('MERGE FAILED');
        expect(line).toContain('base=reportLive');
        expect(line).toContain('registered="live records" live-safe');
    });

    test('never carries a stored value', () => {
        const text = buildPullReport(fixtureSummary(), { host: 'www.milkywayidle.com' });
        expect(text).not.toContain(SENTINEL);
    });

    test('says so without a summary', () => {
        expect(buildPullReport(null)).toContain('No pull has run');
    });

    test('strips the character suffix only', () => {
        expect(stripCharacterSuffix('watchlist_30404')).toBe('watchlist');
        expect(stripCharacterSuffix('watchlist_default')).toBe('watchlist');
        expect(stripCharacterSuffix('watchlist')).toBe('watchlist');
        // Records that lead with the character id
        expect(stripCharacterSuffix('603281_inventoryTabs_config')).toBe('inventoryTabs_config');
        expect(stripCharacterSuffix('guildMemberSkills_default')).toBe('guildMemberSkills');
        expect(describeSyncKey('settings', 'nothing_1').registered).toBe(false);
    });
});
