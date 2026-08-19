/**
 * Monster stat check
 *
 * The game's answer next to the sim's, for the same monster, side by side.
 *
 * When you click a combat unit the game sends a `battle_unit_fetched` carrying
 * that unit's fully-resolved `combatDetails` — the live, buffed armour and
 * resistances that ramp as a monster stacks its own Toughness or Guardian Aura,
 * the evasion and accuracy ratings, the max hit. The combat sim builds the same
 * monster from scratch and computes what it *thinks* those numbers are. A gap
 * between the two is either a buff the sim's baseline doesn't carry (expected)
 * or the sim modelling the monster wrong (a bug — the resistance-wipe that
 * over-credited the player's damage per hit was exactly this, invisible until
 * you put the two columns next to each other).
 *
 * This module is the arithmetic: back the room level out of the scaled stats,
 * pick the fields worth comparing, and classify each gap. The panel that shows
 * it and the socket hook that feeds it live in `monster-stat-check-ui.js`; the
 * sim monster is built there because it needs live game data seeded first.
 */

/** Rows compared under each heading. `[combatDetails key, label]`. */
const MITIGATION_ROWS = [
    ['maxHitpoints', 'Max HP'],
    ['totalArmor', 'Armor'],
    ['totalWaterResistance', 'Water resist'],
    ['totalNatureResistance', 'Nature resist'],
    ['totalFireResistance', 'Fire resist'],
];

const EVASION_ROWS = [
    ['stabEvasionRating', 'Stab evasion'],
    ['slashEvasionRating', 'Slash evasion'],
    ['smashEvasionRating', 'Smash evasion'],
    ['rangedEvasionRating', 'Ranged evasion'],
    ['magicEvasionRating', 'Magic evasion'],
];

/** Below this the room scale is ~1.0 — indistinguishable from no scaling. */
const LABYRINTH_ROOM_FLOOR = 110;

/** Percent gap within which the two numbers are called equal. */
const MATCH_TOLERANCE_PCT = 1;

/**
 * Back the labyrinth room level out of the game's scaled defense level.
 *
 * A labyrinth monster runs at difficultyTier 0 and scales its levels by
 * `roomLevel / 100`, so `gameDefense = baseDefense * roomLevel / 100` and the
 * room level is recoverable from the two. Only meaningful at tier 0 — a
 * higher-tier monster's defense carries the tier multipliers too, and reversing
 * it as if it were a room level is wrong; the caller guards on tier.
 *
 * @param {number} gameDefenseLevel - The unit's live `combatDetails.defenseLevel`
 * @param {number} baseDefenseLevel - The monster's unscaled base defense level
 * @returns {number} Derived room level, or 0 when there is no meaningful scaling
 */
export function deriveRoomLevel(gameDefenseLevel, baseDefenseLevel) {
    if (!(baseDefenseLevel > 0) || !(gameDefenseLevel > 0)) return 0;
    const derived = Math.round((100 * gameDefenseLevel) / baseDefenseLevel);
    // At or near 100 the scale is 1.0 — building at roomLevel 0 gives the same
    // numbers without asserting a labyrinth context that may not be there.
    return derived > LABYRINTH_ROOM_FLOOR ? derived : 0;
}

/**
 * The combat style short key ('magic', 'smash', …) for a unit's combat stats.
 * @param {Object} combatStats - A unit's `combatDetails.combatStats`
 * @returns {string}
 */
export function styleKeyOf(combatStats) {
    const hrid = combatStats?.combatStyleHrid || combatStats?.combatStyleHrids?.[0] || '/combat_styles/smash';
    return String(hrid).split('/').pop();
}

/**
 * Human-readable names of the buffs currently on a unit.
 * @param {Object} combatBuffMap - The unit's `combatBuffMap`
 * @returns {string[]}
 */
export function activeBuffNames(combatBuffMap) {
    return Object.keys(combatBuffMap || {}).map((hrid) => String(hrid).split('/').pop().replace(/_/g, ' '));
}

/** A buff type → the compared `combatDetails` keys it raises. */
const BUFF_TYPE_TO_KEYS = {
    '/buff_types/accuracy': (style) => [`${style}AccuracyRating`],
    '/buff_types/fury_accuracy': (style) => [`${style}AccuracyRating`],
    '/buff_types/damage': (style) => [`${style}MaxDamage`],
    '/buff_types/fury_damage': (style) => [`${style}MaxDamage`],
    '/buff_types/evasion': () => EVASION_ROWS.map(([key]) => key),
    '/buff_types/armor': () => ['totalArmor'],
    '/buff_types/max_hitpoints': () => ['maxHitpoints'],
    '/buff_types/water_resistance': () => ['totalWaterResistance'],
    '/buff_types/nature_resistance': () => ['totalNatureResistance'],
    '/buff_types/fire_resistance': () => ['totalFireResistance'],
};

/**
 * Every buff type the sim engine's stat rebuild reads (see
 * combat-sim/engine/combat-unit.js `updateCombatDetails`). A live buff whose
 * type is not in here is one the engine has no term for — the fold cannot
 * apply it and the panel says so rather than dropping it silently.
 */
export const ENGINE_BUFF_TYPES = new Set([
    ...['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'].map(
        (stat) => `/buff_types/${stat}_level`
    ),
    '/buff_types/accuracy',
    '/buff_types/armor',
    '/buff_types/attack_speed',
    '/buff_types/cast_speed',
    '/buff_types/combat_drop_quantity',
    '/buff_types/combat_drop_rate',
    '/buff_types/critical_damage',
    '/buff_types/critical_rate',
    '/buff_types/damage',
    '/buff_types/damage_taken',
    '/buff_types/efficiency',
    '/buff_types/elemental_thorns',
    '/buff_types/evasion',
    '/buff_types/experience',
    '/buff_types/fire_amplify',
    '/buff_types/fire_resistance',
    '/buff_types/fury_accuracy',
    '/buff_types/fury_damage',
    '/buff_types/gourmet',
    '/buff_types/healing_amplify',
    '/buff_types/hp_regen',
    '/buff_types/life_steal',
    '/buff_types/max_hitpoints',
    '/buff_types/max_manapoints',
    '/buff_types/mp_regen',
    '/buff_types/nature_amplify',
    '/buff_types/nature_resistance',
    '/buff_types/physical_amplify',
    '/buff_types/physical_thorns',
    '/buff_types/rare_find',
    '/buff_types/retaliation',
    '/buff_types/tenacity',
    '/buff_types/threat',
    '/buff_types/water_amplify',
    '/buff_types/water_resistance',
    '/buff_types/wisdom',
]);

/** Boosts near enough to zero that folding them would be noise. */
const FOLD_EPSILON = 1e-9;

/** Human-readable name from a buff unique hrid: `/buff_uniques/x_y` → `x y`. */
function shortName(uniqueHrid) {
    return String(uniqueHrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * Plan the fold of your live combat buffs onto the sim's fight-start build.
 *
 * The sim player is snapshot at the first combat start — persistent buffs
 * folded in, no transient combat buff cast yet — while your live sheet is read
 * mid-fight with Toughness, Precision, fury, an evasion buff and whatever the
 * monster has shredded off you all up. Comparing the two raw shows every one of
 * those as a gap (observed on a Twilight Zone vampire: armour +50%, resists
 * +56–60%, evasion +27%, accuracy +80%, all of it self-buff).
 *
 * What this returns is a set of synthetic engine buffs to hand the sim player
 * before its stats are resolved, so both sides carry the same effects. The
 * arithmetic is a **per-type delta against your buff map at fight start**:
 * `Σnow(type) − Σstart(type)`. The fight-start map is what the sim's build
 * already holds (persistent sources — a guild damage buff, the labyrinth
 * combat-damage upgrade — are on you as the fight opens and are in the sim's
 * permanent buffs), so subtracting it applies each effect exactly once. A
 * subtracted delta rather than a divided ratio because that is how the engine
 * composes: every one of armour, resistances, evasion, accuracy, damage and max
 * HP sums the ratio boosts of a type and applies the sum once, so one buff
 * carrying the summed delta is arithmetically the live total.
 *
 * Without a start map (no `new_battle` seen this session) the whole live map
 * folds — the best available, and it can overstate the sim column by any
 * persistent ratios, which is why the caller says so on screen.
 *
 * @param {Object} combatBuffMap - Your live `combatBuffMap`
 * @param {Object|null} [startBuffMap] - Your `combatBuffMap` at fight start
 * @returns {{buffs: Object, folded: string[], inBuild: string[], notModelled: string[], hasStartMap: boolean}}
 *   `buffs` is keyed by a synthetic unique hrid, in the engine's buff shape
 */
export function planBuffFold(combatBuffMap, startBuffMap = null) {
    const sums = new Map();
    const bump = (typeHrid, buff, sign) => {
        const entry = sums.get(typeHrid) || { ratioBoost: 0, flatBoost: 0 };
        entry.ratioBoost += sign * (Number(buff?.ratioBoost) || 0);
        entry.flatBoost += sign * (Number(buff?.flatBoost) || 0);
        sums.set(typeHrid, entry);
    };

    const folded = [];
    const inBuild = [];
    const notModelled = [];
    const start = startBuffMap || {};

    for (const [uniqueHrid, buff] of Object.entries(combatBuffMap || {})) {
        const typeHrid = buff?.typeHrid;
        if (!ENGINE_BUFF_TYPES.has(typeHrid)) {
            notModelled.push(shortName(uniqueHrid));
            continue;
        }
        bump(typeHrid, buff, +1);
        const before = start[uniqueHrid];
        const unchanged =
            before &&
            (Number(before.ratioBoost) || 0) === (Number(buff?.ratioBoost) || 0) &&
            (Number(before.flatBoost) || 0) === (Number(buff?.flatBoost) || 0);
        (unchanged ? inBuild : folded).push(shortName(uniqueHrid));
    }
    // A buff that was up at fight start and has since fallen off is inside the
    // sim's build and no longer on you — its negative delta takes it back out.
    for (const buff of Object.values(start)) {
        if (ENGINE_BUFF_TYPES.has(buff?.typeHrid)) bump(buff.typeHrid, buff, -1);
    }

    const buffs = {};
    for (const [typeHrid, entry] of sums) {
        if (Math.abs(entry.ratioBoost) < FOLD_EPSILON && Math.abs(entry.flatBoost) < FOLD_EPSILON) continue;
        const uniqueHrid = `/buff_uniques/toolasha_fold${typeHrid.replace('/buff_types', '')}`;
        buffs[uniqueHrid] = {
            uniqueHrid,
            typeHrid,
            ratioBoost: entry.ratioBoost,
            ratioBoostLevelBonus: 0,
            flatBoost: entry.flatBoost,
            flatBoostLevelBonus: 0,
            startTime: 0,
            duration: Number.MAX_SAFE_INTEGER,
        };
    }

    return { buffs, folded, inBuild, notModelled, hasStartMap: Boolean(startBuffMap) };
}

/**
 * One line naming which player the sim was built from.
 *
 * The three probe contexts build genuinely different characters — the labyrinth
 * setup is a chosen loadout with lab token buffs and crates and no food, a zone
 * fight is the character exactly as they stand, a guild trial is the character
 * against a tier-scaled boss — and a reader who cannot tell which one produced a
 * column cannot tell a modelling gap from a comparison against the wrong build.
 *
 * @param {{source: string, zoneName?: string, tier?: number, loadoutName?: string}|null} source
 * @returns {string} The label, or '' when the source is unknown
 */
export function simPlayerLabel(source) {
    if (!source?.source) return '';
    const tier = Number(source.tier) || 0;
    if (source.source === 'labyrinth') {
        const loadout = source.loadoutName ? ` · loadout ${source.loadoutName}` : '';
        return `Sim player: labyrinth setup${loadout} · lab token buffs · crates · no food/drink`;
    }
    if (source.source === 'trial') {
        return `Sim player: your current build · Guild trial T${tier}`;
    }
    const zone = source.zoneName ? ` · ${source.zoneName}` : '';
    const tierLabel = tier > 0 ? ` (T${tier})` : '';
    return `Sim player: your current build${zone}${tierLabel} · food & drinks on · zone buffs`;
}

/** Buff types whose gaps the player check explains, for the effects readout. */
const EFFECT_BUFF_TYPES = new Set([...Object.keys(BUFF_TYPE_TO_KEYS)]);

/**
 * The names of the combat effects on a unit that move a compared stat — the ones
 * that explain a player-build gap (precision, fury, a monster's shred on you),
 * with the level-boost community/house buffs that fold into base stats left out.
 * @param {Object} combatBuffMap - The unit's `combatBuffMap`
 * @returns {string[]}
 */
export function combatEffectNames(combatBuffMap) {
    const names = [];
    for (const [uniqueHrid, buff] of Object.entries(combatBuffMap || {})) {
        if (EFFECT_BUFF_TYPES.has(buff?.typeHrid)) {
            names.push(String(uniqueHrid).split('/').pop().replace(/_/g, ' '));
        }
    }
    return names;
}

/**
 * The compared stat keys that an active buff on this unit raises.
 *
 * The player-build check compares the sim's build at *fight start* — before any
 * transient combat buff has been cast — against your live stats, which are read
 * mid-fight with those buffs up. Precision (a `/buff_types/accuracy` self-buff,
 * +68.4% at level 72) is the common one: it lifts your live accuracy while the
 * fight-start sim build has none, and the row reads as a fat mismatch when it is
 * really the sim applying precision in the fight, just not in this snapshot. The
 * keys this returns are handed leniency so such a row reads as a buff, not a bug;
 * every other stat stays sharp. Harmless for a folded persistent buff — both
 * sides carry it, so the row matches and the leniency never fires.
 *
 * @param {Object} combatBuffMap - The unit's `combatBuffMap`
 * @param {string} styleKey - The unit's combat style short key
 * @returns {Set<string>} Compared `combatDetails` keys a live buff raises
 */
export function buffedStatKeys(combatBuffMap, styleKey) {
    const keys = new Set();
    for (const buff of Object.values(combatBuffMap || {})) {
        const toKeys = BUFF_TYPE_TO_KEYS[buff?.typeHrid];
        if (!toKeys) continue;
        for (const key of toKeys(styleKey)) keys.add(key);
    }
    return keys;
}

/**
 * The grouped list of rows to compare, given the monster's own combat style.
 * Offense is style-specific — a smasher has a `smashMaxDamage`, not a magic one.
 * @param {string} styleKey
 * @returns {Array<{group: string, rows: Array<[string, string]>}>}
 */
export function statRows(styleKey) {
    return [
        { group: 'Mitigation', rows: MITIGATION_ROWS },
        { group: 'Evasion', rows: EVASION_ROWS },
        {
            group: 'Offense',
            rows: [
                [`${styleKey}AccuracyRating`, 'Accuracy'],
                [`${styleKey}MaxDamage`, 'Max hit'],
            ],
        },
    ];
}

/**
 * One stat compared between the game's live value and the sim's computed value.
 * @param {string} key - A `combatDetails` field name
 * @param {Object} gameDetails - The game unit's `combatDetails`
 * @param {Object} simDetails - The sim monster's `combatDetails`
 * @returns {{key: string, game: number|null, sim: number|null, deltaPct: number|null}}
 *   `deltaPct` is the game relative to the sim's baseline — positive means the
 *   game reads *above* the baseline (a buff is up), negative *below* it (a
 *   debuff is on), so the sign lines up with the direction of the live effect.
 */
export function compareStat(key, gameDetails, simDetails) {
    const gameRaw = Number(gameDetails?.[key]);
    const simRaw = Number(simDetails?.[key]);
    const game = Number.isFinite(gameRaw) ? gameRaw : null;
    const sim = Number.isFinite(simRaw) ? simRaw : null;
    let deltaPct = null;
    if (game != null && sim != null) {
        if (sim !== 0) deltaPct = ((game - sim) / sim) * 100;
        else if (game === 0) deltaPct = 0;
    }
    return { key, game, sim, deltaPct };
}

/**
 * Verdict for a single gap.
 *
 * The sim's baseline carries no active buffs or debuffs — the engine applies
 * those per tick during a fight, not to the resting stat block. So when the game
 * differs from the baseline and *some* combat effect is up, either direction is
 * accounted for: the game reading high is a buff (Toughness raising resistance),
 * the game reading low is a debuff (the player's pestilent-shot shred lowering
 * it). Only a gap with **no** active effect at all is a genuine modelling
 * mismatch. (A limitation worth stating: a real bug on one stat can hide behind
 * an unrelated effect on another, since the effect list isn't matched to the
 * stat — so the clean read is a monster with an empty buff map.)
 *
 * - `match` — within tolerance, the sim has this stat right.
 * - `buff` — game above the baseline with an effect up (raised by a buff).
 * - `debuff` — game below the baseline with an effect up (lowered by a debuff).
 * - `mismatch` — a gap with no active effect to explain it.
 * - `unknown` — one side had no number to compare.
 *
 * @param {number|null} deltaPct - Game relative to the sim baseline
 * @param {boolean} hasBuffs - Whether any combat effect is active on the unit
 * @returns {'match'|'buff'|'debuff'|'mismatch'|'unknown'}
 */
export function classify(deltaPct, hasBuffs) {
    if (deltaPct == null) return 'unknown';
    if (Math.abs(deltaPct) < MATCH_TOLERANCE_PCT) return 'match';
    if (hasBuffs) return deltaPct > 0 ? 'buff' : 'debuff';
    return 'mismatch';
}

/**
 * Build the full game-vs-sim comparison for a fetched unit.
 *
 * With `simBuffed`, the sim monster was built with the game's active effects
 * already applied, so the two sides are compared buffed-against-buffed: a
 * remaining gap is unexplained *by definition*, so it is classified plainly as
 * match or mismatch, and the buff/debuff verdicts don't arise. Without it, the
 * sim is the unbuffed baseline and a gap is read against the active effects —
 * game high is a buff, game low a debuff, only an effect-less gap a mismatch.
 *
 * @param {Object} gameUnit - The `unit` from a `battle_unit_fetched` payload
 * @param {Object} simDetails - The sim monster's computed `combatDetails`
 * @param {Object} [options]
 * @param {boolean} [options.simBuffed=false] - Whether the sim already carries
 *   the unit's active effects
 * @param {Set<string>} [options.leniencyKeys] - Compared keys to classify with
 *   buff-awareness even when `simBuffed` — for the player check, where the sim's
 *   fight-start build lacks the transient combat buffs your live stats carry, so
 *   the boosted rows must not read as mismatches (see `buffedStatKeys`).
 * @returns {{
 *   groups: Array<{group: string, rows: Array<{key,label,game,sim,deltaPct,verdict}>}>,
 *   buffs: string[], styleKey: string, hasMismatch: boolean, simBuffed: boolean
 * }}
 */
export function buildComparison(gameUnit, simDetails, { simBuffed = false, leniencyKeys = null } = {}) {
    const gameDetails = gameUnit?.combatDetails || {};
    const styleKey = styleKeyOf(gameDetails.combatStats);
    const buffs = activeBuffNames(gameUnit?.combatBuffMap);
    // When the sim carries the effects, a gap is not effect-explained — classify
    // it as a flat mismatch rather than a buff/debuff. Exception: a stat a live
    // buff raises that the sim build lacks (the player check's fight-start snap)
    // keeps buff-awareness, so precision reads as a buff, not a bug.
    const classifyHasBuffs = simBuffed ? false : buffs.length > 0;
    let hasMismatch = false;

    const groups = statRows(styleKey).map(({ group, rows }) => ({
        group,
        rows: rows.map(([key, label]) => {
            const compared = compareStat(key, gameDetails, simDetails);
            const rowHasBuffs = leniencyKeys?.has(key) ? true : classifyHasBuffs;
            const verdict = classify(compared.deltaPct, rowHasBuffs);
            if (verdict === 'mismatch') hasMismatch = true;
            return { ...compared, label, verdict };
        }),
    }));

    return { groups, buffs, styleKey, hasMismatch, simBuffed };
}

/**
 * The flagged rows of a comparison — everything the sim's baseline did not match
 * outright, buff and debuff and mismatch alike. These are what a discrepancy log
 * keeps: the expected effects with their magnitudes (so a pestilent-shot shred
 * or an elusiveness buff is on record) and the genuine mismatches that want a
 * closer look, told apart by `verdict`.
 *
 * @param {Object} comparison - A `buildComparison` result
 * @returns {Array<{group,key,stat,game,sim,deltaPct,verdict}>}
 */
export function flaggedRows(comparison) {
    const out = [];
    for (const group of comparison?.groups || []) {
        for (const row of group.rows || []) {
            if (row.verdict === 'buff' || row.verdict === 'debuff' || row.verdict === 'mismatch') {
                out.push({
                    group: group.group,
                    key: row.key,
                    stat: row.label,
                    game: row.game,
                    sim: row.sim,
                    deltaPct: row.deltaPct,
                    verdict: row.verdict,
                });
            }
        }
    }
    return out;
}

/** Percent gap within which a produced buff's magnitude is called equal. */
const BUFF_MATCH_TOLERANCE_PCT = 5;

/**
 * A stable signature of a unit's active-effect set, for keying labelled cases.
 * Two clicks with the same effects up (in any order) share a signature; adding
 * or dropping an effect makes a new one — so a monster is kept in every distinct
 * buff state it's seen in (unbuffed, part-stacked, fully stacked), each a
 * deterministic test of the sim's stat arithmetic given that exact set.
 * @param {Object} combatBuffMap
 * @returns {string}
 */
export function buffSignature(combatBuffMap) {
    return Object.keys(combatBuffMap || {})
        .sort()
        .join(',');
}

/** Human-readable name from a buff unique hrid. */
export function buffName(hrid) {
    return String(hrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ');
}

/**
 * The integer stack multiple between two boosts of the same effect, or null.
 *
 * Neither side states a stack count: the game's `combatBuffMap` records carry
 * only `{typeHrid, ratioBoost, flatBoost}` (no stack field appears in any
 * payload this codebase handles), and the sim's capture keeps one strongest
 * instance per uniqueHrid — so a stacked effect is visible only as its total
 * sitting at an integer multiple of the single-stack value. Heuristic by
 * necessity: same sign, ratio an integer ≥ 2 in either direction, within the
 * match tolerance of exact.
 *
 * @param {number} gv - The game's boost
 * @param {number} sv - The sim's boost
 * @returns {number|null} The multiple (2, 3, …), or null when not one
 */
function stackMultipleOf(gv, sv) {
    if (!gv || !sv) return null;
    if (gv > 0 !== sv > 0) return null;
    const ratio = Math.abs(gv) >= Math.abs(sv) ? gv / sv : sv / gv;
    const n = Math.round(ratio);
    if (n < 2) return null;
    return Math.abs(ratio - n) <= n * (BUFF_MATCH_TOLERANCE_PCT / 100) ? n : null;
}

/**
 * Union the produced-effect records of several blind probe runs, keeping the
 * peak (largest-magnitude, signed) boost per uniqueHrid — the same rule the
 * engine's capture sink applies within one run. A low-uptime effect that
 * happened not to appear in one run's fights must not read as never produced.
 *
 * @param {Array<Array<{uniqueHrid,typeHrid,ratioBoost,flatBoost}>>} runs
 * @returns {Array<{uniqueHrid,typeHrid,ratioBoost,flatBoost}>}
 */
export function unionProducedBuffs(runs) {
    const merged = new Map();
    for (const produced of runs || []) {
        for (const rec of produced || []) {
            if (!rec?.uniqueHrid) continue;
            const kept = merged.get(rec.uniqueHrid) || {
                uniqueHrid: rec.uniqueHrid,
                typeHrid: rec.typeHrid || null,
                ratioBoost: 0,
                flatBoost: 0,
            };
            const ratio = Number(rec.ratioBoost) || 0;
            const flat = Number(rec.flatBoost) || 0;
            if (Math.abs(ratio) > Math.abs(kept.ratioBoost)) kept.ratioBoost = ratio;
            if (Math.abs(flat) > Math.abs(kept.flatBoost)) kept.flatBoost = flat;
            merged.set(rec.uniqueHrid, kept);
        }
    }
    return [...merged.values()];
}

/**
 * Diff the buffs the sim produced in a blind fight against the game's live
 * effects — the "does the sim even generate these on its own" check. Union by
 * uniqueHrid, so every effect either side has is a row.
 *
 * Verdicts, worst first:
 * - `missing` — the game has it, the blind sim never produced it across its
 *   probe fights (the sim does not model the ability, or its rotation never
 *   cast it). The one claim the probe's evidence is strong for.
 * - `magnitude` — both produce it, but at a different strength (a derivation /
 *   level-resolution gap).
 * - `stacks` — both produce it and the strengths sit at an integer multiple
 *   (2×, 3×, either direction) of each other: the per-stack value agrees, only
 *   the stack count at the compared instants differs — a timing/uptime
 *   question, not a derivation one. `stackMultiple` carries the multiple.
 * - `notInSnapshot` — the sim produced it but it wasn't up in the game's
 *   snapshot. The game column is ONE clicked instant, so an effect between
 *   applications simply isn't there — timing, not a modelling defect; graded
 *   neutral and never counted as an issue.
 * - `match` — same effect, same strength.
 *
 * @param {Object} gameBuffMap - The unit's live `combatBuffMap`
 * @param {Array<{uniqueHrid,typeHrid,ratioBoost,flatBoost}>} produced - From the probe
 * @returns {Array<{uniqueHrid,name,typeHrid,game,sim,verdict,deltaPct,stackMultiple}>}
 */
export function compareBuffProduction(gameBuffMap, produced) {
    const toRec = (r) => ({
        ratioBoost: Number(r?.ratioBoost) || 0,
        flatBoost: Number(r?.flatBoost) || 0,
        typeHrid: r?.typeHrid || null,
    });
    const game = new Map(Object.entries(gameBuffMap || {}).map(([hrid, r]) => [hrid, toRec(r)]));
    const sim = new Map((produced || []).filter((r) => r?.uniqueHrid).map((r) => [r.uniqueHrid, toRec(r)]));

    const keys = [...new Set([...game.keys(), ...sim.keys()])];
    const rows = keys.map((hrid) => {
        const g = game.get(hrid) || null;
        const s = sim.get(hrid) || null;
        let verdict;
        let deltaPct = null;
        let stackMultiple = null;
        if (g && !s) {
            verdict = 'missing';
        } else if (!g && s) {
            verdict = 'notInSnapshot';
        } else {
            // Compare on whichever boost the game's effect actually uses.
            const field = g.ratioBoost !== 0 || g.flatBoost === 0 ? 'ratioBoost' : 'flatBoost';
            const gv = g[field];
            const sv = s[field];
            if (gv !== 0) deltaPct = ((sv - gv) / Math.abs(gv)) * 100;
            const equal = deltaPct == null ? sv === gv : Math.abs(deltaPct) < BUFF_MATCH_TOLERANCE_PCT;
            if (equal) {
                verdict = 'match';
            } else {
                stackMultiple = stackMultipleOf(gv, sv);
                verdict = stackMultiple ? 'stacks' : 'magnitude';
            }
        }
        return {
            uniqueHrid: hrid,
            name: buffName(hrid),
            typeHrid: g?.typeHrid || s?.typeHrid || null,
            game: g,
            sim: s,
            verdict,
            deltaPct,
            stackMultiple,
        };
    });

    const rank = { missing: 0, magnitude: 1, stacks: 2, notInSnapshot: 3, match: 4 };
    rows.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) || a.name.localeCompare(b.name));
    return rows;
}

/**
 * Which context fields a held tick capture disagrees with, for the uptime
 * harness's usable gate. A field unlabelled on either side passes — absence of
 * a label is not evidence of a mismatch (old captures carry no fingerprint,
 * and a capture armed outside a room may carry no monster). What this refuses
 * to do is compare ticks from one monster/room/build against a sim of another
 * and call the gap a finding.
 *
 * @param {Object|null} captureContext - The capture file's `context`
 * @param {{monsterHrid: string, roomLevel: number, fingerprint: string|null}} current
 * @returns {string[]} Human-readable names of the differing fields
 *   ('monster', 'room level', 'build'); empty when the capture is usable
 */
export function captureContextMismatches(captureContext, current) {
    const mismatches = [];
    const capturedMonster = captureContext?.monsterHrid || null;
    const capturedLevel = Number(captureContext?.roomLevel) || 0;
    const capturedBuild = captureContext?.fingerprint || null;
    if (capturedMonster && current?.monsterHrid && capturedMonster !== current.monsterHrid) {
        mismatches.push('monster');
    }
    if (capturedLevel && Number(current?.roomLevel) && capturedLevel !== Number(current.roomLevel)) {
        mismatches.push('room level');
    }
    if (capturedBuild && current?.fingerprint && capturedBuild !== current.fingerprint) {
        mismatches.push('build');
    }
    return mismatches;
}

/**
 * Wrap a discrepancy log and the current snapshot in the export envelope.
 *
 * playerBuild is panel-level (one per session, not per monster), so it rides at
 * the top rather than inside an entry. It is the other half of the sim-vs-real
 * picture: a monster can match perfectly while the sim builds *you* wrong, and
 * an export that carries only the monster side sends whoever reads it hunting on
 * the wrong side of the fight.
 *
 * @param {Array<Object>} entries - Recorded discrepancy records, newest last
 * @param {Object|null} current - The comparison currently on screen
 * @param {number} exportedAt - A timestamp (the caller owns the clock)
 * @param {Object|null} [playerBuild] - The player-build (you vs sim) result, if run
 * @param {{source: string, zoneHrid?: string|null, tier?: number, loadoutName?: string|null}|null} [simPlayer]
 *   Which player the sim was built from — a zone build, the labyrinth setup or a
 *   guild trial. Without it an export cannot be read: the same monster compared
 *   against the lab loadout and against your live gear are different findings.
 * @returns {Object}
 */
export function buildExportPayload(entries, current, exportedAt, playerBuild = null, simPlayer = null) {
    return {
        format: 'toolasha-monster-stat-check',
        version: 1,
        exportedAt,
        current: current || null,
        entries: entries || [],
        playerBuild: playerBuild || null,
        simPlayer: simPlayer || null,
    };
}
