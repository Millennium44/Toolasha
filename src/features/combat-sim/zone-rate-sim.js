/**
 * Single-zone rate simulation
 *
 * One zone, one tier, one loadout, solo, for a fixed number of hours — started
 * by a click on a queued fight, so the queue can time that fight in the gear it
 * will actually be fought in.
 *
 * Headless: the simulator's panel is neither opened nor touched. The run goes
 * through the same `runSimulation` worker path the panel's Simulate button
 * uses, with a DTO built the way the panel auto-fills one (`buildPlayerDTO`)
 * and the loadout applied the way the panel's loadout picker applies one
 * (`applyLoadoutSnapshotToDTO`). It does not preempt: a run the panel already
 * has going is left alone, and a panel run started afterwards cancels this one
 * (which then reports "cancelled"), as panel runs always have.
 *
 * The result is written to the single-zone rate store, never to the all-zones
 * snapshot — see the note above `ZONE_SIM_RATES_KEY` for why.
 */

import dataManager from '../../core/data-manager.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import {
    applyLoadoutSnapshotToDTO,
    buildGameDataPayload,
    buildPlayerDTO,
    calculateSimRevenue,
    getCommunityBuffs,
} from './combat-sim-adapter.js';
import { runSimulation } from './combat-sim-runner.js';
import { loadoutSnapshot } from '../../utils/bundle-bridge.js';
import { characterKey } from '../../utils/character-key.js';
import { ZONE_SIM_RATES_KEY, loadoutSignature, saveZoneSimRate } from '../../utils/all-zones-snapshot.js';

/** The length the queue's button asks for */
export const ZONE_RATE_SIM_HOURS = 24;

/**
 * Build the run a queued fight asks for, without running it.
 *
 * Separate from {@link simulateZoneRate} so the configuration — zone, tier,
 * loadout, hours, solo — can be checked without workers.
 *
 * @param {Object} request
 * @param {string} request.zoneHrid - The fight's zone
 * @param {number} [request.difficultyTier=0] - Its tier
 * @param {number|string} [request.loadoutId=0] - The fight's `characterLoadoutID`; 0 is worn gear
 * @param {number} [request.hours] - Hours to simulate
 * @param {Object} [deps] - Overrides for tests
 * @returns {Promise<{ok: true, params: Object, loadout: Object}|{ok: false, error: string}>}
 */
export async function prepareZoneRateRun(
    { zoneHrid, difficultyTier = 0, loadoutId = 0, hours = ZONE_RATE_SIM_HOURS },
    deps = {}
) {
    const {
        store = loadoutSnapshot() || bundledLoadoutSnapshot,
        makeDTO = buildPlayerDTO,
        makeGameData = buildGameDataPayload,
        communityBuffs = getCommunityBuffs,
        applyLoadout = applyLoadoutSnapshotToDTO,
    } = deps;

    if (!zoneHrid) return { ok: false, error: 'No zone to simulate.' };

    const gameData = makeGameData();
    if (!gameData) return { ok: false, error: 'Game data is not loaded yet.' };

    const zone = gameData.actionDetailMap?.[zoneHrid];
    if (zone?.combatZoneInfo?.isDungeon) {
        return { ok: false, error: 'Dungeons are not simulated here: the queue counts runs, the sim counts waves.' };
    }

    const dto = makeDTO();
    if (!dto) return { ok: false, error: 'Character data is not loaded yet.' };

    const id = Number(loadoutId) || 0;
    let loadout = { id: '0', source: 'worn', name: null, signature: null };
    if (id > 0) {
        // The store fills from storage asynchronously; an empty one early in a
        // session is not "no such loadout"
        if (typeof store?.whenReady === 'function') await store.whenReady();
        const snapshot = store?.snapshots?.[String(id)] || null;
        if (!snapshot) {
            return {
                ok: false,
                error:
                    'Could not read the loadout this fight uses (it may be deleted, or Loadout Snapshots may be ' +
                    'off). Nothing was simulated.',
            };
        }
        if (applyLoadout(dto, snapshot, gameData) === false) {
            return { ok: false, error: `Could not apply the ${snapshot.name || 'selected'} loadout.` };
        }
        loadout = {
            id: String(id),
            source: 'loadout',
            name: snapshot.name || null,
            signature: loadoutSignature(snapshot),
        };
    }

    return {
        ok: true,
        loadout,
        params: {
            gameData,
            playerDTOs: [dto],
            zoneHrid,
            difficultyTier: Number(difficultyTier) || 0,
            hours,
            communityBuffs: communityBuffs(),
        },
    };
}

/**
 * Reduce a finished run to the entry the rate store keeps.
 * @param {Object} simResult - Merged SimResult
 * @param {Object} run - `{params, loadout}` from {@link prepareZoneRateRun}
 * @param {Object} [options]
 * @param {Function} [options.revenue] - `calculateSimRevenue`
 * @param {number} [options.now]
 * @returns {Object|null} The entry, or null when the run cleared nothing to rate
 */
export function zoneRateEntry(
    simResult,
    { params, loadout },
    { revenue = calculateSimRevenue, now = Date.now() } = {}
) {
    const simHours = (simResult?.simulatedTime || 0) / (3600 * 1e9) || params.hours;
    const encounters = Number(simResult?.encounters);
    if (!Number.isFinite(encounters) || encounters <= 0 || !(simHours > 0)) return null;

    let profitPerHour = null;
    try {
        const result = revenue(simResult, params.gameData, 'player1', simHours);
        profitPerHour = Number.isFinite(result?.netPerHour) ? result.netPerHour : null;
    } catch {
        // Market data may be unavailable; the rate does not depend on it
    }
    const xp = Object.values(simResult.experienceGained?.player1 || {}).reduce((sum, v) => sum + (v || 0), 0);

    return {
        zoneHrid: params.zoneHrid,
        difficultyTier: params.difficultyTier,
        loadoutId: loadout.id,
        loadoutSource: loadout.source,
        loadoutName: loadout.name,
        signature: loadout.signature,
        encountersPerHour: encounters / simHours,
        profitPerHour,
        xpPerHour: xp / simHours,
        deathsPerHour: (Number(simResult.deaths?.player1) || 0) / simHours,
        hours: simHours,
        savedAt: now,
    };
}

/**
 * Simulate one zone in one loadout and store the rate.
 *
 * @param {Object} request - As {@link prepareZoneRateRun}
 * @param {Object} [options]
 * @param {Function} [options.onProgress] - `(percent)`
 * @param {Object} [options.deps] - Overrides for tests (`run`, `save`, and those of `prepareZoneRateRun`)
 * @returns {Promise<{ok: true, entry: Object}|{ok: false, error: string}>} Never throws
 */
export async function simulateZoneRate(request, { onProgress, deps = {} } = {}) {
    const { run = runSimulation, save = saveZoneSimRate } = deps;
    try {
        // Captured before the first await: the run takes a while, and the rate
        // belongs to whoever it was started for
        const ownerId = dataManager.getCurrentCharacterId();
        const storageKey = characterKey(ZONE_SIM_RATES_KEY);

        const prepared = await prepareZoneRateRun(request, deps);
        if (!prepared.ok) return prepared;

        const simResult = await run(prepared.params, onProgress, { preempt: false });

        if (dataManager.getCurrentCharacterId() !== ownerId) {
            return { ok: false, error: 'The character changed during the run; its result was discarded.' };
        }
        const entry = zoneRateEntry(simResult, prepared);
        if (!entry) {
            return { ok: false, error: 'The simulation cleared no waves, so there is no rate to show.' };
        }
        if (!(await save(storageKey, entry))) {
            return { ok: false, error: 'The rate could not be saved.' };
        }
        return { ok: true, entry };
    } catch (error) {
        if (error?.message === 'Cancelled') {
            return { ok: false, error: 'The simulation was cancelled (another simulation took its place).' };
        }
        console.error('[ZoneRateSim] Simulation failed:', error);
        return { ok: false, error: `Simulation failed: ${error?.message || 'unknown error'}` };
    }
}
