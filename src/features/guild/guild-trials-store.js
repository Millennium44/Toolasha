/**
 * What the trial panel has to remember.
 *
 * Two separate problems, kept in one place because both are "state the panel
 * needs and cannot compute".
 *
 * ## Rate samples
 *
 * A fill rate or a DPS reading needs two observations spread over real time, and
 * the guild panel is a tab a player flicks through. Keeping samples only in
 * memory meant every visit to the tab started from nothing and showed "measuring
 * …" for as long as the player was willing to sit and stare at it. They are
 * written down instead, keyed by guild name — following the `guildXP_<name>`
 * precedent in `guild-xp-tracker.js`, because trial state belongs to the guild
 * and not to whichever alt happened to look at it — and thrown away when the
 * week rolls over, since last week's trials are a different ladder.
 *
 * ## Building bonuses
 *
 * Guild Points and token payouts both scale with a building level (Builders Hall
 * and the Treasury respectively), and those levels are only on the wire when
 * guild traffic carries them — the same problem `guild-shrine-store.js` solves
 * for shrines, and it is already solving it here: `guildBuildingLevelMap` is
 * captured and persisted by the data manager, so the level survives the session
 * it was seen in.
 *
 * The *bonus per level*, though, is a different matter. The hrid spellings and
 * the client-data map that describes them have not been verified against a live
 * client, so every lookup here is a probe: several plausible map names, matched
 * by shape, with a hard null when none of them answers. A null is reported as
 * unknown and the panel shows un-bonused figures with a note — which is correct,
 * and is what a guessed multiplier would not be. A manual override in settings
 * covers the player who knows their own guild's numbers and wants them applied.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import config from '../../core/config.js';
import { trialWeekStart } from './guild-trials-math.js';

/** Object store the records live in — shared with the guild XP history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the guild name is appended, as `guildXP_<name>` does */
const KEY_PREFIX = 'guildTrials';

/** Samples kept per tile. An hour of trial at one sample every five seconds is 720. */
export const MAX_SAMPLES = 800;

/**
 * Storage key for a guild's trial record.
 * @param {string|null} guildName - Guild name, or null before it is known
 * @returns {string} Storage key
 */
export function guildTrialsStorageKey(guildName) {
    return `${KEY_PREFIX}_${guildName || 'default'}`;
}

/**
 * An empty record for a week.
 * @param {number} weekStart - Week start, in ms
 * @returns {{weekStart: number, tiles: Object}} Fresh record
 */
export function emptyRecord(weekStart) {
    return { weekStart, tiles: {} };
}

/**
 * The key a tile's history is stored under.
 *
 * Name plus kind rather than name alone: two trials could in principle share a
 * name across the skilling and combat halves of a week, and a merged history
 * would fit a growth curve across two different ladders.
 *
 * @param {{name: string, kind: string}} tile - A scraped tile
 * @returns {string} Stable key
 */
export function tileKey(tile) {
    return `${tile?.kind || 'unknown'}::${String(tile?.name || '')
        .trim()
        .toLowerCase()}`;
}

/**
 * Fold a scraped tile into a record, in place on a copy.
 *
 * Three things are written: the sample itself, the tile's identity, and — when
 * the tile is showing a total for a tier that has not been seen before — a tier
 * observation, which is what the growth fit is later built from. Repeat samples
 * with an identical timestamp are dropped, because the panel's observer fires
 * several times for one React render and a zero-span pair reads as an infinite
 * rate.
 *
 * @param {Object} record - Existing record (not mutated)
 * @param {Object} tile - A tile from `readTrialTiles`
 * @param {number} at - Sample time, in ms
 * @returns {Object} The updated record
 */
export function recordTileSample(record, tile, at) {
    const weekStart = record?.weekStart ?? trialWeekStart(at);
    const tiles = { ...(record?.tiles || {}) };
    const key = tileKey(tile);
    const existing = tiles[key] || { name: tile?.name || '', kind: tile?.kind || 'skilling', samples: [], tiers: [] };

    const samples = existing.samples.filter((sample) => sample?.t !== at);
    samples.push({ t: at, readings: (tile?.readings || []).map((reading) => ({ ...reading })) });
    samples.sort((a, b) => a.t - b.t);

    const tiers = [...(existing.tiers || [])];
    if (Number.isFinite(tile?.tier)) {
        for (const reading of tile?.readings || []) {
            if (!(reading.max > 0)) continue;
            const seen = tiers.find((entry) => entry.tier === tile.tier && entry.total === reading.max);
            if (!seen) tiers.push({ tier: tile.tier, total: reading.max });
        }
    }

    tiles[key] = {
        name: tile?.name || existing.name,
        kind: tile?.kind || existing.kind,
        level: Number.isFinite(tile?.level) ? tile.level : existing.level,
        tier: Number.isFinite(tile?.tier) ? tile.tier : existing.tier,
        samples: samples.slice(-MAX_SAMPLES),
        tiers,
    };

    return { weekStart, tiles };
}

/**
 * Read a guild's record, discarding one from a previous week.
 * @param {string|null} guildName - Guild name
 * @param {number} [now] - Clock, in ms
 * @returns {Promise<Object>} The record, or a fresh one
 */
export async function loadTrialRecord(guildName, now = Date.now()) {
    const weekStart = trialWeekStart(now);
    try {
        const record = await storage.get(guildTrialsStorageKey(guildName), STORE_NAME, null);
        if (!record || typeof record !== 'object' || record.weekStart !== weekStart) return emptyRecord(weekStart);
        return { weekStart: record.weekStart, tiles: record.tiles || {} };
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to load trial samples:', error);
        return emptyRecord(weekStart);
    }
}

/**
 * Write a guild's record.
 * @param {string|null} guildName - Guild name
 * @param {Object} record - The record
 * @returns {Promise<boolean>} True when the write was queued
 */
export async function saveTrialRecord(guildName, record) {
    try {
        await storage.set(guildTrialsStorageKey(guildName), record, STORE_NAME);
        return true;
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to save trial samples:', error);
        return false;
    }
}

// ─── Building bonuses ───────────────────────────────────────────────────────

/** The buildings whose levels change a payout, and how their hrids are spelled */
export const BUILDING_PATTERNS = {
    buildersHall: /buildershall/,
    treasury: /treasury/,
    skillingEncampment: /skillingencampment/,
    combatEncampment: /combatencampment/,
};

/** Client-data maps that might describe guild buildings, most likely first */
const DETAIL_MAP_KEYS = ['guildBuildingDetailMap', 'guildBuildingDetailDict', 'guildShrineDetailMap'];

/**
 * An hrid reduced to its comparable letters.
 * @param {string} hrid - An hrid
 * @returns {string} Lowercase letters only
 */
function normaliseHrid(hrid) {
    return String(hrid || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
}

/**
 * Find the hrid a building is spelled with, from whatever the guild has built.
 * @param {Object} levelMap - `guildBuildingLevelMap`
 * @param {RegExp} pattern - One of {@link BUILDING_PATTERNS}
 * @returns {string|null} The hrid, or null when the guild has no such building
 */
export function findBuildingHrid(levelMap, pattern) {
    for (const hrid of Object.keys(levelMap || {})) {
        if (pattern.test(normaliseHrid(hrid))) return hrid;
    }
    return null;
}

/**
 * The bonus a building's detail entry grants at a level.
 *
 * Reads the buff shape the rest of the codebase already reads — `ratioBoost`
 * plus `(level - 1) × ratioBoostLevelBonus`, as `combat-sim-adapter.js`
 * resolves shrine buffs — and falls back to a flat `bonusPerLevel` field for a
 * detail entry that carries one instead. Anything else returns null.
 *
 * @param {Object} detail - A guild building detail entry
 * @param {number} level - Built level
 * @returns {number|null} Bonus as a fraction, or null when the entry says nothing usable
 */
export function buildingBonusFromDetail(detail, level) {
    if (!detail || !Number.isFinite(level) || level <= 0) return null;

    const buffs = Array.isArray(detail.buffs) ? detail.buffs : [];
    for (const buff of buffs) {
        const base = Number(buff?.ratioBoost);
        const perLevel = Number(buff?.ratioBoostLevelBonus);
        if (Number.isFinite(base) || Number.isFinite(perLevel)) {
            return (Number.isFinite(base) ? base : 0) + (level - 1) * (Number.isFinite(perLevel) ? perLevel : 0);
        }
    }

    const perLevel = Number(detail.bonusPerLevel ?? detail.ratioBoostLevelBonus);
    if (Number.isFinite(perLevel)) return perLevel * level;

    return null;
}

/**
 * Everything known about one payout-relevant building.
 *
 * `source` is what the panel needs to caption itself: `'client'` when the game's
 * own data answered, `'manual'` when the player typed the number in, and
 * `'unknown'` when neither did — in which case `bonus` is null and the caller
 * must show un-bonused figures rather than treat it as zero.
 *
 * @param {Object} input - Inputs
 * @param {RegExp} input.pattern - Which building
 * @param {number|null} input.override - Manual bonus as a percentage, or null
 * @param {Object} [input.levelMap] - `guildBuildingLevelMap`; read from the data manager when omitted
 * @param {Object} [input.detailMap] - Building detail map; probed from client data when omitted
 * @returns {{hrid: string|null, level: number, bonus: number|null, source: string}} What is known
 */
export function readBuildingBonus({ pattern, override = null, levelMap, detailMap }) {
    const levels = levelMap || dataManager.guildBuildingLevelMap || {};
    const details = detailMap || probeBuildingDetailMap();

    const hrid = findBuildingHrid(levels, pattern);
    const level = hrid ? Number(levels[hrid]) || 0 : 0;

    if (Number.isFinite(override) && override > 0) {
        return { hrid, level, bonus: override / 100, source: 'manual' };
    }

    const bonus = hrid ? buildingBonusFromDetail(details?.[hrid], level) : null;
    if (Number.isFinite(bonus)) return { hrid, level, bonus, source: 'client' };

    return { hrid, level, bonus: null, source: 'unknown' };
}

/**
 * The client-data map describing guild buildings, whichever it is called.
 * @returns {Object} The map, or an empty object
 */
export function probeBuildingDetailMap() {
    const clientData = dataManager.getInitClientData?.() || {};
    for (const key of DETAIL_MAP_KEYS) {
        const candidate = clientData[key];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
    }
    return {};
}

/**
 * Both payout bonuses, with their provenance.
 * @param {Object} [options] - Overrides, for tests
 * @param {Object} [options.levelMap] - `guildBuildingLevelMap`
 * @param {Object} [options.detailMap] - Building detail map
 * @param {Function} [options.getSetting] - Settings reader
 * @returns {{buildersHall: Object, treasury: Object}} Bonus info per building
 */
export function readPayoutBonuses({ levelMap, detailMap, getSetting } = {}) {
    const read = getSetting || ((key, fallback) => config.getSettingValue?.(key, fallback) ?? fallback);
    return {
        buildersHall: readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            override: Number(read('guildTrialsBuildersHallBonus', 0)),
            levelMap,
            detailMap,
        }),
        treasury: readBuildingBonus({
            pattern: BUILDING_PATTERNS.treasury,
            override: Number(read('guildTrialsTreasuryBonus', 0)),
            levelMap,
            detailMap,
        }),
    };
}
