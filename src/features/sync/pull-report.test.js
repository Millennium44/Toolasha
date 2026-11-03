/**
 * The pull report: key names and counts for a developer, never values.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { registerSyncMerge, clearSyncMerges } from '../../utils/sync-merge-registry.js';
import { buildPullSummary } from './pull-summary.js';
import {
    buildPullReport,
    stripCharacterSuffix,
    describeSyncKey,
    redactSyncKey,
    REPORT_PRIVACY_LINE,
} from './pull-report.js';
import { memberSkillsStorageKey } from '../guild/guild-member-skills.js';
import { sessionStorageKey } from '../guild/guild-trial-abilities.js';
import { planStorageKey } from '../guild/guild-trial-plan.js';
import { trialSessionStorageKey } from '../guild/guild-trial-recorder.js';
import { guildTrialsStorageKey, trialStatsStorageKey } from '../guild/guild-trials-store.js';
import { ledgerCycleKey, ledgerScope } from '../guild/guild-trial-ledger.js';
import { guildLoadoutsStorageKey } from '../guild/guild-loadouts.js';

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

    test('never prints a guild name, whichever key family embeds it', () => {
        const guild = 'Quiet Cows 7';
        const keys = [
            memberSkillsStorageKey(guild),
            sessionStorageKey(guild, 5),
            planStorageKey(guild),
            trialSessionStorageKey(guild, 5),
            guildTrialsStorageKey(guild, 5),
            trialStatsStorageKey(guild, 5),
            ledgerCycleKey(ledgerScope(guild, 5), 1760000000000),
            guildLoadoutsStorageKey(30404, guild),
            `guildXP_${guild}`,
        ];
        const summary = buildPullSummary({
            writtenWholeKeys: keys.map((key) => ({ store: 'guildHistory', key })),
            mergeFailed: keys.map((key) => ({ store: 'guildHistory', key, label: 'guild records' })),
            latchedKeys: keys.map((key) => ({ store: 'guildHistory', key })),
            latched: keys.length,
            expected: { guildHistory: keys.length },
        });
        const text = buildPullReport(summary, {});
        expect(text).not.toContain('Quiet');
        expect(text).not.toContain('Cows');
        expect(text).toContain('guildMemberSkills_<guild>');
        expect(text).toContain('guildTrialLedger_<guild>__1760000000000');
        expect(text).toContain('guildLoadouts_30404_<guild>');
        // The id stays, and so does a key with no guild in it
        expect(redactSyncKey('guildLoadouts_30404')).toBe('guildLoadouts_30404');
        expect(redactSyncKey('guildTrials_char_5')).toBe('guildTrials_char_5');
        expect(redactSyncKey('guildMemberSkills_default')).toBe('guildMemberSkills_default');
        expect(redactSyncKey('guildTrialLedger_default__1760000000000')).toBe(
            'guildTrialLedger_default__1760000000000'
        );
        expect(redactSyncKey('watchlist_30404')).toBe('watchlist_30404');
    });

    test('says so without a summary', () => {
        expect(buildPullReport(null)).toContain('No pull has run');
    });

    test('no longer prints a writer field: the gist records neither the build nor the device that wrote it', () => {
        expect(buildPullReport(fixtureSummary(), {})).not.toContain('writer=');
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

describe('what the report says about each key the pull did something to', () => {
    const LEDGER_LABEL = 'Trade ledger fills (daily)';
    const ledgerKey = (day) => `tradeLedgerRec_12345_2026-08-${String(day).padStart(2, '0')}`;
    const lines = (text) => text.split('\n');
    const keyLines = (text) => lines(text).filter((line) => line.startsWith('  ') && line.includes(' / '));

    beforeEach(() => {
        registerSyncMerge({
            store: 'marketListings',
            base: 'tradeLedgerRec',
            merge: (a) => a,
            label: LEDGER_LABEL,
        });
    });

    /** The real report that prompted this: 10 combined, 7 of them latched, 3 live-safe */
    function tenCombined() {
        const merged = [];
        for (let day = 10; day <= 16; day++) {
            // Seven ledger days: stacks of three or more, with the pulled copy duplicating the local one's rows
            merged.push({
                store: 'marketListings',
                key: ledgerKey(day),
                label: LEDGER_LABEL,
                counts: { local: 12, pulled: 15, merged: 15 },
            });
        }
        for (const [index, key] of ['reportLive_12345', 'reportLive_67890', 'reportLive_default'].entries()) {
            merged.push({
                store: 'settings',
                key,
                label: 'live records',
                counts: { local: 3, pulled: 3 + index, merged: 4 },
            });
        }
        return buildPullSummary({
            merged,
            latchedKeys: merged.slice(0, 7).map(({ store, key }) => ({ store, key })),
            latched: 7,
            expected: { marketListings: 7, settings: 3 },
            unchanged: { marketListings: 98, settings: 1240 },
            at: '2026-11-03T20:00:00.000Z',
        });
    }

    test('lists every combined key, marks it LATCHED or live-safe, and gives its row counts', () => {
        const text = buildPullReport(tenCombined(), { host: 'test.milkywayidle.com' });
        const keys = keyLines(text);
        expect(keys).toHaveLength(10);
        expect(text).toContain('Keys (latched, merge failed, combined or written whole): 10');

        const latched = keys.filter((line) => line.includes('LATCHED'));
        expect(latched).toHaveLength(7);
        expect(latched[0]).toContain('marketListings / tradeLedgerRec_12345_2026-08-10 | LATCHED, combined |');
        expect(latched[0]).toContain(`registered="${LEDGER_LABEL}" NOT live-safe`);
        expect(latched[0]).toContain('rows: local 12, pulled 15, merged 15');

        const safe = keys.filter((line) => line.includes('live-safe') && line.includes('combined, live-safe'));
        expect(safe).toHaveLength(3);
        expect(safe[1]).toContain('settings / reportLive_67890 | combined, live-safe |');
        expect(safe[1]).toContain('rows: local 3, pulled 4, merged 4');
        // Latched first, the rest after
        expect(keys.slice(0, 7).every((line) => line.includes('LATCHED'))).toBe(true);
        expect(text).not.toContain('writer=');
    });

    test('a combined key that did not latch and is not registered live-safe says so', () => {
        const summary = buildPullSummary({
            merged: [
                {
                    store: 'settings',
                    key: 'reportPlain_12345',
                    label: 'plain records',
                    counts: { local: 1, pulled: 2, merged: 2 },
                },
            ],
            expected: { settings: 1 },
            latchedKeys: [],
            latched: 0,
        });
        expect(keyLines(buildPullReport(summary, {}))[0]).toContain('combined, not latched');
    });

    test('row counts: zero local, a non-array value, and a summary that predates them', () => {
        const summary = buildPullSummary({
            merged: [
                {
                    store: 'settings',
                    key: 'reportLive_1',
                    label: 'live records',
                    counts: { local: 0, pulled: 5, merged: 5 },
                },
                {
                    store: 'settings',
                    key: 'reportLive_2',
                    label: 'live records',
                    counts: { local: null, pulled: null, merged: null },
                },
                { store: 'settings', key: 'reportLive_3', label: 'live records' },
                // Not numbers at all
                {
                    store: 'settings',
                    key: 'reportLive_4',
                    label: 'live records',
                    counts: { local: 'x', pulled: -1, merged: NaN },
                },
            ],
            expected: { settings: 4 },
        });
        const keys = keyLines(buildPullReport(summary, {}));
        expect(keys.find((l) => l.includes('reportLive_1 '))).toContain('rows: local 0, pulled 5, merged 5');
        expect(keys.find((l) => l.includes('reportLive_2 '))).toContain('rows: local n/a, pulled n/a, merged n/a');
        expect(keys.find((l) => l.includes('reportLive_3 '))).toContain('rows: unknown');
        expect(keys.find((l) => l.includes('reportLive_4 '))).toContain('rows: local n/a, pulled n/a, merged n/a');
    });

    test('a key named twice in the result is listed once', () => {
        const entry = {
            store: 'settings',
            key: 'reportLive_12345',
            label: 'live records',
            counts: { local: 1, pulled: 1, merged: 1 },
        };
        const summary = buildPullSummary({ merged: [entry, entry], expected: { settings: 1 } });
        expect(keyLines(buildPullReport(summary, {}))).toHaveLength(1);
    });

    test('a key that was combined and latched is one line; a failed fold keeps its own status', () => {
        const summary = buildPullSummary({
            merged: [
                {
                    store: 'settings',
                    key: 'reportPlain_12345',
                    label: 'plain records',
                    counts: { local: 4, pulled: 4, merged: 4 },
                },
            ],
            mergeFailed: [{ store: 'settings', key: 'reportLive_12345', label: 'live records' }],
            writtenWholeKeys: [
                { store: 'settings', key: 'reportLive_12345' },
                { store: 'settings', key: 'other_1' },
            ],
            latchedKeys: [
                { store: 'settings', key: 'reportPlain_12345' },
                { store: 'settings', key: 'reportLive_12345' },
            ],
            latched: 2,
            expected: { settings: 3 },
        });
        const keys = keyLines(buildPullReport(summary, {}));
        expect(keys.map((line) => line.split(' | ')[1])).toEqual([
            'LATCHED, combined',
            'LATCHED, MERGE FAILED',
            'written whole',
        ]);
    });

    test('more keys than the cap: latched ones first, then the count of the rest', () => {
        const merged = Array.from({ length: 450 }, (_, i) => ({
            store: 'marketListings',
            key: `tradeLedgerRec_12345_${String(i).padStart(4, '0')}`,
            label: LEDGER_LABEL,
            counts: { local: 3, pulled: 3, merged: 3 },
        }));
        const summary = buildPullSummary({
            merged,
            // The last one latched; it must still be listed before the cut
            latchedKeys: [{ store: 'marketListings', key: merged[449].key }],
            latched: 1,
            expected: { marketListings: 450 },
        });
        const text = buildPullReport(summary, {});
        expect(keyLines(text)).toHaveLength(400);
        expect(text).toContain('...and 50 more');
        expect(keyLines(text)[0]).toContain(merged[449].key);
        expect(text).toContain('Keys (latched, merge failed, combined or written whole): 450');
    });

    test('guild keys stay redacted when they are combined, and no stored value reaches the report', () => {
        const guild = 'Quiet Cows 7';
        const key = guildTrialsStorageKey(guild, 5);
        const summary = buildPullSummary({
            merged: [
                { store: 'guildHistory', key, label: 'guild records', counts: { local: 2, pulled: 3, merged: 3 } },
            ],
            expected: { guildHistory: 1 },
            // A stray value-bearing field, as the existing report test proves is dropped
            payload: { stores: { guildHistory: { [key]: SENTINEL } } },
        });
        const text = buildPullReport(summary, {});
        expect(text).not.toContain('Quiet');
        expect(text).not.toContain(SENTINEL);
        expect(text).toContain('guildTrials_<guild>');
    });

    test('nothing changed, nothing latched, a pull that held records, all latched', () => {
        const nothing = buildPullSummary({ expected: {}, unchanged: {} });
        const text = buildPullReport(nothing, {});
        expect(text).toContain('Pull applied: no records changed.');
        expect(text).toContain('Keys (latched, merge failed, combined or written whole): 0');
        expect(keyLines(text)).toHaveLength(0);

        const held = buildPullSummary({
            mergeHeld: [{ store: 'settings', key: 'reportLive_12345', label: 'live records' }],
            expected: {},
        });
        const heldText = buildPullReport(held, {});
        expect(heldText).toContain('Held: settings/live records');
        // A held key was not written, so it is not in the key list
        expect(keyLines(heldText)).toHaveLength(0);

        const all = tenCombined();
        const allLatched = buildPullSummary({
            merged: all.stores.flatMap((s) => s.combinedRecords.map((r) => ({ store: s.store, ...r }))),
            latchedKeys: all.stores.flatMap((s) => s.combinedRecords.map((r) => ({ store: s.store, key: r.key }))),
            latched: 10,
            expected: { marketListings: 7, settings: 3 },
        });
        expect(keyLines(buildPullReport(allLatched, {})).every((line) => line.includes('LATCHED'))).toBe(true);
    });

    test('an older summary with no stores, no timing and no combined list prints unknown and does not throw', () => {
        const old = {
            at: '2026-10-01T00:00:00.000Z',
            latched: 1,
            combined: 2,
            writtenWhole: 0,
            held: 0,
            overwritten: 0,
        };
        const text = buildPullReport(old, {});
        expect(text).toContain('Pull timing: unknown');
        expect(text).toContain('Longest stall overlapping the pull: unknown');
        expect(text).toContain('Ledger repair this session: unknown');
        expect(text).toContain('Keys (latched, merge failed, combined or written whole): 0');

        const noLists = buildPullReport({ stores: [{ store: 'settings', combined: 1, writtenWhole: 0, held: 0 }] }, {});
        expect(noLists).toContain('settings: 1 combined');
    });
});

describe('what the report says about when the pull ran', () => {
    const timed = (extra = {}) =>
        buildPullSummary({
            expected: { settings: 1 },
            writtenWholeKeys: [{ store: 'settings', key: 'a_1' }],
            at: '2026-11-03T20:00:00.000Z',
            timing: {
                startPerf: 100_000,
                endPerf: 103_200,
                sinceLoadMs: 100_400,
                durationMs: 3200,
                visibility: 'hidden',
                stall: { status: 'none', lostMs: null, visibility: null },
                ...extra,
            },
        });
    const stallLine = (text) => text.split('\n').find((l) => l.startsWith('Longest stall'));

    test('prints seconds since load, the tab state at the start, and the duration', () => {
        const text = buildPullReport(timed(), {});
        expect(text).toContain('Pull timing: started 100.4 s after page load, tab hidden at the start, took 3.2 s');
        expect(stallLine(text)).toBe('Longest stall overlapping the pull: none');
    });

    test('a tab open many hours reads in hours as well', () => {
        const text = buildPullReport(timed({ sinceLoadMs: 14 * 3600 * 1000 }), {});
        expect(text).toContain('started 50400.0 s (14.0 h) after page load');
    });

    test('a stall noted when the pull ended is printed with its size and the tab state', () => {
        const text = buildPullReport(timed({ stall: { status: 'found', lostMs: 4200, visibility: 'hidden' } }), {});
        expect(stallLine(text)).toBe('Longest stall overlapping the pull: 4200 ms (tab hidden)');
    });

    test('a stall the heartbeat recorded after the pull ended is found from the ring, and the larger one wins', () => {
        const lostTime = {
            running: true,
            totalMs: 6000,
            // Ended 1 s after the pull did, but began 2.5 s before that: it overlaps
            windows: [{ at: 1, perfAt: 104_200, lostMs: 3500, visibilityState: 'hidden' }],
        };
        const text = buildPullReport(timed({ stall: { status: 'found', lostMs: 900, visibility: 'visible' } }), {
            lostTime,
        });
        expect(stallLine(text)).toBe('Longest stall overlapping the pull: 3500 ms (tab hidden)');
    });

    test('a window entirely before or after the pull is not an overlap', () => {
        const lostTime = {
            running: true,
            totalMs: 5000,
            windows: [
                { perfAt: 99_000, lostMs: 2000, visibilityState: 'hidden' },
                { perfAt: 109_000, lostMs: 2000, visibilityState: 'hidden' },
            ],
        };
        expect(stallLine(buildPullReport(timed(), { lostTime }))).toBe('Longest stall overlapping the pull: none');
    });

    test('a ring that has rolled past the pull says so rather than claiming none', () => {
        const lostTime = {
            running: true,
            totalMs: 90_000,
            windows: [{ perfAt: 900_000, lostMs: 1000, visibilityState: 'visible' }],
        };
        const text = buildPullReport(timed({ stall: { status: 'unmeasured', lostMs: null, visibility: null } }), {
            lostTime,
        });
        expect(stallLine(text)).toContain('older stalls have rolled off');
    });

    test('no diagnostics, or a malformed ring, costs the line and nothing else', () => {
        const unmeasured = { status: 'unmeasured', lostMs: null, visibility: null };
        for (const lostTime of [undefined, null, {}, { windows: 'x' }, { running: false, windows: [] }]) {
            const text = buildPullReport(timed({ stall: unmeasured }), { lostTime });
            expect(stallLine(text)).toBe('Longest stall overlapping the pull: not measured');
            expect(text).toContain('Pull timing: started');
        }
    });

    test('a pull that was never timed prints unknown', () => {
        const text = buildPullReport(buildPullSummary({ expected: {} }), {});
        expect(text).toContain('Pull timing: unknown');
    });
});

describe('what the report says about the ledger repair', () => {
    const repairLine = (text) => text.split('\n').find((l) => l.startsWith('Ledger repair'));
    const summary = () => buildPullSummary({ expected: {} });

    test('not run yet is told apart from a run that cut nothing', () => {
        expect(repairLine(buildPullReport(summary(), { ledgerRepair: { charId: '12345', runs: 0, cut: 0 } }))).toBe(
            'Ledger repair this session (character 12345): not run yet'
        );
        expect(repairLine(buildPullReport(summary(), { ledgerRepair: { charId: '12345', runs: 2, cut: 0 } }))).toBe(
            'Ledger repair this session (character 12345): 0 listings cut (2 runs)'
        );
    });

    test('counts the listings cut, singular and plural', () => {
        expect(repairLine(buildPullReport(summary(), { ledgerRepair: { charId: '12345', runs: 1, cut: 3 } }))).toBe(
            'Ledger repair this session (character 12345): 3 listings cut (1 run)'
        );
        expect(
            repairLine(buildPullReport(summary(), { ledgerRepair: { charId: 'default', runs: 1, cut: 1 } }))
        ).toContain('1 listing cut');
    });

    test('a store that could not be asked, or an answer of the wrong shape, prints unknown', () => {
        expect(repairLine(buildPullReport(summary(), {}))).toBe('Ledger repair this session: unknown');
        expect(repairLine(buildPullReport(summary(), { ledgerRepair: null }))).toBe(
            'Ledger repair this session: unknown'
        );
        expect(repairLine(buildPullReport(summary(), { ledgerRepair: { charId: '1', runs: 'x', cut: 1 } }))).toBe(
            'Ledger repair this session (character 1): unknown'
        );
    });

    test('an id that does not look like a character id is left out, not printed', () => {
        const line = repairLine(
            buildPullReport(summary(), { ledgerRepair: { charId: 'Quiet Cows 7!', runs: 1, cut: 0 } })
        );
        expect(line).toBe('Ledger repair this session: 0 listings cut (1 run)');
    });
});
