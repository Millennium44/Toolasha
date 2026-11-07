/**
 * Names a phase of a sync operation in the PFormance panel's stall ledger.
 *
 * A pull is many awaits, so a longtask during one used to read as unattributed. This runs a phase under
 * `performanceMonitor.traceAsync`, which lists `sync:<kind>:<phase>` on any stall that overlapped it
 * (`inFlight`: pending work, not proven CPU). Observation only: the phase's value is returned, and its
 * error rethrown, exactly as without the wrapper. While the panel is not measuring, `fn` is just called.
 */

import performanceMonitor from '../../utils/performance-monitor.js';

/**
 * Run one phase of a sync operation under a ledger name.
 * @param {string} kind - Which operation, e.g. `pull`
 * @param {string} phase - Which phase of it, e.g. `download`
 * @param {Function} fn - The phase; returns its promise or value
 * @returns {Promise<*>|*} Whatever `fn` returned (rejects as `fn` does)
 */
export function syncPhase(kind, phase, fn) {
    return performanceMonitor.traceAsync(`sync:${kind}:${phase}`, fn);
}
