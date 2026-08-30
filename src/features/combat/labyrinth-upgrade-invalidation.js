/**
 * What an upgrade would stale
 *
 * Every cached labyrinth room result is stamped with the gear fingerprint it
 * was simulated under, and a gear change throws the whole cache away —
 * `_invalidateIfInputsChanged` clears both layers, because the cache key does
 * not encode gear and a partial drop would leave the surviving entries to be
 * reused under a baseline that has moved. That is correct, and it is invisible:
 * the upgrade advisor ranks a candidate on damage and gold and says nothing
 * about the minutes of simulation buying it would cost, or about which rooms
 * were sitting near enough to their decision bar that re-simming might come
 * back with a different answer.
 *
 * This computes the fingerprint a candidate's gear change *would* produce —
 * by {@link FINGERPRINT_SPEC}, so it is the same value the real change would
 * write — and reports which cached rooms it invalidates, ranked by how close
 * each one was to the recommend panel's Target Win %:
 *
 *     would stale 6 cached rooms, 2 within 2pp of their bar
 *
 * ## It names candidates and decides nothing
 *
 * A room sitting 1pp under its bar is not a room the upgrade fixes. It is a
 * room whose cached answer is about to stop being evidence, and whose true
 * answer under the new gear is unknown until it is re-simulated. Nothing here
 * predicts which way it would land, and the wording is picked so that it cannot
 * be read as predicting: "would stale" and "within 2pp of their bar" are both
 * statements about the *cache*, not about the rooms. The honest answer needs a
 * re-sim, and this is the thing that tells you a re-sim is owed.
 *
 * ## Coverage
 *
 * The fingerprint hashes loadout snapshots and worn item+enhancement, and
 * excludes levels, abilities and buffs. So a house candidate, an ability swap,
 * a combat level, a drink or a community buff changes nothing it hashes, and
 * this says *nothing at all* on those rows — not "0 rooms", which would be a
 * claim about a mechanism that does not apply to them. Only worn-item and
 * enhancement candidates are in coverage.
 */

/** Candidate types whose change lands on worn gear, and so on the fingerprint */
export const GEAR_CANDIDATE_TYPES = Object.freeze(['tier', 'enhancement', 'cross_slot']);

/** Within this many percentage points of the bar counts as close to it */
export const CLOSE_TO_BAR_PP = 2;

/**
 * Whether a candidate touches anything the gear fingerprint covers.
 *
 * @param {Object|null} candidate - An advisor candidate
 * @returns {boolean} False for house, ability, level, drink, shrine and buff rows
 */
export function isGearCandidate(candidate) {
    if (!candidate || !GEAR_CANDIDATE_TYPES.includes(candidate.type)) return false;
    return Boolean(candidate.upgradeHrid || candidate.addedSlots || candidate.removedItems);
}

/**
 * One loadout's worn items, with a candidate's change applied.
 *
 * The three gear candidate shapes are all expressed as the same two operations:
 * items leaving, and items arriving. A `tier` or `enhancement` candidate swaps
 * one item for another in place; a `cross_slot` candidate names what it removes
 * and what it adds, because two-hand ↔ main-hand+off-hand is not a swap of one
 * item for one item.
 *
 * A loadout that is not wearing the item being upgraded comes back untouched,
 * which is right: upgrading a weapon does not change what a loadout that does
 * not hold it puts on.
 *
 * @param {Array<Object>} equipment - `{itemHrid, enhancementLevel}` per worn slot
 * @param {Object} candidate - A gear candidate
 * @returns {Array<Object>} The projected worn list
 */
export function applyGearCandidate(equipment, candidate) {
    const worn = (equipment || []).filter(Boolean);
    if (!isGearCandidate(candidate)) return worn;

    const level = (equip) => Number(equip?.enhancementLevel) || 0;
    const removed = [
        ...(candidate.removedItems || []).map((item) => ({
            itemHrid: item?.hrid ?? item?.itemHrid,
            enhancementLevel: Number(item?.enhancementLevel) || 0,
        })),
        ...(candidate.currentHrid
            ? [{ itemHrid: candidate.currentHrid, enhancementLevel: Number(candidate.currentLevel) || 0 }]
            : []),
    ];

    let touched = false;
    const kept = [];
    const pending = [...removed];
    for (const equip of worn) {
        const index = pending.findIndex(
            (item) => item.itemHrid === equip.itemHrid && item.enhancementLevel === level(equip)
        );
        if (index >= 0) {
            pending.splice(index, 1);
            touched = true;
            continue;
        }
        kept.push(equip);
    }
    // The loadout is not wearing what this candidate upgrades
    if (!touched) return worn;

    const added = candidate.addedSlots
        ? Object.values(candidate.addedSlots).map((item) => ({
              itemHrid: item?.hrid ?? item?.itemHrid,
              enhancementLevel: Number(item?.enhancementLevel) || 0,
          }))
        : [{ itemHrid: candidate.upgradeHrid, enhancementLevel: Number(candidate.upgradeLevel) || 0 }];

    return [...kept, ...added.filter((item) => item.itemHrid)];
}

/**
 * The worn half of the fingerprint's input, exactly as
 * `_snapshotContentFingerprint` builds it.
 *
 * Pinned by {@link FINGERPRINT_SPEC}: stored records key on the hash of this
 * string, so the shape may not change. It is rebuilt here rather than imported
 * because the point is to build it from *projected* equipment, which the live
 * snapshot store cannot supply.
 *
 * @param {Array<Array<Object>>} loadouts - Resolved equipment per loadout
 * @returns {string}
 */
export function wornFingerprintInput(loadouts) {
    return (loadouts || [])
        .map((equipment) =>
            (equipment || []).map((equip) => `${equip.itemHrid}+${Number(equip.enhancementLevel) || 0}`).join(',')
        )
        .join('|');
}

/**
 * The fingerprint a candidate's gear change would produce.
 *
 * @param {Object} current - The two halves the live fingerprint hashes
 * @param {string} current.stored - Snapshot JSON with `savedAt` stripped
 * @param {Array<Array<Object>>} current.loadouts - Resolved equipment per loadout
 * @param {Object} candidate - A gear candidate
 * @param {Function} hash - The djb2 hasher the live fingerprint uses
 * @returns {string} The projected fingerprint
 */
export function projectedFingerprint({ stored, loadouts }, candidate, hash) {
    const projected = (loadouts || []).map((equipment) => applyGearCandidate(equipment, candidate));
    return hash(`${stored}||${wornFingerprintInput(projected)}`);
}

/**
 * The room a cache key belongs to.
 *
 * The first two colon-separated fields are the monster and the room level, and
 * hrids carry `/` rather than `:`, so the room identity splits off cleanly —
 * the same reading `staleCombatCacheRooms` does, and for the same reason:
 * rooms are the unit a player thinks in, and one room can hold several entries
 * (a precision run, a decision-bar run, different crates).
 *
 * @param {string} cacheKey - A combat cache key
 * @returns {string} `monsterHrid:roomLevel`
 */
export function roomOfCacheKey(cacheKey) {
    const [monsterHrid, roomLevel] = String(cacheKey).split(':');
    return `${monsterHrid}:${roomLevel}`;
}

/**
 * Which cached rooms an upgrade would stale, closest to their bar first.
 *
 * Closeness is the gap between a room's simulated clear chance and the Target
 * Win % the recommendation is searched against, in percentage points. That is
 * the quantity that decides whether a re-sim could change the recommendation: a
 * room at 92% against a 70% bar will still clear the bar under slightly
 * different gear, and a room at 70.4% might not.
 *
 * A room with several cached entries is ranked by its closest one — the entry
 * nearest the bar is the one whose answer is most fragile, and it is the room
 * that gets re-simulated, not the entry.
 *
 * @param {Array<Object>} entries - `{key, result}` from the combat cache
 * @param {Object} options - The bar and what counts as near it
 * @param {number} options.targetRate - The Target Win %, as a fraction 0..1
 * @param {number} [options.withinPp] - Percentage points that count as close
 * @returns {{rooms: number, within: number, withinPp: number,
 *   ranked: Array<{room: string, name: string|null, roomLevel: number|null,
 *     clearChance: number, gapPp: number, trials: number|null, halfWidthPp: number|null}>}}
 */
export function rankInvalidatedRooms(entries, { targetRate, withinPp = CLOSE_TO_BAR_PP } = {}) {
    const bar = Number(targetRate);
    const byRoom = new Map();

    for (const entry of entries || []) {
        const result = entry?.result;
        const raw = result?.clearChance;
        // `Number(null)` is 0, which is a perfectly good clear chance and a
        // completely wrong reading of an entry that never recorded one
        if (!entry?.key || raw === null || raw === undefined) continue;
        const clearChance = Number(raw);
        if (!Number.isFinite(clearChance)) continue;

        const room = roomOfCacheKey(entry.key);
        const gapPp = Number.isFinite(bar) ? Math.abs(clearChance - bar) * 100 : Infinity;
        const candidate = {
            room,
            name: result.monsterName || null,
            roomLevel: Number.isFinite(Number(result.roomLevel)) ? Number(result.roomLevel) : null,
            clearChance,
            gapPp,
            trials: Number.isFinite(Number(result.trials)) ? Number(result.trials) : null,
            halfWidthPp: Number.isFinite(Number(result.halfWidth)) ? Number(result.halfWidth) * 100 : null,
        };

        const held = byRoom.get(room);
        if (!held || candidate.gapPp < held.gapPp) byRoom.set(room, candidate);
    }

    const ranked = [...byRoom.values()].sort((a, b) => a.gapPp - b.gapPp);
    return {
        rooms: ranked.length,
        // The gap is a difference of two floats scaled by 100, so an exact
        // two-percentage-point gap lands at 2.0000000000000018 about as often
        // as at 2. A boundary that a reader would call "exactly on it" has to
        // count as within it.
        within: ranked.filter((entry) => entry.gapPp <= withinPp + 1e-9).length,
        withinPp,
        ranked,
    };
}

/**
 * The one compact line the advisor row gets, or nothing.
 *
 * Empty for a candidate out of the fingerprint's coverage and empty when there
 * is no cache to stale — in both cases because there is nothing true to say,
 * and a row saying "would stale 0 cached rooms" on every house upgrade would be
 * noise that also implies the mechanism applies there.
 *
 * @param {Object|null} summary - From {@link rankInvalidatedRooms}
 * @param {boolean} [changesFingerprint] - Whether the projected fingerprint differs
 * @returns {string} The line, or an empty string
 */
export function describeInvalidatedRooms(summary, changesFingerprint = true) {
    if (!changesFingerprint || !summary?.rooms) return '';

    const rooms = `would stale ${summary.rooms} cached room${summary.rooms === 1 ? '' : 's'}`;
    if (!summary.within) return rooms;
    return `${rooms}, ${summary.within} within ${summary.withinPp}pp of their bar`;
}

export default {
    GEAR_CANDIDATE_TYPES,
    CLOSE_TO_BAR_PP,
    isGearCandidate,
    applyGearCandidate,
    wornFingerprintInput,
    projectedFingerprint,
    roomOfCacheKey,
    rankInvalidatedRooms,
    describeInvalidatedRooms,
};
