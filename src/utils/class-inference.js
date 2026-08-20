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
 * 1. **Threat on the sheet is a tank.** `combatStats.threat` is a stat nobody
 *    carries by accident — it exists to pull aggro — so a captured loadout with
 *    a nonzero one settles the question outright. Only a capture can say this;
 *    the stream carries no stats.
 * 2. **An ally heal is a healer.** An `/ability_effect_types/heal` effect
 *    pointed at an ally. Self-heals do not count: every build life-steals.
 * 3. **The modal damage style of what they actually cast.** Magic splits again
 *    by the modal `damageType` of those casts — fire, water, nature — because in
 *    this game "mage" without an element says nothing about what the party is
 *    weak to. Ranged and the three melee styles collapse to Ranged and Melee.
 * 4. **The sheet's own style**, when no damaging cast has been seen but a
 *    capture exists: `combatStats.combatStyleHrids[0]` and `combatStats.damageType`.
 * 5. **Nothing.** Null, and the caller draws no tag. Never a guess from party
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

/** How many distinct ability hrids a verdict keeps as its evidence */
export const MAX_EVIDENCE = 6;

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
    natureMage: { key: 'natureMage', label: 'Nature Mage', short: 'NATURE' },
    mage: { key: 'mage', label: 'Mage', short: 'MAGE' },
    ranged: { key: 'ranged', label: 'Ranged', short: 'RANGED' },
    melee: { key: 'melee', label: 'Melee', short: 'MELEE' },
};

/** Damage type hrid tail → the magic bucket it names */
const MAGE_BY_ELEMENT = {
    fire: CLASS_BUCKETS.fireMage,
    water: CLASS_BUCKETS.waterMage,
    nature: CLASS_BUCKETS.natureMage,
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
 * @returns {{hrid: string, healsAlly: boolean, damages: boolean, style: string, element: string}|null}
 */
export function abilityProfile(hrid, abilityDetailMap = {}) {
    const key = String(hrid || '');
    if (!key || key === 'auto' || key === 'idle' || key === 'dot') return null;

    const detail = abilityDetailMap?.[key];
    if (!detail) return null;

    let healsAlly = false;
    let damages = false;
    let style = '';
    let element = '';

    for (const effect of detail.abilityEffects || []) {
        const target = String(effect?.targetType || '');
        if (effect?.effectType === HEAL_EFFECT && target !== 'self') healsAlly = true;
        if (effect?.effectType !== DAMAGE_EFFECT) continue;

        damages = true;
        // The first damaging effect states the style; a multi-effect ability
        // does not mix styles, and taking the first keeps the answer stable
        if (!style) style = tail(effect?.combatStyleHrid);
        if (!element) element = tail(effect?.damageType);
    }

    return { hrid: key, healsAlly, damages, style, element };
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
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {{key: string, label: string, short: string, basis: string, evidence: string[]}|null}
 *   The verdict, or null when nothing supports one
 */
export function inferClass({ casts = null, kit = null, stats = null } = {}, abilityDetailMap = {}) {
    // The hrids the verdict may cite: what was watched first, and the captured
    // kit behind it. Deduplicated, because a captured ability that was also
    // cast is one piece of evidence rather than two
    const observed = [...(casts?.order || [])];
    const kitHrids = (kit || []).map((entry) => String(entry?.hrid || '')).filter(Boolean);
    const evidence = [...new Set([...observed, ...kitHrids])].slice(0, MAX_EVIDENCE);

    const verdict = (bucket, basis) => (bucket ? { ...bucket, basis, evidence } : null);

    // 1. Threat is a stat carried on purpose, and only a tank carries it
    if (Number(stats?.threat) > 0) return verdict(CLASS_BUCKETS.tank, 'threat on the captured sheet');

    const profiles = [];
    for (const hrid of [...observed, ...kitHrids]) {
        const profile = abilityProfile(hrid, abilityDetailMap);
        if (profile) profiles.push(profile);
    }

    // 2. Anybody who heals an ally is the healer, whatever else they cast —
    //    a healer's filler damage is not what the party needs them for
    if (profiles.some((profile) => profile.healsAlly)) {
        return verdict(CLASS_BUCKETS.healer, 'an ally heal in the ability stream');
    }

    // 3. The modal style of the damaging casts, weighted by how often each
    //    ability was actually seen — a rotation's opener should not outvote
    //    the spell it is cast ten times between
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
        if (bucket) return verdict(bucket, 'the styles cast in this trial');
    }

    // 4. The sheet, when nothing damaging has been watched. A capture states
    //    the weapon's own style and element outright
    const sheetStyle = stats?.combatStyleHrid || stats?.combatStyleHrids?.[0];
    const sheetBucket = bucketForStyle(sheetStyle, stats?.damageType);
    if (sheetBucket) return verdict(sheetBucket, 'the weapon style on the captured sheet');

    // 5. Nothing. A column of blanks is honest; a column of guesses is not
    return null;
}
