import { describe, test, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
    value: undefined,
    teardown: [],
    updates: 0,
    failUpdate: false,
}));

vi.mock('./storage.js', () => ({
    default: {
        update: async (key, mutate) => {
            store.updates += 1;
            if (store.failUpdate) return null;
            store.value = mutate(store.value);
            return { written: true, value: store.value };
        },
        get: async (key, storeName, fallback) => (store.value === undefined ? fallback : store.value),
        onBeforeTeardown: (fn) => {
            store.teardown.push(fn);
            return () => {};
        },
    },
}));

import * as reloadLog from './reload-log.js';

const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
    reloadLog.resetReloadLog();
    store.value = undefined;
    store.teardown = [];
    store.updates = 0;
    store.failUpdate = false;
});

describe('recording', () => {
    test('a prompt writes one entry with the documented fields', async () => {
        const handle = reloadLog.recordReloadPrompt({
            source: 'sync-pull',
            message: 'Reload now',
            records: ['Personal trade prices', 'Personal trade prices', 'Watchlist'],
            characterId: 30404,
        });
        await settle();
        const entries = await reloadLog.readEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            id: handle.id,
            source: 'sync-pull',
            kind: 'data-changed',
            message: 'Reload now',
            records: ['Personal trade prices', 'Watchlist'],
            characterId: 30404,
            outcome: 'unknown',
            shownMs: null,
        });
        expect(typeof entries[0].at).toBe('number');
    });

    test('each source records its own entry', async () => {
        for (const source of ['sync-pull', 'restore', 'tab-version', 'recovery']) {
            reloadLog.recordReloadPrompt({ source, message: source });
        }
        await settle();
        const entries = await reloadLog.readEntries();
        expect(entries.map((e) => e.source)).toEqual(['sync-pull', 'restore', 'tab-version', 'recovery']);
    });

    test('keeps only the last 200 entries', async () => {
        store.value = Array.from({ length: 199 }, (_, i) => ({ id: `old${i}`, at: i, source: 's', outcome: 'x' }));
        for (let i = 0; i < 3; i++) reloadLog.recordReloadPrompt({ source: 'n', message: String(i) });
        await settle();
        const entries = await reloadLog.readEntries();
        expect(entries).toHaveLength(200);
        expect(entries[0].id).toBe('old2');
        expect(entries.at(-1).message).toBe('2');
    });

    test('a long record list is cut and counted', async () => {
        reloadLog.recordReloadPrompt({
            source: 's',
            message: 'm',
            records: Array.from({ length: 50 }, (_, i) => `r${i}`),
        });
        await settle();
        const [entry] = await reloadLog.readEntries();
        expect(entry.records).toHaveLength(41);
        expect(entry.records.at(-1)).toBe('…and 10 more');
    });

    test('empty input still records an entry', async () => {
        reloadLog.recordReloadPrompt();
        await settle();
        const [entry] = await reloadLog.readEntries();
        expect(entry).toMatchObject({ source: 'unknown', records: [], characterId: null });
    });

    test('turned off: nothing is written, listeners still hear it', async () => {
        reloadLog.setEnabledProvider(() => false);
        const heard = vi.fn();
        reloadLog.onPrompt(heard);
        const handle = reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        handle.settle('reloaded');
        await settle();
        expect(store.updates).toBe(0);
        expect(store.teardown).toHaveLength(0);
        expect(heard).toHaveBeenCalledWith(handle);
        expect(await reloadLog.readEntries()).toEqual([]);
    });

    test('a failed write leaves the entry to the page-close write', async () => {
        store.failUpdate = true;
        reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        await settle();
        expect(store.value).toBeUndefined();
        store.failUpdate = false;
        store.teardown[0]('pagehide');
        await settle();
        expect(store.value).toHaveLength(1);
        expect(store.value[0].outcome).toBe('page-closed');
    });
});

describe('outcomes', () => {
    test('an outcome fills in the entry and the time shown', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
        const handle = reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        vi.setSystemTime(new Date('2026-11-12T10:00:07Z'));
        handle.settle('auto-reloaded');
        vi.useRealTimers();
        await settle();
        const [entry] = await reloadLog.readEntries();
        expect(entry.outcome).toBe('auto-reloaded');
        expect(entry.shownMs).toBe(7000);
    });

    test('a weaker outcome never replaces a stronger one; a reload replaces a dismissal', async () => {
        const handle = reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        handle.settle('dismissed');
        handle.settle('page-closed');
        expect(handle.outcome()).toBe('dismissed');
        handle.settle('auto-reloaded');
        handle.settle('cancelled');
        await settle();
        const [entry] = await reloadLog.readEntries();
        expect(entry.outcome).toBe('auto-reloaded');
    });

    test('the page closing marks unanswered prompts page-closed and keeps answered ones', async () => {
        const answered = reloadLog.recordReloadPrompt({ source: 'a', message: 'm' });
        reloadLog.recordReloadPrompt({ source: 'b', message: 'm' });
        answered.settle('reloaded');
        await settle();
        store.teardown[0]('pagehide');
        await settle();
        const entries = await reloadLog.readEntries();
        expect(entries.map((e) => e.outcome)).toEqual(['reloaded', 'page-closed']);
        expect(store.teardown).toHaveLength(1);
    });

    test('the close write carries an entry whose first write has not landed', async () => {
        store.failUpdate = true;
        const handle = reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        handle.settle('reloaded');
        await settle();
        store.failUpdate = false;
        store.teardown[0]('pagehide');
        await settle();
        expect(store.value).toHaveLength(1);
        expect(store.value[0].outcome).toBe('reloaded');
    });

    test('entries from another tab are kept when this page writes', async () => {
        store.value = [{ id: 'other', at: 1, source: 'sync-pull', outcome: 'reloaded' }];
        reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        await settle();
        expect((await reloadLog.readEntries()).map((e) => e.id)[0]).toBe('other');
    });

    test('clearing forgets prompts still open so a later outcome cannot write them back', async () => {
        const handle = reloadLog.recordReloadPrompt({ source: 's', message: 'm' });
        await settle();
        expect(await reloadLog.clearLog()).toBe(true);
        handle.settle('reloaded');
        await settle();
        expect(await reloadLog.readEntries()).toEqual([]);
    });
});

describe('device-only registration', () => {
    test('the key is under the local-only prefix, so the sync leaves it on the device', async () => {
        const { LOCAL_ONLY_KEY_PREFIXES } = await import('../features/sync/sync-payload.js');
        const { ownsKey } = await import('../features/sync/sync-ownership.js');
        expect(LOCAL_ONLY_KEY_PREFIXES.some((prefix) => reloadLog.LOG_KEY.startsWith(prefix))).toBe(true);
        expect(ownsKey('settings', reloadLog.LOG_KEY)).toBe(true);
    });
});

describe('the pasted text', () => {
    test('counts by source, outcome and record label before the entries', () => {
        const base = { kind: 'data-changed', characterId: 1 };
        const text = reloadLog.formatReloadLog([
            {
                ...base,
                at: 0,
                source: 'sync-pull',
                outcome: 'reloaded',
                shownMs: 4000,
                records: ['A', 'B'],
                message: 'm1',
            },
            {
                ...base,
                at: 1000,
                source: 'sync-pull',
                outcome: 'page-closed',
                shownMs: null,
                records: ['A'],
                message: 'm2',
            },
            { ...base, at: 2000, source: 'restore', outcome: 'unknown', shownMs: null, records: [], message: 'm3' },
        ]);
        expect(text).toContain('3 prompts');
        expect(text).toMatch(/sync-pull: 2/);
        expect(text).toMatch(/restore: 1/);
        expect(text).toMatch(/A: 2/);
        expect(text).toMatch(/B: 1/);
        expect(text.indexOf('By source')).toBeLessThan(text.indexOf('Entries'));
        expect(text).toContain('records: none named');
        expect(reloadLog.formatReloadLog([])).toMatch(/no reload prompts/);
    });
});
