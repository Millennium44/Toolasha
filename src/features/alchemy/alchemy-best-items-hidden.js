/**
 * Best Items hidden list: its stored shape and the fold two copies of it take.
 *
 * Stored per character under `alchemyBestItems_hidden_<characterId>` as
 * `{coinify: [hrid], decompose: [hrid], ...}`: the lists are what every build has always written and read, and
 * they stay the truth about what is hidden. Beside them sits `__events`, `{type: {hrid: {t, h}}}`, the time and
 * kind of the latest hide (`h: 1`) or unhide (`h: 0`, a tombstone) this record has seen for an item. Two devices
 * that hid different items between syncs keep both; an unhide on one is not undone by the other's older list.
 *
 * Older builds read only the arrays (they drop a non-array value such as `__events` from memory), so the lists
 * stay readable by them. A copy an older build wrote has no `__events`: its listed items count as hidden at time
 * 0, so any recorded unhide beats them and a recorded hide of something it does not list keeps it hidden.
 * @module alchemy-best-items-hidden
 */

import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** Storage key prefix (per character) */
export const HIDDEN_KEY_PREFIX = 'alchemyBestItems_hidden_';
/** How far ahead of this device's clock an event time may be before it is ignored */
const MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
/** The field beside the lists that holds the events; never a valid alchemy type */
export const EVENTS_FIELD = '__events';

/**
 * @param {*} value - Anything
 * @returns {boolean} Whether it is a plain object (not null, not an array)
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {*} value - A stored hidden record
 * @param {string} type - Alchemy type
 * @returns {Array<string>} The type's list, strings only, no duplicates, in stored order
 */
export function listOf(value, type) {
    const list = isPlainObject(value) && Array.isArray(value[type]) ? value[type] : [];
    return [...new Set(list.filter((hrid) => typeof hrid === 'string'))];
}

/**
 * @param {*} value - A stored hidden record
 * @param {string} type - Alchemy type
 * @param {string} hrid - Item hrid
 * @returns {{t: number, h: number}|null} The recorded event, or null when none is well formed
 */
export function eventOf(value, type, hrid) {
    const events = isPlainObject(value) && isPlainObject(value[EVENTS_FIELD]) ? value[EVENTS_FIELD][type] : null;
    const event = isPlainObject(events) ? events[hrid] : null;
    // A time far ahead of this clock is a bad clock or junk: it would pin the item against every later change
    if (!isPlainObject(event) || !Number.isFinite(event.t) || event.t <= 0 || event.t > Date.now() + MAX_AHEAD_MS) {
        return null;
    }
    return { t: event.t, h: event.h ? 1 : 0 };
}

/**
 * @param {*} value - A stored hidden record
 * @param {string} type - Alchemy type
 * @returns {Array<string>} Item hrids this record holds a well-formed event for
 */
function eventHrids(value, type) {
    const events = isPlainObject(value) && isPlainObject(value[EVENTS_FIELD]) ? value[EVENTS_FIELD][type] : null;
    return isPlainObject(events) ? Object.keys(events) : [];
}

/**
 * Every type a record holds a list or events for.
 * @param {*} value - A stored hidden record
 * @returns {Array<string>} Type keys
 */
function typesOf(value) {
    const types = new Set(Object.keys(value).filter((key) => key !== EVENTS_FIELD && Array.isArray(value[key])));
    if (isPlainObject(value[EVENTS_FIELD])) {
        for (const [type, events] of Object.entries(value[EVENTS_FIELD])) if (isPlainObject(events)) types.add(type);
    }
    return [...types];
}

/**
 * What one copy says about one item: listed means hidden (at the recorded time, or 0 for a copy with no record),
 * not listed with a recorded time means unhidden then, not listed with none means no opinion.
 * @param {*} value - A stored hidden record
 * @param {string} type - Alchemy type
 * @param {string} hrid - Item hrid
 * @param {Set<string>} listed - The type's list in that record
 * @returns {{t: number, h: number}|null} The copy's claim
 */
function claimOf(value, type, hrid, listed) {
    const event = eventOf(value, type, hrid);
    if (listed.has(hrid)) return { t: event ? event.t : 0, h: 1 };
    return event ? { t: event.t, h: 0 } : null;
}

/**
 * Fold two copies of one character's hidden record. For each item the later event wins; a tie keeps it hidden.
 * A copy that is missing or not an object says nothing, so it can never unhide anything.
 * @param {*} local - This device's stored record
 * @param {*} incoming - The other copy
 * @returns {*} The folded record
 */
export function mergeHiddenRecords(local, incoming) {
    if (!isPlainObject(local)) return isPlainObject(incoming) ? incoming : local;
    if (!isPlainObject(incoming)) return local;
    const out = {};
    const events = {};
    const types = new Set([...typesOf(local), ...typesOf(incoming)]);
    for (const type of types) {
        const localSet = new Set(listOf(local, type));
        const incomingSet = new Set(listOf(incoming, type));
        const items = new Set([...localSet, ...incomingSet, ...eventHrids(local, type), ...eventHrids(incoming, type)]);
        const hidden = [];
        for (const hrid of items) {
            const a = claimOf(local, type, hrid, localSet);
            const b = claimOf(incoming, type, hrid, incomingSet);
            let winner = a || b;
            if (a && b) winner = a.t > b.t ? a : b.t > a.t ? b : a.h >= b.h ? a : b;
            if (!winner) continue;
            if (winner.h) hidden.push(hrid);
            if (winner.t > 0) (events[type] ||= {})[hrid] = { t: winner.t, h: winner.h };
        }
        out[type] = hidden;
    }
    if (Object.keys(events).length > 0) out[EVENTS_FIELD] = events;
    // Fields this build does not know (a newer build's sibling of the lists) pass through: incoming's, else local's
    for (const source of [local, incoming]) {
        for (const [key, value] of Object.entries(source)) {
            if (key !== EVENTS_FIELD && !Array.isArray(value)) out[key] = value;
        }
    }
    return out;
}

/**
 * Apply one hide or unhide to a stored record, as the folding write does when it lands. Everything else in the
 * record (other types, other items' events, fields a newer build adds) is carried over.
 * @param {*} stored - The record in storage now (any shape)
 * @param {string} type - Alchemy type
 * @param {string} hrid - Item hrid
 * @param {boolean} hide - True to hide, false to bring back
 * @param {number} now - Clock reading
 * @returns {Object} The record to store
 */
export function applyHiddenChange(stored, type, hrid, hide, now) {
    const next = isPlainObject(stored) ? { ...stored } : {};
    const list = listOf(next, type).filter((entry) => entry !== hrid);
    if (hide) list.push(hrid);
    next[type] = list;
    // Never earlier than an event already recorded, so a clock behind another device's cannot lose the change
    const prior = eventOf(stored, type, hrid);
    const t = Math.max(now, prior ? prior.t + 1 : 0);
    const allEvents = isPlainObject(next[EVENTS_FIELD]) ? { ...next[EVENTS_FIELD] } : {};
    allEvents[type] = { ...(isPlainObject(allEvents[type]) ? allEvents[type] : {}), [hrid]: { t, h: hide ? 1 : 0 } };
    next[EVENTS_FIELD] = allEvents;
    return next;
}

registerSyncMerge({
    store: 'settings',
    prefix: HIDDEN_KEY_PREFIX,
    merge: mergeHiddenRecords,
    label: 'Alchemy Best Items hidden items',
});
