import { afterEach, describe, expect, test, vi } from 'vitest';

const yields = vi.hoisted(() => ({ count: 0, onYield: null }));
vi.mock('../../utils/yield-to-browser.js', () => ({
    yieldToBrowser: () => {
        yields.count++;
        yields.onYield?.(yields.count);
        // A microtask stands in for a frame; a real timer per yield makes a hundred-member run slow
        return Promise.resolve();
    },
}));
import {
    ASSIGN_MODES,
    BENCH_PIN,
    memberTierRates,
    optimizeTrialAssignment,
    optimizeTrialAssignmentAsync,
    rateInputFromLevel,
    scoreTrial,
    signupMessages,
    skillingSlotCap,
} from './guild-trial-assign.js';
import { skillingSuccessAtTier } from './guild-trial-model.js';
import { GUILD_SKILLING_TICKS } from '../guild/guild-trial-messages.fixture.js';
import { TRIAL_MAX_TIER } from '../guild/guild-trials-math.js';

const CRAFTING = '/guild_skilling/crafting';
const MILKING = '/guild_skilling/milking';
const ALCHEMY = '/guild_skilling/alchemy';
const COOKING = '/guild_skilling/cooking';

/** Constant work per second at every tier */
function flat(rate) {
    const rates = new Float64Array(TRIAL_MAX_TIER + 1);
    rates.fill(rate, 1);
    return rates;
}

const assumed = { efficiency: 0.6154, actionSeconds: 4.464, doubleChance: 0 };

describe('the rate model against the recorded reading', () => {
    test('effective level 100 reproduces the Crafting tier-10 footer on success and work power', () => {
        const reading = GUILD_SKILLING_TICKS[0];
        const input = rateInputFromLevel(100, { ...assumed, efficiency: reading.efficiency });
        expect(Math.floor(input.workPower)).toBe(reading.progressPerAction);
        expect(skillingSuccessAtTier(input, reading.tier)).toBeCloseTo(reading.successRate, 12);
        // Neither neighbor reproduces both
        expect(Math.floor(rateInputFromLevel(99, { efficiency: reading.efficiency }).workPower)).not.toBe(161);
        expect(Math.floor(rateInputFromLevel(101, { efficiency: reading.efficiency }).workPower)).not.toBe(161);
    });

    test('work per second is floor(work power) × success × (1 + double) / action time', () => {
        const rates = memberTierRates({ ...rateInputFromLevel(100, assumed), doubleChance: 0.1 });
        expect(rates[10]).toBeCloseTo((161 * 0.08 * 1.1) / 4.464, 10);
        expect(rates[1]).toBeCloseTo((161 * 0.8 * 1.1) / 4.464, 10);
    });

    test('unusable inputs contribute nothing', () => {
        expect(memberTierRates({ workPower: 0, actionSeconds: 5, effectiveLevel: 100 })[1]).toBe(0);
        expect(memberTierRates({ workPower: 100, actionSeconds: 0, effectiveLevel: 100 })[1]).toBe(0);
        expect(rateInputFromLevel(0, assumed)).toBeNull();
        expect(rateInputFromLevel(NaN, assumed)).toBeNull();
    });
});

describe('scoreTrial — analytic tier walk', () => {
    test('banks whole tiers, then half credit per unit of progress on the unfinished one', () => {
        // Tier pools 1000, 1100, 1200 at 100 work/s: 10 s + 11 s, then 4 s of a 12 s tier
        const score = scoreTrial(flat(100), 0, { baseWork: 1000, seconds: 25, jitter: [1] });
        expect(score.nominalTiers).toBe(2);
        expect(score.nominalProgress).toBeCloseTo(1 / 3, 12);
        expect(score.points).toBeCloseTo(200 + 100 + 100 * 0.5 * (1 / 3), 10);
    });

    test('every signup adds 1% to the pool', () => {
        const alone = scoreTrial(flat(100), 0, { baseWork: 1000, seconds: 10, jitter: [1] });
        const crowded = scoreTrial(flat(100), 10, { baseWork: 1000, seconds: 10, jitter: [1] });
        expect(alone.nominalTiers).toBe(1);
        expect(crowded.nominalTiers).toBe(0);
        expect(crowded.nominalProgress).toBeCloseTo(1000 / 1100, 12);
    });

    test('jitter averages across a tier boundary instead of jumping at it', () => {
        const atEdge = scoreTrial(flat(100), 0, { baseWork: 1000, seconds: 10 });
        expect(atEdge.points).toBeGreaterThan(100); // half credit at the slower rates
        expect(atEdge.points).toBeLessThan(200);
    });

    test('no work banks nothing', () => {
        expect(scoreTrial(flat(0), 5, { baseWork: 40000 }).points).toBe(0);
    });
});

describe('optimizeTrialAssignment', () => {
    const member = (id, rates, extra = {}) => ({ id, name: `M${id}`, rates, ...extra });
    const strong = { effectiveLevel: 160, workPower: 250, actionSeconds: 5, doubleChance: 0 };
    const weak = { effectiveLevel: 90, workPower: 120, actionSeconds: 5, doubleChance: 0 };

    test('puts each member where they are strong', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING, MILKING],
            baseWork: 40000,
            members: [
                member('1', { [CRAFTING]: strong, [MILKING]: weak }),
                member('2', { [CRAFTING]: weak, [MILKING]: strong }),
            ],
        });
        const placed = Object.fromEntries(result.members.map((m) => [m.id, m.trialHrid]));
        expect(placed).toEqual({ 1: CRAFTING, 2: MILKING });
        expect(result.totalPoints).toBeGreaterThan(0);
    });

    test('bench mode leaves out a combat member who only adds to the pool; fill mode places them', () => {
        const members = [
            member('1', { [CRAFTING]: strong }),
            member('2', { [CRAFTING]: { ...weak, workPower: 1, effectiveLevel: 1 } }, { inCombat: true }),
        ];
        const bench = optimizeTrialAssignment({ trials: [CRAFTING], baseWork: 40000, members });
        expect(bench.members.find((m) => m.id === '2').trialHrid).toBeNull();
        const fill = optimizeTrialAssignment({
            trials: [CRAFTING],
            baseWork: 40000,
            members,
            mode: ASSIGN_MODES.Fill,
        });
        expect(fill.members.find((m) => m.id === '2').trialHrid).toBe(CRAFTING);
        expect(fill.totalPoints).toBeLessThanOrEqual(bench.totalPoints);
    });

    test('respects slot caps, pins and trials a member has no rate for', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING, MILKING],
            baseWork: 40000,
            caps: { [CRAFTING]: 1, [MILKING]: 2 },
            members: [
                member('1', { [CRAFTING]: strong, [MILKING]: strong }),
                member('2', { [CRAFTING]: strong, [MILKING]: strong }),
                member('3', { [CRAFTING]: { ...strong, effectiveLevel: 200, workPower: 400 } }),
                member('4', { [CRAFTING]: strong, [MILKING]: strong }, { pin: BENCH_PIN }),
                member('5', { [CRAFTING]: weak }, { pin: MILKING }),
            ],
        });
        const placed = Object.fromEntries(result.members.map((m) => [m.id, m.trialHrid]));
        expect(placed['4']).toBeNull();
        expect(placed['5']).toBe(MILKING); // pinned without a Milking rate: counted, adds nothing
        // The one Crafting slot goes to the strongest crafter; Milking has one free slot left
        expect(placed['3']).toBe(CRAFTING);
        const crafting = result.trials.find((t) => t.trialHrid === CRAFTING);
        const milking = result.trials.find((t) => t.trialHrid === MILKING);
        expect(crafting.signups).toBe(1);
        expect(milking.signups).toBe(2);
        expect(result.members.find((m) => m.id === '5').hasRate).toBe(false);
    });

    test('reports current points and the moves from the current sheet', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING, MILKING],
            baseWork: 40000,
            members: [
                member('1', { [CRAFTING]: strong, [MILKING]: weak }, { current: MILKING }),
                member('2', { [CRAFTING]: weak, [MILKING]: strong }, { current: MILKING }),
            ],
        });
        expect(result.totalPoints).toBeGreaterThan(result.currentPoints);
        expect(result.moves).toEqual([{ id: '1', name: 'M1', from: MILKING, to: CRAFTING }]);
    });

    test('matches an exhaustive search on a small roster', () => {
        const trials = [CRAFTING, MILKING];
        const levels = [
            [150, 110],
            [140, 145],
            [100, 160],
            [120, 120],
            [95, 105],
            [170, 90],
        ];
        // In combat, so the bench is open to every member and the search space is the full 3^6
        const members = levels.map(([c, m], i) =>
            member(
                String(i),
                {
                    [CRAFTING]: { effectiveLevel: c, workPower: c * 1.5, actionSeconds: 6, doubleChance: 0 },
                    [MILKING]: { effectiveLevel: m, workPower: m * 1.5, actionSeconds: 6, doubleChance: 0 },
                },
                { inCombat: true }
            )
        );
        const options = { trials, baseWork: 40000, caps: { [CRAFTING]: 3, [MILKING]: 3 } };
        const result = optimizeTrialAssignment({ ...options, members });

        let best = -Infinity;
        for (let code = 0; code < 3 ** members.length; code++) {
            let rest = code;
            const pins = members.map(() => {
                const slot = rest % 3;
                rest = Math.floor(rest / 3);
                return slot === 2 ? BENCH_PIN : trials[slot];
            });
            if (pins.filter((p) => p === CRAFTING).length > 3 || pins.filter((p) => p === MILKING).length > 3) continue;
            const fixed = optimizeTrialAssignment({
                ...options,
                members: members.map((m, i) => ({ ...m, pin: pins[i] })),
                restarts: 0,
            });
            best = Math.max(best, fixed.totalPoints);
        }
        expect(result.totalPoints).toBeCloseTo(best, 6);
    });

    test('a hundred members across four trials finishes within a few seconds even on a loaded machine', () => {
        const trials = [CRAFTING, MILKING, ALCHEMY, COOKING];
        const members = Array.from({ length: 100 }, (_, i) =>
            member(
                String(i),
                Object.fromEntries(
                    trials.map((hrid, t) => [
                        hrid,
                        rateInputFromLevel(80 + ((i * 37 + t * 53) % 90), { efficiency: 0.4, actionSeconds: 5 }),
                    ])
                )
            )
        );
        const started = performance.now();
        const result = optimizeTrialAssignment({ trials, baseWork: 40000, cap: 25, members });
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(5000);
        expect(result.trials.every((t) => t.signups <= 25)).toBe(true);
    });

    test('the async search returns what the synchronous one does', async () => {
        const members = [
            member('1', { [CRAFTING]: strong, [MILKING]: weak }),
            member('2', { [CRAFTING]: weak, [MILKING]: strong }),
            member('3', { [CRAFTING]: strong, [MILKING]: strong }),
        ];
        const problem = { trials: [CRAFTING, MILKING], baseWork: 40000, members, seed: 7 };
        const sync = optimizeTrialAssignment(problem);
        const async = await optimizeTrialAssignmentAsync(problem);
        expect(async.totalPoints).toBeCloseTo(sync.totalPoints, 9);
        expect(async.members.map((m) => m.trialHrid)).toEqual(sync.members.map((m) => m.trialHrid));
    });

    test('refuses a problem with no skilling trials', () => {
        expect(() => optimizeTrialAssignment({ trials: ['/guild_combat/badger'], baseWork: 1, members: [] })).toThrow(
            /No skilling trials/
        );
    });
});

describe('skillingSlotCap', () => {
    const detailMap = {
        '/guild_buildings/skilling_encampment': { maxLevel: 10, skillingTrialSlotsPerLevel: 2 },
        '/guild_buildings/combat_encampment': { maxLevel: 10, combatTrialSlotsPerLevel: 4 },
    };

    test('20 plus the encampment’s slots per level, clamped to its max level', () => {
        expect(skillingSlotCap(detailMap, { '/guild_buildings/skilling_encampment': 3 })).toBe(26);
        expect(skillingSlotCap(detailMap, { '/guild_buildings/skilling_encampment': 40 })).toBe(40);
        expect(skillingSlotCap(detailMap, {})).toBe(20);
        expect(skillingSlotCap(null, null)).toBe(20);
    });
});

describe('signupMessages', () => {
    const utf8 = (text) => new TextEncoder().encode(text).length;

    test('one short message names every trial and member', () => {
        const messages = signupMessages([
            { label: 'Crafting', names: ['Ann', 'Bob'] },
            { label: 'Milking', names: ['Cy'] },
            { label: 'Alchemy', names: [] },
        ]);
        expect(messages).toEqual(['Skilling sign-ups — Crafting: Ann, Bob | Milking: Cy']);
    });

    test('splits at 400 UTF-8 bytes and loses no one, multibyte names included', () => {
        const names = Array.from({ length: 60 }, (_, i) => `玩家名字${i}`);
        const groups = [
            { label: 'Crafting', names: names.slice(0, 30) },
            { label: 'Milking', names: names.slice(30) },
        ];
        const messages = signupMessages(groups);
        expect(messages.length).toBeGreaterThan(1);
        for (const message of messages) expect(utf8(message)).toBeLessThanOrEqual(400);
        const text = messages.join(' ');
        for (const name of names) expect(text).toMatch(new RegExp(`(: |, )${name}(,| \\||$| )`));
        expect(text).toContain('(cont.)');
    });
});

describe('review fixes', () => {
    const strong = { effectiveLevel: 160, workPower: 250, actionSeconds: 5, doubleChance: 0 };
    const idle = { effectiveLevel: 1, workPower: 1, actionSeconds: 5, doubleChance: 0 };

    test('a pin to a trial that was not drawn is Auto, not the bench', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING],
            baseWork: 40000,
            members: [{ id: '1', name: 'A', rates: { [CRAFTING]: strong }, pin: '/guild_skilling/brewing' }],
        });
        expect(result.members[0]).toMatchObject({ trialHrid: CRAFTING, pinned: false });
    });

    test('bench mode benches only members in combat; anyone else benched is flagged', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING],
            baseWork: 40000,
            members: [
                { id: '1', name: 'A', rates: { [CRAFTING]: strong } },
                { id: '2', name: 'Idle', rates: { [CRAFTING]: idle } },
                { id: '3', name: 'Fighter', rates: { [CRAFTING]: idle }, inCombat: true },
                { id: '4', name: 'Pinned out', rates: { [CRAFTING]: strong }, pin: BENCH_PIN },
            ],
        });
        const byName = Object.fromEntries(result.members.map((m) => [m.name, m]));
        expect(byName.Idle.trialHrid).toBe(CRAFTING);
        expect(byName.Fighter.trialHrid).toBeNull();
        expect(byName.Fighter.losesBonus).toBe(false);
        expect(byName['Pinned out'].losesBonus).toBe(true);
    });

    test('a member without combat benched for want of slots is flagged', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING],
            baseWork: 40000,
            cap: 1,
            members: [
                { id: '1', name: 'A', rates: { [CRAFTING]: strong } },
                { id: '2', name: 'B', rates: { [CRAFTING]: idle } },
            ],
        });
        const b = result.members.find((m) => m.name === 'B');
        expect(b.trialHrid).toBeNull();
        expect(b.losesBonus).toBe(true);
    });

    test('a name cut to fit never splits a surrogate pair', () => {
        const [message] = signupMessages([{ label: 'C', names: ['😀'.repeat(200)] }]);
        expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(400);
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(message)).toBe(false);
    });
});

describe('pins past a trial’s slots', () => {
    test('pins beyond the cap are dropped, current sign-ups kept first, and reported', () => {
        const strong = { effectiveLevel: 160, workPower: 250, actionSeconds: 5, doubleChance: 0 };
        const result = optimizeTrialAssignment({
            trials: [CRAFTING, MILKING],
            baseWork: 40000,
            caps: { [CRAFTING]: 1, [MILKING]: 5 },
            members: [
                { id: '1', name: 'A', rates: { [CRAFTING]: strong, [MILKING]: strong }, pin: CRAFTING },
                {
                    id: '2',
                    name: 'B',
                    rates: { [CRAFTING]: strong, [MILKING]: strong },
                    pin: CRAFTING,
                    current: CRAFTING,
                },
            ],
        });
        const crafting = result.trials.find((t) => t.trialHrid === CRAFTING);
        expect(crafting.signups).toBe(1);
        const byName = Object.fromEntries(result.members.map((m) => [m.name, m]));
        expect(byName.B).toMatchObject({ trialHrid: CRAFTING, pinned: true, pinDropped: false });
        expect(byName.A).toMatchObject({ pinned: false, pinDropped: true, trialHrid: MILKING });
    });
});

describe('must-place members and feasibility', () => {
    const flexible = {
        id: 'F',
        name: 'Flexible',
        rates: {
            [CRAFTING]: { effectiveLevel: 200, workPower: 400, actionSeconds: 4, doubleChance: 0 },
            [MILKING]: { effectiveLevel: 90, workPower: 100, actionSeconds: 6, doubleChance: 0 },
        },
    };
    const craftingOnly = (id) => ({
        id,
        name: `Only ${id}`,
        rates: { [CRAFTING]: { effectiveLevel: 120, workPower: 150, actionSeconds: 6, doubleChance: 0 } },
    });

    for (const mode of [ASSIGN_MODES.Fill, ASSIGN_MODES.Bench]) {
        test(`${mode}: a chain of moves frees the only slot a member can take`, () => {
            const result = optimizeTrialAssignment({
                trials: [CRAFTING, MILKING],
                baseWork: 40000,
                cap: 1,
                mode,
                members: [flexible, craftingOnly('G')],
            });
            const byId = Object.fromEntries(result.members.map((m) => [m.id, m]));
            expect(byId.G.trialHrid).toBe(CRAFTING);
            expect(byId.F.trialHrid).toBe(MILKING);
            expect(result.members.filter((m) => m.losesBonus)).toEqual([]);
        });
    }

    test('when there are too few slots, exactly the overflow is left out and flagged', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING, MILKING],
            baseWork: 40000,
            cap: 1,
            members: [flexible, craftingOnly('G'), craftingOnly('H'), craftingOnly('I')],
        });
        const out = result.members.filter((m) => !m.trialHrid);
        expect(out).toHaveLength(2);
        expect(out.every((m) => m.losesBonus)).toBe(true);
        expect(result.members.find((m) => m.id === 'F').trialHrid).toBe(MILKING);
    });

    test('a combat member is benched to make room for one who must be placed', () => {
        const result = optimizeTrialAssignment({
            trials: [CRAFTING],
            baseWork: 40000,
            cap: 1,
            members: [{ ...flexible, inCombat: true }, craftingOnly('G')],
        });
        expect(result.members.find((m) => m.id === 'G').trialHrid).toBe(CRAFTING);
        expect(result.members.find((m) => m.id === 'F').trialHrid).toBeNull();
    });
});

describe('the async search hands the browser frames inside a pass', () => {
    const trials = [CRAFTING, MILKING, ALCHEMY, COOKING];
    const big = () => ({
        trials,
        baseWork: 40000,
        cap: 25,
        restarts: 1,
        members: Array.from({ length: 100 }, (_, i) => ({
            id: String(i),
            name: `M${i}`,
            inCombat: i % 3 === 0,
            rates: Object.fromEntries(
                trials.map((hrid, t) => [
                    hrid,
                    rateInputFromLevel(80 + ((i * 37 + t * 53) % 90), { efficiency: 0.4, actionSeconds: 5 }),
                ])
            ),
        })),
    });

    afterEach(() => {
        yields.count = 0;
        yields.onYield = null;
        vi.restoreAllMocks();
    });

    test('a hundred members: async matches sync and yields many times', async () => {
        const sync = optimizeTrialAssignment(big());
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => (clock += 13));
        const async = await optimizeTrialAssignmentAsync(big());
        expect(async.totalPoints).toBeCloseTo(sync.totalPoints, 9);
        expect(async.members.map((m) => m.trialHrid)).toEqual(sync.members.map((m) => m.trialHrid));
        // One per outer step of the scans, not one per pass
        expect(yields.count).toBeGreaterThan(100);
    });

    test('an abort during a pass rejects at the next frame', async () => {
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => (clock += 13));
        const controller = new AbortController();
        yields.onYield = (count) => {
            if (count === 40) controller.abort();
        };
        await expect(optimizeTrialAssignmentAsync(big(), { signal: controller.signal })).rejects.toThrow(/canceled/);
        expect(yields.count).toBe(40);
    });
});
