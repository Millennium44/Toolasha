/**
 * All Zones Combat Simulator Runner
 * Uses a dedicated coordinator worker (multiWorker) that spawns child simulation workers.
 *
 * Worker-spawned workers get different CPU scheduling from the browser than
 * main-thread-spawned workers, matching Shykai's architecture for better
 * multi-zone throughput.
 */

import { buildExtraBuffs, getMaxWorkers } from './combat-sim-runner.js';
import WORKER_SCRIPT from './combat-sim-worker-entry.js?worker';
import MULTI_WORKER_SCRIPT from './multi-worker-entry.js?worker';
import { calculateSimRevenue } from './combat-sim-adapter.js';

let multiWorker = null;
let activeReject = null;
/** The current run's teardown, so a cancel frees the blob URL the run made */
let activeCleanup = null;

/**
 * Run simulations for all specified zones in parallel via a coordinator worker.
 * @param {Object} params
 * @param {Object} params.gameData - Game data maps from buildGameDataPayload()
 * @param {Array<Object>} params.playerDTOs - Player DTOs from buildAllPlayerDTOs()
 * @param {Array<{zoneHrid: string, difficultyTier: number}>} params.zones - Zones to simulate
 * @param {number} params.hours - Hours to simulate per zone
 * @param {Object} params.communityBuffs - { mooPass, comExp, comDrop }
 * @param {boolean} [params.useEarlyExit] - Skip higher tiers when both XP/hr and profit/hr decline
 * @param {Function} [onProgress] - Called with (percent: 0-100) for overall progress
 * @returns {Promise<Array<Object>>} Array of SimResults, one per zone (same order as input)
 */
export async function runAllZonesSimulation(params, onProgress) {
    const { gameData, playerDTOs, zones, hours, communityBuffs, useEarlyExit } = params;

    if (!zones.length) return [];

    // Cancel any previous run
    cancelAllZonesSimulation();

    // Guild buffs are not folded in here: the worker reads each player DTO's
    // own guildCombatBuffs, so party members keep their own guild's bonuses
    const extraBuffs = buildExtraBuffs(communityBuffs);
    const ONE_HOUR_NS = 3600 * 1e9;
    const simulationTimeLimit = hours * ONE_HOUR_NS;

    // The same budget every other sim path uses. This module counted raw
    // hardwareConcurrency instead, so a 16-core desktop spawned 16 workers and
    // a phone reporting 8 cores spawned 8 — each holding its own clone of the
    // whole game data, where everything else stops at four.
    const maxWorkers = getMaxWorkers();

    return new Promise((resolve, reject) => {
        // Store reject so cancelAllZonesSimulation can unblock the promise
        activeReject = reject;

        // Create the coordinator worker
        const blob = new Blob([MULTI_WORKER_SCRIPT], { type: 'application/javascript' });
        const blobURL = URL.createObjectURL(blob);
        const worker = new Worker(blobURL);
        multiWorker = worker;

        const cleanup = () => {
            multiWorker = null;
            activeReject = null;
            activeCleanup = null;
            URL.revokeObjectURL(blobURL);
        };
        activeCleanup = cleanup;

        // Per-zone tier metrics for early exit comparison: zoneHrid → [{xpPerHour, profitPerHour}]
        const tierResultsByZone = new Map();

        worker.onmessage = (event) => {
            const msg = event.data;

            if (msg.type === 'progress') {
                if (onProgress) onProgress(Math.round(msg.progress));
            } else if (msg.type === 'zone_tier_result') {
                // Calculate XP/hr and profit/hr for this tier and decide whether to skip the next.
                // Whatever happens in here, a decision must go back: a chain in the
                // coordinator is parked on it, and a missing answer is a sweep that never ends
                const { zoneHrid, simResult } = msg;
                let skip = false;
                try {
                    skip = decideSkip(zoneHrid, simResult);
                } catch (error) {
                    console.error('[AllZones] Tier comparison failed; simming the next tier anyway:', error);
                }
                worker.postMessage({ type: 'zone_tier_decision', zoneHrid, skip });
            } else if (msg.type === 'all_zones_result') {
                worker.terminate();
                cleanup();
                if (onProgress) onProgress(100);
                resolve(msg.results);
            } else if (msg.type === 'error') {
                worker.terminate();
                cleanup();
                reject(new Error(msg.error));
            }
        };

        /**
         * Whether the next tier of a zone is worth simming: not when both XP/hr
         * and profit/hr fell against the tier before it
         * @param {string} zoneHrid
         * @param {Object} simResult
         * @returns {boolean}
         */
        const decideSkip = (zoneHrid, simResult) => {
            {
                const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;

                // Sum XP across all players and all skills
                let totalXP = 0;
                for (const playerXP of Object.values(simResult.experienceGained || {})) {
                    for (const xp of Object.values(playerXP)) {
                        totalXP += xp;
                    }
                }
                const xpPerHour = totalXP / simHours;

                let profitPerHour = 0;
                try {
                    const revenue = calculateSimRevenue(simResult, gameData, 'player1', simHours);
                    profitPerHour = revenue.netPerHour;
                } catch {
                    // Revenue calculation may fail if market data is unavailable
                }

                const prevResults = tierResultsByZone.get(zoneHrid) || [];
                const currMetrics = { xpPerHour, profitPerHour };

                let skip = false;
                if (prevResults.length > 0) {
                    const prev = prevResults[prevResults.length - 1];
                    if (xpPerHour < prev.xpPerHour && profitPerHour < prev.profitPerHour) {
                        skip = true;
                    }
                }

                prevResults.push(currMetrics);
                tierResultsByZone.set(zoneHrid, prevResults);
                return skip;
            }
        };

        worker.onerror = (error) => {
            worker.terminate();
            cleanup();
            reject(new Error(error.message || 'MultiWorker error'));
        };

        // Send the simulation worker script as a string so the multiWorker can spawn child workers
        worker.postMessage({
            type: 'start_all_zones',
            workerScript: WORKER_SCRIPT,
            gameData,
            playerDTOs,
            zones,
            simulationTimeLimit,
            extraBuffs,
            maxWorkers,
            useEarlyExit: !!useEarlyExit,
        });
    });
}

/**
 * Terminate the coordinator worker (kills all child workers too) and reject the pending promise.
 */
export function cancelAllZonesSimulation() {
    if (multiWorker) {
        multiWorker.terminate();
        multiWorker = null;
    }
    const reject = activeReject;
    // Every other exit runs the teardown; a cancel used to skip it and leak the
    // coordinator's blob URL — and its script — for the life of the page
    activeCleanup?.();
    activeReject = null;
    activeCleanup = null;
    if (reject) reject(new Error('Cancelled'));
}
