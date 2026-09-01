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
 * Version 2 hashed those seven levels alongside the gear, and left a gap it
 * named: abilities and house rooms move a sim too. Version 3 closes that gap.
 * Each bump changes the value every stored record keys on, which is why the
 * value carries its version in the open: `v1`/`v2`/`v3` fingerprints can never
 * be equal, so nothing pools across a change by accident, and a record made
 * under an older version stays stored, stays readable and stays counted —
 * apart, never merged.
 *
 * ## What is in, and what is not
 *
 * In: the loadout snapshots, the worn item+enhancement list, the seven combat
 * skill levels `Player.createFromDTO` reads (stamina, intelligence, attack,
 * defense, melee, ranged, magic), and — new in v3 — the equipped ability kit
 * and the house rooms.
 *
 * Abilities, by slot: `Player.createFromDTO` maps `dto.abilities` positionally
 * through `Ability.createFromDTO`, which reads exactly `hrid`, `level` and
 * `triggers`, and `CombatSimulator` walks that array in order and fires the
 * first ability whose `shouldTrigger` passes. So the slot index is part of the
 * build, not a presentation detail: the same four abilities in a different
 * order is a different rotation. Levels are in because every ability effect
 * carries a `...LevelBonus` term; triggers are in because `shouldTrigger` gates
 * on them, and two identical kits with different trigger conditions fight
 * differently.
 *
 * Ability levels are hashed a second way, as `learned`. A labyrinth room with
 * a loadout assigned does not use the equipped kit at all —
 * `applyLoadoutSnapshotToDTO` takes the ability *set* from the snapshot (which
 * the snapshot JSON already puts in the hash) but reads each one's *level* from
 * `characterData.characterAbilities`, which the snapshot does not carry. So the
 * learned level of every ability any loadout names is hashed too; without it a
 * levelled ability would move every loadout room's sim and move no fingerprint.
 *
 * House rooms, by hrid and level, level 0 excluded. `Player.createFromDTO`
 * pushes a `HouseRoom` for every entry with `level > 0` and skips the rest, so
 * a room at 0 is not part of the build and must not be part of the hash.
 * Every room is in, not a "combat rooms" subset: `HouseRoom` deliberately
 * applies each room's action buffs with no `usableInActionTypeMap` filter
 * (player-verified — house wisdom reaches combat regardless of scoping), and
 * `generatePermanentBuffs` folds all of them into the unit's permanent buffs.
 * There is no read that distinguishes a combat room from any other, so
 * inventing one would be a guess.
 *
 * Out: the fifteen skilling levels. `buildPlayerDTO` puts them on the DTO but
 * `Player.createFromDTO` never reads one, so no skilling level can change a
 * combat sim's answer — and hashing them would drop the whole (expensive)
 * combat sim cache every time a woodcutting level ticked over.
 *
 * ## Why buffs and consumables stay out, deliberately
 *
 * Teas, drinks, food and community buffs do move a sim result, and they are
 * still not hashed. This is a decision, not an oversight, and it should not be
 * "fixed": a reading needs `MIN_CALIBRATION_FIGHTS` fights in one cohort before
 * it can be called, and consumables change several times an hour — every swap
 * would start a fresh cohort, so no cohort would ever reach the threshold and
 * every reading would report "too few to call" forever. Fragmenting the pool
 * past the point of usefulness is a worse answer than a fingerprint that is
 * silent about a term. Gear, levels, abilities and house rooms all change on
 * the scale of days; consumables change on the scale of minutes, and that is
 * the line.
 *
 * Deliberately dependency-free: the recorder, the calibration split and the
 * export all need the version, and none of them may drag in the sim graph.
 */

/**
 * The fingerprint algorithm in force. Bumped only when the hashed inputs
 * change; every bump strands the previous version's records in their own
 * cohort rather than deleting them.
 */
export const FINGERPRINT_VERSION = 3;

/** What a current-version fingerprint value starts with */
export const FINGERPRINT_PREFIX = `v${FINGERPRINT_VERSION}:`;

/**
 * What the build fingerprint hashes, for exports to carry — stored records key
 * on the value, so the algorithm must never change under a version; this
 * documents it instead.
 */
export const FINGERPRINT_SPEC =
    'v3: djb2 over loadout snapshots (savedAt excluded) + worn itemHrid+enhancementLevel + the seven combat ' +
    'skill levels the sim reads (stamina, intelligence, attack, defense, melee, ranged, magic) + the equipped ' +
    'ability slots (index, hrid, level, triggers) and the learned levels of loadout-named abilities + house ' +
    'rooms at level above 0 (hrid, level); excludes skilling levels, buffs and consumables. ' +
    'Value is prefixed "v3:".';

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
 * How many ability slots `buildPlayerDTO` and `applyLoadoutSnapshotToDTO` both
 * build: slot 0 is the special ability, slots 1-4 the normal ones. Fixed, so an
 * empty trailing slot hashes as empty rather than as absent.
 */
export const ABILITY_SLOTS = 5;

/**
 * One ability's trigger list, in the order `Ability.createFromDTO` passes it to
 * `Trigger.createFromDTO`. Order is significant to the string but not to the
 * sim (`shouldTrigger` ANDs them all); it is kept as given rather than sorted
 * because both DTO builders read it straight off the same server-supplied map,
 * so the order is already stable and sorting would only cost time.
 *
 * `null` triggers means "the ability's own defaults", which is a different
 * build from "no triggers configured", so the two produce different strings.
 *
 * @param {Array<Object>|null|undefined} triggers - Trigger DTOs
 * @returns {string}
 */
function triggersPart(triggers) {
    if (!Array.isArray(triggers)) return 'default';
    return triggers
        .map(
            (t) =>
                `${t?.dependencyHrid ?? ''}~${t?.conditionHrid ?? ''}~${t?.comparatorHrid ?? ''}~${Number(t?.value) || 0}`
        )
        .join(';');
}

/**
 * The ability half of the fingerprint's input.
 *
 * Two things, because two paths reach the sim. `equipped` is the live 5-slot
 * kit, positional: `CombatSimulator` fires the first slot whose triggers pass,
 * so reordering the same abilities is a different build and must hash
 * differently. `learned` is the level of every ability a labyrinth loadout
 * names — a loadout room takes its ability set from the snapshot but its levels
 * from the character, so those levels reach the sim without passing through
 * anything else in the hash.
 *
 * Unreadable inputs produce `abilities=unknown`, the same placeholder discipline
 * {@link combatLevelsPart} uses and for the same reason: callers gate on
 * `snapshotsReady`, which cannot be true before the character payload has
 * landed, so the placeholder is never mistaken for an empty kit.
 *
 * @param {Object|null} input
 * @param {Array<Object|null>} [input.equipped] - `dto.abilities`, 5 slots
 * @param {Object} [input.learned] - abilityHrid → learned level
 * @returns {string}
 */
export function abilitiesPart(input) {
    if (!input || typeof input !== 'object') return 'abilities=unknown';
    const equipped = Array.isArray(input.equipped) ? input.equipped : null;
    if (!equipped) return 'abilities=unknown';

    const slots = [];
    for (let i = 0; i < ABILITY_SLOTS; i++) {
        const ability = equipped[i];
        if (!ability?.hrid) {
            slots.push(`${i}:-`);
            continue;
        }
        const level = Math.max(0, Math.floor(Number(ability.level) || 0));
        slots.push(`${i}:${ability.hrid}@${level}[${triggersPart(ability.triggers)}]`);
    }

    const learned = input.learned && typeof input.learned === 'object' ? input.learned : {};
    const levels = Object.keys(learned)
        .sort()
        .map((hrid) => `${hrid}@${Math.max(0, Math.floor(Number(learned[hrid]) || 0))}`);

    return `abilities=${slots.join(',')}|learned=${levels.join(',')}`;
}

/**
 * The house-room half of the fingerprint's input.
 *
 * Sorted by hrid, because `characterHouseRoomMap` is an object and its key
 * order is not a property of the build. Rooms at level 0 are dropped:
 * `Player.createFromDTO` pushes a `HouseRoom` only for `level > 0`, so a room
 * standing at 0 contributes nothing to the sim and a build that has never built
 * it must hash identically to one that has it in the map at 0.
 *
 * @param {Object|null} rooms - houseRoomHrid → level, as `dto.houseRooms`
 * @returns {string}
 */
export function houseRoomsPart(rooms) {
    if (!rooms || typeof rooms !== 'object') return 'house=unknown';
    const parts = Object.keys(rooms)
        .sort()
        .map((hrid) => ({ hrid, level: Math.max(0, Math.floor(Number(rooms[hrid]) || 0)) }))
        .filter((room) => room.level > 0)
        .map((room) => `${room.hrid}:${room.level}`);
    return `house=${parts.join(',')}`;
}

/**
 * The exact string the fingerprint hashes, assembled from its five parts.
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
 * @param {string} input.abilities - From {@link abilitiesPart}
 * @param {string} input.houseRooms - From {@link houseRoomsPart}
 * @returns {string}
 */
export function fingerprintInput({ stored, worn, levels, abilities, houseRooms }) {
    return `${stored}||${worn}||${levels}||${abilities}||${houseRooms}`;
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
    ABILITY_SLOTS,
    fingerprintVersionOf,
    isCurrentFingerprintVersion,
    combatLevelsPart,
    abilitiesPart,
    houseRoomsPart,
    fingerprintInput,
    tagFingerprint,
};
