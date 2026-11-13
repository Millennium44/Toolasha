import { describe, test, expect } from 'vitest';
import { FULL_MODIFIER_DETAILS } from '../__fixtures__/talisman-full-modifiers.js';
import { talismanRow } from '../__fixtures__/talisman-reroll.js';
import {
    buildRecommendedSet,
    isSpecialLine,
    lineMarginals,
    planBudgetSet,
    planImprovements,
    scaleAcrossGrades,
    setOptionsFor,
} from './talisman-line-sets.js';

const H = (key) => `/talisman_modifiers/${key}`;

/** A ranking row as the combat ranking makes it: measured at G6, scaled to every grade */
function row(key, valueAtG6, extra = {}) {
    const detail = FULL_MODIFIER_DETAILS[H(key)];
    return {
        hrid: H(key),
        name: detail.name,
        detail,
        special: isSpecialLine(detail),
        value: valueAtG6,
        byGrade: scaleAcrossGrades(valueAtG6, detail, 6),
        significant: true,
        ...extra,
    };
}

/** An orb solver stand-in: cost grows with lines, grade and Special lines (the shape the real solver keys on) */
function fakeOrbs({ stopAfter = Infinity } = {}) {
    let calls = 0;
    const orbs = {
        cancelled: false,
        limited: false,
        stopped: () => orbs.cancelled,
        async freshCost(_type, targets) {
            calls++;
            if (calls > stopAfter) orbs.cancelled = true;
            const special = targets.some((t) => FULL_MODIFIER_DETAILS[t.hrid]?.groupHrid?.endsWith('/special'));
            return { orbs: targets.length * targets[0].minGrade * (special ? 5 : 1), counts: {} };
        },
        async ownedCost(talisman, targets) {
            calls++;
            if (calls > stopAfter) orbs.cancelled = true;
            return { orbs: targets.length * targets[0].minGrade, counts: {}, status: 'move' };
        },
        get calls() {
            return calls;
        },
    };
    return orbs;
}

describe('special lines come from the game data group', () => {
    test('the five Special-group lines, and nothing else', () => {
        const specials = Object.values(FULL_MODIFIER_DETAILS)
            .filter(isSpecialLine)
            .map((d) => d.name)
            .sort();
        expect(specials).toEqual(['Echo', 'Fortify', 'Overkill', 'Shatter', 'Smite']);
    });
});

describe('Practical sets', () => {
    const rows = [
        row('smite', 60),
        row('overkill', 50),
        row('echo', 40),
        row('critical_damage', 30),
        row('critical_rate', 20),
        row('ability_damage', 10),
    ];

    test('at most one Special line per talisman, grades capped at G3 and valued there', () => {
        const options = setOptionsFor('practical', { simGrade: 6, capGrade: 3 });
        const set = buildRecommendedSet(rows, { slots: 3, ...options });
        for (const t of set.talismans) {
            expect(t.modifiers.filter((m) => isSpecialLine(FULL_MODIFIER_DETAILS[m.hrid])).length).toBeLessThanOrEqual(
                1
            );
            for (const m of t.modifiers) expect(m.grade).toBe(3);
        }
        // Smite at G3 is 0.06 / 0.12 of its G6 value
        const smite = set.members.find((m) => m.hrid === H('smite'));
        expect(smite.value / smite.copies).toBeCloseTo(30, 6);
    });

    test('Ideal: the simulated grade and no limit on Specials', () => {
        const set = buildRecommendedSet(rows, { slots: 1, ...setOptionsFor('ideal', { simGrade: 6, capGrade: 3 }) });
        expect(set.talismans[0].modifiers.map((m) => m.hrid)).toEqual([
            H('smite'),
            H('overkill'),
            H('echo'),
            H('critical_damage'),
        ]);
        expect(set.talismans[0].modifiers.every((m) => m.grade === 6)).toBe(true);
    });

    test('a later copy measured with one in every slot is scaled to the grade like the first', () => {
        const r = row('critical_damage', 30, { copiesValue: 60 });
        // At G3: first 15, the ×3 run's 60 at G6 is 30 at G3, so each later copy adds 7.5
        const { marginals } = lineMarginals(r, 3, 3);
        [15, 7.5, 7.5].forEach((v, i) => expect(marginals[i]).toBeCloseTo(v, 9));
    });
});

describe('Budget sets', () => {
    const rows = [row('critical_damage', 30), row('critical_rate', 20), row('smite', 60), row('ability_damage', 10)];

    test('each talisman takes the most value whose expected orbs fit the budget', async () => {
        const plan = await planBudgetSet(rows, {
            slots: 2,
            capGrade: 3,
            budget: 6,
            typeHrid: '/talisman_types/combat',
            orbs: fakeOrbs(),
        });
        expect(plan.set.talismans).toHaveLength(2);
        for (const t of plan.set.talismans) {
            expect(t.cost.orbs).toBeLessThanOrEqual(6);
            expect(t.modifiers.filter((m) => isSpecialLine(FULL_MODIFIER_DETAILS[m.hrid])).length).toBeLessThanOrEqual(
                1
            );
        }
    });

    test('a budget too small for any target: no set, and the cheapest cost', async () => {
        const plan = await planBudgetSet(rows, {
            slots: 3,
            capGrade: 3,
            budget: 0.5,
            typeHrid: '/talisman_types/combat',
            orbs: fakeOrbs(),
        });
        expect(plan).toMatchObject({ set: null, reason: 'budget', cheapest: 1 });
    });

    test('stopped mid-solve: no set, said as cancelled', async () => {
        const plan = await planBudgetSet(rows, {
            slots: 3,
            capGrade: 3,
            budget: 100,
            typeHrid: '/talisman_types/combat',
            orbs: fakeOrbs({ stopAfter: 2 }),
        });
        expect(plan).toMatchObject({ set: null, reason: 'cancelled' });
    });
});

describe('Improve mine', () => {
    const rows = [row('critical_damage', 30), row('critical_rate', 20), row('armor', 6)];
    const owned = [
        talismanRow(1, [
            { hrid: H('armor'), grade: 2 },
            { hrid: H('tenacity'), grade: 1 },
        ]),
        talismanRow(2, [{ hrid: H('milking_speed'), grade: 1 }], { talismanTypeHrid: '/talisman_types/skilling' }),
    ];
    const plan = (list, orbs = fakeOrbs()) =>
        planImprovements(rows, { owned: list, typeHrid: '/talisman_types/combat', capGrade: 3, orbs });

    test('no owned talismans', async () => {
        expect((await plan([])).status).toBe('none_owned');
    });

    test('only talismans of the other type', async () => {
        expect(await plan([owned[1]])).toMatchObject({ status: 'none_of_type', otherCount: 1 });
    });

    test('options best value per orb first, no more lines than the talisman has, gain net of its lines now', async () => {
        const result = await plan(owned);
        expect(result.status).toBe('done');
        const [best] = result.options;
        expect(best.talisman.id).toBe(1);
        expect(best.targets.length).toBeLessThanOrEqual(2);
        for (let i = 1; i < result.options.length; i++) {
            expect(result.options[i - 1].perOrb).toBeGreaterThanOrEqual(result.options[i].perOrb);
        }
        // Armor G2 is worth 6 * 3/8 now; Critical Damage G3 is worth 15
        const critOnly = result.options.find(
            (o) => o.targets.length === 1 && o.targets[0].hrid === H('critical_damage') && o.targets[0].minGrade === 3
        );
        expect(critOnly.gain).toBeCloseTo(15 - 6 * (3 / 8), 6);
    });

    test('stopped mid-solve: cancelled', async () => {
        expect((await plan(owned, fakeOrbs({ stopAfter: 1 }))).status).toBe('cancelled');
    });
});

describe('Improve mine across many talismans', () => {
    const rows = [row('critical_damage', 30), row('critical_rate', 20), row('ability_damage', 12), row('smite', 60)];
    const eight = Array.from({ length: 8 }, (_, i) =>
        talismanRow(100 + i, [
            { hrid: H('armor'), grade: 1 },
            { hrid: H('tenacity'), grade: 1 },
            { hrid: H('max_hitpoints'), grade: 1 },
            { hrid: H('hp_regen'), grade: 1 },
        ])
    );
    /** Real-solver-like costs: each extra line costs disproportionately more, so small targets buy best */
    function steepOrbs() {
        const shapes = new Set();
        const orbs = {
            cancelled: false,
            limited: false,
            stopped: () => false,
            shapes,
            async ownedCost(talisman, targets) {
                shapes.add(targets.map((t) => `${t.hrid}:${t.minGrade}`).join(','));
                return { orbs: 10 ** targets.length * targets[0].minGrade, counts: {}, status: 'move' };
            },
        };
        return orbs;
    }

    test('stops growing a target once one more line lowers the best value per orb', async () => {
        const orbs = steepOrbs();
        const result = await planImprovements(rows, {
            owned: eight,
            typeHrid: '/talisman_types/combat',
            capGrade: 3,
            orbs,
        });
        expect(result.status).toBe('done');
        // Each grade tries the one- and two-line targets of each kind, then stops: no 3- or 4-line target
        expect([...orbs.shapes].every((key) => key.split(',').length <= 2)).toBe(true);
        expect(result.options[0].targets).toHaveLength(1);
    });
});

describe('Improve mine solves only what can make the list', () => {
    const rows = [row('critical_damage', 30), row('critical_rate', 20), row('ability_damage', 12), row('smite', 60)];
    const eight = Array.from({ length: 8 }, (_, i) =>
        talismanRow(200 + i, [
            { hrid: H('armor'), grade: 1 },
            { hrid: H('tenacity'), grade: 1 },
            { hrid: H('max_hitpoints'), grade: 1 },
            { hrid: H('hp_regen'), grade: 1 },
        ])
    );

    test('a target whose cost floor (same lines lower, or fewer lines) cannot beat the list is never costed', async () => {
        let calls = 0;
        const shapes = new Set();
        const orbs = {
            cancelled: false,
            limited: false,
            stopped: () => false,
            async ownedCost(_t, targets) {
                calls++;
                // A solve is one target shape (all eight talismans have four lines)
                shapes.add(
                    targets
                        .map((t) => `${t.hrid}:${t.minGrade}`)
                        .sort()
                        .join(',')
                );
                // Real-solver-like: a higher grade and more lines both cost more
                return { orbs: 3 ** targets[0].minGrade * 10 ** targets.length, counts: {}, status: 'move' };
            },
        };
        const result = await planImprovements(rows, {
            owned: eight,
            typeHrid: '/talisman_types/combat',
            capGrade: 3,
            orbs,
        });
        expect(result.status).toBe('done');
        expect(result.options).toHaveLength(5);
        // 12 shapes and 96 costings before the floors; the best option is the same either way
        expect(shapes.size).toBeLessThanOrEqual(5);
        expect(calls).toBeLessThanOrEqual(40);
        expect(result.options[0].perOrb).toBeCloseTo(0.5, 9);
    });
});

describe('Budget: a plan cut short by the solve limit says so', () => {
    test('slots filled, slots in all, and that the limit cut it', async () => {
        let calls = 0;
        const orbs = {
            cancelled: false,
            limited: false,
            stopped: () => false,
            async freshCost(_type, targets) {
                calls++;
                if (calls > 3) {
                    orbs.limited = true;
                    return null;
                }
                return { orbs: targets.length, counts: {} };
            },
        };
        const plan = await planBudgetSet([row('critical_damage', 30), row('critical_rate', 20)], {
            slots: 3,
            capGrade: 3,
            budget: 100,
            typeHrid: '/talisman_types/combat',
            orbs,
        });
        expect(plan.set).toMatchObject({ slots: 3, limited: true });
        expect(plan.set.slotsFilled).toBeLessThan(3);
    });
});

describe('Budget with upper-bound costs', () => {
    test('an upper bound over the budget is not taken as fitting, and is counted so the panel can say it may fit', async () => {
        const orbs = {
            cancelled: false,
            limited: false,
            stopped: () => false,
            async freshCost(_type, targets) {
                return { orbs: 5 * targets.length, counts: {}, upperBound: true };
            },
        };
        const plan = await planBudgetSet([row('critical_damage', 30)], {
            slots: 1,
            capGrade: 3,
            budget: 4,
            typeHrid: '/talisman_types/combat',
            orbs,
        });
        expect(plan).toMatchObject({ set: null, reason: 'budget' });
        expect(plan.overUpperBound).toBeGreaterThan(0);
        expect(plan.cheapestIsUpperBound).toBe(true);
    });
});
