/**
 * Which game server this is
 *
 * Milky Way Idle runs a test server beside the live one, on its own hostname
 * and with its own database. Playing on it is ordinary — it is where new
 * content is tried — but the two are different worlds: different characters,
 * different prices, different economy.
 *
 * That matters wherever Toolasha sends something outward. A test-server order
 * book uploaded to a pooled price dataset is not a cheaper price, it is a wrong
 * one, and it is indistinguishable from a real one once it has landed. So
 * anything that contributes data to a shared service asks here first.
 *
 * Reading is a different question and mostly harmless — a test-server session
 * looking up live history gets live history, which is what it was after.
 */

/** The test servers of the international site and of its CN mirror, page and socket hosts alike */
const TEST_HOSTNAMES = new Set([
    'test.milkywayidle.com',
    'api-test.milkywayidle.com',
    'test.milkywayidlecn.com',
    'api-test.milkywayidlecn.com',
]);

/** Every origin the game itself is served from. The sim-site @matches are not on this list. */
const GAME_ORIGINS = new Set([
    'https://www.milkywayidle.com',
    'https://test.milkywayidle.com',
    'https://www.milkywayidlecn.com',
    'https://test.milkywayidlecn.com',
]);

/** Where a page that is not a game host (a sim site) reads game files from */
const FALLBACK_ORIGIN = 'https://www.milkywayidle.com';

/** The one host whose market the pooled third-party price dataset is keyed to */
const POOLED_DATASET_HOSTNAME = 'www.milkywayidle.com';

/**
 * The hostname this page is on, or an empty string off a browser.
 * @returns {string}
 */
function currentHostname() {
    try {
        return String(globalThis.location?.hostname || '').toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Whether this is the test server.
 *
 * Matches by hostname rather than by anything in the game data, because the
 * answer is needed before a character has loaded and because the hostname is
 * the one thing the two servers can never share.
 *
 * @param {string} [hostname] - Overrides the page's own, for tests
 * @returns {boolean} True on the test server, false on live and false anywhere
 *   the question does not apply — an unknown host is treated as live, which is
 *   the answer that keeps a real session contributing
 */
export function isTestServer(hostname = currentHostname()) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    return TEST_HOSTNAMES.has(host);
}

/**
 * The origin to read the game's own static files from (market JSON, asset
 * manifest). A game host reads its own copy; anything else — a sim site the
 * script is also matched on — falls back to the international site.
 *
 * @param {string} [origin] - Overrides the page's own, for tests
 * @returns {string} An origin with no trailing slash
 */
export function gameOrigin(origin = globalThis.location?.origin) {
    const normalized = String(origin || '').toLowerCase();
    return GAME_ORIGINS.has(normalized) ? normalized : FALLBACK_ORIGIN;
}

/**
 * Whether this page is on the host whose market the pooled price dataset
 * describes. The CN mirror and the test servers are excluded: whether the CN
 * order books are the international ones is unconfirmed, and a wrong book
 * cannot be told from a right one once it has been uploaded.
 *
 * @param {string} [hostname] - Overrides the page's own, for tests
 * @returns {boolean} True only on www.milkywayidle.com
 */
export function isPooledDatasetSite(hostname = currentHostname()) {
    return String(hostname || '').toLowerCase() === POOLED_DATASET_HOSTNAME;
}
