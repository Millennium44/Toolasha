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
 * The *bonus per level* is read three ways, in order. A manual override in
 * settings wins, for the player who knows their own guild's numbers. Then the
 * client's own detail map, if it turns out to publish one — the hrid spellings
 * and the map name have not been verified against a live client, so every lookup
 * there is a probe: several plausible map names, matched by shape. Failing both,
 * the confirmed rule: 2% per level, read off the in-game Build dialog, which
 * shows "Level 10 → Level 11, Guild Points: +20% → +22%" for the Builders Hall
 * and the same pattern for the Treasury.
 *
 * Only a building whose *level* never reached the client is reported as unknown,
 * and only then does the panel fall back to un-bonused figures with a note.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import config from '../../core/config.js';
import { BUILDING_BONUS_PER_LEVEL, GUILD_BUILDING_MAX_LEVEL, trialWeekStart } from './guild-trials-math.js';

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
 * **A card with nothing moving on it updates the identity and adds no sample.**
 * That is what makes the two trial tabs add up. The Trials tab's card carries
 * the level, the tier, what the trial is worth and how many members signed up,
 * and no progress bar at all; the In Progress tab's card carries the reading and
 * neither a level nor a tier. Both write here under the same key, and a sample
 * with an empty `readings` array would be worse than useless — `ratePerMs` would
 * fit a rate across a series with holes in it, and the overlay tile would report
 * a trial as freshly read when all that was seen was its sign-up sheet.
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

    const readings = tile?.readings || [];
    const samples = existing.samples.filter((sample) => sample?.t !== at);
    if (readings.length) samples.push({ t: at, readings: readings.map((reading) => ({ ...reading })) });
    samples.sort((a, b) => a.t - b.t);

    // The tier the reading belongs to may have come from the *other* tab: the In
    // Progress card carries a total and no tier, the Trials card carries a tier
    // and no total, and a tier observation needs both. Taking the tier already
    // on the record is what lets the growth curve be fitted at all — requiring
    // one card to carry both means no observation is ever recorded.
    const tier = Number.isFinite(tile?.tier) ? tile.tier : existing.tier;
    const tiers = [...(existing.tiers || [])];
    if (Number.isFinite(tier)) {
        for (const reading of readings) {
            if (!(reading.max > 0)) continue;
            const seen = tiers.find((entry) => entry.tier === tier && entry.total === reading.max);
            if (!seen) tiers.push({ tier, total: reading.max });
        }
    }

    // What the game itself says clearing this tier is worth, kept per tier as the
    // trial climbs. The ladder in `guild-trials-math.js` derives the same figure
    // from the guide's prose, and where the two disagree this one is right — but
    // only a card that carried *both* a tier and a points line can be filed, so
    // the tier here is the tile's own rather than the record's carried-over one.
    // Attaching the In Progress tab's reading to a stale tier is tolerable for a
    // total that is checked against movement; attaching a points figure to the
    // wrong tier would silently corrupt the payout.
    const pointsByTier = { ...(existing.pointsByTier || {}) };
    if (Number.isFinite(tile?.tier) && Number.isFinite(tile?.points)) {
        pointsByTier[tile.tier] = tile.points;
    }

    tiles[key] = {
        name: tile?.name || existing.name,
        kind: tile?.kind || existing.kind,
        level: Number.isFinite(tile?.level) ? tile.level : existing.level,
        tier: Number.isFinite(tile?.tier) ? tile.tier : existing.tier,
        // Both come off the Trials tab and are absent from the In Progress one,
        // so a card that does not carry them must not erase what the other tab
        // already said
        points: Number.isFinite(tile?.points) ? tile.points : existing.points,
        signups: tile?.signups || existing.signups || null,
        pointsByTier,
        samples: samples.slice(-MAX_SAMPLES),
        tiers,
    };

    return { weekStart, tiles };
}

/**
 * Fold two records for the same week into one.
 *
 * Needed because the guild's name arrives *after* this feature starts. The
 * record is keyed by guild name following the `guildXP_<name>` precedent, but
 * `guildXPTracker` has usually not seen the guild yet when the trials feature
 * initialises, so the first samples of a session are written under `default`.
 * When the real name turns up there are then two records — this session's under
 * `default` and previous sessions' under the name — and picking either one
 * throws away readings that were correctly taken. So they are merged.
 *
 * Samples are unioned by timestamp, which is exactly right: two records of the
 * same trial are two views of one series, a repeated timestamp is the same
 * observation seen twice, and `ratePerMs` wants them in order. Records from
 * different weeks are not merged at all — the newer week wins whole, because
 * last week's trials are a different ladder and splicing them together would
 * fit a growth curve across both.
 *
 * @param {Object|null} base - The stored record
 * @param {Object|null} incoming - The record in hand
 * @returns {Object} One record
 */
export function mergeTrialRecords(base, incoming) {
    const baseWeek = Number.isFinite(base?.weekStart) ? base.weekStart : null;
    const incomingWeek = Number.isFinite(incoming?.weekStart) ? incoming.weekStart : null;

    if (baseWeek === null) return incoming ? { weekStart: incomingWeek, tiles: incoming.tiles || {} } : emptyRecord(0);
    if (incomingWeek === null) return { weekStart: baseWeek, tiles: base.tiles || {} };
    if (baseWeek !== incomingWeek) {
        const newer = baseWeek > incomingWeek ? base : incoming;
        return { weekStart: newer.weekStart, tiles: newer.tiles || {} };
    }

    const tiles = { ...(base.tiles || {}) };
    for (const [key, tile] of Object.entries(incoming.tiles || {})) {
        const existing = tiles[key];
        if (!existing) {
            tiles[key] = tile;
            continue;
        }

        const byTime = new Map();
        for (const sample of [...(existing.samples || []), ...(tile.samples || [])]) {
            if (Number.isFinite(sample?.t)) byTime.set(sample.t, sample);
        }
        const samples = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-MAX_SAMPLES);

        const tiers = [...(existing.tiers || [])];
        for (const entry of tile.tiers || []) {
            if (!tiers.some((seen) => seen.tier === entry.tier && seen.total === entry.total)) tiers.push(entry);
        }

        // The newer record's identity wins: a tile that has moved on a tier is
        // describing the trial as it is now
        const newest = (record) => record.samples?.[record.samples.length - 1]?.t ?? 0;
        const fresher = newest(tile) >= newest(existing) ? tile : existing;
        const staler = fresher === tile ? existing : tile;

        tiles[key] = {
            name: fresher.name || existing.name,
            kind: fresher.kind || existing.kind,
            level: Number.isFinite(fresher.level) ? fresher.level : existing.level,
            tier: Number.isFinite(fresher.tier) ? fresher.tier : existing.tier,
            // Carried across rather than dropped. Both come off the Trials tab
            // and only ever off the Trials tab, and the merge that runs when the
            // guild's name arrives happens on a record built from whichever tab
            // was open — so dropping them here erased the sign-up count and the
            // game's stated points on the first render of every session, which
            // is exactly the data the payout block was found showing as zero.
            points: Number.isFinite(fresher.points) ? fresher.points : staler.points,
            signups: fresher.signups || staler.signups || null,
            pointsByTier: { ...(staler.pointsByTier || {}), ...(fresher.pointsByTier || {}) },
            samples,
            tiers,
        };
    }

    return { weekStart: baseWeek, tiles };
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

/**
 * Highest level a guild building or shrine can reach.
 *
 * Confirmed against the in-game Buildings tab, which shows "Lv. 10 / 20" — a
 * different ladder from the 21 trial tiers `guild-trials-math.js` encodes
 * ({@link module:./guild-trials-math.TRIAL_MAX_TIER}), and the two must never be
 * conflated. A level read off `guildBuildingLevelMap` above this is stale or
 * corrupt data, not a building the confirmed 2%-per-level formula should be
 * extrapolated past, so {@link readBuildingBonus} clamps to it rather than
 * trusting the raw number.
 */
export { GUILD_BUILDING_MAX_LEVEL };

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
 * Bonus a payout building grants per level.
 *
 * Confirmed against both in-game upgrade popups — "Level 10 → Level 11, Guild
 * Points: +20% → +22%" on the Builder's Hall and "Level 5 → Level 6, Guild Token
 * Rewards: +10% → +12%" on the Treasury — so the bonus is level × 0.02 on both,
 * and not a per-level step on top of a base. Pinned in `guild-trials-math.js`
 * beside the payout arithmetic that uses it, and re-exported here because this
 * is the file that resolves a building's level.
 *
 * This is the game's own rule rather than a guess, so it beats reporting the
 * bonus as unknown: a guild whose Builders Hall level reached the client is not
 * a guild whose Guild Points multiplier is a mystery. What remains genuinely
 * unknowable is the *level* — that only arrives on guild traffic — and that is
 * what the unknown case is now reserved for.
 */
export { BUILDING_BONUS_PER_LEVEL };

/**
 * Everything known about one payout-relevant building.
 *
 * `source` is what the panel needs to caption itself: `'manual'` when the player
 * typed the number in, `'client'` when the game's own detail map described the
 * building, `'formula'` when the level is known and the confirmed
 * 2%-per-level rule was applied to it, and `'unknown'` when not even the level
 * is — in which case `bonus` is null and the caller must show un-bonused figures
 * rather than treat it as zero.
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
    // Clamped to GUILD_BUILDING_MAX_LEVEL: buildings cap at 20 in-game, so
    // anything higher on the wire is bad data, not a level to trust or to
    // extrapolate the 2%-per-level formula past.
    const level = hrid ? Math.min(Number(levels[hrid]) || 0, GUILD_BUILDING_MAX_LEVEL) : 0;

    if (Number.isFinite(override) && override > 0) {
        return { hrid, level, bonus: override / 100, source: 'manual' };
    }

    const bonus = hrid ? buildingBonusFromDetail(details?.[hrid], level) : null;
    if (Number.isFinite(bonus)) return { hrid, level, bonus, source: 'client' };

    // The level is the hard part; once it is in hand the multiplier is arithmetic
    if (level > 0) return { hrid, level, bonus: level * BUILDING_BONUS_PER_LEVEL, source: 'formula' };

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
