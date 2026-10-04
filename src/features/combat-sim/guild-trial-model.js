/** Pure inputs and results shared by the Guild Trial Simulator and its worker. */
import {
    TRIAL_MAX_TIER,
    TRIAL_SKILLS,
    levelFromTier,
    tierPoolWork,
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

/** Validate a scenario without changing its roster or any imported build. */
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
        const buffs = input[key] ?? [];
        if (!Array.isArray(buffs) || buffs.length > 300)
            throw new Error(`${key} must be a buff list with at most 300 entries.`);
        result[key] = buffs.map((buff) => {
            if (!/^\/buff_types\/[a-z_]+$/.test(buff?.typeHrid || ''))
                throw new Error('A buff has an unsupported type.');
            return {
                ...buff,
                flatBoost: numberIn(buff.flatBoost ?? 0, -1000, 10000, 'Buff flat boost'),
                ratioBoost: numberIn(buff.ratioBoost ?? 0, -0.95, 100, 'Buff ratio boost'),
            };
        });
    }
    if (input.kind === 'skilling') {
        if (!TRIAL_SKILLS.includes(String(input.trialHrid || '').replace('/guild_skilling/', '')))
            throw new Error('Choose a skilling trial.');
        result.baseWork = numberIn(input.baseWork, 1, 1e9, 'Tier 1 work before participants');
        result.members = members.map((member, i) => ({
            ...member,
            name: String(member.name || `Member ${i + 1}`).slice(0, 80),
            referenceTier: numberIn(member.referenceTier ?? 1, 1, TRIAL_MAX_TIER, 'Reference tier', true),
            successRate: numberIn(member.successRate, 0.05, 1, 'Success rate'),
            successLossPerTier: numberIn(member.successLossPerTier ?? 0.08, 0, 1, 'Success loss per tier'),
            workPower: numberIn(member.workPower, 0, 1e7, 'Work power'),
            actionSeconds: numberIn(member.actionSeconds, 0.1, 3600, 'Work time'),
            doubleChance: numberIn(member.doubleChance ?? 0, 0, 1, 'Double progress chance'),
        }));
        if (result.members.every((member) => member.workPower === 0))
            throw new Error('At least one member needs work power.');
        // Bound the worker's worst case. Normal trial work times are several seconds.
        const events = result.members.reduce((sum, m) => sum + result.seconds / m.actionSeconds, 0);
        if (events * result.runs > 20_000_000)
            throw new Error('Reduce the runs or increase work time for this roster.');
    } else {
        if (!/^\/guild_combat\/[a-z_]+$/.test(input.trialHrid || '')) throw new Error('Choose a trial boss.');
        result.resetBetweenTiers = input.resetBetweenTiers !== false;
        result.members = members.map((member, i) => ({
            ...member,
            name: String(member.name || `Member ${i + 1}`).slice(0, 80),
        }));
        for (const member of result.members) {
            const dto = member.dto;
            if (!dto?.equipment || !Array.isArray(dto.abilities) || !dto.houseRooms) {
                throw new Error(`${member.name} needs a complete combat build.`);
            }
            for (const skill of ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic']) {
                numberIn(dto[`${skill}Level`], 1, 1000, `${member.name}: ${skill} level`);
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

/** Success at a tier, using a stated reference reading and an editable decline. */
export function skillingSuccessAtTier(member, tier) {
    return Math.max(0.05, Math.min(1, member.successRate - (tier - member.referenceTier) * member.successLossPerTier));
}

/** Expected work per second; useful beside the simulated distribution. */
export function skillingWorkPerSecond(members, tier) {
    return members.reduce(
        (sum, m) =>
            sum + (Math.floor(m.workPower) * skillingSuccessAtTier(m, tier) * (1 + m.doubleChance)) / m.actionSeconds,
        0
    );
}

/** Required pool with the same ladder the live trial forecast uses. */
export function skillingPool(scenario, tier) {
    return tierPoolWork({ baseWork: scenario.baseWork, tier, participants: scenario.members.length });
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
        });
    }
    const meanBasePoints =
        attempts.reduce(
            (sum, a) => sum + trialBankedBasePoints({ type: scenario.kind, bankedTiers: a.highestTier }).basePoints,
            0
        ) / count;
    return {
        kind: scenario.kind,
        trialHrid: scenario.trialHrid,
        seed: scenario.seed,
        runs: count,
        participants: scenario.members.length,
        startTier: scenario.startTier,
        meanHighestTier: highest.reduce((sum, tier) => sum + tier, 0) / count,
        medianHighestTier: percentile(highest, 0.5),
        lowHighestTier: percentile(highest, 0.1),
        highHighestTier: percentile(highest, 0.9),
        meanSeconds: attempts.reduce((sum, a) => sum + a.seconds, 0) / count,
        meanBasePoints,
        outcomes: Object.fromEntries(
            ['defeat', 'timeout', 'max-tier'].map((key) => [key, attempts.filter((a) => a.reason === key).length])
        ),
        tiers: rows,
        warnings: [...new Set(attempts.flatMap((a) => a.warnings || []))],
    };
}
