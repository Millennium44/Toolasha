/**
 * What an alchemy action actually spent on catalysts.
 *
 * ## An allowlist records an unknown catalyst as free
 *
 * Coinify and decompose used to test the secondary slot against two constants
 * each and add the successes to a matching field. Anything else — a catalyst the
 * game adds later, or one the author did not think of — matched neither branch
 * and was recorded as nothing at all. Nothing is indistinguishable from free, so
 * the session's profit came out quietly too good, which is the same class of
 * error as every other "an unknown treated as zero" bug.
 *
 * So there is no allowlist here. Whatever hrid the slot names is recorded under
 * that hrid, and a reader that does not recognise it can still see that
 * something was spent.
 *
 * ## Measured, not inferred
 *
 * Adding the success count assumes the game's consumption rule. The message says
 * what was actually spent: the catalyst's own stack appears in
 * `endCharacterItems`, one lower per consumption (measured live on transmute:
 * prime_catalyst 962662 → 962661 across consecutive messages). The observed
 * decrement is preferred and the success count is only the fallback, for a
 * message with no baseline for that stack yet.
 *
 * Read through the FOLDED ledger, never the raw rows: a batched message carries
 * the catalyst stack once per packed action, and counting those snapshots would
 * multiply the consumption the way self-returns once were. See
 * `alchemy-item-deltas.js`.
 */

/**
 * Record one message's catalyst spend on a session.
 *
 * Writes the general `catalystsUsed` record, keyed by hrid, and — when the
 * caller maps this hrid to one of its own legacy fields — adds the same count
 * there, so sessions stored before this existed and readers that only know the
 * old fields keep working.
 *
 * @param {Object} session - The active session, mutated
 * @param {Object} options - The message's moving parts
 * @param {string|null} options.catalystHrid - Catalyst in the secondary slot
 * @param {Array<{row: Object, delta: number|null}>} options.noted - The FOLDED ledger entries
 * @param {number} options.successCount - Successes this message covered
 * @param {number} options.attemptCount - Attempts this message covered
 * @param {Object} [options.legacyFields] - hrid → session field name to keep populated
 * @param {boolean} [options.stackKnown] - The ledger holds a baseline for every
 *   stack of this catalyst, so a message with no row for it spent none
 * @returns {number} How many catalysts were recorded as spent
 */
export function recordCatalystUse(
    session,
    { catalystHrid, noted, successCount, attemptCount, legacyFields, stackKnown = false }
) {
    if (!session || !catalystHrid) return 0;

    if (!session.catalystsUsed) {
        session.catalystsUsed = {};
    }

    // A spend outside [0, attempts] is not this action's doing — the player
    // bought or sold catalysts while the run was going — and the successes are
    // the honest answer for that message
    let observed = null;
    let rowSeen = false;
    for (const { row, delta } of noted || []) {
        if (row?.itemHrid !== catalystHrid) continue;
        rowSeen = true;
        if (delta === null) continue;
        const spent = -delta;
        if (spent < 0 || spent > attemptCount) continue;
        observed = (observed ?? 0) + spent;
    }
    // Every consumption moves the stack, so a known stack that did not move
    // was not spent from — the slot still names a catalyst whose stack ran out
    if (observed === null && !rowSeen && stackKnown) observed = 0;

    const consumed = observed ?? successCount;
    session.catalystsUsed[catalystHrid] = (session.catalystsUsed[catalystHrid] || 0) + consumed;

    const legacyField = legacyFields?.[catalystHrid];
    if (legacyField) {
        session[legacyField] = (session[legacyField] || 0) + consumed;
    }

    return consumed;
}

export default { recordCatalystUse };
