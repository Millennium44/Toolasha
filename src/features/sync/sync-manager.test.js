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

const character = vi.hoisted(() => ({ id: 'char-A' }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => character.id },
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

const dialog = vi.hoisted(() => ({ answer: null, calls: 0, last: null }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async (question) => {
        dialog.calls += 1;
        dialog.last = question;
        return dialog.answer;
    },
}));

const payload = vi.hoisted(() => ({ text: '{"local":1}' }));
vi.mock('./sync-payload.js', () => ({
    buildPayloadJSON: async () => payload.text,
    applyPayload: async (json) => {
        payload.applied = json;
        return { restored: {}, merged: payload.merged ?? [], exportedAt: null };
    },
    // Content hash, as the real one: the exportedAt stamp does not participate
    contentHash: (text) => `h:${String(text).replace(/"exportedAt":"[^"]*",/, '')}`,
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
    dialog.last = null;
    dialog.calls = 0;
    payload.text = '{"local":1}';
    payload.applied = undefined;
    payload.merged = [];
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
        syncManager.busySince = Date.now();
        expect((await syncManager.push()).reason).toBe('busy');
    });

    test('a sync wedged busy for long enough is taken over, not honoured forever', async () => {
        // The failure this guards: an abandoned conflict dialog (or a hung
        // request) held `busy` for the rest of the session, and every
        // 15-minute auto-push declined silently for days
        syncManager.busy = true;
        syncManager.busySince = Date.now() - 6 * 60 * 1000;
        const result = await syncManager.push();
        expect(result.ok).toBe(true);
        syncManager.busy = false;
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

    test('records when this device pushed, apart from the stamp a pull overwrites', async () => {
        await syncManager.push();
        expect(stored.map.toolasha_sync_lastPushedAt).toBe(stored.map.toolasha_sync_lastSyncedAt);
    });

    test('a pull moves the shared stamp but leaves the push stamp where it was', async () => {
        await syncManager.push();
        const pushedAt = stored.map.toolasha_sync_lastPushedAt;

        gist.read = {
            manifest: { exportedAt: '2027-02-01T00:00:00.000Z', chunks: 1, hash: 'h:remote' },
            payload: '{"remote":1}',
        };
        await syncManager.pull();

        // "This device applied someone else's export" is not "this device's data is
        // in the gist", which is why the two stamps are kept apart
        expect(stored.map.toolasha_sync_lastSyncedAt).toBe('2027-02-01T00:00:00.000Z');
        expect(stored.map.toolasha_sync_lastPushedAt).toBe(pushedAt);
    });

    test('adopts a gist the account already has instead of making a second', async () => {
        gist.found = 'existing';
        stored.map.toolasha_sync_lastSyncedAt = '2026-08-01T00:00:00Z';
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
        stored.map.toolasha_sync_lastSyncedAt = '2026-08-01T00:00:00Z';
        await syncManager.push();
        expect(gist.writes[0].previous).toBe(4);
    });

    test('a device that never synced must confirm before overwriting an existing gist', async () => {
        stored.map.toolasha_sync_gistId = 'rich-gist';
        dialog.answer = null;

        const result = await syncManager.push();
        expect(result).toEqual({ ok: true, skipped: true, reason: 'cancelled' });
        expect(dialog.calls).toBe(1);
        expect(gist.writes).toHaveLength(0);
    });

    test('confirming the overwrite pushes; a silent push never even asks', async () => {
        stored.map.toolasha_sync_gistId = 'rich-gist';

        const silent = await syncManager.push({ silent: true });
        expect(silent).toEqual({ ok: true, skipped: true, reason: 'never-synced' });
        expect(dialog.calls).toBe(0);

        dialog.answer = 'push';
        const result = await syncManager.push();
        expect(result.ok).toBe(true);
        expect(gist.writes).toHaveLength(1);
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

    test('the conflict dialog offers the merge first, and says what can and cannot be combined', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        dialog.answer = null;

        await syncManager.pull();

        expect(dialog.last.choices[0].value).toBe('merge');
        expect(dialog.last.choices.map((choice) => choice.value)).toEqual(['merge', 'pull', 'push', null]);
        expect(dialog.last.message).toContain('combined');
    });

    test('choosing the merge applies the union and pushes it straight back up', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        payload.merged = [{ store: 'settings', key: 'treasureTally_char', label: 'Treasure tally' }];
        dialog.answer = 'merge';

        const result = await syncManager.pull();

        expect(payload.applied).toBe('{"remote":1}');
        // The union only exists here until it is sent up, so the gist gets it
        expect(gist.writes).toHaveLength(1);
        expect(result).toMatchObject({ ok: true, merged: 1, pushedBack: true });
        expect(dialog.calls).toBe(1);
    });

    test('applying the GitHub copy here only does not push anything back', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        payload.merged = [{ store: 'settings', key: 'treasureTally_char', label: 'Treasure tally' }];
        dialog.answer = 'pull';

        const result = await syncManager.pull();

        expect(payload.applied).toBe('{"remote":1}');
        expect(gist.writes).toHaveLength(0);
        expect(result).toMatchObject({ ok: true, merged: 1 });
        expect(result.pushedBack).toBeUndefined();
    });

    test('an unattended pull that merges says how much was combined rather than replaced', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        gist.read = remote('2026-02-01T00:00:00.000Z');
        payload.merged = [
            { store: 'settings', key: 'treasureTally_char', label: 'Treasure tally' },
            { store: 'xpHistory', key: 'xpHistory_char', label: 'Skill XP history' },
        ];

        await syncManager.pull();

        expect(dialog.calls).toBe(0);
        expect(toasts.at(-1).message).toContain('2 records were combined');
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

/**
 * What the player is told when sync fails.
 *
 * A failure that only reaches the console is a failure nobody knows about, and
 * one that reaches a toast saying "sync failed" is one nobody can act on. So
 * every toast has to name which half failed, why, and — where the answer is not
 * simply "wait" — what to do next.
 */
describe('failure messages', () => {
    test('names the operation, the reason and the next step', async () => {
        gist.writeError = new FakeGistError('auth', 'GitHub rejected the token.');
        await syncManager.push();

        const toast = toasts.at(-1);
        expect(toast.message).toContain('Sync push failed');
        expect(toast.message).toContain('GitHub rejected the token.');
        expect(toast.message).toContain('Settings → Cross-Device Sync');
        // Something to do about it must not fade before it is read
        expect(toast.duration).toBe(0);
    });

    test('says pull when it was the pull', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        gist.readError = new FakeGistError('parse', 'The sync gist manifest is corrupt.');
        await syncManager.pull();
        expect(toasts.at(-1).message).toContain('Sync pull failed');
    });

    test('a payload too big says which setting shrinks it', async () => {
        gist.writeError = new FakeGistError('too-large', 'GitHub refused the payload.');
        await syncManager.push();
        expect(toasts.at(-1).message).toContain('Settings only');
    });

    test('adds nothing to a failure that already says when to come back', async () => {
        gist.writeError = new FakeGistError('rate-limit', 'GitHub is rate-limiting this token. Try again after 3pm.');
        await syncManager.push();

        const toast = toasts.at(-1);
        expect(toast.message).toBe('Sync push failed: GitHub is rate-limiting this token. Try again after 3pm.');
        // A limit that lifts on its own may fade on its own
        expect(toast.duration).toBeUndefined();
    });

    test('a bug in this script is still shown, with its message and a next step', async () => {
        gist.writeError = new TypeError('files is not iterable');
        const result = await syncManager.push();

        expect(result.reason).toBe('error');
        expect(toasts.at(-1).message).toContain('files is not iterable');
        expect(toasts.at(-1).kind).toBe('error');
    });

    test('an automatic push still speaks up — silence only covers "nothing to do"', async () => {
        stored.map.toolasha_sync_lastHash = 'h:something-else';
        gist.writeError = new FakeGistError('auth', 'GitHub rejected the token.');
        await syncManager.push({ silent: true });
        expect(toasts.at(-1).message).toContain('Sync push failed');
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

describe('passphrase encryption', () => {
    test('a set passphrase uploads ciphertext with the encryption record in the manifest', async () => {
        settings.values.sync_passphrase = 'moo moo';

        const result = await syncManager.push();
        expect(result.ok).toBe(true);

        const write = gist.writes[0];
        expect(write.manifest.encrypted).toMatchObject({ algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256' });
        // The chunk is ciphertext, not the payload; the hash is still the plaintext's
        expect(write.chunks[0]).not.toContain('local');
        expect(write.manifest.hash).toBe(`h:${payload.text}`);

        // Unwinding the full pipeline — decrypt, then gunzip — returns the payload
        const { decryptBytes } = await import('./sync-crypto.js');
        const { gunzipToText } = await import('./sync-compress.js');
        const opened = await decryptBytes({ ...write.manifest.encrypted, ciphertext: write.chunks[0] }, 'moo moo');
        expect(write.manifest.compressed).toBe('gzip');
        await expect(gunzipToText(opened)).resolves.toBe(payload.text);
    });

    test('no passphrase means no encryption record — the gist is gzip, readable with no secret', async () => {
        const result = await syncManager.push();
        expect(result.ok).toBe(true);

        const write = gist.writes[0];
        expect(write.manifest.encrypted).toBeUndefined();
        expect(write.manifest.compressed).toBe('gzip');

        const { base64ToBytes } = await import('./sync-crypto.js');
        const { gunzipToText } = await import('./sync-compress.js');
        await expect(gunzipToText(base64ToBytes(write.chunks[0]))).resolves.toBe(payload.text);
    });

    test('pulling a compressed unencrypted gist decompresses before applying', async () => {
        const { gzipText } = await import('./sync-compress.js');
        const { bytesToBase64 } = await import('./sync-crypto.js');
        const remote = '{"remote":3}';

        stored.map['toolasha_sync_gistId'] = 'gist-1';
        gist.read = {
            manifest: { exportedAt: '2026-08-05T12:00:00Z', chunks: 1, hash: `h:${remote}`, compressed: 'gzip' },
            payload: bytesToBase64(await gzipText(remote)),
        };

        const result = await syncManager.pull();
        expect(result.ok).toBe(true);
        expect(payload.applied).toBe(remote);
    });

    test('pulling a compressed and encrypted gist unwinds both layers', async () => {
        settings.values.sync_passphrase = 'moo moo';
        const { gzipText } = await import('./sync-compress.js');
        const { encryptBytes } = await import('./sync-crypto.js');
        const remote = '{"remote":4}';
        const sealed = await encryptBytes(await gzipText(remote), 'moo moo');

        stored.map['toolasha_sync_gistId'] = 'gist-1';
        gist.read = {
            manifest: {
                exportedAt: '2026-08-05T12:00:00Z',
                chunks: 1,
                hash: `h:${remote}`,
                compressed: 'gzip',
                encrypted: { iterations: sealed.iterations, salt: sealed.salt, iv: sealed.iv },
            },
            payload: sealed.ciphertext,
        };

        const result = await syncManager.pull();
        expect(result.ok).toBe(true);
        expect(payload.applied).toBe(remote);
    });

    test('pulling an encrypted gist decrypts before applying', async () => {
        settings.values.sync_passphrase = 'moo moo';
        const { encryptText } = await import('./sync-crypto.js');
        const remote = '{"remote":2}';
        const sealed = await encryptText(remote, 'moo moo');

        stored.map['toolasha_sync_gistId'] = 'gist-1';
        gist.read = {
            manifest: {
                exportedAt: '2026-08-05T12:00:00Z',
                chunks: 1,
                hash: `h:${remote}`,
                encrypted: { iterations: sealed.iterations, salt: sealed.salt, iv: sealed.iv },
            },
            payload: sealed.ciphertext,
        };

        const result = await syncManager.pull();
        expect(result.ok).toBe(true);
        expect(payload.applied).toBe(remote);
    });

    test('pulling an encrypted gist without a passphrase fails with the passphrase remedy', async () => {
        stored.map['toolasha_sync_gistId'] = 'gist-1';
        gist.read = {
            manifest: {
                exportedAt: '2026-08-05T12:00:00Z',
                chunks: 1,
                encrypted: { iterations: 1, salt: 'a', iv: 'b' },
            },
            payload: 'zzz',
        };

        const result = await syncManager.pull();
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('passphrase');
        expect(toasts.at(-1).message).toContain('passphrase');
        expect(payload.applied).toBeUndefined();
    });

    test('a wrong passphrase on pull fails cleanly and applies nothing', async () => {
        settings.values.sync_passphrase = 'wrong one';
        const { encryptText } = await import('./sync-crypto.js');
        const sealed = await encryptText('{"remote":2}', 'right one');

        stored.map['toolasha_sync_gistId'] = 'gist-1';
        gist.read = {
            manifest: {
                exportedAt: '2026-08-05T12:00:00Z',
                chunks: 1,
                encrypted: { iterations: sealed.iterations, salt: sealed.salt, iv: sealed.iv },
            },
            payload: sealed.ciphertext,
        };

        const result = await syncManager.pull();
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('passphrase');
        expect(payload.applied).toBeUndefined();
    });
});

describe('the silent startup pull never raises a dialog', () => {
    test('both sides changed in silent mode stands down as a conflict, without asking', async () => {
        stored.map.toolasha_sync_gistId = 'abc';
        stored.map.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        stored.map.toolasha_sync_lastHash = 'h:what-we-pushed'; // local content differs
        gist.read = {
            manifest: { exportedAt: '2026-02-01T00:00:00.000Z', chunks: 1, hash: 'h:remote' },
            payload: '{"remote":1}',
        };
        dialog.answer = 'pull'; // would apply, if anything dared ask

        const result = await syncManager.pull({ silent: true });
        expect(result).toMatchObject({ skipped: true, reason: 'conflict' });
        expect(dialog.calls).toBe(0);
        expect(payload.applied).toBeUndefined();
    });
});

describe('push on character switch', () => {
    test('a re-initialise for a different character schedules one silent push; a page load does not', async () => {
        vi.useFakeTimers();
        settings.values.sync_onSwitch = true;
        character.id = 'char-A';
        const pushes = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });

        try {
            // First initialise of the page: never fires, whatever the setting says
            syncManager.cleanup();
            await syncManager.initialize();
            await vi.advanceTimersByTimeAsync(6 * 1000);
            expect(pushes).not.toHaveBeenCalled();

            // The switch: teardown, another character, re-initialise
            syncManager.cleanup();
            character.id = 'char-B';
            await syncManager.initialize();
            await vi.advanceTimersByTimeAsync(6 * 1000);
            expect(pushes).toHaveBeenCalledTimes(1);
            expect(pushes).toHaveBeenCalledWith({ silent: true });

            // The same character again is not a switch
            syncManager.cleanup();
            await syncManager.initialize();
            await vi.advanceTimersByTimeAsync(6 * 1000);
            expect(pushes).toHaveBeenCalledTimes(1);
        } finally {
            syncManager.cleanup();
            pushes.mockRestore();
            vi.useRealTimers();
        }
    });
});
