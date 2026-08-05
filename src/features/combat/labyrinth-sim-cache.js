/**
 * Labyrinth Combat Sim Cache
 *
 * Everything between a combat room and the simulator: the cache key a room's
 * sim is filed under, the stopping rule it runs to, the run itself, and the
 * mirror of the results in the 'labyrinth' store that keeps a reload from
 * starting over.
 *
 * Mixed into LabyrinthClearRate — the methods here read the loadout, crate
 * and gear accessors that live on the singleton alongside them.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { buildGameDataPayload, getCommunityBuffs } from '../combat-sim/combat-sim-adapter.js';
import { runLabyrinthSimulation } from '../combat-sim/combat-sim-runner.js';
import { wilsonInterval, decidedAgainst } from '../combat-sim/engine/wilson.js';
import loadoutSnapshot from './loadout-snapshot.js';
import { roomXpPerHour } from './labyrinth-formulas.js';
import { DISCARD_LEGACY } from './labyrinth-outcomes.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

/** Clear chances are pinned to this many percentage points either side by default */
export const DEFAULT_SIM_PRECISION_PCT = 1;
/** No room stops before this many trials, however lopsided the early ones look */
const MIN_SIM_TRIALS = 100;
/** Backstop for a rate near a coin toss, which never converges cheaply */
const MAX_SIM_TRIALS = 20000;
/** Persisted mirror of combatCache, in the 'labyrinth' store */
const COMBAT_CACHE_STORAGE_KEY = 'labyrinthCombatSimCache';
const COMBAT_CACHE_STORE = 'labyrinth';
/** Bumped when the stored shape changes */
const COMBAT_CACHE_STORAGE_VERSION = 1;
/** A cached sim result older than this is dropped on load rather than trusted */
const COMBAT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Newest entries kept when the persisted set is written back out */
const COMBAT_CACHE_MAX_ENTRIES = 200;
const DECISION_MIN_TRIALS = 40;
/** A room sitting exactly on the bar never decides; this is where it gives up */
const DECISION_MAX_TRIALS = 4000;

/** Prototype methods mixed into LabyrinthClearRate */
export const simCacheMethods = {
    /**
     * Get crate HRIDs as an array for the combat sim
     */
    getCrateHrids() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        return [
            labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ].filter(Boolean);
    },

    /**
     * Build cache key for a combat sim result
     */
    buildCombatCacheKey(monsterHrid, roomLevel, decideAgainst = null) {
        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const crateHrids = this.getCrateHrids();
        // Results from the two stopping rules must not share a slot. A decided
        // one is deliberately coarse — forty fights can leave ±12 points — and
        // a tile badge reading it would present that as a measurement.
        const mode = decideAgainst === null ? `${this.getSimPrecisionPct()}pp` : `dec${decideAgainst}`;
        return `${monsterHrid}:${roomLevel}:${loadoutId}:${mode}:${crateHrids.join(',')}`;
    },

    /**
     * How tightly a room's clear chance has to be pinned down before its sim
     * stops, in percentage points either side.
     *
     * This replaced a fixed span of simulated hours, which bought trials at a
     * rate set by fight length and so measured a five-second room twenty times
     * more finely than one running the full timeout — the slow rooms being
     * exactly the marginal ones where the decision is closest.
     */
    getSimPrecisionPct() {
        const raw = Number(config.getSettingValue('labyrinthSimPrecision', DEFAULT_SIM_PRECISION_PCT));
        return Math.min(10, Math.max(0.1, raw || DEFAULT_SIM_PRECISION_PCT));
    },

    /**
     * Ceiling on a single room's sim, in simulated hours. Precision normally
     * ends the run long before this; it exists so a room whose rate sits near a
     * coin toss cannot run forever.
     */
    getSimHours() {
        const raw = Number(config.getSettingValue('labyrinthRecommendSimHours', 3));
        return Math.min(100, Math.max(1, Math.floor(raw) || 3));
    },

    /** The stopping rule handed to the engine */
    getSimStopRule() {
        return {
            targetHalfWidth: this.getSimPrecisionPct() / 100,
            minTrials: MIN_SIM_TRIALS,
            maxTrials: MAX_SIM_TRIALS,
        };
    },

    /**
     * Experience per hour a combat room at this level would pay, from a win
     * rate and an average fight length.
     *
     * The same arithmetic computeCombatClear does, exposed so a caller holding
     * a sim result of its own (Lab Sim's Find Max) can quote a throughput
     * without re-deriving the award or forgetting the walk to the room.
     *
     * @param {number} roomLevel - The room's level
     * @param {number} avgFightSeconds - Mean length of one attempt, win or lose
     * @param {number} clearChance - 0-1
     * @returns {number} Experience per hour, 0 when the room never clears
     */
    estimateCombatXpPerHour(roomLevel, avgFightSeconds, clearChance) {
        if (!(roomLevel > 0) || !(clearChance > 0) || !(avgFightSeconds > 0)) return 0;
        const xpPerRoom = roomLevel * 50 * (1 + this.getCombatExperienceBonus());
        return roomXpPerHour(xpPerRoom, avgFightSeconds / clearChance, clearChance);
    },

    getCachedCombatResult(monsterHrid, roomLevel) {
        return this.combatCache.get(this.buildCombatCacheKey(monsterHrid, roomLevel)) || null;
    },

    // -------------------------------------------------------------------------
    // Persisted combat cache
    //
    // combatCache itself is only ever a plain Map — nothing here changes that,
    // or the invalidation that already governs it. This is a mirror written to
    // the 'labyrinth' store so the Map does not start empty on every reload; on
    // the way back in, an entry is trusted only if it is both fresh enough and
    // still under the gear it was simmed with, the same two questions the
    // in-memory cache is already subject to (TTL is new — nothing in-memory
    // lives long enough to need one; the gear check mirrors
    // _invalidateIfInputsChanged's own clear exactly).
    // -------------------------------------------------------------------------

    /**
     * Bring persisted combat sim results in from storage, once per session.
     *
     * Unlike `loadOutcomes`, this does not lazily load on first read:
     * `getCachedCombatResult` is called synchronously from render paths that
     * cannot await a database read, so whatever survives the reload has to
     * already be in the Map by the time those paths run. Called from
     * `initialize()`, after the gear fingerprint baseline is seeded, so the
     * gear check below has something current to compare against.
     */
    async _loadCombatCache() {
        if (this._combatCacheLoaded) return;
        this._combatCacheLoaded = true;
        try {
            const stored = await readScoped(COMBAT_CACHE_STORAGE_KEY, COMBAT_CACHE_STORE, null, DISCARD_LEGACY);
            if (!stored || stored.version !== COMBAT_CACHE_STORAGE_VERSION || !Array.isArray(stored.entries)) {
                return;
            }

            const now = Date.now();
            const currentFingerprint = this._snapshotContentFingerprint();
            for (const entry of stored.entries) {
                if (!entry?.key || !entry.result) continue;

                const age = now - Number(entry.computedAt);
                if (!Number.isFinite(age) || age > COMBAT_CACHE_TTL_MS) continue;

                // Same rule _invalidateIfInputsChanged already applies in
                // memory: gear the entry was simmed under and gear worn now
                // have to match, since the cache key alone doesn't encode it
                if (entry.snapshotFingerprint !== currentFingerprint) continue;

                const result = { ...entry.result, computedAt: entry.computedAt, fromPersistedCache: true };
                this.combatCache.set(entry.key, result);
                this._combatCacheMeta.set(entry.key, {
                    computedAt: entry.computedAt,
                    snapshotFingerprint: entry.snapshotFingerprint,
                });
            }
        } catch (error) {
            console.error('[LabyrinthClearRate] Loading cached combat sims failed:', error);
        }
    },

    /**
     * Write combatCache's contents back out to the 'labyrinth' store, capped to
     * the most recent `COMBAT_CACHE_MAX_ENTRIES`.
     *
     * Called after every completed sim rather than read-modify-written from
     * storage: `_combatCacheMeta` plus `combatCache` are already the full
     * in-memory state, loaded entries included, so a fresh read is never
     * needed and there is nothing for two quick sims to race over.
     *
     * Not awaited by callers — `storage.set` is itself debounced, so a burst
     * of sims collapses into one write a few seconds after the last of them.
     * @param {string} cacheKey - As built by buildCombatCacheKey
     * @param {Object} _result - The sim result just cached (already sitting in
     *   combatCache under cacheKey by the time this runs; read from there
     *   rather than trusted directly, so a stripped/re-persisted entry and a
     *   freshly-simmed one build their record the same way)
     */
    _persistCombatCacheEntry(cacheKey, _result) {
        this._combatCacheMeta.set(cacheKey, {
            computedAt: Date.now(),
            snapshotFingerprint: this._snapshotContentFingerprint(),
        });

        const entries = [];
        for (const [key, meta] of this._combatCacheMeta) {
            const cached = this.combatCache.get(key);
            if (!cached || !meta) continue;
            // A loaded entry carries fromPersistedCache/computedAt for display;
            // strip them back out so a re-persisted entry doesn't claim to have
            // been computed at the moment it was merely re-written
            const { computedAt: _computedAt, fromPersistedCache: _fromPersistedCache, ...bare } = cached;
            entries.push({
                key,
                result: bare,
                computedAt: meta.computedAt,
                snapshotFingerprint: meta.snapshotFingerprint,
            });
        }
        entries.sort((a, b) => b.computedAt - a.computedAt);
        if (entries.length > COMBAT_CACHE_MAX_ENTRIES) {
            const dropped = entries.splice(COMBAT_CACHE_MAX_ENTRIES);
            for (const entry of dropped) this._combatCacheMeta.delete(entry.key);
        }

        writeScoped(COMBAT_CACHE_STORAGE_KEY, { version: COMBAT_CACHE_STORAGE_VERSION, entries }, COMBAT_CACHE_STORE);
    },

    /**
     * Empty the persisted mirror. Called only for a gear change, which is the
     * one event that makes a stored sim untrue.
     *
     * The other sites that touch the in-memory Map deliberately leave this
     * alone — and, since this rewrite, mostly leave the Map alone too. Clearing
     * the Map without clearing the meta is not a no-op for storage:
     * `_persistCombatCacheEntry` rebuilds the stored list from the entries
     * still in the Map, so an emptied Map quietly wrote an empty file on the
     * next sim. A search run and a precision change both used to do that, and
     * neither had any reason to.
     */
    _clearPersistedCombatCache() {
        this._combatCacheMeta.clear();
        writeScoped(
            COMBAT_CACHE_STORAGE_KEY,
            { version: COMBAT_CACHE_STORAGE_VERSION, entries: [] },
            COMBAT_CACHE_STORE
        );
    },

    /**
     * Run combat sim for a monster room and return clear stats
     */
    async computeCombatClear(monsterHrid, roomLevel, options = {}) {
        // A bar means the caller only needs to know which side of it this room
        // falls on, which is a far cheaper question than what its rate is
        const rawBar = Number(options.decideAgainst);
        const bar = Number.isFinite(rawBar) && rawBar > 0 && rawBar < 1 ? rawBar : null;

        const cacheKey = this.buildCombatCacheKey(monsterHrid, roomLevel, bar);
        if (this.combatCache.has(cacheKey)) return this.combatCache.get(cacheKey);

        // A measured result already in hand answers a decision for free, as
        // long as its interval clears the bar — no reason to simulate again
        if (bar !== null) {
            const measured = this.combatCache.get(this.buildCombatCacheKey(monsterHrid, roomLevel, null));
            if (
                measured?.trials > 0 &&
                decidedAgainst(Math.round(measured.clearChance * measured.trials), measured.trials, bar)
            ) {
                return measured;
            }
        }

        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const dto = this.buildLabyrinthPlayerDTO(loadoutId);
        if (!dto) return { clearChance: 0, expectedSeconds: Infinity, failed: true };

        const gameData = buildGameDataPayload();
        const crateHrids = this.getCrateHrids();
        const labyrinthCombatBuffs = this.getLabyrinthCombatBuffs();

        try {
            const simResult = await runLabyrinthSimulation({
                gameData,
                playerDTOs: [dto],
                zoneHrid: '/actions/combat/fly',
                monsterHrid,
                roomLevel,
                crates: crateHrids,
                hours: this.getSimHours(),
                precision:
                    bar === null
                        ? this.getSimStopRule()
                        : {
                              decideAgainst: bar,
                              minTrials: DECISION_MIN_TRIALS,
                              maxTrials: DECISION_MAX_TRIALS,
                          },
                // The character's own, the way the Lab Sim panel passes them.
                // Neither of the two the engine models — wisdom and combat drop
                // quantity — moves a win rate, so the hardcoded zeroes this
                // replaces produced the same clear chance. They are still the
                // wrong thing to tell a simulator: the sim result is cached and
                // read back by anything that wants a figure off it, and a run
                // labelled "no buffs" is one balance patch away from being read
                // as one.
                communityBuffs: getCommunityBuffs(),
                labyrinthCombatBuffs,
            });

            const attempts = simResult.labyAttemptCount || 1;
            const wins = simResult.encounters || 0;
            const winRate = wins / attempts;
            const totalTime = simResult.simulatedTime / 1e9;
            const avgTime = totalTime / attempts;

            const gameDataLocal = dataManager.getInitClientData();
            const monsterDetail = gameDataLocal?.combatMonsterDetailMap?.[monsterHrid];
            const monsterName = monsterDetail?.name || monsterHrid.replace('/monsters/', '').replace(/_/g, ' ');

            const snapshot = loadoutSnapshot.snapshots[loadoutId];
            const loadoutName = snapshot?.name || `Loadout #${loadoutId}`;

            // Failure reason: deaths mean defense is the problem, otherwise the
            // fights are timing out on the 2-minute limit (insufficient damage)
            const failures = Math.max(0, attempts - wins);
            const deaths = Math.max(0, Number(simResult.deaths?.[dto.hrid || 'player1'] || 0));
            const failedByDeath = Math.min(failures, deaths);
            const failedByTimeout = failures - failedByDeath;
            const failureReason =
                failures > 0 && winRate < 1
                    ? failedByDeath > failedByTimeout
                        ? 'Insufficient Defense'
                        : 'Insufficient Damage'
                    : '';

            // How sure the figure is, which is the point of stopping on
            // precision rather than on a clock: a rate is only as good as the
            // number of fights behind it, and that number now varies by room
            const interval = wilsonInterval(wins, attempts);

            // A labyrinth room pays on completion, not per swing, so its
            // experience is a property of the room rather than of the fight —
            // the same level-based award a skilling room gives. An earlier
            // version totalled the experience the simulated fights earned,
            // which credited losing attempts for damage they dealt and paid out
            // for rooms that were never cleared.
            const xpPerClear = roomLevel * 50 * (1 + this.getCombatExperienceBonus());
            const expectedSeconds = winRate > 0 ? avgTime / winRate : Infinity;

            const result = {
                clearChance: winRate,
                expectedSeconds,
                type: 'combat',
                winRate,
                avgFightSeconds: avgTime,
                monsterName,
                monsterHrid,
                loadoutName,
                roomLevel,
                failureReason,
                trials: attempts,
                halfWidth: interval.halfWidth,
                hitTarget: !!simResult.labyStoppedOnPrecision,
                // What clearing the room is worth, and what that works out to per
                // hour once the attempts you lose on the way — and the walk to
                // the room before each of them — are paid for. A room you never
                // clear earns nothing however long you fight it, which is
                // exactly what an unreachable room is worth.
                xpPerRoom: xpPerClear,
                xpPerHour: roomXpPerHour(xpPerClear, expectedSeconds, winRate),
            };

            // Don't cache 0% results: right after page load the loadout
            // snapshots may not be loaded yet, so a 0% can come from simming
            // with the wrong gear. Leaving it uncached lets a retry correct it.
            if (winRate > 0) {
                this.combatCache.set(cacheKey, result);
                this._persistCombatCacheEntry(cacheKey, result);
            }
            return result;
        } catch (error) {
            if (error?.message === 'Cancelled') {
                // Explicit user Stop — flag it so searches abort instead of
                // treating the kill as a genuine 0% result
                return { clearChance: 0, expectedSeconds: Infinity, failed: true, cancelled: true };
            }
            console.error('[LabyrinthClearRate] Combat sim failed:', error);
            return { clearChance: 0, expectedSeconds: Infinity, failed: true };
        }
    },

    queueCombatSim(monsterHrid, roomLevel, badge) {
        this.simQueue.push({ monsterHrid, roomLevel, badge });
    },

    async processSimQueue() {
        if (this.simRunning) return;
        this.simRunning = true;
        while (this.simQueue.length > 0) {
            const { monsterHrid, roomLevel, badge } = this.simQueue.shift();
            if (!badge.isConnected) continue;
            const result = await this.computeCombatClear(monsterHrid, roomLevel);
            if (badge.isConnected) this.updateBadge(badge, result, roomLevel);
        }
        this.simRunning = false;
    },
};
