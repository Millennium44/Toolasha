/**
 * Conservation (talisman Special, test patch 2026-11-20): a chance to keep a protection item a failure would consume,
 * never a Philosopher's Mirror. It thins the protection count only: the chain, the attempts and the XP are unchanged.
 * Epiphany (a chance of double XP) scales a run's expected XP.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { calculateEnhancement, clearEnhancementMemo, protectionKeepChance } from './enhancement-calculator.js';
import {
    clearProtectSweepMemo,
    expectedProtectionsFromStock,
    expectedRunXp,
    sweepProtectFrom,
    sweepProtectFromMemo,
} from './enhancement-protect-sweep.js';

const CHAIN = {
    enhancingLevel: 90,
    houseLevel: 4,
    toolBonus: 12,
    speedBonus: 20,
    itemLevel: 80,
    targetLevel: 10,
    startLevel: 0,
    protectFrom: 4,
    blessedTea: false,
    guzzlingBonus: 1,
};

beforeEach(() => {
    clearEnhancementMemo();
    clearProtectSweepMemo();
});

describe('calculateEnhancement with Conservation', () => {
    test('no Conservation (0, absent, junk) is the plain count', () => {
        const plain = calculateEnhancement(CHAIN);
        expect(plain.protectionCount).toBeGreaterThan(0);
        for (const value of [0, undefined, null, -0.5, Number.NaN, 'x']) {
            expect(calculateEnhancement({ ...CHAIN, conservation: value }).protectionCount).toBe(plain.protectionCount);
        }
    });

    test.each([0.02516, 0.1006])('keeps %s of the protections and changes nothing else', (chance) => {
        const plain = calculateEnhancement(CHAIN);
        const kept = calculateEnhancement({ ...CHAIN, conservation: chance });
        expect(kept.protectionCount).toBeCloseTo(plain.protectionCount * (1 - chance), 10);
        expect(kept.attempts).toBe(plain.attempts);
        expect(kept.attemptsVariance).toBe(plain.attemptsVariance);
        expect(kept.visitCounts).toEqual(plain.visitCounts);
    });

    test('the memo tells the two apart, and a chance past 1 is clamped to keeping all', () => {
        const kept = calculateEnhancement({ ...CHAIN, conservation: 0.1 });
        const plain = calculateEnhancement(CHAIN);
        expect(kept.protectionCount).toBeLessThan(plain.protectionCount);
        expect(calculateEnhancement({ ...CHAIN, conservation: 5 }).protectionCount).toBe(0);
    });

    test('a run with no protection stays at 0', () => {
        expect(calculateEnhancement({ ...CHAIN, protectFrom: 0, conservation: 0.08 }).protectionCount).toBe(0);
    });
});

describe('protectionKeepChance', () => {
    test("a Philosopher's Mirror is never kept; any other protection item takes the chance", () => {
        expect(protectionKeepChance(0.05, '/items/philosophers_mirror')).toBe(0);
        expect(protectionKeepChance(0.05, '/items/mirror_of_protection')).toBe(0.05);
        expect(protectionKeepChance(0.05, null)).toBe(0.05);
        expect(protectionKeepChance(0, '/items/holy_sword')).toBe(0);
        expect(protectionKeepChance(undefined, '/items/holy_sword')).toBe(0);
    });
});

describe('expectedProtectionsFromStock with Conservation', () => {
    const run = (extra) => calculateEnhancement({ ...CHAIN, targetLevel: 6, protectFrom: 3, ...extra });
    const args = (calc, extra) => ({
        successChances: calc.successRates.map((r) => r.actualRate / 100),
        targetLevel: 6,
        protectFrom: 3,
        ...extra,
    });

    test('a stock larger than any run needs is the net expected count', () => {
        const calc = run({ conservation: 0.2 });
        const exact = expectedProtectionsFromStock(args(calc, { conservation: 0.2, stock: 5000 }));
        expect(exact).toBeCloseTo(calc.protectionCount, 8);
    });

    test('0 Conservation is the old answer', () => {
        const calc = run({});
        expect(expectedProtectionsFromStock(args(calc, { stock: 2 }))).toBeCloseTo(
            expectedProtectionsFromStock(args(calc, { conservation: 0, stock: 2 })),
            12
        );
    });

    test('agrees with a simulation of the same run (one and three copies)', () => {
        const calc = run({});
        const p = calc.successRates.map((r) => r.actualRate / 100);
        const keep = 0.3;
        let seed = 12345;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296;
        };
        const stocks = [1, 3];
        const sums = stocks.map(() => 0);
        const trials = 120000;
        for (let t = 0; t < trials; t++) {
            let level = 0;
            let used = 0;
            while (level < 6) {
                if (rand() < p[level]) level += 1;
                else if (level >= 3) {
                    if (rand() >= keep) used += 1;
                    level -= 1;
                } else level = 0;
            }
            stocks.forEach((s, i) => {
                sums[i] += Math.min(s, used);
            });
        }
        stocks.forEach((s, i) => {
            const exact = expectedProtectionsFromStock(args(calc, { conservation: keep, stock: s }));
            expect(exact).toBeGreaterThan(sums[i] / trials - 0.012);
            expect(exact).toBeLessThan(sums[i] / trials + 0.012);
        });
    });
});

describe('sweepProtectFrom with Conservation and Epiphany', () => {
    const OPTION = { itemHrid: '/items/holy_sword', name: 'Holy Sword', price: 50000 };
    const sweep = (chainExtra = {}, extra = {}) =>
        sweepProtectFrom({
            chain: { ...CHAIN, ...chainExtra },
            targetLevel: 8,
            materialCostPerAttempt: 1000,
            protectionOptions: [OPTION],
            xpBaseLevel: 80,
            wisdomDecimal: 0.2,
            ...extra,
        });
    const protectedRow = (result) => result.rows.find((row) => row.protectFrom === 4);

    test('a protected row spends (1 - c) of the protections and so costs less; attempts are the same', () => {
        const plain = protectedRow(sweep());
        const kept = protectedRow(sweep({ conservation: 0.1 }));
        expect(kept.protections).toBeCloseTo(plain.protections * 0.9, 10);
        expect(kept.attempts).toBe(plain.attempts);
        expect(kept.expectedCost).toBeCloseTo(plain.expectedCost - plain.protections * 0.1 * 50000, 4);
    });

    test('the no-protection row is untouched', () => {
        const plain = sweep().rows[0];
        const kept = sweep({ conservation: 0.1 }).rows[0];
        expect(kept.protectFrom).toBe(0);
        expect(kept.expectedCost).toBe(plain.expectedCost);
    });

    test('no protection option priced (prices missing): only the unprotected row, whatever Conservation', () => {
        const rows = sweep({ conservation: 0.1 }, { protectionOptions: [] }).rows;
        expect(rows.every((row) => row.protectFrom === 0)).toBe(true);
    });

    test('the memo does not hand a Conservation-less answer to a Conservation one', () => {
        const args = (c) => ({
            chain: { ...CHAIN, conservation: c },
            targetLevel: 8,
            materialCostPerAttempt: 1000,
            protectionOptions: [OPTION],
        });
        const a = protectedRow(sweepProtectFromMemo(args(0)));
        const b = protectedRow(sweepProtectFromMemo(args(0.1)));
        expect(b.protections).toBeLessThan(a.protections);
    });

    test('Epiphany scales the run XP by (1 + chance) and nothing else', () => {
        const plain = protectedRow(sweep());
        const doubled = protectedRow(sweep({}, { epiphany: 0.04 }));
        expect(doubled.xp).toBeCloseTo(plain.xp * 1.04, 8);
        expect(doubled.expectedCost).toBe(plain.expectedCost);
    });

    test('expectedRunXp: 0 and junk Epiphany are the plain figure', () => {
        const calc = calculateEnhancement(CHAIN);
        const base = expectedRunXp(calc, { xpBaseLevel: 80 });
        expect(expectedRunXp(calc, { xpBaseLevel: 80, epiphany: 0 })).toBe(base);
        expect(expectedRunXp(calc, { xpBaseLevel: 80, epiphany: -1 })).toBe(base);
        expect(expectedRunXp(calc, { xpBaseLevel: 80, epiphany: 0.02 })).toBeCloseTo(base * 1.02, 10);
    });
});
