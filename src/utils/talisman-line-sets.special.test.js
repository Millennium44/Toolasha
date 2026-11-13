/**
 * A second copy of a Special line adds nothing (measured on the test server 2026-11-13: Fortify G2 at power 0.15
 * reads 0.01725 with one copy or two). Sets and rankings must never count or place one.
 */
import { describe, test, expect } from 'vitest';
import { FULL_MODIFIER_DETAILS } from '../__fixtures__/talisman-full-modifiers.js';
import {
    buildRecommendedSet,
    isSpecialLine,
    lineMarginals,
    planBudgetSet,
    scaleAcrossGrades,
    setOptionsFor,
} from './talisman-line-sets.js';

const H = (key) => `/talisman_modifiers/${key}`;

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

function fakeOrbs() {
    return {
        limited: false,
        stopped: () => false,
        async freshCost(_type, targets) {
            return { orbs: targets.length * targets[0].minGrade, counts: {} };
        },
        async ownedCost(_t, targets) {
            return { orbs: targets.length * targets[0].minGrade, counts: {}, status: 'move' };
        },
    };
}

const copiesOf = (set, key) => (set.members.find((m) => m.hrid === H(key)) || { copies: 0 }).copies;

describe('lineMarginals for a Special line', () => {
    test('one copy only, whatever the copies run or the slot count says', () => {
        expect(lineMarginals(row('fortify', 60), 3, 6).marginals).toEqual([60]);
        expect(lineMarginals(row('fortify', 60, { copiesValue: 150 }), 3, 6).marginals).toEqual([60]);
    });

    test('a regular line still gets a copy per slot (assumed linear without a copies run)', () => {
        const plain = lineMarginals(row('critical_damage', 30), 3, 6);
        expect(plain.marginals).toHaveLength(3);
        plain.marginals.forEach((m) => expect(m).toBeCloseTo(30, 8));
        expect(plain.assumed).toBe(true);
    });
});

describe('sets never repeat a Special', () => {
    const rows = [row('fortify', 60), row('critical_damage', 30), row('ability_damage', 10)];

    test('Ideal with three slots: Fortify once, the regular line three times', () => {
        const set = buildRecommendedSet(rows, { slots: 3, ...setOptionsFor('ideal', { simGrade: 6, capGrade: 3 }) });
        expect(copiesOf(set, 'fortify')).toBe(1);
        expect(copiesOf(set, 'critical_damage')).toBe(3);
        const worn = set.talismans.flatMap((t) => t.modifiers).filter((m) => m.hrid === H('fortify'));
        expect(worn).toHaveLength(1);
    });

    test('a copies run that measured a big second copy is still ignored for a Special', () => {
        const set = buildRecommendedSet([row('fortify', 60, { copiesValue: 400 }), row('critical_damage', 30)], {
            slots: 3,
            ...setOptionsFor('ideal', { simGrade: 6, capGrade: 3 }),
        });
        expect(copiesOf(set, 'fortify')).toBe(1);
    });

    test('two different Specials both count', () => {
        const set = buildRecommendedSet([row('fortify', 60), row('smite', 50)], {
            slots: 2,
            ...setOptionsFor('ideal', { simGrade: 6, capGrade: 3 }),
        });
        expect(copiesOf(set, 'fortify')).toBe(1);
        expect(copiesOf(set, 'smite')).toBe(1);
    });

    test('Budget: the second talisman takes the next Special, not another Fortify', async () => {
        const plan = await planBudgetSet([row('fortify', 60), row('smite', 50)], {
            slots: 2,
            capGrade: 3,
            budget: 1000,
            typeHrid: '/talisman_types/combat',
            orbs: fakeOrbs(),
        });
        const worn = plan.set.talismans.flatMap((t) => t.modifiers.map((m) => m.hrid));
        expect(worn.filter((h) => h === H('fortify'))).toHaveLength(1);
        expect(worn.filter((h) => h === H('smite'))).toHaveLength(1);
    });

    test('Budget with only one Special measured: the second talisman does not repeat it', async () => {
        const plan = await planBudgetSet([row('fortify', 60), row('critical_damage', 30)], {
            slots: 2,
            capGrade: 3,
            budget: 1000,
            typeHrid: '/talisman_types/combat',
            orbs: fakeOrbs(),
        });
        const worn = plan.set.talismans.flatMap((t) => t.modifiers.map((m) => m.hrid));
        expect(worn.filter((h) => h === H('fortify'))).toHaveLength(1);
    });
});
