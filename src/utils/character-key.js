/**
 * Per-character storage key helpers.
 *
 * Character-specific state stored under a bare key leaks between characters —
 * the market cow's watchlist shows up on the iron cow. Every feature that
 * persists per-character state should build its key through {@link characterKey}
 * and read through {@link readScoped}, which also handles one-time adoption of
 * the legacy global value.
 *
 * Adoption policy: a legacy global value almost always belongs to the account's
 * main character. It is adopted (moved to the scoped key, legacy deleted) only
 * by an adoption candidate — a non-ironcow character which, when several
 * characters have networth history, owns the longest series. Other characters
 * simply start clean and leave the legacy value in place for the main to claim.
 */
import dataManager from '../core/data-manager.js';
import storage from '../core/storage.js';

const NETWORTH_SERIES_RE = /^networth_[0-9a-zA-Z]+$/;

/** Per-character memo of the adoption decision, reset only on reload. */
const adoptionDecisions = new Map();

/**
 * A storage key scoped to the character now logged in.
 *
 * Uses the codebase's dominant `${base}_${charId}` idiom with a `'default'`
 * fallback before login, so account-view suffix parsing keeps working.
 * @param {string} base - The unscoped key
 * @returns {string} `base_<characterId>`, or `base_default` before login
 */
export function characterKey(base) {
    return `${base}_${dataManager.getCurrentCharacterId() || 'default'}`;
}

/**
 * Whether the given character should inherit legacy (pre-scoping) global data.
 *
 * Iron cow characters never adopt — the legacy value was almost certainly
 * written by the market character. When several characters have networth
 * history, only the one with the longest series adopts. On any failure the
 * check errs toward adopting, so a solo-character install migrates cleanly.
 * @param {string} charId - The character considering adoption
 * @returns {Promise<boolean>} True when this character may claim legacy data
 */
async function isAdoptionCandidate(charId) {
    if (adoptionDecisions.has(charId)) {
        return adoptionDecisions.get(charId);
    }

    let decision = true;
    try {
        // Same signal MCS reads: character.gameMode. 'standard' is the market
        // character; 'ironcow' and 'legacy_ironcow' never adopt.
        const gameMode = dataManager.getCurrentCharacterGameMode();
        if (typeof gameMode === 'string' && gameMode.includes('ironcow')) {
            decision = false;
        } else {
            const keys = await storage.getAllKeys('networthHistory');
            const seriesKeys = keys.filter((key) => typeof key === 'string' && NETWORTH_SERIES_RE.test(key));
            if (seriesKeys.length > 1) {
                let bestId = null;
                let bestLength = -1;
                for (const key of seriesKeys) {
                    const series = await storage.get(key, 'networthHistory', null);
                    const length = Array.isArray(series) ? series.length : 0;
                    if (length > bestLength) {
                        bestLength = length;
                        bestId = key.slice('networth_'.length);
                    }
                }
                decision = bestId === null || bestId === charId;
            }
        }
    } catch (error) {
        console.error('[CharacterKey] Adoption check failed, adopting by default:', error);
        decision = true;
    }

    adoptionDecisions.set(charId, decision);
    return decision;
}

/**
 * Read a per-character key, migrating any legacy global value exactly once.
 *
 * Looks up `characterKey(base)` first. When absent and the legacy bare `base`
 * key exists, either adopts it (moves it to this character's key and deletes
 * the legacy copy — main character only, see module doc) or discards it
 * (deletes the legacy copy and starts clean), per `options.migrate`.
 *
 * Discard is for state derived from one character's gear or sim results, where
 * inheriting another character's data is worse than starting empty.
 * @param {string} base - The unscoped key
 * @param {string} [storeName] - Object store name (default: 'settings')
 * @param {*} [defaultValue] - Value returned when neither key exists
 * @param {{migrate?: 'adopt'|'discard'}} [options] - Legacy migration mode (default: 'adopt')
 * @returns {Promise<*>} The stored value or default
 */
export async function readScoped(base, storeName = 'settings', defaultValue = null, options = {}) {
    const { migrate = 'adopt' } = options;

    const scopedKey = characterKey(base);
    const scoped = await storage.get(scopedKey, storeName, null);
    if (scoped !== null) {
        return scoped;
    }

    const legacy = await storage.get(base, storeName, null);
    if (legacy === null) {
        return defaultValue;
    }

    if (migrate === 'discard') {
        await storage.delete(base, storeName);
        return defaultValue;
    }

    const charId = dataManager.getCurrentCharacterId();
    if (!charId || !(await isAdoptionCandidate(charId))) {
        // Leave the legacy value in place for the main character to claim.
        return defaultValue;
    }

    await storage.set(scopedKey, legacy, storeName, true);
    await storage.delete(base, storeName);
    return legacy;
}

/**
 * Write a value under this character's scoped key.
 * @param {string} base - The unscoped key
 * @param {*} value - Value to store
 * @param {string} [storeName] - Object store name (default: 'settings')
 * @param {boolean} [immediate] - Skip write debouncing
 * @returns {Promise<boolean>} Success status
 */
export async function writeScoped(base, value, storeName = 'settings', immediate = false) {
    return storage.set(characterKey(base), value, storeName, immediate);
}

/**
 * Test-only: forget memoized adoption decisions.
 */
export function _resetAdoptionCache() {
    adoptionDecisions.clear();
}
