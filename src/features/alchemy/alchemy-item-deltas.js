/**
 * Reading gains out of `endCharacterItems`.
 *
 * The alchemy trackers used to count how many item entries a message carried
 * and call that the number of successful actions. That works only while the
 * game sends one message per action: `endCharacterItems` rows are one per
 * changed inventory STACK, each carrying the stack's new absolute total, so a
 * message covering a batch of efficiency procs still carries one row per item.
 * Counting rows therefore answered "how many different things changed", which
 * for coins — a single stack — could only ever be 0 or 1.
 *
 * The count delta is the one thing in the message that scales with the batch,
 * and the same delta is what the attempt count is already derived from. This
 * keeps the last seen total per stack so the next message can be read as a gain.
 */

/**
 * A ledger of last-seen stack totals.
 *
 * @returns {{note: Function, reset: Function}} The ledger
 */
export function createItemCountLedger() {
    /** @type {Map<string|number, number>} stack id → last seen absolute count */
    const counts = new Map();

    const ledger = {
        /**
         * Record these rows and hand each one's change back.
         *
         * A stack seen for the first time has no baseline, and its delta is
         * null rather than 0 — "no baseline" and "gained nothing" are different
         * answers and only the caller knows which fallback is honest.
         *
         * @param {Array<Object>} rows - `endCharacterItems` rows
         * @returns {Array<{row: Object, delta: number|null}>} One entry per usable row
         */
        noteEach(rows) {
            const seen = [];

            for (const row of rows || []) {
                const id = row?.id ?? row?.itemHrid;
                if (id === undefined || id === null) continue;
                const count = Number(row.count);
                if (!Number.isFinite(count)) continue;

                const previous = counts.get(id);
                seen.push({ row, delta: previous === undefined ? null : count - previous });
                counts.set(id, count);
            }

            return seen;
        },

        /**
         * Record these rows and hand back what they gained between them.
         *
         * @param {Array<Object>} rows - `endCharacterItems` rows, already filtered
         * @returns {number|null} Net change across the rows, or null when none of
         *   them had a baseline to measure against
         */
        note(rows) {
            let total = 0;
            let measured = false;

            for (const { delta } of ledger.noteEach(rows)) {
                if (delta === null) continue;
                total += delta;
                measured = true;
            }

            return measured ? total : null;
        },

        /** Forget every baseline — a new session measures from scratch. */
        reset() {
            counts.clear();
        },
    };

    return ledger;
}
