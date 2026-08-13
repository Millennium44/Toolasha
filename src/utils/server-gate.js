/**
 * Marketplace-patch server gate (8/13/2026 update).
 *
 * The 8/13/2026 marketplace update — 5% market tax, shrine levels shared on
 * profiles, and the rest — is live on the test server and reaches the live
 * server within hours. Until it is live everywhere, the live server must behave
 * exactly as it did before, so every patch-dependent behaviour is gated on which
 * server the script is running on.
 *
 * ## Un-gating, in one place
 *
 * When the patch is live everywhere, change the body of {@link isMarketplacePatchLive}
 * to `return true;` and ship. Every gated behaviour (the tax rate, the shrine
 * fold into gear score, anything added later) flips to the patched rule at once,
 * so there is a single line to flip and nothing to hunt down.
 *
 * ## Why hostname
 *
 * The userscript matches both `www.milkywayidle.com` and `test.milkywayidle.com`,
 * so the same build runs on both and the hostname is the only thing that tells
 * them apart. It is read at load and does not change within a session. In a Web
 * Worker (spawned from a blob URL) the hostname is not the game's, so anything
 * that must know the rate inside a worker is passed the value from the main
 * thread rather than re-deriving it here.
 */

/**
 * Whether the 8/13/2026 marketplace patch is in effect on the current server.
 * @returns {boolean}
 */
export function isMarketplacePatchLive() {
    // Un-gate point: replace the two lines below with `return true;` once the
    // patch is live on www as well.
    if (typeof location === 'undefined' || !location || !location.hostname) return false;
    return location.hostname.includes('test.milkywayidle');
}
