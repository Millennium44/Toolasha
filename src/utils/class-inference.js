/**
 * What role a player is playing, inferred from what they cast.
 *
 * A guild trial fields up to fifty people and the only authoritative statement
 * of anybody's kit is their Battle Info popup, opened one click at a time
 * (`guild-loadout-capture.js`). In practice most of a roster is never clicked,
 * so the Trial Abilities panel lists a column of names about which nothing at
 * all is known — which is exactly the case where a *guess* is worth having, as
 * long as it says what it is a guess from.
 *
 * The stream is the other source. `guild_battle_updated` carries `abilityHrid`
 * on the units it has one for, and every hrid resolves through the game's own
 * `abilityDetailMap` to a combat style, a damage type and an effect type. Those
 * three fields are the whole of the inference: nothing here has a list of
 * ability names in it, so a game update that adds an ability classifies it
 * without anyone editing this file.
 *
 * ## The buckets, and the rules that pick one
 *
 * Strongest evidence first, and the first rule that fires wins:
 *
 * 1. **A taunt, thorns or retaliation ability is a tank.** Cast or merely
 *    carried in a captured kit: a buff of type threat, physical/elemental
 *    thorns or retaliation exists to be hit and nobody else runs one. This is
 *    the kit declaring itself, which beats a number on a stat sheet.
 * 2. **An ally heal is a healer.** An `/ability_effect_types/heal` effect
 *    pointed at an ally. Self-heals do not count: every build life-steals.
 * 2b. **The equipped weapon's own passive, when a stat sheet has been fetched.**
 *    `battle_unit_fetched` (and `new_battle`) carry `combatStats` computed off
 *    the unit's real equipment, and the signature weapon passives — pierce,
 *    curse, bloom, ripple, blaze, mayhem, fury, weaken — appear there as
 *    nonzero numbers only when the weapon that grants one is actually wielded.
 *    Which passive belongs to which combat style is not a list here: it is
 *    derived from the game's own `itemDetailMap` ({@link weaponPassiveBuckets}),
 *    so a passive is only trusted when every weapon carrying it agrees on a
 *    bucket and no non-weapon equipment grants it. This outranks the ability
 *    rules below because abilities are what the player *chose to slot*, while
 *    the passive is what they *actually wield* — the reported failure was a
 *    crossbow wielder tagged Melee off the melee abilities in their kit.
 * 3. **The modal damage style of what they actually cast or carry.** Magic
 *    splits again by the modal `damageType`, because in this game "mage"
 *    without an element says nothing about what the party is weak to — and the
 *    elements are not three peers. Fire and water are the damage elements and
 *    get a bucket each; **nature is the healing element**, so nature casts land
 *    in Healer rather than in a third mage bucket. That agrees with rule 2 by
 *    construction: a nature caster and an ally-healer are the same player, and
 *    the two rules must not be able to disagree about them. Ranged and the
 *    three melee styles collapse to Ranged and Melee. A real ability someone is
 *    actually casting says more about their role than a raw threat number does,
 *    so this now outranks rule 4 — a mage stacking Threat from gear or levels
 *    is still a mage, evidenced by the fireballs they are throwing.
 * 4. **Threat on the sheet is a tank**, when nothing above already answered.
 *    `combatStats.threat` is not a flag — every unit carries a baseline value
 *    the moment they enter combat (the game adds a flat 100 before any
 *    tank-specific multiplier), so a merely nonzero reading proves nothing on
 *    its own; it is what a Fire Mage with 208 Threat on their sheet looks like.
 *    What is diagnostic is a reading well above what the rest of the party is
 *    showing, which is why the caller may pass `partyThreat` — a representative
 *    baseline threat for the current roster. With one, this rule requires
 *    `stats.threat` to clear `partyThreat * TANK_THREAT_RATIO`. Without one
 *    (an isolated call, or a test), it falls back to "nonzero" — weaker, but
 *    only reached once rules 1–3 have already had first refusal.
 * 5. **The sheet's own style**, when no damaging cast has been seen but a
 *    capture exists: `combatStats.combatStyleHrids[0]` and `combatStats.damageType`.
 * 6. **Nothing.** Null, and the caller draws no tag. Never a guess from party
 *    position or from a name.
 *
 * ## It says where it came from
 *
 * Every verdict carries `basis` — which rule fired — and `evidence`, the last
 * few distinct ability hrids the inference was drawn from. A tag nobody can
 * interrogate is a tag nobody should trust, and "Fire Mage, from firestorm,
 * fireball, ice_spear" is a claim a reader can check against the person they
 * are looking at.
 *
 * ## What it is not
 *
 * Not a manual override, not persisted, and not authoritative. A captured kit
 * beats it wherever one exists — this is what fills the rest of the column in.
 *
 * The idea of naming each row's class on a trial meter is KikiMeter's by
 * ZhuLiMoon (MIT) — see `third-party/kikimeter/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The rules, the buckets and the code are
 * Toolasha's own, drawn off the game's ability data rather than a name list.
 */

/** Ability effects that restore health */
const HEAL_EFFECT = '/ability_effect_types/heal';

/** Ability effects that deal damage */
const DAMAGE_EFFECT = '/ability_effect_types/damage';

/** Buff types only a tank's kit carries — the thing to be hit, and the price of hitting it */
const TANK_BUFFS = new Set([
    '/buff_types/threat',
    '/buff_types/physical_thorns',
    '/buff_types/elemental_thorns',
    '/buff_types/retaliation',
]);

/** How many distinct ability hrids a verdict keeps as its evidence */
export const MAX_EVIDENCE = 6;

/**
 * The `combatStats` fields that are weapon passives.
 *
 * Sourced from the game's own combat stat schema (the equipment stat list the
 * bundled combat-sim engine ports verbatim from the game data —
 * `features/combat-sim/engine/player.js`, `EQUIPMENT_STATS`): pierce and curse
 * are the crossbow's and Cursed Bow's on-hits, bloom/ripple/blaze the nature,
 * water and fire weapons', mayhem/fury/weaken the melee lines'. The list only
 * says which keys are *worth looking up*; what each one means is derived from
 * `itemDetailMap` in {@link weaponPassiveBuckets}, so a wrong or stale entry
 * here yields no verdict rather than a wrong one.
 */
export const WEAPON_PASSIVE_STATS = ['mayhem', 'pierce', 'curse', 'fury', 'weaken', 'ripple', 'bloom', 'blaze'];

/** The slots a weapon sits in; a passive read off anything else is not the weapon's */
const WEAPON_SLOT_TYPES = new Set(['/equipment_types/main_hand', '/equipment_types/two_hand']);

/**
 * How far above the party's baseline threat a sheet reading must sit before
 * it is trusted as a tank signal, rather than the ordinary scaling everybody's
 * Threat stat shows. Picked well clear of noise: a real tank's threat comes
 * from a taunt-type buff's ratio boost, which multiplies rather than nudges.
 */
export const TANK_THREAT_RATIO = 1.5;

/**
 * The buckets, and how each is drawn.
 *
 * `short` is what fits beside a name in a crowded list; `label` is what the
 * tooltip and the wider panels use.
 */
export const CLASS_BUCKETS = {
    tank: { key: 'tank', label: 'Tank', short: 'TANK' },
    healer: { key: 'healer', label: 'Healer', short: 'HEAL' },
    fireMage: { key: 'fireMage', label: 'Fire Mage', short: 'FIRE' },
    waterMage: { key: 'waterMage', label: 'Water Mage', short: 'WATER' },
    mage: { key: 'mage', label: 'Mage', short: 'MAGE' },
    ranged: { key: 'ranged', label: 'Ranged', short: 'RANGED' },
    melee: { key: 'melee', label: 'Melee', short: 'MELEE' },
};

/**
 * Damage type hrid tail → the bucket it names.
 *
 * Nature is not a mage bucket. The game's healing is written in nature, so a
 * caster whose modal element is nature is the party's healer — the same verdict
 * the ally-heal rule reaches, from the other direction.
 */
const MAGE_BY_ELEMENT = {
    fire: CLASS_BUCKETS.fireMage,
    water: CLASS_BUCKETS.waterMage,
    nature: CLASS_BUCKETS.healer,
};

/** Combat style hrid tail → the non-magic bucket it names */
const BUCKET_BY_STYLE = {
    ranged: CLASS_BUCKETS.ranged,
    stab: CLASS_BUCKETS.melee,
    slash: CLASS_BUCKETS.melee,
    smash: CLASS_BUCKETS.melee,
};

/**
 * The last segment of an hrid, which is the only part worth comparing.
 * @param {string} hrid - e.g. `/combat_styles/magic`
 * @returns {string} e.g. `magic`, or '' for nothing usable
 */
function tail(hrid) {
    const raw = String(hrid || '');
    if (!raw) return '';
    return raw.includes('/') ? raw.split('/').pop() : raw;
}

/**
 * What one ability is, reduced to the three fields the rules read.
 *
 * `null` for an hrid the game data does not know, and for the two pseudo-hrids
 * the tick stream uses in place of one — `auto` (auto-attacking) and `idle`.
 * An auto-attack says nothing about a build: everybody has one, and its style
 * comes from the weapon rather than from the ability.
 *
 * @param {string} hrid - Ability hrid from a tick or a captured kit
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {{hrid: string, healsAlly: boolean, damages: boolean, tanks: boolean, style: string, element: string}|null}
 */
export function abilityProfile(hrid, abilityDetailMap = {}) {
    const key = String(hrid || '');
    if (!key || key === 'auto' || key === 'idle' || key === 'dot') return null;

    const detail = abilityDetailMap?.[key];
    if (!detail) return null;

    let healsAlly = false;
    let damages = false;
    let tanks = false;
    let style = '';
    let element = '';

    for (const effect of detail.abilityEffects || []) {
        const target = String(effect?.targetType || '');
        if (effect?.effectType === HEAL_EFFECT && target !== 'self') healsAlly = true;
        if ((effect?.buffs || []).some((buff) => TANK_BUFFS.has(String(buff?.typeHrid || '')))) tanks = true;
        if (effect?.effectType !== DAMAGE_EFFECT) continue;

        damages = true;
        // The first damaging effect states the style; a multi-effect ability
        // does not mix styles, and taking the first keeps the answer stable
        if (!style) style = tail(effect?.combatStyleHrid);
        if (!element) element = tail(effect?.damageType);
    }

    return { hrid: key, healsAlly, damages, tanks, style, element };
}

/**
 * A fresh accumulator for one player's observed casts.
 *
 * Distinct hrids in the order first seen, plus a count per hrid so the *modal*
 * style is a real mode rather than whichever ability happened to be last. Both
 * are bounded: a build has a handful of abilities, and an unbounded map keyed by
 * a payload field is a leak waiting for a game update to widen it.
 *
 * @returns {{order: string[], counts: Object}}
 */
export function newCastLog() {
    return { order: [], counts: {} };
}

/**
 * Record one observed cast.
 *
 * Pure in spirit and mutating in fact, because it runs twice a second per
 * player on a live trial stream — the alternative allocates a new object per
 * tick per member for no gain.
 *
 * @param {{order: string[], counts: Object}} log - From {@link newCastLog}, mutated
 * @param {string} hrid - The ability hrid the tick carried
 * @returns {boolean} Whether this was an hrid the log had not seen before
 */
export function noteCast(log, hrid) {
    const key = String(hrid || '');
    if (!log || !key || key === 'auto' || key === 'idle') return false;

    const seen = log.counts[key] !== undefined;
    log.counts[key] = (log.counts[key] || 0) + 1;
    if (seen) return false;

    log.order.push(key);
    // Bounded: the oldest distinct ability falls out of the evidence, and its
    // count goes with it so a stale hrid cannot keep swinging the mode
    while (log.order.length > MAX_EVIDENCE) {
        const dropped = log.order.shift();
        delete log.counts[dropped];
    }
    return true;
}

/**
 * The most-cast entry of a `{key: count}` map.
 *
 * Ties break on the first key in insertion order, which is the earliest thing
 * seen — arbitrary, but stable, so a tag does not flicker between two equally
 * cast styles from one tick to the next.
 *
 * @param {Object} counts - `{key: count}`
 * @returns {string|null} The modal key
 */
function modal(counts) {
    let best = null;
    let most = 0;
    for (const [key, count] of Object.entries(counts || {})) {
        if (count > most) {
            most = count;
            best = key;
        }
    }
    return best;
}

/**
 * The bucket a combat style and damage type name.
 *
 * @param {string} style - Combat style hrid or its tail
 * @param {string} element - Damage type hrid or its tail
 * @returns {{key: string, label: string, short: string}|null}
 */
export function bucketForStyle(style, element) {
    const styleKey = tail(style);
    if (!styleKey) return null;
    if (styleKey !== 'magic') return BUCKET_BY_STYLE[styleKey] || null;
    return MAGE_BY_ELEMENT[tail(element)] || CLASS_BUCKETS.mage;
}

/** The last `itemDetailMap` the passive table was derived from, and the table */
let passiveBucketCache = { map: null, buckets: {} };

/**
 * What each weapon passive says about the wielder, from the game's own items.
 *
 * For every weapon in `itemDetailMap` (main-hand or two-hand) whose
 * `equipmentDetail.combatStats` grants one of {@link WEAPON_PASSIVE_STATS}, the
 * weapon's own combat style and damage type name a bucket — the crossbow's
 * pierce reads ranged off the crossbow itself, the Blooming Trident's bloom
 * reads magic/nature and lands in Healer by the same rule every nature caster
 * does. Nothing is hardcoded about which passive means what, so a new tier or
 * a renamed weapon reclassifies itself.
 *
 * A passive is dropped rather than guessed at when the data disagrees with the
 * premise: granted by weapons of two different buckets, or granted by any
 * non-weapon equipment (a charm's proc says nothing about the weapon in hand).
 * The melee sub-style rides along when every carrier agrees on it, for the
 * icon; buckets that agree while sub-styles differ keep the bucket and drop
 * the sub-style.
 *
 * Cached against the identity of the map, exactly as the callers' other
 * game-data digests are — one pass per client-data load.
 *
 * @param {Object|null} itemDetailMap - Game data
 * @returns {Object<string, {key: string, label: string, short: string, style: string}>}
 *   Passive stat key → the bucket it proves, only for passives the data makes unambiguous
 */
export function weaponPassiveBuckets(itemDetailMap) {
    if (!itemDetailMap || typeof itemDetailMap !== 'object') return {};
    if (passiveBucketCache.map === itemDetailMap) return passiveBucketCache.buckets;

    const buckets = {};
    const dropped = new Set();
    for (const item of Object.values(itemDetailMap)) {
        const equipment = item?.equipmentDetail;
        const stats = equipment?.combatStats;
        if (!stats || typeof stats !== 'object') continue;

        const isWeapon = WEAPON_SLOT_TYPES.has(String(equipment.type || ''));
        for (const passive of WEAPON_PASSIVE_STATS) {
            if (!(Number(stats[passive]) > 0)) continue;
            if (!isWeapon) {
                // Some non-weapon grants this too, so a nonzero reading on a
                // sheet no longer proves the weapon — the passive is out
                dropped.add(passive);
                continue;
            }
            const style = tail(stats.combatStyleHrids?.[0] || stats.combatStyleHrid);
            const bucket = bucketForStyle(style, stats.damageType);
            if (!bucket) {
                dropped.add(passive);
                continue;
            }
            const existing = buckets[passive];
            if (existing && existing.key !== bucket.key) {
                dropped.add(passive);
                continue;
            }
            buckets[passive] = {
                ...bucket,
                // The sub-style survives only while every carrier agrees on it
                style: existing && existing.style !== style ? '' : style,
            };
        }
    }
    for (const passive of dropped) delete buckets[passive];

    passiveBucketCache = { map: itemDetailMap, buckets };
    return buckets;
}

/**
 * What role the evidence says this player is playing.
 *
 * See the module note for the rules and the order they fire in. Everything is
 * an argument: no game data is imported here, so the whole of it is testable
 * against a synthetic ability map.
 *
 * @param {Object} input - The evidence
 * @param {{order: string[], counts: Object}} [input.casts] - Observed casts, from {@link newCastLog}
 * @param {Array<{hrid: string}>} [input.kit] - An authoritative captured ability list
 * @param {Object} [input.stats] - `combatDetails.combatStats` from a captured loadout
 * @param {string} [input.weaponHrid] - The weapon actually wielded, when known (own character,
 *   a captured loadout) — carried on the verdict so the drawing can be the real weapon's kind
 * @param {number|null} [input.partyThreat] - A representative baseline threat for the rest of the
 *   party (e.g. the median of everyone else captured), used to tell a tank's threat apart from the
 *   baseline everybody's sheet shows. Omit when there is nothing to compare against yet.
 * @param {Object} [abilityDetailMap] - Game data
 * @param {Object|null} [itemDetailMap] - Game data, for reading the weapon passives on a fetched
 *   sheet ({@link weaponPassiveBuckets}). Omitted, the passive rule simply never fires.
 * @returns {{key: string, label: string, short: string, basis: string, evidence: string[],
 *   style: string, curse: boolean, weaponHrid: string|null}|null}
 *   The verdict, or null when nothing supports one. `style` is the melee sub-style
 *   (stab/slash/smash) or the sheet's style when one was read, else ''. `curse` says a
 *   curse was ever seen in the evidence — the Cursed Bow's on-hit, which is what tells it
 *   from the crossbow inside the ranged bucket.
 */
export function inferClass(
    { casts = null, kit = null, stats = null, weaponHrid = null, partyThreat = null } = {},
    abilityDetailMap = {},
    itemDetailMap = null
) {
    // The hrids the verdict may cite: what was watched first, and the captured
    // kit behind it. Deduplicated, because a captured ability that was also
    // cast is one piece of evidence rather than two
    const observed = [...(casts?.order || [])];
    const kitHrids = (kit || []).map((entry) => String(entry?.hrid || '')).filter(Boolean);
    const evidence = [...new Set([...observed, ...kitHrids])].slice(0, MAX_EVIDENCE);

    // A curse anywhere in what was watched or carried, or on the sheet itself —
    // `combatStats.curse` is the Cursed Bow's own passive, the strongest form
    // of the same evidence. Evidence is bounded, so the whole watched order is
    // checked too — an early curse must not fall out
    const curse =
        Number(stats?.curse) > 0 ||
        [...observed, ...kitHrids, ...Object.keys(casts?.counts || {})].some((hrid) => /curse/i.test(String(hrid)));
    const sheetStyleTail = tail(stats?.combatStyleHrid || stats?.combatStyleHrids?.[0]);

    const verdict = (bucket, basis, style = '') =>
        bucket ? { ...bucket, basis, evidence, style: style || sheetStyleTail || '', curse, weaponHrid } : null;

    const profiles = [];
    for (const hrid of [...observed, ...kitHrids]) {
        const profile = abilityProfile(hrid, abilityDetailMap);
        if (profile) profiles.push(profile);
    }

    // 1. A taunt, thorns or retaliation ability is the kit's own statement of
    //    tanking — cast or merely carried
    if (profiles.some((profile) => profile.tanks)) {
        return verdict(CLASS_BUCKETS.tank, 'a taunt, thorns or retaliation ability in the kit');
    }

    // 2. Anybody who heals an ally is the healer, whatever else they cast —
    //    a healer's filler damage is not what the party needs them for
    if (profiles.some((profile) => profile.healsAlly)) {
        return verdict(CLASS_BUCKETS.healer, 'an ally heal in the ability stream');
    }

    // 2b. The equipped weapon's own passive, read off a fetched stat sheet.
    //     The abilities in a kit are what the player slotted; the passive is
    //     what they wield — a crossbow wielder carrying melee abilities is
    //     Ranged, and only the sheet knows it. Every nonzero passive the game
    //     data can vouch for must agree on one bucket; a sheet that somehow
    //     shows two different answers proves nothing and falls through
    const passiveBuckets = weaponPassiveBuckets(itemDetailMap);
    const passivesSeen = WEAPON_PASSIVE_STATS.filter(
        (passive) => Number(stats?.[passive]) > 0 && passiveBuckets[passive]
    );
    if (passivesSeen.length && new Set(passivesSeen.map((passive) => passiveBuckets[passive].key)).size === 1) {
        const chosen = passiveBuckets[passivesSeen[0]];
        return verdict(chosen, `the equipped weapon's ${passivesSeen[0]} passive on the stat sheet`, chosen.style);
    }

    // 3. The modal style of the damaging casts, weighted by how often each
    //    ability was actually seen — a rotation's opener should not outvote
    //    the spell it is cast ten times between. A real offensive ability
    //    outranks a raw threat number: everyone's Threat stat scales with
    //    level and gear, so it is not evidence against what someone is
    //    actually observed casting
    const styleCounts = {};
    const elementCounts = {};
    for (const profile of profiles) {
        if (!profile.damages || !profile.style) continue;
        const weight = casts?.counts?.[profile.hrid] || 1;
        styleCounts[profile.style] = (styleCounts[profile.style] || 0) + weight;
        if (profile.style === 'magic' && profile.element) {
            elementCounts[profile.element] = (elementCounts[profile.element] || 0) + weight;
        }
    }

    const style = modal(styleCounts);
    if (style) {
        const bucket = bucketForStyle(style, modal(elementCounts));
        if (bucket) return verdict(bucket, 'the styles cast in this trial', style);
    }

    // 4. Threat on the sheet, once nothing above has already answered. Not a
    //    flag — every unit's sheet carries a baseline value — so with a party
    //    baseline to compare against, only a reading well clear of it counts;
    //    without one, this falls back to "nonzero", the weakest reading of it
    const threat = Number(stats?.threat);
    const baseline = Number(partyThreat);
    const hasBaseline = Number.isFinite(baseline) && baseline > 0;
    const threatIsElevated =
        Number.isFinite(threat) && (hasBaseline ? threat > baseline * TANK_THREAT_RATIO : threat > 0);
    if (threatIsElevated) {
        return verdict(
            CLASS_BUCKETS.tank,
            hasBaseline
                ? 'threat well above the rest of the party, on the captured sheet'
                : 'threat on the captured sheet'
        );
    }

    // 5. The sheet, when nothing damaging has been watched. A capture states
    //    the weapon's own style and element outright
    const sheetStyle = stats?.combatStyleHrid || stats?.combatStyleHrids?.[0];
    const sheetBucket = bucketForStyle(sheetStyle, stats?.damageType);
    if (sheetBucket) return verdict(sheetBucket, 'the weapon style on the captured sheet', tail(sheetStyle));

    // 6. Nothing. A column of blanks is honest; a column of guesses is not
    return null;
}
