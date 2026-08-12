/**
 * The community combat build guide, as data.
 *
 * Ability Swaps used to offer every style-compatible ability for every slot,
 * which is thousands of simulations to discover what the community already
 * knows: a spear build runs Frenzy, Berserk, Precision and Puncture under an
 * aura, and the only open questions are which aura and whether the signature
 * ability is worth its book. This module encodes the guide so the swap
 * generator can ask a much smaller, much better question.
 *
 * Three things live here and nothing else:
 *
 * - **Detection.** Which archetype a loadout is playing, read off the equipped
 *   weapon. Unknown is a real answer — `detectArchetype` returns null rather
 *   than guessing, and the generator falls back to its old every-ability
 *   behaviour, because a wrong archetype would hide the swaps that matter.
 * - **The ability sets**, as groups. A group is a set of OR-alternatives: the
 *   aura group (`Critical Aura OR Fierce Aura`) and, for a couple of
 *   archetypes, the signature group (`Shield Bash OR Retribution`). A group of
 *   one is just an ability. The first group is always the aura and the last is
 *   always the signature — the archetype-defining ability, the one the build is
 *   named for.
 * - **The gear**, which is reference only. It is what the guide says to wear,
 *   it is how the magic archetypes fall back to an element when a weapon does
 *   not name one, and it is deliberately *not* a source of upgrade candidates:
 *   the equipment generator ranks gear on simulated deltas and a list of names
 *   would only tell it what somebody else concluded.
 *
 * Ability and item names are resolved against live game data rather than
 * trusted as hrids, so a renamed ability is still found.
 */

/** Weapon slots, most specific first — a two-hander leaves `main_hand` empty */
const WEAPON_SLOTS = ['/equipment_types/two_hand', '/equipment_types/main_hand'];

/** Where the elemental robes sit, for the magic element fallback */
const ROBE_SLOTS = ['/equipment_types/body', '/equipment_types/legs'];

/** Elemental damage types, and the armor stat that amplifies each */
const ELEMENT_ARCHETYPE = {
    '/damage_types/fire': 'fire',
    '/damage_types/water': 'water',
    '/damage_types/nature': 'nature',
};

/** The amplify stat each magic archetype's robes carry */
const ARCHETYPE_AMPLIFY_STAT = {
    fire: 'fireAmplify',
    water: 'waterAmplify',
    nature: 'natureAmplify',
};

/**
 * Gear the guide shares across every archetype in a family.
 *
 * Reference only — nothing generates candidates from it. It is here because the
 * guide is one document and splitting the shared half out of it would leave the
 * per-archetype entries reading as complete builds when they are not.
 */
export const SHARED_GEAR = {
    melee: {
        t85: [
            'Vision Helmet',
            'Pincer Gloves',
            'Demonic Plate Body',
            'Demonic Plate Legs',
            'Colossus Plate Body',
            'Colossus Plate Legs',
            'Vision Shield',
            'Vampire Fang Dirk',
        ],
        t95: [
            'Corsair Helmet',
            'Dodocamel Gauntlets',
            'Pathbreaker Boots',
            'Maelstrom Plate Body',
            'Maelstrom Plate Legs',
            'Anchorbound Plate Body',
            'Anchorbound Plate Legs',
            "Knight's Aegis",
            'Vampire Fang Dirk',
        ],
    },
    ranged: {
        t85: ['Fluffy Red Hat', 'Umbral Hood', 'Sighted Bracers', 'Revenant Tunic', 'Revenant Chaps', 'Centaur Boots'],
        t95: ['Acrobatic Hood', 'Marksman Bracers', 'Kraken Tunic', 'Kraken Chaps', 'Pathfinder Boots'],
    },
    magic: {
        t85: ['Radiant Hat', 'Chrono Gloves', 'Watchful Relic', 'Sorcerer Boots'],
        t95: ["Magician's Hat", 'Chrono Gloves', 'Watchful Relic', 'Pathseeker Boots'],
        // Floor 10 and above wants the plate legs over the robe bottoms
        deepLabyrinth: ['Anchorbound Plate Legs'],
    },
};

/**
 * The archetypes, in the order the guide lists them.
 *
 * `abilityGroups[0]` is the aura group and `abilityGroups[last]` is the
 * signature group — see `signatureGroup`. `weapons` is what detection matches
 * first; `robes` exists only for the magic archetypes, where it is the fallback
 * for an element the weapon does not name.
 */
export const BUILD_GUIDE = {
    spear: {
        key: 'spear',
        label: 'Spear (Stab)',
        family: 'melee',
        style: 'stab',
        weapons: ['/items/stalactite_spear', '/items/furious_spear'],
        gear: { t85: ['Stalactite Spear', 'Black Bear Shoes'], t95: ['Furious Spear'] },
        abilityGroups: [['Critical Aura', 'Fierce Aura'], ['Frenzy'], ['Berserk'], ['Precision'], ['Puncture']],
    },
    sword: {
        key: 'sword',
        label: 'Sword (Slash)',
        family: 'melee',
        style: 'slash',
        weapons: ['/items/werewolf_slasher', '/items/regal_sword'],
        gear: { t85: ['Werewolf Slasher', 'Grizzly Bear Shoes'], t95: ['Regal Sword'] },
        abilityGroups: [['Critical Aura', 'Fierce Aura'], ['Frenzy'], ['Berserk'], ['Precision'], ['Maim']],
    },
    mace: {
        key: 'mace',
        label: 'Mace (Smash)',
        family: 'melee',
        style: 'smash',
        weapons: ['/items/granite_bludgeon', '/items/chaotic_flail'],
        gear: { t85: ['Granite Bludgeon', 'Polar Bear Shoes'], t95: ['Chaotic Flail'] },
        abilityGroups: [['Critical Aura', 'Fierce Aura'], ['Frenzy'], ['Berserk'], ['Precision'], ['Shield Bash']],
    },
    wark: {
        key: 'wark',
        label: 'Wark (Smash, defensive)',
        family: 'melee',
        style: 'smash',
        weapons: ['/items/spiked_bulwark', '/items/griffin_bulwark'],
        gear: { t85: ['Spiked Bulwark', 'Polar Bear Shoes'], t95: ['Griffin Bulwark'] },
        // Invincible fills the special slot the other melee builds give an aura
        abilityGroups: [['Invincible'], ['Toughness'], ['Spikeshell'], ['Precision'], ['Shield Bash', 'Retribution']],
    },
    bow: {
        key: 'bow',
        label: 'Bow (Cursed)',
        family: 'ranged',
        style: 'ranged',
        weapons: ['/items/vampiric_bow', '/items/cursed_bow'],
        gear: { t85: ['Vampiric Bow'], t95: ['Cursed Bow'] },
        abilityGroups: [['Critical Aura', 'Fierce Aura'], ['Frenzy'], ['Berserk'], ['Precision'], ['Pestilent Shot']],
    },
    crossbow: {
        key: 'crossbow',
        label: 'Crossbow (Sunder)',
        family: 'ranged',
        style: 'ranged',
        weapons: ['/items/soul_hunter_crossbow', '/items/sundering_crossbow'],
        gear: {
            t85: ['Soul Hunter Crossbow', 'Manticore Shield'],
            t95: ['Sundering Crossbow', 'Manticore Shield'],
        },
        abilityGroups: [
            ['Critical Aura', 'Fierce Aura'],
            ['Frenzy'],
            ['Berserk'],
            ['Pestilent Shot'],
            ['Steady Shot', 'Silencing Shot'],
        ],
    },
    fire: {
        key: 'fire',
        label: 'Magic (Fire)',
        family: 'magic',
        style: 'magic',
        weapons: ['/items/infernal_battlestaff', '/items/blazing_trident'],
        robes: [
            '/items/flaming_robe_top',
            '/items/flaming_robe_bottoms',
            '/items/royal_fire_robe_top',
            '/items/royal_fire_robe_bottoms',
        ],
        gear: {
            t85: ['Infernal Battlestaff', 'Flaming Robe Top', 'Flaming Robe Bottoms'],
            t95: ['Blazing Trident', 'Royal Fire Robe Top', 'Royal Fire Robe Bottoms'],
        },
        abilityGroups: [
            ['Critical Aura', 'Mystic Aura'],
            ['Elemental Affinity'],
            ['Precision'],
            ['Smoke Burst'],
            ['Fireball'],
        ],
    },
    water: {
        key: 'water',
        label: 'Magic (Water)',
        family: 'magic',
        style: 'magic',
        weapons: ['/items/frost_staff', '/items/rippling_trident'],
        robes: [
            '/items/icy_robe_top',
            '/items/icy_robe_bottoms',
            '/items/royal_water_robe_top',
            '/items/royal_water_robe_bottoms',
        ],
        gear: {
            t85: ['Frost Staff', 'Icy Robe Top', 'Icy Robe Bottoms'],
            t95: ['Rippling Trident', 'Royal Water Robe Top', 'Royal Water Robe Bottoms'],
        },
        abilityGroups: [
            ['Critical Aura', 'Mystic Aura'],
            ['Elemental Affinity'],
            ['Precision'],
            ['Ice Spear'],
            ['Water Strike'],
        ],
    },
    nature: {
        key: 'nature',
        label: 'Magic (Nature)',
        family: 'magic',
        style: 'magic',
        weapons: ['/items/jackalope_staff', '/items/blooming_trident'],
        robes: [
            '/items/luna_robe_top',
            '/items/luna_robe_bottoms',
            '/items/royal_nature_robe_top',
            '/items/royal_nature_robe_bottoms',
        ],
        gear: {
            t85: ['Jackalope Staff', 'Luna Robe Top', 'Luna Robe Bottoms'],
            t95: ['Blooming Trident', 'Royal Nature Robe Top', 'Royal Nature Robe Bottoms'],
        },
        abilityGroups: [
            ['Critical Aura', 'Mystic Aura'],
            ['Elemental Affinity'],
            ['Precision'],
            ['Ice Spear'],
            ['Entangle'],
        ],
    },
};

/** Every archetype key, in guide order */
export const ARCHETYPE_KEYS = Object.keys(BUILD_GUIDE);

/** Guide weapon hrid → archetype key, built once */
const WEAPON_ARCHETYPE = new Map();
for (const archetype of Object.values(BUILD_GUIDE)) {
    for (const hrid of archetype.weapons) WEAPON_ARCHETYPE.set(hrid, archetype.key);
}

/** Guide robe hrid → archetype key, for the magic element fallback */
const ROBE_ARCHETYPE = new Map();
for (const archetype of Object.values(BUILD_GUIDE)) {
    for (const hrid of archetype.robes || []) ROBE_ARCHETYPE.set(hrid, archetype.key);
}

/**
 * An item hrid with its refinement suffix removed, so a Griffin Bulwark and a
 * refined Griffin Bulwark are the same weapon to the guide.
 * @param {string} hrid - Item hrid
 * @returns {string} The unrefined hrid
 */
function baseItemHrid(hrid) {
    return String(hrid || '').replace(/_refined$/, '');
}

/**
 * Letters and digits only, lowercased — how two names are compared when one
 * came from the guide and the other from game data.
 * @param {string} text
 * @returns {string}
 */
function normalizeName(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

/**
 * The weapon a loadout is actually fighting with.
 * @param {Object} playerDTO - Player DTO with equipment
 * @param {Object} gameData - Game data payload
 * @returns {{hrid: string, name: string, stats: Object}|null}
 */
function equippedWeapon(playerDTO, gameData) {
    for (const slot of WEAPON_SLOTS) {
        const equipped = playerDTO?.equipment?.[slot];
        if (!equipped?.hrid) continue;
        const detail = gameData?.itemDetailMap?.[equipped.hrid];
        return {
            hrid: equipped.hrid,
            name: detail?.name || equipped.hrid.split('/').pop().replace(/_/g, ' '),
            stats: detail?.equipmentDetail?.combatStats || {},
        };
    }
    return null;
}

/**
 * The element a magic loadout is dressed for, when the weapon does not say.
 *
 * A Watchful Relic and a plain staff name no element; the robes always do. The
 * amplify stats are read first because they hold for any robe the game adds,
 * and the guide's own robe list is the fallback for data without them.
 * @param {Object} playerDTO - Player DTO with equipment
 * @param {Object} gameData - Game data payload
 * @returns {string|null} 'fire', 'water', 'nature', or null
 */
function elementFromRobes(playerDTO, gameData) {
    let best = null;
    let bestAmount = 0;
    let named = null;
    for (const slot of ROBE_SLOTS) {
        const equipped = playerDTO?.equipment?.[slot];
        if (!equipped?.hrid) continue;
        named = named || ROBE_ARCHETYPE.get(baseItemHrid(equipped.hrid)) || null;
        const stats = gameData?.itemDetailMap?.[equipped.hrid]?.equipmentDetail?.combatStats || {};
        for (const [key, stat] of Object.entries(ARCHETYPE_AMPLIFY_STAT)) {
            const amount = Number(stats[stat]) || 0;
            if (amount > bestAmount) {
                best = key;
                bestAmount = amount;
            }
        }
    }
    return best || named;
}

/**
 * Which build a loadout is playing.
 *
 * The weapon decides it. A weapon the guide names is taken at its word; anything
 * else is read off its stats, which is what lets an off-guide weapon of the same
 * kind — a lower-tier spear, a staff the guide has not caught up with — still
 * get the build's advice. Two special cases the stats alone get wrong:
 *
 * - A **bulwark** measures as a smash weapon, and a bulwark build is not a mace
 *   build: it is the defensive one, with a completely different ability set.
 *   Matched on the name, which is how the combat engine spots one too.
 * - A **crossbow** and a **bow** are both ranged with different signature shots.
 *   Matched on the name, falling back to the hand they take: every bow in the
 *   game is two-handed and every crossbow is not.
 *
 * Returns null rather than a guess when nothing fits — an unarmed loadout, a
 * weapon with no combat stats, a magic weapon whose element cannot be
 * established from the weapon or the robes. The caller falls back to offering
 * every ability, which is worse but never wrong.
 *
 * @param {Object} playerDTO - Player DTO with equipment
 * @param {Object} gameData - Game data payload
 * @returns {string|null} An archetype key from `BUILD_GUIDE`, or null
 */
export function detectArchetype(playerDTO, gameData) {
    const weapon = equippedWeapon(playerDTO, gameData);
    if (!weapon) return null;

    const named = WEAPON_ARCHETYPE.get(baseItemHrid(weapon.hrid));
    if (named) return named;

    const haystack = `${weapon.hrid} ${weapon.name}`.toLowerCase();
    if (haystack.includes('bulwark')) return 'wark';

    const stats = weapon.stats;
    const elemental = ELEMENT_ARCHETYPE[stats.damageType];
    if (elemental) return elemental;
    if ((stats.magicDamage || 0) > 0) return elementFromRobes(playerDTO, gameData);

    if ((stats.rangedDamage || 0) > 0) {
        if (haystack.includes('crossbow')) return 'crossbow';
        if (haystack.includes('bow')) return 'bow';
        return playerDTO?.equipment?.['/equipment_types/two_hand']?.hrid === weapon.hrid ? 'bow' : 'crossbow';
    }

    if ((stats.stabDamage || 0) > 0) return 'spear';
    if ((stats.slashDamage || 0) > 0) return 'sword';
    if ((stats.smashDamage || 0) > 0) return 'mace';
    return null;
}

/**
 * The archetype-defining ability, or abilities when the guide offers a choice.
 * Always the last group the guide lists — Puncture, Maim, Shield Bash,
 * Pestilent Shot, `Steady Shot OR Silencing Shot`, Fireball, Water Strike,
 * Entangle.
 * @param {string} key - An archetype key
 * @returns {string[]} Ability names, empty for an unknown key
 */
export function signatureGroup(key) {
    const groups = BUILD_GUIDE[key]?.abilityGroups;
    return groups?.length ? [...groups[groups.length - 1]] : [];
}

/**
 * The aura group — the special-slot ability the build runs, both sides of the
 * OR. Wark's is Invincible, which is not an aura but fills the same slot.
 * @param {string} key - An archetype key
 * @returns {string[]} Ability names, empty for an unknown key
 */
export function auraGroup(key) {
    const groups = BUILD_GUIDE[key]?.abilityGroups;
    return groups?.length ? [...groups[0]] : [];
}

/**
 * The hrid of an ability the guide names, found in live game data.
 *
 * The slug is tried first — the game's ability hrids are the name in
 * snake_case, so this is one map lookup for every ability the guide names — and
 * a name match is the fallback, so one renamed by an update is still found.
 * @param {string} name - An ability name from the guide
 * @param {Object} abilityDetailMap - From game data
 * @returns {string|null} The hrid, or null when the game has no such ability
 */
export function resolveAbilityHrid(name, abilityDetailMap) {
    if (!abilityDetailMap) return null;
    const wanted = normalizeName(name);
    if (!wanted) return null;

    const slug = String(name)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_');
    if (abilityDetailMap[`/abilities/${slug}`]) return `/abilities/${slug}`;

    for (const [hrid, detail] of Object.entries(abilityDetailMap)) {
        const label = detail?.name || hrid.split('/').pop().replace(/_/g, ' ');
        if (normalizeName(label) === wanted) return hrid;
    }
    return null;
}

/**
 * What the guide says a loadout should be casting, resolved against game data.
 *
 * `offers` is what may be swapped *in*: every ability in the archetype's set
 * that is not already equipped, or — in aura-only mode — just the aura group,
 * which is the single decision that mode is about. `memberOf` always covers the
 * *whole* set regardless of that mode, and is what the generator uses to tell an
 * on-guide ability from an off-guide one: without it, aura-only mode would
 * happily propose replacing the Frenzy the guide asked for.
 *
 * Returns null when the archetype cannot be established, and also when none of
 * the guide's abilities exist in the game data at all — a guide that resolves
 * to nothing must not silently produce an empty candidate list, so the caller
 * falls back to its old behaviour.
 *
 * @param {Object} playerDTO - Player DTO with equipment and abilities
 * @param {Object} gameData - Game data payload
 * @param {Object} [options]
 * @param {boolean} [options.auraOnly=false] - Restrict `offers` to the aura
 *   group only (historical option name; the UI calls it "Aura only")
 * @returns {{archetype: string, label: string, offers: string[],
 *   memberOf: Map<string, number>, auraOnly: boolean}|null}
 */
export function buildGuidePlan(playerDTO, gameData, options = {}) {
    const { auraOnly = false } = options;
    const key = detectArchetype(playerDTO, gameData);
    const archetype = key ? BUILD_GUIDE[key] : null;
    if (!archetype) return null;

    const abilityDetailMap = gameData?.abilityDetailMap;
    const memberOf = new Map();
    const resolved = archetype.abilityGroups.map((group, index) => {
        const hrids = [];
        for (const name of group) {
            const hrid = resolveAbilityHrid(name, abilityDetailMap);
            if (!hrid || memberOf.has(hrid)) continue;
            memberOf.set(hrid, index);
            hrids.push(hrid);
        }
        return hrids;
    });

    if (memberOf.size === 0) return null;

    const equipped = new Set((playerDTO?.abilities || []).filter((ability) => ability?.hrid).map((a) => a.hrid));
    // auraOnly is the historical flag name; it now restricts offers to the
    // aura group alone (resolved[0]) — the "Aura only" UI toggle.
    const wanted = auraOnly ? [resolved[0]] : resolved;
    // An empty `offers` is a real answer, and not the same as a null plan: a
    // loadout already running the whole guide has nothing to swap, and falling
    // back to every-ability there would answer a question the guide has already
    // settled. Only an unreadable archetype or a guide absent from the game data
    // hands back null.
    const offers = [...new Set(wanted.flat())].filter((hrid) => !equipped.has(hrid));

    return { archetype: key, label: archetype.label, offers, memberOf, auraOnly };
}
