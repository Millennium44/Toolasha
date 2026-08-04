/**
 * GitHub Gist transport for cross-device sync.
 *
 * Everything that talks to api.github.com lives here, so the rest of the sync
 * feature never sees a token, a status code or a rate-limit header.
 *
 * Two things drive the shape of this file.
 *
 * The first is that api.github.com is cross-origin. `api/marketplace.js` uses
 * plain `fetch`, but it only ever asks milkywayidle.com for its own JSON, so no
 * preflight and no CORS. GitHub's API does send permissive CORS headers, yet a
 * request carrying `Authorization` is still at the mercy of whatever CSP the
 * game page ships, and a userscript has no say in that. `GM_xmlhttpRequest`
 * bypasses both, and the script already grants it in the header — so that is
 * the primary path, with `GM.xmlHttpRequest` and finally `fetch` behind it so
 * the module is still testable and still works under a manager that only
 * exposes the promise-shaped API.
 *
 * The second is that a gist file over 1 MB comes back from the API with its
 * `content` truncated and only a `raw_url` to show for it, and a gist over
 * ~10 MB is refused outright. A full backup of a played-in account passes 1 MB
 * easily, so the payload is split across numbered files under that ceiling and
 * a manifest file records how to put it back together.
 *
 * The token is never logged, never included in an error message, and never
 * written into the payload — see `sync-payload.js` for the redaction that keeps
 * it out of the thing being uploaded.
 */

/** Manifest file name; also how an existing sync gist is recognised */
export const MANIFEST_FILE = 'toolasha-sync.json';

/** Numbered payload chunks, `toolasha-data-000.json` and up */
export const CHUNK_PREFIX = 'toolasha-data-';

/**
 * Bytes per chunk file.
 *
 * The API truncates a file's inline `content` at 1 MB (1,000,000 — GitHub
 * counts in decimal megabytes here, not 1,048,576), so this leaves headroom for
 * the JSON string escaping that `JSON.stringify` adds on the way up.
 */
export const MAX_CHUNK_BYTES = 900_000;

/** A gist this large is refused by the API, so say so before spending the upload */
export const MAX_GIST_BYTES = 9_000_000;

/** Requests are abandoned rather than left hanging when the network is wedged */
const REQUEST_TIMEOUT_MS = 30_000;

const API_ROOT = 'https://api.github.com';

/**
 * A failure the sync UI can act on without reading a status code.
 *
 * `kind` is the whole point: the caller decides between "your token is wrong"
 * and "GitHub is rate-limiting you, try after 14:20" without re-deriving it
 * from HTTP.
 */
export class GistError extends Error {
    /**
     * @param {'auth'|'rate-limit'|'offline'|'not-found'|'too-large'|'http'|'parse'} kind - What went wrong
     * @param {string} message - Human-readable, safe to show in a toast
     * @param {Object} [details] - Extra context, e.g. `{ resetAt }` for a rate limit
     */
    constructor(kind, message, details = {}) {
        super(message);
        this.name = 'GistError';
        this.kind = kind;
        Object.assign(this, details);
    }
}

/**
 * Parse the raw header block a userscript manager hands back.
 * @param {string} raw - CRLF-separated `name: value` lines
 * @returns {Record<string, string>} Lower-cased header names to values
 */
function parseHeaders(raw) {
    const headers = {};
    if (typeof raw !== 'string') return headers;
    for (const line of raw.split(/\r?\n/)) {
        const index = line.indexOf(':');
        if (index === -1) continue;
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return headers;
}

/**
 * The cross-origin request function this environment actually has.
 * @returns {Function|null} A GM request function, or null to fall back to fetch
 */
function getGMRequest() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && typeof GM?.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
    return null;
}

/**
 * One HTTP request, whichever transport is available.
 *
 * Resolves for any status the server returned — including 401 and 403 — because
 * classifying those is `classify()`'s job and it needs the body. Rejects only
 * when nothing came back at all, which is what offline looks like from here.
 *
 * @param {Object} options - Request
 * @param {string} options.method - HTTP method
 * @param {string} options.url - Absolute URL
 * @param {Record<string, string>} [options.headers] - Request headers
 * @param {string} [options.body] - Request body
 * @returns {Promise<{status: number, text: string, headers: Record<string, string>}>} Response
 */
export async function httpRequest({ method, url, headers = {}, body }) {
    const gmRequest = getGMRequest();

    if (!gmRequest) {
        // No userscript manager (tests, or a bare page). `fetch` is subject to
        // the page's CSP, so this path can fail where the GM one would not.
        try {
            const response = await fetch(url, { method, headers, body });
            const text = await response.text();
            const collected = {};
            response.headers?.forEach?.((value, name) => {
                collected[String(name).toLowerCase()] = value;
            });
            return { status: response.status, text, headers: collected };
        } catch {
            // Deliberately not forwarding the original error: a fetch failure
            // message can contain the request URL, and the URL is the one place
            // a caller could accidentally have put a token
            throw new GistError('offline', 'Could not reach GitHub. Check your connection and try again.');
        }
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        gmRequest({
            method,
            url,
            headers,
            data: body,
            timeout: REQUEST_TIMEOUT_MS,
            onload: (response) =>
                finish(resolve, {
                    status: response.status,
                    text: response.responseText ?? '',
                    headers: parseHeaders(response.responseHeaders),
                }),
            onerror: () =>
                finish(
                    reject,
                    new GistError('offline', 'Could not reach GitHub. Check your connection and try again.')
                ),
            ontimeout: () => finish(reject, new GistError('offline', 'GitHub did not answer in time. Try again.')),
            onabort: () => finish(reject, new GistError('offline', 'The request to GitHub was cancelled.')),
        });
    });
}

/**
 * Turn a non-2xx response into the error the UI should show.
 * @param {{status: number, text: string, headers: Record<string, string>}} response - What came back
 * @returns {GistError} Classified failure
 */
function classify(response) {
    const { status, headers } = response;

    if (status === 401) {
        return new GistError(
            'auth',
            'GitHub rejected the token. Check it is correct, unexpired, and has the "gist" scope.'
        );
    }

    // GitHub answers a spent quota with 403 or 429 and a remaining count of 0.
    // A 403 with quota left is a scope problem, which reads as auth to the user.
    const remaining = headers['x-ratelimit-remaining'];
    const isRateLimited = status === 429 || (status === 403 && remaining === '0');
    if (isRateLimited) {
        const resetSeconds = Number(headers['x-ratelimit-reset']);
        const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000) : null;
        const when = resetAt ? ` Try again after ${resetAt.toLocaleTimeString()}.` : '';
        return new GistError('rate-limit', `GitHub is rate-limiting this token.${when}`, { resetAt });
    }
    if (status === 403) {
        return new GistError('auth', 'GitHub refused the request. The token is probably missing the "gist" scope.');
    }
    if (status === 404) {
        return new GistError('not-found', 'That gist no longer exists.');
    }
    if (status === 422) {
        return new GistError('too-large', 'GitHub refused the payload. It is most likely too large for one gist.');
    }

    return new GistError('http', `GitHub returned an unexpected response (HTTP ${status}).`);
}

/**
 * An authenticated API call that expects JSON back.
 * @param {string} token - GitHub personal access token
 * @param {string} method - HTTP method
 * @param {string} path - Path under the API root, e.g. `/gists`
 * @param {Object} [payload] - Body, serialized as JSON
 * @returns {Promise<Object>} Parsed response body
 */
async function apiCall(token, method, path, payload) {
    if (!token) {
        throw new GistError('auth', 'No GitHub token is set. Add one in Settings → Cross-Device Sync.');
    }

    const response = await httpRequest({
        method,
        url: `${API_ROOT}${path}`,
        headers: {
            // Bearer is what fine-grained tokens require and classic tokens accept
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    if (response.status < 200 || response.status >= 300) {
        throw classify(response);
    }

    try {
        return JSON.parse(response.text || '{}');
    } catch {
        throw new GistError('parse', 'GitHub sent a response this script could not read.');
    }
}

/**
 * Split a payload into files small enough that GitHub returns them whole.
 *
 * Sliced by UTF-16 code units rather than bytes, which over-counts for ASCII and
 * so errs towards smaller chunks — the safe direction. Slicing between a
 * surrogate pair would corrupt the character, so a split that lands on a high
 * surrogate steps back one.
 *
 * @param {string} text - The payload
 * @param {number} [maxBytes] - Ceiling per chunk
 * @returns {Array<string>} Chunks, in order; joining them returns the input
 */
export function chunkPayload(text, maxBytes = MAX_CHUNK_BYTES) {
    if (!text) return [''];

    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + maxBytes, text.length);
        const code = text.charCodeAt(end - 1);
        // High surrogate at the boundary: its partner is in the next chunk
        if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
        chunks.push(text.slice(start, end));
        start = end;
    }
    return chunks;
}

/**
 * Chunk file name for an index. Zero-padded so the files sort in order in the
 * gist's own web view, which is where someone will look when they distrust it.
 * @param {number} index - Zero-based chunk index
 * @returns {string} File name
 */
export function chunkFileName(index) {
    return `${CHUNK_PREFIX}${String(index).padStart(3, '0')}.json`;
}

/**
 * Find an existing sync gist belonging to the token's owner.
 *
 * The point is a second device: the user pastes the same token and the gist id
 * is discovered rather than typed. Only the first page is searched — a sync
 * gist is created at most once and is touched on every push, so it sits at the
 * top of a list ordered by update time.
 *
 * @param {string} token - GitHub personal access token
 * @returns {Promise<string|null>} Gist id, or null when there is none
 */
export async function findSyncGist(token) {
    const gists = await apiCall(token, 'GET', '/gists?per_page=100');
    if (!Array.isArray(gists)) return null;
    const match = gists.find((gist) => gist?.files && Object.hasOwn(gist.files, MANIFEST_FILE));
    return match?.id ?? null;
}

/**
 * Read the manifest and every chunk out of a gist.
 *
 * A file the API truncated is re-fetched from its `raw_url`. That should not
 * happen with chunks under the ceiling, but a gist edited by hand in the browser
 * can produce one, and losing half a backup silently is much worse than one
 * extra request.
 *
 * @param {string} token - GitHub personal access token
 * @param {string} gistId - Gist id
 * @returns {Promise<{manifest: Object, payload: string, updatedAt: string}>} Reassembled contents
 */
export async function readSyncGist(token, gistId) {
    const gist = await apiCall(token, 'GET', `/gists/${encodeURIComponent(gistId)}`);
    const files = gist?.files || {};

    const manifestFile = files[MANIFEST_FILE];
    if (!manifestFile) {
        throw new GistError('parse', 'That gist is not a Toolasha sync gist — it has no manifest file.');
    }

    let manifest;
    try {
        manifest = JSON.parse(await readFileContent(token, manifestFile));
    } catch {
        throw new GistError('parse', 'The sync gist manifest is corrupt. Push from a good device to replace it.');
    }

    const chunkCount = Number(manifest?.chunks) || 0;
    const parts = [];
    for (let index = 0; index < chunkCount; index += 1) {
        const name = chunkFileName(index);
        const file = files[name];
        if (!file) {
            throw new GistError('parse', `The sync gist is missing ${name}. Push again to replace it.`);
        }
        parts.push(await readFileContent(token, file));
    }

    return { manifest, payload: parts.join(''), updatedAt: gist?.updated_at ?? null };
}

/**
 * A gist file's contents, following `raw_url` when the API truncated it.
 * @param {string} token - GitHub personal access token
 * @param {Object} file - A file entry from the gist API
 * @returns {Promise<string>} File contents
 */
async function readFileContent(token, file) {
    if (!file.truncated && typeof file.content === 'string') return file.content;
    if (!file.raw_url) return file.content ?? '';

    const response = await httpRequest({
        method: 'GET',
        url: file.raw_url,
        headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status < 200 || response.status >= 300) throw classify(response);
    return response.text;
}

/**
 * Create or update the private sync gist.
 *
 * Chunk files left over from a larger previous payload are explicitly nulled,
 * which is how the API is told to delete a file. Without that, shrinking the
 * payload would leave stale trailing chunks in place and the next reader would
 * happily splice them onto the end.
 *
 * @param {string} token - GitHub personal access token
 * @param {string|null} gistId - Existing gist id, or null to create one
 * @param {Object} manifest - Manifest object, stored as pretty JSON
 * @param {Array<string>} chunks - Payload chunks in order
 * @param {number} [previousChunkCount=0] - How many chunks the gist held before
 * @returns {Promise<{id: string, updatedAt: string}>} The gist that was written
 */
export async function writeSyncGist(token, gistId, manifest, chunks, previousChunkCount = 0) {
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalBytes > MAX_GIST_BYTES) {
        throw new GistError(
            'too-large',
            'This backup is too big for a single gist. Switch Sync scope to "Settings only".'
        );
    }

    const files = { [MANIFEST_FILE]: { content: JSON.stringify(manifest, null, 2) } };
    chunks.forEach((chunk, index) => {
        // A gist file may not be empty; a single space keeps an empty payload legal
        files[chunkFileName(index)] = { content: chunk === '' ? ' ' : chunk };
    });
    for (let index = chunks.length; index < previousChunkCount; index += 1) {
        files[chunkFileName(index)] = null;
    }

    const body = { description: 'Toolasha cross-device sync (do not edit by hand)', files };

    if (gistId) {
        const updated = await apiCall(token, 'PATCH', `/gists/${encodeURIComponent(gistId)}`, body);
        return { id: updated.id ?? gistId, updatedAt: updated.updated_at ?? null };
    }

    const created = await apiCall(token, 'POST', '/gists', { ...body, public: false });
    if (!created?.id) throw new GistError('parse', 'GitHub created a gist but did not say which one.');
    return { id: created.id, updatedAt: created.updated_at ?? null };
}

export default {
    MANIFEST_FILE,
    MAX_CHUNK_BYTES,
    MAX_GIST_BYTES,
    GistError,
    chunkPayload,
    chunkFileName,
    findSyncGist,
    readSyncGist,
    writeSyncGist,
};
