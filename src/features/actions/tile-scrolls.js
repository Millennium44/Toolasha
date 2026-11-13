/**
 * Simulated scrolls on the skill page's action tiles
 *
 * The scroll chips on an action panel make that panel's figures show what a scroll would do. This
 * puts the same chosen scrolls (the Defaults button, the Loadouts panel, the chips) behind the tiles'
 * Profit/hr, Exp/hr and Eff. XP/hr, so every action can be compared with them at once.
 *
 * It is not a second calculation: it arms the same `dataManager` simulation the action panel arms,
 * runs the tiles' ordinary calculators inside it, and disarms. The profit and XP calculators finish
 * their arithmetic before their first await, so arming is a synchronous span that nothing else can
 * interleave with (a task card or the pinned page computing a real figure never sees it).
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { loadoutSnapshot, scrollSimulator } from '../../utils/bundle-bridge.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import bundledScrollSimulator from '../combat/scroll-simulator.js';
import { SELECTION_CHANGED_EVENT } from '../../utils/scroll-buff-values.js';
import {
    SIMULATED_ACTION_TYPES,
    getApplicableScrollBuffs,
    getOwnedScrolls,
    getSimulatedScrollNames,
    scrollItemHrid,
    shortScrollName,
} from './scroll-chips.js';

/** The setting behind the tiles' use of simulated scrolls (and the header "Scrolls" button) */
export const TILE_SCROLLS_SETTING = 'skillTiles_simulatedScrolls';

function simulator() {
    return scrollSimulator() || bundledScrollSimulator;
}

/**
 * The scrolls chosen for an action type that could apply to it, whether or not the tiles use them.
 * Empty while the simulation switch is off or the action type takes no part in the simulation.
 * Only scrolls the action type can use are kept: the default selection is shared by every skill, and
 * a chip row (which lists only usable scrolls) could never show the rest.
 * @param {string} actionTypeHrid
 * @returns {Set<string>} Buff type hrids
 */
export function getChosenScrolls(actionTypeHrid) {
    if (!actionTypeHrid || !config.getSetting('simulateScrollEffects')) return new Set();
    if (!SIMULATED_ACTION_TYPES.includes(actionTypeHrid)) return new Set();
    const chosen = simulator().getScrollSetForActionType(actionTypeHrid);
    if (!chosen || chosen.size === 0) return new Set();
    const usable = new Set(getApplicableScrollBuffs(actionTypeHrid));
    return new Set([...chosen].filter((hrid) => usable.has(hrid)));
}

/**
 * Every scroll the picker offers for an action type, in chip order, with what the picker shows for each.
 * Scrolls are identified by buff hrid and item hrid, never by their displayed names.
 * @param {string} actionTypeHrid
 * @returns {Array<{buff: string, name: string, itemHrid: string|null, owned: number|null, checked: boolean}>}
 */
export function listPickerScrolls(actionTypeHrid) {
    if (!actionTypeHrid) return [];
    const selected = simulator().resolveSelection(actionTypeHrid).set;
    return getApplicableScrollBuffs(actionTypeHrid).map((buff) => {
        const itemHrid = scrollItemHrid(buff);
        return {
            buff,
            name: shortScrollName(buff),
            itemHrid,
            owned: getOwnedScrolls(itemHrid),
            checked: selected.has(buff),
        };
    });
}

/**
 * Tick or untick one scroll in the selection the chips edit (the active loadout's list, else the default),
 * through the same simulator call a chip click makes. Resolves again at call time, as the chip does.
 * @param {string} actionTypeHrid
 * @param {string} buffTypeHrid
 * @param {boolean} on
 * @returns {Promise<boolean>} Whether the selection was kept
 */
export async function setPickerScroll(actionTypeHrid, buffTypeHrid, on) {
    const sim = simulator();
    const current = sim.resolveSelection(actionTypeHrid);
    const next = new Set(current.set);
    if (on) next.add(buffTypeHrid);
    else next.delete(buffTypeHrid);
    return sim.saveScrollsForLoadout(current.loadoutName, [...next]);
}

/**
 * The scrolls the tiles of an action type apply right now: the chosen ones, when the tile setting is on.
 * @param {string} actionTypeHrid
 * @returns {Set<string>}
 */
export function getTileScrolls(actionTypeHrid) {
    if (!config.getSetting(TILE_SCROLLS_SETTING)) return new Set();
    return getChosenScrolls(actionTypeHrid);
}

/**
 * Run `run` with the simulation armed for exactly `scrolls` (none arms nothing, and also hides any
 * simulation someone else has armed for this action type), then put back whatever was armed.
 * `run` must start the calculation synchronously; the figures it returns may be awaited afterwards.
 * @template T
 * @param {string} actionTypeHrid
 * @param {Set<string>} scrolls
 * @param {() => T} run
 * @returns {{result: T, simulated: string[]}} `simulated` is the short names of the scrolls that really
 *   changed something (one already active in the game is not simulated and not counted twice)
 */
function runArmed(actionTypeHrid, scrolls, run) {
    const previous = dataManager.scrollSimulationByActionType?.[actionTypeHrid];
    dataManager.setScrollSimulation(actionTypeHrid, scrolls);
    try {
        const result = run();
        const simulated = scrolls.size > 0 ? getSimulatedScrollNames(actionTypeHrid) : [];
        return { result, simulated };
    } finally {
        if (previous) dataManager.setScrollSimulation(actionTypeHrid, previous);
        else dataManager.clearScrollSimulation(actionTypeHrid);
    }
}

/**
 * Start a tile's calculation with the tiles' scrolls applied.
 * @template T
 * @param {string} actionTypeHrid
 * @param {() => T} run - Starts the calculators and returns their (possibly pending) results
 * @returns {{result: T, simulated: string[]}} `simulated` is empty when the figures are the real ones
 */
export function runWithTileScrolls(actionTypeHrid, run) {
    return runArmed(actionTypeHrid, getTileScrolls(actionTypeHrid), run);
}

/**
 * Start a calculation with no scroll simulated: the real figures, whatever else has armed.
 * @template T
 * @param {string} actionTypeHrid
 * @param {() => T} run
 * @returns {T}
 */
export function runWithoutScrolls(actionTypeHrid, run) {
    return runArmed(actionTypeHrid, new Set(), run).result;
}

/**
 * Plain-text mark appended to a figure that assumes scrolls (plain text, like the sell-tax marker:
 * tile stat spans are rewritten through `textContent`).
 * @param {string[]} simulated
 * @returns {string}
 */
export function tileScrollMarker(simulated) {
    return simulated?.length ? ' 📜' : '';
}

/**
 * Hover text for a simulated tile.
 * @param {string[]} simulated
 * @returns {string} Empty when nothing is simulated
 */
export function tileScrollTitle(simulated) {
    if (!simulated?.length) return '';
    const plural = simulated.length > 1;
    return (
        `These figures assume the ${simulated.join(', ')} ${plural ? 'scrolls' : 'scroll'} ` +
        `(chosen in Defaults or Loadouts). ${plural ? 'They are' : 'It is'} not active in the game. ` +
        `The "Scrolls" button above turns this off.`
    );
}

/**
 * Show or clear a tile's simulated-scrolls hover and accent on its stats box.
 * @param {HTMLElement|null} displayElement
 * @param {string[]} simulated
 */
export function paintTileScrollMark(displayElement, simulated) {
    if (!displayElement) return;
    const title = tileScrollTitle(simulated);
    if (title) {
        displayElement.title = title;
        displayElement.dataset.mwiSimulatedScrolls = simulated.join(',');
        displayElement.style.borderTopStyle = 'dashed';
        displayElement.style.borderTopColor = config.COLOR_ACCENT;
    } else if (displayElement.dataset.mwiSimulatedScrolls !== undefined) {
        displayElement.removeAttribute('title');
        delete displayElement.dataset.mwiSimulatedScrolls;
        displayElement.style.borderTopStyle = 'solid';
        displayElement.style.borderTopColor = `var(--border-color, ${config.COLOR_BORDER})`;
    }
}

/**
 * Call `callback` whenever what the tiles would show changes: the chosen scrolls (chips, Defaults,
 * Loadouts, and the saved selections finishing their load), the tile setting, the simulation switch,
 * or the loadout that decides which selection applies. May be called more than once per change.
 * Call from a feature's `initialize()`, not once at module load: the loadout store drops its
 * listeners when it is disabled.
 * @param {() => void} callback
 * @returns {() => void} Stop listening
 */
export function onTileScrollsChanged(callback) {
    const undo = [];
    document.addEventListener(SELECTION_CHANGED_EVENT, callback);
    undo.push(() => document.removeEventListener(SELECTION_CHANGED_EVENT, callback));
    for (const key of [TILE_SCROLLS_SETTING, 'simulateScrollEffects']) {
        const stop = config.onSettingChange(key, callback);
        if (typeof stop === 'function') undo.push(stop);
    }
    const snapshots = loadoutSnapshot() || bundledLoadoutSnapshot;
    if (typeof snapshots?.onUpdate === 'function') {
        snapshots.onUpdate(callback);
        undo.push(() => snapshots.offUpdate?.(callback));
    }
    return () => {
        for (const fn of undo) fn();
    };
}
