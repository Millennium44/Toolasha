/**
 * Dungeon chest luck
 *
 * A dungeon pays once, on completion, from a reward table — which is why the
 * per-monster drop model declines to measure one and why Party Luck goes blank
 * inside a dungeon. But there is a question a dungeon *can* answer, and it is
 * the one people actually ask: **how many chests did I get, against how many I
 * was owed.**
 *
 * ## The mechanic
 *
 * A completion pays `5 / partySize` chests, scaled by the Combat Drop Quantity
 * bonus. A five-person party is one chest each; at +29.5% quantity the mean is
 * 1.295, which the game realises as one chest guaranteed and a 29.5% chance of
 * a second. That is the buff people describe as "double chests sometimes", and
 * it is the whole of the randomness — everything else about a dungeon payout is
 * fixed.
 *
 * ## Counted, not assumed
 *
 * The number of completions is nowhere in the payload; only the simulator has
 * ever had it, and only for runs it simulated. So it is observed instead: watch
 * the chest count in the loot, and every time it rises, that is one completion
 * that paid however much it rose by. That gives the completions and the extras
 * together, with no arithmetic standing in for either.
 *
 * It also means the guaranteed part is measured rather than derived. If the game
 * changes what a completion pays, the count of completions stays right and only
 * the expectation moves.
 *
 * ## The distribution
 *
 * Extras over `n` completions are `Binomial(n, p)` with `p` the fractional part
 * of the mean. Small enough to sum exactly — a dungeon session is tens of runs,
 * not millions — so the percentile is computed rather than sampled, the same
 * choice `spawn-expectation.js` makes for the same reason.
 */

/** What one completion pays before the quantity bonus, split across the party */
const CHESTS_PER_COMPLETION = 5;

/**
 * The chests a dungeon completion pays.
 *
 * A fallback for when the zone's own reward table is not to hand. Named rather
 * than sniffed from the item data: plenty of things are openable, and counting a
 * treasure chest from a gathering node as a dungeon completion would put a run's
 * worth of luck onto the wrong scale.
 */
const DUNGEON_CHESTS = new Set([
    '/items/chimerical_chest',
    '/items/sinister_chest',
    '/items/enchanted_chest',
    '/items/pirate_chest',
]);

/**
 * @param {string} itemHrid - An item
 * @returns {boolean} Whether it is a chest a dungeon pays out
 */
export function isDungeonChest(itemHrid) {
    return DUNGEON_CHESTS.has(itemHrid);
}

/**
 * Which items *this* dungeon pays on every completion.
 *
 * The reward table's guaranteed entries are the chests — that is what makes them
 * the guaranteed part, and it is the same test the simulator applies when it
 * multiplies a reward by `chestsPerCompletion` instead of by its drop rate. Read
 * from the zone rather than from a list so a dungeon added tomorrow is counted
 * today; the list is only there for when the zone data has not loaded.
 *
 * @param {Object} actionDetail - The zone's action detail
 * @param {number} difficultyTier - Which raises some reward rates
 * @returns {Set<string>} Item hrids
 */
export function dungeonChestItems(actionDetail, difficultyTier = 0) {
    const table = actionDetail?.combatZoneInfo?.dungeonInfo?.rewardDropTable;
    if (!table?.length) return DUNGEON_CHESTS;

    const guaranteed = new Set();
    for (const drop of table) {
        const rate = (drop?.dropRate || 0) + (drop?.dropRatePerDifficultyTier ?? 0) * difficultyTier;
        if (rate >= 1 && drop?.itemHrid && !isRefinementChest(drop.itemHrid)) guaranteed.add(drop.itemHrid);
    }
    return guaranteed.size ? guaranteed : DUNGEON_CHESTS;
}

/**
 * Whether an item is a refinement chest.
 *
 * They are excluded from everything that counts completions or entry keys. A
 * refinement chest is not what a completion pays — it takes a chest key to open
 * like any other, but it does **not** take an entry key, because it is not the
 * per-completion payout. Counting one as a completion would invent a run that
 * never happened, and inflate both the chest tally and what it was owed.
 *
 * Matched by name rather than by a list, so a refinement chest for a dungeon
 * added later is excluded without anybody remembering to add it.
 *
 * @param {string} itemHrid - An item
 * @returns {boolean}
 */
export function isRefinementChest(itemHrid) {
    return String(itemHrid || '').includes('_refinement_chest');
}

/**
 * How many dungeon chests a loot map holds.
 *
 * @param {Object} lootMap - The game's `totalLootMap`, keyed by its own slot key
 * @param {Set<string>} [chests] - Which items count, from `dungeonChestItems`
 * @returns {number}
 */
export function countDungeonChests(lootMap, chests = DUNGEON_CHESTS) {
    let total = 0;
    for (const entry of Object.values(lootMap || {})) {
        if (!entry?.itemHrid || isRefinementChest(entry.itemHrid)) continue;
        if (chests.has(entry.itemHrid)) total += entry.count || 0;
    }
    return total;
}

/**
 * How many chests a completion is worth to one character.
 *
 * The level gap enters here as a multiplier, the same way the quantity bonus
 * does, and the consequence is the interesting part: a party of five with no
 * quantity bonus is a mean of 1 each, and at a 90% penalty that becomes 0.1.
 * A tenth of a chest is not a thing the game can hand over, so it is realised
 * the same way 1.295 is — as a chance. Nine completions in ten pay that
 * character nothing and the tenth pays one, which is exactly how a level-gapped
 * character describes it.
 *
 * The *magnitude* is borrowed rather than measured: it is the debuff the
 * simulator applies to per-monster drops, and nothing has confirmed a dungeon
 * uses the same number. The structure is right and the multiplier is the best
 * available guess, so callers are given the observed rate alongside it — a
 * multiplier that is wrong shows up as the two disagreeing.
 *
 * @param {Object} input - The party and the bonuses
 * @param {number} input.partySize - How many are splitting the reward
 * @param {number} input.dropQuantity - `combatDropQuantity`, as a fraction
 * @param {number} input.levelGap - The level-gap debuff, a negative fraction
 * @returns {number} Mean chests per completion
 */
export function chestsPerCompletion({ partySize = 1, dropQuantity = 0, levelGap = 0 } = {}) {
    const party = partySize > 0 ? partySize : 1;
    const quantity = Number.isFinite(dropQuantity) ? dropQuantity : 0;
    // An unknown gap is not a penalty. Clamped because a debuff past -1 would
    // make a completion pay a negative number of chests.
    const gap = Number.isFinite(levelGap) ? Math.min(0, Math.max(-1, levelGap)) : 0;

    return (CHESTS_PER_COMPLETION / party) * (1 + Math.max(0, quantity)) * (1 + gap);
}

/**
 * `P(X <= k)` for `X ~ Binomial(n, p)`, summed exactly.
 *
 * Iteratively rather than through factorials, which overflow well before a
 * session does — the term for `k` is the term for `k-1` times `(n-k+1)p /
 * (k(1-p))`, and every term stays a probability.
 *
 * @param {number} k - How many successes were seen
 * @param {number} n - How many trials
 * @param {number} p - Chance of a success
 * @returns {number} 0..1
 */
export function binomialAtMost(k, n, p) {
    if (n <= 0) return 1;
    if (p <= 0) return k >= 0 ? 1 : 0;
    if (p >= 1) return k >= n ? 1 : 0;
    if (k < 0) return 0;
    if (k >= n) return 1;

    let term = (1 - p) ** n;
    let total = term;

    for (let i = 1; i <= k; i++) {
        term *= ((n - i + 1) / i) * (p / (1 - p));
        total += term;
    }
    return Math.min(1, total);
}

/**
 * Where a run of completions sits among the runs it could have been.
 *
 * The percentile is over the **extras** rather than over the total, because the
 * guaranteed part is not a draw — a hundred completions that each paid their
 * guaranteed chest and nothing more is not a hundred pieces of bad luck, it is
 * one figure being compared against itself.
 *
 * `P(X <= extras)` rather than a two-sided reading, matching the drop-luck
 * percentile so the two can sit beside each other and mean the same thing.
 *
 * @param {Object} input - What happened and what was owed
 * @param {number} input.completions - Runs that paid out
 * @param {number} input.chests - Chests they paid
 * @param {number} input.mean - From `chestsPerCompletion`
 * @returns {Object|null} `{completions, chests, expected, extras, expectedExtras,
 *   chance, percentile}`, or null when there is nothing to measure
 */
export function chestLuck({ completions, chests, mean } = {}) {
    if (!(completions > 0) || !(mean > 0) || !Number.isFinite(chests)) return null;

    const guaranteed = Math.floor(mean);
    const chance = mean - guaranteed;
    const expected = completions * mean;
    const extras = chests - completions * guaranteed;

    // Nothing random to place it among: at a whole-number mean every completion
    // pays the same, so there is no distribution and saying "50th" would invent
    // one. The count is still worth showing; the verdict is not.
    if (chance <= 0) {
        return { completions, chests, expected, extras, expectedExtras: 0, chance: 0, percentile: null };
    }

    return {
        completions,
        chests,
        expected,
        extras,
        expectedExtras: completions * chance,
        chance,
        // Clamped because a mid-run reading can see a chest before the
        // completion that produced it, and a negative count is not a percentile
        percentile: binomialAtMost(Math.max(0, extras), completions, chance),
    };
}

/**
 * Watch a chest count for the moments it rises.
 *
 * The count comes from `totalLootMap`, which is the loot for the **combat
 * session** rather than the character's inventory — the server accumulates it
 * and re-sends the whole thing on every `new_battle`. That is worth being
 * precise about, because it is the difference between a reading that survives a
 * page refresh and one that does not: after a reload the very first message
 * carries every chest the session has produced, so nothing needs storing.
 *
 * This originally treated a first sighting as a baseline — the right rule for an
 * inventory, where somebody may walk in holding a hundred chests from yesterday,
 * and quite wrong here. It threw away the whole session on every refresh.
 *
 * What a first sighting genuinely cannot recover is how many *completions*
 * produced those chests, so that much is recorded separately: `chests` is the
 * session's own total, and `watchedChests` is the part with a completion count
 * to go with it.
 *
 * @param {Object} tally - From `newChestTally`, mutated
 * @param {number} count - The session's chest count as it stands now
 * @returns {Object} The same tally
 */
export function noteChestCount(tally, count) {
    if (!Number.isFinite(count) || count < 0) return tally;

    const before = tally.seen;
    tally.seen = count;
    // Always the session's own figure, whether or not this saw it arrive
    tally.chests = count;

    if (before === null || before === undefined) {
        // Arriving mid-session: these chests are real and their completions are
        // not knowable from a count alone
        tally.unwatched = count;
        return tally;
    }

    // A fall means the session restarted — the caller resets on that, and until
    // it does there is nothing to add
    const gained = count - before;
    if (gained <= 0) return tally;

    tally.completions += 1;
    tally.watchedChests += gained;
    tally.byPayout[gained] = (tally.byPayout[gained] || 0) + 1;
    return tally;
}

/**
 * A fresh tally for `noteChestCount`.
 * @returns {Object}
 */
export function newChestTally() {
    return { completions: 0, chests: 0, watchedChests: 0, unwatched: 0, byPayout: {}, seen: null };
}
