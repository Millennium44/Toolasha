/**
 * Labyrinth fight recorder
 *
 * The calibration replay needs several fights of one monster to measure a rate.
 * The labyrinth hands out random rooms and only lets you fight one again by
 * failing it, so there is no farming a monster to a sample on demand. The way to
 * a sample is to stop trying to force one: keep every combat fight's damage
 * exchange, across runs and reloads, and let the ones you happen to meet often
 * accumulate.
 *
 * So this is passive and persistent. Every resolved combat fight is kept — no
 * arming, no targeting — with the gross damage each side dealt (summed from the
 * health that fell, so regen is not subtracted) and the gear it was fought in.
 * The replay pools whatever has piled up for the gear you are wearing now, which
 * is why each attempt carries a fingerprint: a gear change starts a fresh pool
 * rather than comparing fights fought on different gear against one sim.
 *
 * ## Why gross, and why fingerprinted
 *
 * Gross because the sim reports damage gross; net-of-regen made the monster look
 * weaker than it hit. Fingerprinted because the replay re-simulates with your
 * current loadout, and a fight fought on last week's gear is a fight against a
 * different character — pooling it would compare the sim to the wrong fights.
 *
 * ## Versioned
 *
 * The fingerprint's own definition changes over time — v2 added the combat
 * skill levels the sim reads, because a level-up moves the sim's answer without
 * moving an item; v3 added the ability kit and the house rooms, for the same
 * reason. Each attempt is stamped with the version it was fingerprinted under,
 * and readings never pool across versions: a v1, a v2 and a v3 fight are fights
 * against three different characters as far as the sim is concerned. Every
 * older cohort is kept, shown and counted — never deleted.
 *
 * ## Bounded
 *
 * A thousand fights, oldest dropped, at a measured 837 bytes a record: ~798 KB
 * per character. Saved replay inputs are referenced, not copied — forty
 * distinct builds at ~10.4 KB each, about 406 KB — so the whole pool is bounded
 * at roughly 1.20 MB however many builds are cycled through. See MAX_ATTEMPTS
 * and MAX_REPLAY_BUILDS for the arithmetic.
 * The number is doubled transiently by
 * `mergeAttempts`, which unions both devices' pools before slicing, so a
 * cross-device sync peaks at up to twice the cap in memory; that is the figure
 * to check against before raising it again. The constraint this is sized
 * against is local IndexedDB, not the upload: the gist payload is gzipped
 * before its size is checked, and a pool of near-identical records is about the
 * most compressible text there is.
 *
 * The cap is age-ordered and version-blind, which is what keeps a migration
 * from starving the new cohort: a pre-migration attempt is by construction
 * older than every post-migration one, so it is always among the first to fall
 * off. There is deliberately no per-version reservation — reserving space for
 * the old cohort would let a stale version hold half the slots forever, and the
 * whole point of the cap is that history ages out. What a migration therefore
 * costs is that the older cohort shrinks as the new one fills, and once
 * MAX_ATTEMPTS current-version fights have accumulated the older records are
 * gone. That is the intended end state: they are kept while they are the only
 * history there is, and retired once they are not.
 */

import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { copyReplayInputs, replayBuildKey, replayBuildIdFor } from './labyrinth-replay-inputs.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { clearRecord, clearedAtOf, clearedRecord, entriesOf, mergeClearable } from '../../utils/cleared-record.js';
import { scriptVersion } from '../../utils/script-version.js';
import { FINGERPRINT_SPEC, FINGERPRINT_VERSION, isCurrentFingerprintVersion } from './labyrinth-fingerprint.js';

/** The labyrinth store, shared with the sim cache — this is labyrinth history */
const STORE = 'labyrinth';
const KEY = 'labyrinthFightRecorder';

/**
 * Fights kept before the oldest fall off — many runs of history, still small.
 *
 * 1000 × ~837 bytes is about 798 KB per character for the fights themselves
 * (798 bytes of measurements and 39 of interned build id), which is the figure
 * this cap was chosen against. `mergeAttempts` unions both
 * devices' pools before slicing to the cap, so a cross-device sync holds up to
 * twice this many records at once; raise it only against that figure, not
 * against the steady-state one.
 *
 * Records also reference the effective room inputs for historical replay. Those
 * are interned by build rather than stored per fight — see
 * {@link MAX_REPLAY_BUILDS} for what they add.
 */
export const MAX_ATTEMPTS = 1000;

/**
 * Distinct saved builds the pool keeps replay inputs for.
 *
 * A saved build is a whole `buildPlayerDTO` — equipment, five abilities and six
 * consumables with their trigger lists, house rooms, guild and achievement
 * buffs, seventeen levels — plus crates, community buffs and the labyrinth
 * buffs: about **10.4 KB** of JSON, measured against a fully-kitted character.
 * Stored on every fight that was opened with a caught start, that is 1000 ×
 * 10.4 KB ≈ **10.2 MB** of builds on top of ~0.76 MB of fights: about
 * **10.9 MB** per character, against a pool that was ~0.76 MB before.
 *
 * What that cost is, and is not: it is **local IndexedDB**, fifteen times the
 * record for data almost all of which is the same build written again. It is
 * not an upload problem — the sync payload is gzipped before the MAX_GIST_BYTES
 * check (`sync-manager.js` compresses; `gist-client.js` sums the *compressed*
 * chunks), and near-identical DTOs are about the most compressible text there
 * is: a thousand copies of a stand-in 11 KB build gzip from 10.7 MB to 72 KB,
 * 152×. The uncompressed peak was never what the 9 MB ceiling measured, so
 * citing that ceiling here was wrong; the arithmetic below is about disk.
 *
 * Consecutive fights within a run share one build exactly, so the inputs are
 * interned: one copy per distinct build, each fight carrying a short
 * `replayBuildId` instead. That alone is bounded only by how often the player
 * changes gear, so the table is capped too, at the most recently fought builds.
 * A fight whose build falls off the table keeps every measurement it ever had
 * and simply reverts to the legacy path — replayable when its `fingerprint`
 * matches the current build. No fight history is ever lost to this cap.
 *
 * 40 × 10.4 KB ≈ **406 KB** of builds, plus 1000 records at 837 bytes each
 * (798 bare, 39 for the id — both measured by stringifying a full record with
 * every optional field present) ≈ **798 KB**: the pool lands at about
 * **1.20 MB** per character and cannot exceed it however many builds are cycled
 * through. The sync union holds twice both caps transiently, ~2.4 MB in memory.
 *
 * That is why MAX_ATTEMPTS stays at 1000: the fight history is the expensive
 * thing to rebuild (it accumulates passively over many runs and cannot be
 * farmed), the builds are not, and capping the builds bounds the new cost
 * without spending any of the old one.
 */
export const MAX_REPLAY_BUILDS = 40;

/** A fight shorter than this is an abandon, not a fight, and says nothing about a rate */
const MIN_FIGHT_SECONDS = 3;

/**
 * What makes two stored attempts the same fight.
 *
 * Attempts recorded from here on carry their own `recordId`. Older ones do
 * not, and are told apart by the fight's own clock and its measurements —
 * two real fights never share all of those, so only a genuine duplicate
 * collapses.
 * @param {Object} attempt - A stored attempt
 * @returns {string}
 */
export function attemptIdentity(attempt) {
    if (attempt?.recordId) return String(attempt.recordId);
    return [
        'legacy',
        attempt?.monsterHrid,
        attempt?.roomLevel,
        attempt?.battleStartedAt,
        attempt?.resolvedAt,
        attempt?.seconds,
        attempt?.outcome,
        attempt?.monsterHpEnd,
        attempt?.playerHpEnd,
        attempt?.monsterDamage,
        attempt?.playerDamageTaken,
    ].join('|');
}

/** An id no other tab or session will mint */
function newRecordId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * How old a recorded fight is, for the ring cap's ordering.
 *
 * `resolvedAt` is when the attempt was filed and is the field the pool is aged
 * by; `battleStartedAt` stands in for records written before it existed, and a
 * record carrying neither sorts oldest, which is where an undatable record
 * belongs in a cap that drops the oldest.
 * @param {Object} attempt - A recorded attempt
 * @returns {number} Milliseconds since the epoch, or 0
 */
function attemptAge(attempt) {
    return Number(attempt?.resolvedAt) || Number(attempt?.battleStartedAt) || 0;
}

/** Oldest first — the order `slice(-MAX_ATTEMPTS)` below depends on */
const oldestFirst = (a, b) => attemptAge(a) - attemptAge(b);

/**
 * Build keys, cached per inputs object.
 *
 * Interning shares one inputs object across every fight of a build, so this is
 * one canonicalisation per distinct build per fold rather than one per fight —
 * the difference between stringifying ~400 KB and ~10 MB on every save.
 * @type {WeakMap<Object, string>}
 */
const buildKeyCache = new WeakMap();

/**
 * The canonical build key of some saved inputs, or null when there are none.
 * @param {*} inputs - A record's `replayInputs`
 * @returns {string|null}
 */
function buildKeyOf(inputs) {
    if (!inputs || typeof inputs !== 'object' || !inputs.playerDTO) return null;
    const cached = buildKeyCache.get(inputs);
    if (cached !== undefined) return cached;
    let key = null;
    try {
        key = replayBuildKey(inputs);
    } catch (error) {
        console.error('[LabyrinthFightRecorder] Keying a saved build failed:', error);
    }
    buildKeyCache.set(inputs, key);
    return key;
}

/**
 * Give every record back the saved build it references.
 *
 * The stored form keeps one copy of each build, on the first record that uses
 * it; this hands the same object — by reference, so memory holds one copy too —
 * to every other record carrying that id. A record whose build is not in the
 * list (its inputs were dropped at the build cap, or it came from a peer that
 * never had them) is left as it is: it keeps its measurements and falls back to
 * the fingerprint path in the replay.
 *
 * Two carriers claiming one id with genuinely different builds cannot be
 * resolved, so that id is refused rather than guessed: every record referencing
 * it keeps its measurements and falls back to the fingerprint path. Losing a
 * build is recoverable; binding a fight to the wrong one produces a confident
 * wrong deviation and nothing says so. Content-derived ids make the case
 * unreachable between current clients; it survives here for pools an older,
 * non-expanding client folded before this fix shipped.
 *
 * @param {Array<Object>} entries - Records in the stored, interned form
 * @returns {Array<Object>} The same records with `replayInputs` filled in
 */
function expandReplayBuilds(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const byId = new Map();
    const conflicted = new Set();
    for (const entry of list) {
        if (!entry?.replayBuildId || !entry.replayInputs) continue;
        const id = String(entry.replayBuildId);
        const held = byId.get(id);
        if (held === undefined) {
            byId.set(id, entry.replayInputs);
            continue;
        }
        // Same object, or the same build stored twice, is not a conflict
        if (held === entry.replayInputs) continue;
        if (buildKeyOf(held) === buildKeyOf(entry.replayInputs)) continue;
        conflicted.add(id);
    }
    if (conflicted.size) {
        console.warn(
            `[LabyrinthFightRecorder] ${conflicted.size} saved build id(s) are claimed by different builds; ` +
                'the fights referencing them keep their measurements and fall back to the current-build path.'
        );
        for (const id of conflicted) byId.delete(id);
    }
    if (!byId.size) return list;
    return list.map((entry) => {
        if (!entry?.replayBuildId || entry.replayInputs) return entry;
        const inputs = byId.get(String(entry.replayBuildId));
        return inputs ? { ...entry, replayInputs: inputs } : entry;
    });
}

/**
 * Store each distinct build once, and cap how many are kept.
 *
 * Ids come from the build's own content — see {@link replayBuildIdFor} — so
 * they mean the same thing in every pool that ever holds them. Grouping is by
 * the full canonical key, never a hash, so two builds can never be collapsed
 * into one, and the id is derived from that same full key rather than from a
 * position in this list.
 *
 * The carrier — the record that keeps the actual inputs — is chosen *after* the
 * ring cap has been applied, so eviction cannot leave a record pointing at a
 * build that is no longer in the list. A build past {@link MAX_REPLAY_BUILDS}
 * loses its inputs *and* its id together, for the same reason.
 *
 * `capacity` defaults to {@link MAX_REPLAY_BUILDS}, the bound that keeps the
 * *stored* pool off disk small. An export has no such disk-size reason to drop
 * anything — deduplication alone already does the size work the export cares
 * about — so {@link recordingFile} calls this with `Infinity` and every distinct
 * build in the pool is carried, however many there are.
 *
 * @param {Array<Object>} entries - Records with their builds expanded, oldest first
 * @param {number} [capacity] - How many distinct builds to keep inputs for
 * @returns {Array<Object>} The records in the stored form
 */
function internReplayBuilds(entries, capacity = MAX_REPLAY_BUILDS) {
    const list = Array.isArray(entries) ? entries : [];
    const keys = new Map();
    // Where each build was last fought, so the cap keeps the most recent ones —
    // the builds the current gear is nearest and that are still accumulating
    const lastSeen = new Map();
    list.forEach((entry, index) => {
        const key = buildKeyOf(entry?.replayInputs);
        if (!key) return;
        keys.set(index, key);
        lastSeen.set(key, index);
    });
    if (!keys.size) return list;
    const kept = new Set(
        [...lastSeen.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, capacity)
            .map(([key]) => key)
    );

    const ids = new Map();
    const carried = new Set();
    return list.map((entry, index) => {
        const key = keys.get(index);
        if (!key || !kept.has(key)) {
            if (!entry || (entry.replayInputs == null && entry.replayBuildId == null)) return entry;
            return { ...entry, replayInputs: null, replayBuildId: null };
        }
        if (!ids.has(key)) ids.set(key, replayBuildIdFor(key));
        const id = ids.get(key);
        if (carried.has(id)) return { ...entry, replayBuildId: id, replayInputs: null };
        carried.add(id);
        return { ...entry, replayBuildId: id };
    });
}

/**
 * The interning scheme the stored pool is written under.
 *
 * A record without this marker is format 0, which is not one shape but two.
 * Mostly it is the legacy **verbatim** form: every fight carries its own
 * `replayInputs` and nothing is shared, which is how the pool was stored for
 * its whole life before interning and is what the real user data on disk looks
 * like (a test character holds 183 such records, most with a `fingerprint` and
 * no `replayInputs` at all). It can also be a pool the immediately preceding
 * build interned with POSITIONAL ids (`b0`, `b1`, …) and wrote out before the
 * marker existed — those do share. Both read correctly through
 * `expandReplayBuilds`, which resolves whatever ids a record carries and is a
 * no-op on records carrying none; the marker is not what makes them readable.
 *
 * 1 is the interned form: one copy of each build, carried on one record, with
 * every other fight of that build referencing it by a content-derived id.
 *
 * The marker exists so a reader can *refuse* a pool it cannot interpret. A pool
 * written under a scheme this build does not know is left unexpanded rather
 * than expanded by guesswork — the fights keep every measurement they have and
 * fall back to the fingerprint path, which is the same cost as a build falling
 * off the cap, and no fight is bound to a build that is not its own.
 */
export const REPLAY_BUILD_FORMAT = 1;

/**
 * The interning scheme a stored value was written under.
 * @param {*} value - A stored record, or the bare array it used to be
 * @returns {number} 0 for the legacy verbatim form
 */
function replayBuildFormatOf(value) {
    if (Array.isArray(value)) return 0;
    return Number(value?.replayBuildFormat) || 0;
}

/**
 * The stored shape this module writes: a cleared record plus the interning marker.
 * @param {Array<Object>} entries - Records in the interned form
 * @param {number} [clearedAt] - The clear epoch to carry
 * @returns {{clearedAt: number, entries: Array<Object>, replayBuildFormat: number}}
 */
function storedRecord(entries, clearedAt = 0) {
    return { ...clearedRecord(entries, clearedAt), replayBuildFormat: REPLAY_BUILD_FORMAT };
}

/**
 * Read a stored pool into the expanded, in-memory form its marker allows.
 *
 * Both the legacy verbatim form and format 1 expand the same way: expansion is
 * a no-op on records that carry no `replayBuildId`, so the legacy pool passes
 * through untouched. A newer format is not expanded at all.
 *
 * @param {*} value - A stored record, or the bare array it used to be
 * @returns {{clearedAt: number, entries: Array<Object>}} Ready to fold
 */
function readStored(value) {
    const entries = entriesOf(value);
    const format = replayBuildFormatOf(value);
    if (format > REPLAY_BUILD_FORMAT) {
        console.warn(
            `[LabyrinthFightRecorder] A stored fight pool uses build format ${format}, newer than ${REPLAY_BUILD_FORMAT}; ` +
                'its saved builds are left unresolved rather than guessed at.'
        );
        return clearedRecord(entries, clearedAtOf(value));
    }
    return clearedRecord(expandReplayBuilds(entries), clearedAtOf(value));
}

/**
 * The pool, kept through the shared load/save discipline: a read that could
 * not be made keeps the fights in memory, a save folds in what another tab
 * stored, and the ring cap is applied to the union (oldest fall off first).
 *
 * The comparator is what makes "oldest fall off first" true. Without one
 * `mergeById` returns stored-then-new, which is only *incidentally* age-ordered
 * — and stops being so exactly when it matters: a device that has been offline
 * for a week contributes fights that are older than everything stored here but
 * arrive on the new side, so the untimed cap kept them and evicted genuinely
 * newer fights instead.
 *
 * Both sides arrive already expanded — {@link readStored} does that in
 * `mergeAttempts`, which is the only place that knows the marker saying whether
 * expansion is even interpretable. Expanding again here would undo a refusal.
 */
const unionAttempts = (base, fresh) => mergeById(attemptIdentity, oldestFirst)(base, fresh).slice(-MAX_ATTEMPTS);

/**
 * The fold as stored and synced: the union above, with the clear's epoch applied.
 *
 * The Accuracy tab's Reset throws the pool away, and a union cannot say so — the
 * peer's still-full copy wins the next pull and the disowned fights come back,
 * on both devices. The epoch is compared against each attempt's own clock
 * (`attemptAge`), so fights the other device recorded after the Reset survive
 * it. The stored shape is `{ clearedAt, entries }`; a bare array is what was
 * stored before and reads as a pool no Reset has touched. See
 * utils/cleared-record.js.
 * @type {Function}
 */
const foldAttempts = mergeClearable(unionAttempts, attemptAge, { label: 'labyrinth fight' });

/*
 * Interning runs LAST, on the fold's own output. The clear epoch drops entries
 * from the middle of the list after the union has run, and the record that
 * carries a build's inputs is by construction the oldest one using it — so
 * interning before the clear filter left the survivors pointing at a build the
 * filter had just thrown away. Doing it here means every id in the stored
 * record resolves within that record, whatever the fold dropped.
 */
export const mergeAttempts = (base, fresh) => {
    // The refusal has to be here and not only in `readStored`. Refusing to
    // EXPAND a newer pool made the read safe and the write destructive: the
    // unexpanded entries went through `internReplayBuilds` anyway, the result
    // was stamped format 1, and the newer client's carrier was re-interned
    // under a content id while every reference to its own scheme resolved to
    // nothing. One fight recorded on the older client was enough to erase the
    // newer one's builds from disk permanently — the opposite of what a
    // forward-compatibility marker is for.
    const baseFormat = replayBuildFormatOf(base);
    const freshFormat = replayBuildFormatOf(fresh);
    if (baseFormat > REPLAY_BUILD_FORMAT || freshFormat > REPLAY_BUILD_FORMAT) {
        const newer = freshFormat > baseFormat ? fresh : base;
        console.warn(
            `[LabyrinthFightRecorder] A stored fight pool uses build format ${Math.max(baseFormat, freshFormat)}, ` +
                `newer than ${REPLAY_BUILD_FORMAT}; it is kept exactly as written rather than folded and ` +
                're-stamped. Any fights this client has to add are dropped instead of overwriting it.'
        );
        return newer;
    }
    const folded = foldAttempts(readStored(base), readStored(fresh));
    return storedRecord(internReplayBuilds(entriesOf(folded)), clearedAtOf(folded));
};

const record = createPersistedRecord({
    base: KEY,
    store: STORE,
    empty: () => storedRecord([]),
    merge: mergeAttempts,
    label: 'LabyrinthFightRecorder',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({ store: STORE, base: KEY, merge: mergeAttempts, label: 'Labyrinth fights' });

// Memory keeps the pool EXPANDED: every record holds its saved build, shared
// by reference so one object serves every fight of that build. The stored form
// is interned; the two are converted at each boundary below.
let attempts = entriesOf(readStored(record.get()));
let loading = null;

/**
 * The sim-model marker stamped on every attempt recorded from here on.
 *
 * The sim switched every labyrinth path to full monster abilities, so a
 * prediction made before that switch came from a different model. Attempts
 * without this marker are that legacy cohort, and the accuracy views must not
 * pool their predictions with new ones.
 * @returns {{fullKit: boolean, version: string|null}}
 */
function modelMarker() {
    return { fullKit: true, version: scriptVersion() };
}

/**
 * Read the accumulated fights back from storage, once.
 *
 * Called from the room-log feature's initialize so the pool survives a reload.
 * Idempotent, and safe to call before it has resolved — the in-memory list is
 * simply empty until it does.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function load() {
    if (record.isLoaded()) return attempts;
    if (loading) return loading;
    loading = (async () => {
        try {
            record.set(storedRecord(internReplayBuilds(attempts)));
            await record.load();
            attempts = entriesOf(readStored(record.get()));
        } catch (error) {
            console.error('[LabyrinthFightRecorder] Reading the fight pool failed:', error);
        }
        loading = null;
        return attempts;
    })();
    return loading;
}

/**
 * Forget the pool in memory without touching storage — for a character
 * switch, so the next load reads the arriving character's pool rather than
 * writing the departing one's under their key.
 */
export function forget() {
    record.reset();
    attempts = entriesOf(readStored(record.get()));
    loading = null;
}

/**
 * Write the pool out. Fire-and-forget: a lost write costs one fight, not the
 * run. Skipped when storage cannot be read first, so the pool on disk is never
 * blindly overwritten.
 * @returns {Promise<boolean>} Whether a write landed
 */
function persist() {
    // The epoch of a clear lives on the stored copy; memory carries none of its
    // own and the fold takes the newer of the two
    // A save with nothing stored yet writes memory as-is, so the interned form
    // has to be what memory holds by the time save() reads it
    record.set(storedRecord(internReplayBuilds(attempts)));
    return record
        .save()
        .then((landed) => {
            attempts = entriesOf(readStored(record.get()));
            return landed;
        })
        .catch((error) => {
            console.error('[LabyrinthFightRecorder] Writing the fight pool failed:', error);
            return false;
        });
}

/**
 * Keep one resolved fight, if it can support a rate.
 *
 * @param {Object} attempt
 * @param {string} attempt.monsterHrid - Which monster
 * @param {string} [attempt.monsterName] - For the file and the display
 * @param {number} attempt.roomLevel - The room's level, which scales the monster
 * @param {number} attempt.seconds - How long the fight ran
 * @param {string} attempt.outcome - clear | death | timeout | unknown
 * @param {boolean} attempt.cleared - The floor's word on whether the room cleared
 * @param {number} attempt.monsterMaxHp - The monster's maximum health
 * @param {number} attempt.monsterHpEnd - Its health on the last tick seen
 * @param {number} attempt.playerMaxHp - Your maximum health
 * @param {number} attempt.playerHpStart - Your health when the fight began
 * @param {number} attempt.playerHpEnd - Your health on the last tick seen
 * @param {number} [attempt.monsterDamage] - Gross damage you dealt (summed drops)
 * @param {number} [attempt.playerDamageTaken] - Gross damage you took (summed drops)
 * @param {number} [attempt.monsterHpStart] - The monster's health when the fight
 *   began — the new_battle snapshot's figure when the start was caught
 * @param {number} [attempt.monsterHealed] - Health the monster restored mid-fight
 * @param {number} [attempt.unattributedDealt] - Endpoint-reconciled damage the
 *   tick-summed figure missed; negative when the ticks carried more than the
 *   endpoints — stored as-is either way, it is a data-quality reading
 * @param {number} [attempt.playerHits] - Your swings that landed on the monster
 * @param {number} [attempt.playerMisses] - Your swings that missed
 * @param {number} [attempt.playerCrits] - Your landed swings that critted
 * @param {number} [attempt.playerDotTicks] - Damage-over-time ticks that landed on
 *   the monster — health it lost with no swing behind it. Counted apart from
 *   `playerHits` because a tick rings no attack counter, and kept so the replay
 *   can compare the swing/tick mix against the sim's
 * @param {number} [attempt.playerDotDamage] - The part of `monsterDamage` those
 *   ticks dealt. `monsterDamage` is the whole of what the monster lost, so
 *   damage-per-hit divided by `playerHits` would count tick damage in the
 *   numerator and no tick in the denominator; this is what the replay subtracts
 *   to make both sides measure swings
 * @param {number} [attempt.battleStartedAt] - When the fight opened (ms epoch)
 * @param {number} [attempt.firstUpdateAt] - First battle_updated processed
 * @param {number} [attempt.lastTickAt] - Last battle_updated processed
 * @param {number} [attempt.resolvedAt] - When the attempt was filed
 * @param {string} [attempt.resolveReason] - What ended the watch ('new_battle',
 *   'new_fight', 'stale', 'room_switch', 'left_labyrinth', 'feature_disabled')
 * @param {boolean} [attempt.complete] - Whole fight measured: seeded from its
 *   new_battle snapshot and resolved to a known outcome. Defaults false.
 * @param {string} [attempt.fingerprint] - The build the fight was fought in
 *   (gear and combat levels), version-tagged by the fingerprint module
 * @param {number} [attempt.predicted] - The cached clear chance in effect when the
 *   fight was recorded (0..1), or absent when no sim had run for the room
 */
export function noteAttempt(attempt) {
    if (!attempt || !attempt.monsterHrid) return;

    const seconds = Number(attempt.seconds) || 0;
    const monsterMaxHp = Number(attempt.monsterMaxHp) || 0;
    const playerMaxHp = Number(attempt.playerMaxHp) || 0;
    if (seconds < MIN_FIGHT_SECONDS || monsterMaxHp <= 0 || playerMaxHp <= 0) return;
    if (attempt.outcome === 'unknown') return;

    const grossDealt = Number(attempt.monsterDamage);
    const grossTaken = Number(attempt.playerDamageTaken);
    const playerHits = Number(attempt.playerHits);
    const playerMisses = Number(attempt.playerMisses);
    const playerCrits = Number(attempt.playerCrits);
    const playerDotTicks = Number(attempt.playerDotTicks);
    const predicted = Number(attempt.predicted);
    // Null when not measured, so a reader can tell "absent" from zero
    const nonNegOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    // unattributedDealt is a signed residual and stays signed
    const numOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    attempts.push({
        recordId: newRecordId(),
        monsterHrid: String(attempt.monsterHrid),
        monsterName: attempt.monsterName ? String(attempt.monsterName) : null,
        roomLevel: Math.max(0, Math.floor(Number(attempt.roomLevel) || 0)),
        seconds,
        outcome: String(attempt.outcome || 'unknown'),
        cleared: Boolean(attempt.cleared),
        monsterMaxHp,
        monsterHpEnd: Math.max(0, Number(attempt.monsterHpEnd) || 0),
        playerMaxHp,
        playerHpStart: Math.max(0, Number(attempt.playerHpStart) || 0),
        playerHpEnd: Math.max(0, Number(attempt.playerHpEnd) || 0),
        monsterDamage: Number.isFinite(grossDealt) && grossDealt >= 0 ? grossDealt : null,
        playerDamageTaken: Number.isFinite(grossTaken) && grossTaken >= 0 ? grossTaken : null,
        // The endpoint reconciliation, absent on recordings made before the
        // fight's start was caught from its new_battle snapshot
        monsterHpStart: nonNegOrNull(attempt.monsterHpStart),
        monsterHealed: nonNegOrNull(attempt.monsterHealed),
        unattributedDealt: numOrNull(attempt.unattributedDealt),
        // The fight's own clock — measured in-fight time, not the wall-clock
        // of the resolution that filed it
        battleStartedAt: nonNegOrNull(attempt.battleStartedAt),
        firstUpdateAt: nonNegOrNull(attempt.firstUpdateAt),
        lastTickAt: nonNegOrNull(attempt.lastTickAt),
        resolvedAt: nonNegOrNull(attempt.resolvedAt),
        resolveReason: attempt.resolveReason ? String(attempt.resolveReason).slice(0, 32) : null,
        // Whole fight measured: opened at its new_battle snapshot and resolved
        // to a known outcome. False on partial fights and on the legacy path
        // that joins at the first retained tick.
        complete: attempt.complete === true,
        // Null on recordings made before hit-rate was tracked, so the replay can
        // tell "no swing data" from "zero hits landed"
        playerHits: Number.isFinite(playerHits) && playerHits >= 0 ? playerHits : null,
        playerMisses: Number.isFinite(playerMisses) && playerMisses >= 0 ? playerMisses : null,
        // Null on recordings from before crits were tracked, so a rate reads as
        // "unknown" rather than "zero crits"
        playerCrits: Number.isFinite(playerCrits) && playerCrits >= 0 ? playerCrits : null,
        // Null on recordings from before the hit mix was tracked, so a fight
        // that predates the counter is not read as one that never ticked
        playerDotTicks: Number.isFinite(playerDotTicks) && playerDotTicks >= 0 ? playerDotTicks : null,
        // Null the same way, and read the same way: a fight that predates the
        // subtotal cannot have its tick damage subtracted, so the replay keeps
        // the mixed damage-per-hit for it and labels it, rather than treating
        // the absent field as a fight that bled for nothing
        playerDotDamage: nonNegOrNull(attempt.playerDotDamage),
        fingerprint: attempt.fingerprint ? String(attempt.fingerprint) : null,
        replayInputs: copyReplayInputs(attempt.replayInputs),
        // Which fingerprint definition the value above was computed under.
        // Stamped from the constant rather than taken from the caller: the
        // recorder and the fingerprint are the same build, and a caller-supplied
        // version could label a v2 value v1. Absent on records written before
        // this field existed, and those read as version 1 — the gear-only
        // fingerprint — wherever they are split into cohorts.
        fingerprintVersion: FINGERPRINT_VERSION,
        // The clear chance the sim was claiming when the fight was recorded —
        // the prediction at entry, not one recomputed later by a newer engine.
        // Null when no sim had run for the room; old records lack the field.
        predicted: Number.isFinite(predicted) && predicted >= 0 && predicted <= 1 ? predicted : null,
        // Attempts without this marker predate the full-kit sim model and are
        // the legacy cohort — kept, but never pooled with current predictions
        model: modelMarker(),
    });

    if (attempts.length > MAX_ATTEMPTS) attempts = attempts.slice(attempts.length - MAX_ATTEMPTS);
    persist();
}

/**
 * The accumulated fights, optionally only those fought on one build.
 *
 * The fingerprint carries its version, so filtering by a current-version value
 * already excludes every pre-migration record — a v1 fingerprint cannot equal a
 * v2 one. Passing no fingerprint returns the whole pool, older cohorts and all;
 * that is what the browse view and the export want, and any *reading* built
 * from it must split the cohorts itself.
 *
 * @param {string} [fingerprint] - Keep only fights carrying this build fingerprint
 * @returns {Array<Object>}
 */
export function recordedAttempts(fingerprint) {
    const list = fingerprint ? attempts.filter((a) => a.fingerprint === fingerprint) : attempts;
    return list.map((a) => ({ ...a }));
}

/**
 * How much has accumulated, for the build given.
 *
 * `legacyFingerprint` counts what the whole pool holds from an older
 * fingerprint definition — kept and readable, never pooled into a reading — so
 * a panel can say how much history the migration set aside rather than leaving
 * a dropped count unexplained.
 *
 * @param {string} [fingerprint] - Count only fights carrying this build fingerprint
 * @returns {{attempts: number, total: number, monsters: number, legacyFingerprint: number}}
 */
export function recordingStatus(fingerprint) {
    const list = fingerprint ? attempts.filter((a) => a.fingerprint === fingerprint) : attempts;
    return {
        attempts: list.length,
        total: attempts.length,
        monsters: new Set(list.map((a) => a.monsterHrid)).size,
        legacyFingerprint: attempts.filter((a) => !isCurrentFingerprintVersion(a)).length,
    };
}

/** Throw away every accumulated fight, stamped so a pull cannot bring them back. */
export function clearRecording() {
    attempts = [];
    // Shaped, not bare: REPLAY_BUILD_FORMAT promises every write this module
    // makes carries the marker, and the clear is a write like any other.
    clearRecord(record, undefined, storedRecord).catch((error) =>
        console.error('[LabyrinthFightRecorder] Clearing the fight pool failed:', error)
    );
}

/** What every exported file calls itself, so a reader can refuse a foreign one */
export const RECORDING_FORMAT = 'toolasha-labyrinth-recording';

/**
 * The export shape this build writes.
 *
 * 4 and below: every fight carries its own verbatim `replayInputs`, and there
 * is no `replayBuildFormat` field at all. 5: the attempts are interned exactly
 * as the stored pool is — one copy of each distinct build, carried on one
 * fight, every other fight of that build referencing it by a content-derived
 * `replayBuildId` — and the file says so with a top-level `replayBuildFormat`.
 *
 * The version had to move with the shape. A fight that references a build
 * carries `replayInputs: null`, which to a reader that only knows version 4 is
 * indistinguishable from a fight that never had a build — it would read a whole
 * pool as buildless and say nothing. Bumping the version is what makes that
 * reader stop instead: {@link attemptsFromRecordingFile} refuses a file whose
 * `replayBuildFormat` it does not know rather than handing back unresolved
 * fights, and any external reader pinned to 4 fails on the version instead of
 * silently mis-reading the attempts.
 */
export const RECORDING_VERSION = 5;

/**
 * The attempts of an exported file, with each fight's saved build resolved.
 *
 * This is the reader half of the export's interning: the same
 * `expandReplayBuilds` the stored pool is read through, so an export and a
 * stored record resolve under one scheme rather than two. A legacy file
 * (version 4 and below, no `replayBuildFormat`) passes through untouched —
 * expansion is a no-op on records carrying no `replayBuildId`.
 *
 * It throws rather than degrades. Unlike the stored pool — which has to keep
 * working for the player whatever is on disk — an export is read by a person
 * or a script investigating a discrepancy, and a pool of fights quietly
 * stripped of their builds is exactly the kind of wrong answer that costs an
 * afternoon.
 *
 * @param {Object} file - A parsed export, as {@link recordingFile} wrote it
 * @returns {Array<Object>} The attempts, each carrying its own `replayInputs`
 * @throws {Error} If the file is not a recording, or was written under a build
 *   interning scheme newer than {@link REPLAY_BUILD_FORMAT}
 */
export function attemptsFromRecordingFile(file) {
    if (!file || typeof file !== 'object' || file.format !== RECORDING_FORMAT) {
        throw new Error(`[LabyrinthFightRecorder] Not a ${RECORDING_FORMAT} file`);
    }
    const hasBuildFormat = Object.prototype.hasOwnProperty.call(file, 'replayBuildFormat');
    if (Number(file.version) >= 5 && !hasBuildFormat) {
        throw new Error('[LabyrinthFightRecorder] This recording is missing replay build format metadata.');
    }
    const rawBuildFormat = file.replayBuildFormat;
    if (hasBuildFormat && (!Number.isInteger(rawBuildFormat) || rawBuildFormat < 0)) {
        throw new Error('[LabyrinthFightRecorder] This recording has invalid replay build format metadata.');
    }
    const buildFormat = hasBuildFormat ? rawBuildFormat : 0;
    if (buildFormat > REPLAY_BUILD_FORMAT) {
        throw new Error(
            `[LabyrinthFightRecorder] This recording interns saved builds under format ${buildFormat}, newer than ` +
                `${REPLAY_BUILD_FORMAT}; its fights cannot be bound to their builds by this build of the script.`
        );
    }
    if (Number(file.version) >= 5 && buildFormat !== REPLAY_BUILD_FORMAT) {
        throw new Error(
            `[LabyrinthFightRecorder] Recording version ${file.version} requires replay build format ` +
                `${REPLAY_BUILD_FORMAT}, not ${buildFormat}.`
        );
    }
    if (!Array.isArray(file.attempts)) {
        throw new Error('[LabyrinthFightRecorder] This recording is missing attempts.');
    }
    const entries = file.attempts;
    if (buildFormat === REPLAY_BUILD_FORMAT) {
        const carriers = new Map();
        for (const entry of entries) {
            const id = entry?.replayBuildId == null ? null : String(entry.replayBuildId);
            if (entry?.replayInputs == null) continue;
            if (!id) {
                throw new Error('[LabyrinthFightRecorder] An interned recording carries a saved build without an id.');
            }
            const inputs = copyReplayInputs(entry.replayInputs);
            if (!inputs) {
                throw new Error(`[LabyrinthFightRecorder] Saved build ${id} is unreadable.`);
            }
            const key = replayBuildKey(inputs);
            if (replayBuildIdFor(key) !== id) {
                throw new Error(`[LabyrinthFightRecorder] Saved build id ${id} does not match its saved build.`);
            }
            const held = carriers.get(id);
            if (held !== undefined && held !== key) {
                throw new Error(`[LabyrinthFightRecorder] Saved build id ${id} is claimed by different builds.`);
            }
            carriers.set(id, key);
        }
        for (const entry of entries) {
            const id = entry?.replayBuildId == null ? null : String(entry.replayBuildId);
            if (id && !carriers.has(id)) {
                throw new Error(
                    `[LabyrinthFightRecorder] Fight ${entry?.recordId || '(unknown)'} references missing saved build ${id}.`
                );
            }
        }
    }
    return expandReplayBuilds(entries).map((entry) => ({ ...entry }));
}

/**
 * The pool in a shape safe to write out and read back.
 *
 * The attempts are interned, not expanded. `recordedAttempts()` hands back the
 * in-memory form, where every fight of a build carries its own copy of that
 * build — around 10.4 KB of player DTO apiece — so serializing it wrote the
 * same build out verbatim once per fight and turned a ~1.2 MB stored pool into
 * roughly 10 MB of JSON. Interning here is the same one applied to the stored
 * pool, so the file carries each distinct build once and
 * {@link attemptsFromRecordingFile} resolves it back — except for the cap.
 * {@link MAX_REPLAY_BUILDS} exists to bound what the stored pool keeps in
 * IndexedDB forever; an export is a one-shot file a person reads to
 * investigate a discrepancy, deduplication alone already does the size work an
 * export cares about, and dropping a build past the cap here would cost that
 * reader real data for no space saved on disk. So this interns with no cap at
 * all — every distinct build the pool references rides along, however many
 * there are.
 *
 * `extra` is folded in first, so a caller can embed the replay comparison
 * alongside the raw attempts without clobbering the format tag or the attempts.
 *
 * @param {Object} [extra] - Extra top-level fields to embed, e.g. `{ replay }`
 * @returns {Object}
 */
export function recordingFile(extra = {}) {
    // Which script produced the file and against which server — live and test
    // do not share balance, so a reader has to know which one it is looking at
    const host = typeof location !== 'undefined' ? location.hostname || null : null;
    return {
        ...extra,
        format: RECORDING_FORMAT,
        // 4: attempts carry fingerprintVersion, and the file names the
        // definition it was written under. 5: the attempts are interned.
        version: RECORDING_VERSION,
        exportedAt: Date.now(),
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        // The sim model this build records under; attempts carry their own marker
        fullKit: true,
        // The fingerprint definition this build records under. Attempts carry
        // their own `fingerprintVersion`, and an attempt without one is v1.
        fingerprintVersion: FINGERPRINT_VERSION,
        fingerprintSpec: FINGERPRINT_SPEC,
        // Which interning scheme `attempts` below is written under — the same
        // marker and the same scheme as the stored pool's. Read the attempts
        // back with `attemptsFromRecordingFile`.
        replayBuildFormat: REPLAY_BUILD_FORMAT,
        // Infinity: an export carries every build the pool references, unlike
        // the stored pool's write path which caps at MAX_REPLAY_BUILDS — see
        // the note above.
        attempts: internReplayBuilds(recordedAttempts(), Infinity),
    };
}

/**
 * Write the pool out as a file.
 * @param {Object} [extra] - Extra top-level fields to embed
 * @returns {boolean} Whether there was anything to write
 */
export function downloadRecording(extra = {}) {
    if (!attempts.length) return false;
    try {
        const blob = new Blob([JSON.stringify(recordingFile(extra))], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `toolasha-labyrinth-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return true;
    } catch (error) {
        console.error('[LabyrinthFightRecorder] Writing the recording failed:', error);
        return false;
    }
}

export default {
    load,
    forget,
    noteAttempt,
    recordedAttempts,
    recordingStatus,
    clearRecording,
    recordingFile,
    attemptsFromRecordingFile,
    downloadRecording,
};
