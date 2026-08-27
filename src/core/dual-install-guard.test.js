/**
 * @vitest-environment happy-dom
 *
 * Two Toolasha userscripts on one page share one database and one settings
 * map, and the one that saves last deletes the other's settings. Nothing here
 * can stop that; these are the two signals that notice it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const map = new Map();
    return {
        map,
        reset: () => map.clear(),
        getJSON: vi.fn(async (key, _store, fallback = null) =>
            map.has(key) ? structuredClone(map.get(key)) : fallback
        ),
        setJSON: vi.fn(async (key, value) => {
            map.set(key, structuredClone(value));
            return true;
        }),
    };
});

vi.mock('./storage.js', () => ({ default: storageMock }));

const { claimPage, claimLost, checkSettingsFingerprint, DUAL_INSTALL_MESSAGE } =
    await import('./dual-install-guard.js');

const KEY = 'script_settingsMap_char1';

beforeEach(() => {
    storageMock.reset();
    storageMock.getJSON.mockClear();
    storageMock.setJSON.mockClear();
    delete window.Toolasha;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the page claim', () => {
    test('an empty page is claimed without complaint', () => {
        expect(claimPage()).toBe(false);
        expect(claimLost()).toBe(false);
    });

    test("the fork's own bundles do not look like a second instance", () => {
        // Every @require bundle defines window.Toolasha by design, which is why
        // "the namespace already exists" would fire on every single load
        window.Toolasha = { Core: {}, Utils: {}, Market: {} };
        expect(claimPage()).toBe(false);
    });

    test('a claim already held by another instance is reported', () => {
        window.Toolasha = { [Symbol.for('noop')]: 1, __toolashaInstance: { id: 'someone-else', at: 1 } };
        expect(claimPage()).toBe(true);
    });

    test('a claim replaced after the fact is reported', () => {
        expect(claimPage()).toBe(false);
        window.Toolasha.__toolashaInstance = { id: 'arrived-later', at: 2 };
        expect(claimLost()).toBe(true);
    });

    test('a namespace reset out from under us reads as a lost claim', () => {
        claimPage();
        window.Toolasha = {};
        expect(claimLost()).toBe(true);
    });
});

describe('the settings fingerprint', () => {
    test('a first load records and accuses nobody', async () => {
        expect(await checkSettingsFingerprint(KEY, ['a', 'b'], '3.23.0')).toEqual([]);
    });

    test('an unchanged map on the next load is fine', async () => {
        await checkSettingsFingerprint(KEY, ['a', 'b'], '3.23.0');
        expect(await checkSettingsFingerprint(KEY, ['a', 'b'], '3.23.0')).toEqual([]);
    });

    test('ids that vanished between two loads of one build are reported', async () => {
        await checkSettingsFingerprint(KEY, ['a', 'b', 'forkOnly'], '3.23.0');
        // …the other script wrote its own whole schema over the map…
        expect(await checkSettingsFingerprint(KEY, ['a', 'b'], '3.23.0')).toEqual(['forkOnly']);
    });

    test('a build change is not an accusation — a schema legitimately loses ids', async () => {
        await checkSettingsFingerprint(KEY, ['a', 'b', 'retired'], '3.23.0');
        expect(await checkSettingsFingerprint(KEY, ['a', 'b'], '3.24.0')).toEqual([]);
    });

    test('an absent or empty map says nothing and records nothing', async () => {
        expect(await checkSettingsFingerprint(KEY, null, '3.23.0')).toEqual([]);
        expect(await checkSettingsFingerprint(KEY, [], '3.23.0')).toEqual([]);
        expect(storageMock.setJSON).not.toHaveBeenCalled();
    });

    test('each character is fingerprinted separately', async () => {
        await checkSettingsFingerprint(KEY, ['a', 'forkOnly'], '3.23.0');
        expect(await checkSettingsFingerprint('script_settingsMap_char2', ['a'], '3.23.0')).toEqual([]);
    });

    test('a storage failure is not an accusation', async () => {
        storageMock.getJSON.mockRejectedValueOnce(new Error('IndexedDB went away'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await checkSettingsFingerprint(KEY, ['a'], '3.23.0')).toEqual([]);
    });
});

describe('what the user is told', () => {
    test('the message names the cause and the fix', () => {
        expect(DUAL_INSTALL_MESSAGE).toContain('Two copies of Toolasha');
        expect(DUAL_INSTALL_MESSAGE).toContain('keep exactly one');
    });
});
