/**
 * Briefing snapshot store
 *
 * Where a character's briefing facts live, and what a reader is allowed to
 * expect in them.
 *
 * Split from `briefing-snapshot.js` because the two halves have wildly
 * different appetites. Writing a snapshot means reaching into the enhancement
 * tracker, the consumable forecast and the guild roster; reading one means a
 * key prefix and `storage.get`. The account panel is a reader, and importing
 * the writer for a prefix would drag every one of those features into the
 * account view's import graph — which is how a panel that shows five numbers
 * ends up loading the combat stats collector.
 */

import storage from '../../core/storage.js';

/** Where a per-character snapshot lives, in the `settings` store */
export const SNAPSHOT_PREFIX = 'briefingSnapshot_';

/** The store it lives in — the same one the listing baseline uses */
export const SNAPSHOT_STORE = 'settings';

/**
 * The facts a snapshot may carry, and therefore the ones the panel may show.
 *
 * The list is the contract between the writer and the reader: the writer
 * gathers nothing outside it, and the reader narrows the *live* facts to it too
 * so that every character on the account is answering the same questions.
 * `briefing-snapshot.js` says why each of the engine's other subjects is not
 * here.
 */
export const SNAPSHOT_FACT_KEYS = [
    'tasksReady',
    'taskSlots',
    'consumable',
    'listings',
    'enhancement',
    'guild',
    'labyrinth',
];

/**
 * Where one character's snapshot lives.
 * @param {string} characterId - Whose
 * @returns {string} Storage key
 */
export function snapshotKey(characterId) {
    return `${SNAPSHOT_PREFIX}${characterId}`;
}

/**
 * The snapshots among a batch of `settings` keys.
 *
 * Handed the key list the account read already has, so enumerating the
 * account's briefings costs no extra key scan — only the reads for keys that
 * exist.
 *
 * @param {Array<string>} settingsKeys - Every key in the settings store
 * @returns {Promise<Object<string, Object>>} Character id → snapshot
 */
export async function readSnapshotsFromKeys(settingsKeys) {
    const byId = {};
    for (const key of settingsKeys || []) {
        if (typeof key !== 'string' || !key.startsWith(SNAPSHOT_PREFIX)) continue;
        const id = key.slice(SNAPSHOT_PREFIX.length);
        if (!id) continue;
        try {
            const snapshot = await storage.get(key, SNAPSHOT_STORE, null);
            if (snapshot && Number.isFinite(snapshot.at)) byId[id] = snapshot;
        } catch (error) {
            console.error(`[BriefingSnapshot] Could not read ${key}:`, error);
        }
    }
    return byId;
}
