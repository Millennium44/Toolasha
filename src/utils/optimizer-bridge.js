/**
 * Link between the skill pages and the Skilling Optimizer.
 *
 * The Optimizer registers itself here while it is running; a skill page asks
 * here whether it may offer "Open in Optimizer" and what to call. Keeping the
 * link in its own file means the skill page never imports the Optimizer's UI
 * (which builds DOM when loaded), and a disabled Optimizer simply has no
 * registration, so nothing is offered.
 */

let opener = null;
const listeners = new Set();

function notify() {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.error('[OptimizerBridge] Listener failed:', error);
        }
    }
}

/**
 * Be told when the Optimizer registers or unregisters (it restarts on a setting flip or character switch).
 * @param {function(): void} listener - Called after each change
 * @returns {function(): void} Unsubscribe
 */
export function onOpenerChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Called by the Optimizer when it starts.
 * @param {{supports: function(string): boolean, open: function(string, (string|null)): Promise<boolean>}} handlers
 *   `supports(skillHrid)` says whether the Optimizer has a view for the skill;
 *   `open(skillHrid, actionHrid)` shows it.
 * @returns {function(): void} Unregister (only removes this registration)
 */
export function registerOptimizerOpener(handlers) {
    opener = handlers;
    notify();
    return () => {
        if (opener !== handlers) return;
        opener = null;
        notify();
    };
}

/**
 * Whether the Optimizer is running and has a view for this skill.
 * @param {string|null} skillHrid - e.g. `/skills/woodcutting`
 * @returns {boolean}
 */
export function canOpenInOptimizer(skillHrid) {
    return Boolean(opener && skillHrid && opener.supports(skillHrid));
}

/**
 * Show the skill in the Optimizer, opening the character panel and its tab as needed.
 * @param {string} skillHrid - e.g. `/skills/woodcutting`
 * @param {string|null} [actionHrid] - Action to preselect, if any
 * @returns {Promise<boolean>} Whether the Optimizer was shown
 */
export async function openInOptimizer(skillHrid, actionHrid = null) {
    if (!canOpenInOptimizer(skillHrid)) return false;
    return opener.open(skillHrid, actionHrid);
}
