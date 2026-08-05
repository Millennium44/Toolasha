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

/** The live game, the test game, and nothing else Toolasha runs on */
const TEST_HOSTNAMES = new Set(['test.milkywayidle.com', 'api-test.milkywayidle.com']);

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
