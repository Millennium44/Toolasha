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
