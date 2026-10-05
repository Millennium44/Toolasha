/** Pure inputs and results shared by the Guild Trial Simulator and its worker. */
import {
    TRIAL_MAX_TIER,
    TRIAL_SKILLS,
    levelFromTier,
    tierPoolWork,
    tierMarginalPoints,
    partialTierCredit,
    trialBankedBasePoints,
} from '../guild/guild-trials-math.js';

export const MAX_TRIAL_MEMBERS = 100;
export const MAX_TRIAL_RUNS = 200;

function numberIn(value, min, max, label, integer = false) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        throw new Error(`${label} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
    }
    return n;
}

function validateBuffs(buffs, label) {
    if (!Array.isArray(buffs) || buffs.length > 300)
        throw new Error(`${label} must be a buff list with at most 300 entries.`);
    return buffs.map((buff) => {
        if (!/^\/buff_types\/[a-z_]+$/.test(buff?.typeHrid || '')) throw new Error('A buff has an unsupported type.');
        return {
            ...buff,
            flatBoost: numberIn(buff.flatBoost ?? 0, -1000, 10000, 'Buff flat boost'),
            ratioBoost: numberIn(buff.ratioBoost ?? 0, -0.95, 100, 'Buff ratio boost'),
        };
    });
}

function isRecord(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a scenario without mutating its roster or any imported build. */
export function validateTrialScenario(input) {
    if (!['combat', 'skilling'].includes(input?.kind)) throw new Error('Choose a combat or skilling trial.');
    const members = input.members;
    if (!Array.isArray(members) || !members.length || members.length > MAX_TRIAL_MEMBERS) {
        throw new Error(`Add between 1 and ${MAX_TRIAL_MEMBERS} members.`);
    }
    const ids = members.filter((member) => member?.id != null && member.id !== '').map((member) => String(member.id));
    if (new Set(ids).size !== ids.length) throw new Error('A character can appear only once in a trial roster.');
    const result = {
        ...input,
        startTier: numberIn(input.startTier ?? 1, 1, TRIAL_MAX_TIER, 'Starting tier', true),
        seconds: numberIn(input.seconds ?? 3600, 1, 3600, 'Time budget'),
        runs: numberIn(input.runs ?? 50, 1, MAX_TRIAL_RUNS, 'Simulation runs', true),
        seed: numberIn(input.seed ?? 1, 0, 4294967295, 'Seed', true),
    };
    for (const key of ['sharedBuffs', 'buildingBuffs']) {
        result[key] = validateBuffs(input[key] ?? [], key);
    }
    if (input.kind === 'skilling') {
        if (!TRIAL_SKILLS.some((skill) => input.trialHrid === `/guild_skilling/${skill}`))
            throw new Error('Choose a skilling trial.');
        result.baseWork = numberIn(input.baseWork, 1, 1e9, 'Tier 1 work before participants');
        // Every signup adds 1% to each tier's work, including members without a reading.
        result.participantCount = numberIn(
            input.participantCount ?? members.length,
            members.length,
            MAX_TRIAL_MEMBERS,
            'Participants for work scaling',
            true
        );
        result.members = members.map((member, i) => {
            const curve =
                member.effectiveLevel == null
                    ? {}
                    : {
                          effectiveLevel: numberIn(member.effectiveLevel, 1, 1000, 'Effective skill level'),
                          successBonus: numberIn(member.successBonus ?? 0, -1, 10, 'Success bonus'),
                      };
            const referenceTier = numberIn(member.referenceTier ?? 1, 1, TRIAL_MAX_TIER, 'Reference tier', true);
            return {
                ...member,
                ...curve,
                name: String(member.name || `Member ${i + 1}`).slice(0, 80),
                referenceTier,
                successRate: numberIn(
                    member.successRate ?? skillingSuccessAtTier(curve, referenceTier),
                    0.05,
                    1,
                    'Success rate'
                ),
                successLossPerTier: numberIn(member.successLossPerTier ?? 0.08, 0, 1, 'Success loss per tier'),
                workPower: numberIn(member.workPower, 0, 1e7, 'Work power'),
                actionSeconds: numberIn(member.actionSeconds, 0.1, 3600, 'Work time'),
                doubleChance: numberIn(member.doubleChance ?? 0, 0, 1, 'Double progress chance'),
                successLowerBound: member.successLowerBound === true,
            };
        });
        if (result.members.every((member) => member.workPower === 0))
            throw new Error('At least one member needs work power.');
        // Bound the worker's worst case. Normal trial work times are several seconds.
        const events = result.members.reduce((sum, m) => sum + result.seconds / m.actionSeconds, 0);
        if (events * result.runs > 20_000_000)
            throw new Error('Reduce the runs or increase work time for this roster.');
    } else {
        if (!/^\/guild_combat\/[a-z_]+$/.test(input.trialHrid || '')) throw new Error('Choose a trial boss.');
        result.participantCount = numberIn(
            input.participantCount ?? members.length,
            members.length,
            MAX_TRIAL_MEMBERS,
            'Participants for boss scaling',
            true
        );
        result.resetBetweenTiers = input.resetBetweenTiers !== false;
        result.members = members.map((member, i) => ({
            ...member,
            name: String(member.name || `Member ${i + 1}`).slice(0, 80),
        }));
        for (const member of result.members) {
            const dto = member.dto;
            if (!isRecord(dto?.equipment) || !Array.isArray(dto.abilities) || !isRecord(dto.houseRooms)) {
                throw new Error(`${member.name} needs a complete combat build.`);
            }
            for (const skill of ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic']) {
                // The engine adds these levels to base stats; a numeric string
                // would concatenate instead and silently inflate the build.
                if (typeof dto[`${skill}Level`] !== 'number')
                    throw new Error(`${member.name}: ${skill} level must be a numeric value.`);
                numberIn(dto[`${skill}Level`], 1, 1000, `${member.name}: ${skill} level`);
            }
            member.dto = { ...dto };
            for (const key of ['guildCombatBuffs', 'achievementCombatBuffs']) {
                if (dto[key] != null) member.dto[key] = validateBuffs(dto[key], `${member.name}: ${key}`);
            }
            if (Object.keys(dto.equipment).some((key) => !key.startsWith('/equipment_types/'))) {
                throw new Error(`${member.name} has equipment in an unsupported format.`);
            }
            for (const piece of Object.values(dto.equipment).filter(Boolean)) {
                if (!piece.hrid?.startsWith('/items/'))
                    throw new Error(`${member.name} has an unsupported equipment item.`);
                numberIn(piece.enhancementLevel ?? 0, 0, 50, 'Enhancement level', true);
            }
            for (const ability of dto.abilities.filter(Boolean)) {
                if (!ability.hrid?.startsWith('/abilities/'))
                    throw new Error(`${member.name} has an unsupported ability.`);
                numberIn(ability.level, 1, 1000, 'Ability level', true);
            }
        }
    }
    return result;
}

/** Recorded game curve, or a reference-based estimate when the level/bonus are unknown. */
export function skillingSuccessAtTier(member, tier) {
    if (member.effectiveLevel != null) {
        const gap = member.effectiveLevel - levelFromTier(tier);
        return Math.max(0.05, Math.min(1, 0.8 * (1 + gap * (gap >= 0 ? 0.005 : 0.01) + (member.successBonus ?? 0))));
    }
    return Math.max(0.05, Math.min(1, member.successRate - (tier - member.referenceTier) * member.successLossPerTier));
}

/** Skilling trials whose recorded success curve carries a success bonus. */
const SUCCESS_BONUS_TRIALS = ['/guild_skilling/enhancing'];

/**
 * Anchor the game's two-slope curve on a single reading when no bend has been observed.
 *
 * One reading cannot separate effective level from success bonus, so this assumes no
 * success bonus (every recorded curve but Enhancing had none) and places the bend where
 * the reading puts it: `rate / 0.8 - 1 = gap * (0.005 when gap >= 0, else 0.01)` with
 * `gap = effectiveLevel - trialLevel`, i.e. -4 percentage points per tier while the trial level is below
 * the effective level and -8 above it. A capped 100% reading only says the gap is at
 * least 50 levels, so it returns the least effective level consistent with it and flags
 * the curve as a lower bound.
 *
 * That bound needs the no-bonus assumption: a bonus stands in for levels, moving the
 * bend earlier. For a trial whose skill carries a bonus (Enhancing) a capped reading
 * instead returns the steepest curve through it, -8 points a tier from the reading,
 * which no level or non-negative bonus consistent with the reading can fall below.
 *
 * @param {{tier: number, successRate: number, trialHrid?: string}} reading - The reading to anchor on
 * @param {number} [successBonus] - Assumed success bonus
 * @returns {{effectiveLevel: number, successBonus: number, successLowerBound: boolean}|null} The curve
 */
export function anchorSkillingSuccessCurve(reading, successBonus = 0) {
    const tier = reading?.tier;
    const rate = reading?.successRate;
    if (!Number.isInteger(tier) || tier < 1 || tier > TRIAL_MAX_TIER) return null;
    if (!Number.isFinite(rate) || rate < 0.05 || rate > 1) return null;
    if (rate >= 1 && SUCCESS_BONUS_TRIALS.includes(reading.trialHrid)) {
        // 0.8 * (1 + 0.25) = 1 at the reading's own level, then 0.01 * 0.8 per level above it.
        return { effectiveLevel: levelFromTier(tier), successBonus: 0.25, successLowerBound: true };
    }
    const excess = rate / 0.8 - 1 - successBonus;
    const effectiveLevel = levelFromTier(tier) + excess / (excess >= 0 ? 0.005 : 0.01);
    if (!(effectiveLevel >= 1 && effectiveLevel <= 1000)) return null;
    return { effectiveLevel, successBonus, successLowerBound: rate >= 1 };
}

/** Infer level and success bonus only when uncapped readings identify the curve's bend. */
export function fitSkillingSuccessCurve(readings) {
    const rows = [
        ...new Map(
            (readings || [])
                .filter(
                    (r) =>
                        Number.isInteger(r?.tier) &&
                        r.tier >= 1 &&
                        r.tier <= TRIAL_MAX_TIER &&
                        Number.isFinite(r.successRate) &&
                        r.successRate >= 0.05 &&
                        r.successRate <= 1
                )
                .map((r) => [r.tier, r])
        ).values(),
    ].sort((a, b) => a.tier - b.tier);
    const uncapped = rows.filter((r) => r.successRate > 0.05 && r.successRate < 1);
    for (let i = 0; i < uncapped.length; i++) {
        for (let j = i + 1; j < uncapped.length; j++) {
            const left = uncapped[i],
                right = uncapped[j];
            const levelGap = levelFromTier(right.tier) - levelFromTier(left.tier);
            const decline = left.successRate - right.successRate;
            if (decline <= 0.004 * levelGap + 1e-9 || decline >= 0.008 * levelGap - 1e-9) continue;
            const effectiveLevel = levelFromTier(left.tier) + (0.008 * levelGap - decline) / 0.004;
            const successBonus = left.successRate / 0.8 - 1 - 0.005 * (effectiveLevel - levelFromTier(left.tier));
            const curve = { effectiveLevel, successBonus };
            if (
                effectiveLevel >= 1 &&
                effectiveLevel <= 1000 &&
                successBonus >= -1 &&
                successBonus <= 10 &&
                rows.every((r) => Math.abs(skillingSuccessAtTier(curve, r.tier) - r.successRate) <= 0.00051)
            )
                return curve;
        }
    }
    return null;
}

/** Expected work per second; useful beside the simulated distribution. */
export function skillingWorkPerSecond(members, tier) {
    return members.reduce(
        (sum, m) =>
            sum + (Math.floor(m.workPower) * skillingSuccessAtTier(m, tier) * (1 + m.doubleChance)) / m.actionSeconds,
        0
    );
}

/** Required pool with the same ladder the live trial forecast uses, scaled by every signup. */
export function skillingPool(scenario, tier) {
    return tierPoolWork({
        baseWork: scenario.baseWork,
        tier,
        participants: scenario.participantCount ?? scenario.members.length,
    });
}

/**
 * The seed for one attempt. `seed + run × 0x9e3779b9` keeps it independent of how runs
 * are split across workers; the result is then mixed with the same murmur3 finalizer
 * `seedSimRng` applies (`mixSeed(seed, 0)` in engine/rng.js). Raw mulberry32 seeds that
 * differ by a multiple of its increment walk one stream at an offset: runs 7 apart did,
 * only 819,059 draws apart.
 * @param {number} seed - Scenario seed
 * @param {number} run - Zero-based attempt index
 * @returns {number} 32-bit seed for {@link trialRandom}
 */
export function trialRunSeed(seed, run) {
    let h = (((seed + run * 0x9e3779b9) >>> 0) ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic local RNG; no shared combat-engine random state. */
export function trialRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), state | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

/** Aggregate whole trial attempts. Clear odds are unconditional, including earlier failures. */
export function summarizeTrialRuns(scenario, attempts) {
    const count = attempts.length;
    if (!count) throw new Error('The simulation returned no attempts.');
    const highest = attempts.map((attempt) => attempt.highestTier);
    const rows = [];
    for (let tier = scenario.startTier; tier <= TRIAL_MAX_TIER; tier++) {
        const observed = attempts.flatMap((attempt) => attempt.tiers.filter((row) => row.tier === tier));
        const clears = observed.filter((row) => row.cleared);
        rows.push({
            tier,
            level: levelFromTier(tier),
            reachChance: observed.length / count,
            clearChance: clears.length / count,
            meanClearSeconds: clears.length ? clears.reduce((sum, row) => sum + row.seconds, 0) / clears.length : null,
            meanAttemptSeconds: observed.length
                ? observed.reduce((sum, row) => sum + row.seconds, 0) / observed.length
                : null,
            meanProgressFraction: observed.length
                ? observed.reduce((sum, row) => sum + (row.cleared ? 1 : row.progressFraction || 0), 0) /
                  observed.length
                : null,
        });
    }
    const meanBankedBasePoints =
        attempts.reduce(
            (sum, a) => sum + trialBankedBasePoints({ type: scenario.kind, bankedTiers: a.highestTier }).basePoints,
            0
        ) / count;
    const meanPartialBasePoints =
        attempts.reduce((sum, attempt) => {
            const unfinished = attempt.tiers.find((row) => !row.cleared);
            return (
                sum +
                (unfinished
                    ? (tierMarginalPoints(scenario.kind, unfinished.tier) ?? 0) *
                      partialTierCredit(unfinished.progressFraction)
                    : 0)
            );
        }, 0) / count;
    return {
        kind: scenario.kind,
        trialHrid: scenario.trialHrid,
        seed: scenario.seed,
        runs: count,
        participants: scenario.members.length,
        ...(scenario.kind === 'combat'
            ? { bossParticipants: scenario.participantCount ?? scenario.members.length }
            : { workParticipants: scenario.participantCount ?? scenario.members.length }),
        startTier: scenario.startTier,
        meanHighestTier: highest.reduce((sum, tier) => sum + tier, 0) / count,
        medianHighestTier: percentile(highest, 0.5),
        lowHighestTier: percentile(highest, 0.1),
        highHighestTier: percentile(highest, 0.9),
        meanSeconds: attempts.reduce((sum, a) => sum + a.seconds, 0) / count,
        meanBasePoints: meanBankedBasePoints + meanPartialBasePoints,
        meanBankedBasePoints,
        meanPartialBasePoints,
        outcomes: Object.fromEntries(
            ['defeat', 'timeout', 'max-tier'].map((key) => [key, attempts.filter((a) => a.reason === key).length])
        ),
        tiers: rows,
        // A capped reading only bounds success from below, so tiers and points do too.
        lowerBound: scenario.kind === 'skilling' && scenario.members.some((m) => m.successLowerBound),
        warnings: [...new Set(attempts.flatMap((a) => a.warnings || []))],
    };
}
