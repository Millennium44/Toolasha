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

/**
 * Whether a stored record was written by the build that is running now.
 *
 * The rule the labyrinth sim cache already applies to its persisted combat
 * results: a computed output is only as current as the code that computed it,
 * so a build whose engine changed must not serve its predecessor's numbers back
 * as its own. A record with no stamp predates the stamping and counts as
 * foreign, because nothing about it says which engine produced it.
 *
 * @param {Object|null|undefined} record - A stored record carrying `scriptVersion`
 * @returns {boolean} True when the record's stamp matches the running build
 */
export function fromCurrentBuild(record) {
    if (!record || typeof record !== 'object') return false;
    return (record.scriptVersion ?? null) === scriptVersion();
}

/**
 * A keyed map of stored records, reduced to the ones this build wrote.
 *
 * Filtered as a whole rather than at each lookup, so a stale record is kept out
 * of the lists built from the map's keys too: a dropdown that offers a zone
 * whose rate is then refused reads as a bug, where a zone that is simply not
 * listed reads as one this build has not simulated.
 *
 * @param {Object|null|undefined} map - Keyed records, each carrying `scriptVersion`
 * @returns {Object} A new map holding only the current build's records
 */
export function currentBuildEntries(map) {
    const kept = {};
    if (!map || typeof map !== 'object') return kept;
    for (const [key, record] of Object.entries(map)) {
        if (fromCurrentBuild(record)) kept[key] = record;
    }
    return kept;
}
