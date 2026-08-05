/**
 * What other players are actually wearing, as far as it can be seen.
 *
 * Clicking a member's icon in the guild's In Progress view opens the game's unit
 * popup — "Tib - Lv.150", a Battle Info tab and a Stats tab, and behind them a
 * full sheet: five evasions, armor, three resistances, HP and MP regeneration,
 * drop quantity and rare find, training focus, experience bonuses, and the
 * equipped abilities with their levels. It is the only place in the game a guild
 * member's build is visible, and it is gone the moment the popup closes.
 *
 * Nothing else in this script keeps any of it. Skill levels are tracked, and
 * that is all — so "why is that trial failing tier 9" is answered by guesswork
 * about who is under-geared. This writes the sheet down when it goes past.
 *
 * ## Where the numbers come from
 *
 * Two sources, and both are used, because they cover different people:
 *
 * - **`battle_unit_fetched`** is the message the client already treats as
 *   special (`websocket.js` exempts it from de-duplication precisely because
 *   consecutive fetches of different units look alike in the first hundred
 *   characters). It carries a whole `CombatUnit`, which is the popup's own
 *   source, so opening a popup is what produces a snapshot. The same message
 *   type also arrives at the end of a combat session carrying only loot and
 *   experience totals; that variant has no stat sheet and {@link extractLoadout}
 *   returns null for it rather than storing an empty player.
 * - **`new_battle`** names every player in the party and carries their
 *   `combatDetails` — so fighting a trial beside somebody records them without
 *   anybody having to click anything.
 *
 * A popup that turns out not to be websocket-fed is covered by
 * `guild-loadout-capture.js`, which reads the modal's own text with the same
 * found-not-named discipline the trials scrape uses.
 *
 * ## A snapshot is a photograph
 *
 * Every entry carries the moment it was taken and everything that draws one says
 * so. A build seen three weeks ago is not what that member is wearing now, and a
 * stat sheet with no date on it is the single most misleading thing this could
 * store — the numbers are perfectly correct and the claim they imply is false.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { formatRelativeTime } from '../../utils/formatters.js';

/** Object store the records live in — shared with the guild XP history */
export const LOADOUT_STORE = 'guildHistory';

/** Key prefix; the viewing character's id is appended, as `guildShrineLevels` does */
export const LOADOUT_KEY_PREFIX = 'guildLoadouts';

/** How many players are remembered before the least recently seen is dropped */
export const MAX_LOADOUTS = 60;

/**
 * Fields read straight off `combatDetails`.
 *
 * Flat ratings rather than ratios, which is why they are separate from the
 * `combatStats` list below: an evasion of 1,240 and a rare find of 0.12 are both
 * numbers and only one of them is a percentage.
 */
export const DETAIL_ROWS = [
    { key: 'maxHitpoints', label: 'Max HP' },
    { key: 'maxManapoints', label: 'Max MP' },
    { key: 'totalArmor', label: 'Armor' },
    { key: 'totalWaterResistance', label: 'Water resist' },
    { key: 'totalNatureResistance', label: 'Nature resist' },
    { key: 'totalFireResistance', label: 'Fire resist' },
    { key: 'stabEvasionRating', label: 'Stab evasion' },
    { key: 'slashEvasionRating', label: 'Slash evasion' },
    { key: 'smashEvasionRating', label: 'Smash evasion' },
    { key: 'rangedEvasionRating', label: 'Ranged evasion' },
    { key: 'magicEvasionRating', label: 'Magic evasion' },
];

/** Fields read off `combatDetails.combatStats`, all of them ratios unless said otherwise */
export const STAT_ROWS = [
    { key: 'criticalRate', label: 'Crit rate', percent: true },
    { key: 'criticalDamage', label: 'Crit damage', percent: true },
    { key: 'combatDropRate', label: 'Drop rate', percent: true },
    { key: 'combatRareFind', label: 'Rare find', percent: true },
    { key: 'combatDropQuantity', label: 'Drop quantity', percent: true },
    { key: 'combatExperience', label: 'Combat XP', percent: true },
    { key: 'hpRegenPer10', label: 'HP regen /10s', percent: true },
    { key: 'mpRegenPer10', label: 'MP regen /10s', percent: true },
    { key: 'lifeSteal', label: 'Life steal', percent: true },
    { key: 'parry', label: 'Parry', percent: true },
    { key: 'tenacity', label: 'Tenacity', percent: true },
    { key: 'armorPenetration', label: 'Armor pen', percent: true },
    { key: 'physicalAmplify', label: 'Physical amplify', percent: true },
    { key: 'attackSpeed', label: 'Attack speed', percent: true },
    { key: 'castSpeed', label: 'Cast speed', percent: true },
    { key: 'threat', label: 'Threat', percent: true },
    { key: 'abilityHaste', label: 'Ability haste' },
];

/**
 * Storage key for a character's record of what it has seen.
 *
 * Keyed by the *viewing* character rather than by guild, following
 * `guildShrineLevels`: an alt in another guild has seen different people, and a
 * shared key would show one guild's builds under the other's roster.
 *
 * @param {string|number|null} characterId - Viewing character id
 * @returns {string} Storage key
 */
export function guildLoadoutsStorageKey(characterId) {
    return `${LOADOUT_KEY_PREFIX}_${characterId ?? 'default'}`;
}

/**
 * A number as the sheet shows it.
 * @param {number} value - The number
 * @param {boolean} [percent] - Whether it is a ratio
 * @returns {string} Display text
 */
function figure(value, percent = false) {
    if (percent) return `${(value * 100).toFixed(value * 100 >= 10 ? 0 : 1)}%`;
    return Math.round(value).toLocaleString('en-US');
}

/**
 * The rows a stat sheet is worth showing.
 *
 * A ratio of zero is dropped — every player has a `curse` of zero and a sheet
 * padded with them buries the four numbers that differ. A flat rating of zero is
 * kept, because "no armor" is a fact about a build rather than an absent field.
 *
 * @param {Object} details - `combatDetails`
 * @param {Object} stats - `combatDetails.combatStats`
 * @returns {Array<{label: string, value: string}>} Rows, in the order declared above
 */
export function buildLoadoutRows(details = {}, stats = {}) {
    const rows = [];

    for (const { key, label } of DETAIL_ROWS) {
        const value = Number(details?.[key]);
        if (!Number.isFinite(value)) continue;
        rows.push({ label, value: figure(value) });
    }

    for (const { key, label, percent } of STAT_ROWS) {
        const value = Number(stats?.[key]);
        if (!Number.isFinite(value)) continue;
        if (percent && value === 0) continue;
        rows.push({ label, value: figure(value, percent) });
    }

    return rows;
}

/**
 * An ability's readable name.
 * @param {string} hrid - Ability hrid
 * @returns {string} Something readable
 */
function abilityLabel(hrid) {
    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[hrid];
    if (detail?.name) return detail.name;
    return String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * The equipped abilities, in slot order.
 * @param {Array<Object>} list - `combatAbilities`
 * @returns {Array<{hrid: string, level: number|null, label: string}>} Abilities
 */
export function readAbilities(list) {
    const abilities = [];
    for (const entry of Array.isArray(list) ? list : []) {
        const hrid = entry?.abilityHrid || entry?.hrid;
        if (!hrid) continue;
        const level = Number(entry?.level);
        abilities.push({ hrid, level: Number.isFinite(level) ? level : null, label: abilityLabel(hrid) });
    }
    return abilities;
}

/**
 * A loadout snapshot from a unit payload, or null when there is no sheet in it.
 *
 * Null is the important return. `battle_unit_fetched` also arrives at the end of
 * a combat session carrying loot totals and no stats, and a record written from
 * that would replace a real sheet with an empty one and date it now.
 *
 * @param {Object} payload - A `battle_unit_fetched` message, or a unit from one
 * @param {Object} [options] - Context
 * @param {number} [options.at] - When it was seen
 * @param {string} [options.source] - Where it came from, for the caption
 * @returns {Object|null} `{name, characterId, level, rows, abilities, stats, source, at}`
 */
export function extractLoadout(payload, { at = Date.now(), source = 'battle_unit_fetched' } = {}) {
    const unit = payload?.unit || payload;
    if (!unit || typeof unit !== 'object') return null;

    const character = unit.character && typeof unit.character === 'object' ? unit.character : null;
    const name = character?.name || (typeof unit.name === 'string' ? unit.name : null);
    if (!name) return null;

    // A monster carries `combatDetails` too, and storing one under the roster
    // would be a guild member who is a Chimerical Beast
    if (!character && unit.isPlayer !== true) return null;

    const details = unit.combatDetails && typeof unit.combatDetails === 'object' ? unit.combatDetails : {};
    const stats = details.combatStats && typeof details.combatStats === 'object' ? details.combatStats : {};
    const rows = buildLoadoutRows(details, stats);
    const abilities = readAbilities(unit.combatAbilities);
    if (!rows.length && !abilities.length) return null;

    const level = Number(details.combatLevel ?? character?.combatLevel);

    return {
        name,
        characterId: character?.id ?? null,
        level: Number.isFinite(level) ? level : null,
        rows,
        abilities,
        // The raw numbers as well as the rows: a later comparison between two
        // members wants the values, not the strings they were drawn as
        stats: { ...stats },
        source,
        at,
    };
}

/**
 * Every player in a `new_battle`, as loadout snapshots.
 * @param {Object} data - `new_battle` payload
 * @param {Object} [options] - Passed through to {@link extractLoadout}
 * @returns {Array<Object>} Snapshots, empty when the payload carries no sheets
 */
export function extractPartyLoadouts(data, { at = Date.now() } = {}) {
    const players = Object.values(data?.players || {});
    return players.map((player) => extractLoadout(player, { at, source: 'new_battle' })).filter(Boolean);
}

/**
 * The key a player's snapshot is stored under.
 * @param {string} name - Player name
 * @returns {string} Stable key
 */
export function loadoutKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase();
}

/**
 * Fold a snapshot into a record, on a copy.
 *
 * Newest wins outright, including when the newer one is thinner. A popup scrape
 * with six rows replacing a socket snapshot with thirty is a real loss of
 * detail, and it is still the more honest record: the thin one is what was
 * actually seen most recently, and preferring the fat one would date old numbers
 * to now.
 *
 * @param {Object|null} record - Existing record (not mutated)
 * @param {Object|null} loadout - From {@link extractLoadout}
 * @returns {Object} `{players: Object, updatedAt: number}`
 */
export function foldLoadout(record, loadout) {
    const players = { ...(record?.players || {}) };
    if (!loadout?.name) return { players, updatedAt: record?.updatedAt ?? 0 };

    const key = loadoutKey(loadout.name);
    const existing = players[key];
    if (existing && Number(existing.at) > Number(loadout.at)) {
        return { players, updatedAt: record?.updatedAt ?? 0 };
    }

    players[key] = { ...loadout };

    // Oldest sightings fall off the end rather than the record growing without
    // bound across every guild an account has ever been in
    const keys = Object.keys(players);
    if (keys.length > MAX_LOADOUTS) {
        const ordered = keys.sort((a, b) => (players[b]?.at || 0) - (players[a]?.at || 0));
        for (const stale of ordered.slice(MAX_LOADOUTS)) delete players[stale];
    }

    return { players, updatedAt: Math.max(record?.updatedAt ?? 0, loadout.at || 0) };
}

/**
 * The record as a list, most recently seen first.
 * @param {Object|null} record - A stored record
 * @returns {Array<Object>} Snapshots
 */
export function loadoutList(record) {
    const players = record?.players && typeof record.players === 'object' ? record.players : {};
    return Object.values(players)
        .filter((entry) => entry && entry.name)
        .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * How old a snapshot is, in words.
 * @param {number} at - When it was taken
 * @param {number} [now] - Clock
 * @returns {string} e.g. `seen 2h ago`
 */
export function describeLoadoutAge(at, now = Date.now()) {
    if (!Number.isFinite(at) || at <= 0) return 'seen at an unknown time';
    return `seen ${formatRelativeTime(Math.max(0, now - at))}`;
}

/**
 * Read a character's record of the loadouts it has seen.
 * @param {string|number|null} characterId - Viewing character id
 * @returns {Promise<Object>} The record, or an empty one
 */
export async function loadLoadouts(characterId) {
    try {
        const record = await storage.get(guildLoadoutsStorageKey(characterId), LOADOUT_STORE, null);
        if (!record || typeof record !== 'object') return { players: {}, updatedAt: 0 };
        return { players: record.players || {}, updatedAt: record.updatedAt || 0 };
    } catch (error) {
        console.error('[GuildLoadouts] Failed to load seen loadouts:', error);
        return { players: {}, updatedAt: 0 };
    }
}

/**
 * Write a character's record.
 * @param {string|number|null} characterId - Viewing character id
 * @param {Object} record - The record
 * @returns {Promise<boolean>} True when the write was queued
 */
export async function saveLoadouts(characterId, record) {
    try {
        if (!Object.keys(record?.players || {}).length) return false;
        await storage.set(guildLoadoutsStorageKey(characterId), record, LOADOUT_STORE);
        return true;
    } catch (error) {
        console.error('[GuildLoadouts] Failed to save seen loadouts:', error);
        return false;
    }
}
