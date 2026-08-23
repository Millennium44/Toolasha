import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

// Library header for standalone enhancement library (no userscript metadata)
const standaloneHeader = `/**
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
`;

// Prepend the library header to the bundle.
//
// This used to vendor the whole of math.js in front of our code — roughly
// 600 KB for one 20x20 matrix inverse. `src/utils/matrix-inverse.js` does that
// job in a few dozen lines and rollup bundles it like any other import.
function prependHeader(headerContent) {
    return {
        name: 'prepend-header',
        renderChunk(code) {
            return `${headerContent}
${code}
`;
        },
    };
}

export default {
    input: 'src/libraries/enhancement-standalone.js',
    output: {
        file: 'dist/libraries/toolasha-enhancement-standalone.js',
        format: 'iife',
        name: 'ToolashaEnhancementBundle',
    },
    plugins: [
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        commonjs(),
        prependHeader(standaloneHeader),
    ],
};
