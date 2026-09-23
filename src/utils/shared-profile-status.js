/**
 * How much a cached `profile_shared` payload can be trusted as a party member's loadout.
 *
 * A party member's gear, abilities and house rooms in every combat sim come from the last
 * `profile_shared` this browser saw for them (`websocket.js` keeps the list under
 * `profile_list` in the `combatExport` store, one entry per character id, and stamps each
 * entry's `timestamp` with the capture time). Nothing refreshes an entry except opening that
 * player's profile again, so the loadout can be weeks old, and a profile that hides its
 * equipment arrives with an empty `wearableItemMap` — a member who then fights naked in the
 * sim with nothing on screen to say why.
 *
 * Pure: every function takes the time it measures against, so a caller can compute a status
 * once and re-age it at render time.
 */

/**
 * Past this a cached profile is flagged as stale. A day, because that is the cadence a party
 * member's build actually moves on: ability levels climb with every day of combat, gear gets
 * enhanced or swapped as the market turns over, and house rooms are built between sessions.
 * A profile opened during the current play session reads as fresh; one from yesterday or
 * earlier is the first that plausibly misses a change worth simulating. Any shorter and a
 * party that plays together all evening would see every member warned about mid-session.
 */
export const PROFILE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * When a cached profile was captured.
 * @param {Object|null|undefined} profile - A `profile_list` entry
 * @returns {number|null} Epoch milliseconds, or null when the entry carries no usable stamp
 */
export function profileCapturedAt(profile) {
    const stamp = profile?.timestamp;
    return typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

/**
 * Age of a capture, clamped at zero: a second game tab can stamp with a clock slightly ahead.
 * @param {number|null} capturedAt - From {@link profileCapturedAt}
 * @param {number} [now=Date.now()] - Reference time
 * @returns {number|null} Milliseconds, or null when the capture time is unknown
 */
export function profileAgeMs(capturedAt, now = Date.now()) {
    return capturedAt === null || capturedAt === undefined ? null : Math.max(0, now - capturedAt);
}

/**
 * Whether an age is old enough to warn about. An unknown age is treated as stale, never fresh.
 * @param {number|null} ageMs - From {@link profileAgeMs}
 * @returns {boolean}
 */
export function isProfileStale(ageMs) {
    return ageMs === null || ageMs > PROFILE_STALE_MS;
}

/**
 * A cached profile's trustworthiness as a sim loadout.
 * @param {Object|null|undefined} profile - A `profile_list` entry, or nothing when none is cached
 * @param {number} [now=Date.now()] - Reference time
 * @returns {{found: boolean, capturedAt: number|null, ageMs: number|null, stale: boolean,
 *   gearless: boolean, hidden: boolean}} `gearless` when the profile names no equipped item;
 *   `hidden` when that is because the owner hides their equipment
 */
export function sharedProfileStatus(profile, now = Date.now()) {
    if (!profile) {
        return { found: false, capturedAt: null, ageMs: null, stale: true, gearless: true, hidden: false };
    }
    const capturedAt = profileCapturedAt(profile);
    const ageMs = profileAgeMs(capturedAt, now);
    const worn = Object.values(profile.profile?.wearableItemMap || {}).filter((item) => item?.itemHrid);
    const gearless = worn.length === 0;
    return {
        found: true,
        capturedAt,
        ageMs,
        stale: isProfileStale(ageMs),
        gearless,
        hidden: gearless && !!profile.profile?.hideWearableItems,
    };
}

/**
 * Short age label: "5 min old", "7 h old", "3 d old", or "age unknown".
 * @param {number|null} ageMs - From {@link profileAgeMs}
 * @returns {string}
 */
export function formatProfileAge(ageMs) {
    if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return 'age unknown';
    const minutes = ageMs / 60000;
    if (minutes < 60) return `${Math.max(1, Math.floor(minutes))} min old`;
    const hours = minutes / 60;
    if (hours < 48) return `${Math.floor(hours)} h old`;
    return `${Math.floor(hours / 24)} d old`;
}

/**
 * The warning a party member's cached profile deserves, or null when it is recent and geared.
 *
 * Worded for both the in-game sim and the exports, since the member is loaded (or exported)
 * either way; a member with no cached profile at all is the one case that is left out.
 *
 * @param {string} name - The member's display name
 * @param {ReturnType<typeof sharedProfileStatus>} status - Their profile's status
 * @param {number} [now=Date.now()] - Reference time, for re-aging a status computed earlier
 * @returns {{level: 'missing'|'gearless'|'stale', text: string}|null}
 */
export function sharedProfileWarning(name, status, now = Date.now()) {
    const who = name || 'Unknown';
    if (!status?.found) {
        return {
            level: 'missing',
            text: `${who}: no cached profile, left out. Open their profile in game, then try again.`,
        };
    }
    if (status.gearless) {
        const why = status.hidden ? 'their profile hides equipment' : 'their profile shows no equipment';
        return {
            level: 'gearless',
            text: `${who}: included with NO gear (${why}). Open their profile while you share a party to capture it.`,
        };
    }
    const ageMs = profileAgeMs(status.capturedAt, now);
    if (isProfileStale(ageMs)) {
        const age = ageMs === null ? 'of unknown age' : formatProfileAge(ageMs);
        return {
            level: 'stale',
            text: `${who}: profile ${age}, so their gear may have changed. Open their profile to refresh it.`,
        };
    }
    return null;
}

/**
 * One-line summary of the loaded members whose profiles need a second look, for a status bar.
 * Members with no cached profile are left to the caller, which already names them as missing.
 * @param {Array<{name: string, found: boolean, capturedAt: number|null, gearless: boolean}>} statuses
 * @param {number} [now=Date.now()] - Reference time
 * @returns {string} e.g. "No gear: Dave · Old profiles: Carol 3 d old", or '' when all is well
 */
export function sharedProfileSummary(statuses, now = Date.now()) {
    const loaded = (statuses || []).filter((entry) => entry?.found);
    const gearless = loaded.filter((entry) => entry.gearless).map((entry) => entry.name);
    const old = loaded
        .filter((entry) => !entry.gearless && isProfileStale(profileAgeMs(entry.capturedAt, now)))
        .map((entry) => `${entry.name} ${formatProfileAge(profileAgeMs(entry.capturedAt, now))}`);
    const parts = [];
    if (gearless.length) parts.push(`No gear: ${gearless.join(', ')}`);
    if (old.length) parts.push(`Old profiles: ${old.join(', ')}`);
    return parts.join(' · ');
}
