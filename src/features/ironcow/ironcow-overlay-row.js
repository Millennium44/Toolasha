/**
 * The "Iron Bell next step" overlay tile.
 *
 * One line saying where the plan stands right now: which stage is still
 * blocking the loop ("Foraging 62/80"), or that the loop is ready and, once it
 * has been costed at least once, what it is currently worth in bells a week
 * ("Loop ready — 41K bells/week").
 *
 * ## Nothing is computed here
 *
 * The stage derivation is `ironcow-plan.js`'s, off the character's own live
 * state — the same call the panel itself makes, so the tile can never disagree
 * with the panel it summarises. The bells figure is the panel's own last costed
 * loop, read off `ironcow-runtime.js` rather than recomputed, for the same
 * reason `networth-rows.js` reads `networthFeature.currentData` instead of
 * pricing anything itself: costing the loop runs the gathering and alchemy
 * calculators, which is not something a tile redrawn on the overlay's timer may
 * do.
 *
 * Read off the runtime module rather than off the panel directly — this file
 * is imported *by* `ironcow-panel.js` to register itself, and importing the
 * panel back here would make that a circular dependency.
 *
 * ## Only meaningful on an iron cow
 *
 * A standard character has no plan to be a stage of, so the tile draws nothing
 * for one — which the overlay renders as a compact strip carrying the tile's
 * own name, same as any other tile with nothing to say yet.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import ironCowRuntime from './ironcow-runtime.js';
import { deriveStages, isIronCowMode, readCharacterState } from './ironcow-plan.js';

/**
 * Where the plan stands right now, in one line.
 *
 * Reading the character can throw if game data is half-loaded, same as the
 * panel's own `_safeState` — a tile that cannot be answered draws nothing
 * rather than taking the overlay down with it.
 *
 * @returns {string} e.g. "Foraging 62/80", "Loop ready", "Loop ready — 41.20K bells/week", or "" when not applicable
 */
function nextStepLine() {
    let state;
    try {
        state = readCharacterState();
    } catch (error) {
        console.error('[IronCow] Reading the character for the overlay tile failed:', error);
        return '';
    }
    if (!state || !isIronCowMode(state.gameMode)) return '';

    const stages = deriveStages(state, ironCowRuntime.overrides || {});
    const loopStage = stages.find((stage) => stage.id === 'loop');
    if (!loopStage) return '';
    if (!loopStage.ready) return loopStage.blockedBy?.[0] || '';

    const bellsPerWeek = ironCowRuntime.loop?.bells?.perWeek;
    if (Number.isFinite(bellsPerWeek) && bellsPerWeek > 0) {
        return `Loop ready — ${formatLargeNumber(Math.round(bellsPerWeek))} bells/week`;
    }
    return 'Loop ready';
}

registerRow({
    key: 'ironBellNextStep',
    name: 'Iron Bell next step',
    // Only worth anything to an iron cow, so nobody else sees it uninvited.
    defaultVisible: false,
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const text = nextStepLine();
        if (!text) return blank(container);

        row(container, [{ text, color: ROW_COLORS.neutral, bold: true }]);
        container.title = 'Where you stand in the Iron Bell Farming plan.\nDouble-click to open the panel.';
    },
    // Same gesture opens and dismisses it, per the overlay's own convention.
    onOpen: () => ironCowRuntime.toggle(),
});
