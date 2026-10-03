/**
 * The Bestiary points target: where it is kept, and how the game is asked for fresh counts.
 *
 * The target is per character. A character's own record (`bestiaryPointsTarget_<id>`)
 * wins; a character without one falls back to the `notifications_bestiaryPointsTargetDefault`
 * setting, which is how the settings screen seeds every character at once. The Bestiary
 * planner writes the record, so a target set there never leaks to another character.
 *
 * Lives in `utils` so the sim bundle (the planner) and the ui bundle (the alert) read and write one
 * key; it holds no module state, which is what lets rollup share it by global.
 */
import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { readScoped, writeScoped } from './character-key.js';

/** Storage key base; the character id is appended by `character-key.js` */
export const TARGET_KEY = 'bestiaryPointsTarget';

/** The master switch of the alert */
export const ALERT_SETTING = 'notifications_bestiaryPointsTarget';

/** Fallback target for characters that have no record of their own */
export const DEFAULT_TARGET_SETTING = 'notifications_bestiaryPointsTargetDefault';

/** Event emitted on the data manager when the stored target changes, so the alert re-reads it */
export const TARGET_CHANGED_EVENT = 'bestiary_target_changed';

/**
 * A usable target, or null.
 * @param {*} value - Anything read from storage or a setting
 * @returns {number|null} A positive whole number of points
 */
function asTarget(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The current character's target: its own record, else the settings default.
 * @returns {Promise<number|null>} Points, or null when none is set
 */
export async function getBestiaryTarget() {
    const own = asTarget(await readScoped(TARGET_KEY, 'settings', null));
    if (own !== null) return own;
    return asTarget(config.getSettingValue?.(DEFAULT_TARGET_SETTING, 0));
}

/**
 * Set the current character's target and turn the alert on.
 *
 * The character is captured before the write and the result discarded if a switch happened first,
 * because the key is scoped to whoever is current when `writeScoped` runs.
 *
 * @param {number} points - Total Bestiary points to be told about
 * @returns {Promise<boolean>} True when the target was stored
 */
export async function setBestiaryTarget(points) {
    const target = asTarget(points);
    if (target === null) return false;
    const who = dataManager.getCurrentCharacterId?.();
    if (!who) return false;
    const ok = await writeScoped(TARGET_KEY, target, 'settings', true);
    if (dataManager.getCurrentCharacterId?.() !== who) return false;
    config.setSetting(ALERT_SETTING, true);
    dataManager.emit?.(TARGET_CHANGED_EVENT, { target });
    return ok !== false;
}

/**
 * Ask the game for the Bestiary (`get_monsters`), as its own tab does on open.
 * A data fetch, not a game action; the answer arrives as `monsters_updated`.
 * Found through the React fiber tree rather than an obfuscated key.
 */
export function requestBestiary() {
    try {
        const rootEl = document.getElementById('root');
        const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
        const find = (fiber, depth = 0) => {
            if (!fiber || depth > 4000) return null;
            if (typeof fiber.stateNode?.handleGetMonsters === 'function') return fiber.stateNode;
            return find(fiber.child, depth + 1) || find(fiber.sibling, depth + 1);
        };
        find(rootFiber)?.handleGetMonsters?.();
    } catch (error) {
        console.error('[BestiaryTarget] Requesting the Bestiary failed:', error);
    }
}
