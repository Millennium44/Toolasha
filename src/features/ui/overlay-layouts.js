/**
 * Named overlay layouts
 *
 * An overlay arrangement is worth an hour of fiddling, and there is more than
 * one of them worth having: the tiles you want while grinding a dungeon are not
 * the tiles you want while running the marketplace, and the only way to keep
 * both was to export one to a file and import it back an hour later.
 *
 * So layouts get names. Saving one writes the arrangement exactly as
 * `_exportLayout` writes a file — through `toOPanelConfig` — and switching reads
 * it back through `fromOPanelConfig`, which is the same code path an import
 * already takes. That is deliberate: a second way of applying a layout is a
 * second set of bugs about tiles arriving unplaced, and the import path has
 * already learned the awkward parts (native coordinates left alone, OPanel's
 * refitted).
 *
 * Everything lives under one key holding a map of name to saved file, rather
 * than a key per layout. A map is one read, one write and one place to look
 * when a name goes missing; a key per layout means a listing has to enumerate
 * the whole store and guess which keys are layouts by their prefix.
 *
 * The map operations are pure and exported separately from the storage calls,
 * because renaming, overwriting and deleting are where the mistakes live and
 * none of them need IndexedDB to be tested.
 *
 * ## Presets
 *
 * Four arrangements ship with the script, because the first thing a named
 * layout asks of you is that you already have one — and the answer to "what
 * would a combat layout even contain" is the same for everybody the first ten
 * times it is asked. They sit in the same dropdown as your own, marked, and
 * they apply through exactly the same path. They cannot be deleted or written
 * over; saving your own under a preset's name simply shadows it, which is the
 * behaviour you want from a preset you have outgrown.
 *
 * ## Which layout an activity wants
 *
 * The last part is the one that makes the rest worth having: switching by hand
 * every time you stop fighting and start milking is switching you will do twice
 * and then stop doing. {@link decideAutoSwitch} is the whole of that decision,
 * kept pure and here rather than in the panel — it is four rules about *when*
 * not to act (too soon, unlocked, already there, told not to), and every one of
 * them is a rule you can only test by lying about the clock.
 */

import storage from '../../core/storage.js';
import { toOPanelConfig } from '../../utils/opanel-config.js';

/** The one key the whole map lives under */
export const LAYOUTS_KEY = 'overlayLayouts';

/** Which object store — the same one the overlay's own settings use */
const STORE = 'settings';

/** Long enough to be descriptive, short enough to fit the dropdown */
export const MAX_NAME_LENGTH = 40;

/**
 * A name as it will be stored.
 *
 * Trimmed and capped rather than rejected on length, so a pasted name is
 * shortened instead of losing the whole save. Whitespace-only is not a name.
 *
 * @param {string} name - What the player typed
 * @returns {string} The stored form, or '' when there is nothing usable
 */
export function normalizeName(name) {
    if (typeof name !== 'string') return '';
    return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

/**
 * The saved names, in the order they should be offered.
 *
 * Sorted rather than kept in insertion order: a dropdown you scan for a name
 * you already know is easier alphabetical, and insertion order is invisible
 * from the outside anyway.
 *
 * @param {Object} map - The stored map
 * @returns {string[]} Names
 */
export function layoutNames(map) {
    if (!map || typeof map !== 'object') return [];
    return Object.keys(map).sort((a, b) => a.localeCompare(b));
}

/**
 * The map with one layout added or replaced.
 *
 * Returns a new object rather than mutating, so a caller holding the old map
 * still holds the old map — which is what makes "save failed, nothing changed"
 * true rather than merely intended.
 *
 * @param {Object} map - The stored map
 * @param {string} name - Layout name; normalized here
 * @param {Object} file - What `toOPanelConfig` produced
 * @returns {Object} A new map, unchanged when the name is unusable
 */
export function putLayout(map, name, file) {
    const key = normalizeName(name);
    if (!key || !file) return { ...(map || {}) };
    return { ...(map || {}), [key]: { savedAt: Date.now(), file } };
}

/**
 * The map with one layout gone.
 *
 * @param {Object} map - The stored map
 * @param {string} name - Layout name
 * @returns {Object} A new map, unchanged when the name is not in it
 */
export function removeLayout(map, name) {
    const key = normalizeName(name);
    const next = { ...(map || {}) };
    delete next[key];
    return next;
}

/**
 * Every saved layout.
 *
 * An unreadable or absent map reads as no layouts rather than as an error: the
 * overlay still has to draw its settings popover, and a control that throws
 * takes the popover with it.
 *
 * @returns {Promise<Object>} `{ [name]: {savedAt, file} }`
 */
export async function loadLayouts() {
    try {
        const map = await storage.getJSON(LAYOUTS_KEY, STORE, null);
        return map && typeof map === 'object' ? map : {};
    } catch (error) {
        console.error('[OverlayLayouts] Reading the saved layouts failed:', error);
        return {};
    }
}

/**
 * Write the whole map back.
 *
 * @param {Object} map - The map to store
 * @returns {Promise<boolean>} Whether it was written
 */
async function writeLayouts(map) {
    try {
        await storage.setJSON(LAYOUTS_KEY, map, STORE, true);
        return true;
    } catch (error) {
        console.error('[OverlayLayouts] Saving the layouts failed:', error);
        return false;
    }
}

/**
 * Save an arrangement under a name, replacing one of the same name.
 *
 * @param {string} name - Layout name
 * @param {Object} file - What `toOPanelConfig` produced
 * @returns {Promise<Object>} The map as it now stands
 */
export async function saveLayout(name, file) {
    const current = await loadLayouts();
    const next = putLayout(current, name, file);
    // The map that is actually stored, so a failed write leaves the dropdown
    // showing what exists rather than a name that only ever lived in memory
    return (await writeLayouts(next)) ? next : current;
}

/**
 * Forget a saved layout.
 *
 * @param {string} name - Layout name
 * @returns {Promise<Object>} The map as it now stands
 */
export async function deleteLayout(name) {
    const current = await loadLayouts();
    const next = removeLayout(current, name);
    return (await writeLayouts(next)) ? next : current;
}

/**
 * One saved layout's file, ready for `fromOPanelConfig`.
 *
 * Your own first, then the presets — which is what makes "Save As under a
 * preset's name" shadow it rather than fail.
 *
 * @param {string} name - Layout name
 * @returns {Promise<Object|null>} The saved file, or null when there is no such layout
 */
export async function getLayout(name) {
    const map = await loadLayouts();
    return map[normalizeName(name)]?.file || presetFile(name);
}

// ─── Presets ────────────────────────────────────────────────────────────────

/**
 * How a preset is marked in the dropdown.
 *
 * A suffix rather than a separate group or an icon: the dropdown is one line
 * tall in a popover that is already crowded, `optgroup` is styled by the browser
 * and looks nothing like the rest of this panel, and the one thing a reader
 * needs is to know that Delete will not offer this name.
 */
export const PRESET_SUFFIX = ' · preset';

/**
 * The activities a layout can be asked to serve.
 *
 * Three of them come from what the character is doing and the fourth from what
 * is on screen — see the panel's activity reader. `NONE` is what a layout with
 * no opinion is mapped to, and is not an activity anything is ever detected as.
 */
export const ACTIVITY = {
    COMBAT: 'combat',
    SKILLING: 'skilling',
    LABYRINTH: 'labyrinth',
    MARKET: 'market',
    NONE: 'none',
};

/**
 * The arrangements that ship with the script.
 *
 * Each is a list of row keys, in the order they should be packed — which is
 * also the order they are read in, left to right and wrapping, so the figure
 * that decides something comes first. No positions and no sizes: a preset that
 * carried coordinates would be a preset measured against one panel width, and
 * every tile in it would arrive clamped or overlapping on a narrower one. Left
 * unplaced, `resolveLayout` packs them against the panel the player actually
 * has.
 *
 * `activity` is what the preset answers for when auto-switching is on. A player
 * who maps one of their own layouts to the same activity takes precedence — the
 * preset is the fallback, not the rule.
 */
export const PRESET_LAYOUTS = {
    Combat: {
        activity: ACTIVITY.COMBAT,
        rows: [
            'combatStatus',
            'battleTimer',
            'dps',
            'combatRevenue',
            'deathsPerHour',
            'manaPerFight',
            'luck',
            'overExpected',
            'combatSession',
            'consumables',
            'treasure',
        ],
    },
    Skilling: {
        activity: ACTIVITY.SKILLING,
        rows: ['experiencePerHour', 'timeToLevel', 'queueTimeLeft', 'totalProfit', 'consumables', 'coins', 'houses'],
    },
    Labyrinth: {
        activity: ACTIVITY.LABYRINTH,
        // The combat half, plus the three tiles a run is actually decided by:
        // what it is dropping, whether the sim agrees with what happened, and
        // whether you are about to run out of food
        rows: [
            'combatStatus',
            'dps',
            'deathsPerHour',
            'manaPerFight',
            'consumables',
            'combatRevenue',
            'treasure',
            'replayCheck',
            'combatSession',
        ],
    },
    Market: {
        activity: ACTIVITY.MARKET,
        rows: ['netWorth', 'coins', 'marketListings', 'inventoryValue', 'watchlist', 'equipmentWatch', 'skillBooks'],
    },
};

/**
 * The preset names, in the order they should be offered.
 * @returns {string[]} Names
 */
export function presetNames() {
    return Object.keys(PRESET_LAYOUTS);
}

/**
 * Is this the name of a preset?
 * @param {string} name - A layout name
 * @returns {boolean}
 */
export function isPreset(name) {
    return Object.prototype.hasOwnProperty.call(PRESET_LAYOUTS, normalizeName(name));
}

/**
 * A preset as a layout file, in exactly the shape a saved one has.
 *
 * Built through `toOPanelConfig` rather than hand-written, so a preset takes
 * the same road home as a layout you saved yourself: the same writer, the same
 * reader, the same application. A preset that arrived by a shortcut would be a
 * preset that behaves differently from everything around it in some way nobody
 * predicted.
 *
 * Everything not in `rows` is switched *off* rather than left alone. A preset
 * that only added tiles would leave whatever was up before sitting among them,
 * which is not a layout — it is the union of two.
 *
 * @param {string} name - Preset name
 * @returns {Object|null} A file for `fromOPanelConfig`, or null when there is no such preset
 */
export function presetFile(name) {
    const preset = PRESET_LAYOUTS[normalizeName(name)];
    if (!preset) return null;

    return toOPanelConfig({
        order: [...preset.rows],
        visible: Object.fromEntries(preset.rows.map((key) => [key, true])),
        positions: {},
        sizes: {},
        zoom: {},
        snapToGrid: true,
        // Applied locked. A preset is somebody else's arrangement arriving
        // under your cursor, and arriving unlocked means the first click that
        // lands on it drags a tile.
        locked: true,
        separators: true,
        textScale: 100,
    });
}

/**
 * Every name the dropdown should offer, and what kind each one is.
 *
 * A preset whose name has been taken by a saved layout is dropped rather than
 * listed twice: the saved one shadows it, and two identical names in a dropdown
 * is a dropdown that cannot be used.
 *
 * @param {Object} map - The stored map
 * @returns {Array<{name: string, preset: boolean, label: string}>} Names in offering order
 */
export function offeredLayouts(map) {
    const saved = layoutNames(map);
    const shadowed = new Set(saved);

    return [
        ...saved.map((name) => ({ name, preset: false, label: name })),
        ...presetNames()
            .filter((name) => !shadowed.has(name))
            .map((name) => ({ name, preset: true, label: `${name}${PRESET_SUFFIX}` })),
    ];
}

// ─── Auto-switching ─────────────────────────────────────────────────────────

/**
 * How long an activity has to hold before the layout follows it.
 *
 * Ten seconds, because the transitions are the problem rather than the
 * activities. A queue that runs out between two combat batches is a second of
 * "skilling" — actually of nothing — and a layout that redrew itself for it and
 * back again has cost you the tile you were reading twice. Nothing is lost by
 * waiting: an activity that lasts less than ten seconds is not one you were
 * going to read an overlay during.
 */
export const SWITCH_STABILITY_MS = 10_000;

/**
 * The state {@link decideAutoSwitch} carries between calls.
 * @returns {Object} A fresh state
 */
export function freshSwitchState() {
    return {
        /** What was last seen, and since when */
        seen: null,
        seenSince: 0,
        /** The activity the layout on screen was chosen for */
        applied: null,
        /**
         * Whether a hand-picked layout is holding auto-switching off, and what
         * was happening when it was picked. Two fields rather than one, because
         * "paused while nothing identifiable was going on" is a real state and
         * a null `pausedAt` cannot say it.
         */
        paused: false,
        pausedAt: null,
    };
}

/**
 * Which layout an activity should bring up.
 *
 * A layout the player mapped to the activity wins over the preset for it, which
 * is the whole point of the mapping — the preset is what "combat" means until
 * you have said what it means to you. Mappings naming a layout that has since
 * been deleted are ignored rather than applied as a missing name.
 *
 * @param {string} activity - One of {@link ACTIVITY}
 * @param {Object} mappings - `{ [layoutName]: activity }`, from the panel's settings
 * @param {string[]} [saved] - Names that actually exist
 * @returns {string|null} A layout name, or null when nothing serves this activity
 */
export function layoutForActivity(activity, mappings, saved = []) {
    if (!activity || activity === ACTIVITY.NONE) return null;

    const exists = new Set(saved);
    for (const [name, mapped] of Object.entries(mappings || {})) {
        if (mapped !== activity) continue;
        if (exists.has(name) || isPreset(name)) return name;
    }

    const preset = presetNames().find((name) => PRESET_LAYOUTS[name].activity === activity);
    return preset || null;
}

/**
 * Whether to switch layout, given what is going on.
 *
 * Four reasons not to, and they are the whole function:
 *
 * - **Too soon.** The activity has not held for {@link SWITCH_STABILITY_MS}.
 * - **Unlocked.** Tiles are being arranged, and replacing the layout underneath
 *   somebody who is dragging one is the worst thing this feature could do.
 * - **Already there.** The layout on screen was chosen for this activity.
 * - **Told not to.** A layout was applied by hand, and the activity has not
 *   changed since. Picking a layout is an instruction, and a feature that
 *   overrode it four seconds later would be a feature nobody leaves on. It
 *   resumes at the next *change* of activity rather than after a timeout,
 *   because that is the moment your choice stopped being about what you are
 *   doing now.
 *
 * Pure, and returns the next state rather than mutating: the caller runs this
 * on a one-second tick, and a decision function that keeps its own clock is one
 * that cannot be tested without waiting for it.
 *
 * @param {Object} input - Inputs
 * @param {Object} input.state - The last state, from {@link freshSwitchState}
 * @param {string|null} input.activity - What is happening now, or null when unknown
 * @param {number} input.now - Clock, in ms
 * @param {boolean} [input.enabled] - Whether auto-switching is on
 * @param {boolean} [input.locked] - Whether the layout is locked
 * @param {Object} [input.mappings] - `{ [layoutName]: activity }`
 * @param {string[]} [input.saved] - Saved layout names
 * @param {number} [input.stabilityMs] - How long an activity must hold
 * @returns {{state: Object, apply: string|null, activity: string|null}} The next state, and
 *   the layout to apply if any
 */
export function decideAutoSwitch({
    state,
    activity,
    now,
    enabled = true,
    locked = true,
    mappings = {},
    saved = [],
    stabilityMs = SWITCH_STABILITY_MS,
}) {
    const current = state || freshSwitchState();

    // A new reading restarts the clock, whether or not anything else is true —
    // the timer is about the world, not about whether we are allowed to act on
    // it, and pausing it while unlocked would make the first switch after a
    // relock take another ten seconds
    const seen = current.seen === activity ? current : { ...current, seen: activity, seenSince: now };

    // An activity that has actually changed is what releases a manual pause,
    // even when the new activity is one nothing is mapped to
    const changedSincePause = seen.paused && activity !== seen.pausedAt;
    const released = changedSincePause ? { ...seen, paused: false, pausedAt: null } : seen;

    if (!enabled || !locked || !activity) return { state: released, apply: null, activity };
    if (released.paused) return { state: released, apply: null, activity };
    if (now - released.seenSince < stabilityMs) return { state: released, apply: null, activity };
    if (released.applied === activity) return { state: released, apply: null, activity };

    const name = layoutForActivity(activity, mappings, saved);
    if (!name) return { state: released, apply: null, activity };

    return { state: { ...released, applied: activity }, apply: name, activity };
}

/**
 * Record that a layout was chosen by hand.
 *
 * @param {Object} state - The switch state
 * @param {string|null} activity - What is happening as the choice is made
 * @returns {Object} The next state
 */
export function pauseForManualChoice(state, activity) {
    const current = state || freshSwitchState();
    // `applied` is cleared as well: the layout on screen is no longer the one
    // auto-switching put there, so when the pause lifts the activity it was
    // paused during is one it may legitimately switch to again
    return { ...current, paused: true, pausedAt: activity ?? null, applied: null };
}
