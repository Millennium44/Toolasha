import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    values: { sync_enabled: true, sync_token: 'ghp_secret', sync_scope: 'settings', sync_auto: false },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => settings.values[key] ?? fallback,
        onSettingChange: () => {},
        offSettingChange: () => {},
    },
}));

const stored = vi.hoisted(() => ({ map: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => stored.map[key] ?? fallback,
        set: async (key, value) => {
            stored.map[key] = value;
        },
    },
}));

const toasts = vi.hoisted(() => []);
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.push({ message, ...options });
        return null;
    },
}));

const dialog = vi.hoisted(() => ({ answer: null, calls: 0 }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async () => {
        dialog.calls += 1;
        return dialog.answer;
    },
}));

const payload = vi.hoisted(() => ({ text: '{"local":1}' }));
vi.mock('./sync-payload.js', () => ({
    buildPayloadJSON: async () => payload.text,
    applyPayload: async (json) => {
        payload.applied = json;
        return { restored: {}, exportedAt: null };
    },
    hashPayload: (text) => `h:${text}`,
}));

const gist = vi.hoisted(() => ({
    found: null,
    read: null,
    readError: null,
    writeError: null,
    writes: [],
}));

class FakeGistError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

vi.mock('./gist-client.js', () => ({
    GistError: FakeGistError,
    chunkPayload: (text) => [text],
    findSyncGist: async () => gist.found,
    readSyncGist: async () => {
        if (gist.readError) throw gist.readError;
        return gist.read;
    },
    writeSyncGist: async (_token, id, manifest, chunks, previous) => {
        if (gist.writeError) throw gist.writeError;
        gist.writes.push({ id, manifest, chunks, previous });
        return { id: id ?? 'created-id', updatedAt: 'now' };
    },
}));

const { default: syncManager, isNewer } = await import('./sync-manager.js');

beforeEach(() => {
    settings.values = { sync_enabled: true, sync_token: 'ghp_secret', sync_scope: 'settings', sync_auto: false };
    stored.map = {};
    toasts.length = 0;
    dialog.answer = null;
    dialog.calls = 0;
    payload.text = '{"local":1}';
    payload.applied = undefined;
    gist.found = null;
    gist.read = null;
    gist.readError = null;
    gist.writeError = null;
    gist.writes = [];
    syncManager.busy = false;
});

describe('guards', () => {
    test('a push with sync off does nothing and says so', async () => {
        settings.values.sync_enabled = false;
        const result = await syncManager.push();
        expect(result).toEqual({ ok: false, reason: 'disabled' });
        expect(gist.writes).toHaveLength(0);
        expect(toasts[0].kind).toBe('warn');
    });

    test('a push with no token points at where to put one', async () => {
        settings.values.sync_token = '   ';
        const result = await syncManager.push();
        expect(result.reason).toBe('no-token');
        expect(gist.writes).toHaveLength(0);
    });

    test('a second concurrent operation is refused rather than interleaved', async () => {
        syncManager.busy = true;
        expect((await syncManager.push()).reason).toBe('busy');
    });
});

describe('push', () => {
    test('creates a gist the first time and remembers its id', async () => {
        const result = await syncManager.push();
        expect(result.ok).toBe(true);
        expect(gist.writes[0].id).toBeNull();
        expect(stored.map.toolasha_sync_gistId).toBe('created-id');
        expect(stored.map.toolasha_sync_lastHash).toBe('h:{"local":1}');
    });

    test('adopts a gist the account already has instead of making a second', async () => {
        gist.found = 'existing';
        await syncManager.push();
        expect(gist.writes[0].id).toBe('existing');
    });

    test('a silent push skips when nothing changed since the last one', async () => {
        stored.map.toolasha_sync_lastHash = 'h:{"local":1}';
        const result = await syncManager.push({ silent: true });
        expect(result).toEqual({ ok: true, skipped: true, reason: 'unchanged' });
        expect(gist.writes).toHaveLength(0);
    });

    test('a silent push runs when something did change', async () => {
        stored.map.toolasha_sync_lastHash = 'h:something-else';
        expect((await syncManager.push({ silent: true })).ok).toBe(true);
        expect(gist.writes).toHaveLength(1);
    });

    test('tells the writer how many chunks to clean up', async () => {
        stored.map.toolasha_sync_chunkCount = 4;
        stored.map.toolasha_sync_gistId = 'abc';
        await syncManager.push();
        expect(gist.writes[0].previous).toBe(4);
    });

    test('a rate limit is a warning toast, not a thrown error', async () => {
        gist.writeError = new FakeGistError('rate-limit', 'GitHub is rate-limiting this token.');
        const result = await syncManager.push();
        expect(result).toEqual({ ok: false, reason: 'rate-limit' });
        expect(toasts.at(-1)).toMatchObject({ kind: 'warn' });
    });

    test('being offline fails soft', async () => {
        gist.writeError = new FakeGistError('offline', 'Could not reach GitHub.');
        expect((await syncManager.push()).ok).toBe(false);
        expect(toasts.at(-1).kind).toBe('error');
    });
});

describe('pull', () => {
    const remote = (exportedAt, body = '{"remote":1}') => ({
        manifest: { exportedAt, chunks: 1, hash: 'h:remote' },
        payload: body,
    });

    test('says there is nothing to pull when the account has no gist', async () => {
        const result = await syncManager.pull();
        expect(result).toMatchObject({ skipped: true, reason: 'no-gist' });
    });

    test('applies a remote copy newer than what this device last synced', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:{"local":1}';
        gist.read = remote('2026-02-01T00:00:00.000Z');

        const result = await syncManager.pull();

        expect(result.ok).toBe(true);
        expect(payload.applied).toBe('{"remote":1}');
        expect(stored.map.toolasha_sync_lastSyncedAt).toBe('2026-02-01T00:00:00.000Z');
        expect(dialog.calls).toBe(0);
    });

    test('leaves everything alone when the remote is not newer', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-03-01T00:00:00.000Z';
        gist.read = remote('2026-02-01T00:00:00.000Z');

        const result = await syncManager.pull();

        expect(result).toMatchObject({ skipped: true, reason: 'not-newer' });
        expect(payload.applied).toBeUndefined();
    });

    test('asks first when both sides moved, and honours "keep this device"', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        dialog.answer = 'push';

        const result = await syncManager.pull();

        expect(dialog.calls).toBe(1);
        expect(payload.applied).toBeUndefined();
        expect(gist.writes).toHaveLength(1);
        expect(result.ok).toBe(true);
    });

    test('dismissing the conflict dialog changes nothing on either side', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        dialog.answer = null;

        const result = await syncManager.pull();

        expect(result).toMatchObject({ skipped: true, reason: 'cancelled' });
        expect(payload.applied).toBeUndefined();
        expect(gist.writes).toHaveLength(0);
    });

    test('choosing the remote copy applies it', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        dialog.answer = 'pull';

        await syncManager.pull();

        expect(payload.applied).toBe('{"remote":1}');
    });

    test('a first sync on a fresh device applies without asking', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        gist.read = remote('2026-02-01T00:00:00.000Z');

        await syncManager.pull();

        expect(dialog.calls).toBe(0);
        expect(payload.applied).toBe('{"remote":1}');
    });

    test('a deleted gist unlinks this device so the next push recreates it', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        gist.readError = new FakeGistError('not-found', 'That gist no longer exists.');

        const result = await syncManager.pull();

        expect(result.reason).toBe('not-found');
        expect(stored.map.toolasha_sync_gistId).toBeNull();
        expect(stored.map.toolasha_sync_lastSyncedAt).toBeNull();
    });
});

describe('isNewer', () => {
    test('anything beats never having synced', () => {
        expect(isNewer('2026-01-01T00:00:00Z', null)).toBe(true);
    });

    test('an equal timestamp is not newer, so a re-read is not a re-apply', () => {
        expect(isNewer('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(false);
    });

    test('a missing or unparseable remote timestamp never wins', () => {
        expect(isNewer(null, '2026-01-01T00:00:00Z')).toBe(false);
        expect(isNewer('not a date', '2026-01-01T00:00:00Z')).toBe(false);
    });
});

describe('describeStatus', () => {
    test('names the thing that is missing', async () => {
        settings.values.sync_enabled = false;
        expect(await syncManager.describeStatus()).toContain('off');

        settings.values.sync_enabled = true;
        settings.values.sync_token = '';
        expect(await syncManager.describeStatus()).toContain('no GitHub token');
    });

    test('reports the last sync once there has been one', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-02-01T00:00:00.000Z';
        expect(await syncManager.describeStatus()).toMatch(/^Last synced /);
    });
});
