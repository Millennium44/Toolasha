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
 * A gist says which server it is for in two places: its description, which
 * the gist list shows (discovery reads only the list, which carries no file
 * contents), and `server` in its manifest, which a push or pull reads. Both are
 * written together on every push. A gist written before either existed is
 * "untagged".
 */

import { isTestServer } from '../../utils/game-server.js';

/** What every sync gist's description starts with, tagged or not */
export const SYNC_DESCRIPTION_PREFIX = 'Toolasha cross-device sync';

/** The description every gist was written with before it named a server */
export const LEGACY_SYNC_DESCRIPTION = `${SYNC_DESCRIPTION_PREFIX} (do not edit by hand)`;

/** How a description names each server */
const DESCRIPTION_LABELS = { live: 'live', test: 'test server' };

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
