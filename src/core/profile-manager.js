/**
 * Profile Cache Module
 * Stores current profile in memory for Steam users
 *
 * ## Shared-profile class evidence
 *
 * A `profile_shared` message — sent whenever anyone opens a party member's or a
 * guild trial roster member's Battle Info — states a full character sheet:
 * every equipped item and every slotted ability, for a player `class-inference.js`
 * may never have seen cast a single hit. Caching what it shows means the
 * personal DPS table and the trial roster get a class guess the moment the
 * profile arrives, rather than only after the player is caught in the act (or,
 * for an auto-attacker who never casts anything identifying at all, never).
 *
 * Kept here — Core, not Utils — because the write happens in `websocket.js`
 * (Core cannot import `data-manager.js` without a circular import, and this
 * module is already Core's externalised profile singleton) and because a
 * bounded, storage-backed cache is module state: sharing one copy across every
 * bundle that touches it matters exactly as much as it does for
 * `currentProfileCache` above. `profile-manager.js` is mapped to
 * `Toolasha.Core.profileManager` in `rollup.config.js`, so every bundle that
 * imports from here — the writer in Core, the readers in Combat and UI —
 * reaches the one real copy rather than a duplicate.
 *
 * Only the ingredients a class guess needs are kept — the equipped weapon's
 * hrid and the slotted ability list — not the whole profile: `inferClass`
 * reads a weapon's own passive stats and combat style off `itemDetailMap`,
 * which is game data no shared payload carries, so resolving `stats` from
 * `weaponHrid` is left to the reader, who already has that map in hand.
 */

import storage from './storage.js';

// Module-level variable to hold current profile in memory
let currentProfileCache = null;

/**
 * Set current profile in memory
 * @param {Object} profileData - Profile data from profile_shared message
 */
export function setCurrentProfile(profileData) {
    currentProfileCache = profileData;
}

/**
 * Get current profile from memory
 * @returns {Object|null} Current profile or null
 */
export function getCurrentProfile() {
    return currentProfileCache;
}

/**
 * Clear current profile from memory
 */
export function clearCurrentProfile() {
    currentProfileCache = null;
}

/** Where the class-evidence cache lives — an existing store, no schema change */
const CLASS_EVIDENCE_STORE = 'combatStats';
/** The one key it is saved under, whole, inside that store */
const CLASS_EVIDENCE_KEY = 'sharedProfileClassEvidence';
/** Most players kept — an active guild's roster and a run's party, several times over */
const MAX_CLASS_EVIDENCE = 300;

/** name (lowercased) → `{weaponHrid, kit, at}`; loaded lazily from storage */
let classEvidence = {};
/** The in-flight (or settled) read, so a second caller does not start a second one */
let classEvidenceLoading = null;

/**
 * The key a name is cached under — trimmed and lowercased, because a battle
 * payload and a shared profile do not always agree on case.
 * @param {string} name
 * @returns {string} '' for nothing usable
 */
function evidenceKey(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase();
}

/**
 * Read the persisted cache once. In memory at once for whatever `noteSharedClassEvidence`
 * already wrote; a stored entry never overwrites one written while the read was in flight.
 * @returns {Promise<void>}
 */
function loadSharedClassEvidence() {
    if (classEvidenceLoading) return classEvidenceLoading;
    classEvidenceLoading = (async () => {
        try {
            const stored = await storage.get(CLASS_EVIDENCE_KEY, CLASS_EVIDENCE_STORE, null);
            if (stored && typeof stored === 'object') {
                classEvidence = { ...stored, ...classEvidence };
            }
        } catch (error) {
            console.error('[ProfileManager] Reading the shared-profile class cache failed:', error);
        }
    })();
    return classEvidenceLoading;
}

/**
 * What a `profile_shared` payload shows about a player's build, reduced to
 * what `class-inference.js` can use.
 *
 * Pure and synchronous — no game data is read here, so it never needs to wait
 * for `itemDetailMap` to be ready. `stats` (the weapon's passive numbers and
 * combat style, for `inferClass`'s rule 2b and its sheet-style fallback) is
 * left for the reader to resolve from `weaponHrid` once it has that map,
 * rather than looked up here.
 *
 * @param {Object} parsed - The `profile_shared` payload, as `websocket.js` parses it:
 *   `{profile: {equippedAbilities, wearableItemMap}}`
 * @returns {{weaponHrid: string|null, kit: Array<{hrid: string}>|null}|null} null when the
 *   profile carries neither a weapon nor an ability
 */
export function evidenceFromSharedProfile(parsed) {
    const abilities = parsed?.profile?.equippedAbilities;
    const kit = Array.isArray(abilities)
        ? abilities.filter((entry) => entry?.abilityHrid).map((entry) => ({ hrid: entry.abilityHrid }))
        : null;

    // The weapon sits in main_hand (one-handed, possibly with an off-hand
    // beside it) or two_hand — never both — and that item location is the one
    // thing a shared profile states outright, with no game data needed to
    // read it
    let weaponHrid = null;
    for (const item of Object.values(parsed?.profile?.wearableItemMap || {})) {
        const location = String(item?.itemLocationHrid || '');
        if (location.endsWith('/main_hand') || location.endsWith('/two_hand')) {
            weaponHrid = item?.itemHrid || weaponHrid;
        }
    }

    if (!weaponHrid && !kit?.length) return null;
    return { weaponHrid, kit: kit?.length ? kit : null };
}

/**
 * Record what a shared profile showed about a player's build, for
 * `class-inference.js` to use when nothing live has been seen from them yet.
 *
 * Bounded: the oldest entry is dropped past {@link MAX_CLASS_EVIDENCE} rather
 * than growing forever — an account that has spectated a lot of trials sees a
 * lot of names, and most of them are never looked up again.
 *
 * @param {string} name - The player's display name
 * @param {{weaponHrid: string|null, kit: Array<{hrid: string}>|null}|null} evidence - From
 *   {@link evidenceFromSharedProfile}; a falsy value is a no-op
 */
export function noteSharedClassEvidence(name, evidence) {
    const key = evidenceKey(name);
    if (!key || !evidence || (!evidence.weaponHrid && !evidence.kit?.length)) return;
    if (!classEvidenceLoading) loadSharedClassEvidence();

    classEvidence[key] = { weaponHrid: evidence.weaponHrid || null, kit: evidence.kit || null, at: Date.now() };

    const names = Object.keys(classEvidence);
    if (names.length > MAX_CLASS_EVIDENCE) {
        names
            .sort((a, b) => classEvidence[a].at - classEvidence[b].at)
            .slice(0, names.length - MAX_CLASS_EVIDENCE)
            .forEach((stale) => delete classEvidence[stale]);
    }

    storage.set(CLASS_EVIDENCE_KEY, classEvidence, CLASS_EVIDENCE_STORE).catch((error) => {
        console.error('[ProfileManager] Saving the shared-profile class cache failed:', error);
    });
}

/**
 * What a shared profile showed for a player, if any.
 *
 * The first call starts the storage read; until it lands this answers only
 * what has been written to this in-memory copy since startup, which is right
 * for a `profile_shared` received moments ago and merely incomplete for one
 * from a previous session — the next call, once the read has landed, has it.
 *
 * @param {string} name - The player's display name
 * @returns {{weaponHrid: string|null, kit: Array<{hrid: string}>|null}|null}
 */
export function sharedClassEvidenceFor(name) {
    if (!classEvidenceLoading) loadSharedClassEvidence();
    const entry = classEvidence[evidenceKey(name)];
    return entry ? { weaponHrid: entry.weaponHrid, kit: entry.kit } : null;
}

/** Forget everything in memory and any in-flight read — for tests */
export function _resetSharedClassEvidence() {
    classEvidence = {};
    classEvidenceLoading = null;
}
