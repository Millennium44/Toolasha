/**
 * The running script's version, for stamping stored records.
 *
 * A stored prediction or measurement outlives the code that produced it, and a
 * ledger that pools records across engine changes reads an engine fix as drift.
 * The version string is the cheapest honest cohort marker there is: stamped at
 * write time, it lets a reader split "measured under the current engine" from
 * "measured under some earlier one" without guessing from timestamps.
 *
 * Null outside the userscript sandbox (tests, a bare import), and callers store
 * that null as-is — "unknown version" is itself a cohort.
 *
 * @returns {string|null} The `@version` of the running build
 */
export function scriptVersion() {
    try {
        return typeof GM_info !== 'undefined' ? GM_info?.script?.version || null : null;
    } catch {
        return null;
    }
}
