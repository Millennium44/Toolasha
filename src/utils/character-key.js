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
import { getAdoptionTargetId, requestAdoptionConsent } from './adoption-consent.js';
import { idsFromRecordKeys, recordKeysFor } from './chunked-history.js';

const NETWORTH_SERIES_RE = /^networth_[0-9a-zA-Z]+$/;

/**
 * The networth series after it was split into one record per month.
 *
 * A migrated character has no `networth_<id>` key at all, so the length
 * comparison below would see nothing and let every character adopt — including
 * the alts the policy exists to keep out.
 */
const NETWORTH_RECORD_PREFIX = 'networthSeries';

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
 * How many networth points one character has recorded, either way it is stored.
 *
 * The pre-migration single key wins where it exists: its presence is what says
 * the split has not happened, so any records beside it are a half-finished
 * migration rather than the series.
 *
 * @param {Array<string>} keys - Every key in the networth store
 * @param {string} id - Whose series
 * @returns {Promise<number>} Points recorded
 */
async function networthSeriesLength(keys, id) {
    const legacy = await storage.get(`networth_${id}`, 'networthHistory', null);
    if (Array.isArray(legacy) && legacy.length > 0) return legacy.length;

    let length = 0;
    for (const key of recordKeysFor(keys, NETWORTH_RECORD_PREFIX, id)) {
        const chunk = await storage.get(key, 'networthHistory', null);
        if (Array.isArray(chunk)) length += chunk.length;
    }
    return length;
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
        const name =
            typeof dataManager.getCurrentCharacterName === 'function'
                ? dataManager.getCurrentCharacterName() || ''
                : '';
        if (typeof gameMode === 'string' && gameMode.includes('ironcow')) {
            decision = false;
        } else if (/test/i.test(name)) {
            // A test character is never the main, whatever its history says.
            decision = false;
        } else {
            const keys = await storage.getAllKeys('networthHistory');
            const ids = new Set([
                ...keys
                    .filter((key) => typeof key === 'string' && NETWORTH_SERIES_RE.test(key))
                    .map((key) => key.slice('networth_'.length)),
                ...idsFromRecordKeys(keys, `${NETWORTH_RECORD_PREFIX}_`),
            ]);

            if (ids.size > 0 && !ids.has(charId)) {
                // Someone on this account has recorded history and this
                // character has none — it is not the main. Skipping the
                // comparison here is what once let a fresh alt adopt
                // everything just by logging in first.
                decision = false;
            } else if (ids.size > 1) {
                let bestId = null;
                let bestLength = -1;
                for (const id of ids) {
                    const length = await networthSeriesLength(keys, id);
                    if (length > bestLength) {
                        bestLength = length;
                        bestId = id;
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
    const scopedKey = characterKey(base);
    const scoped = await storage.get(scopedKey, storeName, null);
    if (scoped !== null) {
        return scoped;
    }

    const legacy = await storage.get(base, storeName, null);
    // Answered here, not in migrateLegacy: calling into another async function
    // costs a microtask hop, and the absent-legacy case is the overwhelmingly
    // common one — load machinery interleaves against it (a prediction-
    // calibration test caught the extra tick as a reordering).
    if (legacy === null) return defaultValue;
    return migrateLegacy(base, scopedKey, legacy, storeName, defaultValue, options);
}

/**
 * `readScoped` over values a caller already read in one batched transaction.
 *
 * A feature that pulls several of its records at startup with
 * {@link module:core/storage.getMany} would lose that single-transaction read
 * by switching to one `readScoped` await per key. Pass the resulting map here
 * instead: the scoped-then-legacy resolution and the one-time adoption are the
 * same as `readScoped`'s, only the two reads come from the batch. The batch
 * must contain both `characterKey(base)` and `base` — a key that is missing
 * from it reads as absent, exactly as `getMany` reports an absent record.
 *
 * @param {string} base - The unscoped key
 * @param {Map<string, *>} values - Batched reads, as returned by `storage.getMany`
 * @param {string} [storeName] - Object store the batch came from (default: 'settings')
 * @param {*} [defaultValue] - Value returned when neither key was present
 * @param {{migrate?: 'adopt'|'discard'}} [options] - Legacy migration mode (default: 'adopt')
 * @returns {Promise<*>} The stored value or default
 */
export async function readScopedFrom(base, values, storeName = 'settings', defaultValue = null, options = {}) {
    const scopedKey = characterKey(base);
    const scoped = values.get(scopedKey) ?? null;
    if (scoped !== null) {
        return scoped;
    }

    const legacy = values.get(base) ?? null;
    if (legacy === null) return defaultValue;
    return migrateLegacy(base, scopedKey, legacy, storeName, defaultValue, options);
}

/**
 * The legacy half of a scoped read: adopt, discard, or leave the bare value.
 *
 * Shared by {@link readScoped} and {@link readScopedFrom} so the two cannot
 * drift — whichever way the values were read, a bare key is claimed only by
 * the character the user confirmed, and is deleted when it is.
 *
 * @param {string} base - The unscoped key
 * @param {string} scopedKey - `characterKey(base)`, already computed
 * @param {*} legacy - The bare key's value, or null when absent
 * @param {string} storeName - Object store name
 * @param {*} defaultValue - Value returned when the legacy value is not claimed
 * @param {{migrate?: 'adopt'|'discard'}} options - Legacy migration mode
 * @returns {Promise<*>} The adopted value or the default
 */
async function migrateLegacy(base, scopedKey, legacy, storeName, defaultValue, options) {
    const { migrate = 'adopt' } = options;

    if (legacy === null) {
        return defaultValue;
    }

    if (migrate === 'discard') {
        await storage.delete(base, storeName);
        return defaultValue;
    }

    const charId = dataManager.getCurrentCharacterId();
    if (!charId) {
        return defaultValue;
    }

    // Adoption is user-confirmed, never automatic. The heuristics only pick
    // which character the dialog preselects.
    const targetId = await getAdoptionTargetId();
    if (targetId === null) {
        // Fire-and-forget: awaiting a modal here would hang feature init.
        isAdoptionCandidate(charId).then(
            (candidate) => requestAdoptionConsent({ recommendedId: candidate ? charId : null }),
            () => requestAdoptionConsent({})
        );
        return defaultValue;
    }
    if (targetId !== charId) {
        // Leave the legacy value in place for the chosen character to claim.
        return defaultValue;
    }

    // `scopedKey` was built by the caller before `getAdoptionTargetId()`'s
    // await; `charId` is read after it. A character switch in between makes
    // those two different characters, and the adoption would then move the
    // legacy value under the departing character's key while handing it to the
    // arriving one — the legacy copy deleted, and neither character holding it
    // where they will look. Leave it for the next read to claim cleanly.
    if (scopedKey !== characterKey(base)) {
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
