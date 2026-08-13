/**
 * When the next Labyrinth entry regenerates.
 *
 * The Labyrinth holds a small stock of entries (five), and one regenerates on a
 * fixed cooldown — the server currently computes it as `labyrinthCooldownHours`
 * for this character (cooldown upgrades shorten it, and the server re-sends the
 * value rather than leaving it to be inferred). A regenerated entry is worth
 * knowing about because entries are the gate on every run, and one sitting
 * unspent while the stock is full is regeneration wasted.
 *
 * ## Where the numbers come from
 *
 * All on `characterInfo`, sent with `init_character_data` and re-sent on
 * `character_info_updated` whenever they move:
 *
 * - `labyrinthEntries` — how many entries are in stock right now
 * - `labyrinthCooldownHours` — the regeneration cadence
 * - `lastLabyrinthTimestamp` — when the cadence is measured from; the next entry
 *   arrives one cooldown after it
 *
 * The stock cap (five) is not on `characterInfo`, so it is a constant here.
 *
 * Nothing reads the panel's "Next Entry" countdown: that string only exists
 * while the Labyrinth panel is open, and a projection that needs a panel open
 * cannot tell anybody who is away — which is the whole point of having one.
 */

/** Milliseconds in an hour */
const HOUR_MS = 3_600_000;

/** The Labyrinth entry stock cap. Not carried on characterInfo, so a constant. */
export const LABYRINTH_MAX_ENTRIES = 5;

/**
 * When the next Labyrinth entry regenerates, and whether the stock is full.
 *
 * @param {Object} input
 * @param {Object} input.characterInfo - `characterData.characterInfo`
 * @param {number} [input.maxEntries=LABYRINTH_MAX_ENTRIES] - Stock cap
 * @param {number} [input.now=Date.now()] - Clock, injectable for tests
 * @returns {{ok: boolean, reason?: string, entries?: number, maxEntries?: number,
 *   cooldownHours?: number, cooldownMs?: number, lastEntryAt?: number, isFull?: boolean,
 *   nextEntryAt?: number|null, msUntilNext?: number|null, available?: boolean}}
 */
export function forecastLabyrinthEntries({ characterInfo, maxEntries = LABYRINTH_MAX_ENTRIES, now = Date.now() } = {}) {
    if (!characterInfo) return { ok: false, reason: 'no character info' };

    const entries = Math.floor(Number(characterInfo.labyrinthEntries));
    const cooldownHours = Number(characterInfo.labyrinthCooldownHours);
    const lastEntryAt = Date.parse(characterInfo.lastLabyrinthTimestamp ?? '');

    if (!Number.isFinite(entries) || !Number.isFinite(cooldownHours) || cooldownHours <= 0) {
        return { ok: false, reason: 'incomplete labyrinth info' };
    }

    const cooldownMs = cooldownHours * HOUR_MS;
    const isFull = entries >= maxEntries;

    // A full stock does not regenerate, so there is no next-entry instant to
    // project — the stored timestamp is stale until an entry is spent.
    let nextEntryAt = null;
    let msUntilNext = null;
    if (!isFull && Number.isFinite(lastEntryAt)) {
        nextEntryAt = lastEntryAt + cooldownMs;
        msUntilNext = nextEntryAt - now;
    }

    return {
        ok: true,
        entries,
        maxEntries,
        cooldownHours,
        cooldownMs,
        lastEntryAt: Number.isFinite(lastEntryAt) ? lastEntryAt : null,
        isFull,
        nextEntryAt,
        msUntilNext,
        // The projected entry is due when its instant has passed.
        available: nextEntryAt != null && now >= nextEntryAt,
    };
}
