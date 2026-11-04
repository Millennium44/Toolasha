/**
 * The queue helper's current batch as gold stages behind the game queue.
 *
 * One function for the Iron Bell panel and the action-bar strip: both hold cash back for the batch when the
 * switch is on, and a number the two compute separately would be two numbers. The panel publishes what the
 * helper is set to (`ironCowRuntime.batchSpec`) and both read it here.
 */

import { batchStages } from './coin-reserve.js';
import { queuedLegCounts, reduceBatchByQueue } from './ironbell-cycle.js';
import { batchForSpec } from './starfruit-loop.js';

/**
 * The gold stages of the batch the helper is set to, for the legs the game queue does not already hold.
 *
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @param {Object|null} spec - `{max, maxCap, basis, hours}`, what the helper is set to
 * @param {Object|null} state - From `readCharacterState`
 * @param {Array<Object>} actions - The game's action queue
 * @returns {{stages: Array<Object>|null, batch: Object|null, missing: Object|null, reason: string}|null} Null
 *   when there is no batch to hold cash for; `stages` null with a reason when the decompose fee has no price
 */
export function nextSetStages(loop, spec, state, actions) {
    if (!loop || loop.missing?.length || !spec) return null;
    const batch = batchForSpec(loop, spec, state);
    if (!batch) return null;
    const queued = queuedLegCounts(actions, loop.items, {
        loop,
        fruitHeld: state?.starfruitHeld || 0,
        essenceHeld: state?.essenceHeld || 0,
    });
    const missing = { ...reduceBatchByQueue(batch, queued, loop), queued };
    const stages = batchStages(loop, missing.batch);
    return {
        stages,
        batch,
        missing,
        reason: stages ? '' : 'The decompose fee has no price yet, so nothing was held back for the next set.',
    };
}

export default { nextSetStages };
