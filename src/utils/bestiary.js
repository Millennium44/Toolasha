/**
 * The Bestiary's arithmetic, and what a zone is worth to it.
 *
 * The game keeps a kill count per monster and pays Bestiary points for it on
 * powers of ten: the first kill is worth 1 point, the tenth 2 more, the
 * hundredth 3 more, and so on — `calculatePointsFromCount` in the client,
 * copied here as {@link pointsFromCount}. Points feed the Bestiary milestones
 * (chests) and the "Hunter" achievements.
 *
 * A zone's worth, then, is how many of those thresholds its monsters cross per
 * hour of fighting there, which is the kill rate the simulator already
 * measures (`simResult.deaths[monsterHrid]`) against the counts the Bestiary
 * tab holds (`monsters_updated`, captured by the data manager). Nothing here
 * reads the game; everything is an argument, so the optimizer is a table of
 * pure functions and the panel decides what to draw.
 *
 * The unit everything below is in is a Bestiary *credit*, not a kill, and the
 * difference is the whole reason {@link creditsPerKill} exists. The game's own
 * "Defeated" figure is already tier-weighted and already divided by the party
 * (a Manticore tooltip reading `Defeated: 496.8 | T0 Defeated: 45 | T2
 * Defeated: 150.6` is exactly 45x1 + 150.6x3), so the counts arriving from
 * `monsters_updated` are credits and need no conversion. A simulated kill rate
 * is not: `simResult.deaths` counts bodies, at one tier, for the whole party.
 * {@link monsterCreditsPerHour} is where those bodies become credits, and it is
 * the only place in the planner where a tier or a party size is looked at.
 *
 * That conversion is only ever right for an ordinary zone or dungeon. A guild
 * trial monster is not tier-weighted at all — see {@link creditsPerKill}'s doc
 * for the measured proof — and this module has no way to tell one apart from
 * an ordinary monster by its arguments alone. What keeps it safe today is
 * that nothing feeds it one: the planner is built only from all-zones combat
 * rows (`combat-sim-ui.js`'s `_buildBestiaryPlanZones`), and no trial monster
 * ever reaches an all-zones row — a trial is fought from the guild panel,
 * never queued as a zone. A future caller that starts feeding this module a
 * trial monster's kills would need to skip {@link creditsPerKill}'s tier
 * weighting entirely, per fact 2 below, not pass it a corrected tier.
 */

/** The prefix the simulator's monster units carry in `deaths` */
const MONSTER_PREFIX = '/monsters/';

/**
 * Points a kill count has earned: one per power of ten reached, weighted by
 * its rank — 1 for the first kill, +2 at 10, +3 at 100, +4 at 1,000 …
 * @param {number} count - Monsters defeated
 * @returns {number}
 */
export function pointsFromCount(count) {
    const n = Math.floor(Number(count) + 1e-9);
    if (!(n >= 1)) return 0;
    let points = 0;
    let threshold = 1;
    let step = 1;
    while (n >= threshold && threshold < 1e14) {
        points += step;
        threshold *= 10;
        step += 1;
    }
    return points;
}

/**
 * The next kill count worth a point: the first power of ten past `count`.
 * @param {number} count - Monsters defeated
 * @returns {number} 1 for an unmet monster, else 10, 100, …
 */
export function nextPointCount(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    let threshold = 1;
    while (threshold <= n && threshold < 1e14) threshold *= 10;
    return threshold;
}

/**
 * What one kill is worth to *your* Bestiary, in credits.
 *
 * The game's Bestiary help states both halves:
 *
 * - "Higher tier monsters grant 1 extra credit per tier (T1 gives +1, T2 gives
 *   +2, etc)" - so a kill at difficulty tier N credits N+1.
 * - "When fighting in a party, you receive fractional credit based on party
 *   size."
 *
 * Both halves are now measured, off `tierData` (a JSON map of tier → kill
 * count) inside `monsters_updated`, on a 92-monster character:
 *
 * 1. **Tier weighting is exact.** `count = Σ tierData[t] × (t + 1)` holds to
 *    floating-point precision for 84 of the 92 monsters — every one that
 *    is not a guild trial monster (fact 2 below). Highest tier observed
 *    among these: 6. Worked example — Granite Golem's
 *    `{"0":8774,"4":31,"6":1028.8}` gives 8774x1 + 31x5 + 1028.8x7 =
 *    8774 + 155 + 7201.6 = 16130.6, its exact `count`.
 * 2. **A guild trial monster is not tier-weighted at all.** The 8 exceptions
 *    above are all `trial_*` monsters. Their "tiers" run as high as 21 —
 *    those are trial *wave numbers*, not difficulty tiers — and for every
 *    one of them `count` is the plain, unweighted sum of `tierData`. Worked
 *    example — Trial Hedgehog's `{"1":10,"2":9,"3":7,…,"21":7}` sums to 152,
 *    its exact `count`; running this function's `tier + 1` rule against it
 *    would claim 1,776 — about 12x too high. {@link creditsPerKill} has no
 *    way to know it was handed a trial monster, so it must never be pointed
 *    at one — see the module doc for where that safety currently comes from.
 * 3. **The party share is an even `1 / N`, and this is now measured, not
 *    assumed.** All 42 fractional `tierData` entries across the character
 *    are multiples of 1/2, 1/5 or 1/10, with zero unexplained. A
 *    contribution-weighted split would produce arbitrary reals instead.
 *
 * A dungeon is weighted on the same `tier + 1` rule as an ordinary zone, on the
 * basis that a dungeon row is simulated at the same `difficultyTier` field the
 * game gives every other fight (see `_getSelectedAllZones`, which expands a
 * dungeon over T0-T2 exactly as it expands a zone over its difficulties) and the
 * help text draws no distinction between the two.
 *
 * @param {Object} [input]
 * @param {number} [input.difficultyTier=0] - The tier being fought; never a guild
 *   trial's wave number — see fact 2 above
 * @param {number} [input.partySize=1] - Players in the party, 1 for solo
 * @returns {number} Credits one kill is worth to you
 */
export function creditsPerKill({ difficultyTier = 0, partySize = 1 } = {}) {
    const tier = Math.max(0, Math.floor(Number(difficultyTier) || 0));
    const party = Math.max(1, Math.floor(Number(partySize) || 1));
    return (tier + 1) / party;
}

/**
 * Which party size a Bestiary projection should divide by.
 *
 * The run's own recorded size wins whenever there is one - a sim that built DTOs
 * for three players killed as three players, and no setting should argue with
 * that. The fallback is for a reading that predates the field being recorded at
 * all (an all-zones snapshot stored by an earlier build), where the only
 * evidence left is what the player says they usually run with.
 *
 * @param {number|null|undefined} recorded - The party size the run recorded
 * @param {number|null|undefined} fallback - The player's configured party size
 * @returns {number} At least 1
 */
export function resolvePartySize(recorded, fallback) {
    const asSize = (value) => {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) && n >= 1 ? n : null;
    };
    return asSize(recorded) ?? asSize(fallback) ?? 1;
}

/**
 * Bestiary credits per hour by monster, off a simulation result.
 *
 * Not kills per hour, which is what `simResult.deaths` holds and what this used
 * to return: `deaths` is incremented once per monster that dies no matter which
 * party member landed the blow (`sim-result.js`'s `addDeath`), and it carries no
 * tier at all. Added to a Bestiary count - which is already tier-weighted and
 * already party-divided - that was two unit errors in one sum. See
 * {@link creditsPerKill}.
 *
 * @param {Object} simResult - From the simulator (`deaths` keyed by unit hrid)
 * @param {number} simHours - The run's length in hours
 * @param {Object} [options]
 * @param {number} [options.difficultyTier=0] - The tier the run was at
 * @param {number} [options.partySize=1] - Players the run simulated
 * @returns {Object} monsterHrid → credits/hour
 */
export function monsterCreditsPerHour(simResult, simHours, { difficultyTier = 0, partySize = 1 } = {}) {
    const out = {};
    const hours = Number(simHours) > 0 ? Number(simHours) : 0;
    if (!hours) return out;
    const perKill = creditsPerKill({ difficultyTier, partySize });
    for (const [hrid, deaths] of Object.entries(simResult?.deaths || {})) {
        if (!String(hrid).startsWith(MONSTER_PREFIX)) continue;
        const n = Number(deaths) || 0;
        if (n > 0) out[hrid] = (n * perKill) / hours;
    }
    return out;
}

/**
 * The Bestiary counts as the game sends them, keyed by monster.
 *
 * The game's own figure is a credit total, not a kill count, and it is openly
 * fractional (a party kill splits a credit across its members — see the
 * module doc above). Flooring it here would throw away up to a whole credit
 * per monster and overstate the time to the next threshold, so the fraction
 * is kept; only a negative or non-finite count clamps to 0.
 *
 * @param {Array<{monsterHrid: string, count: number}>} monsters - `monsters_updated.monsters`
 * @returns {Object} monsterHrid → count
 */
export function countsByMonster(monsters) {
    const out = {};
    for (const entry of monsters || []) {
        if (!entry?.monsterHrid) continue;
        const raw = Number(entry.count);
        out[entry.monsterHrid] = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    }
    return out;
}

/**
 * What fighting a zone does for the Bestiary over a horizon.
 *
 * For each monster the zone kills: the credit count it would reach in `hours`
 * at the simulated credit rate, the points that crossing earns, and how long the first of
 * those points takes. A monster the zone kills but the Bestiary has no row
 * for counts from zero — which is exactly the case the Bestiary pays most for.
 *
 * @param {Object} input
 * @param {Object} input.creditsPerHour - monsterHrid → credits/hour (see {@link monsterCreditsPerHour})
 * @param {Object} input.counts - monsterHrid → defeated so far (see {@link countsByMonster})
 * @param {number} [input.hours=24] - Horizon
 * @returns {{pointsGained: number, pointsPerDay: number, firstPointHours: number|null,
 *   monsters: Array<{monsterHrid: string, count: number, creditsPerHour: number, nextAt: number,
 *   hoursToNext: number, pointsGained: number}>}}
 */
export function zoneBestiaryOutlook({ creditsPerHour = {}, counts = {}, hours = 24 } = {}) {
    const horizon = Number(hours) > 0 ? Number(hours) : 24;
    const monsters = [];
    let pointsGained = 0;
    let firstPointHours = null;

    for (const [hrid, rate] of Object.entries(creditsPerHour)) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        // Kept fractional for the same reason {@link countsByMonster} keeps it:
        // flooring here would silently undo that, since this is the consumer the
        // live panel actually renders from.
        const rawCount = Number(counts[hrid]);
        const count = Number.isFinite(rawCount) ? Math.max(0, rawCount) : 0;
        const reached = count + perHour * horizon;
        const gained = pointsFromCount(reached) - pointsFromCount(count);
        const nextAt = nextPointCount(count);
        const hoursToNext = (nextAt - count) / perHour;
        if (firstPointHours === null || hoursToNext < firstPointHours) firstPointHours = hoursToNext;
        pointsGained += gained;
        monsters.push({
            monsterHrid: hrid,
            count,
            creditsPerHour: perHour,
            nextAt,
            hoursToNext,
            pointsGained: gained,
        });
    }

    monsters.sort((a, b) => a.hoursToNext - b.hoursToNext);
    return {
        pointsGained,
        pointsPerDay: (pointsGained / horizon) * 24,
        firstPointHours,
        monsters,
    };
}
