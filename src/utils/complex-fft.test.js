import { describe, test, expect } from 'vitest';
import {
    cMul,
    cDiv,
    cPow,
    vecConstant,
    vecMulEq,
    vecScaleEq,
    vecAddMulEq,
    unitPowers,
    fftInPlace,
    binarySearch,
} from './complex-fft.js';

/** The transform this file exists to provide, computed the slow obvious way */
function naiveDFT(re, im) {
    const n = re.length;
    const outRe = new Array(n).fill(0);
    const outIm = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
        for (let t = 0; t < n; t++) {
            const angle = (-2 * Math.PI * k * t) / n;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            outRe[k] += re[t] * cos - im[t] * sin;
            outIm[k] += re[t] * sin + im[t] * cos;
        }
    }
    return [outRe, outIm];
}

describe('complex arithmetic', () => {
    test('multiplies', () => {
        expect(cMul([1, 2], [3, 4])).toEqual([-5, 10]);
        expect(cMul([0, 1], [0, 1])).toEqual([-1, 0]);
    });

    test('divides back to what was multiplied', () => {
        const [re, im] = cDiv(cMul([3, -7], [2, 5]), [2, 5]);
        expect(re).toBeCloseTo(3, 12);
        expect(im).toBeCloseTo(-7, 12);
    });

    test('raises to a power', () => {
        const [re, im] = cPow([0, 1], 2);
        expect(re).toBeCloseTo(-1, 12);
        expect(im).toBeCloseTo(0, 12);
    });

    test('a fractional power lands halfway round', () => {
        // The CF layer raises a wave's characteristic function to the number of
        // waves, which is not always whole
        const [re, im] = cPow([-1, 0], 0.5);
        expect(re).toBeCloseTo(0, 12);
        expect(im).toBeCloseTo(1, 12);
    });
});

describe('vector operations', () => {
    test('builds a constant vector of any length', () => {
        // Not just multiples of four — the version this was ported from unrolled
        // by four and wrote past the end of anything else
        expect(vecConstant(3, 2)).toEqual([
            [2, 0],
            [2, 0],
            [2, 0],
        ]);
        expect(vecConstant(5, 1)).toHaveLength(5);
    });

    test('multiplies elementwise in place', () => {
        const target = [
            [1, 2],
            [3, 4],
        ];
        expect(
            vecMulEq(target, [
                [5, 6],
                [7, 8],
            ])
        ).toBe(target);
        expect(target).toEqual([
            [-7, 16],
            [-11, 52],
        ]);
    });

    test('scales in place', () => {
        expect(vecScaleEq([[1, 2]], 3)).toEqual([[3, 6]]);
    });

    test('accumulates a product in place', () => {
        const target = [[1, 1]];
        vecAddMulEq(target, [[2, 0]], [[0, 3]]);
        expect(target).toEqual([[1, 7]]);
    });
});

describe('unitPowers', () => {
    test('matches direct trigonometry across a long table', () => {
        // The recurrence trades accuracy for speed; this pins how much
        const [cos, sin] = unitPowers(1.0, 4096);
        let worst = 0;
        for (let k = 0; k < 4096; k++) {
            worst = Math.max(worst, Math.abs(cos[k] - Math.cos(k)), Math.abs(sin[k] - Math.sin(k)));
        }
        expect(worst).toBeLessThan(1e-11);
    });

    test('starts at one', () => {
        const [cos, sin] = unitPowers(0.7, 8);
        expect(cos[0]).toBe(1);
        expect(sin[0]).toBe(0);
    });

    test('refuses a length it cannot fill', () => {
        // The four-at-a-time loop would leave holes, and a hole reads as zero
        expect(() => unitPowers(1, 6)).toThrow();
        expect(() => unitPowers(1, 0)).toThrow();
    });
});

describe('fftInPlace', () => {
    test('agrees with the naive transform', () => {
        for (const n of [8, 64, 256]) {
            const re = Array.from({ length: n }, (_, i) => Math.sin(i * 1.7) + (i % 3));
            const im = Array.from({ length: n }, (_, i) => Math.cos(i * 0.3));
            const [expectRe, expectIm] = naiveDFT([...re], [...im]);

            fftInPlace(re, im);

            for (let k = 0; k < n; k++) {
                expect(re[k]).toBeCloseTo(expectRe[k], 8);
                expect(im[k]).toBeCloseTo(expectIm[k], 8);
            }
        }
    });

    test('a constant signal becomes a single spike', () => {
        const re = new Array(16).fill(1);
        const im = new Array(16).fill(0);
        fftInPlace(re, im);
        expect(re[0]).toBeCloseTo(16, 10);
        for (let k = 1; k < 16; k++) expect(re[k]).toBeCloseTo(0, 10);
    });

    test('leaves a one-element signal alone', () => {
        const re = [5];
        fftInPlace(re, [0]);
        expect(re).toEqual([5]);
    });

    test('refuses a length it cannot halve', () => {
        expect(() => fftInPlace([1, 2, 3], [0, 0, 0])).toThrow();
        expect(() => fftInPlace([1, 2], [0])).toThrow();
    });
});

describe('binarySearch', () => {
    test('finds where a monotonic function crosses', () => {
        expect(binarySearch((x) => x * x, 0, 4, 2)).toBeCloseTo(Math.SQRT2, 10);
    });

    test('clamps to the bounds when the target is outside them', () => {
        expect(binarySearch((x) => x, 0, 1, 5)).toBeCloseTo(1, 10);
        expect(binarySearch((x) => x, 0, 1, -5)).toBeCloseTo(0, 10);
    });
});
