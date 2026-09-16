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
 *
 * ## One message can carry the same stack several times
 *
 * Measured live (transmuting a refined cape, one item per success): a single
 * `action_completed` whose `currentCount` advanced by three carried three rows
 * for the input stack, counts ascending — 936, 937, 938. They are not three
 * stacks and not three gains; they are successive snapshots of the one stack as
 * the batched actions played out, and only the LAST of them is the total the
 * stack actually ended on. Reading them as separate rows made every consumer
 * count the batch once per snapshot: the transmute tracker added its attempt
 * count once per row and recorded ~1.6x as many self-returns as there were
 * successes, which in turn drove its net input consumption to zero.
 *
 * So rows are folded to one per stack, last wins, before any of them is read.
 */

/**
 * The stack a row belongs to.
 *
 * `id` is the stack's own key and is what the game sends; the item hrid is a
 * fallback for rows that arrive without one.
 *
 * @param {Object} row - An `endCharacterItems` row
 * @returns {string|number|undefined} The stack's identity, or undefined
 */
function stackKey(row) {
    return row?.id ?? row?.itemHrid;
}

/**
 * Collapse repeated snapshots of the same stack down to the last one.
 *
 * Distinct stacks are left alone, including two stacks of the same item — they
 * have different ids and moved independently.
 *
 * @param {Array<Object>} rows - `endCharacterItems` rows, in the order sent
 * @returns {Array<Object>} One row per stack, each the last seen for it
 */
export function foldStackRows(rows) {
    const byStack = new Map();

    for (const row of rows || []) {
        const key = stackKey(row);
        if (key === undefined || key === null) continue;
        // Set after delete so the surviving row keeps the stack's LAST position
        // as well as its last count
        byStack.delete(key);
        byStack.set(key, row);
    }

    return [...byStack.values()];
}

/**
 * A ledger of last-seen stack totals.
 *
 * @returns {{note: Function, noteEach: Function, reset: Function}} The ledger
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
         * Repeated rows for one stack are folded to the last of them first, so
         * a caller gets one entry — and one delta — per stack however many
         * snapshots the message carried.
         *
         * @param {Array<Object>} rows - `endCharacterItems` rows
         * @returns {Array<{row: Object, delta: number|null}>} One entry per changed stack
         */
        noteEach(rows) {
            const seen = [];

            for (const row of foldStackRows(rows)) {
                const id = stackKey(row);
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
