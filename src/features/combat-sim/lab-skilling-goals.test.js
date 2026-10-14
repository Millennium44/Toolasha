/**
 * The Skilling tab's room-level search, goal planner and combined-upgrade check.
 *
 * The simulation is a stand-in with the one property the search relies on: the
 * average clear rate never rises with room level. Upgrades are written onto the
 * setup by the real `applySkillingCandidate`, so a test that combines two of
 * them is checking that both landed together, not that a sum was taken.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    applySkillingCandidate,
    averageSkillingResults,
    createRowLevelMeasure,
    describeCost,
    findMaxSkillingRoomLevel,
    annotateRoomsReached,
    includedSkills,
    mergeMultiSkillGearRows,
    renderSkillBreakdownHtml,
    skillBreakdown,
    planSkillingGoal,
    renderCombinationHtml,
    renderPlanHtml,
    resolveSlotConflicts,
    rowCost,
    selectPlanPool,
    shortlistSkillingForRoomLevels,
    simulateCombination,
    skillingCandidatesConflict,
    uniformRoomLevels,
} from './lab-skilling-goals.js';
import { measureRoomLevelGains } from './labyrinth-upgrade-levels.js';
import * as upgradeAdvisor from './upgrade-advisor.js';

const ALL = ['/skills/milking', '/skills/foraging', '/skills/woodcutting'];
const BODY = '/equipment_types/body';
const LEGS = '/equipment_types/legs';

/** Bonus a setup carries: tokens, community levels and worn gear each add to it. */
function bonusOf(setup) {
    let bonus = 0;
    for (const level of Object.values(setup.dto.tokenUpgrades || {})) bonus += level * 0.05;
    bonus += (setup.dto.communityBuffLevels?.gathering || 0) * 0.04;
    for (const kit of [setup.dto.equipment, ...Object.values(setup.skillEquipmentMap || {})]) {
        for (const worn of Object.values(kit || {}))
            bonus += (GEAR_BONUS[worn?.hrid] || 0) + (worn?.enhancementLevel || 0) * 0.01;
    }
    return bonus;
}
const GEAR_BONUS = { '/items/top_a': 0.1, '/items/top_b': 0.12, '/items/legs_a': 0.08 };

/**
 * Clear rate falls one point per room level and rises with the setup's bonus,
 * capped at 100%, so two upgrades together gain less than their parts when the
 * cap bites.
 */
function evaluate(setup, roomLevel) {
    const level = typeof roomLevel === 'object' ? Math.max(...Object.values(roomLevel)) : roomLevel;
    const clearRate = Math.min(1, Math.max(0, 1 - level / 100 + bonusOf(setup)));
    return { clearRate, xpPerRoom: level * 50 };
}

const baseSetup = () => ({
    dto: {
        tokenUpgrades: {},
        communityBuffLevels: {},
        equipment: {
            [BODY]: { hrid: '/items/old_body', enhancementLevel: 0 },
            [LEGS]: { hrid: '/items/old_legs', enhancementLevel: 0 },
        },
    },
    skillEquipmentMap: {},
});

const tokenRow = (over = {}) => ({
    candidate: { type: 'labyrinth_buff', editorKey: 'speed', currentLevel: 0, description: 'Speed Lv0→1' },
    costType: 'token',
    tokenCost: 10,
    clearRateDelta: 0.05,
    metricType: 'clearRate',
    ...over,
});
const gearRow = (hrid, slot, cost, delta, over = {}) => ({
    candidate: {
        type: 'enhancement',
        slot,
        currentHrid: '/items/old_body',
        currentLevel: 0,
        upgradeHrid: hrid,
        upgradeLevel: 0,
        description: `Swap to ${hrid}`,
        ...over,
    },
    costType: 'gold',
    cost,
    clearRateDelta: delta,
    metricType: 'clearRate',
});

describe('findMaxSkillingRoomLevel', () => {
    const search = (rateAt, threshold, extra = {}) =>
        findMaxSkillingRoomLevel({ clearRateAt: rateAt, threshold, yieldFn: async () => {}, ...extra });

    test('lands on the deepest level that still meets the bar', async () => {
        // 1 - level/100 >= 0.7 holds through level 30 and fails at 31
        const found = await search((level) => 1 - level / 100, 0.7);

        expect(found.maxLevel).toBe(30);
        expect(found.cleared).toBe(true);
        expect(found.atCeiling).toBe(false);
    });

    test('reports nothing cleared, rather than level 0 as a measurement', async () => {
        const found = await search(() => 0.1, 0.7);

        expect(found.cleared).toBe(false);
        expect(found.maxLevel).toBe(0);
    });

    test('flags a setup that clears the top of the window', async () => {
        const found = await search(() => 1, 0.7, { maxLevel: 200 });

        expect(found.maxLevel).toBe(200);
        expect(found.atCeiling).toBe(true);
    });

    test('costs a binary search of probes, not one per level', async () => {
        let probes = 0;
        await search((level) => {
            probes++;
            return 1 - level / 1000;
        }, 0.5);

        expect(probes).toBeLessThanOrEqual(11);
    });

    test('a cancel stops it where it stands and says so', async () => {
        let polls = 0;
        const found = await search((level) => 1 - level / 100, 0.7, { abortSignal: () => ++polls > 2 });

        expect(found.aborted).toBe(true);
    });
});

describe('which rooms a search runs', () => {
    test('All Skills without skip levels runs every room', () => {
        expect(includedSkills({ roomLevel: 100, targetSkill: null, allSkills: ALL })).toEqual(ALL);
    });

    test('Use Skip Levels runs only the skills that have a skip level set', () => {
        const map = { '/skills/milking': 50, '/skills/foraging': 0, '/skills/woodcutting': 70 };

        expect(includedSkills({ roomLevel: map, targetSkill: null, allSkills: ALL })).toEqual([
            '/skills/milking',
            '/skills/woodcutting',
        ]);
    });

    test('a single skill is just that skill, and nothing if its skip level is unset', () => {
        expect(includedSkills({ roomLevel: 100, targetSkill: '/skills/foraging', allSkills: ALL })).toEqual([
            '/skills/foraging',
        ]);
        expect(
            includedSkills({ roomLevel: { '/skills/foraging': 0 }, targetSkill: '/skills/foraging', allSkills: ALL })
        ).toEqual([]);
    });

    test('a probe puts the run rooms at one level and skips the rest', () => {
        expect(uniformRoomLevels(80, ['/skills/milking'], ALL)).toEqual({
            '/skills/milking': 80,
            '/skills/foraging': 0,
            '/skills/woodcutting': 0,
        });
    });

    test('the average is over the rooms run, like the baseline row', () => {
        const results = [
            { skillHrid: '/skills/milking', clearChance: 0.8, xpPerRoom: 100 },
            { skillHrid: '/skills/foraging', clearChance: 0.4, xpPerRoom: 50 },
            { skillHrid: '/skills/woodcutting', clearChance: 0, skipped: true },
        ];

        expect(averageSkillingResults(results).clearRate).toBeCloseTo(0.6, 10);
        expect(averageSkillingResults(results, '/skills/foraging').clearRate).toBeCloseTo(0.4, 10);
    });
});

describe('measuring an upgrade in room levels', () => {
    const run = async (rows, { threshold = 0.7, skills = ALL } = {}) => {
        const measure = createRowLevelMeasure({
            baseSetup: baseSetup(),
            evaluate,
            skills,
            allSkills: ALL,
            threshold,
            yieldFn: async () => {},
        });
        const summary = await measureRoomLevelGains(rows, {
            measure,
            select: shortlistSkillingForRoomLevels,
            shortlistSize: 6,
        });
        return summary;
    };

    test('finds the baseline level, the floor it finishes, and each upgrade’s gain', async () => {
        const rows = [tokenRow({ clearRateDelta: 0.1 }), gearRow('/items/top_a', BODY, 5000, 0.1)];
        rows[0].candidate.editorKey = 'speed';
        const summary = await run(rows);

        // Baseline: 1 - L/100 >= 0.7 -> level 30, which finishes floor 0 (floor 1 needs 40)
        expect(summary.baselineLevel).toBe(30);
        expect(summary.baselineFloor).toBe(0);
        const token = rows.find((r) => r.costType === 'token');
        // A speed token adds 0.05: the bar holds through level 35
        expect(token.maxRoomLevel).toBe(35);
        expect(token.roomLevelDelta).toBe(5);
        expect(token.roomLevelMeasured).toBe(true);
        const gear = rows.find((r) => r.costType === 'gold');
        expect(gear.maxRoomLevel).toBe(40);
        expect(gear.floorReached).toBe(1);
    });

    test('a row that did not help is left unmeasured, not measured as zero', async () => {
        const xp = tokenRow({ metricType: 'xpPerRoom', clearRateDelta: 0 });
        xp.candidate.editorKey = 'experience';
        const summary = await run([xp, gearRow('/items/top_a', BODY, 1, 0.1)]);

        expect(summary.measured).toBe(1);
        expect(xp.roomLevelMeasured).toBe(false);
        expect(xp.maxRoomLevel).toBeNull();
    });

    test('only the top of the shortlist is searched', async () => {
        const rows = Array.from({ length: 9 }, (_, i) =>
            gearRow('/items/top_a', `/equipment_types/slot_${i}`, 100, 0.1 - i * 0.005)
        );
        const summary = await run(rows);

        expect(summary.measured).toBe(6);
        expect(rows.filter((r) => !r.roomLevelMeasured)).toHaveLength(3);
    });

    test('when the table shows no gain anywhere, rows are ranked where the baseline stops clearing', async () => {
        // The table was run at a level the character clears outright, so every delta is 0.
        // The baseline clears through level 30 at 70%; at 31 the gear shows what it does
        const rows = [
            gearRow('/items/top_a', BODY, 5000, 0),
            gearRow('/items/legs_a', '/equipment_types/legs', 100, 0, { currentHrid: '/items/old_legs' }),
        ];
        const setup = baseSetup();
        setup.dto.equipment['/equipment_types/legs'] = { hrid: '/items/old_legs', enhancementLevel: 0 };
        const measure = createRowLevelMeasure({
            baseSetup: setup,
            evaluate,
            skills: ALL,
            allSkills: ALL,
            threshold: 0.7,
            yieldFn: async () => {},
        });
        const summary = await measureRoomLevelGains(rows, { measure, shortlistSize: 6 });

        expect(summary.baselineLevel).toBe(30);
        expect(summary.frontierLevel).toBe(31);
        // One baseline simulation and one per candidate
        expect(summary.frontierSims).toBe(3);
        expect(summary.measured).toBe(2);
        expect(rows[0].maxRoomLevel).toBe(40);
        expect(rows[1].maxRoomLevel).toBe(38);
    });

    test('rows with a real gain at the table’s level keep the table’s shortlist and cost no extra sims', async () => {
        const rows = [gearRow('/items/top_a', BODY, 5000, 0.1)];
        const measure = createRowLevelMeasure({
            baseSetup: baseSetup(),
            evaluate,
            skills: ALL,
            allSkills: ALL,
            threshold: 0.7,
            yieldFn: async () => {},
        });
        const summary = await measureRoomLevelGains(rows, { measure, shortlistSize: 6 });

        expect(summary.frontierSims).toBeUndefined();
        expect(summary.measured).toBe(1);
    });

    test('a setup that clears no room has no level to move, so nothing is measured', async () => {
        const summary = await run([gearRow('/items/top_a', BODY, 1, 0.1)], { threshold: 2 });

        expect(summary.baselineCleared).toBe(false);
        expect(summary.measured).toBe(0);
    });

    test('with Use Skip Levels, only the rooms that have a skip level are run', async () => {
        const seen = [];
        const spy = (setup, roomLevel) => {
            seen.push(roomLevel);
            return evaluate(setup, roomLevel);
        };
        const measure = createRowLevelMeasure({
            baseSetup: baseSetup(),
            evaluate: spy,
            skills: ['/skills/milking'],
            allSkills: ALL,
            threshold: 0.7,
            yieldFn: async () => {},
        });
        await measure(null);

        expect(seen.length).toBeGreaterThan(0);
        for (const map of seen) {
            expect(map['/skills/foraging']).toBe(0);
            expect(map['/skills/woodcutting']).toBe(0);
        }
    });
});

describe('applying upgrades together', () => {
    test('a token level, a community level and a swap all land on one setup', () => {
        let setup = baseSetup();
        setup = applySkillingCandidate(setup, tokenRow().candidate);
        setup = applySkillingCandidate(setup, {
            type: 'community_buff',
            buffKey: 'gathering',
            upgradeLevel: 4,
        });
        setup = applySkillingCandidate(setup, gearRow('/items/top_a', BODY, 1, 0.1).candidate);

        expect(setup.dto.tokenUpgrades.speed).toBe(1);
        expect(setup.dto.communityBuffLevels.gathering).toBe(4);
        expect(setup.dto.equipment[BODY].hrid).toBe('/items/top_a');
    });

    test('the setup it was given is left alone', () => {
        const before = baseSetup();
        applySkillingCandidate(before, gearRow('/items/top_a', BODY, 1, 0.1).candidate);

        expect(before).toEqual(baseSetup());
    });

    test('gear for one skill goes into that skill’s kit only', () => {
        const setup = applySkillingCandidate(baseSetup(), {
            ...gearRow('/items/top_a', BODY, 1, 0.1).candidate,
            type: 'skilling_gear',
            skillKey: '/skills/milking',
        });

        expect(setup.skillEquipmentMap['/skills/milking'][BODY].hrid).toBe('/items/top_a');
        expect(setup.dto.equipment[BODY].hrid).toBe('/items/old_body');
    });
});

describe('one upgrade per slot', () => {
    const a = gearRow('/items/top_a', BODY, 1, 0.1);
    const b = gearRow('/items/top_b', BODY, 1, 0.12);

    test('two swaps for the same slot conflict', () => {
        expect(skillingCandidatesConflict(a.candidate, b.candidate)).toBe(true);
    });

    test('so do two levels of the same item', () => {
        const low = gearRow('/items/old_body', BODY, 1, 0.01, { upgradeHrid: '/items/old_body', upgradeLevel: 5 });
        const high = gearRow('/items/old_body', BODY, 1, 0.02, { upgradeHrid: '/items/old_body', upgradeLevel: 8 });

        expect(skillingCandidatesConflict(low.candidate, high.candidate)).toBe(true);
    });

    test('different slots, and different skills’ kits, do not', () => {
        expect(skillingCandidatesConflict(a.candidate, gearRow('/items/legs_a', LEGS, 1, 0.1).candidate)).toBe(false);
        const milking = { ...a.candidate, skillKey: '/skills/milking' };
        const foraging = { ...b.candidate, skillKey: '/skills/foraging' };
        expect(skillingCandidatesConflict(milking, foraging)).toBe(false);
    });

    test('the same shrine or buff at two levels conflicts; different ones do not', () => {
        const shrine = (buffHrid) => ({ type: 'guild_shrine', buffHrid });
        expect(skillingCandidatesConflict(shrine('/a'), shrine('/a'))).toBe(true);
        expect(skillingCandidatesConflict(shrine('/a'), shrine('/b'))).toBe(false);
        expect(skillingCandidatesConflict(shrine('/a'), tokenRow().candidate)).toBe(false);
    });

    test('a later pick replaces the earlier one for its slot', () => {
        const { kept, dropped } = resolveSlotConflicts([a, tokenRow(), b]);

        expect(kept).toEqual([expect.objectContaining({ costType: 'token' }), b]);
        expect(dropped).toEqual([{ row: a, replacedBy: b }]);
    });
});

describe('simulating checked rows together', () => {
    test('a slot conflict is reported and the later pick is the one taken', async () => {
        const a = gearRow('/items/top_a', BODY, 1000, 0.1);
        const b = gearRow('/items/top_b', BODY, 3000, 0.12);
        const legs = gearRow('/items/legs_a', LEGS, 500, 0.08, { currentHrid: '/items/old_legs' });

        const combo = await simulateCombination({
            rows: [a, legs, b],
            baseSetup: baseSetup(),
            evaluate,
            roomLevel: 50,
        });

        expect(combo.kept).toEqual([legs, b]);
        expect(combo.dropped).toEqual([{ row: a, replacedBy: b }]);
        // Base 0.5 at level 50; top_b 0.12 and legs_a 0.08 together
        expect(combo.clearRate).toBeCloseTo(0.7, 10);
        expect(combo.clearRateDelta).toBeCloseTo(0.2, 10);
        expect(combo.costs.gold).toBe(3500);
        expect(combo.goldPerPct).toBe(175);
    });

    test('the combination is re-simmed, not added: a cap that bites shows up', async () => {
        const rows = [
            gearRow('/items/top_a', BODY, 1, 0.1),
            tokenRow({ clearRateDelta: 0.05 }),
            gearRow('/items/legs_a', LEGS, 1, 0.08),
        ];
        const combo = await simulateCombination({
            rows,
            baseSetup: baseSetup(),
            evaluate,
            // Level 5: 0.95 base, so 0.23 of bonus is cut off at 100%
            roomLevel: 5,
        });

        expect(combo.clearRate).toBe(1);
        expect(combo.clearRateDelta).toBeCloseTo(0.05, 10);
        expect(combo.clearRateDelta).toBeLessThan(0.1 + 0.05 + 0.08);
    });

    test('tokens are counted beside the gold, not priced into it', async () => {
        const combo = await simulateCombination({
            rows: [tokenRow(), gearRow('/items/top_a', BODY, 1000, 0.1)],
            baseSetup: baseSetup(),
            evaluate,
            roomLevel: 50,
        });

        expect(combo.costs).toMatchObject({ gold: 1000, tokens: 10, unpriced: 0 });
        expect(renderCombinationHtml(combo)).toContain('1,000 gold + 10 tokens');
    });

    test('an unpriced row is called out rather than counted as free', async () => {
        const combo = await simulateCombination({
            rows: [gearRow('/items/top_a', BODY, null, 0.1)],
            baseSetup: baseSetup(),
            evaluate,
            roomLevel: 50,
        });

        expect(combo.costs.unpriced).toBe(1);
        expect(combo.goldPerPct).toBeNull();
        expect(describeCost(combo.costs)).toContain('unpriced');
    });

    test('measures the room level of the combination when asked', async () => {
        const combo = await simulateCombination({
            rows: [gearRow('/items/top_a', BODY, 1, 0.1)],
            baseSetup: baseSetup(),
            evaluate,
            roomLevel: 50,
            measureMax: async () => ({ cleared: true, maxLevel: 40 }),
        });

        expect(combo.maxRoomLevel).toBe(40);
        expect(combo.floor).toBe(1);
    });
});

describe('the cost a row is paid in', () => {
    test('tokens and cowbells are counted, gold is only what the row is priced in', () => {
        expect(rowCost({ costType: 'token', tokenCost: 5 })).toEqual({ gold: 0, tokens: 5, cowbells: 0 });
        expect(rowCost({ costType: 'community', cowbellCost: 20 })).toEqual({ gold: 0, tokens: 0, cowbells: 20 });
        expect(rowCost({ costType: 'guild', cost: 900, tokenCost: 4 })).toEqual({ gold: 900, tokens: 4, cowbells: 0 });
        expect(rowCost({ costType: 'gold', cost: null }).gold).toBeNull();
    });
});

describe('planning to a goal', () => {
    const plan = (rows, goalRate, extra = {}) =>
        planSkillingGoal({
            baseSetup: baseSetup(),
            rows,
            evaluate,
            goalRoomLevel: 50,
            goalRate,
            yieldFn: async () => {},
            ...extra,
        });

    test('takes the best value first, simmed on top of what is already chosen', async () => {
        // At level 50 the base clear is 0.5
        const cheap = gearRow('/items/legs_a', LEGS, 100, 0.08, { currentHrid: '/items/old_legs' });
        const dear = gearRow('/items/top_a', BODY, 10_000, 0.1);
        const result = await plan([dear, cheap], 0.65);

        expect(result.steps.map((s) => s.row)).toEqual([cheap, dear]);
        expect(result.steps[0].clearRate).toBeCloseTo(0.58, 10);
        expect(result.steps[1].clearRate).toBeCloseTo(0.68, 10);
        expect(result.steps[1].cumulative.gold).toBe(10_100);
        expect(result.reached).toBe(true);
        expect(result.totals.gold).toBe(10_100);
    });

    test('once one upgrade finishes the job, the cheapest finisher wins over the better value', async () => {
        // Far from the goal, `big` is the better value per point (1 gold per 30 pts vs 1 per 10),
        // but `small` alone finishes the job for less
        const big = gearRow('/items/top_a', BODY, 300, 0.3);
        const small = gearRow('/items/legs_a', LEGS, 200, 0.08, { currentHrid: '/items/old_legs' });
        const result = await plan([big, small], 0.58);

        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].row).toBe(small);
    });

    test('a slot is one choice: the second option for it is dropped once the first is taken', async () => {
        const a = gearRow('/items/top_a', BODY, 100, 0.1);
        const b = gearRow('/items/top_b', BODY, 100, 0.12);
        const legs = gearRow('/items/legs_a', LEGS, 100, 0.08, { currentHrid: '/items/old_legs' });
        const result = await plan([a, b, legs], 0.95);

        const bodyPicks = result.steps.filter((s) => s.row.candidate.slot === BODY);
        expect(bodyPicks).toHaveLength(1);
        expect(bodyPicks[0].row).toBe(b);
        expect(result.reached).toBe(false);
    });

    test('says plainly when the candidates cannot get there, with the best it reached', async () => {
        const result = await plan(
            [gearRow('/items/legs_a', LEGS, 100, 0.08, { currentHrid: '/items/old_legs' })],
            0.99
        );

        expect(result.reached).toBe(false);
        expect(result.finalRate).toBeCloseTo(0.58, 10);
        const html = renderPlanHtml(result, { goalText: '99% clear' });
        expect(html).toContain('Not reachable with these candidates (best reached 58.0%)');
    });

    test('reports the goal and its total when it is met', async () => {
        const result = await plan(
            [gearRow('/items/legs_a', LEGS, 250, 0.08, { currentHrid: '/items/old_legs' })],
            0.55
        );
        const html = renderPlanHtml(result, { goalText: '55% clear' });

        expect(html).toContain('Best plan found reaches the goal at total 250 gold');
        expect(html).toContain('data-plan-step="1"');
    });

    test('a goal already met needs no purchases', async () => {
        const result = await plan([gearRow('/items/top_a', BODY, 100, 0.1)], 0.4);

        expect(result.steps).toEqual([]);
        expect(result.reached).toBe(true);
    });

    test('an upgrade that moves nothing at the goal level is never bought', async () => {
        const dud = gearRow('/items/old_body', BODY, 1, 0.05, { upgradeHrid: '/items/old_body', upgradeLevel: 0 });
        const result = await plan([dud], 0.9);

        expect(result.steps).toEqual([]);
    });

    test('token upgrades are weighed too, and counted rather than priced', async () => {
        const result = await plan([tokenRow()], 0.55);

        expect(result.steps[0].cost).toEqual({ gold: 0, tokens: 10, cowbells: 0 });
        expect(describeCost(result.totals)).toBe('10 tokens');
    });

    test('measures each step’s max room level when asked', async () => {
        const levels = [30, 45];
        const result = await plan(
            [
                gearRow('/items/legs_a', LEGS, 100, 0.08, { currentHrid: '/items/old_legs' }),
                gearRow('/items/top_a', BODY, 100, 0.1),
            ],
            0.65,
            { measureMax: async () => ({ cleared: true, maxLevel: levels.shift() }) }
        );

        expect(result.steps.map((s) => s.maxRoomLevel)).toEqual([30, 45]);
        expect(result.steps.map((s) => s.floor)).toEqual([0, 1]);
    });

    test('a cancel stops it and the verdict says it stopped early', async () => {
        let polls = 0;
        const result = await plan([gearRow('/items/top_a', BODY, 100, 0.1)], 0.9, { abortSignal: () => ++polls > 0 });

        expect(result.aborted).toBe(true);
        expect(renderPlanHtml(result, { goalText: 'x' })).toContain('Stopped early');
    });

    test('simulations per plan are bounded: one ranking pass, then the pool per step', async () => {
        const setup = baseSetup();
        const rows = Array.from({ length: 40 }, (_, i) => {
            setup.dto.equipment[`/equipment_types/slot_${i}`] = { hrid: '/items/old_body', enhancementLevel: 0 };
            return gearRow('/items/old_body', `/equipment_types/slot_${i}`, 100 + i, 0.001, {
                upgradeHrid: '/items/old_body',
                upgradeLevel: 1,
            });
        });
        const result = await plan(rows, 0.99, { candidateCap: 5, baseSetup: setup });

        expect(result.poolSize).toBe(5);
        // One baseline, one ranking sim per row, then at most five trials a step over five steps
        expect(result.sims).toBeLessThanOrEqual(1 + 40 + 5 * 5);
    });
});

describe('the candidates a plan weighs', () => {
    test('priced rows are capped at the best by gold per point; unpriced token rows are always in', () => {
        const rows = [
            gearRow('/items/a', 'slot_1', 1000, 0.1),
            gearRow('/items/b', 'slot_2', 100, 0.1),
            gearRow('/items/c', 'slot_3', 500, 0.1),
            tokenRow(),
        ];
        const pool = selectPlanPool(rows, 2);

        expect(pool).toHaveLength(3);
        expect(pool[0].costType).toBe('token');
        expect(pool.slice(1).map((r) => r.cost)).toEqual([100, 500]);
    });

    test('rows that did not help, or only moved XP, are not candidates', () => {
        const rows = [
            gearRow('/items/a', 'slot_1', 1, 0),
            tokenRow({ metricType: 'xpPerRoom', clearRateDelta: 0.2 }),
            gearRow('/items/b', 'slot_2', 1, -0.02),
        ];

        expect(selectPlanPool(rows)).toEqual([]);
    });

    test('an unpriced row ranks after every priced one', () => {
        const rows = [gearRow('/items/a', 'slot_1', null, 0.5), gearRow('/items/b', 'slot_2', 9999, 0.01)];

        expect(selectPlanPool(rows).map((r) => r.cost)).toEqual([9999, null]);
    });
});

describe('one row per physical item', () => {
    const SKILLS = ['/skills/milking', '/skills/foraging', '/skills/woodcutting', '/skills/cooking'];
    const BACK = '/equipment_types/back';

    /** Each room's clear rate: 0.5, plus 0.04 when its own kit wears the cape. */
    function perRoom(setup) {
        const results = SKILLS.map((skillHrid) => {
            const kit = setup.skillEquipmentMap[skillHrid] || setup.dto.equipment;
            const worn = kit[BACK]?.hrid === '/items/cape';
            return {
                skillHrid,
                skillName: skillHrid.replace('/skills/', ''),
                roomLevel: 50,
                clearChance: 0.5 + (worn ? 0.04 : 0),
                xpPerRoom: 10,
            };
        });
        return averageSkillingResults(results);
    }
    const evaluateRooms = (setup) => perRoom(setup);
    const kitSetup = () => ({
        dto: { equipment: { [BACK]: { hrid: '/items/old_cape', enhancementLevel: 0 } } },
        skillEquipmentMap: Object.fromEntries(
            SKILLS.map((s) => [s, { [BACK]: { hrid: '/items/old_cape', enhancementLevel: 0 } }])
        ),
    });
    const capeRow = (skill, cost = 1000) => ({
        candidate: {
            type: 'skilling_gear',
            skillKey: skill,
            slot: BACK,
            currentHrid: '/items/old_cape',
            currentLevel: 0,
            upgradeHrid: '/items/cape',
            upgradeLevel: 5,
            description: `Old Cape → Gatherer Cape +5 (${skill.replace('/skills/', '')})`,
        },
        costType: 'gold',
        cost,
        // Each part counts its one room out of four
        clearRate: 0.51,
        clearRateDelta: 0.01,
        metricType: 'clearRate',
    });

    const analysis = () => ({
        baseline: { clearRate: 0.5 },
        results: [
            capeRow('/skills/milking'),
            capeRow('/skills/foraging', 1200),
            capeRow('/skills/woodcutting'),
            gearRow('/items/other', '/equipment_types/neck', 5, 0.02),
        ],
    });

    test('the per-skill rows of one item become a single row applied to every skill it serves', () => {
        const result = analysis();
        const added = mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });

        expect(added).toBe(1);
        const merged = result.results.find((r) => r.candidate.merged);
        expect(merged.candidate.description).toBe('Old Cape → Gatherer Cape +5 (milking, foraging, woodcutting)');
        // Three of the four rooms gain 0.04 each: 0.03 on the average, not 0.01
        expect(merged.clearRateDelta).toBeCloseTo(0.03, 10);
        expect(merged.clearRate).toBeCloseTo(0.53, 10);
        // One copy is bought: the dearest part's price, not the sum
        expect(merged.cost).toBe(1200);
        // The halves no longer rank as if each were the whole
        expect(result.results.filter((r) => r.candidate.skillKey)).toEqual([]);
        expect(result.results).toHaveLength(2);
    });

    test('a single-skill item, or two different items for one slot, are left as they are', () => {
        const result = {
            results: [
                capeRow('/skills/milking'),
                {
                    ...capeRow('/skills/foraging'),
                    candidate: { ...capeRow('/skills/foraging').candidate, upgradeHrid: '/items/x' },
                },
            ],
        };
        const added = mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });

        expect(added).toBe(0);
        expect(result.results).toHaveLength(2);
    });

    test('a merged row is one choice for its slot: it conflicts with a part of itself and with a rival cape', () => {
        const result = analysis();
        mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });
        const merged = result.results.find((r) => r.candidate.merged);

        expect(skillingCandidatesConflict(merged.candidate, capeRow('/skills/milking').candidate)).toBe(true);
        expect(skillingCandidatesConflict(merged.candidate, gearRow('/items/other_cape', BACK, 1, 0.1).candidate)).toBe(
            true
        );
        expect(
            skillingCandidatesConflict(merged.candidate, gearRow('/items/x', '/equipment_types/neck', 1, 0.1).candidate)
        ).toBe(false);
    });

    test('the planner and Sim together use the merged row and count its price once', async () => {
        const result = analysis();
        mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });

        const combo = await simulateCombination({
            rows: result.results.filter((r) => r.candidate.merged),
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });
        expect(combo.clearRateDelta).toBeCloseTo(0.03, 10);
        expect(combo.costs.gold).toBe(1200);

        const plan = await planSkillingGoal({
            baseSetup: kitSetup(),
            rows: result.results,
            evaluate: evaluateRooms,
            goalRoomLevel: 50,
            goalRate: 0.53,
            yieldFn: async () => {},
        });
        expect(plan.reached).toBe(true);
        expect(plan.steps.map((s) => s.row.candidate.merged)).toEqual([true]);
        expect(plan.totals.gold).toBe(1200);
    });

    test('the breakdown lists every room: moved ones before to after, the rest as unaffected', () => {
        const result = analysis();
        mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });
        const merged = result.results.find((r) => r.candidate.merged);

        const lines = skillBreakdown({
            baseSetup: kitSetup(),
            candidate: merged.candidate,
            evaluate: evaluateRooms,
            roomLevel: 50,
        });

        expect(lines.map((l) => [l.skillName, l.affected])).toEqual([
            ['milking', true],
            ['foraging', true],
            ['woodcutting', true],
            ['cooking', false],
        ]);
        expect(lines[0]).toMatchObject({ before: 0.5, after: 0.54 });
        expect(lines[0].triesBefore).toBeCloseTo(2, 10);

        const html = renderSkillBreakdownHtml(lines);
        expect(html).toContain('50.0% → 54.0%');
        expect(html).toContain('tries');
        expect(html).toContain('unaffected — 50.0% unchanged');
    });

    test('each gear row says how many rooms it moves and what it does to the tries', async () => {
        const result = analysis();
        mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
        });
        await annotateRoomsReached({
            rows: result.results,
            baseSetup: kitSetup(),
            evaluate: evaluateRooms,
            roomLevel: 50,
            yieldFn: async () => {},
        });
        const merged = result.results.find((r) => r.candidate.merged);

        expect(merged.rooms).toEqual({ affected: 3, total: 4 });
        // Four rooms at 2 tries each is 8; three of them at 1/0.54 is about 7.56
        expect(merged.triesDelta).toBeCloseTo(3 * (1 / 0.54 - 2), 8);
        expect(merged.tries).toBeCloseTo(2 + 3 / 0.54, 8);
        expect(merged.breakdownLines).toHaveLength(4);
        const neck = result.results.find((r) => r.candidate.slot === '/equipment_types/neck');
        expect(neck.rooms.affected).toBe(0);
    });
});

describe('plan quality at the goal level', () => {
    const SLOTS = { a: '/equipment_types/body', b: '/equipment_types/legs', c: '/equipment_types/feet' };
    const BONUS = { '/items/a': 0.3, '/items/b': 0.2, '/items/c': 0.2 };
    const setup = () => ({
        dto: {
            equipment: Object.fromEntries(
                Object.values(SLOTS).map((slot) => [slot, { hrid: '/items/none', enhancementLevel: 0 }])
            ),
        },
        skillEquipmentMap: {},
    });
    const evaluateBonus = (s, level) => {
        const levelValue = typeof level === 'object' ? Math.max(...Object.values(level)) : level;
        const gear = Object.values(s.dto.equipment).reduce((sum, w) => sum + (BONUS[w.hrid] || 0), 0);
        return { clearRate: Math.min(1, Math.max(0, 1 - levelValue / 100 + gear)), xpPerRoom: 0 };
    };
    const swap = (key, cost, delta) =>
        gearRow(`/items/${key}`, SLOTS[key], cost, delta, { currentHrid: '/items/none', description: `Get ${key}` });

    test('a row that shows no gain at the analyzed level is still weighed at the floor’s exit level', async () => {
        // The table was measured where the character already clears everything, so every
        // delta reads 0 there; at the goal's level they matter
        const rows = [swap('a', 400, 0), swap('b', 300, 0)];
        const result = await planSkillingGoal({
            baseSetup: setup(),
            rows,
            evaluate: evaluateBonus,
            goalRoomLevel: 90,
            goalRate: 0.2,
            yieldFn: async () => {},
        });

        expect(result.reached).toBe(true);
        expect(result.steps.map((s) => s.row)).toEqual([rows[1]]);
    });

    test('a better pair beats the greedy pick: a 4-cost 0.30 upgrade over two 3-cost 0.20 ones for 0.40', async () => {
        const rows = [swap('a', 4, 0.3), swap('b', 3, 0.2), swap('c', 3, 0.2)];
        const result = await planSkillingGoal({
            baseSetup: setup(),
            rows,
            evaluate: evaluateBonus,
            // Base is 0.1 at this level; the goal is 0.5
            goalRoomLevel: 90,
            goalRate: 0.5,
            yieldFn: async () => {},
        });

        expect(result.reached).toBe(true);
        expect(result.improved).toBe(true);
        expect(result.totals.gold).toBe(6);
        expect(result.steps.map((s) => s.row).sort()).toEqual([rows[1], rows[2]].sort());
        expect(result.improveSims).toBeGreaterThan(0);
        expect(result.steps.at(-1).clearRate).toBeGreaterThanOrEqual(0.5 - 1e-9);
        const html = renderPlanHtml(result, { goalText: '50%' });
        expect(html).toContain('Best plan found');
        expect(html).toContain(`${result.sims} simulations`);
    });

    test('the improvement pass is bounded', async () => {
        const rows = [swap('a', 4, 0.3), swap('b', 3, 0.2), swap('c', 3, 0.2)];
        const result = await planSkillingGoal({
            baseSetup: setup(),
            rows,
            evaluate: evaluateBonus,
            goalRoomLevel: 90,
            goalRate: 0.5,
            yieldFn: async () => {},
        });

        expect(result.improveSims).toBeLessThanOrEqual(120);
    });
});

describe('pricing a merged multi-skill item once', () => {
    const BACK = '/equipment_types/back';
    const piece = (skill, current, over = {}) => ({
        costType: 'gold',
        cost: 900,
        clearRateDelta: 0.01,
        metricType: 'clearRate',
        ...over,
        candidate: {
            type: 'skilling_gear',
            skillKey: skill,
            slot: BACK,
            currentHrid: current,
            currentLevel: 0,
            upgradeHrid: '/items/cape',
            upgradeLevel: 5,
            description: `Cape (${skill.replace('/skills/', '')})`,
            ...over.candidate,
        },
    });
    const kit = (hrid) => ({ [BACK]: { hrid, enhancementLevel: 0 } });
    const setup = () => ({
        dto: { equipment: kit('/items/c0') },
        skillEquipmentMap: {
            '/skills/milking': kit('/items/c1'),
            '/skills/foraging': kit('/items/c2'),
            '/skills/woodcutting': kit('/items/c3'),
        },
    });
    const evaluate = () => ({ clearRate: 0.5, xpPerRoom: 0, perSkill: [] });

    test('the single purchase is credited with every distinct piece the kits give up', () => {
        // Each part alone: buy 1000, sell its own piece for 100 = 900. Bought once, three
        // different pieces go back: 1000 - 300
        const price = vi
            .spyOn(upgradeAdvisor, 'calculateUpgradeCost')
            .mockImplementation((candidate) => 1000 - 100 * (candidate.removedItems?.length || 0));
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const result = {
            results: [
                piece('/skills/milking', '/items/c1'),
                piece('/skills/foraging', '/items/c2'),
                piece('/skills/woodcutting', '/items/c3'),
            ],
        };
        mergeMultiSkillGearRows({ analysisResult: result, baseSetup: setup(), evaluate, roomLevel: 50, gameData: {} });
        price.mockRestore();
        explain.mockRestore();

        expect(result.results).toHaveLength(1);
        expect(result.results[0].cost).toBe(700);
    });

    test('a displaced piece shared by several kits is credited once', () => {
        const price = vi
            .spyOn(upgradeAdvisor, 'calculateUpgradeCost')
            .mockImplementation((candidate) => 1000 - 100 * (candidate.removedItems?.length || 0));
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const result = { results: [piece('/skills/milking', '/items/c1'), piece('/skills/foraging', '/items/c1')] };
        mergeMultiSkillGearRows({ analysisResult: result, baseSetup: setup(), evaluate, roomLevel: 50, gameData: {} });
        price.mockRestore();
        explain.mockRestore();

        expect(result.results[0].cost).toBe(900);
    });

    test('enhancing a copy already owned competes, and the cheaper route wins', () => {
        const price = vi.spyOn(upgradeAdvisor, 'calculateUpgradeCost').mockReturnValue(5000);
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const owned = piece('/skills/milking', '/items/cape', {
            cost: 400,
            candidate: { type: 'enhancement', currentLevel: 2 },
        });
        const result = { results: [owned, piece('/skills/foraging', '/items/c2')] };
        mergeMultiSkillGearRows({ analysisResult: result, baseSetup: setup(), evaluate, roomLevel: 50, gameData: {} });
        price.mockRestore();
        explain.mockRestore();

        expect(result.results[0].cost).toBe(400);
    });

    test('the owned-copy route also frees the other kits’ pieces', () => {
        // Enhancing the held copy costs 400 on its own, but the foraging and woodcutting
        // kits would each hand back a different piece, as on the buy route (100 each)
        const price = vi
            .spyOn(upgradeAdvisor, 'calculateUpgradeCost')
            .mockImplementation((candidate) => 1000 - 100 * (candidate.removedItems?.length || 0));
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const owned = piece('/skills/milking', '/items/cape', {
            cost: 400,
            candidate: { type: 'enhancement', currentLevel: 2 },
        });
        const result = {
            results: [owned, piece('/skills/foraging', '/items/c2'), piece('/skills/woodcutting', '/items/c3')],
        };
        mergeMultiSkillGearRows({ analysisResult: result, baseSetup: setup(), evaluate, roomLevel: 50, gameData: {} });
        price.mockRestore();
        explain.mockRestore();

        expect(result.results[0].cost).toBe(200);
    });

    test('the owned-copy row’s breakdown itemizes the sales and totals to its cost', () => {
        const price = vi
            .spyOn(upgradeAdvisor, 'calculateUpgradeCost')
            .mockImplementation((candidate) => 1000 - 100 * (candidate.removedItems?.length || 0));
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const owned = piece('/skills/milking', '/items/cape', {
            cost: 400,
            costDetail: { buys: [{ name: 'Cape', price: 400 }], credits: [], gross: 400, credit: 0, net: 400 },
            candidate: { type: 'enhancement', currentLevel: 2 },
        });
        const result = {
            results: [owned, piece('/skills/foraging', '/items/c2'), piece('/skills/woodcutting', '/items/c3')],
        };
        mergeMultiSkillGearRows({ analysisResult: result, baseSetup: setup(), evaluate, roomLevel: 50, gameData: {} });
        price.mockRestore();
        explain.mockRestore();

        const row = result.results[0];
        const detail = row.costDetail;
        expect(row.cost).toBe(200);
        expect(detail.credits.map((c) => c.hrid).sort()).toEqual(['/items/c2', '/items/c3']);
        expect(detail.gross - detail.credit).toBe(row.cost);
        expect(detail.net).toBe(row.cost);
        expect(detail.credits.reduce((sum, c) => sum + c.price, 0)).toBe(detail.credit);
    });

    test('with no price anywhere the merged row is unpriced, not free', () => {
        const price = vi.spyOn(upgradeAdvisor, 'calculateUpgradeCost').mockReturnValue(null);
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const result = { results: [piece('/skills/milking', '/items/c1'), piece('/skills/foraging', '/items/c2')] };
        mergeMultiSkillGearRows({ analysisResult: result, baseSetup: setup(), evaluate, roomLevel: 50, gameData: {} });
        price.mockRestore();
        explain.mockRestore();

        expect(result.results[0].cost).toBeNull();
    });
});

describe('cowbells break a tie at no gold and no tokens', () => {
    const buff = (key, cowbells) => ({
        candidate: { type: 'community_buff', buffKey: key, upgradeLevel: 1, description: key },
        costType: 'community',
        cowbellCost: cowbells,
        clearRateDelta: 0.1,
        metricType: 'clearRate',
    });
    const evaluateBuffs = (setup) => {
        const levels = setup.dto.communityBuffLevels || {};
        return { clearRate: 0.5 + (levels.a ? 0.1 : 0) + (levels.b ? 0.1 : 0), xpPerRoom: 0 };
    };
    const run = (rows, extra = {}) =>
        planSkillingGoal({
            baseSetup: { dto: { communityBuffLevels: {} }, skillEquipmentMap: {} },
            rows,
            evaluate: evaluateBuffs,
            goalRoomLevel: 50,
            goalRate: 0.6,
            yieldFn: async () => {},
            ...extra,
        });

    test('the 10-cowbell buff is chosen over an equally sufficient 100-cowbell one', async () => {
        const result = await run([buff('a', 100), buff('b', 10)]);

        expect(result.steps.map((step) => step.row.candidate.buffKey)).toEqual(['b']);
        expect(result.totals.cowbells).toBe(10);
    });
});

describe('a jewelry swap offered once per kit is one purchase', () => {
    const NECK = '/equipment_types/neck';
    const kits = ['/skills/milking', '/skills/foraging'];
    const necklace = (hrid) => ({ [NECK]: { hrid, enhancementLevel: 0 } });
    const setup = () => ({
        dto: { equipment: necklace('/items/plain') },
        skillEquipmentMap: { [kits[0]]: necklace('/items/n1'), [kits[1]]: necklace('/items/n2') },
    });
    const tierRow = (current) => ({
        candidate: {
            type: 'tier',
            slot: NECK,
            currentHrid: current,
            currentLevel: 0,
            upgradeHrid: '/items/philo',
            upgradeLevel: 5,
            description: `${current} → Philosopher's Necklace +5`,
        },
        costType: 'gold',
        cost: 900,
        clearRateDelta: 0.02,
        metricType: 'clearRate',
    });
    /** Each kit's room gains 0.04 when its own kit wears the Philosopher's necklace. */
    const evaluateKits = (s) => {
        const perSkill = kits.map((skillHrid) => ({
            skillHrid,
            skillName: skillHrid,
            roomLevel: 50,
            clearChance: 0.5 + (s.skillEquipmentMap[skillHrid][NECK].hrid === '/items/philo' ? 0.04 : 0),
        }));
        return averageSkillingResults(perSkill.map((p) => ({ ...p, xpPerRoom: 0 })));
    };

    test('per-kit tier rows merge, are measured on every room, and are priced as one acquisition', () => {
        const price = vi
            .spyOn(upgradeAdvisor, 'calculateUpgradeCost')
            .mockImplementation((candidate) => 1000 - 100 * (candidate.removedItems?.length || 0));
        const explain = vi.spyOn(upgradeAdvisor, 'explainUpgradeCost').mockReturnValue({});
        const result = { results: [tierRow('/items/n1'), tierRow('/items/n2')] };
        mergeMultiSkillGearRows({
            analysisResult: result,
            baseSetup: setup(),
            evaluate: evaluateKits,
            roomLevel: 50,
            gameData: {},
        });
        price.mockRestore();
        explain.mockRestore();

        expect(result.results).toHaveLength(1);
        const [merged] = result.results;
        expect(merged.candidate.merged).toBe(true);
        // Both rooms gain 0.04: 0.04 on the average, where each row alone showed 0.02
        expect(merged.clearRateDelta).toBeCloseTo(0.04, 10);
        // Bought once, two different necklaces sold back
        expect(merged.cost).toBe(800);
    });
});
