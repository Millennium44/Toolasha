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
 * @returns {{
 *   groups: Array<{group: string, rows: Array<{key,label,game,sim,deltaPct,verdict}>}>,
 *   buffs: string[], styleKey: string, hasMismatch: boolean, simBuffed: boolean
 * }}
 */
export function buildComparison(gameUnit, simDetails, { simBuffed = false } = {}) {
    const gameDetails = gameUnit?.combatDetails || {};
    const styleKey = styleKeyOf(gameDetails.combatStats);
    const buffs = activeBuffNames(gameUnit?.combatBuffMap);
    // When the sim carries the effects, a gap is not effect-explained — classify
    // it as a flat mismatch rather than a buff/debuff.
    const classifyHasBuffs = simBuffed ? false : buffs.length > 0;
    let hasMismatch = false;

    const groups = statRows(styleKey).map(({ group, rows }) => ({
        group,
        rows: rows.map(([key, label]) => {
            const compared = compareStat(key, gameDetails, simDetails);
            const verdict = classify(compared.deltaPct, classifyHasBuffs);
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
 * Diff the buffs the sim produced in a blind fight against the game's live
 * effects — the "does the sim even generate these on its own" check. Union by
 * uniqueHrid, so every effect either side has is a row.
 *
 * Verdicts, worst first:
 * - `missing` — the game has it, the blind sim never produced it (the sim does
 *   not model the ability, or its rotation never cast it).
 * - `magnitude` — both produce it, but at a different strength (a derivation /
 *   level-resolution gap).
 * - `extra` — the sim produced it but the game snapshot didn't have it up (often
 *   just timing — the effect was between applications when the panel was read).
 * - `match` — same effect, same strength.
 *
 * @param {Object} gameBuffMap - The unit's live `combatBuffMap`
 * @param {Array<{uniqueHrid,typeHrid,ratioBoost,flatBoost}>} produced - From the probe
 * @returns {Array<{uniqueHrid,name,typeHrid,game,sim,verdict,deltaPct}>}
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
        if (g && !s) {
            verdict = 'missing';
        } else if (!g && s) {
            verdict = 'extra';
        } else {
            // Compare on whichever boost the game's effect actually uses.
            const field = g.ratioBoost !== 0 || g.flatBoost === 0 ? 'ratioBoost' : 'flatBoost';
            const gv = g[field];
            const sv = s[field];
            if (gv !== 0) deltaPct = ((sv - gv) / Math.abs(gv)) * 100;
            const equal = deltaPct == null ? sv === gv : Math.abs(deltaPct) < BUFF_MATCH_TOLERANCE_PCT;
            verdict = equal ? 'match' : 'magnitude';
        }
        return {
            uniqueHrid: hrid,
            name: buffName(hrid),
            typeHrid: g?.typeHrid || s?.typeHrid || null,
            game: g,
            sim: s,
            verdict,
            deltaPct,
        };
    });

    const rank = { missing: 0, magnitude: 1, extra: 2, match: 3 };
    rows.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) || a.name.localeCompare(b.name));
    return rows;
}

/**
 * Wrap a discrepancy log and the current snapshot in the export envelope.
 * @param {Array<Object>} entries - Recorded discrepancy records, newest last
 * @param {Object|null} current - The comparison currently on screen
 * @param {number} exportedAt - A timestamp (the caller owns the clock)
 * @returns {Object}
 */
export function buildExportPayload(entries, current, exportedAt) {
    return {
        format: 'toolasha-monster-stat-check',
        version: 1,
        exportedAt,
        current: current || null,
        entries: entries || [],
    };
}
