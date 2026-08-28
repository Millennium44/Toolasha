/**
 * Consumable target
 *
 * How long the stock is supposed to last.
 *
 * One setting, in one place, because two things read it and they are in
 * different bundles. The Consumables panel measures every shortfall against it —
 * "buy for three days" is a different number from "buy for eight hours". The
 * overlay tile colours against it: a consumable lasting two days is fine if you
 * asked for one and is the thing to go and fix if you asked for three. A tile
 * and a panel disagreeing about that would be worse than either being wrong,
 * because you would have to work out which one to believe.
 *
 * Held in memory and mirrored to storage: the tile redraws every second and an
 * await per draw is not a thing to put behind a colour.
 */

import dataManager from '../core/data-manager.js';
import storage from '../core/storage.js';
import { readScoped, writeScoped } from './character-key.js';

const STORAGE_KEY = 'consumablesSettings';

/** The durations offered, in the order the header button cycles them */
export const TARGETS = [
    { label: '8 hours', seconds: 8 * 3600 },
    { label: '1 day', seconds: 86400 },
    { label: '3 days', seconds: 3 * 86400 },
    { label: '1 week', seconds: 7 * 86400 },
];

const DEFAULT_INDEX = 1;
let index = DEFAULT_INDEX;

/**
 * Bumped on every `loadTarget()` call. A read that resolves after a newer one
 * has already started belongs to a character this module has since left —
 * two switches close enough together interleave their `readScoped` awaits,
 * and storage does not promise to resolve them in call order. Without this,
 * the older read's answer can land last and overwrite `index` with the
 * departed character's target, which the very next `cycleTarget()` then
 * writes down permanently under the *current* character's key.
 */
let generation = 0;

/**
 * @returns {{label: string, seconds: number}} The duration everything is
 *   measured against
 */
export function currentTarget() {
    return TARGETS[index] || TARGETS[DEFAULT_INDEX];
}

/** @returns {number} Which of `TARGETS` is selected */
export function targetIndex() {
    return index;
}

/**
 * Move to the next duration and remember it.
 * @returns {{label: string, seconds: number}} The new target
 */
export function cycleTarget() {
    index = (index + 1) % TARGETS.length;
    writeScoped(STORAGE_KEY, { targetSeconds: currentTarget().seconds }, 'settings').catch((error) => {
        console.error('[ConsumableTarget] Saving the target failed:', error);
    });
    return currentTarget();
}

/**
 * Read the target back at start-up.
 *
 * @param {Function} [onLoaded] - Called once the answer is in, for anything that
 *   has already drawn against the default
 * @returns {Promise<void>}
 */
export async function loadTarget(onLoaded) {
    const started = (generation += 1);
    try {
        // Waits for the database: it is opened after the libraries are
        // evaluated, so a read at module scope always returns the default
        await storage.ready;
        const saved = await readScoped(STORAGE_KEY, 'settings', null, { migrate: 'adopt' });
        if (started !== generation) return; // A newer switch already started its own read
        const found = TARGETS.findIndex((target) => target.seconds === saved?.targetSeconds);
        // A value stored by an older list must not win over the code's
        index = found >= 0 ? found : DEFAULT_INDEX;
    } catch (error) {
        console.error('[ConsumableTarget] Reading the target failed:', error);
    }
    if (started !== generation) return; // Superseded — the newer call owns the next redraw
    onLoaded?.(currentTarget());
}

// How much stock is enough is a question about one character's habits, so the
// key is theirs — and nothing here re-runs on a switch unless it asks to be told
dataManager.on('character_initialized', () => loadTarget());
dataManager.on('character_switched', () => loadTarget());
