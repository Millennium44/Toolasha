/**
 * Complex arithmetic and a radix-2 FFT.
 *
 * Exists for `drop-luck.js`, which works in the frequency domain: the value of a
 * session's drops is a sum of many independent random variables, and sums are
 * ugly in the value domain and a plain product in the frequency one. Getting a
 * distribution back out at the end is one inverse transform.
 *
 * Complex numbers are `[re, im]` pairs rather than objects or parallel typed
 * arrays. Pairs allocate more than typed arrays would, and if the luck analysis
 * ever needs to get faster this is the first place to look — but the transform
 * itself, which is where the array is longest, runs on plain number arrays.
 *
 * Ported from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
 */

/** @typedef {[number, number]} Complex - A complex number as [real, imaginary] */

/**
 * @param {Complex} a - Left
 * @param {Complex} b - Right
 * @returns {Complex} a × b
 */
export function cMul(a, b) {
    return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

/**
 * @param {Complex} a - Numerator
 * @param {Complex} b - Denominator
 * @returns {Complex} a ÷ b
 */
export function cDiv(a, b) {
    const magnitude = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / magnitude, (a[1] * b[0] - a[0] * b[1]) / magnitude];
}

/**
 * A complex number to a real power, via polar form.
 * @param {Complex} c - Base
 * @param {number} x - Exponent
 * @returns {Complex} c^x
 */
export function cPow(c, x) {
    const argument = Math.atan2(c[1], c[0]) * x;
    const magnitude = Math.pow(c[0] * c[0] + c[1] * c[1], x / 2);
    return [magnitude * Math.cos(argument), magnitude * Math.sin(argument)];
}

/**
 * A vector of `n` copies of a real number.
 * @param {number} n - Length
 * @param {number} value - The real part; imaginary is zero
 * @returns {Complex[]} The vector
 */
export function vecConstant(n, value) {
    const vector = new Array(n);
    for (let i = 0; i < n; i++) vector[i] = [value, 0];
    return vector;
}

/**
 * Multiply a vector by another, in place.
 * @param {Complex[]} target - Mutated and returned
 * @param {Complex[]} other - Multiplier
 * @returns {Complex[]} target
 */
export function vecMulEq(target, other) {
    for (let i = 0; i < target.length; i++) {
        const re = target[i][0] * other[i][0] - target[i][1] * other[i][1];
        const im = target[i][0] * other[i][1] + target[i][1] * other[i][0];
        target[i][0] = re;
        target[i][1] = im;
    }
    return target;
}

/**
 * Scale a vector by a real number, in place.
 * @param {Complex[]} target - Mutated and returned
 * @param {number} scale - Multiplier
 * @returns {Complex[]} target
 */
export function vecScaleEq(target, scale) {
    for (let i = 0; i < target.length; i++) {
        target[i][0] *= scale;
        target[i][1] *= scale;
    }
    return target;
}

/**
 * Add the elementwise product of two vectors into a third, in place.
 * The inner step of the wave transition graph, where each state accumulates its
 * successors weighted by the monster that leads to them.
 * @param {Complex[]} target - Mutated and returned
 * @param {Complex[]} a - One factor
 * @param {Complex[]} b - The other
 * @returns {Complex[]} target
 */
export function vecAddMulEq(target, a, b) {
    for (let i = 0; i < target.length; i++) {
        target[i][0] += a[i][0] * b[i][0] - a[i][1] * b[i][1];
        target[i][1] += a[i][0] * b[i][1] + a[i][1] * b[i][0];
    }
    return target;
}

/**
 * Powers of a unit complex number: cos(k·angle) and sin(k·angle) for k = 0…n−1.
 *
 * Built by angle addition from earlier entries rather than by calling `Math.cos`
 * and `Math.sin` n times, which is the hot loop of the whole analysis — every
 * drop in a session builds one of these. The recurrence costs accuracy: error
 * compounds along the table, reaching a few parts in 1e13 by the far end of a
 * 4096-entry one rather than staying at machine epsilon. That is orders below the
 * sampling error of the transform it feeds, and `complex-fft.test.js` pins it so
 * a regression shows up as a failure rather than as a slightly wrong percentile.
 *
 * @param {number} angle - The base angle in radians
 * @param {number} n - How many powers; must be a positive multiple of 4
 * @returns {[number[], number[]]} [cosines, sines]
 */
export function unitPowers(angle, n) {
    if (!Number.isInteger(n) || n < 4 || n % 4 !== 0) {
        throw new Error(`unitPowers needs a positive multiple of 4, got ${n}`);
    }

    const cos = new Array(n);
    const sin = new Array(n);
    cos[0] = 1;
    sin[0] = 0;
    cos[1] = Math.cos(angle);
    sin[1] = Math.sin(angle);
    cos[2] = cos[1] * cos[1] - sin[1] * sin[1];
    sin[2] = 2 * sin[1] * cos[1];
    cos[3] = cos[1] * cos[2] - sin[1] * sin[2];
    sin[3] = sin[1] * cos[2] + cos[1] * sin[2];

    // Each block of four is built from two roughly-halfway entries, so the number
    // of additions any entry is removed from the seed grows like log(n) rather
    // than n — which is what keeps the compounding error down
    for (let i = 4; i < n; i += 4) {
        const j = i >> 1;
        const k = i - j;
        cos[i] = cos[j] * cos[k] - sin[j] * sin[k];
        sin[i] = sin[j] * cos[k] + cos[j] * sin[k];
        cos[i + 1] = cos[j] * cos[k + 1] - sin[j] * sin[k + 1];
        sin[i + 1] = sin[j] * cos[k + 1] + cos[j] * sin[k + 1];
        cos[i + 2] = cos[j + 1] * cos[k + 1] - sin[j + 1] * sin[k + 1];
        sin[i + 2] = sin[j + 1] * cos[k + 1] + cos[j + 1] * sin[k + 1];
        cos[i + 3] = cos[j + 1] * cos[k + 2] - sin[j + 1] * sin[k + 2];
        sin[i + 3] = sin[j + 1] * cos[k + 2] + cos[j + 1] * sin[k + 2];
    }

    return [cos, sin];
}

/**
 * In-place iterative radix-2 FFT.
 *
 * Decimation in time: the bit-reversal permutation first, then log₂(n) passes of
 * butterflies over doubling block sizes.
 *
 * @param {number[]} re - Real parts, mutated in place
 * @param {number[]} im - Imaginary parts, mutated in place; same length as `re`
 */
export function fftInPlace(re, im) {
    const n = re.length;
    if (n <= 1) return;
    if ((n & (n - 1)) !== 0) throw new Error(`fftInPlace needs a power-of-two length, got ${n}`);
    if (im.length !== n) throw new Error('fftInPlace needs matching real and imaginary lengths');

    for (let i = 0, j = 0; i < n; i++) {
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
        let k = n >> 1;
        while (k > 0 && k <= j) {
            j -= k;
            k >>= 1;
        }
        j += k;
    }

    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const step = (-2 * Math.PI) / len;
        const stepRe = Math.cos(step);
        const stepIm = Math.sin(step);

        for (let start = 0; start < n; start += len) {
            let wRe = 1;
            let wIm = 0;

            for (let offset = 0; offset < half; offset++) {
                const lo = start + offset;
                const hi = lo + half;
                const tRe = wRe * re[hi] - wIm * im[hi];
                const tIm = wRe * im[hi] + wIm * re[hi];

                re[hi] = re[lo] - tRe;
                im[hi] = im[lo] - tIm;
                re[lo] += tRe;
                im[lo] += tIm;

                const nextWRe = wRe * stepRe - wIm * stepIm;
                wIm = wRe * stepIm + wIm * stepRe;
                wRe = nextWRe;
            }
        }
    }
}

/**
 * Binary search for the point where a monotonic function reaches a target.
 * @param {Function} f - Monotonically non-decreasing
 * @param {number} low - Lower bound
 * @param {number} high - Upper bound
 * @param {number} target - Value to reach
 * @param {number} [iterations] - Halvings; 60 takes a unit interval below 1e-18
 * @returns {number} The crossing point
 */
export function binarySearch(f, low, high, target, iterations = 60) {
    let lo = low;
    let hi = high;
    for (let i = 0; i < iterations; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < target) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}
