/**
 * A class the user sets for a player, laid over what `class-inference.js` says.
 *
 * Inference is a guess from casts, kits and sheets, and it is sometimes wrong
 * in ways only the watcher can see — the auto-attacking tank whose taunt never
 * streamed, the healer who has only thrown damage so far. KikiMeter answers
 * this with a click on the class icon and a menu (ZhuLiMoon, MIT); this is the
 * same answer as a layer: nothing in the inference changes, and every surface
 * that draws a class tag passes the verdict through {@link applyClassOverride}
 * with the player's name on the way to the screen.
 *
 * Stored account-wide by player name (see `name-keyed-store.js` for why, and
 * for the read-versus-write race). The payloads that reach the boards carry a
 * name and no character id, so the name is the key; a player who renames
 * starts again from the inference.
 */

import { CLASS_BUCKETS } from './class-inference.js';
import { createNameKeyedStore } from './name-keyed-store.js';

const overrides = createNameKeyedStore({
    key: 'playerClassOverrides',
    isValid: (value) => Object.hasOwn(CLASS_BUCKETS, String(value)),
});

/**
 * The bucket key the user set for a player, or null.
 * @param {string} name - Player name
 * @returns {string|null} A key of `CLASS_BUCKETS`
 */
export function classOverrideFor(name) {
    return overrides.get(name);
}

/**
 * The verdict to draw for a player.
 *
 * The inferred verdict unchanged when nothing is set. Otherwise the set bucket,
 * marked `manual`, keeping the inference's evidence and — only when it named
 * the same bucket — its drawing hints (melee sub-style, curse, own weapon), so
 * confirming a correct guess changes nothing about how it is drawn.
 *
 * @param {string} name - Player name
 * @param {Object|null} verdict - From `inferClass`
 * @returns {Object|null} A verdict, with `manual: true` and `inferred` when overridden
 */
export function applyClassOverride(name, verdict) {
    const key = classOverrideFor(name);
    const bucket = key ? CLASS_BUCKETS[key] : null;
    if (!bucket) return verdict || null;

    const same = verdict?.key === key;
    return {
        ...bucket,
        basis: 'set by you',
        evidence: verdict?.evidence || [],
        style: same ? verdict.style || '' : '',
        curse: same ? Boolean(verdict.curse) : false,
        weaponHrid: same ? verdict.weaponHrid || null : null,
        manual: true,
        inferred: verdict || null,
    };
}

/**
 * Set a player's class, or hand them back to the inference with null.
 * @param {string} name - Player name
 * @param {string|null} key - A key of `CLASS_BUCKETS`, or null
 * @returns {Promise<void>}
 */
export function setClassOverride(name, key) {
    return overrides.set(name, key);
}

/** @returns {Promise<void>} The stored overrides, read once */
export function loadClassOverrides() {
    return overrides.load();
}

/** Forget every override in memory — for tests */
export function _resetClassOverrides() {
    overrides.reset();
}
