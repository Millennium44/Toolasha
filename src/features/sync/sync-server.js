/**
 * Which game server a sync gist belongs to.
 *
 * The live game and the test server are different worlds, and each browser
 * origin keeps its own gist id. One GitHub token commonly holds a gist for
 * each, so a device that has to find its gist again (a fresh install, Unlink,
 * a gist that went missing) must not adopt the other server's: that is how a
 * live game ended up syncing with the test server's gist, and then could not
 * read it once the test passphrase changed.
 *
 * A gist says which server it is for in three places, strongest first:
 * - a marker file named for the server (`toolasha-server-live.txt`), which the
 *   gist list shows by name without fetching content. A push from an older
 *   build rewrites the description and manifest without the server but only
 *   touches the files it names, so the marker survives it;
 * - `server` in its manifest, which a push or pull reads;
 * - its description, which the gist list also shows.
 * A gist written before any of these existed is "untagged".
 */

import { isTestServer } from '../../utils/game-server.js';

/** What every sync gist's description starts with, tagged or not */
export const SYNC_DESCRIPTION_PREFIX = 'Toolasha cross-device sync';

/** The description every gist was written with before it named a server */
export const LEGACY_SYNC_DESCRIPTION = `${SYNC_DESCRIPTION_PREFIX} (do not edit by hand)`;

/** How a description names each server */
const DESCRIPTION_LABELS = { live: 'live', test: 'test server' };

/** Prefix of the marker file that names a gist's server in its file list */
export const SERVER_MARKER_PREFIX = 'toolasha-server-';

/**
 * The marker file name for a server.
 * @param {'live'|'test'} server - Server kind
 * @returns {string} File name, e.g. `toolasha-server-live.txt`
 */
export function serverMarkerFile(server) {
    return `${SERVER_MARKER_PREFIX}${server}.txt`;
}

/**
 * The content of a marker file: one line saying what it is.
 * @param {'live'|'test'} server - Server kind
 * @returns {string} File content
 */
export function serverMarkerContent(server) {
    return `Toolasha sync gist for ${server === 'test' ? 'the test server' : 'the live game'}. Do not edit or delete by hand.\n`;
}

/**
 * Whether a gist file name is a server marker (of either server).
 * @param {*} name - A gist file name
 * @returns {boolean} True for a marker file
 */
export function isServerMarkerFile(name) {
    return name === serverMarkerFile('live') || name === serverMarkerFile('test');
}

/**
 * The server a gist's file names mark it for. Only one marker means anything;
 * two (a hand-made mess) say nothing, so the manifest and description decide.
 * @param {Iterable<string>|null|undefined} names - File names of the gist
 * @returns {'live'|'test'|null} The marked server, or null
 */
export function markerServer(names) {
    if (!names) return null;
    const set = new Set(names);
    const live = set.has(serverMarkerFile('live'));
    const test = set.has(serverMarkerFile('test'));
    if (live === test) return null;
    return live ? 'live' : 'test';
}

/**
 * Which server this page is on.
 * @param {string} [hostname] - Overrides the page's own, for tests
 * @returns {'live'|'test'} The server kind; anything that is not a test host is live
 */
export function serverKind(hostname) {
    return isTestServer(hostname) ? 'test' : 'live';
}

/**
 * Whether a value is a server kind a gist can be tagged with.
 * @param {*} value - Candidate
 * @returns {boolean} True for 'live' or 'test'
 */
export function isServerKind(value) {
    return value === 'live' || value === 'test';
}

/**
 * The description a push writes for a gist of this server.
 * @param {'live'|'test'|null|undefined} server - The server the gist is for
 * @returns {string} Description; the legacy one when no server is named
 */
export function syncGistDescription(server) {
    if (!isServerKind(server)) return LEGACY_SYNC_DESCRIPTION;
    return `${SYNC_DESCRIPTION_PREFIX} — ${DESCRIPTION_LABELS[server]} (do not edit by hand)`;
}

/**
 * The server a gist description names, or null for an untagged one (the
 * legacy description, a hand-edited one, or none).
 * @param {*} description - A gist's description
 * @returns {'live'|'test'|null} The server it is tagged for
 */
export function descriptionServer(description) {
    if (typeof description !== 'string' || !description.startsWith(SYNC_DESCRIPTION_PREFIX)) return null;
    const match = /^ — (live|test server) \(/.exec(description.slice(SYNC_DESCRIPTION_PREFIX.length));
    if (!match) return null;
    return match[1] === 'live' ? 'live' : 'test';
}

/**
 * A server, the way a sentence names it.
 * @param {'live'|'test'} server - Server kind
 * @returns {string} "the live game" or "the test server"
 */
export function serverName(server) {
    return server === 'test' ? 'the test server' : 'the live game';
}

/**
 * The gist id in what someone typed or pasted: the bare 32-character id, or a
 * gist link (gist.github.com/<user>/<id>, its raw form, or the API's
 * /gists/<id>).
 * @param {*} input - Text from the Gist ID box
 * @returns {string|null} The id in lower case, or null when there is none
 */
export function parseGistId(input) {
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (/^[0-9a-f]{32}$/i.test(text)) return text.toLowerCase();
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    const allowed = ['gist.github.com', 'gist.githubusercontent.com', 'api.github.com'];
    if (url.protocol !== 'https:' || !allowed.includes(host)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    // The id is the first 32-hex segment: /<user>/<id>, /<id>, /gists/<id>, /<user>/<id>/raw/...
    const id = segments.find((segment) => /^[0-9a-f]{32}$/i.test(segment));
    return id ? id.toLowerCase() : null;
}

/**
 * What a sync says when it refuses the other server's gist.
 * @param {'live'|'test'} gistServer - The server the gist is tagged for
 * @param {'live'|'test'} here - The server this page is on
 * @returns {string} Message, safe to show
 */
export function wrongServerMessage(gistServer, here) {
    return (
        `The sync gist this device uses belongs to ${serverName(gistServer)}, and this is ${serverName(here)}, ` +
        'so nothing was synced.'
    );
}
