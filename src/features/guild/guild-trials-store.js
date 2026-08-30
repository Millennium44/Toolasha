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
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import config from '../../core/config.js';
import {
    BUILDING_BONUS_PER_LEVEL,
    GUILD_BUILDING_MAX_LEVEL,
    isTrialName,
    MAX_TRIAL_NAME_CHARS,
    trialWeekStart,
} from './guild-trials-math.js';
import { isPlausibleReading } from './guild-trials-scrape.js';

/** Object store the records live in — shared with the guild XP history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the guild name is appended, as `guildXP_<name>` does */
const KEY_PREFIX = 'guildTrials';

/** Samples kept per tile. An hour of trial at one sample every five seconds is 720. */
export const MAX_SAMPLES = 800;

/**
 * Storage key for a guild's trial record.
 *
 * By guild name where it is known, because trial state belongs to the guild and
 * not to whichever alt happened to look at it — two characters in one guild are
 * two views of the same trial.
 *
 * Before the name is known the key falls back to the **character**, not to a
 * single shared bucket. That bucket was reported as a data leak and it is
 * exactly one: switching characters in the same tab left the previous guild's
 * finished trial on screen — "Guild Points banked 2,880" against a guild whose
 * own header read 0 — because both characters wrote to and read from
 * `guildTrials_default`. A per-character fallback cannot collide that way, and
 * the moment the guild's name arrives the record is merged onto the guild's key
 * as before.
 *
 * @param {string|null} guildName - Guild name, or null before it is known
 * @param {string|number|null} [characterId] - The viewing character, for the fallback key
 * @returns {string} Storage key
 */
export function guildTrialsStorageKey(guildName, characterId = null) {
    if (guildName) return `${KEY_PREFIX}_${guildName}`;
    return characterId === null || characterId === undefined
        ? `${KEY_PREFIX}_default`
        : `${KEY_PREFIX}_char_${characterId}`;
}

/**
 * The slot a character's own action stats live in, inside a tile.
 *
 * The record itself is keyed by guild and must stay that way — two characters
 * in one guild are two views of the same trial, and the samples, the tiers and
 * the points are the guild's. The footer's figures are not: Work Power and
 * Success Rate are the *reader's* own, and they were being merged field by
 * field into one shared `personal` block. Two alts in one guild overwrote each
 * other's every time either opened the tab, and the forecast — which fits a
 * success-rate decline across tiers from exactly these numbers — was fitting a
 * curve through two characters' readings at once. The provenance guard could
 * not see it: both records are the same guild's, which is all it checks.
 *
 * So the guild half stays shared and the personal half is split by character
 * underneath it.
 *
 * @param {string|number|null} [characterId] - The viewing character
 * @returns {string} Slot name inside `tile.personalByCharacter`
 */
export function personalSlot(characterId) {
    return characterId === null || characterId === undefined ? 'default' : String(characterId);
}

/** A plain object, or an empty one */
const asObject = (value) => (value && typeof value === 'object' ? value : {});

/**
 * One character's action stats off a tile.
 *
 * A tile written before the split carries its figures at the top level and has
 * no `personalByCharacter` at all; those are read as-is until somebody adopts
 * them ({@link adoptPersonalStats}), because a legacy record's personal half is
 * almost certainly the reader's own and dropping it would cost a forecast that
 * has been building all hour. Once the split exists, a character that is not in
 * it has no readings — which is the correct answer, not a gap to be filled from
 * somebody else's.
 *
 * @param {Object|null} tile - A stored tile
 * @param {string|number|null} [characterId] - The viewing character
 * @returns {{personal: Object, personalByTier: Object}} That character's figures
 */
export function tilePersonalStats(tile, characterId = null) {
    const byCharacter = tile?.personalByCharacter;
    if (byCharacter && typeof byCharacter === 'object') {
        const slice = asObject(byCharacter[personalSlot(characterId)]);
        return { personal: asObject(slice.personal), personalByTier: asObject(slice.personalByTier) };
    }
    return { personal: asObject(tile?.personal), personalByTier: asObject(tile?.personalByTier) };
}

/**
 * Move a tile's un-split figures under one character, once.
 *
 * Two sources are claimed: the top-level `personal`/`personalByTier` of a tile
 * written before the split, and the `default` slot a tile sampled before the
 * character's id was known wrote to. Both are claimed only by a character that
 * has no slot of its own yet — a character with its own readings has nothing to
 * inherit, and taking the shared block on top of them would be the original bug
 * running in the other direction.
 *
 * @param {Object} tile - A stored tile (not mutated)
 * @param {string|number|null} characterId - The viewing character
 * @returns {{tile: Object, changed: boolean}} The tile, and whether anything moved
 */
export function adoptTilePersonal(tile, characterId) {
    const slot = personalSlot(characterId);
    if (slot === 'default') return { tile, changed: false };

    const byCharacter = { ...asObject(tile?.personalByCharacter) };
    // A character with its own readings has nothing to inherit. The shared
    // block is left where it is rather than swept up, so the *other* character
    // in the guild can still claim it on its own first read
    if (byCharacter[slot]) return { tile, changed: false };

    const legacyPersonal = asObject(tile?.personal);
    const legacyByTier = asObject(tile?.personalByTier);
    const orphan = asObject(byCharacter.default);
    const populated = (block) =>
        Object.keys(asObject(block?.personal)).length > 0 || Object.keys(asObject(block?.personalByTier)).length > 0;
    if (!populated({ personal: legacyPersonal, personalByTier: legacyByTier }) && !populated(orphan)) {
        return { tile, changed: false };
    }

    byCharacter[slot] = {
        // The top-level block is the newer statement of the two: it is what
        // every build wrote last, `default` only ever held the pre-id window
        personal: { ...asObject(orphan.personal), ...legacyPersonal },
        personalByTier: { ...asObject(orphan.personalByTier), ...legacyByTier },
    };
    delete byCharacter.default;

    const adopted = { ...tile, personalByCharacter: byCharacter };
    delete adopted.personal;
    delete adopted.personalByTier;
    return { tile: adopted, changed: true };
}

/**
 * {@link adoptTilePersonal} across a record's live tiles.
 *
 * The archived cycles are deliberately left alone: they are a finished week's
 * figures nothing forecasts from, and re-attributing them would put a name on
 * numbers that never carried one.
 *
 * @param {Object} record - A stored record (not mutated)
 * @param {string|number|null} characterId - The viewing character
 * @returns {{record: Object, changed: boolean}} The record, and whether anything moved
 */
export function adoptPersonalStats(record, characterId) {
    if (personalSlot(characterId) === 'default') return { record, changed: false };

    const tiles = {};
    let changed = false;
    for (const [key, tile] of Object.entries(asObject(record?.tiles))) {
        const result = adoptTilePersonal(tile, characterId);
        tiles[key] = result.tile;
        changed = changed || result.changed;
    }
    return changed ? { record: { ...record, tiles }, changed } : { record, changed };
}

/**
 * An empty record for a week.
 * @param {number} weekStart - Week start, in ms
 * @param {Object} [provenance] - `{guildId, guildName}` the record belongs to
 * @returns {{weekStart: number, tiles: Object, guildId: string|null, guildName: string|null}} Fresh record
 */
export function emptyRecord(weekStart, { guildId = null, guildName = null } = {}) {
    return { weekStart, tiles: {}, guildId, guildName, history: [] };
}

/**
 * Whether a stored record can possibly belong to the guild now on screen.
 *
 * The reported failure this exists for: a character switched inside one tab
 * wrote the previous guild's trial into the shared fallback key, that record was
 * then adopted onto the *new* guild's own key, and every build since has
 * faithfully rendered a finished trial from a guild the player had left —
 * "banked 2,880" against a guild whose own header read 0. Keying the storage
 * correctly stops it happening again and does nothing at all about the copy
 * already on disk. Provenance is what lets the code throw that copy away.
 *
 * Three answers, and the third is the one that matters. A record that names a
 * different guild is `'foreign'` and is discarded outright. One that names this
 * guild is `'own'`. One that names no guild at all was written before this
 * field existed — `'unknown'`, which is not enough to discard on by itself but
 * is enough to *believe the game over the record* when the two disagree; see
 * the lifecycle check in `guild-trials.js`.
 *
 * @param {Object|null} record - A stored record
 * @param {Object} [context] - `{guildId, guildName}` as currently known
 * @returns {'own'|'foreign'|'unknown'} What the record's provenance says
 */
export function recordProvenance(record, { guildId = null, guildName = null } = {}) {
    const storedId = record?.guildId ?? null;
    const storedName = record?.guildName ?? null;
    if (!storedId && !storedName) return 'unknown';

    if (storedId && guildId) return String(storedId) === String(guildId) ? 'own' : 'foreign';
    if (storedName && guildName) {
        return String(storedName).toLowerCase() === String(guildName).toLowerCase() ? 'own' : 'foreign';
    }

    // The record knows which guild it belongs to and the page has not said yet.
    // Not foreign — that would throw away a correct record on every cold load
    // before the socket has spoken
    return 'unknown';
}

/**
 * Put this week's tiles away and start the next cycle empty.
 *
 * Archived rather than deleted: the figures were real when they were taken, and
 * a player who wants last cycle's numbers has nowhere else to get them. Bounded
 * to {@link MAX_ARCHIVED_CYCLES}, oldest dropped first.
 *
 * ## The accuracy fold
 *
 * `accuracy` is the compact per-trial attribution summary from
 * `guild-trial-accuracy.js`. It is folded in here because this is the last
 * moment the week's measured-vs-reported pairs are still readable: they live in
 * a week-guarded blob (see {@link loadTrialStats}) that the next cycle
 * discards, so an accuracy figure not carried into the archive is gone. Only
 * the medians, the worsts and the counts travel — never the per-player table,
 * which would multiply this record by the party size for a detail nobody reads
 * a month later.
 *
 * @param {Object} record - The record (not mutated)
 * @param {string} reason - Why the cycle was closed, for the archive entry
 * @param {number} [at] - Clock
 * @param {Object} [options] - Extras folded into the entry
 * @param {Object|null} [options.accuracy] - Compact per-trial accuracy, keyed by encounter
 * @returns {Object} The record with its tiles moved into `history`
 */
export function archiveCycle(record, reason, at = Date.now(), { accuracy = null } = {}) {
    const tiles = record?.tiles && typeof record.tiles === 'object' ? record.tiles : {};
    const history = Array.isArray(record?.history) ? [...record.history] : [];

    if (Object.keys(tiles).length) {
        const entry = { archivedAt: at, reason, weekStart: record?.weekStart ?? null, tiles };
        // Additive: written only when there is something to write, so an entry
        // with no `accuracy` key is an archive from before this existed rather
        // than a cycle that attributed nothing. `archivedAccuracyTrend` keeps
        // those two apart and says "no accuracy data" for the former
        if (accuracy && typeof accuracy === 'object' && Object.keys(accuracy).length) entry.accuracy = accuracy;
        history.push(entry);
    }

    return {
        ...record,
        weekStart: record?.weekStart ?? trialWeekStart(at),
        tiles: {},
        history: history.slice(-MAX_ARCHIVED_CYCLES),
    };
}

/** How many finished cycles are kept beside the live one */
export const MAX_ARCHIVED_CYCLES = 4;

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
 * @param {string|number|null} [characterId] - Whose footer the personal figures were read off
 * @returns {Object} The updated record
 */
export function recordTileSample(record, tile, at, characterId = null) {
    const weekStart = record?.weekStart ?? trialWeekStart(at);
    const tiles = { ...(record?.tiles || {}) };
    const key = tileKey(tile);
    // The sampling character claims an un-split tile's figures on its way past,
    // so a record that reaches here without having been adopted on load does
    // not strand them
    const existing = adoptTilePersonal(
        tiles[key] || { name: tile?.name || '', kind: tile?.kind || 'skilling', samples: [], tiers: [] },
        characterId
    ).tile;

    const readings = tile?.readings || [];
    const samples = existing.samples.filter((sample) => sample?.t !== at);
    if (readings.length) samples.push({ t: at, readings: readings.map((reading) => ({ ...reading })) });
    samples.sort((a, b) => a.t - b.t);

    // A timestamped series of the card's stated *total points*, kept even when no
    // progress bar is present. A trial this character did not join never sends a
    // bar reading, so `samples` above stays empty and no rate can be fitted — but
    // the Trials tab still states the running total, and watching that total tick
    // up across refreshes is a loose fill rate for a trial you are not in. Only
    // the Trials card carries points; the In Progress card does not, so a reading
    // without one must not erase the series.
    const pointSamples = (existing.pointSamples || []).filter((sample) => sample?.t !== at);
    if (Number.isFinite(tile?.points)) pointSamples.push({ t: at, points: tile.points });
    pointSamples.sort((a, b) => a.t - b.t);

    // The tier the reading belongs to may have come from the *other* tab: the In
    // Progress card carries a total and no tier, the Trials card carries a tier
    // and no total, and a tier observation needs both. Taking the tier already
    // on the record is what lets the growth curve be fitted at all — requiring
    // one card to carry both means no observation is ever recorded.
    const tier = Number.isFinite(tile?.tier) ? tile.tier : existing.tier;

    // Which tier the *reading* belongs to, which is not the tier the card is
    // badged with. The badge counts tiers finished, so a live pool on a card
    // badged T2 is T3's pool — filing it under the badge put two different
    // tiers' pool sizes under one number and broke the ladder that is fitted
    // from them. The caller says so explicitly rather than this file guessing.
    const observationTier = Number.isFinite(tile?.readingTier) ? tile.readingTier : tier;

    // Which tier the footer's stats describe. Stated by the caller when it can —
    // the stats are read on a live card, a card between tiers and a completed
    // card alike, and only the first of those has a reading tier at all. Riding
    // on `observationTier` meant a skilling trial's whole run of Success Rate
    // readings landed in the flat `personal` and nothing in `personalByTier`.
    const personalTier = Number.isFinite(tile?.personalTier) ? tile.personalTier : observationTier;
    const personalSlotKey = personalSlot(characterId);
    const mine = asObject(existing.personalByCharacter?.[personalSlotKey]);
    const tiers = [...(existing.tiers || [])];
    if (Number.isFinite(observationTier)) {
        for (const reading of readings) {
            if (!(reading.max > 0)) continue;
            const seen = tiers.find((entry) => entry.tier === observationTier && entry.total === reading.max);
            if (!seen) tiers.push({ tier: observationTier, total: reading.max });
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

    // When each tier badge was *watched appearing*, which is the only rate
    // signal a trial nobody here joined ever gives. The card's stated points
    // are a step function — flat between tiers, a jump at each one — so fitting
    // a rate across them measured nothing; the badge moving is a timestamped
    // event, and the pool behind it has a known size.
    //
    // Only a badge seen to *move* is written. A card first opened already
    // reading T16 says nothing about when T16 banked — possibly an hour before
    // this tab opened — and pairing that timestamp with the next badge measures
    // a slice of the real interval and reports a rate several times too high.
    // So the first sighting only establishes where the card is, and the clock
    // starts at the next transition.
    const tierSeenAt = { ...(existing.tierSeenAt || {}) };
    if (
        Number.isFinite(tile?.tier) &&
        Number.isFinite(existing.tier) &&
        tile.tier > existing.tier &&
        !Number.isFinite(tierSeenAt[tile.tier])
    ) {
        tierSeenAt[tile.tier] = at;
    }

    tiles[key] = {
        name: tile?.name || existing.name,
        kind: tile?.kind || existing.kind,
        level: Number.isFinite(tile?.level) ? tile.level : existing.level,
        tier: Number.isFinite(tile?.tier) ? tile.tier : existing.tier,
        // The tier the socket stated for the trial *in progress*
        // (`guild_skilling_updated.tier`), kept apart from `tier` because the
        // two count different things: the badge counts tiers finished. Without
        // this the socket's own statement reached the observation filing and
        // never the analysis, and the panel said "tier not known yet" over a
        // stream that was stating the tier several times a second.
        liveTier: Number.isFinite(tile?.socketTier) ? tile.socketTier : existing.liveTier,
        // …and the pool target it was stated with, written as a pair: the
        // statement expires the moment the bar's target moves on to the next
        // tier's, and without this a `liveTier` persisted early in a trial
        // outranked the bar for the rest of the hour — "Banked 8 tiers" over a
        // bar only T15 produces. An update that states a tier without a pool
        // clears the target rather than inheriting one from another tier.
        liveTierTarget: Number.isFinite(tile?.socketTier)
            ? Number.isFinite(tile?.socketTierTarget)
                ? tile.socketTierTarget
                : null
            : existing.liveTierTarget,
        // Both come off the Trials tab and are absent from the In Progress one,
        // so a card that does not carry them must not erase what the other tab
        // already said
        points: Number.isFinite(tile?.points) ? tile.points : existing.points,
        // Sticky: a finished trial does not become unfinished, and the In
        // Progress card that carries the reading does not carry the word
        completed: Boolean(tile?.completed) || Boolean(existing.completed),
        // The reader's own action stats, from the In Progress footer, filed
        // under the character that read them — see {@link personalSlot}. Merged
        // rather than replaced: the footer shows what it shows, and a redraw
        // that omits one stat is not the stat going away. Kept per tier as
        // well, because they are not constant across one: the same character's
        // success rate fell eight points a tier through a watched trial, which
        // is a thing the forecast has to model rather than a reading it can
        // overwrite
        personalByCharacter: {
            ...(existing.personalByCharacter || {}),
            [personalSlotKey]: {
                personal: { ...(mine.personal || {}), ...(tile?.personal || {}) },
                personalByTier: {
                    ...(mine.personalByTier || {}),
                    ...(Number.isFinite(personalTier) && tile?.personal && Object.keys(tile.personal).length
                        ? { [personalTier]: { ...(mine.personalByTier?.[personalTier] || {}), ...tile.personal } }
                        : {}),
                },
            },
        },
        signups: tile?.signups || existing.signups || null,
        pointsByTier,
        tierSeenAt,
        samples: samples.slice(-MAX_SAMPLES),
        pointSamples: pointSamples.slice(-MAX_SAMPLES),
        tiers,
    };

    // Everything else on the record is carried through: a sample must not strip
    // the provenance stamp or the archived cycles off it, which is a thing this
    // returned-a-fresh-object shape did quietly for both
    return { ...(record || {}), weekStart, tiles };
}

/**
 * Carry an un-split tile's top-level figures through a merge, when there are
 * any. Omitted entirely otherwise, so a split tile never grows an empty legacy
 * block for {@link adoptTilePersonal} to trip over.
 * @param {Object} staler - The older side
 * @param {Object} fresher - The newer side
 * @returns {{personal?: Object, personalByTier?: Object}} Fields to spread onto the merged tile
 */
function mergeLegacyPersonal(staler, fresher) {
    const personal = { ...asObject(staler?.personal), ...asObject(fresher?.personal) };
    const personalByTier = { ...asObject(staler?.personalByTier), ...asObject(fresher?.personalByTier) };
    const merged = {};
    if (Object.keys(personal).length) merged.personal = personal;
    if (Object.keys(personalByTier).length) merged.personalByTier = personalByTier;
    return merged;
}

/**
 * Union two tiles' per-character figures, one character at a time.
 * @param {Object} staler - The older side
 * @param {Object} fresher - The newer side
 * @returns {Object} One `personalByCharacter` map
 */
function mergePersonalByCharacter(staler, fresher) {
    const a = asObject(staler?.personalByCharacter);
    const b = asObject(fresher?.personalByCharacter);
    const merged = {};
    for (const slot of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const older = asObject(a[slot]);
        const newer = asObject(b[slot]);
        merged[slot] = {
            personal: { ...asObject(older.personal), ...asObject(newer.personal) },
            personalByTier: { ...asObject(older.personalByTier), ...asObject(newer.personalByTier) },
        };
    }
    return merged;
}

/**
 * Union two tier-clear timestamp maps, keeping the earlier sighting of each.
 * @param {Object} [a] - One side's `tierSeenAt`
 * @param {Object} [b] - The other side's
 * @returns {Object} One map
 */
function mergeTierSeenAt(a, b) {
    const merged = {};
    for (const source of [a, b]) {
        for (const [tier, at] of Object.entries(source || {})) {
            const when = Number(at);
            if (!Number.isFinite(when)) continue;
            const held = Number(merged[tier]);
            merged[tier] = Number.isFinite(held) ? Math.min(held, when) : when;
        }
    }
    return merged;
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

    // Whole-record wins carry their archive and provenance with them: a record
    // that has just archived a cycle is mostly its history, and the save that
    // merges it over last week's stored copy must not strip that off
    const whole = (record) => ({
        weekStart: record.weekStart,
        tiles: record.tiles || {},
        guildId: record.guildId ?? null,
        guildName: record.guildName ?? null,
        history: Array.isArray(record.history) ? record.history : [],
    });
    if (baseWeek === null) return incoming ? whole(incoming) : emptyRecord(0);
    if (incomingWeek === null) return whole(base);
    if (baseWeek !== incomingWeek) return whole(baseWeek > incomingWeek ? base : incoming);

    // Archived cycles unioned, not concatenated: both sides usually hold the
    // same cycles, and doubling them up would push the oldest past the cap
    const history = [];
    const seenCycles = new Set();
    for (const cycle of [...(base.history || []), ...(incoming.history || [])]) {
        if (!cycle) continue;
        const mark = `${cycle.archivedAt ?? ''}:${cycle.weekStart ?? ''}:${cycle.reason ?? ''}`;
        if (seenCycles.has(mark)) continue;
        seenCycles.add(mark);
        history.push(cycle);
    }
    const provenance = {
        guildId: base.guildId ?? incoming.guildId ?? null,
        guildName: base.guildName ?? incoming.guildName ?? null,
        history: history.slice(-MAX_ARCHIVED_CYCLES),
    };
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

        const byPointTime = new Map();
        for (const sample of [...(existing.pointSamples || []), ...(tile.pointSamples || [])]) {
            if (Number.isFinite(sample?.t)) byPointTime.set(sample.t, sample);
        }
        const pointSamples = [...byPointTime.values()].sort((a, b) => a.t - b.t).slice(-MAX_SAMPLES);

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
            completed: Boolean(existing.completed) || Boolean(tile.completed),
            // Per character, slot by slot: merging the two sides' blocks flat
            // is what this file's split exists to stop. An un-split side keeps
            // its top-level copy through the merge rather than being folded
            // into anybody's slot — the merge does not know whose it is, and
            // the next load by a character without one will claim it
            ...mergeLegacyPersonal(staler, fresher),
            personalByCharacter: mergePersonalByCharacter(staler, fresher),
            level: Number.isFinite(fresher.level) ? fresher.level : existing.level,
            tier: Number.isFinite(fresher.tier) ? fresher.tier : existing.tier,
            // Both halves of the socket statement travel together: a liveTier
            // paired with another record's target would defeat the staleness
            // check that the pairing exists for
            liveTier: Number.isFinite(fresher.liveTier) ? fresher.liveTier : staler.liveTier,
            liveTierTarget: Number.isFinite(fresher.liveTier) ? fresher.liveTierTarget : staler.liveTierTarget,
            // Carried across rather than dropped. Both come off the Trials tab
            // and only ever off the Trials tab, and the merge that runs when the
            // guild's name arrives happens on a record built from whichever tab
            // was open — so dropping them here erased the sign-up count and the
            // game's stated points on the first render of every session, which
            // is exactly the data the payout block was found showing as zero.
            points: Number.isFinite(fresher.points) ? fresher.points : staler.points,
            signups: fresher.signups || staler.signups || null,
            pointsByTier: { ...(staler.pointsByTier || {}), ...(fresher.pointsByTier || {}) },
            // Both sides' tier-clear timestamps, earliest wins. Two records of
            // one week are two views of the same badges, and the merge that
            // runs when the guild's name arrives must not drop the half that
            // was written under `default` — that is a measured interval gone,
            // and with only a handful ever taken losing one is losing the model.
            // Earliest rather than freshest because a later sighting of the same
            // badge is the same clear seen again, and the first one is closest
            // to when it actually happened.
            tierSeenAt: mergeTierSeenAt(existing.tierSeenAt, tile.tierSeenAt),
            samples,
            pointSamples,
            tiers,
        };
    }

    // A live tile that one side has already put away is the archived tile seen
    // from a copy that had not archived yet — a stale tab's, or one written
    // before this side's archive landed. It is not brought back to life; the
    // archive holds it. Only a tile with nothing newer than its archived copy
    // is dropped, so a genuinely new trial under the same key survives.
    const newestOf = (tile) => tile?.samples?.[tile.samples.length - 1]?.t ?? 0;
    for (const cycle of provenance.history) {
        for (const [key, archived] of Object.entries(cycle?.tiles || {})) {
            if (tiles[key] && newestOf(tiles[key]) <= newestOf(archived)) delete tiles[key];
        }
    }

    return { weekStart: baseWeek, tiles, ...provenance };
}

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE_NAME,
    // `guildTrials_<guild>` and its per-character fallbacks, but NOT the
    // sibling keys built without the underscore (`guildTrialsRoster` and
    // friends), which are caches rather than history
    prefix: `${KEY_PREFIX}_`,
    merge: mergeTrialRecords,
    label: 'Guild trial records',
});

/**
 * Read a guild's record, discarding one from a previous week.
 *
 * "Absent" and "unreadable" are different answers. No record, or last week's,
 * is a fresh week and says so; a read that could not be made (the connection
 * dropped, the transaction failed) is `null`, and the caller keeps whatever it
 * holds in memory rather than starting the week over — a fresh record taken
 * for the truth and then written back is how a week of samples used to vanish.
 * @param {string|null} guildName - Guild name
 * @param {number} [now] - Clock, in ms
 * @param {string|number|null} [characterId] - The viewing character, for the fallback key
 * @returns {Promise<Object|null>} The record, a fresh one when absent, or null when the read cannot be trusted
 */
export async function loadTrialRecord(guildName, now = Date.now(), characterId = null, { guildId = null } = {}) {
    const weekStart = trialWeekStart(now);
    const fresh = () => emptyRecord(weekStart, { guildId, guildName });

    try {
        const probe = await storage.tryGet(guildTrialsStorageKey(guildName, characterId), STORE_NAME);
        if (probe === null) {
            console.warn('[GuildTrialsStore] The trial record could not be read; keeping the in-memory copy');
            return null;
        }
        const record = probe.found ? probe.value : null;
        if (!record || typeof record !== 'object') return fresh();

        // A record from a previous week is last week's ladder, not this one's
        if (record.weekStart !== weekStart) return fresh();

        // A record that names another guild cannot be this guild's, whatever key
        // it was filed under — which is exactly how the reported one survived
        if (recordProvenance(record, { guildId, guildName }) === 'foreign') {
            console.warn('[GuildTrialsStore] Discarding a trial record belonging to another guild');
            return fresh();
        }

        // Self-heal on the way in. What is already stored was written by an
        // older build with a looser card filter, and a filter fixed today does
        // nothing about a notice board that is already on disk being sampled,
        // exported and paid out every week from now on
        const cleaned = purgeJunkTiles({
            weekStart: record.weekStart,
            tiles: record.tiles || {},
            history: Array.isArray(record.history) ? record.history : [],
            guildId: record.guildId ?? guildId,
            guildName: record.guildName ?? guildName,
        });

        // The other half of the way in: a record written before the personal
        // figures were split by character carries them at the top level, and
        // they are almost certainly this reader's — nobody else has opened the
        // tab in this build. Handing them to the first character to read them
        // keeps the forecast it has been building all hour; leaving them shared
        // is the bug. A character that already has its own slot inherits
        // nothing, so the second alt through does not take the first one's.
        const adopted = adoptPersonalStats(cleaned.record, characterId);

        if (cleaned.purged.length || adopted.changed) {
            if (cleaned.purged.length) {
                console.warn(
                    '[GuildTrialsStore] Dropping stored tiles that are not trials:',
                    cleaned.purged.join(', ')
                );
            }
            // As-is: the record was read a moment ago, and the heal is meant to
            // lose tiles a merge would bring straight back
            await saveTrialRecord(guildName, adopted.record, characterId, { guildId, overwrite: true });
        }
        return adopted.record;
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to load trial samples:', error);
        return null;
    }
}

/**
 * One save at a time per key, in order. Two interleaved read-merge-writes to
 * the same key could each miss what the other merged in.
 * @type {Map<string, Promise<boolean>>}
 */
const saveChains = new Map();

/**
 * Re-read a key, fold what is stored under the value in hand, and write.
 *
 * The write is refused when the read cannot be trusted — a blind write from a
 * copy that may be missing everything is precisely the accident this exists to
 * prevent — and the caller's next save retries. The probe is a single key read,
 * which is what makes it cheap enough for the five-second sampler.
 * @param {string} key - Storage key
 * @param {*} value - The in-memory value
 * @param {function(*, *): *} merge - `(stored, memory) → merged`, memory winning
 * @param {Object} [options]
 * @param {boolean} [options.overwrite=false] - Write as-is; for intentional losses only
 * @returns {Promise<boolean>} Whether the write was queued
 */
function probeMergeWrite(key, value, merge, { overwrite = false } = {}) {
    const run = async () => {
        try {
            let toWrite = value;
            if (!overwrite) {
                const probe = await storage.tryGet(key, STORE_NAME);
                if (probe === null) {
                    console.warn(`[GuildTrialsStore] ${key} not saved: storage could not be read first`);
                    return false;
                }
                if (probe.found && probe.value && typeof probe.value === 'object') {
                    toWrite = merge(probe.value, value);
                }
            }
            await storage.set(key, toWrite, STORE_NAME);
            return true;
        } catch (error) {
            console.error(`[GuildTrialsStore] Failed to save ${key}:`, error);
            return false;
        }
    };
    const chain = (saveChains.get(key) || Promise.resolve()).then(run, run);
    saveChains.set(key, chain);
    return chain;
}

/**
 * Delete the legacy shared record.
 *
 * `guildTrials_default` was one bucket for every character in the tab, which is
 * the bug two of these fixes exist for. Nothing writes to it any more; this
 * removes what is left so it cannot be adopted onto a guild's key by an older
 * build's leftovers.
 *
 * @returns {Promise<boolean>} True when the key was removed or already absent
 */
export async function purgeLegacyTrialRecord() {
    try {
        await storage.delete(`${KEY_PREFIX}_default`, STORE_NAME);
        return true;
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to purge the legacy trial record:', error);
        return false;
    }
}

/**
 * How a stored tile is shown not to be a trial.
 *
 * The rules the scrape now applies at read time, applied again to what is
 * already written down. A guild's **notice board** became a tile on a live
 * client — key
 * `skilling::[braille art]\nWelcome to Creamland!\n\nJOIN DISCORD: …`, 987
 * characters of it — because two Discord channel ids in the text have exactly
 * the shape of a progress bar:
 *
 * ```
 * https://discord.com/channels/1234500000000000001/1525000000000000321
 * ```
 *
 * It was then sampled every five seconds, the Overview tab's guild statistics
 * were attached to it as the player's own action stats, and it was live enough
 * to start the recorder — the session in that export reads `startedBy:
 * "tab-reading"`. None of that is fixed by a filter that only runs on new cards.
 *
 * @param {Object} tile - A stored tile
 * @param {string} key - The key it is filed under
 * @returns {boolean} True when it must not be kept
 */
export function isJunkTile(tile, key = '') {
    const name = String(tile?.name ?? '');
    if (!isTrialName(name)) return true;
    // The key is derived from the name, so a key the name would not produce is a
    // record written before the name was checked at all
    if (/[\r\n]/.test(String(key)) || String(key).length > MAX_TRIAL_NAME_CHARS + 16) return true;

    return (tile?.samples || []).some((sample) =>
        (sample?.readings || []).some((reading) => !isPlausibleReading(reading?.current, reading?.max))
    );
}

/**
 * Drop stored tiles that are not trials, and say which went.
 *
 * The same one-time, self-healing shape the monster-loadout purge uses: the
 * record comes back untouched — the same object — when there is nothing to
 * purge, so a caller can tell whether a write is needed.
 *
 * `history` is cleaned too. An archived cycle carrying a notice board is an
 * export full of it and a payout computed from it, a week after the fact.
 *
 * @param {Object|null} record - A stored record
 * @returns {{record: Object|null, purged: string[]}} The clean record and what left
 */
export function purgeJunkTiles(record) {
    if (!record || typeof record !== 'object') return { record, purged: [] };

    const purged = [];
    const clean = (tiles) => {
        const kept = {};
        for (const [key, tile] of Object.entries(tiles || {})) {
            if (isJunkTile(tile, key)) {
                // One short line of it, so a log line stays a log line
                purged.push(
                    `${String(tile?.name ?? key)
                        .slice(0, 40)
                        .replace(/\s+/g, ' ')}…`
                );
                continue;
            }
            kept[key] = tile;
        }
        return kept;
    };

    const tiles = clean(record.tiles);
    const history = Array.isArray(record.history)
        ? record.history.map((cycle) => (cycle?.tiles ? { ...cycle, tiles: clean(cycle.tiles) } : cycle))
        : record.history;

    if (!purged.length) return { record, purged };
    return { record: { ...record, tiles, history }, purged };
}

/**
 * Delete every trial record and session this script has stored.
 *
 * The escape hatch. Everything above heals itself on the next render, and this
 * is here for the case where it does not — one call, no arguments, and the
 * feature rebuilds from the panel within a sampler tick.
 *
 * Only the trial keys: `guildHistory` is shared with the guild XP history, which
 * is months of data and nothing to do with trials.
 *
 * @returns {Promise<{removed: string[]}>} Which keys went
 */
export async function clearTrialStorage() {
    const removed = [];
    try {
        const keys = await storage.getAllKeys(STORE_NAME);
        for (const key of keys || []) {
            const name = String(key);
            if (!name.startsWith(KEY_PREFIX) && !name.startsWith('guildTrialSession')) continue;
            await storage.delete(name, STORE_NAME);
            removed.push(name);
        }
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to clear trial storage:', error);
    }
    return { removed };
}

/**
 * Write a guild's record.
 *
 * What is stored is re-read and folded under the record in hand first
 * ({@link mergeTrialRecords}: samples unioned, the fresher tile's identity
 * standing), so samples another tab took, or that were written before a read
 * failed, survive; and the write is refused outright when storage cannot be
 * read. Writes to one key run in order.
 * @param {string|null} guildName - Guild name
 * @param {Object} record - The record
 * @param {string|number|null} [characterId] - The viewing character, for the fallback key
 * @param {Object} [options]
 * @param {boolean} [options.overwrite=false] - Write the record as-is. For the
 *   one write that is meant to lose tiles: archiving a finished cycle.
 * @returns {Promise<boolean>} True when the write was queued
 */
export async function saveTrialRecord(
    guildName,
    record,
    characterId = null,
    { guildId = null, overwrite = false } = {}
) {
    // Stamped on the way out, so the next session can tell whose it is
    const stamped = {
        ...record,
        guildId: record?.guildId ?? guildId ?? null,
        guildName: record?.guildName ?? guildName ?? null,
    };
    const fold = (stored, memory) => {
        const merged = mergeTrialRecords(stored, memory);
        return {
            ...merged,
            guildId: merged.guildId ?? stamped.guildId,
            guildName: merged.guildName ?? stamped.guildName,
        };
    };
    return probeMergeWrite(guildTrialsStorageKey(guildName, characterId), stamped, fold, { overwrite });
}

// ─── Learned work bases ─────────────────────────────────────────────────────

/**
 * The key the learned per-skill work bases live under.
 *
 * Deliberately **not** scoped by guild or character, unlike the trial records
 * above, and the exception is earned rather than an oversight: a skill's base
 * work is a property of the game's ladder, not of anyone's guild. The crafting
 * base of 40,000 is confirmed across two different guilds — 49,920 with 4
 * participants at T3 in one, 88,920 with 17 at T10 in another, both exactly
 * `40,000 × (1 + 0.1 × (tier − 1)) × (1 + 0.01 × participants)` — so a base
 * learned watching one guild's trial is precisely what identifies the tier in
 * the next guild's. Scoping it would relearn a constant per guild and leave a
 * mid-trial join blind in every guild the player had not taught it in yet.
 *
 * Still under the `guildTrials` prefix, so {@link clearTrialStorage} — the
 * escape hatch — takes it with everything else.
 */
const WORK_BASES_KEY = `${KEY_PREFIX}WorkBases`;

/**
 * The learned first-tier work per skill.
 * @returns {Promise<Object<string, {baseWork: number, tier: number, target: number,
 *   participants: number, learnedAt: number}>>} Skill key (`crafting`) → what was learned
 */
export async function loadWorkBases() {
    try {
        const held = await storage.get(WORK_BASES_KEY, STORE_NAME, null);
        return held && typeof held === 'object' && !Array.isArray(held) ? held : {};
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to load the learned work bases:', error);
        return {};
    }
}

/**
 * Write the learned work bases down.
 * @param {Object} bases - The map {@link loadWorkBases} returns
 * @returns {Promise<boolean>} True when the write was queued
 */
export async function saveWorkBases(bases) {
    // Stored under memory, per skill: a base another tab learned is kept
    return probeMergeWrite(WORK_BASES_KEY, bases || {}, (stored, memory) => ({ ...stored, ...memory }));
}

// ─── The spectated fight's roster ───────────────────────────────────────────

/**
 * The key the last-seen trial fight roster lives under.
 *
 * `new_guild_battle` states the party in slot order — the join every
 * spectated tick's `pMap` indexes into — and it fires once per tier and never
 * again. A page refresh mid-tier therefore lost every name until the next
 * tier began: "Player 2" and "Player 3" on a leaderboard whose names had been
 * on the wire minutes earlier. The roster is written down with the battle id
 * it belongs to, and a refreshed session adopts it back the moment the stream
 * shows the same battle id — the id is the guard, so another fight's roster
 * can never be borrowed.
 *
 * Under the `guildTrials` prefix, so {@link clearTrialStorage} takes it too.
 */
const ROSTER_KEY = `${KEY_PREFIX}Roster`;

/**
 * The last trial fight roster written down.
 * @returns {Promise<{battleId: *, roster: Object, at: number}|null>} The entry, or null
 */
export async function loadTrialRoster() {
    try {
        const held = await storage.get(ROSTER_KEY, STORE_NAME, null);
        if (!held || typeof held !== 'object') return null;
        if (!held.roster || typeof held.roster !== 'object') return null;
        return held;
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to load the trial roster:', error);
        return null;
    }
}

/**
 * Write a trial fight's roster down, keyed to its battle.
 * @param {{battleId: *, roster: Object, at: number}} entry - The roster and whose fight it is
 * @returns {Promise<boolean>} True when the write was queued
 */
export async function saveTrialRoster(entry) {
    // The roster in hand is the fight on screen; the stored one only fills
    // fields it does not state. Refused, not written blind, when storage
    // cannot be read
    return probeMergeWrite(ROSTER_KEY, entry, (stored, memory) => ({ ...stored, ...memory }));
}

// ─── Measured-vs-reported trial stats ───────────────────────────────────────

/**
 * Where the week's measured-vs-game-reported comparison is kept.
 *
 * Under the `guildTrials` prefix, so {@link clearTrialStorage} takes it too, and
 * week-guarded on the way in exactly as {@link loadTrialRecord} is: a blob from a
 * previous week is last week's trial, and the comparison resets with the ladder.
 */
const STATS_KEY = `${KEY_PREFIX}Stats`;

/**
 * Read the week's saved measured-vs-reported trial stats.
 * @param {number} [now=Date.now()] - Clock, in ms
 * @returns {Promise<{weekStart: number, trials: Object}>} The blob, or a fresh one
 */
export async function loadTrialStats(now = Date.now()) {
    const weekStart = trialWeekStart(now);
    const fresh = { weekStart, trials: {} };
    try {
        const held = await storage.get(STATS_KEY, STORE_NAME, null);
        if (!held || typeof held !== 'object' || held.weekStart !== weekStart) return fresh;
        return { weekStart, trials: held.trials && typeof held.trials === 'object' ? held.trials : {} };
    } catch (error) {
        console.error('[GuildTrialsStore] Failed to load trial stats:', error);
        return fresh;
    }
}

/**
 * Write the week's measured-vs-reported trial stats.
 * @param {{weekStart: number, trials: Object}} blob - The comparison, keyed by encounter
 * @returns {Promise<boolean>} True when the write was queued
 */
export async function saveTrialStats(blob) {
    // Same week: the encounters are unioned, this copy's winning; another
    // week's stored blob is last week's trial and the new one replaces it
    const fold = (stored, memory) =>
        stored?.weekStart === memory?.weekStart
            ? { ...stored, ...memory, trials: { ...(stored.trials || {}), ...(memory.trials || {}) } }
            : memory;
    return probeMergeWrite(STATS_KEY, blob, fold);
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
    archives: /archives/,
    skillingEncampment: /skillingencampment/,
    combatEncampment: /combatencampment/,
};

/** Client-data maps that might describe guild buildings, most likely first */
const DETAIL_MAP_KEYS = ['guildBuildingDetailMap', 'guildBuildingDetailDict', 'guildShrineDetailMap'];

/**
 * The per-level fields the game's own building entries carry.
 *
 * Read out of `initClientData` by the player and confirmed against the two
 * upgrade popups this file already quotes: the Builder's Hall entry carries
 * `guildPointsBonusPerLevel: 0.02` and the Treasury `guildTokenBonusPerLevel:
 * 0.02`. Each entry carries only its own, so "whichever of these is present" is
 * unambiguous and no caller has to say which building it is holding.
 *
 * Reading them beats the constant: it is the same number today, and it is
 * whatever the number becomes after a rebalance.
 */
const PER_LEVEL_FIELDS = ['guildPointsBonusPerLevel', 'guildTokenBonusPerLevel', 'guildExperienceBonusPerLevel'];

/** Remembered once found: `initClientData` is large and its shape does not change mid-session */
let detailMapKey = null;

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

    // The game's own per-level figure first, where the entry carries one
    for (const field of PER_LEVEL_FIELDS) {
        const perLevel = Number(detail[field]);
        if (Number.isFinite(perLevel)) return perLevel * level;
    }

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
 * @returns {{hrid: string|null, level: number, bonus: number|null, source: string,
 *   rules: {bonusPerLevel: number, maxLevel: number, source: string}}} What is known
 */
export function readBuildingBonus({ pattern, override = null, levelMap, detailMap }) {
    const levels = levelMap || dataManager.guildBuildingLevelMap || {};
    const details = detailMap || probeBuildingDetailMap();

    const rules = readBuildingRules(pattern, { levelMap: levels, detailMap: details });
    const hrid = findBuildingHrid(levels, pattern);
    // Clamped to the building's own cap — 20 in the game's data — so anything
    // higher on the wire is bad data, not a level to trust or to extrapolate the
    // per-level rule past.
    const level = hrid ? Math.min(Number(levels[hrid]) || 0, rules.maxLevel) : 0;

    if (Number.isFinite(override) && override > 0) {
        return { hrid, level, bonus: override / 100, source: 'manual', rules };
    }

    const bonus = hrid ? buildingBonusFromDetail(details?.[hrid], level) : null;
    if (Number.isFinite(bonus)) return { hrid, level, bonus, source: 'client', rules };

    // The level is the hard part; once it is in hand the multiplier is arithmetic
    if (level > 0) return { hrid, level, bonus: level * rules.bonusPerLevel, source: 'formula', rules };

    return { hrid, level, bonus: null, source: 'unknown', rules };
}

/**
 * The client-data map describing guild buildings, whichever it is called.
 * @returns {Object} The map, or an empty object
 */
export function probeBuildingDetailMap() {
    const clientData = dataManager.getInitClientData?.() || {};

    if (detailMapKey && isBuildingDetailMap(clientData[detailMapKey])) return clientData[detailMapKey];

    for (const key of DETAIL_MAP_KEYS) {
        const candidate = clientData[key];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            detailMapKey = key;
            return candidate;
        }
    }

    // Named guesses exhausted. Rather than give up on a map that is provably
    // there — the player read it out of `initClientData` — find it by what it
    // contains: entries keyed `/guild_buildings/<name>` carrying the per-level
    // fields above. A renamed map then costs nothing.
    for (const [key, value] of Object.entries(clientData)) {
        if (!isBuildingDetailMap(value)) continue;
        detailMapKey = key;
        return value;
    }

    return {};
}

/**
 * Whether a client-data value looks like the guild building detail map.
 * @param {*} value - A candidate
 * @returns {boolean} True when it is one
 */
function isBuildingDetailMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    for (const [hrid, entry] of Object.entries(value)) {
        if (!entry || typeof entry !== 'object') continue;
        if (PER_LEVEL_FIELDS.some((field) => Number.isFinite(Number(entry[field])))) return true;
        if (/^\/guild_buildings?\//.test(hrid) && Number.isFinite(Number(entry.maxLevel))) return true;
    }
    return false;
}

/**
 * The rules a building runs on, from the game's own data where it has them.
 *
 * Both figures are confirmed twice over — `guildPointsBonusPerLevel: 0.02` and
 * `maxLevel: 20` in client data, and the upgrade popups that quote the same
 * numbers back — so this is not a probe for something unverified. It exists so
 * that a rebalance changes the panel rather than making it quietly wrong, and it
 * falls back to the constants when there is no client data to read, which is the
 * state every test and every pre-login moment is in.
 *
 * @param {RegExp} pattern - One of {@link BUILDING_PATTERNS}
 * @param {Object} [options] - Overrides, for tests
 * @param {Object} [options.levelMap] - `guildBuildingLevelMap`
 * @param {Object} [options.detailMap] - Building detail map
 * @returns {{bonusPerLevel: number, maxLevel: number, source: 'client'|'constant'}} The rules
 */
export function readBuildingRules(pattern, { levelMap, detailMap } = {}) {
    const levels = levelMap || dataManager.guildBuildingLevelMap || {};
    const details = detailMap || probeBuildingDetailMap();

    // By level map first, because that is the spelling this guild's own data
    // uses; by the detail map's own keys when the guild has never built one
    const hrid = findBuildingHrid(levels, pattern) || findBuildingHrid(details, pattern) || null;
    const entry = hrid ? details?.[hrid] : null;

    const perLevel = PER_LEVEL_FIELDS.map((field) => Number(entry?.[field])).find((value) => Number.isFinite(value));
    const maxLevel = Number(entry?.maxLevel);

    return {
        bonusPerLevel: Number.isFinite(perLevel) ? perLevel : BUILDING_BONUS_PER_LEVEL,
        maxLevel: Number.isFinite(maxLevel) && maxLevel > 0 ? maxLevel : GUILD_BUILDING_MAX_LEVEL,
        source: Number.isFinite(perLevel) ? 'client' : 'constant',
    };
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
