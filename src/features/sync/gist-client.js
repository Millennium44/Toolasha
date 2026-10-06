/**
 * GitHub Gist transport for cross-device sync.
 *
 * Everything that talks to api.github.com lives here, so the rest of the sync
 * feature never sees a token, a status code or a rate-limit header.
 *
 * Two things drive the shape of this file.
 *
 * The first is the transport. api.github.com is cross-origin, but GitHub
 * answers with `Access-Control-Allow-Origin: *` and exposes the headers this
 * file reads (ETag, Retry-After, X-RateLimit-*), and the game page ships no
 * Content-Security-Policy — so a page `fetch` reaches it. That is the primary
 * path for api.github.com, and it has to be: `GM_xmlhttpRequest` hands every
 * request body to the userscript manager's background page, and Tampermonkey
 * keeps it after the request completes. A sync push body is the whole backup,
 * several megabytes, and Firefox was measured holding hundreds of them. The GM
 * path remains the fallback when the page fetch throws (CORS, or a CSP the game
 * might add later), and the only path for every other host, whose CORS nobody
 * has checked.
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

import { gmRequest, gmRequestAvailable, recordPageRequest } from '../../utils/gm-traffic.js';

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
     * @param {'auth'|'rate-limit'|'offline'|'not-found'|'too-large'|'conflict'|'http'|'parse'} kind - What went wrong
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
 * Hosts reached with a page `fetch` before the userscript manager is tried.
 *
 * Only hosts whose CORS answer has been measured belong here; a host that
 * refuses the preflight would cost a failed fetch before every GM request.
 */
const PAGE_FETCH_HOSTS = new Set(['api.github.com']);

/**
 * Methods a failed page fetch may be replayed with through the manager: repeating them changes nothing.
 * Not PATCH: a whole-gist write whose answer was lost may have landed, and replaying the same stale
 * snapshot could overwrite a newer push another device made in between.
 */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * Set once page fetches keep failing where the GM path reaches GitHub — CORS or a
 * CSP, not the network — so later requests stop paying for a doomed fetch first.
 * Module state: it lasts for the page. Falling back is what the leak was, so the
 * latch is earned, not tripped: see `FETCH_FAILURES_TO_LATCH`.
 */
let pageFetchUnusable = false;

/**
 * Consecutive fetch failures that GM answered below 500, needed before the latch sets. One is a
 * blip (a connection reset on wake); a CORS or CSP block repeats on every request. A 5xx is
 * not counted: an error page from an edge carries no CORS header, so the fetch throws for the
 * same reason GM gets the 5xx, and the page fetch is not to blame.
 */
const FETCH_FAILURES_TO_LATCH = 3;

/** Fetch failures in a row that GM answered; any page fetch that succeeds resets it. */
let fetchFailuresAnsweredByManager = 0;

/** Tests only: forget a previous fallback. */
export function resetTransportForTests() {
    pageFetchUnusable = false;
    fetchFailuresAnsweredByManager = 0;
}

/**
 * The cross-origin request function this environment actually has.
 * @returns {Function|null} A GM request function, or null to fall back to fetch
 */
function getGMRequest() {
    return gmRequestAvailable() ? gmRequest : null;
}

/**
 * Whether this URL goes to a host that is reached with a page fetch first.
 * @param {string} url - Absolute URL
 * @returns {boolean} True when the page fetch is tried before GM
 */
function prefersPageFetch(url) {
    if (pageFetchUnusable || typeof fetch !== 'function') return false;
    try {
        return PAGE_FETCH_HOSTS.has(new URL(url).host);
    } catch {
        return false;
    }
}

/**
 * One request through the page's own `fetch`.
 *
 * A thrown fetch is either the network or the browser refusing the request
 * (CORS, CSP); the two look the same from here, so the error carries
 * `transportFailure` and `httpRequest` tells them apart by asking the GM path.
 * A timeout carries no flag: the server was reached and did not answer, and the
 * GM path would wait just as long.
 *
 * @param {Object} request - As for `httpRequest`
 * @param {boolean} githubHost - Omit credentials and bypass the HTTP cache
 * @returns {Promise<{status: number, text: string, headers: Record<string, string>}>} Response
 */
async function pageFetch({ method, url, headers, body, anonymous }, githubHost) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller
        ? setTimeout(() => {
              timedOut = true;
              controller.abort();
          }, REQUEST_TIMEOUT_MS)
        : null;
    const sentBytes = typeof body === 'string' ? body.length : 0;
    try {
        const response = await fetch(url, {
            method,
            headers,
            body,
            // Authorization travels in its header only. github.com cookies are
            // never wanted, and a `*` CORS answer refuses credentialed requests.
            ...(anonymous || githubHost ? { credentials: 'omit' } : {}),
            // GitHub marks gist responses cacheable for 60 s. A listing served
            // from the browser cache can miss a chunk another device wrote a
            // moment ago, and the orphan cleanup depends on that listing.
            ...(githubHost ? { cache: 'no-store' } : {}),
            ...(controller ? { signal: controller.signal } : {}),
        });
        const text = await response.text();
        const collected = {};
        response.headers?.forEach?.((value, name) => {
            collected[String(name).toLowerCase()] = value;
        });
        recordPageRequest(url, sentBytes, text.length, false);
        return { status: response.status, text, headers: collected };
    } catch {
        recordPageRequest(url, sentBytes, 0, true);
        // The original error is not forwarded: a fetch failure message can
        // contain the request URL, and the URL is the one place a caller could
        // accidentally have put a token
        if (timedOut) throw new GistError('offline', 'GitHub did not answer in time. Try again.');
        throw new GistError('offline', 'Could not reach GitHub. Check your connection and try again.', {
            transportFailure: true,
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * One HTTP request, whichever transport is available.
 *
 * Resolves for any status the server returned — including 401 and 403 — because
 * classifying those is `classify()`'s job and it needs the body. Rejects only
 * when nothing came back at all, which is what offline looks like from here.
 *
 * For api.github.com the page fetch goes first and the GM path is tried only
 * when the fetch throws. An HTTP error status is an answer, never a reason to
 * fall back: repeating a 409 through GM would double the request and put its
 * body in the manager's memory, which is what the page fetch is there to stop.
 * The fallback is remembered for the session only once GM succeeds where the
 * fetch failed; a dead network fails both and leaves the page fetch in place.
 *
 * @param {Object} options - Request
 * @param {string} options.method - HTTP method
 * @param {string} options.url - Absolute URL
 * @param {Record<string, string>} [options.headers] - Request headers
 * @param {string} [options.body] - Request body
 * @param {boolean} [options.anonymous] - Send and store no cookies (GM `anonymous`, fetch `credentials: 'omit'`)
 * @returns {Promise<{status: number, text: string, headers: Record<string, string>}>} Response
 */
export async function httpRequest({ method, url, headers = {}, body, anonymous = false }) {
    const request = { method, url, headers, body, anonymous };
    const send = getGMRequest();

    // No userscript manager (tests, or a bare page): fetch is all there is
    if (!send) return pageFetch(request, prefersPageFetch(url));
    if (!prefersPageFetch(url)) return managerRequest(send, request);

    // A request that must not be sent twice goes straight to the manager when the last page fetch
    // failed where the manager got through: trying the page first could only fail again, and that
    // failure could not be replayed (see below)
    const replayable = REPLAYABLE_METHODS.has(String(method).toUpperCase());
    if (!replayable && fetchFailuresAnsweredByManager > 0) return managerRequest(send, request);

    try {
        const response = await pageFetch(request, true);
        fetchFailuresAnsweredByManager = 0;
        return response;
    } catch (error) {
        if (!error?.transportFailure) {
            // A timeout, not a refusal: it says nothing about the page fetch, and breaks the run
            fetchFailuresAnsweredByManager = 0;
            throw error;
        }
        // A fetch can fail after GitHub acted on it (the connection drops while the answer comes back).
        // Replaying is safe for a read or a whole-gist overwrite, but a second POST creates a second
        // gist, so a failed POST surfaces as the failure it is and the next sync starts over.
        if (!replayable) throw error;
        let response;
        try {
            response = await managerRequest(send, request);
        } catch (managerError) {
            // Neither got through: the network, not the page fetch. That breaks the run too.
            fetchFailuresAnsweredByManager = 0;
            throw managerError;
        }
        // A 5xx says nothing about the page fetch (see above) and breaks the run: three in a row means
        // three in a row
        fetchFailuresAnsweredByManager = response.status < 500 ? fetchFailuresAnsweredByManager + 1 : 0;
        if (fetchFailuresAnsweredByManager >= FETCH_FAILURES_TO_LATCH) {
            pageFetchUnusable = true;
            console.warn(
                '[GistClient] Page fetch to GitHub keeps failing where the userscript manager does not; using it.'
            );
        }
        return response;
    }
}

/**
 * One request through the userscript manager.
 * @param {Function} send - The GM request function
 * @param {Object} request - As for `httpRequest`
 * @returns {Promise<{status: number, text: string, headers: Record<string, string>}>} Response
 */
function managerRequest(send, { method, url, headers, body, anonymous }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        send({
            method,
            url,
            headers,
            data: body,
            ...(anonymous ? { anonymous: true } : {}),
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
 * The structured half of a GitHub error response.
 *
 * Every error the API returns is JSON of the same shape — a `message`, usually a
 * `documentation_url` pointing at the rule that was broken, and for validation
 * failures an `errors` array of `{resource, field, code, message}`. Those three
 * fields are what classification is built on, because they are the API's own
 * contract; the prose inside `message` is not, and it has been reworded before.
 *
 * A body that is not JSON at all (an HTML error page from a proxy in front of
 * GitHub, say) yields empty fields rather than throwing, so classification falls
 * back to the status code alone.
 *
 * @param {string} text - Raw response body
 * @returns {{message: string, documentationUrl: string, errors: Array<Object>}} Structured fields
 */
function githubDetail(text) {
    const empty = { message: '', documentationUrl: '', errors: [] };
    if (typeof text !== 'string' || !text.trim()) return empty;

    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return empty;
    }
    if (!body || typeof body !== 'object') return empty;

    return {
        message: typeof body.message === 'string' ? body.message : '',
        documentationUrl: typeof body.documentation_url === 'string' ? body.documentation_url : '',
        errors: Array.isArray(body.errors) ? body.errors : [],
    };
}

/**
 * Is this refusal a rate limit, and when does it lift?
 *
 * Both of GitHub's limits arrive as a 403 or a 429, and telling them apart from
 * a scope problem is the one classification that cannot be done on the status
 * code alone:
 *
 *   primary   — the hourly quota is spent: `x-ratelimit-remaining: 0`
 *   secondary — a burst was refused with quota still on the clock, and the only
 *               structural marks are a `retry-after` header and a
 *               documentation_url naming the secondary limits
 *
 * Order matters. The headers are checked first because they are the API's
 * contract, the documentation URL second because its path is stable, and the
 * prose in `message` last and only when nothing structural decided — matching
 * on English text is how a reworded message turns a rate limit into a mystery.
 *
 * @param {number} status - HTTP status
 * @param {Record<string, string>} headers - Response headers, lower-cased
 * @param {{message: string, documentationUrl: string}} detail - Structured fields
 * @returns {{resetAt: Date|null, secondary: boolean}|null} Null when this is not a rate limit
 */
function rateLimitInfo(status, headers, detail) {
    if (status !== 403 && status !== 429) return null;

    const quotaSpent = headers['x-ratelimit-remaining'] === '0';

    const retryAfter = Number(headers['retry-after']);
    const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;

    // Covers both `/rest/overview/rate-limits-for-the-rest-api` and the
    // secondary-rate-limits page, and nothing else GitHub documents
    const documented = /rate-limit/i.test(detail.documentationUrl);

    // Last resort, and only when every structural signal was silent
    const prose =
        !quotaSpent &&
        !hasRetryAfter &&
        !documented &&
        /rate limit|abuse detection|too many requests/i.test(detail.message);

    // A 429 is unambiguous whatever the headers say; a 403 needs a reason
    if (status !== 429 && !quotaSpent && !hasRetryAfter && !documented && !prose) return null;

    const resetSeconds = Number(headers['x-ratelimit-reset']);
    let resetAt = null;
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) resetAt = new Date(resetSeconds * 1000);
    else if (hasRetryAfter) resetAt = new Date(Date.now() + retryAfter * 1000);

    return { resetAt, secondary: !quotaSpent && (hasRetryAfter || /secondary/i.test(detail.documentationUrl)) };
}

/** Validation-failure signals that mean the payload was too big for one gist */
const SIZE_CODES = new Set(['too_large', 'too_long']);

/**
 * Does a 422's structured detail say the payload was oversized?
 * @param {{message: string, errors: Array<Object>}} detail - Structured fields
 * @returns {boolean|null} True/false when the detail decides, null when it is silent
 */
function looksOversized(detail) {
    for (const error of detail.errors) {
        if (SIZE_CODES.has(error?.code)) return true;
        if (typeof error?.message === 'string' && /too large|too long|maximum size|exceed/i.test(error.message)) {
            return true;
        }
    }
    if (detail.errors.length > 0) return false;
    if (/too large|maximum size|exceed/i.test(detail.message)) return true;
    return null;
}

/**
 * Turn a non-2xx response into the error the UI should show.
 *
 * Classification is by status code and the structured fields GitHub documents,
 * in that order; the prose in `message` is consulted only where nothing else can
 * decide (see `rateLimitInfo`). GitHub's own message is carried along in
 * `githubMessage` so a report can quote it without the classification depending
 * on it.
 *
 * @param {{status: number, text: string, headers: Record<string, string>}} response - What came back
 * @returns {GistError} Classified failure
 */
function classify(response) {
    const { status, headers = {} } = response;
    const detail = githubDetail(response.text);
    // Never the token: GitHub does not echo request headers, and nothing from
    // the request is put in here
    const context = { githubMessage: detail.message, documentationUrl: detail.documentationUrl };

    const rate = rateLimitInfo(status, headers, detail);
    if (rate) {
        const when = rate.resetAt ? ` Try again after ${rate.resetAt.toLocaleTimeString()}.` : ' Try again shortly.';
        const which = rate.secondary
            ? 'GitHub is throttling this token for making too many requests too quickly.'
            : 'GitHub is rate-limiting this token — its hourly quota is spent.';
        return new GistError('rate-limit', `${which}${when}`, { ...context, resetAt: rate.resetAt });
    }

    if (status === 401) {
        return new GistError(
            'auth',
            'GitHub rejected the token. Check it is correct, unexpired, and has the "gist" scope.',
            context
        );
    }
    if (status === 403) {
        // Quota was not the reason, so the token is allowed to exist and not to
        // do this — which for the gist API is always a missing scope
        return new GistError(
            'auth',
            'GitHub refused the request. The token is probably missing the "gist" scope.',
            context
        );
    }
    if (status === 404) {
        return new GistError('not-found', 'That gist no longer exists.', context);
    }
    if (status === 422) {
        const oversized = looksOversized(detail);
        if (oversized === false) {
            // A validation failure that is not about size — saying "too large"
            // would send the reader to shrink a payload that is not the problem
            const first = detail.errors[0] || {};
            const field = first.field ? ` (${first.resource || 'gist'}.${first.field})` : '';
            return new GistError(
                'http',
                `GitHub rejected the gist${field}: ${detail.message || 'validation failed'}.`,
                context
            );
        }
        return new GistError(
            'too-large',
            'GitHub refused the payload. It is most likely too large for one gist.',
            context
        );
    }
    if (status === 409) {
        // The gist changed between this request being built and landing —
        // another device (or another character's tab) pushed at the same
        // moment. Transient by nature; writeSyncGist retries it.
        return new GistError('conflict', 'Another device pushed at the same moment (HTTP 409).', context);
    }
    if (status >= 500) {
        return new GistError('http', `GitHub is having trouble (HTTP ${status}). Try again in a few minutes.`, context);
    }

    return new GistError('http', `GitHub returned an unexpected response (HTTP ${status}).`, context);
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
    const exchange = await apiExchange(token, method, path, {
        body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return exchange.data;
}

/**
 * An authenticated API call, with what the response said about itself.
 *
 * With `ifNoneMatch`, a 304 is an answer rather than a failure: the resource
 * still has that ETag, and GitHub sends no body (and, for an authenticated
 * request, does not count it against the rate limit).
 *
 * @param {string} token - GitHub personal access token
 * @param {string} method - HTTP method
 * @param {string} path - Path under the API root
 * @param {Object} [options] - Options
 * @param {string} [options.body] - Body, already serialized
 * @param {string|null} [options.ifNoneMatch] - ETag for a conditional request
 * @returns {Promise<{notModified: boolean, etag: string|null, data: Object|null}>} Outcome
 */
async function apiExchange(token, method, path, { body, ifNoneMatch = null } = {}) {
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
            ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
        },
        body,
    });
    const etag = response.headers?.etag || null;

    if (ifNoneMatch && response.status === 304) return { notModified: true, etag: etag || ifNoneMatch, data: null };

    if (response.status < 200 || response.status >= 300) {
        throw classify(response);
    }

    try {
        return { notModified: false, etag, data: JSON.parse(response.text || '{}') };
    } catch {
        throw new GistError('parse', 'GitHub sent a response this script could not read.');
    }
}

/**
 * A gist's file names and sizes, without contents — what a remembered listing
 * keeps, since that is all the orphan cleanup and the size guard read.
 * @param {Record<string, Object>|undefined} files - The `files` of a gist response
 * @returns {Record<string, number>|null} Size by file name, or null when there is no listing
 */
function fileSizes(files) {
    if (!files || typeof files !== 'object') return null;
    const sizes = {};
    for (const [name, file] of Object.entries(files)) sizes[name] = Number(file?.size) || 0;
    return sizes;
}

/**
 * What a push needs to know about the manifest already in the gist, read from
 * a gist response: its ordering counter, and whether it is encrypted.
 *
 * Both are null when the manifest is absent, truncated or does not parse, and
 * the counter is null for anything but a plain non-negative integer — the push
 * then writes what it built, exactly as before.
 *
 * `unordered` says the gist holds sync data — a manifest, or chunks — whose
 * place in the order of exchanges cannot be read: no counter and no readable
 * timestamp. Nothing then says whether it is older or newer than what the
 * caller last took, which a write that must not replace a newer exchange has
 * to know. A gist this sync never wrote holds no exchange, so it is not.
 *
 * @param {Object|null|undefined} files - The `files` map of a gist response
 * @returns {{syncSeq: number|null, encrypted: boolean|null, exportedAt: string|null, unordered: boolean}} What
 *   the manifest says
 */
function listedManifest(files) {
    const file = files?.[MANIFEST_FILE];
    const unread = { syncSeq: null, encrypted: null, exportedAt: null, unordered: Boolean(file) };
    // No manifest and no sync chunks is a gist this sync never wrote: nothing in it can be encrypted.
    // Sync chunks without a manifest are an encrypted gist whose manifest was deleted, so the encryption
    // is unknown, as it is for a manifest that is there but unreadable; the push treats both as unsafe.
    if (files && !file) {
        const hasChunks = Object.keys(files).some((name) => chunkIndexFromName(name) !== null);
        return { ...unread, encrypted: hasChunks ? null : false, unordered: hasChunks };
    }
    if (!file || file.truncated || typeof file.content !== 'string') return unread;
    try {
        const manifest = JSON.parse(file.content);
        // The same shape readSyncGist insists on; anything else parsed but says nothing about encryption
        if (manifest?.toolashaSync !== 1 || Array.isArray(manifest) || !(Number(manifest.chunks) >= 1)) {
            return unread;
        }
        const seq = manifest?.syncSeq;
        const syncSeq = Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
        const exportedAt = typeof manifest?.exportedAt === 'string' ? manifest.exportedAt : null;
        return {
            syncSeq,
            encrypted: Boolean(manifest?.encrypted),
            exportedAt,
            unordered: syncSeq === null && !Number.isFinite(Date.parse(exportedAt ?? '')),
        };
    } catch {
        return unread;
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
 * The chunk index a gist file name encodes, or null when it is not a chunk.
 * @param {string} name - Gist file name
 * @returns {number|null} Zero-based chunk index
 */
export function chunkIndexFromName(name) {
    if (typeof name !== 'string' || !name.startsWith(CHUNK_PREFIX)) return null;
    const match = /^(\d+)\.json$/.exec(name.slice(CHUNK_PREFIX.length));
    if (!match) return null;
    return Number(match[1]);
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
 * With `etag`, the read is conditional: a gist that still has that ETag comes
 * back as `{notModified: true}` with nothing downloaded. Every gist response
 * carries every file's content, so this is the difference between a few hundred
 * bytes and the whole backup.
 *
 * @param {string} token - GitHub personal access token
 * @param {string} gistId - Gist id
 * @param {Object} [options] - Options
 * @param {string|null} [options.etag] - ETag of a version this device already has
 * @returns {Promise<{notModified?: boolean, manifest?: Object, payload?: string, updatedAt?: string,
 *   etag: string|null, files?: Record<string, number>}>} Reassembled contents, the response's ETag, and the
 *   gist's file sizes by name
 */
export async function readSyncGist(token, gistId, { etag = null } = {}) {
    const exchange = await apiExchange(token, 'GET', `/gists/${encodeURIComponent(gistId)}`, { ifNoneMatch: etag });
    if (exchange.notModified) return { notModified: true, etag: exchange.etag };
    return parseSyncGist(token, gistId, exchange);
}

/**
 * Read one past revision of the sync gist: what a given write left there.
 *
 * For the write check in `writeSyncGist`: a push that finds another device
 * wrote between its listing and its own write reads that device's revision
 * back to merge it in, rather than leave it overwritten.
 *
 * @param {string} token - GitHub personal access token
 * @param {string} gistId - Gist id
 * @param {string} version - The revision's version (a `history` entry's `version`)
 * @returns {Promise<{manifest: Object, payload: string, history: Array<string>, version: string|null}>}
 *   That revision's manifest and reassembled contents
 */
export async function readSyncGistRevision(token, gistId, version) {
    const path = `/gists/${encodeURIComponent(gistId)}/${encodeURIComponent(version)}`;
    const exchange = await apiExchange(token, 'GET', path);
    return parseSyncGist(token, gistId, exchange);
}

/**
 * The versions a gist response's `history` lists, newest first.
 * @param {Object|null|undefined} gist - A gist response body
 * @returns {Array<string>|null} Versions, or null when the response carries no history
 */
function historyVersions(gist) {
    if (!Array.isArray(gist?.history)) return null;
    return gist.history.map((entry) => entry?.version).filter((version) => typeof version === 'string');
}

/** How many replaced revisions one write check reads back, at most */
const MAX_INTERVENING = 5;

/**
 * The versions written between a write's base and the write itself — other
 * devices' pushes this write replaced — oldest first.
 *
 * Empty when there were none, and when it cannot be told: no base recorded
 * (a gist listed before versions were), or no history to read.
 *
 * @param {Array<string>|null} history - The gist's versions after the write, newest first
 * @param {string|null} basedOn - The version the write was based on
 * @returns {Array<string>} Replaced versions, oldest first
 */
function interveningVersions(history, basedOn) {
    if (!basedOn || !Array.isArray(history) || history.length < 2) return [];
    const base = history.indexOf(basedOn);
    const between = base === -1 ? history.slice(1) : history.slice(1, base);
    return between.slice(0, MAX_INTERVENING).reverse();
}

/**
 * A gist response read as a sync gist: manifest checked, chunks reassembled.
 * @param {string} token - GitHub personal access token
 * @param {string} gistId - Gist id
 * @param {{data: Object, etag: string|null}} exchange - The response
 * @returns {Promise<Object>} What `readSyncGist` returns
 */
async function parseSyncGist(token, gistId, exchange) {
    const gist = exchange.data;
    const files = gist?.files || {};

    const manifestFile = files[MANIFEST_FILE];
    if (!manifestFile) {
        throw new GistError('parse', 'That gist is not a Toolasha sync gist — it has no manifest file.');
    }

    // Fetched outside the parse try/catch: a transport failure here (offline,
    // auth, rate limit) must keep its own classification — swallowing it into
    // "corrupt manifest" sends the reader to repair a gist that is fine.
    const manifestText = await readFileContent(token, manifestFile);

    let manifest;
    try {
        manifest = JSON.parse(manifestText);
    } catch {
        throw new GistError(
            'parse',
            `The sync gist's ${MANIFEST_FILE} is not valid JSON (gist ${gistId}). Push from a good device to replace it.`
        );
    }

    // Every manifest this script has ever written carries the marker and a
    // chunk count. A file that parses but has neither is not ours — a backup
    // pasted into the gist by hand looks exactly like this, and reading it as
    // a manifest would quietly resolve to an empty payload.
    if (manifest?.toolashaSync !== 1 || !(Number(manifest?.chunks) >= 1)) {
        throw new GistError(
            'parse',
            `The ${MANIFEST_FILE} in gist ${gistId} is not one this script wrote — it looks edited or replaced by ` +
                'hand. Pushing from a good device rewrites it.'
        );
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

    const history = historyVersions(gist);
    return {
        manifest,
        payload: parts.join(''),
        updatedAt: gist?.updated_at ?? null,
        etag: exchange.etag,
        files: fileSizes(files),
        history,
        version: history?.[0] ?? null,
    };
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
 * *Which* files are left over is read from the gist, not from what this device
 * remembers writing. The remembered count is per-device: device A that last
 * pushed two chunks has no idea device B has since grown the gist to six, so
 * pushing two again used to leave files 2-5 in place — counting towards the
 * gist ceiling, and invisible to a size guard that only knew about the two
 * being written. The count survives as a fallback for a gist that cannot be
 * listed.
 *
 * The listing is a conditional request when `known` holds a listing of this
 * gist: a 304 means the gist still has exactly that ETag, so its file set is
 * exactly the remembered one, and the orphan cleanup reads that instead of
 * downloading every file's content to learn their names.
 *
 * @param {string} token - GitHub personal access token
 * @param {string|null} gistId - Existing gist id, or null to create one
 * @param {Object} manifest - Manifest object, stored as pretty JSON
 * @param {Array<string>} chunks - Payload chunks in order
 * @param {number} [previousChunkCount=0] - How many chunks this device last wrote, as a hint
 * @param {{gistId: string, etag: string, files: Record<string, number>}|null} [known] - A remembered
 *   listing: the gist's ETag and the file sizes it had at that ETag
 * @param {Object} [options] - Options
 * @param {boolean} [options.unattended=false] - A push nobody pressed a button for (interval, character
 *   switch, session handoff). It refuses to replace an encrypted gist with a payload in the clear — a device
 *   whose passphrase was never entered would otherwise turn every other device's encryption off on its next
 *   interval, without a word — and it refuses to write a gist it could not list, since it cannot then tell
 *   what it would be writing over.
 * @param {(() => Promise<boolean>)|null} [options.confirmPlaintext=null] - For a push someone did press:
 *   asked before a payload in the clear replaces an encrypted gist. False cancels the write.
 * @param {((manifest: {syncSeq: number|null, exportedAt: string|null, unordered: boolean, version: string|null,
 *   etag: string|null}) => boolean)|null} [options.isAhead=null]
 *   Asked of a gist this write had to download the listing of (not a 304 against `known`): true means the gist
 *   holds an exchange the caller has not taken, and the write stops with a `behind` GistError instead of
 *   overwriting it — the caller merges first.
 * @returns {Promise<{id: string, updatedAt: string, etag: string|null, files: Record<string, number>|null,
 *   syncSeq: number|undefined, version: string|null, basedOn: string|null, intervening: Array<string>}>} The
 *   gist that was written, with the ETag and file sizes of the version the write produced, the counter its
 *   manifest actually carries (raised above the gist's own, see below), the version it produced and the one it
 *   was based on, and any versions other devices wrote in between that this write replaced (oldest first)
 */
export async function writeSyncGist(
    token,
    gistId,
    manifest,
    chunks,
    previousChunkCount = 0,
    known = null,
    { unattended = false, confirmPlaintext = null, isAhead = null } = {}
) {
    let listing = known && gistId && known.gistId === gistId && known.etag && known.files ? known : null;

    // Everything but the orphan list is the same on every attempt, so the body
    // is serialized again only when a retry's listing names different orphans.
    // A full-scope body is megabytes; stringifying it once per 409 was waste.
    const files = {};
    chunks.forEach((chunk, index) => {
        // A gist file may not be empty; a single space keeps an empty payload legal
        files[chunkFileName(index)] = { content: chunk === '' ? ' ' : chunk };
    });
    const payloadBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    let serialized = null;
    let plaintextConfirmed = false;
    let attempts = 0;

    const attempt = async () => {
        attempts += 1;
        // Listed before the size guard, because what survives the write counts
        // towards the ceiling as much as what is being written. Inside the
        // attempt so a conflict retry sees the file set that just beat it.
        if (gistId) {
            const fresh = await listGistFiles(token, gistId, listing);
            // Fail closed, pressed push or not: with no listing the write cannot
            // see the counter or the encryption it would be writing over. A
            // device with a stale counter would write it below the gist's, and
            // every device holding the higher one would read the gist as older
            // and skip it — for as many pushes as the gap is wide.
            if (!fresh) {
                throw new GistError(
                    'unlisted',
                    unattended
                        ? 'The sync gist could not be listed before writing it.'
                        : "Couldn't read the gist's current state, so nothing was pushed. Try again."
                );
            }
            // A conflict means another device just wrote: the first attempt's listing predates it, so
            // its counter and encryption cannot be trusted. Without a fresh one the retry stops.
            if (!fresh && attempts > 1) {
                throw new GistError(
                    'unlisted',
                    'Another device pushed at the same moment and the sync gist could not be listed again.'
                );
            }
            listing = fresh;
        }
        const existingFiles = listing?.files ?? null;

        const orphans = [];
        let survivingBytes = 0;
        if (existingFiles) {
            for (const [name, size] of Object.entries(existingFiles)) {
                if (name === MANIFEST_FILE || Object.hasOwn(files, name)) continue; // being overwritten
                if (chunkIndexFromName(name) !== null) {
                    // A chunk this payload does not reach is an orphan, whoever wrote it
                    orphans.push(name);
                    continue;
                }
                // Something else lives in this gist. Not ours to delete, but its
                // bytes are just as real to the API's ceiling.
                survivingBytes += Number(size) || 0;
            }
        } else {
            for (let index = chunks.length; index < previousChunkCount; index += 1) {
                orphans.push(chunkFileName(index));
            }
        }
        orphans.sort();

        if (payloadBytes + survivingBytes > MAX_GIST_BYTES) {
            throw new GistError(
                'too-large',
                'This backup is too big for a single gist. Switch Sync scope to "Settings only".'
            );
        }

        // Unknown counts as encrypted: an unreadable manifest, or no listing for a pressed push, must
        // not let plaintext replace what may be an encrypted gist without asking
        if (gistId && listing?.encrypted !== false && !manifest?.encrypted) {
            if (unattended) {
                throw new GistError(
                    'passphrase',
                    'The sync gist is encrypted and this device has no sync passphrase, so pushing would replace ' +
                        'it unencrypted. Automatic pushes from this device are skipped until the passphrase is entered.'
                );
            }
            if (confirmPlaintext && !plaintextConfirmed) {
                if (!(await confirmPlaintext())) throw new GistError('cancelled', 'The push was cancelled.');
                // Asked once per push, not again on a conflict retry
                plaintextConfirmed = true;
            }
        }

        // Another device has pushed since this one last took the gist. Writing
        // now would replace that push with a copy that has never seen it
        if (isAhead && listing?.fresh && isAhead(listing)) {
            throw new GistError('behind', 'The sync gist has changes this device has not taken yet.');
        }

        // The counter is written above whatever the gist already carries.
        // This device's own counter only knows the exchanges it took part in:
        // a device that last took 5 and pushes 6 over a gist another device
        // has since taken to 7 would write a payload every device at 7 reads
        // as *older* — skipped as "not newer", marked current, and never
        // downloaded again — while its contents are now the gist's. Lamport's
        // send rule is one above everything seen, and the listing just saw it.
        const remoteSeq = listing?.syncSeq ?? null;
        const syncSeq =
            Number.isSafeInteger(manifest?.syncSeq) && remoteSeq !== null && remoteSeq >= manifest.syncSeq
                ? remoteSeq + 1
                : manifest?.syncSeq;
        // The version this write was decided against, in the manifest: the
        // check after the write compares it with what the gist's history says
        // came before this write, and a device whose own push was replaced
        // can tell from it that the replacement never saw that push.
        const basedOn = gistId && listing?.version ? listing.version : null;
        const writtenManifest =
            syncSeq === manifest?.syncSeq && !basedOn
                ? manifest
                : { ...manifest, syncSeq, ...(basedOn ? { basedOn } : {}) };

        const orphanKey = `${orphans.join('\n')}|${syncSeq}|${basedOn}`;
        if (serialized?.orphanKey !== orphanKey) {
            const withOrphans = { [MANIFEST_FILE]: { content: JSON.stringify(writtenManifest, null, 2) }, ...files };
            for (const name of orphans) withOrphans[name] = null;
            const body = {
                description: 'Toolasha cross-device sync (do not edit by hand)',
                files: withOrphans,
                ...(gistId ? {} : { public: false }),
            };
            serialized = { orphanKey, syncSeq, basedOn, text: JSON.stringify(body) };
        }

        if (gistId) {
            const updated = await apiExchange(token, 'PATCH', `/gists/${encodeURIComponent(gistId)}`, {
                body: serialized.text,
            });
            // GitHub takes a PATCH unconditionally — the update endpoint has no
            // precondition and answers no 409 — so two devices that both listed
            // the gist before either wrote both succeed, and the later write
            // replaces the earlier one. The write's own history says whether
            // that happened: the entry under this write should be the version
            // this write was based on.
            let history = historyVersions(updated.data);
            if (!history && serialized.basedOn) {
                const relisted = await listGistFiles(token, gistId, null);
                history = relisted?.history ?? null;
            }
            return {
                id: updated.data?.id ?? gistId,
                updatedAt: updated.data?.updated_at ?? null,
                etag: updated.etag,
                files: fileSizes(updated.data?.files),
                syncSeq: serialized.syncSeq,
                version: history?.[0] ?? null,
                basedOn: serialized.basedOn,
                intervening: interveningVersions(history, serialized.basedOn),
            };
        }

        const created = await apiExchange(token, 'POST', '/gists', { body: serialized.text });
        if (!created.data?.id) throw new GistError('parse', 'GitHub created a gist but did not say which one.');
        return {
            id: created.data.id,
            updatedAt: created.data.updated_at ?? null,
            etag: created.etag,
            files: fileSizes(created.data.files),
            syncSeq: serialized.syncSeq,
        };
    };

    // A 409 is two pushes landing on the same gist at the same moment — two
    // characters' tabs both on the sync interval, mostly. The loser's state is
    // no less worth writing for having lost the race, so it retries after a
    // short jittered pause with a fresh listing; whole-gist overwrite plus
    // newest-wins pulls make replaying the same payload safe. Only conflicts
    // retry — every other failure means the same request would fail the same way.
    const CONFLICT_RETRIES = 2;
    for (let tries = 0; ; tries += 1) {
        try {
            return await attempt();
        } catch (error) {
            if (!(error instanceof GistError) || error.kind !== 'conflict' || tries >= CONFLICT_RETRIES) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));
        }
    }
}

/**
 * The files a gist currently holds, or null when they cannot be read.
 *
 * A failure here must not fail the push: the listing is an improvement on the
 * remembered chunk count, not a prerequisite for writing. A transport error
 * that would fail the push anyway will fail it a moment later on the PATCH,
 * with its own classification intact.
 *
 * With a previous listing, the request is conditional and a 304 returns that
 * listing unchanged. The pair is only ever stored together — an ETag and the
 * file sizes of the response that carried it — so a match proves the file set.
 *
 * @param {string} token - GitHub personal access token
 * @param {string} gistId - Gist id
 * @param {{etag: string, files: Record<string, number>}|null} previous - Listing to revalidate
 * @returns {Promise<{gistId: string, etag: string|null, files: Record<string, number>, syncSeq: number|null,
 *   encrypted: boolean|null}|null>} The listing, with what the gist's manifest says (null when unread, or kept
 *   from `previous` on a 304)
 */
async function listGistFiles(token, gistId, previous) {
    try {
        const ifNoneMatch = previous?.etag && previous.files ? previous.etag : null;
        const exchange = await apiExchange(token, 'GET', `/gists/${encodeURIComponent(gistId)}`, { ifNoneMatch });
        if (exchange.notModified) {
            return {
                gistId,
                etag: exchange.etag,
                files: previous.files,
                syncSeq: previous.syncSeq ?? null,
                encrypted: previous.encrypted ?? null,
                exportedAt: null,
                unordered: false,
                version: previous.version ?? null,
                fresh: false,
            };
        }
        const files = fileSizes(exchange.data?.files);
        return files
            ? {
                  gistId,
                  etag: exchange.etag,
                  files,
                  fresh: true,
                  version: historyVersions(exchange.data)?.[0] ?? null,
                  history: historyVersions(exchange.data),
                  ...listedManifest(exchange.data?.files),
              }
            : null;
    } catch (error) {
        console.warn('[GistClient] Could not list the gist before writing it:', error?.message || error);
        return null;
    }
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
    readSyncGistRevision,
    writeSyncGist,
};
