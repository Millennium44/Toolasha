/**
 * Minimal dense-matrix helper: exactly the operations the enhancement Markov
 * chain needs, and nothing else.
 *
 * These few calls — `zeros`, `identity`, `subset`, `subtract`, `inv` on a matrix
 * that is at most 20×20 — used to be the entire reason the userscript pulled in
 * math.js: a ~600 KB `@require` on the page and an `importScripts` of the same
 * library inside every enhancement and networth worker, parsed afresh per
 * worker. A Gauss–Jordan inverse of a 20×20 matrix is thirty lines.
 *
 * The API is deliberately shaped like the slice of math.js it replaces
 * (`math.inv(math.subtract(I, Q))`, `M.get([i, j])`) so the call sites and the
 * serialised `buildEnhancementMarkov` did not have to change, and so a future
 * reader comparing against the old code sees the same expressions.
 *
 * The factory closes over nothing on purpose: the worker managers serialise it
 * with `toString()` and evaluate it inside their blob workers, which cannot
 * import modules. Anything read from module scope here would be undefined
 * there — the same constraint `buildEnhancementMarkov` is written under.
 * @returns {Object} A math.js-shaped namespace with the operations listed above
 */
export function createMatrixMath() {
    /**
     * Dense row-major matrix over Float64Array rows.
     */
    class Matrix {
        /**
         * @param {number} rows - Row count
         * @param {number} cols - Column count
         */
        constructor(rows, cols) {
            this.rows = rows;
            this.cols = cols;
            this.data = [];
            for (let i = 0; i < rows; i++) {
                this.data.push(new Float64Array(cols));
            }
        }

        /**
         * @param {Array<number>} pos - [row, column]
         * @returns {number} The stored value
         */
        get(pos) {
            return this.data[pos[0]][pos[1]];
        }

        /**
         * Store a value, growing the matrix if the position is outside it.
         *
         * math.js resizes on an out-of-range `set`, and the chain builder
         * relies on it: the absorbing state is written at `[targetLevel,
         * targetLevel]`, which for a target of 20 is one past the 20×20 matrix,
         * and a Blessed Tea double jump can write one past the edge too. Those
         * cells are never read back — the fundamental matrix only ever looks at
         * the transient block — but throwing there would break every level-20
         * calculation.
         * @param {Array<number>} pos - [row, column]
         * @param {number} value - Value to store
         * @returns {Matrix} this, for chaining like math.js
         */
        set(pos, value) {
            const [row, col] = pos;
            if (col >= this.cols) {
                const cols = col + 1;
                for (let i = 0; i < this.data.length; i++) {
                    const grown = new Float64Array(cols);
                    grown.set(this.data[i]);
                    this.data[i] = grown;
                }
                this.cols = cols;
            }
            while (row >= this.rows) {
                this.data.push(new Float64Array(this.cols));
                this.rows += 1;
            }
            this.data[row][col] = value;
            return this;
        }

        /**
         * Extract a submatrix.
         * @param {{rows: Array<number>, cols: Array<number>}} index - From `index(range(…), range(…))`
         * @returns {Matrix} The selected block
         */
        subset(index) {
            const out = new Matrix(index.rows.length, index.cols.length);
            for (let i = 0; i < index.rows.length; i++) {
                for (let j = 0; j < index.cols.length; j++) {
                    out.data[i][j] = this.data[index.rows[i]][index.cols[j]];
                }
            }
            return out;
        }

        /**
         * @returns {Array<Array<number>>} Plain nested-array copy
         */
        toArray() {
            return this.data.map((row) => Array.from(row));
        }
    }

    return {
        Matrix,

        /**
         * @param {number} rows - Row count
         * @param {number} cols - Column count
         * @returns {Matrix} An all-zero matrix
         */
        zeros(rows, cols) {
            return new Matrix(rows, cols);
        },

        /**
         * @param {number} n - Size
         * @returns {Matrix} The n×n identity
         */
        identity(n) {
            const out = new Matrix(n, n);
            for (let i = 0; i < n; i++) out.data[i][i] = 1;
            return out;
        },

        /**
         * @param {number} start - Inclusive start
         * @param {number} end - Exclusive end
         * @returns {Array<number>} The indices in between
         */
        range(start, end) {
            const out = [];
            for (let i = start; i < end; i++) out.push(i);
            return out;
        },

        /**
         * @param {Array<number>} rows - Row indices
         * @param {Array<number>} cols - Column indices
         * @returns {{rows: Array<number>, cols: Array<number>}} A subset selector
         */
        index(rows, cols) {
            return { rows, cols };
        },

        /**
         * Element-wise A − B.
         * @param {Matrix} a - Left operand
         * @param {Matrix} b - Right operand
         * @returns {Matrix} The difference
         */
        subtract(a, b) {
            const out = new Matrix(a.rows, a.cols);
            for (let i = 0; i < a.rows; i++) {
                for (let j = 0; j < a.cols; j++) {
                    out.data[i][j] = a.data[i][j] - b.data[i][j];
                }
            }
            return out;
        },

        /**
         * Invert a square matrix by Gauss–Jordan elimination with partial pivoting.
         *
         * Partial pivoting is not optional here even though (I − Q) is
         * diagonally dominant for every chain we build: a target level of 1
         * gives a 1×1 matrix, and a protected run can put a near-zero on the
         * diagonal. Picking the largest pivot in the column keeps the result
         * within floating-point noise of the LU-based inverse this replaced.
         * @param {Matrix} matrix - Square matrix to invert
         * @returns {Matrix} The inverse
         * @throws {Error} If the matrix is not square, or is singular
         */
        inv(matrix) {
            const n = matrix.rows;
            if (matrix.cols !== n) {
                throw new Error(`Cannot invert a ${matrix.rows}x${matrix.cols} matrix: not square`);
            }

            // Work on copies so the caller's matrix is untouched
            const a = matrix.data.map((row) => Float64Array.from(row));
            const inverse = new Matrix(n, n);
            for (let i = 0; i < n; i++) inverse.data[i][i] = 1;
            const b = inverse.data;

            for (let col = 0; col < n; col++) {
                // Partial pivot: largest magnitude in this column at or below the diagonal
                let pivotRow = col;
                let pivotMagnitude = Math.abs(a[col][col]);
                for (let row = col + 1; row < n; row++) {
                    const magnitude = Math.abs(a[row][col]);
                    if (magnitude > pivotMagnitude) {
                        pivotMagnitude = magnitude;
                        pivotRow = row;
                    }
                }

                if (pivotMagnitude === 0) {
                    throw new Error('Cannot invert a singular matrix');
                }

                if (pivotRow !== col) {
                    const tmpA = a[col];
                    a[col] = a[pivotRow];
                    a[pivotRow] = tmpA;
                    const tmpB = b[col];
                    b[col] = b[pivotRow];
                    b[pivotRow] = tmpB;
                }

                const pivot = a[col][col];
                const aRow = a[col];
                const bRow = b[col];
                for (let j = 0; j < n; j++) {
                    aRow[j] /= pivot;
                    bRow[j] /= pivot;
                }

                for (let row = 0; row < n; row++) {
                    if (row === col) continue;
                    const factor = a[row][col];
                    if (factor === 0) continue;
                    const targetA = a[row];
                    const targetB = b[row];
                    for (let j = 0; j < n; j++) {
                        targetA[j] -= factor * aRow[j];
                        targetB[j] -= factor * bRow[j];
                    }
                }
            }

            return inverse;
        },
    };
}

/**
 * The shared main-thread instance. Named `matrixMath` rather than `math` at the
 * call sites so it is obvious which library is doing the work.
 */
const matrixMath = createMatrixMath();

export default matrixMath;
