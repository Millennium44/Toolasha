/**
 * Fury stacking check — is the Fury buff additive with the other damage and
 * accuracy buffs, or multiplicative on top of them?
 *
 * ## The dispute
 *
 * The sim engine gives Fury its own factor
 * (`combat-sim/engine/combat-unit.js`): an accuracy rating is
 * `base × (1 + d) × (1 + f)`, where `d` is the summed ratio boost of
 * `/buff_types/accuracy` and `f` that of `/buff_types/fury_accuracy`, and the
 * same shape repeats for damage and for every style. Another simulator claims
 * the game pools the two instead — `base × (1 + d + f)`. One hand reading
 * favoured our form, which is one observation, so this measures it on every
 * reading the wire offers and keeps score.
 *
 * ## Why the game can settle it without the sim
 *
 * A `battle_unit_fetched` (and each `new_battle` player entry) carries the
 * unit's fully-resolved `combatDetails` *and* the ingredients the formula is
 * built from: the boosted `attackLevel`/`meleeLevel`/… and the gear ratios in
 * `combatStats`. So `base = (10 + level) × (1 + gearRatio)` is readable
 * straight off the same message as the answer, and the two predictions can be
 * compared against the game's own number without building anything. Nothing
 * here depends on the sim being right about gear, levels or buffs — only on
 * the game reporting its own inputs, which is the weakest assumption available.
 *
 * ## The constraint that makes or breaks this
 *
 * **The two formulas agree whenever either term is zero.** `(1 + d)(1 + f)`
 * minus `(1 + d + f)` is `d × f`, so a reading with no Fury stacks, or with no
 * other accuracy/damage buff, matches both models exactly and says nothing at
 * all. A panel reporting "40 of 40 match" off forty zero-Fury readings would be
 * worse than no panel. So every reading carries its predicted gap
 * `base × d × f`, and only a gap wide enough that a single integer-rounded
 * value cannot satisfy both models — {@link MIN_GAP_UNITS} — is counted as
 * evidence. Everything else is counted too, separately, under the reason it
 * could not discriminate.
 *
 * ## Accuracy and damage are graded apart
 *
 * They are separate expressions in the engine and separate buff types in the
 * game; they could in principle disagree, and collapsing them would hide it.
 *
 * ## Why styles are a breakdown and not a multiplier on the sample
 *
 * One snapshot resolves five accuracy ratings and six max damages, all from the
 * *same* `d` and `f`. Counting them as eleven independent readings would inflate
 * every interval elevenfold. So a snapshot is one reading per metric — decided
 * multiplicative only if every discriminating style says so — and the per-style
 * counts sit underneath as a breakdown, where a magic build disagreeing with a
 * melee one would show.
 */

/** Ratio boosts below this are treated as absent. */
const EPSILON = 1e-9;

/**
 * How far a prediction may sit from the game's number and still be called a
 * match. The game reports these ratings rounded, so a whole unit has to be
 * forgiven; anything looser would start matching both models at once.
 */
export const MATCH_TOLERANCE = 1;

/**
 * The smallest predicted gap between the two models that counts as evidence.
 *
 * Three units against a one-unit tolerance each side: the two acceptance
 * windows cannot overlap, so at most one model can match, with a unit of margin
 * left over for the rounding we cannot see.
 */
export const MIN_GAP_UNITS = 3;

/** Discriminating readings needed per metric before the verdict says anything. */
export const MIN_READINGS = 20;

/**
 * How far the Wilson interval has to clear the middle before the verdict names
 * a model.
 *
 * Not 0.95: the quantity being estimated is not really a proportion at all —
 * the game applies one formula, so a clean sample is all one side and the
 * interval's width is only the sample's smallness. Twenty unanimous readings
 * put the Wilson lower bound at 0.84, which is as sure as twenty of anything
 * gets. What the bar is actually there to catch is a sample that *contradicts
 * itself*: one dissenting reading in twenty drops the bound below this and the
 * verdict refuses, which is the right answer, because a deterministic formula
 * cannot be both.
 */
export const DECIDE_BOUND = 0.8;

/** The most per-reading audit rows kept for hand-checking. */
export const MAX_AUDIT_ROWS = 30;

/** How many reading signatures are remembered, to keep repeats out of the count. */
export const MAX_SEEN_SIGNATURES = 500;

/** The two metrics, graded separately. */
export const METRICS = ['accuracy', 'damage'];

/**
 * Buff identities per metric: the non-Fury pool, and the two ways a Fury entry
 * can name itself.
 *
 * `/buff_types/fury_accuracy` is the **engine's** type. It is synthesized in
 * `combat-sim/engine/combat-unit.js` (`updateFuryBuffs`) and that is the only
 * place in this codebase the value is ever produced — nothing reads it off the
 * wire. What a live `combatBuffMap` states is an entry keyed by its *unique*
 * hrid, `/buff_uniques/fury_accuracy`, and the stat-check panel's fold (which
 * lists only entries whose `typeHrid` the engine knows) has been seen naming
 * both "fury accuracy" and "fury damage" off a live player sheet while this
 * check, keyed on the engine type alone, found no Fury at all in the same
 * message. So a Fury entry is recognised by **either** name, and an entry
 * recognised as Fury is kept out of the other pool whatever type it declares —
 * otherwise a Fury entry carrying the plain accuracy type would be counted as
 * `d` as well, and the two models compared using the same number twice.
 */
const BUFF_TYPES = {
    accuracy: { other: '/buff_types/accuracy', fury: '/buff_types/fury_accuracy' },
    damage: { other: '/buff_types/damage', fury: '/buff_types/fury_damage' },
};

/** Readings to sit through before "no Fury in any of them" is called a fault. */
export const FURY_ALARM_READINGS = 10;

/** The most distinct buff identities remembered for the diagnosis. */
export const MAX_OBSERVED_IDENTITIES = 40;

/** The tally shape. A tally written in an older shape is dropped, not merged. */
export const TALLY_VERSION = 2;

/**
 * `[combatDetails key, level field, combatStats ratio field]` per style, mirroring
 * the engine's expressions. Defensive has a max damage and no accuracy rating.
 */
const TERMS = {
    accuracy: {
        stab: ['stabAccuracyRating', 'attackLevel', 'stabAccuracy'],
        slash: ['slashAccuracyRating', 'attackLevel', 'slashAccuracy'],
        smash: ['smashAccuracyRating', 'attackLevel', 'smashAccuracy'],
        ranged: ['rangedAccuracyRating', 'attackLevel', 'rangedAccuracy'],
        magic: ['magicAccuracyRating', 'attackLevel', 'magicAccuracy'],
    },
    damage: {
        stab: ['stabMaxDamage', 'meleeLevel', 'stabDamage'],
        slash: ['slashMaxDamage', 'meleeLevel', 'slashDamage'],
        smash: ['smashMaxDamage', 'meleeLevel', 'smashDamage'],
        ranged: ['rangedMaxDamage', 'rangedLevel', 'rangedDamage'],
        magic: ['magicMaxDamage', 'magicLevel', 'magicDamage'],
        defensive: ['defensiveMaxDamage', 'defenseLevel', 'defensiveDamage'],
    },
};

/** Styles per metric, in the order the breakdown lists them. */
export const STYLES = {
    accuracy: Object.keys(TERMS.accuracy),
    damage: Object.keys(TERMS.damage),
};

/** Why a reading could not discriminate, in the order the panel lists them. */
export const NON_DISCRIMINATING_REASONS = [
    'noBuffMap',
    'noFury',
    'noOtherBuff',
    'gapTooSmall',
    'flatBoost',
    'noData',
    'duplicate',
];

/** Plain-language names for those reasons. */
export const REASON_LABELS = {
    noBuffMap: 'The snapshot carried no buffs at all — nothing to read Fury from',
    noFury: 'No Fury stacks up — both models agree exactly',
    noOtherBuff: 'No other buff of that type — both models agree exactly',
    gapTooSmall: `Both models within ${MIN_GAP_UNITS} units of each other — rounding hides the difference`,
    flatBoost: 'A flat boost on the same buff type — no model term for it',
    noData: 'The snapshot did not carry the numbers',
    duplicate: 'Same buffs and same numbers as a reading already counted',
};

/** The outcomes a discriminating reading can have. */
export const OUTCOMES = ['multiplicative', 'additive', 'neither', 'mixed'];

/**
 * Whether one buff entry is Fury's effect on a metric.
 *
 * Either name settles it: the engine's synthetic `typeHrid`, or a unique hrid
 * whose last segment is Fury's and names this metric (`fury_accuracy`,
 * `fury_damage`). Named rather than typed, because the type is the half of the
 * pair this codebase invents and the wire is the half that decides.
 *
 * @param {string} identity - The entry's unique hrid (or its map key)
 * @param {string} typeHrid - The entry's buff type
 * @param {string} metric - `'accuracy'` or `'damage'`
 * @returns {boolean} Whether it is Fury's
 */
export function isFuryEntry(identity, typeHrid, metric) {
    if (typeHrid === BUFF_TYPES[metric]?.fury) return true;
    const segment = String(identity || '')
        .split('/')
        .pop();
    return segment.startsWith('fury') && segment.includes(metric);
}

/**
 * One metric's two pools, totalled off a live buff map in one pass.
 *
 * A Fury entry goes to the Fury pool and nowhere else, however it types itself;
 * everything else of the metric's plain type goes to the other pool.
 *
 * Summed, not maxed, because that is what the engine's buff index does: every
 * active buff of a type contributes its `ratioBoost` to one total, applied
 * once.
 *
 * @param {Object} combatBuffMap - A unit's live `combatBuffMap`
 * @param {string} metric - `'accuracy'` or `'damage'`
 * @returns {{other: {ratio: number, flat: number}, fury: {ratio: number, flat: number},
 *   entries: number, furyEntries: number}} The pools, and what they were read from
 */
export function poolBoosts(combatBuffMap, metric) {
    const types = BUFF_TYPES[metric];
    const other = { ratio: 0, flat: 0 };
    const fury = { ratio: 0, flat: 0 };
    let entries = 0;
    let furyEntries = 0;
    for (const [key, buff] of Object.entries(combatBuffMap || {})) {
        entries += 1;
        const identity = buff?.uniqueHrid || key;
        const isFury = isFuryEntry(identity, buff?.typeHrid, metric);
        let pool = null;
        if (isFury) pool = fury;
        else if (buff?.typeHrid === types.other) pool = other;
        if (!pool) continue;
        if (isFury) furyEntries += 1;
        pool.ratio += Number(buff?.ratioBoost) || 0;
        pool.flat += Number(buff?.flatBoost) || 0;
    }
    return { other, fury, entries, furyEntries };
}

/**
 * What a snapshot's buff map actually held, kept so a run of zero
 * discriminating readings can say *why*.
 *
 * "Fury was never up" and "Fury is never being found" produce an identical
 * tally otherwise, and they mean opposite things: the first is a quiet zone,
 * the second is this check being broken. The identities come with it, because
 * the only way to tell a renamed buff from an absent one is to read the names
 * the wire is using.
 *
 * @param {Object} combatBuffMap - A unit's live `combatBuffMap`
 * @returns {{entries: number, fury: number, types: string[], uniques: string[]}} The sighting
 */
export function observeBuffs(combatBuffMap) {
    const types = [];
    const uniques = [];
    let fury = 0;
    let entries = 0;
    for (const [key, buff] of Object.entries(combatBuffMap || {})) {
        entries += 1;
        const identity = String(buff?.uniqueHrid || key);
        uniques.push(identity);
        if (buff?.typeHrid) types.push(String(buff.typeHrid));
        if (METRICS.some((metric) => isFuryEntry(identity, buff?.typeHrid, metric))) fury += 1;
    }
    return { entries, fury, types, uniques };
}

/**
 * Both models' predictions for one style, against the game's own number.
 *
 * @param {Object} params - Inputs
 * @param {string} params.metric - `'accuracy'` or `'damage'`
 * @param {string} params.style - A style key from {@link STYLES}
 * @param {Object} params.combatDetails - The unit's resolved `combatDetails`
 * @param {number} params.other - Summed non-Fury ratio boost (`d`)
 * @param {number} params.fury - Summed Fury ratio boost (`f`)
 * @returns {Object|null} The sub-reading, or null when the fields are missing
 */
export function evaluateStyle({ metric, style, combatDetails, other, fury }) {
    const terms = TERMS[metric]?.[style];
    if (!terms) return null;
    const [key, levelField, ratioField] = terms;
    const game = Number(combatDetails?.[key]);
    const level = Number(combatDetails?.[levelField]);
    const gearRatio = Number(combatDetails?.combatStats?.[ratioField]);
    if (!Number.isFinite(game) || !Number.isFinite(level) || !Number.isFinite(gearRatio)) return null;

    const plainBase = (10 + level) * (1 + gearRatio);
    if (!(plainBase > 0)) return null;

    // A bulwark adds the defensive max damage into the smash one *after* both
    // have taken the same factor, so the smash base is the sum of the two. The
    // correction is a base correction and carries no preference between the
    // models — but left out, a bulwark user's smash row would land in "neither"
    // and read as both models being wrong.
    let base = plainBase;
    let bulwark = false;
    if (metric === 'damage' && style === 'smash') {
        const defensive = evaluateBase(combatDetails, 'damage', 'defensive');
        if (defensive > 0) {
            const plain = decide(plainBase, game, other, fury);
            if (plain.matched === 'neither') {
                const combined = decide(plainBase + defensive, game, other, fury);
                if (combined.matched === 'multiplicative' || combined.matched === 'additive') {
                    base = plainBase + defensive;
                    bulwark = true;
                }
            }
        }
    }

    const verdict = decide(base, game, other, fury);
    return {
        metric,
        style,
        other,
        fury,
        base,
        game,
        bulwark,
        ...verdict,
    };
}

/**
 * The unfactored base of one style's expression, for the bulwark correction.
 * @param {Object} combatDetails - Resolved combat details
 * @param {string} metric - `'accuracy'` or `'damage'`
 * @param {string} style - A style key
 * @returns {number} The base, or 0 when it cannot be read
 */
function evaluateBase(combatDetails, metric, style) {
    const terms = TERMS[metric]?.[style];
    if (!terms) return 0;
    const [, levelField, ratioField] = terms;
    const level = Number(combatDetails?.[levelField]);
    const gearRatio = Number(combatDetails?.combatStats?.[ratioField]);
    if (!Number.isFinite(level) || !Number.isFinite(gearRatio)) return 0;
    const base = (10 + level) * (1 + gearRatio);
    return base > 0 ? base : 0;
}

/**
 * Score one base against the game's number under both models.
 * @param {number} base - The unfactored expression
 * @param {number} game - The game's resolved value
 * @param {number} other - `d`
 * @param {number} fury - `f`
 * @returns {Object} Predictions, errors, the gap and which model matched
 */
function decide(base, game, other, fury) {
    const multiplicative = base * (1 + other) * (1 + fury);
    const additive = base * (1 + other + fury);
    const gap = Math.abs(multiplicative - additive);
    const errorMultiplicative = multiplicative - game;
    const errorAdditive = additive - game;
    const hitMultiplicative = Math.abs(errorMultiplicative) <= MATCH_TOLERANCE;
    const hitAdditive = Math.abs(errorAdditive) <= MATCH_TOLERANCE;
    let matched = 'neither';
    if (hitMultiplicative && hitAdditive) matched = 'both';
    else if (hitMultiplicative) matched = 'multiplicative';
    else if (hitAdditive) matched = 'additive';
    return { multiplicative, additive, gap, errorMultiplicative, errorAdditive, matched };
}

/**
 * One metric's reading off one snapshot: every style scored, then one verdict.
 *
 * A snapshot is one reading per metric rather than one per style because every
 * style shares the same `d` and `f` — see the module note. The reading is
 * discriminating when at least one style's gap clears {@link MIN_GAP_UNITS},
 * and its outcome is the agreement of those styles: unanimous or `mixed`.
 *
 * @param {string} metric - `'accuracy'` or `'damage'`
 * @param {Object} unit - A unit with `combatDetails` and `combatBuffMap`
 * @returns {Object} The metric reading
 */
export function readMetric(metric, unit) {
    const combatDetails = unit?.combatDetails;
    const pool = poolBoosts(unit?.combatBuffMap, metric);
    const otherBoost = pool.other;
    const furyBoost = pool.fury;
    const other = otherBoost.ratio;
    const fury = furyBoost.ratio;

    const styles = [];
    for (const style of STYLES[metric]) {
        const sub = evaluateStyle({ metric, style, combatDetails, other, fury });
        if (sub) styles.push(sub);
    }

    const base = { metric, other, fury, styles, discriminating: false, outcome: null, reason: null, signature: null };

    if (!styles.length) return { ...base, reason: 'noData' };
    // Separated from `noFury` deliberately: a snapshot carrying no buff map at
    // all is one this check cannot read, and filing it under "Fury was down" is
    // the difference between a quiet zone and a broken reader
    if (!pool.entries) return { ...base, reason: 'noBuffMap' };
    if (Math.abs(fury) < EPSILON) return { ...base, reason: 'noFury' };
    if (Math.abs(other) < EPSILON) return { ...base, reason: 'noOtherBuff' };
    // A flat boost of the same type has no term in either model, so a reading
    // carrying one cannot tell the models apart — it can only fail both
    if (Math.abs(otherBoost.flat) > EPSILON || Math.abs(furyBoost.flat) > EPSILON) {
        return { ...base, reason: 'flatBoost' };
    }

    const deciding = styles.filter((sub) => sub.gap >= MIN_GAP_UNITS);
    if (!deciding.length) return { ...base, reason: 'gapTooSmall' };

    // 'both' cannot survive a gap this wide — the acceptance windows are
    // disjoint by construction. If it somehow does, the reading is not telling
    // the models apart and must not be counted as if it were
    const votes = deciding.map((sub) => sub.matched);
    if (votes.every((vote) => vote === 'both')) return { ...base, reason: 'gapTooSmall' };

    // Unanimity or nothing. A snapshot whose styles disagree is `mixed`, which
    // is a finding of its own and is never folded into either side's count
    let outcome = 'mixed';
    for (const candidate of ['multiplicative', 'additive', 'neither']) {
        if (votes.every((vote) => vote === candidate)) outcome = candidate;
    }

    return {
        ...base,
        discriminating: true,
        outcome,
        deciding,
        signature: signatureOf(metric, other, fury, deciding),
    };
}

/**
 * A reading's fingerprint, so the same wave's numbers seen twice are not
 * counted twice.
 *
 * Auto-fighting a zone sends a `new_battle` per wave, and consecutive waves at
 * the same Fury stack count carry identical numbers. Those are one observation
 * restated, not twenty, and counting them would shrink the interval without
 * learning anything.
 *
 * @param {string} metric - The metric
 * @param {number} other - `d`
 * @param {number} fury - `f`
 * @param {Array<Object>} deciding - The discriminating sub-readings
 * @returns {string} The signature
 */
export function signatureOf(metric, other, fury, deciding) {
    const numbers = deciding.map((sub) => `${sub.style}:${sub.game}:${sub.base.toFixed(3)}`).join(',');
    return `${metric}|${other.toFixed(8)}|${fury.toFixed(8)}|${numbers}`;
}

/**
 * Both metrics read off one unit snapshot.
 * @param {Object} unit - A unit with `combatDetails` and `combatBuffMap`
 * @returns {{accuracy: Object, damage: Object}} The readings
 */
export function readUnit(unit) {
    return {
        accuracy: readMetric('accuracy', unit),
        damage: readMetric('damage', unit),
        observed: observeBuffs(unit?.combatBuffMap),
    };
}

/** A fresh, empty tally. @returns {Object} The tally */
export function emptyTally() {
    const styleCounts = (metric) =>
        Object.fromEntries(
            STYLES[metric].map((style) => [
                style,
                { discriminating: 0, multiplicative: 0, additive: 0, neither: 0, both: 0 },
            ])
        );
    const metric = (name) => ({
        readings: 0,
        discriminating: 0,
        multiplicative: 0,
        additive: 0,
        neither: 0,
        mixed: 0,
        reasons: Object.fromEntries(NON_DISCRIMINATING_REASONS.map((reason) => [reason, 0])),
        styles: styleCounts(name),
    });
    return {
        version: TALLY_VERSION,
        startedAt: null,
        updatedAt: null,
        accuracy: metric('accuracy'),
        damage: metric('damage'),
        observed: { units: 0, withBuffMap: 0, withFury: 0, types: {}, uniques: [] },
        audit: [],
        seen: [],
    };
}

/**
 * Fold one snapshot's readings into a tally, in place.
 *
 * In place because this runs on every wave of a live stream; the caller owns
 * the tally.
 *
 * @param {Object} tally - The tally to add to
 * @param {{accuracy: Object, damage: Object}} readings - From {@link readUnit}
 * @param {number} [now] - Clock, for the timestamps
 * @returns {Object} The same tally
 */
export function foldReading(tally, readings, now = Date.now()) {
    if (!tally || !readings) return tally;
    if (tally.startedAt === null) tally.startedAt = now;
    tally.updatedAt = now;
    foldObservation(tally, readings.observed);

    if (!Array.isArray(tally.seen)) tally.seen = [];
    const seen = new Set(tally.seen);
    for (const metric of METRICS) {
        const reading = readings[metric];
        if (!reading) continue;
        const bucket = tally[metric];
        if (!bucket) continue;
        bucket.readings += 1;

        if (!reading.discriminating) {
            const reason = reading.reason;
            if (reason && reason in bucket.reasons) bucket.reasons[reason] += 1;
            continue;
        }
        if (seen.has(reading.signature)) {
            bucket.reasons.duplicate += 1;
            continue;
        }
        seen.add(reading.signature);
        tally.seen.push(reading.signature);
        if (tally.seen.length > MAX_SEEN_SIGNATURES) tally.seen.splice(0, tally.seen.length - MAX_SEEN_SIGNATURES);

        bucket.discriminating += 1;
        bucket[reading.outcome] = (bucket[reading.outcome] || 0) + 1;

        for (const sub of reading.deciding) {
            const styleBucket = bucket.styles[sub.style];
            if (!styleBucket) continue;
            styleBucket.discriminating += 1;
            styleBucket[sub.matched] = (styleBucket[sub.matched] || 0) + 1;
        }

        tally.audit.unshift(auditRow(reading, now));
        if (tally.audit.length > MAX_AUDIT_ROWS) tally.audit.length = MAX_AUDIT_ROWS;
    }
    return tally;
}

/**
 * Fold one snapshot's buff sighting into the tally's diagnosis, in place.
 *
 * @param {Object} tally - The tally
 * @param {{entries: number, fury: number, types: string[], uniques: string[]}} [observed] - A sighting
 * @returns {void}
 */
function foldObservation(tally, observed) {
    if (!observed) return;
    if (!tally.observed) tally.observed = { units: 0, withBuffMap: 0, withFury: 0, types: {}, uniques: [] };
    const seen = tally.observed;
    seen.units += 1;
    if (observed.entries > 0) seen.withBuffMap += 1;
    if (observed.fury > 0) seen.withFury += 1;
    for (const type of observed.types) {
        if (seen.types[type] === undefined && Object.keys(seen.types).length >= MAX_OBSERVED_IDENTITIES) continue;
        seen.types[type] = (seen.types[type] || 0) + 1;
    }
    for (const unique of observed.uniques) {
        if (seen.uniques.includes(unique)) continue;
        if (seen.uniques.length >= MAX_OBSERVED_IDENTITIES) break;
        seen.uniques.push(unique);
    }
}

/**
 * The stored audit row for one discriminating reading — the widest-gap style,
 * which is the one carrying the reading's information.
 * @param {Object} reading - A discriminating metric reading
 * @param {number} now - Clock
 * @returns {Object} The row
 */
function auditRow(reading, now) {
    const widest = reading.deciding.reduce((best, sub) => (sub.gap > best.gap ? sub : best), reading.deciding[0]);
    return {
        at: now,
        metric: reading.metric,
        style: widest.style,
        outcome: reading.outcome,
        other: round(reading.other, 6),
        fury: round(reading.fury, 6),
        game: round(widest.game, 3),
        multiplicative: round(widest.multiplicative, 3),
        additive: round(widest.additive, 3),
        errorMultiplicative: round(widest.errorMultiplicative, 3),
        errorAdditive: round(widest.errorAdditive, 3),
        gap: round(widest.gap, 3),
        bulwark: Boolean(widest.bulwark),
        styleCount: reading.deciding.length,
    };
}

/**
 * Round for storage, so a float does not carry sixteen meaningless digits into
 * IndexedDB and back out into a panel.
 * @param {number} value - The number
 * @param {number} places - Decimal places
 * @returns {number|null} Rounded, or null
 */
function round(value, places) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

/**
 * Read a tally back as something a panel can print, and say what it means.
 *
 * @param {Object} tally - A tally
 * @param {Function} wilsonInterval - The interval function, injected so this
 *   module stays free of the sim engine in tests
 * @returns {Object} Summary
 */
export function summarize(tally, wilsonInterval) {
    const safe = tally || emptyTally();
    const observed = safe.observed || emptyTally().observed;
    const metrics = {};
    for (const metric of METRICS) {
        const bucket = safe[metric] || emptyTally()[metric];
        const decided = (bucket.multiplicative || 0) + (bucket.additive || 0);
        const interval = wilsonInterval(bucket.multiplicative || 0, decided);
        const nonDiscriminating = NON_DISCRIMINATING_REASONS.reduce(
            (sum, reason) => sum + (bucket.reasons?.[reason] || 0),
            0
        );
        const summary = {
            metric,
            readings: bucket.readings || 0,
            discriminating: bucket.discriminating || 0,
            nonDiscriminating,
            multiplicative: bucket.multiplicative || 0,
            additive: bucket.additive || 0,
            neither: bucket.neither || 0,
            mixed: bucket.mixed || 0,
            decided,
            fraction: decided > 0 ? (bucket.multiplicative || 0) / decided : null,
            low: interval.low,
            high: interval.high,
            reasons: NON_DISCRIMINATING_REASONS.map((reason) => ({
                reason,
                label: REASON_LABELS[reason],
                count: bucket.reasons?.[reason] || 0,
            })),
            styles: STYLES[metric].map((style) => ({
                style,
                ...(bucket.styles?.[style] || { discriminating: 0, multiplicative: 0, additive: 0, neither: 0 }),
            })),
        };
        summary.verdict = verdictFor(summary);
        metrics[metric] = summary;
    }
    return {
        metrics,
        observed,
        health: healthOf(observed),
        audit: safe.audit || [],
        updatedAt: safe.updatedAt,
        startedAt: safe.startedAt,
    };
}

/**
 * The plain-language reading of one metric's tally.
 *
 * Deliberately reluctant, and loudest when it is confused: a discriminating
 * reading that matches *neither* model means the expression has a term neither
 * side of the argument has written down, which is a bigger finding than either
 * answer and must not be averaged away into a percentage.
 *
 * @param {Object} summary - One metric's summary
 * @returns {{text: string, decided: boolean}} Verdict
 */
export function verdictFor(summary) {
    const name = summary.metric === 'accuracy' ? 'Accuracy rating' : 'Max damage';
    const unexplained = (summary.neither || 0) + (summary.mixed || 0);

    if (unexplained > 0 && unexplained >= summary.discriminating / 2) {
        return {
            decided: false,
            text:
                `${name}: ${unexplained} of ${summary.discriminating} discriminating readings match neither model. ` +
                'Both formulas are wrong about this, or a term the check does not model (a flat boost, a level ' +
                'the snapshot reports differently, gear this reads wrong) is in the expression. No verdict.',
        };
    }

    if (summary.discriminating < MIN_READINGS) {
        return {
            decided: false,
            text:
                `${name}: ${summary.discriminating} of ${MIN_READINGS} discriminating readings. Not enough to say ` +
                'anything yet — fight with Fury up and another accuracy or damage buff running.',
        };
    }

    const caution =
        unexplained > 0
            ? ` ${unexplained} reading${unexplained === 1 ? '' : 's'} matched neither model, which is worth a look.`
            : '';
    const band = `${Math.round(summary.low * 100)}–${Math.round(summary.high * 100)}%`;

    if (summary.low > DECIDE_BOUND) {
        return {
            decided: true,
            text:
                `${name}: MULTIPLICATIVE. Fury is its own factor on top of the other buffs — ` +
                `${summary.multiplicative}/${summary.decided} decided readings, 95% CI ${band}. ` +
                `This is what the engine already does.${caution}`,
        };
    }
    if (summary.high < 1 - DECIDE_BOUND) {
        return {
            decided: true,
            text:
                `${name}: ADDITIVE. Fury pools with the other buffs — ` +
                `${summary.additive}/${summary.decided} decided readings, 95% CI ${band}. ` +
                `The engine's separate factor is wrong here.${caution}`,
        };
    }
    return {
        decided: false,
        text:
            `${name}: readings disagree — ${summary.multiplicative} multiplicative, ${summary.additive} additive ` +
            `out of ${summary.decided} decided (95% CI ${band}). A deterministic formula cannot do both, so ` +
            `something else differs between the readings.${caution}`,
    };
}

/**
 * Whether the check is working, as distinct from whether it has learned
 * anything yet.
 *
 * The failure this exists for: the feature ran for twenty-eight snapshots,
 * filed every one under "no Fury up", and printed a tidy zero — which is
 * exactly what a quiet zone looks like, and exactly what a Fury lookup matching
 * nothing looks like. Reading counts alone cannot tell the two apart, so the
 * sighting counts are kept and read here, and a run this long with Fury never
 * once seen is reported as a fault rather than as patience.
 *
 * @param {{units: number, withBuffMap: number, withFury: number, types: Object, uniques: string[]}} observed
 *   The tally's sighting counts
 * @returns {{ok: boolean, text: string}} The diagnosis
 */
export function healthOf(observed) {
    const units = observed?.units || 0;
    const withBuffMap = observed?.withBuffMap || 0;
    const withFury = observed?.withFury || 0;
    const uniques = observed?.uniques || [];

    if (!units) return { ok: true, text: 'No snapshots read yet. Fight with Fury up and this fills in.' };

    if (withFury > 0) {
        return {
            ok: true,
            text: `Fury found in ${withFury} of ${units} snapshots — the check is reading the buff map.`,
        };
    }

    if (units < FURY_ALARM_READINGS) {
        return { ok: true, text: `No Fury in the ${units} snapshots so far — too few to mean anything yet.` };
    }

    if (!withBuffMap) {
        return {
            ok: false,
            text:
                `NOT READING BUFFS: none of ${units} snapshots carried a buff map at all, so every reading is ` +
                'non-discriminating by construction and the counts below mean nothing. The messages being watched ' +
                'are not the ones carrying your live buffs.',
        };
    }

    const names = uniques
        .map((hrid) => String(hrid).split('/').pop())
        .slice(0, 12)
        .join(', ');
    return {
        ok: false,
        text:
            `NOT FINDING FURY: ${units} snapshots, ${withBuffMap} of them carrying buffs, and no Fury effect ` +
            'recognised in any of them. Either Fury was genuinely never up for the whole run, or this check does ' +
            `not recognise what the game is calling it. Buffs seen: ${names || 'none'}.`,
    };
}
