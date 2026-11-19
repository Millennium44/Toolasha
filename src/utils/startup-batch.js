/**
 * One storage transaction for the preferences a panel restores when it is built.
 *
 * A panel that restores a dozen remembered options used to start a dozen reads (a scoped option is
 * two: its character's key, then the legacy bare key), and at startup each read queued behind every
 * other feature's. A reader made here asks for all of them at once on one readonly transaction, and
 * the restore functions take it in place of `storage.get` / `readScoped` / `readScopedChecked`.
 *
 * The rules a single read keeps are kept here:
 * - an absent key, a stored null and an unreadable store give the same default `storage.get` gave;
 * - the checked read keeps `ok: false` for a record that could not be read (`tryGetMany` is all or
 *   nothing, and any failure re-reads through `readScopedChecked`, which says exactly which);
 * - a scoped value is served only to the character the batch was made for. If the character has
 *   changed since, the read goes to storage for the current one, so one character's key is never
 *   answered with another's value;
 * - a key the batch did not ask for goes to storage as it always did.
 *
 * A reader is for one build of one panel, used right after it is made: it is a snapshot.
 * @module utils/startup-batch
 */
import dataManager from '../core/data-manager.js';
import storage from '../core/storage.js';
import { characterKey, readScoped, readScopedChecked, readScopedCheckedFrom, readScopedFrom } from './character-key.js';

/**
 * The reads a restore function does when it is given no reader: straight to storage, one key at a time.
 * @type {{get: Function, scoped: Function, checked: Function}}
 */
export const DIRECT_READS = {
    get: (key, storeName = 'settings', defaultValue = null) => storage.get(key, storeName, defaultValue),
    // Spread, so the sync-ownership scan (which follows keys forwarded by name) does not take this
    // module for a writer-wrapper: the keys are named at the callers
    scoped: (...args) => readScoped(...args),
    checked: (...args) => readScopedChecked(...args),
};

/**
 * Start the batched reads and return a reader over them.
 * @param {object} spec
 * @param {Array<string>} [spec.plain] - Keys read with `get` (not character scoped)
 * @param {Array<string>} [spec.scoped] - Bases read with `readScoped` (scoped key and legacy bare key)
 * @param {Array<string>} [spec.checked] - Bases read with `readScopedChecked` (`tryGet` semantics)
 * @param {string} [spec.store] - The one store all of them live in (default: 'settings')
 * @returns {{get: Function, scoped: Function, checked: Function}} Same shapes as {@link DIRECT_READS}
 */
export function createStartupReader({ plain = [], scoped = [], checked = [], store = 'settings' }) {
    // Keys and owner fixed in one synchronous step: the batch answers for exactly this character
    const owner = dataManager.getCurrentCharacterId?.() ?? null;
    const batchKeys = [...plain, ...scoped.flatMap((base) => [characterKey(base), base])];
    const checkedKeys = checked.flatMap((base) => [characterKey(base), base]);
    const sameCharacter = () => (dataManager.getCurrentCharacterId?.() ?? null) === owner;

    const values = batchKeys.length > 0 ? storage.getMany(batchKeys, store).catch(() => null) : Promise.resolve(null);
    const reads =
        checkedKeys.length > 0 ? storage.tryGetMany(checkedKeys, store).catch(() => null) : Promise.resolve(null);

    return {
        async get(key, storeName = 'settings', defaultValue = null) {
            const map = await values;
            if (!map || storeName !== store || !plain.includes(key) || !map.has(key)) {
                return DIRECT_READS.get(key, storeName, defaultValue);
            }
            const value = map.get(key);
            return value != null ? value : defaultValue;
        },
        async scoped(base, storeName = 'settings', defaultValue = null, options = {}) {
            const map = await values;
            if (!map || storeName !== store || !scoped.includes(base) || !sameCharacter()) {
                return DIRECT_READS.scoped(base, storeName, defaultValue, options);
            }
            return readScopedFrom(base, map, storeName, defaultValue, options);
        },
        async checked(base, storeName = 'settings', options = {}) {
            const map = await reads;
            if (!map || storeName !== store || !checked.includes(base) || !sameCharacter()) {
                return DIRECT_READS.checked(base, storeName, options);
            }
            return readScopedCheckedFrom(base, map, storeName, options);
        },
    };
}
