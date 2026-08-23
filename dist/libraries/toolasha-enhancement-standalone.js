/**
 * Toolasha Enhancement Calculator - Standalone Math Library
 *
 * Pure math library for MWI enhancement calculations. No game data dependencies.
 * Uses Markov Chain matrix math to calculate exact expected values.
 *
 * @version 1.0.0
 * @author Celasha
 * @license MIT
 * @repository https://github.com/Celasha/Toolasha
 *
 * Usage:
 *   const result = window.ToolashaEnhancement.calculate({
 *       baseItemPrice: 720000000,
 *       materialCostPerAttempt: 8979591,
 *       protectionPrice: 11500000,
 *       successRates: [0.55, 0.495, 0.495, ...],
 *       targetLevel: 9
 *   });
 */

(function () {
    'use strict';

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
    function createMatrixMath() {
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

    /**
     * Toolasha Enhancement Calculator - Standalone Math Library
     *
     * Pure math library with NO game data dependencies.
     * Uses Markov Chain matrix math to calculate exact expected values.
     *
     * Designed for external tools (like JIGS) that provide their own data.
     * All inputs are passed as parameters - no DOM or API calls.
     *
     * Usage:
     *   const result = window.ToolashaEnhancement.calculate({
     *       baseItemPrice: 720000000,
     *       materialCostPerAttempt: 8979591,
     *       protectionPrice: 11500000,
     *       successRates: [0.55, 0.495, 0.495, ...],
     *       targetLevel: 9
     *   });
     */


    /**
     * Base success rates by enhancement level (before bonuses)
     * Index 0 = +1, Index 19 = +20
     */
    const BASE_SUCCESS_RATES = [
        0.5, // +1
        0.45, // +2
        0.45, // +3
        0.4, // +4
        0.4, // +5
        0.4, // +6
        0.35, // +7
        0.35, // +8
        0.35, // +9
        0.35, // +10
        0.3, // +11
        0.3, // +12
        0.3, // +13
        0.3, // +14
        0.3, // +15
        0.3, // +16
        0.3, // +17
        0.3, // +18
        0.3, // +19
        0.3, // +20
    ];

    /**
     * Fibonacci calculation for item quantities (Philosopher's Mirror optimization)
     * @param {number} n - Index
     * @returns {number} Fibonacci-like value
     */
    function fib(n) {
        if (n === 0 || n === 1) {
            return 1;
        }
        return fib(n - 1) + fib(n - 2);
    }

    /**
     * Mirror Fibonacci calculation for mirror quantities
     * @param {number} n - Index
     * @returns {number} Number of mirrors needed
     */
    function mirrorFib(n) {
        if (n === 0) {
            return 1;
        }
        if (n === 1) {
            return 2;
        }
        return mirrorFib(n - 1) + mirrorFib(n - 2) + 1;
    }

    /**
     * Calculate enhancement statistics using Markov Chain matrix inversion
     *
     * @param {Object} params - Enhancement parameters
     * @param {number} params.targetLevel - Target enhancement level (1-20)
     * @param {number[]} params.successRates - Array of success rates per level (decimals, e.g., 0.55 for 55%)
     *                                          Index 0 = rate for +1, Index 19 = rate for +20
     * @param {number} params.protectFrom - Start using protection at this level (0 = never, 2+ = from that level)
     * @param {boolean} [params.blessedTea=false] - Whether Blessed Tea effect is active
     * @param {number} [params.guzzlingBonus=1.0] - Drink concentration multiplier for blessed tea
     * @returns {Object} Enhancement statistics (attempts, protectionCount)
     */
    function calculateEnhancementStats(params) {
        const { targetLevel, successRates, protectFrom = 0, blessedTea = false, guzzlingBonus = 1.0 } = params;

        // Validate inputs
        if (targetLevel < 1 || targetLevel > 20) {
            throw new Error('Target level must be between 1 and 20');
        }
        if (!successRates || successRates.length < targetLevel) {
            throw new Error('successRates array must have at least targetLevel elements');
        }
        if (protectFrom < 0 || protectFrom > targetLevel) {
            throw new Error('Protection level must be between 0 and target level');
        }

        // Build Markov Chain transition matrix (20×20)
        const markov = matrixMath.zeros(20, 20);

        for (let i = 0; i < targetLevel; i++) {
            const successChance = successRates[i];

            // Where do we go on failure?
            // Protection only applies when protectFrom > 0 AND we're at or above that level
            const failureDestination = protectFrom > 0 && i >= protectFrom ? i - 1 : 0;

            if (blessedTea) {
                // Blessed Tea: 1% base chance to jump +2, scaled by guzzling bonus
                const skipChance = successChance * 0.01 * guzzlingBonus;
                const remainingSuccess = successChance * (1 - 0.01 * guzzlingBonus);

                markov.set([i, i + 2], skipChance);
                markov.set([i, i + 1], remainingSuccess);
                markov.set([i, failureDestination], 1 - successChance);
            } else {
                // Normal: Success goes to +1, failure goes to destination
                markov.set([i, i + 1], successChance);
                markov.set([i, failureDestination], 1.0 - successChance);
            }
        }

        // Absorbing state at target level
        markov.set([targetLevel, targetLevel], 1.0);

        // Extract transient matrix Q (all states before target)
        const Q = markov.subset(matrixMath.index(matrixMath.range(0, targetLevel), matrixMath.range(0, targetLevel)));

        // Fundamental matrix: M = (I - Q)^-1
        const I = matrixMath.identity(targetLevel);
        const M = matrixMath.inv(matrixMath.subtract(I, Q));

        // Expected attempts from level 0 to target
        let attempts = 0;
        for (let i = 0; i < targetLevel; i++) {
            attempts += M.get([0, i]);
        }

        // Expected protection item uses
        let protectionCount = 0;
        if (protectFrom > 0 && protectFrom < targetLevel) {
            for (let i = protectFrom; i < targetLevel; i++) {
                const timesAtLevel = M.get([0, i]);
                const failureChance = markov.get([i, i - 1]);
                protectionCount += timesAtLevel * failureChance;
            }
        }

        return {
            attempts,
            protectionCount,
        };
    }

    /**
     * Calculate cost for a single protection strategy
     * @private
     */
    function calculateStrategyResult(params, protectFrom) {
        const { baseItemPrice, materialCostPerAttempt, protectionPrice, successRates, targetLevel } = params;

        const stats = calculateEnhancementStats({
            targetLevel,
            successRates,
            protectFrom,
            blessedTea: params.blessedTea || false,
            guzzlingBonus: params.guzzlingBonus || 1.0,
        });

        const materialCost = materialCostPerAttempt * stats.attempts;
        const protectionCost = protectionPrice * stats.protectionCount;
        const totalCost = baseItemPrice + materialCost + protectionCost;

        return {
            protectFrom,
            attempts: stats.attempts,
            protectionCount: stats.protectionCount,
            baseCost: baseItemPrice,
            materialCost,
            protectionCost,
            totalCost,
        };
    }

    /**
     * Main calculation function - finds optimal enhancement strategy
     *
     * @param {Object} params - All enhancement parameters
     * @param {number} params.baseItemPrice - Cost of base +0 item
     * @param {number} params.materialCostPerAttempt - Total material cost per enhancement attempt
     * @param {number} params.protectionPrice - Cost of cheapest protection option
     * @param {number[]} params.successRates - Array of success rates (decimals, index 0 = +1 rate)
     * @param {number} params.targetLevel - Target enhancement level (1-20)
     * @param {number} [params.philosopherMirrorPrice=0] - Price of Philosopher's Mirror (0 to disable)
     * @param {boolean} [params.blessedTea=false] - Whether Blessed Tea is active
     * @param {number} [params.guzzlingBonus=1.0] - Drink concentration multiplier
     * @returns {Object} Optimal strategy with cost breakdown
     *
     * @example
     * const result = ToolashaEnhancement.calculate({
     *     baseItemPrice: 720000000,
     *     materialCostPerAttempt: 8979591,
     *     protectionPrice: 11500000,
     *     successRates: [0.55, 0.495, 0.495, 0.44, 0.44, 0.44, 0.385, 0.385, 0.385],
     *     targetLevel: 9
     * });
     * // Returns: { totalCost, attempts, protectionCount, usedMirror, ... }
     */
    function calculate(params) {
        const {
            baseItemPrice,
            materialCostPerAttempt,
            protectionPrice,
            successRates,
            targetLevel,
            philosopherMirrorPrice = 0,
            blessedTea = false,
            guzzlingBonus = 1.0,
        } = params;

        // Validate required params
        if (typeof baseItemPrice !== 'number' || baseItemPrice < 0) {
            throw new Error('baseItemPrice must be a non-negative number');
        }
        if (typeof materialCostPerAttempt !== 'number' || materialCostPerAttempt < 0) {
            throw new Error('materialCostPerAttempt must be a non-negative number');
        }
        if (typeof protectionPrice !== 'number' || protectionPrice < 0) {
            throw new Error('protectionPrice must be a non-negative number');
        }
        if (!Array.isArray(successRates) || successRates.length === 0) {
            throw new Error('successRates must be a non-empty array');
        }
        if (typeof targetLevel !== 'number' || targetLevel < 1 || targetLevel > 20) {
            throw new Error('targetLevel must be between 1 and 20');
        }

        // Step 1: Build results matrix - test all protection strategies for each level
        const allResults = [];

        for (let level = 1; level <= targetLevel; level++) {
            const resultsForLevel = [];

            // Test "never protect" (0)
            resultsForLevel.push(
                calculateStrategyResult(
                    {
                        baseItemPrice,
                        materialCostPerAttempt,
                        protectionPrice,
                        successRates,
                        targetLevel: level,
                        blessedTea,
                        guzzlingBonus,
                    },
                    0
                )
            );

            // Test all "protect from X" strategies (2 through level)
            for (let protectFrom = 2; protectFrom <= level; protectFrom++) {
                resultsForLevel.push(
                    calculateStrategyResult(
                        {
                            baseItemPrice,
                            materialCostPerAttempt,
                            protectionPrice,
                            successRates,
                            targetLevel: level,
                            blessedTea,
                            guzzlingBonus,
                        },
                        protectFrom
                    )
                );
            }

            allResults.push(resultsForLevel);
        }

        // Step 2: Build target_costs array (minimum cost for each level)
        const targetCosts = new Array(targetLevel + 1);
        const targetAttempts = new Array(targetLevel + 1);
        targetCosts[0] = baseItemPrice;
        targetAttempts[0] = 0;

        for (let level = 1; level <= targetLevel; level++) {
            const resultsForLevel = allResults[level - 1];
            const minResult = resultsForLevel.reduce((best, curr) => (curr.totalCost < best.totalCost ? curr : best));
            targetCosts[level] = minResult.totalCost;
            targetAttempts[level] = minResult.attempts;
        }

        // Step 3: Apply Philosopher's Mirror optimization
        let mirrorStartLevel = null;

        if (philosopherMirrorPrice > 0) {
            for (let level = 3; level <= targetLevel; level++) {
                const traditionalCost = targetCosts[level];
                const mirrorCost = targetCosts[level - 2] + targetCosts[level - 1] + philosopherMirrorPrice;

                if (mirrorCost < traditionalCost) {
                    if (mirrorStartLevel === null) {
                        mirrorStartLevel = level;
                    }
                    targetCosts[level] = mirrorCost;
                }
            }
        }

        // Step 4: Build final result
        const finalLevelResults = allResults[targetLevel - 1];
        const optimalTraditional = finalLevelResults.reduce((best, curr) =>
            curr.totalCost < best.totalCost ? curr : best
        );

        if (mirrorStartLevel !== null) {
            // Mirror strategy was optimal
            const n = targetLevel - mirrorStartLevel;
            const numLowerTier = fib(n);
            const numUpperTier = fib(n + 1);
            const numMirrors = mirrorFib(n);

            const lowerTierLevel = mirrorStartLevel - 2;
            const upperTierLevel = mirrorStartLevel - 1;

            const costLowerTier = targetCosts[lowerTierLevel];
            const costUpperTier = targetCosts[upperTierLevel];
            const attemptsLowerTier = targetAttempts[lowerTierLevel];
            const attemptsUpperTier = targetAttempts[upperTierLevel];

            const totalLowerTierCost = numLowerTier * costLowerTier;
            const totalUpperTierCost = numUpperTier * costUpperTier;
            const totalMirrorsCost = numMirrors * philosopherMirrorPrice;
            const totalAttempts = numLowerTier * attemptsLowerTier + numUpperTier * attemptsUpperTier;

            return {
                targetLevel,
                protectFrom: optimalTraditional.protectFrom,
                attempts: totalAttempts,
                protectionCount: 0, // Mirror strategy doesn't use protection in final phase
                baseCost: 0,
                materialCost: 0,
                protectionCost: 0,
                consumedItemsCost: totalLowerTierCost + totalUpperTierCost,
                mirrorCost: totalMirrorsCost,
                totalCost: targetCosts[targetLevel],
                usedMirror: true,
                mirrorStartLevel,
                mirrorCount: numMirrors,
                consumedItems: [
                    { level: lowerTierLevel, quantity: numLowerTier, costEach: costLowerTier },
                    { level: upperTierLevel, quantity: numUpperTier, costEach: costUpperTier },
                ],
                traditionalCost: optimalTraditional.totalCost,
            };
        } else {
            // Traditional strategy was optimal
            return {
                targetLevel,
                protectFrom: optimalTraditional.protectFrom,
                attempts: optimalTraditional.attempts,
                protectionCount: optimalTraditional.protectionCount,
                baseCost: optimalTraditional.baseCost,
                materialCost: optimalTraditional.materialCost,
                protectionCost: optimalTraditional.protectionCost,
                consumedItemsCost: 0,
                mirrorCost: 0,
                totalCost: optimalTraditional.totalCost,
                usedMirror: false,
                mirrorStartLevel: null,
                mirrorCount: 0,
                consumedItems: [],
                traditionalCost: optimalTraditional.totalCost,
            };
        }
    }

    /**
     * Calculate success rate multiplier based on enhancing level vs item level
     *
     * @param {Object} params - Parameters
     * @param {number} params.enhancingLevel - Player's enhancing level (with bonuses)
     * @param {number} params.itemLevel - Item's level requirement
     * @param {number} [params.toolBonus=0] - Equipment/tool success bonus %
     * @returns {number} Multiplier to apply to base success rates
     *
     * @example
     * const multiplier = ToolashaEnhancement.getSuccessMultiplier({
     *     enhancingLevel: 100,
     *     itemLevel: 80,
     *     toolBonus: 5
     * });
     * // Returns: 1.15 (10% from level advantage + 5% from tools)
     */
    function getSuccessMultiplier(params) {
        const { enhancingLevel, itemLevel, toolBonus = 0 } = params;

        if (enhancingLevel >= itemLevel) {
            const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
            return 1 + (toolBonus + levelAdvantage) / 100;
        } else {
            return 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
        }
    }

    /**
     * Apply success multiplier to base rates to get actual rates
     *
     * @param {number} multiplier - Success rate multiplier from getSuccessMultiplier()
     * @param {number} [maxLevel=20] - How many levels to calculate
     * @returns {number[]} Array of actual success rates (decimals)
     *
     * @example
     * const rates = ToolashaEnhancement.applyMultiplierToBaseRates(1.10, 9);
     * // Returns: [0.55, 0.495, 0.495, 0.44, ...] for first 9 levels
     */
    function applyMultiplierToBaseRates(multiplier, maxLevel = 20) {
        const rates = [];
        for (let i = 0; i < maxLevel; i++) {
            const baseRate = BASE_SUCCESS_RATES[i];
            const actualRate = Math.min(1.0, baseRate * multiplier); // Cap at 100%
            rates.push(actualRate);
        }
        return rates;
    }

    // Export to global scope for @require usage
    window.ToolashaEnhancement = {
        // Main calculation function
        calculate,

        // Helper functions
        getSuccessMultiplier,
        applyMultiplierToBaseRates,
        calculateEnhancementStats,

        // Fibonacci helpers (for advanced usage)
        fib,
        mirrorFib,

        // Constants
        BASE_SUCCESS_RATES,

        // Version for compatibility checking
        VERSION: '1.0.0',
    };

})();
