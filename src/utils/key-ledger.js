/**
 * Dungeon key ledger
 *
 * How many keys a character actually spent, as opposed to how many they were
 * assumed to have spent.
 *
 * ## Why not just take the difference
 *
 * The obvious measurement is the count at the start of a run against the count
 * at the end, which is what the "Key counts" chat message offers. It is wrong
 * the moment somebody buys keys mid-run: start at 10, spend 3, buy 20, and the
 * difference says they *gained* 17. There is no way to recover the 3 from two
 * samples, because two samples cannot tell one number changing twice from one
 * number changing once.
 *
 * So this does not sample. It watches every change and adds up the two
 * directions separately: a count that falls is keys consumed, a count that rises
 * is keys acquired. Buying mid-run lands in `gained` and never touches `spent`.
 *
 * ## What it can and cannot see
 *
 * `items_updated` is the character's own inventory, so this is exact for the
 * player running it and silent about everybody else. Party members are only
 * visible through the chat message, which is two samples — so their figure is
 * trustworthy only while it falls, and this exposes `sample()` to record that
 * distinction rather than averaging a wrong number into a right one.
 *
 * A fall is not necessarily a dungeon: keys can be listed on the market or given
 * away, and both look exactly like spending one. Nothing in the payload
 * distinguishes them, so the ledger counts what it sees and the caller decides
 * what window to trust — which for a dungeon is the run itself.
 */

/** The key a dungeon takes to enter, per dungeon */
export const ENTRY_KEYS = {
    '/actions/combat/chimerical_den': '/items/chimerical_entry_key',
    '/actions/combat/sinister_circus': '/items/sinister_entry_key',
    '/actions/combat/enchanted_fortress': '/items/enchanted_entry_key',
    '/actions/combat/pirate_cove': '/items/pirate_entry_key',
};

/** Everything this tracks, entry keys and the keys that open the chests */
export const TRACKED_KEYS = new Set([
    ...Object.values(ENTRY_KEYS),
    '/items/chimerical_chest_key',
    '/items/sinister_chest_key',
    '/items/enchanted_chest_key',
    '/items/pirate_chest_key',
]);

/** Where a key has to be for this to be counting the right pile */
const INVENTORY = '/item_locations/inventory';

/**
 * A fresh ledger.
 *
 * @returns {Object} `{counts, spent, gained, samples}`
 */
export function newKeyLedger() {
    return { counts: {}, spent: {}, gained: {}, samples: {} };
}

/**
 * Take an `items_updated` payload and record what moved.
 *
 * The payload carries new absolute counts for the rows that changed, not deltas,
 * so the previous count has to be remembered here — by the time a listener runs,
 * the data manager has already applied the update over the old value.
 *
 * @param {Object} ledger - From `newKeyLedger`, mutated
 * @param {Array<Object>} endCharacterItems - The changed rows
 * @returns {Object} The same ledger
 */
export function noteItems(ledger, endCharacterItems) {
    for (const item of endCharacterItems || []) {
        if (!TRACKED_KEYS.has(item?.itemHrid)) continue;
        if (item.itemLocationHrid && item.itemLocationHrid !== INVENTORY) continue;

        const count = Number(item.count);
        if (!Number.isFinite(count) || count < 0) continue;

        const hrid = item.itemHrid;
        const before = ledger.counts[hrid];
        ledger.counts[hrid] = count;

        // The first sighting is where counting starts. Whatever they were
        // already holding is not a purchase and is certainly not a dungeon.
        if (before === undefined) continue;

        const moved = count - before;
        if (moved < 0) ledger.spent[hrid] = (ledger.spent[hrid] || 0) + -moved;
        else if (moved > 0) ledger.gained[hrid] = (ledger.gained[hrid] || 0) + moved;
    }
    return ledger;
}

/**
 * Record somebody else's key count, seen from the outside.
 *
 * This is the two-sample case, and it is kept apart from `spent` because it is a
 * weaker measurement. A fall is real spending. A rise means they acquired keys,
 * and how many they *also* spent in that window is not recoverable — so the
 * sample is marked unusable rather than counted as zero, which would quietly
 * drag an average down every time somebody restocked.
 *
 * @param {Object} ledger - From `newKeyLedger`, mutated
 * @param {string} who - Whose count this is
 * @param {number} count - What they hold now
 * @returns {Object} The same ledger
 */
export function sample(ledger, who, count) {
    if (!who || !Number.isFinite(count) || count < 0) return ledger;

    const previous = ledger.samples[who];
    if (!previous) {
        ledger.samples[who] = { seen: count, spent: 0, runs: 0, unmeasurable: 0 };
        return ledger;
    }

    const moved = count - previous.seen;
    previous.seen = count;

    if (moved < 0) {
        previous.spent += -moved;
        previous.runs += 1;
    } else if (moved > 0) {
        // They bought, traded for or opened something into keys. Whatever they
        // spent in the same window is underneath that and cannot be dug out.
        previous.unmeasurable += 1;
    }
    return ledger;
}

/**
 * What one key cost this character, net of anything they picked up.
 *
 * @param {Object} ledger - From `newKeyLedger`
 * @param {string} itemHrid - Which key
 * @returns {{spent: number, gained: number}}
 */
export function keyFlow(ledger, itemHrid) {
    return { spent: ledger.spent[itemHrid] || 0, gained: ledger.gained[itemHrid] || 0 };
}

/**
 * The entry key a dungeon takes.
 *
 * @param {string} actionHrid - The dungeon
 * @returns {string|null}
 */
export function entryKeyFor(actionHrid) {
    return ENTRY_KEYS[actionHrid] || null;
}
