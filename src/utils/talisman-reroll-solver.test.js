import { describe, test, expect } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../__fixtures__/talisman-reroll.js';
import {
    advise,
    buildProblem,
    countStates,
    CLAMP_STATE_LIMIT,
    encodeLines,
    focusMultiplier,
    gradeOdds,
    isFocusable,
    meetsTarget,
    solve,
    REROLL_MODES,
} from './talisman-reroll-solver.js';

const M = (name) => `/talisman_modifiers/${name}`;
const COMBAT = '/talisman_types/combat';
const SKILLING = '/talisman_types/skilling';
const VALUE_WEIGHTS = Object.fromEntries(Object.entries(ORB_ITEMS).map(([hrid, item]) => [hrid, item.sellPrice]));
const BINDING = TALISMAN_INFO.lockInputItemHrid;

function problemFor(targets, lineCount, { type = COMBAT, weights = VALUE_WEIGHTS } = {}) {
    return buildProblem({
        talismanTypeHrid: type,
        lineCount,
        targets,
        info: TALISMAN_INFO,
        modifierDetailMap: REROLL_MODIFIERS,
        weights,
    });
}

const solved = new Map();
function solutionFor(targets, lineCount, options = {}) {
    const key = JSON.stringify([targets, lineCount, options.type, options.weights]);
    if (!solved.has(key)) {
        const built = problemFor(targets, lineCount, options);
        expect(built.status).toBe('ok');
        solved.set(key, solve(built.problem));
    }
    return solved.get(key);
}

const line = (name, grade) => ({ hrid: M(name), grade });

describe('game data reading', () => {
    test('a cap cuts the measured curve and renormalizes', () => {
        const capped = gradeOdds(4);
        expect(capped).toHaveLength(4);
        expect(capped.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
        expect(capped[0]).toBeCloseTo(0.51 / 0.958, 6);
        expect(gradeOdds(6).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    });

    test('grades are tracked up to G6 unless the target is too large, and a clamp is flagged', () => {
        const small = problemFor([{ hrid: M('armor'), minGrade: 3 }], 3);
        expect(small.problem).toMatchObject({ G: 6, gradeClamped: false });
        expect(countStates(3, 1, 6)).toBeLessThanOrEqual(CLAMP_STATE_LIMIT);
        const large = problemFor(
            ['armor', 'ability_damage', 'smite', 'ability_haste'].map((name) => ({ hrid: M(name), minGrade: 5 })),
            4
        );
        expect(large.problem).toMatchObject({ G: 5, gradeClamped: true });
        // The count matches the states the solver enumerates
        expect(solutionFor([{ hrid: M('armor'), minGrade: 3 }], 2).stateCount).toBe(countStates(2, 1, 6));
    });

    test('focus weight comes from the data; Special-group lines cannot be focused', () => {
        expect(focusMultiplier(TALISMAN_INFO)).toBe(5);
        expect(isFocusable(REROLL_MODIFIERS[M('smite')])).toBe(false);
        expect(isFocusable(REROLL_MODIFIERS[M('armor')])).toBe(true);
    });
});

describe('targets that cannot be solved', () => {
    test('no target, an empty talisman, no orbs', () => {
        expect(problemFor([], 4).status).toBe('noTarget');
        expect(problemFor([{ hrid: M('armor'), minGrade: 2 }], 0).status).toBe('empty');
        expect(problemFor([{ hrid: M('armor'), minGrade: 2 }], 2, { weights: {} }).status).toBe('noOrbs');
    });

    test('one type wanted twice (a talisman never holds a type twice)', () => {
        const result = problemFor(
            [
                { hrid: M('armor'), minGrade: 2 },
                { hrid: M('armor'), minGrade: 3 },
            ],
            4
        );
        expect(result).toMatchObject({ status: 'impossible', reason: 'duplicate' });
    });

    test('a type outside the pool, a grade above the cap, more lines than the talisman has', () => {
        expect(problemFor([{ hrid: M('milking_speed'), minGrade: 1 }], 4)).toMatchObject({ reason: 'notInPool' });
        expect(problemFor([{ hrid: M('armor'), minGrade: 7 }], 4)).toMatchObject({ reason: 'gradeAboveCap' });
        expect(
            problemFor(
                [
                    { hrid: M('armor'), minGrade: 1 },
                    { hrid: M('melee_evasion'), minGrade: 1 },
                ],
                1
            )
        ).toMatchObject({ reason: 'needsMoreLines' });
    });

    test('orbs that never change a type cannot reach a missing type', () => {
        const weights = { '/items/attunement_orb': 1, '/items/exchange_orb': 1 };
        const targets = [{ hrid: M('armor'), minGrade: 1 }];
        const solution = solutionFor(targets, 2, { weights });
        const advice = advise(solution, talismanRow(1, [line('melee_evasion', 3), line('melee_accuracy', 2)]), targets);
        expect(advice.status).toBe('unreachable');
    });
});

describe('hard rules', () => {
    const targets = [
        { hrid: M('ability_damage'), minGrade: 3 },
        { hrid: M('armor'), minGrade: 3 },
    ];

    test('a met target says so and recommends nothing', () => {
        const solution = solutionFor(targets, 4);
        const talisman = talismanRow(1, [
            line('armor', 5),
            line('melee_evasion', 1),
            line('ability_damage', 3),
            line('melee_accuracy', 1),
        ]);
        expect(advise(solution, talisman, targets)).toMatchObject({ status: 'met', counts: {} });
    });

    test('a pending result that meets the target is always taken', () => {
        const solution = solutionFor(targets, 4);
        const talisman = talismanRow(
            1,
            [line('armor', 6), line('melee_evasion', 6), line('ability_damage', 2), line('melee_accuracy', 6)],
            {
                pendingModifiers: [
                    line('armor', 3),
                    line('magic_damage', 1),
                    line('ability_damage', 3),
                    line('smite', 1),
                ],
            }
        );
        expect(advise(solution, talisman, targets)).toMatchObject({ status: 'accept', met: true });
    });

    test('a pending result worse than the current lines is kept away; a better one is used', () => {
        const solution = solutionFor(targets, 4);
        const current = [
            line('armor', 4),
            line('melee_evasion', 1),
            line('melee_accuracy', 1),
            line('magic_damage', 1),
        ];
        const worse = [
            line('ranged_accuracy', 1),
            line('melee_evasion', 1),
            line('melee_accuracy', 2),
            line('magic_damage', 1),
        ];
        expect(advise(solution, talismanRow(1, current, { pendingModifiers: worse }), targets).status).toBe('discard');
        // The other way round: the pending roll holds the wanted line the current one lacks
        const accepted = advise(solution, talismanRow(1, worse, { pendingModifiers: current }), targets);
        expect(accepted.status).toBe('accept');
        expect(accepted.value).toBeLessThan(accepted.otherValue);
    });

    test('a pending roll never replaces lines that already meet the target', () => {
        const solution = solutionFor(targets, 4);
        const current = [
            line('armor', 3),
            line('ability_damage', 3),
            line('melee_accuracy', 1),
            line('magic_damage', 1),
        ];
        const pending = [
            line('armor', 2),
            line('ability_damage', 6),
            line('melee_accuracy', 6),
            line('magic_damage', 6),
        ];
        expect(advise(solution, talismanRow(1, current, { pendingModifiers: pending }), targets).status).toBe(
            'discard'
        );
    });

    test('a line that meets its slot is locked before rerolling, unless the solver shows locking costs more', () => {
        const solution = solutionFor(targets, 4);
        const modifiers = [
            line('armor', 4),
            line('melee_evasion', 1),
            line('melee_accuracy', 1),
            line('magic_damage', 1),
        ];
        const advice = advise(solution, talismanRow(1, modifiers), targets);
        const locked = encodeLines(solution, modifiers, M('armor')).index;
        const lockValue = solution.V[locked] + VALUE_WEIGHTS[BINDING];
        // Whatever is recommended is no dearer than locking the met line
        expect(advice.value).toBeLessThanOrEqual(lockValue + 1e-6);
        // and with full rerolls this cheap next to a Binding Orb, locking is the move
        expect(advice.move).toEqual({ kind: 'lock', itemHrid: BINDING, modifierHrid: M('armor') });
    });

    test('a locked line already in place is kept and the next orb is rerolled', () => {
        const solution = solutionFor(targets, 4);
        const talisman = talismanRow(
            1,
            [line('armor', 4), line('melee_evasion', 1), line('melee_accuracy', 1), line('magic_damage', 1)],
            { lockedModifierHrid: M('armor') }
        );
        const advice = advise(solution, talisman, targets);
        expect(advice.status).toBe('move');
        expect(advice.move.kind).toBe('orb');
        expect(advice.counts[BINDING] || 0).toBeLessThan(0.5);
    });
});

describe('hand-checked values', () => {
    test('one line, Reforging only, any grade of a weight-1 type: 43.5 rolls (pool weight 43.5)', () => {
        const targets = [{ hrid: M('armor'), minGrade: 1 }];
        const solution = solutionFor(targets, 1, { weights: { '/items/reforging_orb': 1 } });
        const advice = advise(solution, talismanRow(1, [line('melee_evasion', 1)]), targets);
        expect(advice.value).toBeCloseTo(43.5, 8);
        expect(advice.counts['/items/reforging_orb']).toBeCloseTo(43.5, 8);
    });

    test('two lines, Attunement only, armor G3+ and smite G2+ from G1/G1: 19.57041219', () => {
        const targets = [
            { hrid: M('armor'), minGrade: 3 },
            { hrid: M('smite'), minGrade: 2 },
        ];
        const solution = solutionFor(targets, 2, { weights: { '/items/attunement_orb': 1 } });
        const advice = advise(solution, talismanRow(1, [line('armor', 1), line('smite', 1)]), targets);
        expect(advice.value).toBeCloseTo(19.57041219, 7);
    });
});

describe('policy and counts', () => {
    test('expected counts times weights add up to the value of the state', () => {
        const targets = [
            { hrid: M('ability_damage'), minGrade: 3 },
            { hrid: M('smite'), minGrade: 2 },
        ];
        const solution = solutionFor(targets, 3);
        const K = solution.orbHrids.length;
        let checked = 0;
        for (let s = 0; s < solution.stateCount; s += 7) {
            if (!Number.isFinite(solution.V[s])) continue;
            let total = 0;
            solution.orbHrids.forEach((hrid, k) => {
                total += solution.E[s * K + k] * (VALUE_WEIGHTS[hrid] || 0);
            });
            expect(total).toBeCloseTo(solution.V[s], -1);
            checked++;
        }
        expect(checked).toBeGreaterThan(20);
    });

    describe('every line already at the wanted grade, orbs counted one each', () => {
        const targets = [
            { hrid: M('ability_damage'), minGrade: 4 },
            { hrid: M('smite'), minGrade: 4 },
            { hrid: M('armor'), minGrade: 4 },
        ];
        const ones = Object.fromEntries(Object.keys(VALUE_WEIGHTS).map((hrid) => [hrid, 1]));
        const modifiers = [
            line('armor', 4),
            line('melee_evasion', 4),
            line('melee_accuracy', 4),
            line('magic_damage', 4),
        ];

        test('only types are missing, so Focus is the move; its picks leave out Special-group lines', () => {
            const solution = solutionFor(targets, 4, { weights: ones });
            const advice = advise(solution, talismanRow(1, modifiers), targets);
            expect(advice.move.itemHrid).toBe('/items/focus_orb');
            expect(advice.move.focusHrids).toEqual([M('ability_damage'), M('armor')]);
            // Armor meets its slot unlocked: locking it first is shown to cost more
            expect(advice.lockFirst.modifierHrid).toBe(M('armor'));
            expect(advice.lockFirst.value).toBeGreaterThan(advice.value);
        });

        test('a lock on an easy line is given up only when keeping it is shown to cost more', () => {
            const solution = solutionFor(targets, 4, { weights: ones });
            const advice = advise(solution, talismanRow(1, modifiers, { lockedModifierHrid: M('armor') }), targets);
            expect(advice.move).toEqual({ kind: 'unlock' });
            expect(advice.stayLockedValue).toBeGreaterThan(advice.value);
        });

        test('focus picks leave out the locked type', () => {
            const solution = solutionFor(targets, 4, { weights: ones });
            const locked = [
                line('smite', 4),
                line('melee_evasion', 4),
                line('melee_accuracy', 4),
                line('magic_damage', 4),
            ];
            const advice = advise(solution, talismanRow(1, locked, { lockedModifierHrid: M('smite') }), targets);
            expect(advice.move.itemHrid).toBe('/items/focus_orb');
            expect(advice.move.focusHrids).toEqual([M('ability_damage'), M('armor')]);
        });
    });

    test('a skilling talisman draws from the skilling pool', () => {
        const targets = [
            { hrid: M('milking_speed'), minGrade: 2 },
            { hrid: M('foraging_speed'), minGrade: 1 },
        ];
        const solution = solutionFor(targets, 2, { type: SKILLING });
        const talisman = talismanRow(1, [line('milking_speed', 2), line('alchemy_efficiency', 1)], {
            talismanTypeHrid: SKILLING,
        });
        const advice = advise(solution, talisman, targets);
        expect(advice.status).toBe('move');
        expect(Number.isFinite(advice.value)).toBe(true);
        expect(problemFor(targets, 2, { type: COMBAT }).status).toBe('impossible');
    });

    test('a malformed talisman holding one type twice reads the extra copy as junk', () => {
        const targets = [{ hrid: M('armor'), minGrade: 3 }];
        const solution = solutionFor(targets, 2);
        const twice = talismanRow(1, [line('armor', 1), line('armor', 2)]);
        const { index, lineCodes } = encodeLines(solution, twice.modifiers, '');
        expect(index).not.toBeUndefined();
        expect(lineCodes.map(solution.labelOf)).toEqual([1, 0]);
        // Two talismans with the same lines get the same advice
        const again = talismanRow(2, [line('armor', 1), line('armor', 2)]);
        expect(advise(solution, again, targets)).toEqual(advise(solution, twice, targets));
    });

    test('meetsTarget reads raw grades', () => {
        const targets = [{ hrid: M('armor'), minGrade: 3 }];
        expect(meetsTarget([line('armor', 3)], targets)).toBe(true);
        expect(meetsTarget([line('armor', 2)], targets)).toBe(false);
        expect(meetsTarget([line('armor', 6)], [])).toBe(false);
    });
});

// ---- Simulating the policy under the real, uncompressed rules ----

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function simulate(solution, targets, start, runs, seed, weights = VALUE_WEIGHTS) {
    const random = rng(seed);
    const pool = Object.values(REROLL_MODIFIERS).filter((d) => d.talismanTypeHrid === start.talismanTypeHrid);
    const orbOf = (hrid) => TALISMAN_INFO.rerollInputMap[hrid];
    const pickGrade = (cap) => {
        const odds = gradeOdds(cap);
        let r = random();
        for (let g = 0; g < odds.length; g++) {
            r -= odds[g];
            if (r < 0) return g + 1;
        }
        return odds.length;
    };
    const drawTypes = (count, excluded, focus) => {
        const taken = new Set(excluded);
        const out = [];
        for (let i = 0; i < count; i++) {
            const options = pool.filter((d) => !taken.has(d.hrid));
            const weights = options.map((d) => d.weight * (focus.has(d.hrid) ? TALISMAN_INFO.focusWeight : 1));
            let r = random() * weights.reduce((a, b) => a + b, 0);
            let pick = options[options.length - 1];
            for (let k = 0; k < options.length; k++) {
                r -= weights[k];
                if (r < 0) {
                    pick = options[k];
                    break;
                }
            }
            taken.add(pick.hrid);
            out.push(pick.hrid);
        }
        return out;
    };
    const reroll = (mods, locked, hrid, focusHrids) => {
        const input = orbOf(hrid);
        const open = mods.map((m, i) => i).filter((i) => mods[i].hrid !== locked);
        const next = mods.map((m) => ({ ...m }));
        if (input.modeHrid === REROLL_MODES.full) {
            const types = drawTypes(open.length, locked ? [locked] : [], new Set());
            open.forEach((i, k) => (next[i] = { hrid: types[k], grade: pickGrade(input.gradeCap) }));
        } else if (input.modeHrid === REROLL_MODES.typesOnly) {
            const types = drawTypes(open.length, locked ? [locked] : [], new Set(focusHrids));
            open.forEach((i, k) => (next[i] = { hrid: types[k], grade: mods[i].grade }));
        } else if (input.modeHrid === REROLL_MODES.randomLines) {
            const chosen = open.slice();
            for (let i = chosen.length - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
            }
            const picked = chosen.slice(0, input.lineCount);
            const kept = mods.filter((m, i) => !picked.includes(i)).map((m) => m.hrid);
            const types = drawTypes(picked.length, kept, new Set());
            picked.forEach((i, k) => (next[i] = { hrid: types[k], grade: pickGrade(input.gradeCap) }));
        } else if (input.modeHrid === REROLL_MODES.permute) {
            const grades = open.map((i) => mods[i].grade);
            for (let i = grades.length - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [grades[i], grades[j]] = [grades[j], grades[i]];
            }
            open.forEach((i, k) => (next[i] = { hrid: mods[i].hrid, grade: grades[k] }));
        } else {
            for (const i of open) {
                const r = random();
                const g = mods[i].grade;
                const shifted = r < input.shiftDownChance ? g - 1 : r < 1 - input.shiftUpChance ? g : g + 1;
                next[i] = { hrid: mods[i].hrid, grade: Math.max(1, Math.min(TALISMAN_INFO.maxGrade, shifted)) };
            }
        }
        return next;
    };

    let total = 0;
    let totalSq = 0;
    for (let run = 0; run < runs; run++) {
        let mods = start.modifiers.map((m) => ({ ...m }));
        let locked = start.lockedModifierHrid;
        let spent = 0;
        for (let guard = 0; guard < 100000 && !meetsTarget(mods, targets); guard++) {
            const advice = advise(
                solution,
                { modifiers: mods, lockedModifierHrid: locked, pendingModifiers: null },
                targets
            );
            const move = advice.move;
            if (move.kind === 'lock') {
                locked = move.modifierHrid;
                spent += weights[BINDING];
            } else if (move.kind === 'unlock') {
                locked = '';
            } else {
                spent += weights[move.itemHrid];
                const pending = reroll(mods, locked, move.itemHrid, move.focusHrids || []);
                const decision = advise(
                    solution,
                    { modifiers: mods, lockedModifierHrid: locked, pendingModifiers: pending },
                    targets
                );
                if (decision.status === 'accept') mods = pending;
            }
        }
        total += spent;
        totalSq += spent * spent;
    }
    const mean = total / runs;
    const stderr = Math.sqrt(Math.max(0, totalSq / runs - mean * mean) / runs);
    return { mean, stderr };
}

describe('the compressed solver against the raw rules', () => {
    const cases = [
        {
            name: 'one wanted line on a two-line talisman',
            targets: [{ hrid: M('ability_damage'), minGrade: 3 }],
            start: talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]),
        },
        {
            name: 'two wanted lines on a three-line talisman, one rare',
            targets: [
                { hrid: M('armor'), minGrade: 2 },
                { hrid: M('smite'), minGrade: 1 },
            ],
            start: talismanRow(1, [line('melee_evasion', 2), line('melee_accuracy', 1), line('armor', 1)]),
        },
        {
            name: 'a four-line skilling talisman with a locked line already in place',
            targets: [
                { hrid: M('milking_speed'), minGrade: 3 },
                { hrid: M('foraging_speed'), minGrade: 4 },
            ],
            start: talismanRow(
                1,
                [
                    line('milking_speed', 3),
                    line('alchemy_efficiency', 5),
                    line('cooking_speed', 1),
                    line('brewing_speed', 2),
                ],
                { talismanTypeHrid: SKILLING, lockedModifierHrid: M('milking_speed') }
            ),
        },
        {
            name: 'every orb counted one each (Focus and Exchange carry the plan)',
            targets: [
                { hrid: M('ability_damage'), minGrade: 4 },
                { hrid: M('armor'), minGrade: 3 },
            ],
            start: talismanRow(1, [line('melee_evasion', 5), line('melee_accuracy', 3), line('magic_damage', 1)]),
            weights: Object.fromEntries(Object.keys(VALUE_WEIGHTS).map((hrid) => [hrid, 1])),
        },
        {
            name: 'Mutation and Attunement the cheap orbs',
            targets: [
                { hrid: M('armor'), minGrade: 4 },
                { hrid: M('melee_damage'), minGrade: 2 },
            ],
            start: talismanRow(1, [line('armor', 2), line('melee_accuracy', 3), line('magic_damage', 1)]),
            weights: {
                ...Object.fromEntries(Object.keys(VALUE_WEIGHTS).map((hrid) => [hrid, 20])),
                '/items/mutation_orb': 1,
                '/items/attunement_orb': 1,
            },
        },
    ];
    for (const { name, targets, start, weights } of cases) {
        test(name, () => {
            const solution = solutionFor(targets, start.modifiers.length, { type: start.talismanTypeHrid, weights });
            const expected = advise(solution, start, targets).value;
            const { mean, stderr } = simulate(solution, targets, start, 1500, 12345, weights);
            // Sampling noise plus the compression's few-percent allowance
            expect(Math.abs(mean - expected)).toBeLessThan(4 * stderr + 0.05 * expected);
        });
    }
});
