/**
 * Dual-install guard.
 *
 * Two copies of Toolasha on one page do not coexist — they share storage. The
 * database name, its version, and the exact settings and tab keys are the same
 * for this fork and for the script it forked from (deliberately: it is what
 * lets a user move between them without losing anything — see the note in
 * `settings-storage.js`). The cost of that sharing is that whichever copy saves
 * last wins the WHOLE map, because the settings map is written whole. A copy
 * with a smaller schema therefore deletes every setting the other one added,
 * silently, on the next toggle of anything. That is the confirmed cause of the
 * "all my settings reset" reports.
 *
 * Nothing on this side can stop the other copy writing. What it can do is
 * notice and say so, which is what this module is for. Two independent signals,
 * because neither alone covers every case:
 *
 * 1. **The page marker.** The first copy to run stamps its own instance id on
 *    `window.Toolasha`; a second copy finding a different id, or finding its
 *    own stamp gone at a later check, knows another full instance is running.
 *    This fires BEFORE any damage — but only for a copy that stamps, i.e.
 *    another build of this fork. It is deliberately NOT "window.Toolasha is
 *    already defined": every one of this fork's own @require bundles defines
 *    it, by design, so that test would fire on every single load.
 *
 * 2. **The settings fingerprint.** Every load records which setting ids the
 *    stored map held, alongside the build that saw them. When a later load of
 *    the SAME build finds ids missing that the previous load had, something
 *    that is not this build rewrote the map — which is exactly the shape of
 *    the damage. This one catches the other script whatever order the two load
 *    in, at the cost of only being able to say so after the first rewrite.
 *
 * The honest limit, stated plainly: there is no reliable way from inside this
 * script to see a co-installed copy of the *other* script before it writes. It
 * announces itself on no global this fork can distinguish from its own, and
 * userscript managers do not expose their peers. Signal 2 is the closest safe
 * approximation, and it is the one that matches the reported symptom.
 */

import storage from './storage.js';

const STORE = 'settings';

/** Where the instance stamp lives on the shared namespace object */
const INSTANCE_KEY = '__toolashaInstance';

/** Where the previous load's settings fingerprint lives */
const FINGERPRINT_KEY = 'toolasha_settingsFingerprint';

/** This page-load's identity — a new one every time the script runs */
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** What the user is told, once, when either signal fires */
export const DUAL_INSTALL_MESSAGE =
    'Two copies of Toolasha are running on this page. They share the same database, ' +
    'so each one overwrites the other’s settings and custom tabs — this is how settings ' +
    'get reset and tabs disappear. Open your userscript manager and keep exactly one ' +
    'Toolasha enabled, then reload.';

/** The namespace object both the bundles and any other copy would use */
function namespace() {
    if (typeof window === 'undefined') return null;
    if (!window.Toolasha) window.Toolasha = {};
    return window.Toolasha;
}

/**
 * Claim the page for this instance, and report whether someone got here first.
 *
 * Call once, as early as the script runs.
 * @returns {boolean} Whether another instance had already claimed the page
 */
export function claimPage() {
    const ns = namespace();
    if (!ns) return false;
    const existing = ns[INSTANCE_KEY];
    const taken = Boolean(existing && existing.id && existing.id !== INSTANCE_ID);
    ns[INSTANCE_KEY] = { id: INSTANCE_ID, at: Date.now() };
    if (taken) {
        console.warn('[DualInstall] Another Toolasha instance had already claimed this page:', existing);
    }
    return taken;
}

/**
 * Has anything replaced this instance's claim since {@link claimPage}?
 *
 * A second copy that loads after this one overwrites the stamp (or resets the
 * namespace object outright, which reads the same way here).
 * @returns {boolean} Whether the claim is gone
 */
export function claimLost() {
    if (typeof window === 'undefined') return false;
    const stamped = window.Toolasha?.[INSTANCE_KEY];
    const lost = !stamped || stamped.id !== INSTANCE_ID;
    if (lost) console.warn('[DualInstall] This instance’s page claim was replaced:', stamped);
    return lost;
}

/**
 * Compare the setting ids in the stored map against the ones the previous load
 * of this same build saw, and record the current set for next time.
 *
 * Only a LOSS counts, and only within one build: a build change legitimately
 * adds and removes schema ids, so the fingerprint is discarded whenever the
 * version differs rather than read as an accusation.
 *
 * Pure apart from the one record it keeps; safe to call when nothing is stored
 * (it records and says nothing).
 *
 * @param {string} characterKey - The settings key the map was read from
 * @param {Array<string>|null} storedIds - Ids in the stored map, or null when absent
 * @param {string} version - This build's version
 * @returns {Promise<Array<string>>} The ids that went missing since the last load
 */
export async function checkSettingsFingerprint(characterKey, storedIds, version) {
    if (!Array.isArray(storedIds) || storedIds.length === 0) return [];
    const key = `${FINGERPRINT_KEY}_${characterKey}`;
    let missing = [];
    try {
        const previous = await storage.getJSON(key, STORE, null);
        if (previous && previous.version === version && Array.isArray(previous.ids)) {
            const now = new Set(storedIds);
            missing = previous.ids.filter((id) => !now.has(id));
        }
        await storage.setJSON(key, { version, ids: storedIds, at: Date.now() }, STORE, true);
    } catch (error) {
        console.error('[DualInstall] Settings fingerprint check failed:', error);
        return [];
    }
    if (missing.length > 0) {
        console.warn(
            `[DualInstall] ${missing.length} setting(s) vanished from the stored map between loads of the same ` +
                'build — another Toolasha shares this storage and rewrote it:',
            missing
        );
    }
    return missing;
}

export default { claimPage, claimLost, checkSettingsFingerprint, DUAL_INSTALL_MESSAGE };
