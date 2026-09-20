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

/** Buff types per metric: the non-Fury pool and the Fury pool. */
const BUFF_TYPES = {
    accuracy: { other: '/buff_types/accuracy', fury: '/buff_types/fury_accuracy' },
    damage: { other: '/buff_types/damage', fury: '/buff_types/fury_damage' },
};

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
export const NON_DISCRIMINATING_REASONS = ['noFury', 'noOtherBuff', 'gapTooSmall', 'flatBoost', 'noData', 'duplicate'];

/** Plain-language names for those reasons. */
export const REASON_LABELS = {
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
 * Sum the ratio and flat boosts of one buff type across a live buff map.
 *
 * Summed, not maxed, because that is what the engine's buff index does: every
 * active buff of a type contributes its `ratioBoost` to one total which is
 * applied once.
 *
 * @param {Object} combatBuffMap - A unit's live `combatBuffMap`
 * @param {string} typeHrid - The buff type to total
 * @returns {{ratio: number, flat: number}} The totals
 */
export function sumBoost(combatBuffMap, typeHrid) {
    let ratio = 0;
    let flat = 0;
    for (const buff of Object.values(combatBuffMap || {})) {
        if (buff?.typeHrid !== typeHrid) continue;
        ratio += Number(buff.ratioBoost) || 0;
        flat += Number(buff.flatBoost) || 0;
    }
    return { ratio, flat };
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
    const types = BUFF_TYPES[metric];
    const otherBoost = sumBoost(unit?.combatBuffMap, types.other);
    const furyBoost = sumBoost(unit?.combatBuffMap, types.fury);
    const other = otherBoost.ratio;
    const fury = furyBoost.ratio;

    const styles = [];
    for (const style of STYLES[metric]) {
        const sub = evaluateStyle({ metric, style, combatDetails, other, fury });
        if (sub) styles.push(sub);
    }

    const base = { metric, other, fury, styles, discriminating: false, outcome: null, reason: null, signature: null };

    if (!styles.length) return { ...base, reason: 'noData' };
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
    return { accuracy: readMetric('accuracy', unit), damage: readMetric('damage', unit) };
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
        version: 1,
        startedAt: null,
        updatedAt: null,
        accuracy: metric('accuracy'),
        damage: metric('damage'),
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
    return { metrics, audit: safe.audit || [], updatedAt: safe.updatedAt, startedAt: safe.startedAt };
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
