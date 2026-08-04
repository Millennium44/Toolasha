import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import {
    GistError,
    MANIFEST_FILE,
    chunkPayload,
    chunkFileName,
    findSyncGist,
    readSyncGist,
    writeSyncGist,
} from './gist-client.js';

/** Requests the fake transport saw, newest last */
let calls;
/** Queued responses, consumed in order */
let responses;

beforeEach(() => {
    calls = [];
    responses = [];
    globalThis.GM_xmlhttpRequest = (options) => {
        calls.push(options);
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected request to ${options.url}`);
        if (next.networkError) {
            options.onerror();
            return;
        }
        options.onload({
            status: next.status ?? 200,
            responseText: typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}),
            responseHeaders: Object.entries(next.headers || {})
                .map(([name, value]) => `${name}: ${value}`)
                .join('\r\n'),
        });
    };
});

afterEach(() => {
    delete globalThis.GM_xmlhttpRequest;
});

describe('chunkPayload', () => {
    test('splits at the ceiling and rejoins to the original', () => {
        const text = 'x'.repeat(2500);
        const chunks = chunkPayload(text, 1000);
        expect(chunks).toHaveLength(3);
        expect(chunks.join('')).toBe(text);
    });

    test('never splits a surrogate pair', () => {
        // Each emoji is two code units, so a ceiling of 3 would land mid-pair
        const text = '😀😀😀';
        const chunks = chunkPayload(text, 3);
        expect(chunks.join('')).toBe(text);
        for (const chunk of chunks) expect([...chunk].every((char) => char === '😀')).toBe(true);
    });

    test('an empty payload is still one chunk, because a gist file cannot be absent', () => {
        expect(chunkPayload('')).toEqual(['']);
    });

    test('names sort in gist order', () => {
        expect([chunkFileName(10), chunkFileName(2)].sort()).toEqual([chunkFileName(2), chunkFileName(10)]);
    });
});

describe('error classification', () => {
    test('401 is an auth problem, and the message mentions the gist scope', async () => {
        responses.push({ status: 401, body: { message: 'Bad credentials' } });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'auth' });
    });

    test('403 with no quota left is a rate limit, with a reset time', async () => {
        const reset = Math.floor(Date.now() / 1000) + 600;
        responses.push({
            status: 403,
            headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) },
            body: {},
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('rate-limit');
        expect(error.resetAt).toBeInstanceOf(Date);
    });

    test('403 with quota remaining is a scope problem, not a rate limit', async () => {
        responses.push({ status: 403, headers: { 'X-RateLimit-Remaining': '4000' }, body: {} });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'auth' });
    });

    test('404 says the gist is gone', async () => {
        responses.push({ status: 404, body: {} });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'not-found' });
    });

    test('a dead network is offline, not an HTTP failure', async () => {
        responses.push({ networkError: true });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'offline' });
    });

    test('a missing token fails before any request is made', async () => {
        await expect(findSyncGist('')).rejects.toMatchObject({ kind: 'auth' });
        expect(calls).toHaveLength(0);
    });
});

describe('token handling', () => {
    test('the token travels in a header and never in the URL', async () => {
        responses.push({ status: 200, body: [] });
        await findSyncGist('ghp_secret');
        expect(calls[0].url).not.toContain('ghp_secret');
        expect(calls[0].headers.Authorization).toBe('Bearer ghp_secret');
    });

    test('an error message never carries the token', async () => {
        responses.push({ status: 500, body: {} });
        const error = await findSyncGist('ghp_secret').catch((caught) => caught);
        expect(error).toBeInstanceOf(GistError);
        expect(JSON.stringify({ message: error.message })).not.toContain('ghp_secret');
    });
});

describe('findSyncGist', () => {
    test('recognises a sync gist by its manifest file', async () => {
        responses.push({
            status: 200,
            body: [
                { id: 'other', files: { 'notes.md': {} } },
                { id: 'ours', files: { [MANIFEST_FILE]: {} } },
            ],
        });
        expect(await findSyncGist('tok')).toBe('ours');
    });

    test('returns null when the account has none', async () => {
        responses.push({ status: 200, body: [{ id: 'other', files: { 'notes.md': {} } }] });
        expect(await findSyncGist('tok')).toBeNull();
    });
});

describe('readSyncGist', () => {
    test('reassembles chunks in manifest order', async () => {
        responses.push({
            status: 200,
            body: {
                updated_at: '2026-01-01T00:00:00Z',
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ chunks: 2, exportedAt: 'T' }) },
                    [chunkFileName(0)]: { content: '{"a":' },
                    [chunkFileName(1)]: { content: '1}' },
                },
            },
        });
        const { payload, manifest } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('{"a":1}');
        expect(manifest.exportedAt).toBe('T');
    });

    test('follows raw_url for a file the API truncated', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ chunks: 1 }) },
                    [chunkFileName(0)]: { truncated: true, raw_url: 'https://gist.example/raw', content: 'partial' },
                },
            },
        });
        responses.push({ status: 200, body: 'the-whole-thing' });

        const { payload } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('the-whole-thing');
        expect(calls[1].url).toBe('https://gist.example/raw');
    });

    test('a gist without a manifest is not ours', async () => {
        responses.push({ status: 200, body: { files: { 'notes.md': { content: 'hi' } } } });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'parse' });
    });

    test('a missing chunk fails loudly rather than returning half a backup', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ chunks: 2 }) },
                    [chunkFileName(0)]: { content: 'half' },
                },
            },
        });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'parse' });
    });
});

describe('writeSyncGist', () => {
    test('creates a private gist when there is no id', async () => {
        responses.push({ status: 201, body: { id: 'new-id', updated_at: 'T' } });
        const result = await writeSyncGist('tok', null, { chunks: 1 }, ['data']);
        expect(result.id).toBe('new-id');
        expect(calls[0].method).toBe('POST');
        expect(JSON.parse(calls[0].data).public).toBe(false);
    });

    test('patches an existing gist rather than making a second one', async () => {
        responses.push({ status: 200, body: { id: 'abc', updated_at: 'T' } });
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']);
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].url).toContain('/gists/abc');
    });

    test('deletes chunk files a shrinking payload no longer needs', async () => {
        responses.push({ status: 200, body: { id: 'abc' } });
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data'], 3);
        const { files } = JSON.parse(calls[0].data);
        expect(files[chunkFileName(0)]).toEqual({ content: 'data' });
        expect(files[chunkFileName(1)]).toBeNull();
        expect(files[chunkFileName(2)]).toBeNull();
    });

    test('refuses a payload too large for one gist before spending the upload', async () => {
        const huge = ['x'.repeat(9_000_001)];
        await expect(writeSyncGist('tok', 'abc', {}, huge)).rejects.toMatchObject({ kind: 'too-large' });
        expect(calls).toHaveLength(0);
    });
});
