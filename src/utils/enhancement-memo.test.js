/**
 * calculateEnhancement memo and the Float64Array stock path of expectedProtectionsFromStock.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as mathjs from 'mathjs';
import matrixMath from './matrix-inverse.js';
import { calculateEnhancement, clearEnhancementMemo, BASE_SUCCESS_RATES } from './enhancement-calculator.js';
import { expectedProtectionsFromStock } from './enhancement-protect-sweep.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

const base = {
    enhancingLevel: 90,
    toolBonus: 8,
    speedBonus: 20,
    itemLevel: 80,
    targetLevel: 12,
    startLevel: 0,
    protectFrom: 5,
    blessedTea: true,
    guzzlingBonus: 1.1,
    blessedTeaBonus: 0.01,
    perActionTimeOverride: 0,
};

describe('calculateEnhancement memo', () => {
    beforeEach(() => clearEnhancementMemo());
    afterEach(() => vi.restoreAllMocks());

    test('equal inputs give equal results, not the same object', () => {
        const a = calculateEnhancement({ ...base });
        const b = calculateEnhancement({ ...base });
        expect(b).toEqual(a);
        expect(b).not.toBe(a);
        expect(b.successRates).not.toBe(a.successRates);
        expect(b.visitCounts).not.toBe(a.visitCounts);
    });

    test('a caller mutating a result cannot poison later calls', () => {
        const a = calculateEnhancement({ ...base });
        const expected = calculateEnhancement({ ...base });
        a.attempts = -1;
        a.visitCounts[0] = -1;
        a.successRates[0].actualRate = -1;
        expect(calculateEnhancement({ ...base })).toEqual(expected);
    });

    const changes = {
        enhancingLevel: 95,
        toolBonus: 12,
        speedBonus: 40,
        itemLevel: 85,
        targetLevel: 14,
        startLevel: 3,
        protectFrom: 8,
        blessedTea: false,
        guzzlingBonus: 1.2,
        blessedTeaBonus: 0.02,
        perActionTimeOverride: 7,
    };
    for (const [field, value] of Object.entries(changes)) {
        test(`changing ${field} changes the result`, () => {
            const a = calculateEnhancement({ ...base });
            const b = calculateEnhancement({ ...base, [field]: value });
            expect(b).not.toEqual(a);
        });
    }

    test('omitted optionals match their explicit defaults', () => {
        const rest = { enhancingLevel: 90, toolBonus: 8, itemLevel: 80, targetLevel: 12 };
        const a = calculateEnhancement(rest);
        const b = calculateEnhancement({
            ...rest,
            speedBonus: 0,
            startLevel: 0,
            protectFrom: 0,
            blessedTea: false,
            guzzlingBonus: 1,
            blessedTeaBonus: 0.01,
        });
        expect(b).toEqual(a);
    });

    test('invalid input still throws every time', () => {
        expect(() => calculateEnhancement({ ...base, targetLevel: 21 })).toThrow();
        expect(() => calculateEnhancement({ ...base, targetLevel: 21 })).toThrow();
    });

    test('a +20 path computed twice solves each chain once', () => {
        const inv = vi.spyOn(matrixMath, 'inv');
        const path = () => {
            for (let t = 1; t <= 20; t++) {
                for (let p = 0; p <= t; p++) calculateEnhancement({ ...base, targetLevel: t, protectFrom: p });
            }
        };
        path();
        const first = inv.mock.calls.length;
        expect(first).toBeGreaterThan(200);
        path();
        expect(inv.mock.calls.length).toBe(first);
        inv.mockRestore();
    });

    test('memo stays bounded and evicts the oldest', () => {
        for (let i = 0; i < 4500; i++) calculateEnhancement({ ...base, toolBonus: i / 10 });
        const inv = vi.spyOn(matrixMath, 'inv');
        calculateEnhancement({ ...base, toolBonus: 0 }); // oldest, evicted
        expect(inv).toHaveBeenCalledTimes(1);
        calculateEnhancement({ ...base, toolBonus: 449.9 }); // newest, kept
        expect(inv).toHaveBeenCalledTimes(1);
        inv.mockRestore();
    });
});

// ---- reference: the array-of-arrays implementation this replaced ----
function invertSmall(matrix) {
    const n = matrix.length;
    const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        if (!(Math.abs(a[pivot][col]) > 1e-15)) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        const scale = a[col][col];
        for (let c = 0; c < 2 * n; c++) a[col][c] /= scale;
        for (let r = 0; r < n; r++) {
            if (r === col || a[r][col] === 0) continue;
            const factor = a[r][col];
            for (let c = 0; c < 2 * n; c++) a[r][c] -= factor * a[col][c];
        }
    }
    return a.map((row) => row.slice(n));
}

function referenceStock({
    successChances,
    targetLevel,
    startLevel = 0,
    protectFrom,
    blessedTea = false,
    guzzlingBonus = 1,
    blessedTeaBonus = 0.01,
    stock,
}) {
    const s = Math.max(0, Math.floor(Number(stock) || 0));
    if (s === 0 || !(protectFrom > 0)) return 0;
    const T = Math.floor(Number(targetLevel) || 0);
    if (!(T >= 1) || !Array.isArray(successChances) || successChances.length < T) return null;
    const start = Math.max(0, Math.min(T - 1, Math.floor(Number(startLevel) || 0)));
    const jump = blessedTea ? (Number(blessedTeaBonus) || 0) * (Number(guzzlingBonus) || 1) : 0;
    const A = Array.from({ length: T }, (_, i) => Array.from({ length: T }, (__, j) => (i === j ? 1 : 0)));
    const protectedFail = new Array(T).fill(0);
    for (let i = 0; i < T; i++) {
        const p = Math.min(1, Math.max(0, Number(successChances[i]) || 0));
        const skip = p * jump;
        if (i + 1 < T) A[i][i + 1] -= p - skip;
        if (i + 2 < T) A[i][i + 2] -= skip;
        if (i >= protectFrom) protectedFail[i] = 1 - p;
        else A[i][0] -= 1 - p;
    }
    const inverse = invertSmall(A);
    if (!inverse) return null;
    const L = inverse.map((row) => row.map((_, j) => (j + 1 < T ? row[j + 1] * protectedFail[j + 1] : 0)));
    const minusL = L.map((row, i) => row.map((value, j) => (i === j ? 1 : 0) - value));
    const resolvent = invertSmall(minusL);
    if (!resolvent) return null;
    const h = resolvent.map((row) => row.reduce((sum, value) => sum + value, 0));
    const meanUses = h[start] - 1;
    const matVec = (m, v) => m.map((row) => row.reduce((sum, value, j) => sum + value * v[j], 0));
    const matMul = (a, b) =>
        a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
    let beyond = h;
    let power = L;
    for (let e = s + 1; e > 0; e = Math.floor(e / 2)) {
        if (e % 2 === 1) beyond = matVec(power, beyond);
        if (e > 1) power = matMul(power, power);
    }
    const fromStock = meanUses - beyond[start];
    if (!Number.isFinite(fromStock)) return null;
    return Math.max(0, Math.min(s, meanUses, fromStock));
}

describe('expectedProtectionsFromStock matches the reference', () => {
    const chances = (T, mult) => BASE_SUCCESS_RATES.slice(0, T).map((r) => Math.min(100, r * mult) / 100);
    const fixtures = [];
    for (const [T, protectFrom, start, stock, blessedTea] of [
        [20, 2, 0, 1, false],
        [20, 5, 0, 3, true],
        [20, 10, 4, 7, true],
        [20, 20, 0, 50, false],
        [12, 3, 2, 400, true],
        [15, 1, 0, 2500, false],
        [1, 1, 0, 3, false],
        [2, 1, 1, 3, true],
    ]) {
        fixtures.push({
            successChances: chances(T, 1.3),
            targetLevel: T,
            startLevel: start,
            protectFrom,
            blessedTea,
            guzzlingBonus: 1.12,
            stock,
        });
    }
    fixtures.forEach((f, idx) => {
        test(`fixture ${idx}`, () => {
            const got = expectedProtectionsFromStock(f);
            const want = referenceStock(f);
            if (want === null) expect(got).toBeNull();
            else expect(Math.abs(got - want)).toBeLessThan(1e-9);
        });
    });

    test('zero stock, no protect, short chances', () => {
        const f = fixtures[1];
        expect(expectedProtectionsFromStock({ ...f, stock: 0 })).toBe(0);
        expect(expectedProtectionsFromStock({ ...f, protectFrom: 0 })).toBe(0);
        expect(expectedProtectionsFromStock({ ...f, successChances: [0.5] })).toBeNull();
    });
});
