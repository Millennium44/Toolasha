/**
 * Marketplace-patch server gate (8/13/2026 update).
 *
 * The 8/13/2026 marketplace update — 5% market tax, shrine levels shared on
 * profiles, and the rest — is now live on **both** servers, so the gate is open
 * everywhere and every patch-dependent behaviour uses the patched rule. It was
 * hostname-gated while the patch was live only on the test server; that window
 * has closed.
 *
 * ## Kept as one line
 *
 * The gate stays a function that every patch-dependent site reads, rather than
 * being deleted at each call, so there is still a single place to reason about
 * the patch — and a single place to re-gate the next server-staged change from,
 * by putting the hostname test back.
 */

/**
 * Whether the 8/13/2026 marketplace patch is in effect on the current server.
 *
 * True everywhere now that the patch is live on `www` as well as `test`. Left as
 * a function so the call sites do not have to change when a future patch needs
 * staging again.
 *
 * @returns {boolean}
 */
export function isMarketplacePatchLive() {
    return true;
}
