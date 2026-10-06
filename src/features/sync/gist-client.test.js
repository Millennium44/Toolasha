import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    GistError,
    MANIFEST_FILE,
    chunkPayload,
    chunkFileName,
    chunkIndexFromName,
    findSyncGist,
    httpRequest,
    readSyncGist,
    resetTransportForTests,
    writeSyncGist,
} from './gist-client.js';
import { getGmTrafficSnapshot, resetGmTraffic } from '../../utils/gm-traffic.js';

/**
 * Requests either fake transport saw, newest last, in the GM details shape
 * (`data` is the body) with `transport` saying which one carried it.
 */
let calls;
/**
 * Queued responses, consumed in order by whichever transport asks next.
 * `networkError` fails either transport; `fetchThrows` fails only a page fetch,
 * the way a CORS or CSP refusal does.
 */
let responses;

const bodyText = (next) => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}));

beforeEach(() => {
    calls = [];
    responses = [];
    resetTransportForTests?.();
    globalThis.GM_xmlhttpRequest = (options) => {
        calls.push({ ...options, transport: 'gm' });
        const queued = responses.shift();
        const next = typeof queued === 'function' ? queued(options) : queued;
        if (!next) throw new Error(`Unexpected request to ${options.url}`);
        if (next.networkError) {
            options.onerror();
            return;
        }
        options.onload({
            status: next.status ?? 200,
            responseText: bodyText(next),
            responseHeaders: Object.entries(next.headers || {})
                .map(([name, value]) => `${name}: ${value}`)
                .join('\r\n'),
        });
    };
    vi.stubGlobal('fetch', async (url, init = {}) => {
        calls.push({ ...init, url, data: init.body, transport: 'fetch' });
        const queued = responses.shift();
        const next = typeof queued === 'function' ? queued({ ...init, url }) : queued;
        if (!next) throw new Error(`Unexpected request to ${url}`);
        if (next.hang) {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        }
        if (next.networkError || next.fetchThrows) throw new TypeError('NetworkError when attempting to fetch');
        const status = next.status ?? 200;
        return {
            status,
            text: async () => (status === 304 ? '' : bodyText(next)),
            headers: new Headers(next.headers || {}),
        };
    });
});

afterEach(() => {
    delete globalThis.GM_xmlhttpRequest;
    vi.unstubAllGlobals();
});

describe('transport', () => {
    test('api.github.com goes through the page fetch, never the userscript manager', async () => {
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');
        expect(calls).toHaveLength(1);
        expect(calls[0].transport).toBe('fetch');
        expect(calls[0].credentials).toBe('omit');
        expect(calls[0].cache).toBe('no-store');
        expect(calls[0].headers.Authorization).toBe('Bearer tok');
    });

    test('an HTTP error is an answer: a 401 and a 409 never reach the userscript manager', async () => {
        responses.push({ status: 401, body: { message: 'Bad credentials' } });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'auth' });

        vi.useFakeTimers();
        try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                responses.push({ status: 200, body: { files: {} } });
                responses.push({ status: 409, body: { message: 'Conflict' } });
            }
            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']).catch((caught) => caught);
            await vi.advanceTimersByTimeAsync(10_000);
            expect((await pending).kind).toBe('conflict');
        } finally {
            vi.useRealTimers();
        }

        expect(calls.length).toBeGreaterThan(1);
        expect(calls.every((call) => call.transport === 'fetch')).toBe(true);
    });

    test('a thrown page fetch falls back to the manager, and only a repeated failure keeps it there', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // One failure is a blip: the next request tries the page fetch again
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        expect(calls.map((call) => call.transport)).toEqual(['fetch', 'gm']);

        // Three in a row that the manager answers is a block (CORS, a CSP): the session stays on it
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');
        expect(calls.map((call) => call.transport)).toEqual(['fetch', 'gm', 'fetch', 'gm', 'fetch', 'gm', 'gm']);
        warn.mockRestore();
    });

    test('a page fetch that succeeds in between starts the failure count again', async () => {
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');

        expect(calls.at(-1).transport).toBe('fetch');
    });

    test('a dead network on both transports breaks the run of failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ networkError: true }, { networkError: true });
        await findSyncGist('tok').catch(() => {});
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');

        expect(calls.at(-1).transport).toBe('fetch');
        warn.mockRestore();
    });

    test('creating a gist goes straight to the manager once a page fetch failed where it got through', async () => {
        // The listing before a first push: the page fetch is blocked, the manager answers
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ status: 201, body: { id: 'g1', files: {} } });
        await httpRequest({ method: 'POST', url: 'https://api.github.com/gists', body: '{}' });

        expect(calls.map((call) => call.transport)).toEqual(['fetch', 'gm', 'gm']);
    });

    test('a page fetch that fails on a whole-gist PATCH is not replayed over a possibly newer gist', async () => {
        responses.push({ fetchThrows: true });
        await expect(
            httpRequest({ method: 'PATCH', url: 'https://api.github.com/gists/g1', body: '{}' })
        ).rejects.toMatchObject({ kind: 'offline' });

        expect(calls.map((call) => call.transport)).toEqual(['fetch']);
    });

    test('a page fetch timeout breaks the run of failures', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            responses.push({ fetchThrows: true }, { status: 200, body: [] });
            await findSyncGist('tok');
            responses.push({ fetchThrows: true }, { status: 200, body: [] });
            await findSyncGist('tok');
            responses.push({ hang: true });
            const pending = findSyncGist('tok').catch(() => {});
            await vi.advanceTimersByTimeAsync(30_000);
            await pending;
            responses.push({ fetchThrows: true }, { status: 200, body: [] });
            await findSyncGist('tok');
            responses.push({ status: 200, body: [] });
            await findSyncGist('tok');

            expect(calls.at(-1).transport).toBe('fetch');
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });

    test('a page fetch that fails on a POST is not replayed, so a gist is never created twice', async () => {
        responses.push({ fetchThrows: true });
        await expect(
            httpRequest({ method: 'POST', url: 'https://api.github.com/gists', body: '{}' })
        ).rejects.toMatchObject({ kind: 'offline' });

        expect(calls.map((call) => call.transport)).toEqual(['fetch']);
    });

    test('a 5xx answer in the middle breaks the run of failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ fetchThrows: true }, { status: 503, body: 'unavailable' });
        await findSyncGist('tok').catch(() => {});
        responses.push({ fetchThrows: true }, { status: 200, body: [] });
        await findSyncGist('tok');
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');

        // Not three in a row, so the page fetch is still tried
        expect(calls.at(-1).transport).toBe('fetch');
        warn.mockRestore();
    });

    test('an edge error page with no CORS header never moves the session onto the manager', async () => {
        // The 502 page throws the fetch (no Access-Control-Allow-Origin); the manager gets the same 502
        for (let i = 0; i < 4; i++) {
            responses.push({ fetchThrows: true }, { status: 502, body: 'bad gateway' });
            await findSyncGist('tok').catch(() => {});
        }
        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');

        expect(calls.at(-1).transport).toBe('fetch');
    });

    test('a dead network fails both transports without giving up on the page fetch', async () => {
        responses.push({ networkError: true }, { networkError: true });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'offline' });

        responses.push({ status: 200, body: [] });
        await findSyncGist('tok');
        expect(calls.map((call) => call.transport)).toEqual(['fetch', 'gm', 'fetch']);
    });

    test('a page fetch that never answers is aborted at the timeout, with no second attempt', async () => {
        vi.useFakeTimers();
        try {
            responses.push({ hang: true });
            const pending = findSyncGist('tok').catch((caught) => caught);
            await vi.advanceTimersByTimeAsync(30_000);
            const error = await pending;
            expect(error.kind).toBe('offline');
            expect(error.message).toContain('in time');
            expect(calls[0].signal.aborted).toBe(true);
            expect(calls.map((call) => call.transport)).toEqual(['fetch']);
        } finally {
            vi.useRealTimers();
        }
    });

    test('other hosts still go through the userscript manager', async () => {
        responses.push({ status: 200, body: 'ok' });
        await httpRequest({ method: 'GET', url: 'https://example.test/a' });
        expect(calls[0].transport).toBe('gm');
    });
});

describe('httpRequest anonymous', () => {
    test('forwards anonymous to GM_xmlhttpRequest only when asked', async () => {
        responses.push({ body: {} }, { body: {} });
        await httpRequest({ method: 'GET', url: 'https://example.test/a', anonymous: true });
        await httpRequest({ method: 'GET', url: 'https://example.test/b' });
        expect(calls[0].anonymous).toBe(true);
        expect('anonymous' in calls[1]).toBe(false);
    });

    test('fetch fallback omits credentials', async () => {
        delete globalThis.GM_xmlhttpRequest;
        const fetchMock = vi.fn(async () => ({ status: 200, text: async () => '', headers: new Headers() }));
        vi.stubGlobal('fetch', fetchMock);
        try {
            await httpRequest({ method: 'GET', url: 'https://example.test/a', anonymous: true });
            expect(fetchMock.mock.calls[0][1].credentials).toBe('omit');
        } finally {
            vi.unstubAllGlobals();
        }
    });
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

/**
 * Classification, from responses shaped like the ones GitHub actually sends.
 *
 * Each fixture below is a real response shape: the status, the headers the API
 * documents, and the JSON body with its `message` and `documentation_url`. The
 * point of testing them whole rather than calling a classifier with a bare
 * status is that the hard cases are precisely the ones where the status is not
 * enough — a secondary rate limit and a missing scope are both a 403, and only
 * the headers and the documentation URL tell them apart.
 */
describe('error classification', () => {
    test('401 is an auth problem, and the message mentions the gist scope', async () => {
        responses.push({
            status: 401,
            headers: { 'X-RateLimit-Remaining': '59' },
            body: {
                message: 'Bad credentials',
                documentation_url: 'https://docs.github.com/rest',
                status: '401',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('auth');
        expect(error.message).toContain('gist');
        expect(error.githubMessage).toBe('Bad credentials');
    });

    test('403 with no quota left is the primary rate limit, with a reset time', async () => {
        const reset = Math.floor(Date.now() / 1000) + 600;
        responses.push({
            status: 403,
            headers: {
                'X-RateLimit-Limit': '5000',
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': String(reset),
                'X-RateLimit-Resource': 'core',
            },
            body: {
                message:
                    'API rate limit exceeded for user ID 1234. If you reach out to GitHub Support for help, please include the request ID.',
                documentation_url:
                    'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-primary-rate-limits',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('rate-limit');
        expect(error.resetAt).toBeInstanceOf(Date);
        expect(error.message).toContain('hourly quota');
    });

    test('403 with quota to spare and a Retry-After is the secondary limit, not a scope problem', async () => {
        responses.push({
            status: 403,
            headers: { 'X-RateLimit-Remaining': '4987', 'Retry-After': '60' },
            body: {
                message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
                documentation_url:
                    'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('rate-limit');
        // No X-RateLimit-Reset on a secondary limit — Retry-After is the clock
        expect(error.resetAt).toBeInstanceOf(Date);
        expect(error.message).toContain('too quickly');
    });

    test('403 with quota remaining and no rate-limit signal is a scope problem', async () => {
        responses.push({
            status: 403,
            headers: { 'X-RateLimit-Remaining': '4000' },
            body: {
                message: 'Resource not accessible by personal access token',
                documentation_url: 'https://docs.github.com/rest/gists/gists#list-gists-for-the-authenticated-user',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('auth');
        expect(error.message).toContain('scope');
    });

    test('a 429 is a rate limit even with no headers to prove it', async () => {
        responses.push({ status: 429, body: {} });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
    });

    test('the prose is only consulted when no header or documentation URL decides', async () => {
        // No remaining count, no Retry-After, no documentation_url — all that is
        // left is what GitHub wrote, which is the last resort and still enough
        responses.push({ status: 403, body: { message: 'You have triggered an abuse detection mechanism.' } });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
    });

    test('404 says the gist is gone', async () => {
        responses.push({
            status: 404,
            body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/gists/gists#get-a-gist' },
        });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'not-found' });
    });

    test('a 422 whose validation errors are about size reads as too large', async () => {
        responses.push({
            status: 422,
            body: {
                message: 'Validation Failed',
                errors: [{ resource: 'Gist', code: 'custom', field: 'files', message: 'is too large' }],
                documentation_url: 'https://docs.github.com/rest/gists/gists#update-a-gist',
            },
        });
        await expect(writeSyncGist('tok', null, { chunks: 1 }, ['data'])).rejects.toMatchObject({
            kind: 'too-large',
        });
    });

    test('a 422 about something other than size does not send the reader off to shrink a payload', async () => {
        responses.push({
            status: 422,
            body: {
                message: 'Validation Failed',
                errors: [{ resource: 'Gist', code: 'missing_field', field: 'files' }],
            },
        });
        const error = await writeSyncGist('tok', null, { chunks: 1 }, ['data']).catch((caught) => caught);
        expect(error.kind).toBe('http');
        expect(error.message).toContain('Gist.files');
    });

    test('a bare 422 with nothing structured still reads as too large, which is what it always is', async () => {
        responses.push({ status: 422, body: {} });
        await expect(writeSyncGist('tok', null, { chunks: 1 }, ['data'])).rejects.toMatchObject({
            kind: 'too-large',
        });
    });

    test('a 5xx says GitHub is at fault and to come back later', async () => {
        responses.push({ status: 502, body: '<html>Bad gateway</html>' });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('http');
        expect(error.message).toContain('502');
        // An HTML body is not JSON; classification must survive that
        expect(error.githubMessage).toBe('');
    });

    test('a dead network is offline, not an HTTP failure', async () => {
        // Once for the page fetch, once for the manager it falls back to
        responses.push({ networkError: true }, { networkError: true });
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
                    [MANIFEST_FILE]: { content: JSON.stringify({ toolashaSync: 1, chunks: 2, exportedAt: 'T' }) },
                    [chunkFileName(0)]: { content: '{"a":' },
                    [chunkFileName(1)]: { content: '1}' },
                },
            },
        });
        const { payload, manifest } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('{"a":1}');
        expect(manifest.exportedAt).toBe('T');
    });

    test('a manifest field this build does not know is passed through, not rejected', async () => {
        // The compatibility guarantee the ordering counter rests on: the gate
        // below is `toolashaSync` and `chunks`, and everything else in the
        // manifest is handed to the caller as it came. A build that predates a
        // field reads the gist exactly as it always did — which is why the
        // counter lives here rather than in the payload
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: {
                        content: JSON.stringify({ toolashaSync: 1, chunks: 1, exportedAt: 'T', somethingNew: 9 }),
                    },
                    [chunkFileName(0)]: { content: '{"a":1}' },
                },
            },
        });

        const { payload, manifest } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('{"a":1}');
        expect(manifest.exportedAt).toBe('T');
        expect(manifest.somethingNew).toBe(9);
    });

    test('follows raw_url for a file the API truncated', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ toolashaSync: 1, chunks: 1 }) },
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

    test('a manifest file replaced by a hand-pasted backup is named for what it is', async () => {
        // Valid JSON, but no toolashaSync marker and no chunk count — exactly
        // what pasting a backup file over the manifest produces
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ formatVersion: 1, stores: { settings: {} } }) },
                },
            },
        });
        const error = await readSyncGist('tok', 'abc').catch((caught) => caught);
        expect(error.kind).toBe('parse');
        expect(error.message).toContain('hand');
    });

    test('a manifest that is not JSON says which gist to look at', async () => {
        responses.push({
            status: 200,
            body: { files: { [MANIFEST_FILE]: { content: 'this is not json' } } },
        });
        const error = await readSyncGist('tok', 'gist-xyz').catch((caught) => caught);
        expect(error.kind).toBe('parse');
        expect(error.message).toContain('gist-xyz');
    });

    test('a transport failure while reading the manifest keeps its own kind', async () => {
        // Truncated manifest forces a raw_url refetch; that refetch failing
        // with 401 must surface as auth, not as a corrupt manifest
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { truncated: true, raw_url: 'https://gist.example/raw', content: 'part' },
                },
            },
        });
        responses.push({ status: 401, body: {} });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'auth' });
    });

    test('a missing chunk fails loudly rather than returning half a backup', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ toolashaSync: 1, chunks: 2 }) },
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
        responses.push({ status: 200, body: { files: {} } });
        responses.push({ status: 200, body: { id: 'abc', updated_at: 'T' } });
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']);
        expect(calls[1].method).toBe('PATCH');
        expect(calls[1].url).toContain('/gists/abc');
    });

    test('deletes every orphaned chunk the gist actually holds, not the number this device wrote', async () => {
        // The gist grew to six chunks because another device pushed more than
        // this one ever has; the local hint says three
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { size: 100 },
                    ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((index) => [chunkFileName(index), { size: 10 }])),
                },
            },
        });
        responses.push({ status: 200, body: { id: 'abc' } });

        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data'], 3);

        const { files } = JSON.parse(calls[1].data);
        expect(files[chunkFileName(0)]).toEqual({ content: 'data' });
        for (const index of [1, 2, 3, 4, 5]) expect(files[chunkFileName(index)]).toBeNull();
    });

    test('a push that loses the race retries with a fresh listing and wins the next one', async () => {
        vi.useFakeTimers();
        try {
            responses.push({ status: 200, body: { files: {} } });
            responses.push({ status: 409, body: { message: 'Conflict' } });
            responses.push({ status: 200, body: { files: {} } });
            responses.push({ status: 200, body: { id: 'abc', updated_at: 'T2' } });

            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']);
            await vi.advanceTimersByTimeAsync(3000);
            const result = await pending;

            expect(result.id).toBe('abc');
            // Four calls: list, losing PATCH, fresh list, winning PATCH
            expect(calls).toHaveLength(4);
            expect(calls[2].method).toBe('GET');
            expect(calls[3].method).toBe('PATCH');
        } finally {
            vi.useRealTimers();
        }
    });

    test('a conflict that never clears is surfaced as one, after its retries', async () => {
        vi.useFakeTimers();
        try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                responses.push({ status: 200, body: { files: {} } });
                responses.push({ status: 409, body: { message: 'Conflict' } });
            }

            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']).catch((caught) => caught);
            await vi.advanceTimersByTimeAsync(10_000);
            const error = await pending;

            expect(error).toBeInstanceOf(GistError);
            expect(error.kind).toBe('conflict');
            expect(calls).toHaveLength(6);
        } finally {
            vi.useRealTimers();
        }
    });

    test('writes its counter above one another device has since pushed to the gist', async () => {
        // This device last took counter 5 and builds 6; another device has
        // meanwhile pushed twice and the gist's manifest says 7. Written as 6,
        // every device at 7 would read this push as older and skip it for good
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { size: 60, content: JSON.stringify({ toolashaSync: 1, chunks: 1, syncSeq: 7 }) },
                    [chunkFileName(0)]: { size: 10 },
                },
            },
        });
        responses.push({ status: 200, body: { id: 'abc' } });

        const result = await writeSyncGist('tok', 'abc', { toolashaSync: 1, chunks: 1, syncSeq: 6 }, ['data']);

        const { files } = JSON.parse(calls[1].data);
        expect(JSON.parse(files[MANIFEST_FILE].content).syncSeq).toBe(8);
        expect(result.syncSeq).toBe(8);
    });

    test('keeps its own counter when the gist is not ahead of it', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { size: 60, content: JSON.stringify({ toolashaSync: 1, chunks: 1, syncSeq: 4 }) },
                },
            },
        });
        responses.push({ status: 200, body: { id: 'abc' } });

        const result = await writeSyncGist('tok', 'abc', { toolashaSync: 1, chunks: 1, syncSeq: 6 }, ['data']);

        const { files } = JSON.parse(calls[1].data);
        expect(JSON.parse(files[MANIFEST_FILE].content).syncSeq).toBe(6);
        expect(result.syncSeq).toBe(6);
        // The manifest is rewritten in place, never counted as a file left behind
        expect(files[MANIFEST_FILE]).not.toBeNull();
    });

    test('a manifest without a counter is not given one', async () => {
        responses.push({
            status: 200,
            body: { files: { [MANIFEST_FILE]: { size: 60, content: JSON.stringify({ syncSeq: 9 }) } } },
        });
        responses.push({ status: 200, body: { id: 'abc' } });

        await writeSyncGist('tok', 'abc', { toolashaSync: 1, chunks: 1 }, ['data']);

        expect(JSON.parse(JSON.parse(calls[1].data).files[MANIFEST_FILE].content).syncSeq).toBeUndefined();
    });

    test('an unattended push never replaces an encrypted gist with one in the clear', async () => {
        // The device whose passphrase was never entered: its pulls fail on the
        // ciphertext, and its interval push used to quietly decrypt the gist
        // for good by overwriting it with plaintext
        const encryptedGist = {
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: {
                        size: 90,
                        content: JSON.stringify({ toolashaSync: 1, chunks: 1, syncSeq: 3, encrypted: { v: 1 } }),
                    },
                },
            },
        };
        responses.push(encryptedGist);

        const error = await writeSyncGist(
            'tok',
            'abc',
            { toolashaSync: 1, chunks: 1, syncSeq: 4 },
            ['plain'],
            0,
            null,
            {
                unattended: true,
            }
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(GistError);
        expect(error.kind).toBe('passphrase');
        // Listed, then refused — nothing written
        expect(calls).toHaveLength(1);
    });

    test('an encrypted push, or one the player asked for, still goes up', async () => {
        const encryptedGist = () => ({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: {
                        size: 90,
                        content: JSON.stringify({ toolashaSync: 1, chunks: 1, encrypted: {} }),
                    },
                },
            },
        });
        responses.push(encryptedGist(), { status: 200, body: { id: 'abc' } });
        await writeSyncGist('tok', 'abc', { chunks: 1, encrypted: { v: 1 } }, ['sealed'], 0, null, {
            unattended: true,
        });
        responses.push(encryptedGist(), { status: 200, body: { id: 'abc' } });
        let asked = 0;
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, {
            confirmPlaintext: async () => {
                asked += 1;
                return true;
            },
        });

        expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH']);
        expect(asked).toBe(1);
    });

    test('an unreadable manifest counts as possibly encrypted; a gist with no manifest does not', async () => {
        const garbled = () => ({
            status: 200,
            body: { files: { [MANIFEST_FILE]: { size: 90, content: '{not json' } } },
        });
        responses.push(garbled());
        const refused = await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, {
            unattended: true,
        }).catch((caught) => caught);
        expect(refused.kind).toBe('passphrase');

        responses.push(garbled());
        const declined = await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, {
            confirmPlaintext: async () => false,
        }).catch((caught) => caught);
        expect(declined.kind).toBe('cancelled');

        // A gist this sync never wrote has nothing encrypted in it
        responses.push({ status: 200, body: { files: { 'notes.txt': { size: 3, content: 'hi' } } } });
        responses.push({ status: 200, body: { id: 'abc' } });
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, { unattended: true });
        expect(calls.at(-1).method).toBe('PATCH');
    });

    test('a pressed push whose listing failed asks before writing plaintext', async () => {
        responses.push({ status: 500, body: {} }, { status: 200, body: { id: 'abc' } });
        let asked = 0;
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, {
            confirmPlaintext: async () => {
                asked += 1;
                return true;
            },
        });
        expect(asked).toBe(1);
    });

    test('a pressed push over an encrypted gist that is not confirmed writes nothing', async () => {
        responses.push({
            status: 200,
            body: { files: { [MANIFEST_FILE]: { size: 90, content: JSON.stringify({ chunks: 1, encrypted: {} }) } } },
        });

        const error = await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, {
            confirmPlaintext: async () => false,
        }).catch((caught) => caught);

        expect(error.kind).toBe('cancelled');
        expect(calls).toHaveLength(1);
    });

    test('a 304 against a remembered version reads its counter and encryption from that version', async () => {
        // The cached path: nothing about the gist comes down, so what the
        // remembered record says is all the write has to go on
        responses.push({ status: 304, headers: { etag: 'W/"e1"' } });
        const known = { gistId: 'abc', etag: 'W/"e1"', files: {}, current: true, syncSeq: 7, encrypted: true };

        const refused = await writeSyncGist('tok', 'abc', { chunks: 1, syncSeq: 1 }, ['plain'], 0, known, {
            unattended: true,
        }).catch((caught) => caught);
        expect(refused.kind).toBe('passphrase');

        responses.push({ status: 304, headers: { etag: 'W/"e1"' } });
        responses.push({ status: 200, body: { id: 'abc' } });
        const result = await writeSyncGist(
            'tok',
            'abc',
            { chunks: 1, syncSeq: 1, encrypted: { v: 1 } },
            ['x'],
            0,
            known
        );
        expect(result.syncSeq).toBe(8);
    });

    test('an unattended push does not write a gist it could not list', async () => {
        responses.push({ status: 502, body: {} });

        const error = await writeSyncGist('tok', 'abc', { chunks: 1, syncSeq: 1 }, ['data'], 0, null, {
            unattended: true,
        }).catch((caught) => caught);

        expect(error.kind).toBe('unlisted');
        expect(calls).toHaveLength(1);
    });

    test('a failed re-list on a conflict retry stops instead of writing on the stale listing', async () => {
        vi.useFakeTimers();
        try {
            responses.push({
                status: 200,
                body: {
                    files: {
                        [MANIFEST_FILE]: { size: 60, content: JSON.stringify({ chunks: 1, syncSeq: 7 }) },
                        [chunkFileName(1)]: { size: 10 },
                    },
                },
            });
            responses.push({ status: 409, body: { message: 'Conflict' } });
            responses.push({ status: 502, body: {} });

            const pending = writeSyncGist('tok', 'abc', { chunks: 1, syncSeq: 3 }, ['data']).catch((caught) => caught);
            await vi.advanceTimersByTimeAsync(3000);
            const error = await pending;

            // The device that won the conflict may have raised the counter or encrypted the gist
            expect(error.kind).toBe('unlisted');
            expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a manifest that parses but is not a sync manifest leaves encryption unknown', async () => {
        for (const content of ['[]', '{}', '{"encrypted":false}']) {
            responses.push({ status: 200, body: { files: { [MANIFEST_FILE]: { size: 9, content } } } });
            const error = await writeSyncGist('tok', 'abc', { chunks: 1 }, ['plain'], 0, null, {
                unattended: true,
            }).catch((caught) => caught);
            expect(error.kind).toBe('passphrase');
        }
    });

    test('falls back to the remembered count when the gist cannot be listed', async () => {
        responses.push({ status: 500, body: {} });
        responses.push({ status: 200, body: { id: 'abc' } });

        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data'], 3);

        const { files } = JSON.parse(calls[1].data);
        expect(files[chunkFileName(1)]).toBeNull();
        expect(files[chunkFileName(2)]).toBeNull();
    });

    test('counts files it is leaving in place towards the gist ceiling', async () => {
        // A file that is not ours and not a chunk survives the write, and is
        // just as real to the API's limit as the bytes being uploaded
        responses.push({ status: 200, body: { files: { 'notes.md': { size: 8_900_000 } } } });

        await expect(writeSyncGist('tok', 'abc', {}, ['x'.repeat(200_000)])).rejects.toMatchObject({
            kind: 'too-large',
        });
        // Listed, then refused — no upload spent
        expect(calls).toHaveLength(1);
    });

    test('refuses a payload too large for one gist before spending the upload', async () => {
        const huge = ['x'.repeat(9_000_001)];
        await expect(writeSyncGist('tok', null, {}, huge)).rejects.toMatchObject({ kind: 'too-large' });
        expect(calls).toHaveLength(0);
    });
});

describe('chunkIndexFromName', () => {
    test('reads the index back out of a chunk file name', () => {
        expect(chunkIndexFromName(chunkFileName(0))).toBe(0);
        expect(chunkIndexFromName(chunkFileName(42))).toBe(42);
    });

    test('is null for anything that is not a chunk file', () => {
        expect(chunkIndexFromName(MANIFEST_FILE)).toBeNull();
        expect(chunkIndexFromName('toolasha-data-notes.json')).toBeNull();
        expect(chunkIndexFromName('notes.md')).toBeNull();
        expect(chunkIndexFromName(undefined)).toBeNull();
    });
});

/**
 * What a push and a silent pull cost, in requests and bytes, at the size that
 * leaked: a full-scope backup of five ~900 KB chunks.
 */
describe('conditional reads and the cost of a sync', () => {
    const CHUNK = 900_000;
    const ETAG = 'W/"v1"';
    const manifestText = JSON.stringify({ toolashaSync: 1, chunks: 5, exportedAt: 'T' });
    const chunkTexts = [0, 1, 2, 3, 4].map((index) => String(index).repeat(CHUNK));
    const gistFiles = {
        [MANIFEST_FILE]: { size: manifestText.length, content: manifestText },
        ...Object.fromEntries(
            chunkTexts.map((text, index) => [chunkFileName(index), { size: text.length, content: text }])
        ),
    };
    const sizes = Object.fromEntries(Object.entries(gistFiles).map(([name, file]) => [name, file.size]));

    /** The gist as GitHub serves it: 304 to a matching If-None-Match, the whole gist otherwise */
    const gistAt =
        (etag, files = gistFiles) =>
        (request) =>
            request.headers?.['If-None-Match'] === etag
                ? { status: 304, body: '', headers: { ETag: etag } }
                : { status: 200, headers: { ETag: etag }, body: { id: 'abc', files } };

    /** Page-fetch traffic for one operation */
    async function measure(operation) {
        resetGmTraffic();
        const before = calls.length;
        const result = await operation();
        const { totals } = getGmTrafficSnapshot();
        return {
            result,
            requests: calls.length - before,
            sent: totals.pageRequestBytes,
            received: totals.pageResponseBytes,
        };
    }

    test('a silent pull of a version this device has downloads nothing', async () => {
        responses.push(gistAt(ETAG));
        const full = await measure(() => readSyncGist('tok', 'abc'));
        expect(full.result.etag).toBe(ETAG);
        expect(full.result.files).toEqual(sizes);

        responses.push(gistAt(ETAG));
        const conditional = await measure(() => readSyncGist('tok', 'abc', { etag: ETAG }));

        expect(calls.at(-1).headers['If-None-Match']).toBe(ETAG);
        expect(conditional.result).toEqual({ notModified: true, etag: ETAG });
        expect(full).toMatchObject({ requests: 1 });
        expect(full.received).toBeGreaterThan(5 * CHUNK);
        expect(conditional).toMatchObject({ requests: 1, received: 0 });
    });

    test('a changed gist is downloaded whole, ETag or not', async () => {
        responses.push(gistAt('W/"v2"'));
        const { payload, etag } = await readSyncGist('tok', 'abc', { etag: ETAG });
        expect(payload).toBe(chunkTexts.join(''));
        expect(etag).toBe('W/"v2"');
    });

    test('a push with a remembered listing revalidates it instead of downloading the gist', async () => {
        const written = { id: 'abc', updated_at: 'T2', files: { [MANIFEST_FILE]: { size: 10 } } };
        const pushOnce = (known) => {
            responses.push(gistAt(ETAG));
            responses.push({ status: 200, headers: { ETag: 'W/"v2"' }, body: written });
            return measure(() => writeSyncGist('tok', 'abc', { chunks: 1 }, ['new'], 5, known));
        };

        const before = await pushOnce(null);
        const after = await pushOnce({ gistId: 'abc', etag: ETAG, files: sizes });

        expect(before.requests).toBe(2);
        expect(after.requests).toBe(2);
        expect(before.received).toBeGreaterThan(5 * CHUNK);
        expect(after.received).toBeLessThan(1000);
        // The write reports the version it produced, for the next push to revalidate
        expect(after.result).toMatchObject({ id: 'abc', etag: 'W/"v2"', files: { [MANIFEST_FILE]: 10 } });
    });

    test('a 304 listing still deletes every orphaned chunk the gist holds', async () => {
        responses.push(gistAt(ETAG));
        responses.push({ status: 200, body: { id: 'abc' } });

        // The local hint says one chunk; the remembered listing says five
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['new'], 1, { gistId: 'abc', etag: ETAG, files: sizes });

        expect(calls[0].headers['If-None-Match']).toBe(ETAG);
        const { files } = JSON.parse(calls[1].data);
        expect(files[chunkFileName(0)]).toEqual({ content: 'new' });
        for (const index of [1, 2, 3, 4]) expect(files[chunkFileName(index)]).toBeNull();
    });

    test('a listing remembered for another gist is not used for this one', async () => {
        responses.push(gistAt(ETAG));
        responses.push({ status: 200, body: { id: 'abc' } });

        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['new'], 0, { gistId: 'zzz', etag: ETAG, files: {} });

        expect(calls[0].headers['If-None-Match']).toBeUndefined();
        const { files } = JSON.parse(calls[1].data);
        for (const index of [1, 2, 3, 4]) expect(files[chunkFileName(index)]).toBeNull();
    });

    test('a conflict retry with an unchanged listing reuses the serialized body', async () => {
        vi.useFakeTimers();
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            responses.push(gistAt(ETAG));
            responses.push({ status: 409, body: { message: 'Conflict' } });
            responses.push(gistAt(ETAG));
            responses.push({ status: 200, body: { id: 'abc' } });

            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, chunkTexts, 5, {
                gistId: 'abc',
                etag: ETAG,
                files: sizes,
            });
            await vi.advanceTimersByTimeAsync(3000);
            await pending;

            const bodies = stringify.mock.calls.filter(([value]) => value?.files && value?.description);
            expect(bodies).toHaveLength(1);
            expect(calls[1].data).toBe(calls[3].data);
        } finally {
            stringify.mockRestore();
            vi.useRealTimers();
        }
    });

    test('a conflict retry whose listing changed rebuilds the body with the new orphans', async () => {
        vi.useFakeTimers();
        try {
            responses.push(gistAt(ETAG, { [MANIFEST_FILE]: { size: 1 } }));
            responses.push({ status: 409, body: { message: 'Conflict' } });
            responses.push(gistAt('W/"v3"'));
            responses.push({ status: 200, body: { id: 'abc' } });

            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, ['new']);
            await vi.advanceTimersByTimeAsync(3000);
            await pending;

            expect(JSON.parse(calls[1].data).files[chunkFileName(4)]).toBeUndefined();
            expect(JSON.parse(calls[3].data).files[chunkFileName(4)]).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
