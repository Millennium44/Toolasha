/**
 * Labyrinth build fingerprint — what it hashes, and which version hashed it
 *
 * The fingerprint answers one question: is the character the sim would run now
 * the same character a stored record was made against? Version 1 answered it
 * from gear alone — loadout snapshots and each worn item's enhancement level —
 * and got it wrong every time a combat skill went up. The sim reads seven skill
 * levels off the player DTO, so a level-up moves accuracy, damage, evasion,
 * max HP and max MP without moving a single item. Fights recorded either side
 * of one were pooled under the same fingerprint and the replay reported the
 * difference as the sim over-crediting damage, when what had actually moved was
 * the input.
 *
 * Version 2 hashes those seven levels alongside the gear. That changes the
 * value every stored record keys on, which is why the value carries its version
 * in the open: `v2:<hash>`. A v1 fingerprint can never equal a v2 one, so
 * nothing pools across the change by accident, and a record made under v1 stays
 * stored, stays readable and stays counted — apart, never merged.
 *
 * ## What is in, and what is not
 *
 * In: the loadout snapshots, the worn item+enhancement list, and the seven
 * combat skill levels `Player.createFromDTO` reads (stamina, intelligence,
 * attack, defense, melee, ranged, magic).
 *
 * Out: the fifteen skilling levels. `buildPlayerDTO` puts them on the DTO but
 * `Player.createFromDTO` never reads one, so no skilling level can change a
 * combat sim's answer — and hashing them would drop the whole (expensive)
 * combat sim cache every time a woodcutting level ticked over.
 *
 * Also out, as in v1: abilities, house rooms, buffs and consumables. Those
 * genuinely do move a sim, and the fingerprint's silence about them is a known
 * limitation carried forward — widening to cover them is a v3 problem, not
 * something to smuggle into this migration.
 *
 * Deliberately dependency-free: the recorder, the calibration split and the
 * export all need the version, and none of them may drag in the sim graph.
 */

/**
 * The fingerprint algorithm in force. Bumped only when the hashed inputs
 * change; every bump strands the previous version's records in their own
 * cohort rather than deleting them.
 */
export const FINGERPRINT_VERSION = 2;

/** What a current-version fingerprint value starts with */
export const FINGERPRINT_PREFIX = `v${FINGERPRINT_VERSION}:`;

/**
 * What the build fingerprint hashes, for exports to carry — stored records key
 * on the value, so the algorithm must never change under a version; this
 * documents it instead.
 */
export const FINGERPRINT_SPEC =
    'v2: djb2 over loadout snapshots (savedAt excluded) + worn itemHrid+enhancementLevel + the seven combat ' +
    'skill levels the sim reads (stamina, intelligence, attack, defense, melee, ranged, magic); ' +
    'excludes skilling levels, abilities, house rooms, buffs. Value is prefixed "v2:".';

/**
 * The version a stored record was fingerprinted under.
 *
 * Records written before the field existed are version 1 by definition — the
 * gear-only fingerprint — so an absent field is read as 1 rather than as
 * unknown. `Number(null)` is 0 and `Number(undefined)` is NaN, so the field is
 * checked for being a positive integer before it is trusted.
 *
 * @param {Object} record - A stored attempt, or anything carrying the field
 * @returns {number} 1 for pre-migration records, otherwise the stamped version
 */
export function fingerprintVersionOf(record) {
    const stamped = record?.fingerprintVersion;
    return Number.isInteger(stamped) && stamped > 0 ? stamped : 1;
}

/**
 * Whether a stored record was fingerprinted the way the live fingerprint is.
 * @param {Object} record - A stored attempt
 * @param {number} [version=FINGERPRINT_VERSION] - The version to measure against
 * @returns {boolean}
 */
export function isCurrentFingerprintVersion(record, version = FINGERPRINT_VERSION) {
    return fingerprintVersionOf(record) === version;
}

/**
 * The seven skills `Player.createFromDTO` copies onto the simulated player, in
 * the order the fingerprint writes them. Order is part of the hashed string, so
 * this array may not be reordered under a version.
 */
export const SIM_COMBAT_SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

/**
 * The combat-level half of the fingerprint's input.
 *
 * Fixed order and fixed shape, so the string is stable across however the level
 * map was built. Levels the caller could not read at all produce the literal
 * `levels=unknown`: the callers that act on a fingerprint change all gate on
 * `loadoutSnapshot.snapshotsReady`, which cannot be true before the character
 * payload the skills arrive in has landed, so the placeholder is never mistaken
 * for a level-up. A skill present but unreadable counts as 0, the same reading
 * the DTO builder's default gives it.
 *
 * @param {Object|null} levels - `{stamina, intelligence, attack, defense, melee, ranged, magic}`
 * @returns {string}
 */
export function combatLevelsPart(levels) {
    if (!levels || typeof levels !== 'object') return 'levels=unknown';
    const parts = SIM_COMBAT_SKILLS.map((name) => `${name}:${Math.max(0, Math.floor(Number(levels[name]) || 0))}`);
    return `levels=${parts.join(',')}`;
}

/**
 * The exact string the fingerprint hashes, assembled from its three halves.
 *
 * Shared rather than rebuilt so the live fingerprint and the upgrade advisor's
 * *projected* one cannot drift apart — a projection that assembled its input
 * differently would never equal the live value, and the advisor would call
 * every candidate cache-invalidating.
 *
 * @param {Object} input
 * @param {string} input.stored - Snapshot JSON with `savedAt` stripped
 * @param {string} input.worn - `itemHrid+enhancementLevel` per slot, per loadout
 * @param {string} input.levels - From {@link combatLevelsPart}
 * @returns {string}
 */
export function fingerprintInput({ stored, worn, levels }) {
    return `${stored}||${worn}||${levels}`;
}

/**
 * Stamp a raw hash with the version in force, producing the value records key
 * on. Version-tagging in the value itself is what makes cross-version pooling
 * impossible rather than merely unlikely: two different algorithms can collide
 * on a hash, but not on the prefix in front of it.
 *
 * @param {string} hash - The djb2 output
 * @returns {string} e.g. `v2:-1194527`
 */
export function tagFingerprint(hash) {
    return `${FINGERPRINT_PREFIX}${hash}`;
}

export default {
    FINGERPRINT_VERSION,
    FINGERPRINT_PREFIX,
    FINGERPRINT_SPEC,
    SIM_COMBAT_SKILLS,
    fingerprintVersionOf,
    isCurrentFingerprintVersion,
    combatLevelsPart,
    fingerprintInput,
    tagFingerprint,
};
