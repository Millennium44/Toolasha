/**
 * Partymates' View Loadouts for the Metz team export
 *
 * The game answers a party member's "View Loadout" with the loadout they have selected for group
 * combat (`loadout_shared`; see `utils/view-loadout.js`), while their cached profile shows whatever
 * they wore when it was opened. The Metz "Import from Toolasha" button runs on the Metz site, which
 * never sees the game's WebSocket and cannot reach `view-loadout.js`'s in-memory captures, so the game
 * page copies party-context captures to GM storage here and the export reads them back.
 *
 * ## Why this persists what view-loadout.js keeps in memory
 *
 * `view-loadout.js` keeps captures in memory because a persisted loadout goes stale with nothing to
 * say so. This store answers that concern instead of ignoring it:
 * - every entry carries its capture time, and is dropped once older than {@link PARTY_LOADOUT_TTL_MS};
 * - the export prefers an entry over the member's cached profile only when it is newer than that
 *   profile, and names the source and both ages in its warnings;
 * - entries are keyed by the member's character id and the whole store by the character that captured
 *   them; the export reads it only for that character, and only for members in the roster it exports.
 *
 * ## What is stored
 *
 * `{owners: {[capturingCharacterId]: {entries: {[memberCharacterId]: {capturedAt, loadout}}}}}` with the
 * loadout trimmed to the fields a sim reads. Only captures made in the party context, of a combat
 * loadout, whose rows name the same character the capture is filed under. A capture by one character
 * leaves the others' entries alone (two tabs, or a swap, must not empty each other's store); the
 * {@link MAX_PARTY_LOADOUT_OWNERS} most recent characters are kept. A party reply with no loadout
 * deletes that member's entry, since it is newer news than the entry. The single-owner
 * `{ownerCharacterId, entries}` shape an earlier build wrote is still read.
 *
 * ## Storage and sync
 *
 * One GM key, `toolasha_metz_party_loadouts`, written only when the serialized store changes (one
 * write per View Loadout at most; never on a timer). GM values live in the userscript manager, outside
 * the IndexedDB stores Toolasha's sync carries (`features/sync/sync-ownership.js` lists those), so it
 * never syncs. That is intended: it is a per-device cache that a fresh View Loadout refills.
 */

import {
    characterIdFromLoadout,
    getLoadouts,
    onLoadoutCaptured,
    VIEW_LOADOUT_CONTEXT,
} from '../../utils/view-loadout.js';
import { gmGetValue, gmSetValue } from '../../utils/gm-traffic.js';
import { PROFILE_STALE_MS } from '../../utils/shared-profile-status.js';

export const GM_PARTY_LOADOUTS_KEY = 'toolasha_metz_party_loadouts';

/**
 * Entries older than this are dropped. The same day a cached profile is called stale after: a
 * member's selected loadout moves on that cadence (gear enhanced or swapped, abilities levelled),
 * and one viewed during the current play session is what the bound should keep.
 */
export const PARTY_LOADOUT_TTL_MS = PROFILE_STALE_MS;

/** Entries kept per character, newest first. A party is five; this leaves room for a rotating group. */
export const MAX_PARTY_LOADOUTS = 12;

/** Characters whose entries are kept, most recently captured first. */
export const MAX_PARTY_LOADOUT_OWNERS = 4;

const COMBAT_ACTION_TYPE = '/action_types/combat';

let unsubscribe = null;

function idKey(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The loadout fields a sim reads, without counts, experience or row ids.
 * @param {Object} loadout - A `loadout_shared` payload
 * @returns {Object}
 */
function trimLoadout(loadout) {
    const wearableItemMap = {};
    for (const [location, row] of Object.entries(isObject(loadout.wearableItemMap) ? loadout.wearableItemMap : {})) {
        if (!row?.itemHrid) continue;
        const itemLocationHrid = row.itemLocationHrid || location;
        wearableItemMap[itemLocationHrid] = {
            itemLocationHrid,
            itemHrid: row.itemHrid,
            enhancementLevel: Number(row.enhancementLevel) || 0,
        };
    }
    const equippedAbilities = (Array.isArray(loadout.equippedAbilities) ? loadout.equippedAbilities : [])
        .filter((row) => row?.abilityHrid)
        .map((row) => ({
            abilityHrid: row.abilityHrid,
            level: Number(row.level) || 1,
            ...(Number.isFinite(row.slotNumber) && { slotNumber: row.slotNumber }),
        }));
    const combatConsumables = (Array.isArray(loadout.combatConsumables) ? loadout.combatConsumables : [])
        .filter((row) => row?.itemHrid)
        .map((row) => ({ itemHrid: row.itemHrid }));
    return {
        actionTypeHrid: loadout.actionTypeHrid || COMBAT_ACTION_TYPE,
        wearableItemMap,
        equippedAbilities,
        combatConsumables,
        abilityCombatTriggersMap: isObject(loadout.abilityCombatTriggersMap) ? loadout.abilityCombatTriggersMap : {},
        consumableCombatTriggersMap: isObject(loadout.consumableCombatTriggersMap)
            ? loadout.consumableCombatTriggersMap
            : {},
    };
}

function readStore() {
    if (typeof GM_getValue === 'undefined') return { raw: null, store: null };
    try {
        const raw = gmGetValue(GM_PARTY_LOADOUTS_KEY, null);
        const parsed = raw ? JSON.parse(raw) : null;
        let store = null;
        if (isObject(parsed) && isObject(parsed.owners)) {
            const owners = {};
            for (const [owner, bucket] of Object.entries(parsed.owners)) {
                if (idKey(owner) && isObject(bucket) && isObject(bucket.entries)) {
                    owners[owner] = { entries: bucket.entries };
                }
            }
            store = { owners };
        } else if (isObject(parsed) && idKey(parsed.ownerCharacterId) && isObject(parsed.entries)) {
            // The single-owner shape an earlier build wrote
            store = { owners: { [String(parsed.ownerCharacterId)]: { entries: parsed.entries } } };
        }
        return { raw, store };
    } catch (error) {
        console.error('[MetzPartyLoadouts] Failed to read stored loadouts:', error);
        return { raw: null, store: null };
    }
}

function isLive(stored, now) {
    const at = stored?.capturedAt;
    return (
        typeof at === 'number' && Number.isFinite(at) && now - at <= PARTY_LOADOUT_TTL_MS && isObject(stored.loadout)
    );
}

/**
 * Fold one capture into a store, in place.
 * @param {{owners: Object}|null} store - Entries by the character that captured them
 * @param {Object} entry - A `CapturedLoadout` from view-loadout.js
 * @returns {{owners: Object}|null} The store (a new one when there was none); null when there is
 *   none and the capture is not one this store keeps
 */
function fold(store, entry) {
    if (!entry || entry.context !== VIEW_LOADOUT_CONTEXT.Party) return store;
    const owner = idKey(entry.ownerCharacterId);
    const memberId = idKey(entry.characterId);
    const loadout = entry.loadout;
    if (!owner || !memberId || memberId === owner || !isObject(loadout)) return store;
    // The rows say whose loadout this is; a capture filed under anyone else is never kept
    const rowId = characterIdFromLoadout(loadout);
    if (rowId && rowId !== memberId) return store;
    const actionType = loadout.actionTypeHrid;
    if (actionType && actionType !== COMBAT_ACTION_TYPE) return store;
    const capturedAt = Number(entry.capturedAt);
    if (!Number.isFinite(capturedAt)) return store;

    // Another character's entries stay: two tabs, or a character swap, must not empty each other's store
    const next = store || { owners: {} };
    const bucket = (next.owners[owner] ||= { entries: {} });
    const previous = bucket.entries[memberId];
    // An older reply arriving late never replaces a newer one
    if (previous && Number(previous.capturedAt) > capturedAt) return next;

    const trimmed = entry.hasLoadout === false ? null : trimLoadout(loadout);
    const usable = trimmed && (Object.keys(trimmed.wearableItemMap).length > 0 || trimmed.equippedAbilities.length > 0);
    if (!usable) {
        // Nothing to wear: the entry it replaces is out of date either way
        delete bucket.entries[memberId];
        return next;
    }
    // Kept only when the rows themselves name this member. A reply whose rows carry no id was matched
    // to its request by name at best, and a loadout must never be filed under the wrong player.
    if (rowId !== memberId) return store;
    bucket.entries[memberId] = { capturedAt, loadout: trimmed };
    return next;
}

/**
 * Copy party-context captures to GM storage for the Metz site. Expired entries are dropped and the
 * newest {@link MAX_PARTY_LOADOUTS} kept; nothing is written when the stored copy would not change.
 * @param {Array<Object>} entries - `CapturedLoadout`s from view-loadout.js
 * @param {number} [now=Date.now()]
 * @returns {boolean} Whether GM storage was written
 */
export function recordPartyLoadouts(entries, now = Date.now()) {
    if (typeof GM_setValue === 'undefined') return false;
    // Re-read every time: another game tab may have written since
    const { raw, store: stored } = readStore();
    let store = stored;
    for (const entry of Array.isArray(entries) ? entries : []) store = fold(store, entry);
    if (!store) return false;

    const owners = Object.entries(store.owners)
        .map(([owner, bucket]) => ({
            owner,
            kept: Object.entries(bucket.entries)
                .filter(([, value]) => isLive(value, now))
                .sort(([, a], [, b]) => b.capturedAt - a.capturedAt)
                .slice(0, MAX_PARTY_LOADOUTS),
        }))
        .filter(({ kept }) => kept.length > 0)
        .sort((a, b) => b.kept[0][1].capturedAt - a.kept[0][1].capturedAt)
        .slice(0, MAX_PARTY_LOADOUT_OWNERS);
    const serialized = JSON.stringify({
        owners: Object.fromEntries(owners.map(({ owner, kept }) => [owner, { entries: Object.fromEntries(kept) }])),
    });
    if (serialized === raw) return false;
    try {
        gmSetValue(GM_PARTY_LOADOUTS_KEY, serialized);
        return true;
    } catch (error) {
        console.error('[MetzPartyLoadouts] Failed to store loadouts:', error);
        return false;
    }
}

/**
 * A partymate's stored View Loadout, for the character exporting them.
 * @param {string|number|null} ownerCharacterId - The character being exported (whose party it is)
 * @param {string|number|null} memberCharacterId - The partymate
 * @param {number} [now=Date.now()]
 * @returns {{capturedAt: number, loadout: Object}|null} null when none was stored by that character for
 *   that member, or it has expired
 */
export function getPartyLoadout(ownerCharacterId, memberCharacterId, now = Date.now()) {
    const owner = idKey(ownerCharacterId);
    const memberId = idKey(memberCharacterId);
    if (!owner || !memberId) return null;
    const { store } = readStore();
    const stored = store?.owners[owner]?.entries[memberId];
    return isLive(stored, now) ? { capturedAt: stored.capturedAt, loadout: stored.loadout } : null;
}

/** Game page only: copy each party View Loadout to GM storage as it is captured. */
export function startMetzPartyLoadoutPublisher() {
    stopMetzPartyLoadoutPublisher();
    unsubscribe = onLoadoutCaptured((entry) => recordPartyLoadouts([entry]));
    // Captures made before this started (settings still loading) count too; one write for all of them
    recordPartyLoadouts(getLoadouts().sort((a, b) => a.capturedAt - b.capturedAt));
}

export function stopMetzPartyLoadoutPublisher() {
    unsubscribe?.();
    unsubscribe = null;
}

/** Feature-registry module */
export const metzPartyLoadoutPublisher = {
    name: 'Metz Party Loadout Publisher',
    initialize: startMetzPartyLoadoutPublisher,
    cleanup: stopMetzPartyLoadoutPublisher,
    disable: stopMetzPartyLoadoutPublisher,
};
