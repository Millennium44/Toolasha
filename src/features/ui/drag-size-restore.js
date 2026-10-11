/**
 * Drag Size Restore
 *
 * The game saves the dragged inventory-column and chat-panel sizes to
 * localStorage as decimal percentages ("25.62034832591766"), but reads them
 * back with `parseInt(...)`. After every reload both come back truncated to the
 * whole percent, up to about 1% (roughly 20px) narrower than where the player
 * left them.
 *
 * The live sizes sit in the React state of the root game component, so once
 * that component is mounted this puts the exact saved value back with a single
 * `setState`. It only does so when the state still equals the truncated saved
 * value, meaning the player has not dragged since; it never writes
 * localStorage and never touches state that already matches.
 */

import { createTimerRegistry } from '../../utils/timer-registry.js';

/** Game localStorage key -> root component state key */
const SIZES = [
    { storageKey: 'inventoryDragSize', stateKey: 'inventoryDragSize' },
    { storageKey: 'chatDragSize', stateKey: 'chatDragSize' },
];

/** Percentages outside this are not a drag the game could have produced */
const MIN_PERCENT = 1;
const MAX_PERCENT = 99;

const RETRY_MS = 500;
const MAX_ATTEMPTS = 40;

/**
 * Find the root game component by walking the React fiber tree.
 * @returns {Object|null} Game component instance
 */
function getGameObject() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function find(fiber) {
        if (!fiber) return null;
        if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Read a saved size from the game's own localStorage key (the game's storage,
 * not Toolasha's, so the direct read is deliberate).
 * @param {string} key - Game localStorage key
 * @returns {number|null} Parsed percentage, or null when missing or unusable
 */
function readSaved(key) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        const value = parseFloat(raw);
        if (!Number.isFinite(value) || value < MIN_PERCENT || value > MAX_PERCENT) return null;
        return value;
    } catch {
        return null;
    }
}

/**
 * Work out which state keys need the exact saved value put back.
 * @param {Object} state - Game component state
 * @returns {Object} Partial state to apply (empty when nothing differs)
 */
export function computeRestore(state) {
    const patch = {};
    if (!state) return patch;
    for (const { storageKey, stateKey } of SIZES) {
        const saved = readSaved(storageKey);
        if (saved === null) continue;
        if (saved !== Math.trunc(saved) && state[stateKey] === Math.trunc(saved)) {
            patch[stateKey] = saved;
        }
    }
    return patch;
}

/**
 * One attempt to restore the sizes.
 * @returns {boolean} True when the game component was found (done, success or not)
 */
export function applyOnce() {
    const game = getGameObject();
    if (!game || typeof game.setState !== 'function' || !game.state) return false;
    try {
        const patch = computeRestore(game.state);
        if (Object.keys(patch).length > 0) game.setState(patch);
    } catch (error) {
        console.error('[DragSizeRestore] Could not restore panel sizes:', error);
    }
    return true;
}

let timers = null;

const dragSizeRestore = {
    name: 'Drag Size Restore',

    initialize() {
        this.cleanup();
        timers = createTimerRegistry();
        const registry = timers;
        let attempts = 0;
        const attempt = () => {
            attempts += 1;
            if (applyOnce() || attempts >= MAX_ATTEMPTS) return;
            registry.scheduleTimeout(attempt, RETRY_MS, 'dragSizeRestore');
        };
        attempt();
    },

    disable() {
        this.cleanup();
    },

    cleanup() {
        if (timers) timers.clearAll();
        timers = null;
    },
};

export default dragSizeRestore;
