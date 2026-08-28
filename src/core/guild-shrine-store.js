/**
 * Guild shrine levels, kept past the message that carried them.
 *
 * Two maps decide what the combat sim can say about a shrine upgrade:
 *
 * - `characterGuildBuffMap` — the levels *this character* has bought in each
 *   guild buff, which is the "current level" every upgrade row steps from.
 * - `guildBuildingLevelMap` — the levels *the guild* has built each shrine to,
 *   which caps how far members are allowed to buy.
 *
 * Neither is reliably present at login. They ride along on guild traffic, which
 * for most sessions means they arrive only once the guild panel has been opened
 * — and never at all for a player who does not open it. Without them the upgrade
 * advisor cannot tell "the shrine is not built" from "nobody told us", so it
 * says so instead of guessing, and every shrine row reads as unknown.
 *
 * So whatever does arrive is written down, keyed per character, with the time it
 * was captured. On the next login the levels are hydrated from that record until
 * a live message replaces them, and `capturedAt` lets a caller say how old the
 * reading is rather than presenting it as current.
 *
 * The message type is deliberately not part of this: the maps are matched by
 * shape wherever they appear, because which message carries them has changed
 * before and the cost of looking is two property reads.
 */

import storage from './storage.js';

/** Object store the records live in — shared with the guild XP history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the character id is appended so alts do not share a reading */
const KEY_PREFIX = 'guildShrineLevels';

/**
 * Storage key for a character's shrine record.
 * @param {string|number|null} characterId - Character id, or null before it is known
 * @returns {string} Storage key
 */
export function guildShrineStorageKey(characterId) {
    return `${KEY_PREFIX}_${characterId ?? 'default'}`;
}

/**
 * Whether a value is a usable map object (and not an array or null).
 * @param {*} value - Candidate
 * @returns {boolean} True when it can be read as an hrid → entry map
 */
function isMapObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Count of entries in a map, tolerating anything that is not one.
 * @param {*} value - Candidate map
 * @returns {number} Number of keys, or 0
 */
export function mapSize(value) {
    return isMapObject(value) ? Object.keys(value).length : 0;
}

/**
 * Pull guild shrine levels out of a WebSocket message, whatever its type.
 *
 * A map is only reported when the message actually carries that key: an absent
 * `guildBuildingLevelMap` must not be read as "the guild has built nothing", or
 * a message about buff purchases would erase the building levels beside them.
 *
 * @param {Object} message - Parsed WebSocket message
 * @returns {{characterGuildBuffMap: (Object|undefined), guildBuildingLevelMap: (Object|undefined), guildId: (string|number|null)}|null}
 *   The maps present in the message, or null when it carries neither
 */
export function extractGuildShrineData(message) {
    if (!message || typeof message !== 'object') return null;

    // Fast path. This runs against every message on the socket, including the
    // battle ticks that arrive several times a second, so anything that is
    // plainly not guild traffic leaves before a single object is allocated.
    if (
        message.characterGuildBuffMap === undefined &&
        message.guildBuildingLevelMap === undefined &&
        message.guild === undefined &&
        message.characterGuild === undefined &&
        message.guildInfo === undefined
    ) {
        return null;
    }

    // Nested carriers as well as the top level — the same maps have been seen
    // hanging off the guild object rather than beside it
    const sources = [message, message.guild, message.characterGuild, message.guildInfo];

    let characterGuildBuffMap;
    let guildBuildingLevelMap;
    let guildId = null;

    for (const source of sources) {
        if (!isMapObject(source)) continue;

        if (characterGuildBuffMap === undefined && isMapObject(source.characterGuildBuffMap)) {
            characterGuildBuffMap = source.characterGuildBuffMap;
        }
        if (guildBuildingLevelMap === undefined && isMapObject(source.guildBuildingLevelMap)) {
            guildBuildingLevelMap = source.guildBuildingLevelMap;
        }
        if (guildId === null) {
            guildId = source.guildID ?? source.guildId ?? (source === message ? null : source.id) ?? null;
        }
    }

    if (characterGuildBuffMap === undefined && guildBuildingLevelMap === undefined) return null;

    return { characterGuildBuffMap, guildBuildingLevelMap, guildId };
}

/**
 * Whether a captured buff map belongs to `characterId`, by the map's own word.
 *
 * Every buff row the game sends carries the `characterID` that bought it. The
 * capture listens on the raw socket with no character scoping, so during a
 * switch a late message from the DEPARTING character's socket can arrive after
 * `currentCharacterId` has moved on — and used to be persisted under the new
 * character's key, which is how one character's shrine plan showed another's
 * buff levels. A row that carries no `characterID` casts no vote; only an
 * explicit mismatch disowns the map.
 *
 * @param {Object|null|undefined} buffMap - A `characterGuildBuffMap`
 * @param {string|number|null} characterId - Whose it is supposed to be
 * @returns {boolean} False only when a row explicitly names a different owner
 */
export function buffMapBelongsTo(buffMap, characterId) {
    if (!isMapObject(buffMap) || characterId == null) return true;
    for (const row of Object.values(buffMap)) {
        const owner = row?.characterID ?? row?.characterId;
        if (owner != null && String(owner) !== String(characterId)) return false;
    }
    return true;
}

/**
 * Read a character's persisted shrine record.
 * @param {string|number|null} characterId - Character id
 * @returns {Promise<Object|null>} The record, or null when there is none
 */
export async function loadGuildShrineLevels(characterId) {
    try {
        if (typeof storage?.getJSON !== 'function') return null;
        const record = await storage.getJSON(guildShrineStorageKey(characterId), STORE_NAME, null);
        if (!record || typeof record !== 'object') return null;
        return record;
    } catch (error) {
        console.error('[GuildShrineStore] Failed to load guild shrine levels:', error);
        return null;
    }
}

/**
 * Write a character's shrine record.
 *
 * A record with nothing in either map is not written: it would replace a real
 * earlier reading with the absence of one.
 *
 * @param {string|number|null} characterId - Character id
 * @param {Object} record - `{characterGuildBuffMap, guildBuildingLevelMap, guildId, capturedAt}`
 * @returns {Promise<boolean>} True when something was written
 */
export async function saveGuildShrineLevels(characterId, record) {
    try {
        if (typeof storage?.setJSON !== 'function') return false;
        if (mapSize(record?.characterGuildBuffMap) === 0 && mapSize(record?.guildBuildingLevelMap) === 0) {
            return false;
        }

        await storage.setJSON(
            guildShrineStorageKey(characterId),
            {
                characterGuildBuffMap: record.characterGuildBuffMap || {},
                guildBuildingLevelMap: record.guildBuildingLevelMap || {},
                guildId: record.guildId ?? null,
                capturedAt: record.capturedAt || Date.now(),
            },
            STORE_NAME
        );
        return true;
    } catch (error) {
        console.error('[GuildShrineStore] Failed to save guild shrine levels:', error);
        return false;
    }
}
