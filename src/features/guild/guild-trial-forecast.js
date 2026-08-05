/**
 * What tier a trial should reach, before or during the hour.
 *
 * ## The tier ladder is not a fit any more
 *
 * Everything this feature projected used to rest on a growth factor measured
 * from whatever tiers happened to be observed. For a **combat** trial that is no
 * longer necessary: the game's own data carries the trial's monsters
 * (`guildTrialDetailMap` → `combatMonsterDetailMap`) and its own HP formula
 * turns out to explain the recorded numbers to the digit.
 *
 * A unit's health in this game is `10 × (10 + level)` before bonuses, and the
 * trial monsters are ordinary Lv.100 sheets: Trial Chameleon's 550,000 is
 * exactly `10 × (10 + 100) × 500`. A tier is fought at
 * {@link module:./guild-trials-math.levelFromTier}, and each signed-up
 * participant adds 1% (the guide's own rule). Against the recorded run:
 *
 * ```
 * T2, Lv.110, 3 signed up:  550,000 × 120/110 × 1.03 = 618,000   observed 618,000
 * T3, Lv.120, 3 signed up:  550,000 × 130/110 × 1.03 = 669,500   observed 669,500
 * ```
 *
 * Two independent tiers, exact, with the participant count taken from the same
 * export's "Signed Up 3/56". So {@link tierMonsterHp} is *derived*, and where a
 * tier has actually been read off the panel the reading still wins — a rule that
 * agrees with the observations everywhere it has been checked is still a rule,
 * and the observation is the thing itself.
 *
 * ## Skilling has no such luck, and says so
 *
 * A skilling trial's pool size per tier is in no client data this can find, and
 * a member's *work rate* cannot be derived from their skill level without the
 * action's own timing — which the trial does not state. So the skilling forecast
 * is built on what has been measured: the pool sizes actually seen (fitted
 * across tiers by `estimateGrowthPerTier`) and the fill rate actually read off
 * the bar. Before a skilling trial starts there is nothing honest to say, and
 * {@link forecastSkillingTier} says that rather than producing a number.
 *
 * ## What a forecast is allowed to be built on
 *
 * Three sources, ranked, and every result carries which one it used:
 *
 * 1. **Measured** — the party's own DPS or fill rate, off this trial.
 * 2. **Estimated** — summed from the loadouts captured for the members who
 *    signed up, for a combat trial that has not started. Rough, and captioned.
 * 3. **Nothing** — reported as unavailable, never as zero.
 */

import {
    baseWorkFromObservations,
    estimateGrowthPerTier,
    levelFromTier,
    projectTierTotal,
    tierPoolWork,
    TRIAL_MAX_TIER,
} from './guild-trials-math.js';

/** The constant in the game's own health formula, `10 × (10 + level)` */
export const HEALTH_LEVEL_OFFSET = 10;

/** Level a trial monster's own sheet is written at */
export const MONSTER_BASE_LEVEL = 100;

/** How much one signed-up participant adds to monster health */
export const PARTICIPANT_HP_STEP = 0.01;

/**
 * When a trial boss reaches full enrage.
 *
 * Not a fight timer, which is what this file assumed and what the monster
 * sheets' `enrageTime` looks like at a glance. The mechanic is a stacking buff:
 * one stack a minute to a maximum of ten, each worth +10% accuracy and +10%
 * damage, so at ten minutes the boss is hitting at double accuracy and double
 * damage — and it goes no further.
 *
 * That is pressure, not a wall. A fight that runs long gets harder and more
 * dangerous; it does not end, and a party that can out-heal it clears the tier
 * eventually. So nothing here stops a walk at ten minutes; it says the boss will
 * be fully enraged and that deaths may cost more time than the projection knows
 * about.
 */
export const ENRAGE_MS = 10 * 60_000;

/**
 * The health one tier's monsters have, all of them together.
 *
 * @param {Object} input - Inputs
 * @param {number} input.baseHp - The wave's health at the monsters' own Lv.100
 * @param {number} input.tier - The tier being fought
 * @param {number} [input.participants] - Members signed up
 * @returns {number|null} Health, or null on unusable input
 */
export function tierMonsterHp({ baseHp, tier, participants = 0 } = {}) {
    const level = levelFromTier(tier);
    if (!Number.isFinite(baseHp) || baseHp <= 0 || level === null) return null;

    const byLevel = (HEALTH_LEVEL_OFFSET + level) / (HEALTH_LEVEL_OFFSET + MONSTER_BASE_LEVEL);
    const byParty = 1 + PARTICIPANT_HP_STEP * Math.max(0, Number(participants) || 0);
    return baseHp * byLevel * byParty;
}

/**
 * The monsters a combat trial fights, from the game's own data.
 *
 * Read at runtime and never pinned here: the sheets are the game's, they change
 * when it rebalances, and a copy in this repository would be wrong silently.
 * Several spawns are normal — Trial Badger is two of the same monster and Trial
 * Swarm is four different ones — so the health that matters is the wave's total.
 *
 * @param {string} name - The trial's name or hrid, as the card or the record has it
 * @param {Object} clientData - `initClientData`
 * @returns {{hrid: string|null, monsters: Array<Object>, baseHp: number, count: number}|null} The wave
 */
export function trialWave(name, clientData) {
    const trials = clientData?.guildTrialDetailMap;
    const monsterMap = clientData?.combatMonsterDetailMap;
    if (!trials || !monsterMap) return null;

    const wanted = String(name || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
    if (!wanted) return null;

    const entry = Object.entries(trials).find(([hrid, detail]) => {
        const tail = String(hrid)
            .split('/')
            .pop()
            .replace(/[^a-z]/gi, '')
            .toLowerCase();
        const label = String(detail?.name || '')
            .toLowerCase()
            .replace(/[^a-z]/g, '');
        return tail === wanted || label === wanted || wanted.includes(tail) || (label && wanted.includes(label));
    });
    if (!entry) return null;

    const [hrid, detail] = entry;
    const hrids = detail?.monsterHrids || detail?.combatMonsterHrids || detail?.spawns || [];
    const monsters = [];
    let baseHp = 0;

    for (const monsterHrid of Array.isArray(hrids) ? hrids : []) {
        const id = typeof monsterHrid === 'string' ? monsterHrid : monsterHrid?.combatMonsterHrid;
        const sheet = monsterMap?.[id];
        if (!sheet) continue;

        const health = Number(sheet.combatDetails?.maxHitpoints ?? sheet.maxHitpoints);
        if (Number.isFinite(health) && health > 0) baseHp += health;
        monsters.push({ hrid: id, name: sheet.name || id, maxHitpoints: health });
    }

    return monsters.length ? { hrid, monsters, baseHp, count: monsters.length } : null;
}

/**
 * A rough damage estimate for a party, from the loadouts that have been captured.
 *
 * Deliberately crude and labelled as such. A real answer is the combat
 * simulator's, which needs a full unit on both sides and a worker to run it in;
 * what this does is add up what each member's own sheet says their auto-attack
 * is worth per second and call the result an estimate. It is here so that a
 * trial which has not started can say *something* honest about whether the party
 * is in the right order of magnitude, and it must never be presented as measured.
 *
 * @param {Array<Object>} loadouts - Snapshots from `guild-loadouts.js`
 * @returns {{dps: number|null, members: number}} The estimate and how many it covers
 */
export function estimatePartyDamage(loadouts) {
    let dps = 0;
    let members = 0;

    for (const loadout of loadouts || []) {
        const own = autoAttackDps(loadout?.stats);
        if (own === null) continue;
        dps += own;
        members += 1;
    }

    return { dps: members ? dps : null, members };
}

/**
 * One member's auto-attack damage per second, from their captured sheet.
 *
 * Exported so the per-player estimate and the party estimate are the same
 * arithmetic rather than two that can drift apart. The sheet's auto-attack
 * figure is a multiplier on the weapon's own damage, which is not on it, so this
 * is a shape rather than a number — every caller must say so.
 *
 * @param {Object} stats - A loadout's `stats`
 * @returns {number|null} Damage a second, or null when the sheet cannot say
 */
export function autoAttackDps(stats) {
    if (!stats) return null;

    // `attackInterval` is nanoseconds on the wire, as the recorded sheets show
    const intervalMs = Number(stats.attackInterval) / 1e6;
    const damage = Number(stats.autoAttackDamage);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(damage) || damage <= 0) return null;

    return (damage * 1000) / intervalMs;
}

/**
 * How far up the ladder a combat trial gets before the hour runs out.
 *
 * Walks tier by tier, spending the current tier's *remaining* health first and
 * each later tier's derived total after it. One thing stops the walk: the hour.
 * A fight that runs past ten minutes meets a fully enraged boss — see
 * {@link ENRAGE_MS} — which is reported as a caption rather than as an ending,
 * because the fight does not end.
 *
 * @param {Object} input - Inputs
 * @param {number} input.baseHp - The wave's Lv.100 health
 * @param {number} input.tier - The tier now in progress
 * @param {number} input.dps - Party damage per second
 * @param {number} input.timeLeftMs - Active time left in the trial
 * @param {number} [input.participants] - Members signed up
 * @param {number|null} [input.remainingInTier] - Health left on the current tier, when it is known
 * @param {Function} [input.observedTotal] - `(tier) => number|null`, a tier's total as actually read
 * @returns {{finalTier: number|null, tiersCleared: number, clears: Array<Object>, limitedBy: string,
 *   enragedFrom: number|null}|null} The projection, or null without a usable rate
 */
export function forecastCombatTier({
    baseHp,
    tier,
    dps,
    timeLeftMs,
    participants = 0,
    remainingInTier = null,
    observedTotal = null,
} = {}) {
    if (!Number.isFinite(tier) || !Number.isFinite(dps) || dps <= 0) return null;
    if (!Number.isFinite(timeLeftMs) || timeLeftMs < 0) return null;

    const totalFor = (candidate) => {
        // A tier actually seen beats a tier derived, always
        const seen = observedTotal?.(candidate);
        if (Number.isFinite(seen) && seen > 0) return seen;
        return tierMonsterHp({ baseHp, tier: candidate, participants });
    };

    const clears = [];
    let spentMs = 0;
    let current = tier;
    let need = Number.isFinite(remainingInTier) && remainingInTier > 0 ? remainingInTier : totalFor(tier);
    let limitedBy = 'time';
    /** The first tier whose fight runs past full enrage, if any */
    let enraged = null;

    while (current <= TRIAL_MAX_TIER) {
        if (!Number.isFinite(need) || need <= 0) {
            limitedBy = 'unknown-next-tier';
            break;
        }

        const takesMs = (need / dps) * 1000;
        // A fight this long meets a fully enraged boss — twice the accuracy and
        // twice the damage — which makes the tier dangerous rather than
        // impossible. Noted, and the walk carries on.
        if (takesMs > ENRAGE_MS) enraged = enraged ?? current;
        if (spentMs + takesMs > timeLeftMs) break;

        spentMs += takesMs;
        clears.push({ tier: current, atMs: spentMs, health: need });

        if (current === TRIAL_MAX_TIER) {
            limitedBy = 'ladder';
            break;
        }
        current += 1;
        need = totalFor(current);
    }

    return {
        finalTier: clears.length ? clears[clears.length - 1].tier : null,
        tiersCleared: clears.length,
        clears,
        limitedBy,
        enragedFrom: enraged,
    };
}

/**
 * The floor a success rate never falls through.
 *
 * Five per cent, confirmed by the player: the rate declines with the tier level
 * and then stops there. So a deep tier is *slow* — a twentieth of the actions
 * landing — and not impossible. Neither ladder has a wall on it: a skilling
 * trial degrades to the floor and a combat one to a fully enraged boss, and both
 * keep going. What ends either walk is the hour.
 */
export const SUCCESS_FLOOR = 0.05;

/**
 * A percentage as the game's footer writes it.
 * @param {string} text - e.g. `73.6%`
 * @returns {number|null} A fraction, or null
 */
function parsePercent(text) {
    const match = String(text ?? '').match(/(-?[\d.]+)\s*%/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value / 100 : null;
}

/**
 * How the player's own success rate falls as the tiers climb.
 *
 * Measured, from the footer the In Progress tab already shows and the personal
 * stats reader already captures. Across a watched trial one character's rate read
 * 73.6% at tier one, 65.6% at tier two and 57.6% at tier three — eight points a
 * tier, exactly, which is what a tier level rising ten against a fixed character
 * level does. That decline matters more than it looks: at four tiers out the same
 * player is contributing a third less than the current fill rate implies, so a
 * forecast that walks a flat rate promises tiers nobody reaches.
 *
 * Fitted linearly across whatever tiers have been observed, and only where there
 * are two — one tier is a reading, not a trend, and the caller is told to walk
 * flat and say so.
 *
 * @param {Object} personalByTier - tier → the footer's own label/value pairs
 * @returns {{atTier: number, rate: number, perTier: number|null, observations: number}|null} The fit
 */
export function successDecline(personalByTier) {
    const points = [];
    for (const [tier, stats] of Object.entries(personalByTier || {})) {
        const level = Number(tier);
        if (!Number.isFinite(level)) continue;

        const entry = Object.entries(stats || {}).find(([label]) => /success/i.test(label));
        const rate = entry ? parsePercent(entry[1]) : null;
        if (rate === null || rate <= 0) continue;
        points.push({ tier: level, rate });
    }
    if (!points.length) return null;

    points.sort((a, b) => a.tier - b.tier);
    const newest = points[points.length - 1];
    if (points.length < 2) {
        return { atTier: newest.tier, rate: newest.rate, perTier: null, observations: 1 };
    }

    // Least squares on the observations, which for the evenly spaced tiers this
    // sees is the same as the average step and is right when they are not
    const meanTier = points.reduce((sum, point) => sum + point.tier, 0) / points.length;
    const meanRate = points.reduce((sum, point) => sum + point.rate, 0) / points.length;
    let top = 0;
    let bottom = 0;
    for (const point of points) {
        top += (point.tier - meanTier) * (point.rate - meanRate);
        bottom += (point.tier - meanTier) ** 2;
    }

    const perTier = bottom > 0 ? top / bottom : null;
    return { atTier: newest.tier, rate: newest.rate, perTier, observations: points.length };
}

/**
 * The success rate a tier is expected to run at.
 * @param {Object|null} decline - From {@link successDecline}
 * @param {number} tier - The tier wanted
 * @returns {number|null} A fraction, or null when nothing was measured
 */
export function successAtTier(decline, tier) {
    if (!decline || !Number.isFinite(tier)) return null;
    if (!Number.isFinite(decline.perTier)) return Math.max(SUCCESS_FLOOR, decline.rate);
    return Math.max(SUCCESS_FLOOR, decline.rate + decline.perTier * (tier - decline.atTier));
}

/**
 * How far up the ladder a skilling trial gets.
 *
 * The same walk, on measured ground throughout: the pool sizes are the ones
 * actually observed (extrapolated between tiers by the growth fit the record
 * already keeps) and the rate is the one read off the bar. Without either, this
 * returns null — there is no client-data pool size to fall back on and no
 * verified way to turn a member's skill level into work per second, so a number
 * here would be invented.
 *
 * @param {Object} input - Inputs
 * @param {number} input.tier - The tier now in progress
 * @param {number} input.rate - Work per second
 * @param {number} input.timeLeftMs - Active time left
 * @param {Array<{tier: number, total: number}>} input.observations - Pool sizes seen
 * @param {number|null} [input.remainingInTier] - Work left in the current tier
 * @returns {{finalTier: number|null, tiersCleared: number, clears: Array<Object>, limitedBy: string}|null}
 *   The projection, or null when nothing has been measured
 */
export function forecastSkillingTier({
    tier,
    rate,
    timeLeftMs,
    observations = [],
    remainingInTier = null,
    participants = 0,
    decline = null,
} = {}) {
    if (!Number.isFinite(tier) || !Number.isFinite(rate) || rate <= 0) return null;
    if (!Number.isFinite(timeLeftMs) || timeLeftMs < 0) return null;

    // Derived first, from the rule the observed pools reproduce exactly — one
    // tier seen anywhere on the ladder gives the whole of it. The growth *fit*
    // is the fallback for a trial whose participant count is not known, and it
    // is what used to stall the whole forecast at "needs a second tier".
    const baseWork = baseWorkFromObservations(observations, participants);
    const growthPerTier = estimateGrowthPerTier(observations);
    const totalFor = (candidate) => {
        const seen = observations.find((entry) => entry.tier === candidate && entry.total > 0)?.total;
        if (Number.isFinite(seen)) return seen;

        const derived = tierPoolWork({ baseWork, tier: candidate, participants });
        if (Number.isFinite(derived)) return derived;

        return projectTierTotal({ observations, tier: candidate, growthPerTier });
    };

    // The player's own success rate falls as the tiers climb, so the rate
    // measured on this tier is not the rate the next one runs at
    const declineAt = (candidate) => {
        const success = successAtTier(decline, candidate);
        if (success === null) return 1;
        const here = successAtTier(decline, tier) || success;
        return here > 0 ? success / here : 1;
    };

    const clears = [];
    let spentMs = 0;
    let current = tier;
    let need = Number.isFinite(remainingInTier) && remainingInTier > 0 ? remainingInTier : totalFor(tier);
    let limitedBy = 'time';

    while (current <= TRIAL_MAX_TIER) {
        if (!Number.isFinite(need) || need <= 0) {
            limitedBy = 'unknown-next-tier';
            break;
        }

        // No wall here: the success rate stops falling at its floor, so a deep
        // tier is slow rather than impossible and the walk simply runs out of
        // hour. Only the clock and the top of the ladder end this one.
        const takesMs = (need / (rate * declineAt(current))) * 1000;
        if (spentMs + takesMs > timeLeftMs) break;

        spentMs += takesMs;
        clears.push({ tier: current, atMs: spentMs, work: need });

        if (current === TRIAL_MAX_TIER) {
            limitedBy = 'ladder';
            break;
        }
        current += 1;
        need = totalFor(current);
    }

    return {
        finalTier: clears.length ? clears[clears.length - 1].tier : null,
        tiersCleared: clears.length,
        clears,
        limitedBy,
    };
}

/**
 * The whole forecast for one trial card, with its provenance.
 *
 * The one entry point the panel uses, so that every caption on screen can name
 * what the number rests on without the drawing code having to work it out.
 *
 * @param {Object} input - Inputs
 * @param {Object} input.analysis - From `analyseTrial`
 * @param {Object} [input.clientData] - `initClientData`, for the monster sheets
 * @param {string} [input.name] - The trial's name
 * @param {number} [input.participants] - Members signed up
 * @param {Array<Object>} [input.loadouts] - Captured loadouts for the party
 * @param {number|null} [input.measuredDps] - Party DPS the trial itself produced
 * @returns {{tier: number|null, tiersCleared: number, source: string, limitedBy: string,
 *   coverage: {known: number, of: number}|null, reason: string|null}} The forecast
 */
export function forecastTrial({
    analysis,
    clientData = null,
    name = '',
    participants = 0,
    loadouts = [],
    measuredDps = null,
} = {}) {
    const nothing = (reason) => ({
        tier: null,
        tiersCleared: 0,
        source: 'none',
        limitedBy: 'unknown',
        coverage: null,
        reason,
    });

    const tier = Number.isFinite(analysis?.tier) ? analysis.tier : null;
    const timeLeftMs = Number.isFinite(analysis?.timeLeftMs) ? analysis.timeLeftMs : null;
    if (tier === null) return nothing('the tier is not known — open the Trials tab once');
    if (timeLeftMs === null) return nothing('no clock on the tab, so there is no hour to spend');

    if (analysis.kind === 'skilling') {
        const rate = Number.isFinite(analysis.rate) ? analysis.rate * 1000 : null;
        if (!rate) return nothing('a skilling trial can only be projected from a measured fill rate');

        const walk = forecastSkillingTier({
            tier,
            rate,
            timeLeftMs,
            observations: analysis.tiers || [],
            remainingInTier: analysis.remaining,
            participants,
            decline: successDecline(analysis.personalByTier),
        });
        if (!walk) return nothing('nothing measured yet');
        // The tiers already banked are part of where this trial ends up
        const banked = Number.isFinite(analysis.tiersClearedSoFar) ? analysis.tiersClearedSoFar : 0;
        const decline = successDecline(analysis.personalByTier);
        const total = banked + walk.tiersCleared;
        return {
            ...walk,
            // The tier reached and the count of tiers banked are one number
            tier: total > 0 ? total : null,
            tiersCleared: total,
            source: 'measured',
            coverage: null,
            reason: null,
            decline,
        };
    }

    const wave = trialWave(name, clientData);
    if (!wave) return nothing('this trial’s monsters are not in the game data this script can read');

    const measured = Number.isFinite(measuredDps) && measuredDps > 0 ? measuredDps : null;
    const estimate = measured === null ? estimatePartyDamage(loadouts) : null;
    const dps = measured ?? estimate?.dps ?? null;
    if (!dps) return nothing('no party damage measured, and no loadouts captured to estimate one from');

    const walk = forecastCombatTier({
        baseHp: wave.baseHp,
        tier,
        dps,
        timeLeftMs,
        participants,
        remainingInTier: analysis.remaining,
        observedTotal: (candidate) =>
            (analysis.tiers || []).find((entry) => entry.tier === candidate && entry.total > 0)?.total ?? null,
    });
    if (!walk) return nothing('nothing to project from');

    const banked = Number.isFinite(analysis.tiersClearedSoFar) ? analysis.tiersClearedSoFar : 0;
    const total = banked + walk.tiersCleared;
    return {
        ...walk,
        // The tier reached and the count of tiers banked are one number
        tier: total > 0 ? total : null,
        tiersCleared: total,
        source: measured === null ? 'estimated' : 'measured',
        coverage: estimate ? { known: estimate.members, of: Math.max(estimate.members, participants) } : null,
        reason: null,
    };
}
