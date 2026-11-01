/**
 * Timings for the skill-goal quick estimate and the leveling-route search.
 *
 * Skipped unless `PLANNER_BENCH=1`: wall-clock numbers are not assertions, and a
 * shared CI box would make any threshold flaky. Run it on its own:
 *
 *     PLANNER_BENCH=1 node_modules/.bin/vitest run src/features/planner/goal-planner.bench.test.js
 *
 * Each case is timed cold (first call) and warm (median of the following runs).
 * The level table grows geometrically like the game's, so a 1 → 200 climb walks
 * every level the way a real one does.
 */

import { describe, test, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import { planGoal } from './goal-planner.js';
import { prepareRouteInput, runRouteSearch } from './leveling-route.js';

const BENCH = Boolean(globalThis.process?.env.PLANNER_BENCH);
/** `ROUTE_CAP=n` tries another within-budget frontier cap */
const CAP = globalThis.process?.env.ROUTE_CAP ? { frontierCap: Number(globalThis.process?.env.ROUTE_CAP) } : {};

/** Cumulative experience per level, growing ~9.5% a level like the game's table */
const LEVEL_TABLE = (() => {
    const table = [0, 0];
    let step = 33;
    for (let level = 2; level <= 200; level += 1) {
        table.push(Math.round(table[level - 1] + step));
        step *= 1.095;
    }
    return table;
})();

/**
 * A skill's worth of actions, one unlocking every few levels.
 * @param {number} count - How many actions
 * @returns {Array<Object>} Rates in the shape `measureXpRates` returns
 */
function rates(count) {
    return Array.from({ length: count }, (_, index) => {
        const requiredLevel = 1 + Math.floor((index * 199) / count);
        const xpPerAction = 10 + requiredLevel * 2;
        const actionTime = 6 + (index % 5);
        const actionsPerHour = 3600 / actionTime;
        return {
            actionHrid: `/actions/cooking/dish_${index}`,
            label: `Dish ${index}`,
            requiredLevel,
            teaSkillLevelBonus: 0,
            actionLevelBonus: 0,
            xpPerHour: actionsPerHour * xpPerAction,
            xpPerAction,
            actionTime,
            totalEfficiency: 10,
            actionsPerHour,
            goldPerHour: -1000 * requiredLevel,
            drinkCostPerHour: 500,
            upfrontCost: 50 * requiredLevel,
            goldKnown: true,
        };
    });
}

/**
 * @param {number} level - Starting level
 * @param {number} target - Target level
 * @param {Array<Object>} list - Rates
 * @returns {Object} A planning context
 */
function context(level, target, list) {
    return {
        now: 0,
        gold: 1e12,
        levelExperienceTable: LEVEL_TABLE,
        skillName: () => 'Cooking',
        skill: () => ({ level, experience: LEVEL_TABLE[level] }),
        owned: () => 0,
        goldRates: () => [],
        xpRates: () => list,
    };
}

/**
 * @param {Function} fn - Work to time
 * @param {number} runs - Warm repetitions
 * @returns {{cold: number, warm: number}} Milliseconds
 */
export function time(fn, runs = 50) {
    const start = performance.now();
    fn();
    const cold = performance.now() - start;
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
        const t0 = performance.now();
        fn();
        samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return { cold, warm: samples[Math.floor(samples.length / 2)] };
}

/**
 * Print timing lines past Vitest's console capture.
 * @param {Array<string>} lines - Lines to print
 */
export function report(lines) {
    globalThis.process.stderr.write(`${lines.join('\n')}\n`);
}

export const BENCH_CASES = [
    { name: 'short goal (50→60), 6 actions', level: 50, target: 60, count: 6 },
    { name: 'short goal (50→60), 60 actions', level: 50, target: 60, count: 60 },
    { name: 'long goal (1→200), 6 actions', level: 1, target: 200, count: 6 },
    { name: 'long goal (1→200), 60 actions', level: 1, target: 200, count: 60 },
];

export { LEVEL_TABLE, rates, context };

describe.skipIf(!BENCH)('quick estimate timings', () => {
    beforeAll(() => {
        globalThis.math = mathjs;
    });

    test('planSkillGoal', () => {
        const lines = [];
        for (const { name, level, target, count } of BENCH_CASES) {
            const list = rates(count);
            const goal = { type: 'skill', skillHrid: '/skills/cooking', targetLevel: target };
            const { cold, warm } = time(() => planGoal(goal, context(level, target, list)));
            lines.push(`quick estimate | ${name} | cold ${cold.toFixed(3)} ms | warm ${warm.toFixed(3)} ms`);
        }
        report(lines);
    });
});

describe.skipIf(!BENCH)('route search timings', () => {
    beforeAll(() => {
        globalThis.math = mathjs;
    });

    test('runRouteSearch, straight through and sliced', async () => {
        const lines = [];
        for (const { name, level, target, count } of BENCH_CASES) {
            const input = prepareRouteInput({
                skillHrid: '/skills/cooking',
                targetLevel: target,
                level,
                experience: LEVEL_TABLE[level],
                rates: rates(count).map((rate) => ({ ...rate, measuredAtLevel: level })),
                table: LEVEL_TABLE,
                // Tight enough that the within-budget frontier has real trade-offs in it
                gold: 2_000_000,
            });
            const samples = [];
            let result = null;
            for (let i = 0; i < 5; i += 1) {
                const t0 = performance.now();
                result = await runRouteSearch(input, CAP);
                samples.push(performance.now() - t0);
            }
            const cold = samples[0];
            const warm = [...samples.slice(1)].sort((a, b) => a - b)[1];

            // Sliced the way the panel runs it: the longest stretch between yields is the stall
            let longest = 0;
            let last = performance.now();
            let stopAsked = null;
            const sliced = await runRouteSearch(input, {
                yieldToBrowser: async () => {
                    const at = performance.now();
                    longest = Math.max(longest, at - last);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    last = performance.now();
                },
                shouldStop: () => false,
                ...CAP,
            });
            // Cancellation latency: ask to stop, see how long until the search returns
            let stopAt = 0;
            const stopped = await runRouteSearch(input, {
                yieldToBrowser: async () => {
                    if (!stopAsked) stopAsked = performance.now();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                },
                shouldStop: () => {
                    stopAt = performance.now();
                    return stopAsked !== null;
                },
                ...CAP,
            });
            const cancelMs = stopped.status === 'stopped' ? stopAt - stopAsked : NaN;
            lines.push(
                `route search | ${name} | cold ${cold.toFixed(1)} ms | warm ${warm.toFixed(1)} ms | ` +
                    `segments ${result.stats.segments} | bounded ${result.bounded} | ` +
                    `longest slice ${longest.toFixed(1)} ms | stop ${Number.isFinite(cancelMs) ? cancelMs.toFixed(1) : 'n/a'} ms | ` +
                    `${sliced.status}`
            );
        }
        report(lines);
    });
});
