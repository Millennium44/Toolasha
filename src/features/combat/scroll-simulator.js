/**
 * Scroll Simulator
 * Manages per-loadout and global default scroll selections for profit/XP simulation.
 *
 * Storage: scroll_simulation_${charId} in 'settings' store.
 * Structure: { '__default__': [buffTypeHrid, ...], 'Loadout Name': [...], ... }
 *
 * Priority when resolving scrolls for an action type:
 *   1. Loadout-specific selection (if a snapshot is active for the skill)
 *   2. Global default ('__default__')
 *   3. Empty set (if toggle is off or nothing configured)
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import loadoutSnapshot from './loadout-snapshot.js';

const STORAGE_KEY_PREFIX = 'scroll_simulation';
export const DEFAULT_KEY = '__default__';

/** Whoever is logged in, or `'default'` before login */
function currentCharId() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * One character's key, built from an id the caller captured.
 *
 * Not resolved at each use: the read and the write of a selection have to name
 * the same character, and `character_switched` is a deferred macrotask, so the
 * switch can land between them.
 * @param {string} charId - Whose selections
 * @returns {string} The storage key
 */
function storageKeyFor(charId) {
    return `${STORAGE_KEY_PREFIX}_${charId}`;
}

/** How many times one `initialize()` may re-read after finding the character moved under it */
const INIT_ATTEMPTS = 3;

class ScrollSimulator {
    constructor() {
        /** @type {Object.<string, Set<string>>} loadoutName → Set of buffTypeHrids */
        this.scrollsByLoadout = {};
        this.initialized = false;
        this.switchHandler = null;
        /**
         * Whose selections are in memory, or null when none are. `_persist()`
         * refuses to write anything else's — the key is resolved at write time,
         * so a map still holding the departing character's loadouts would
         * otherwise be stored as the arriving character's configuration.
         */
        this.owner = null;
        /**
         * Bumped by the switch handler. `character_switched` is deferred, so it
         * is not serialised against a load already running; a load that finds
         * the number moved drops what it read rather than folding it in.
         */
        this._generation = 0;
    }

    async initialize() {
        if (this.initialized) return;
        // Registered before the read, not after it. The boot call is the only
        // one anybody makes, so a read the guard below refused used to return
        // without ever reaching this: no switch handler, `owner` left null and
        // `initialized` left false for the rest of the session, which is every
        // scroll selection silently unsaved and no scrolls simulated at all.
        this._registerSwitchHandler();

        // Bounded rather than a single pass: a read that no longer speaks for
        // the character it was made for has to be made again, and only a switch
        // the handler above actually saw has somebody else to make it.
        for (let attempt = 0; attempt < INIT_ATTEMPTS && !this.initialized; attempt += 1) {
            // Captured before the read: the hydration below used to assign into
            // whatever `scrollsByLoadout` held when it landed, so a load still in
            // flight across a switch added the departing character's loadout
            // selections on top of the arriving character's — simulating scroll
            // buffs they have not bought, in every profit and XP figure on screen,
            // and storing the union under their key on the next save.
            const charId = currentCharId();
            const started = this._generation;
            const saved = await storage.getJSON(storageKeyFor(charId), 'settings', {});
            // The switch handler is reloading for the arriving character already
            if (this._generation !== started) return;
            // The id moved with no switch event behind it, so nothing else will
            if (currentCharId() !== charId) continue;

            // A selection saved while the read was in flight is this character's
            // own and wins over the stored copy, as everywhere else in the codebase
            const held = this.owner === charId ? this.scrollsByLoadout : {};
            const next = { ...held };
            for (const [name, arr] of Object.entries(saved)) {
                if (Array.isArray(arr) && !(name in held)) {
                    next[name] = new Set(arr);
                }
            }
            this.scrollsByLoadout = next;
            this.owner = charId;
            this.initialized = true;
        }
    }

    /**
     * Listen for the switch that makes the selections in memory somebody else's.
     * Idempotent; the listener outlives every reload it triggers.
     * @private
     */
    _registerSwitchHandler() {
        if (this.switchHandler) return;
        this.switchHandler = async () => {
            this._generation += 1;
            this.scrollsByLoadout = {};
            this.owner = null;
            this.initialized = false;
            await this.initialize();
        };
        dataManager.on('character_switched', this.switchHandler);
    }

    /**
     * Returns the Set of buffTypeHrids to simulate for the given action type.
     * Respects the master toggle and loadout priority.
     * @param {string} actionTypeHrid
     * @returns {Set<string>}
     */
    getScrollSetForActionType(actionTypeHrid) {
        if (!config.getSetting('simulateScrollEffects')) return new Set();
        const loadoutName = loadoutSnapshot.getSnapshotInfoForSkill(actionTypeHrid)?.name;
        if (loadoutName && this.scrollsByLoadout[loadoutName]) {
            return this.scrollsByLoadout[loadoutName];
        }
        return this.scrollsByLoadout[DEFAULT_KEY] ?? new Set();
    }

    /**
     * Returns the Set of buffTypeHrids configured for a specific loadout (or the default).
     * @param {string|null} loadoutName - null for global defaults
     * @returns {Set<string>}
     */
    getScrollsForLoadout(loadoutName) {
        return this.scrollsByLoadout[loadoutName ?? DEFAULT_KEY] ?? new Set();
    }

    /**
     * Save scroll selections for a loadout (or global defaults).
     * @param {string|null} loadoutName - null for global defaults
     * @param {string[]} buffTypeHrids
     */
    async saveScrollsForLoadout(loadoutName, buffTypeHrids) {
        const charId = currentCharId();
        if (this.owner !== charId) {
            console.warn(
                `[ScrollSimulator] Not saving scroll selections: they belong to ${this.owner ?? 'no character yet'}, ` +
                    `not to ${charId}`
            );
            return;
        }
        const key = loadoutName ?? DEFAULT_KEY;
        this.scrollsByLoadout[key] = new Set(buffTypeHrids);
        await this._persist(charId);
    }

    /**
     * Write the whole map under one character's key.
     * @param {string} charId - Whose selections these are, already verified
     * @private
     */
    async _persist(charId) {
        const toSave = {};
        for (const [name, set] of Object.entries(this.scrollsByLoadout)) {
            toSave[name] = [...set];
        }
        await storage.setJSON(storageKeyFor(charId), toSave, 'settings');
    }
}

const scrollSimulator = new ScrollSimulator();
export default scrollSimulator;
