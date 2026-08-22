/**
 * Dungeon Tracker Storage
 * Manages IndexedDB storage for dungeon run history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';

/**
 * Runs are stored once for the whole account, not once per character.
 *
 * A team run is the same run whichever of your characters was in the party, and
 * the duplicate check that collapses those two sightings into one entry only
 * works if they land in the same list. Partitioning the store per character
 * would turn one run into two.
 *
 * What the store lacked was any record of *who* recorded each run, so a panel
 * could not answer "how am I doing" without also counting the other character's
 * runs. New runs are stamped with the recording character; the panel filters on
 * that stamp. Runs written before the stamp existed fall back to looking for
 * the character's name in the team, which is right for every run they were
 * actually in and merely conservative for solo runs recorded under a name the
 * roster does not carry.
 */

// Hardcoded max waves for each dungeon (fallback if maxCount is 0)
const DUNGEON_MAX_WAVES = {
    '/actions/combat/chimerical_den': 50,
    '/actions/combat/sinister_circus': 60,
    '/actions/combat/enchanted_fortress': 65,
    '/actions/combat/pirate_cove': 65,
};

/**
 * Whether a stored run belongs to the given character.
 *
 * Pure so the fallback is testable: the stamp decides when it is there, and
 * only a run without one is matched by name against the team.
 *
 * @param {Object} run - A stored run
 * @param {string|null} characterId - The character asking
 * @param {string|null} characterName - Their in-game name, for legacy runs
 * @returns {boolean}
 */
export function runMatchesCharacter(run, characterId, characterName) {
    if (!run) return false;

    if (run.recordedBy) {
        return characterId != null && String(run.recordedBy) === String(characterId);
    }

    // Legacy run: no stamp, so the roster is the only evidence there is
    if (!characterName) return false;
    if (Array.isArray(run.team) && run.team.includes(characterName)) return true;
    if (typeof run.teamKey === 'string' && run.teamKey.split(',').includes(characterName)) return true;
    return false;
}

/**
 * Narrow a run list to one character, or leave it whole.
 *
 * @param {Array<Object>} runs - Stored runs
 * @param {string} filterCharacter - 'mine' or 'all'
 * @param {{id: string|null, name: string|null}} character - Who is asking
 * @returns {Array<Object>} The runs to show
 */
export function filterRunsForCharacter(runs, filterCharacter, character) {
    const list = Array.isArray(runs) ? runs : [];
    if (filterCharacter !== 'mine') return list;
    return list.filter((run) => runMatchesCharacter(run, character?.id ?? null, character?.name ?? null));
}

/**
 * The character the panel is currently speaking for.
 * @returns {{id: string|null, name: string|null}}
 */
export function currentCharacter() {
    return {
        id: dataManager.getCurrentCharacterId?.() ?? null,
        name: dataManager.getCurrentCharacterName?.() ?? null,
    };
}

class DungeonTrackerStorage {
    constructor() {
        this.unifiedStoreName = 'unifiedRuns'; // Unified storage for all runs

        /**
         * The stored list, newest first, once it has been read.
         *
         * Every run used to be saved by reading the whole list back from
         * IndexedDB, scanning it for a duplicate and writing it back, and every
         * panel refresh read it again; with a few hundred runs kept that was
         * most of the store's traffic. Memory is the truth between writes now:
         * every read and write goes through here, so the list is read once per
         * session and written only when it changes.
         */
        this._runs = null;
        /** teamKey → that team's runs (the same objects), for the duplicate check */
        this._byTeam = new Map();
        /** When the last run was appended, to tell a burst from a lone run */
    }

    /**
     * The stored list, read on first use and held afterwards.
     *
     * A read that could not be made is not an empty history: the list stays
     * unloaded, this call answers empty, and a save will not write over
     * whatever is stored until a read has succeeded.
     * @returns {Promise<Array<Object>|null>} The live list, or null when storage could not be read
     * @private
     */
    async _loadRuns() {
        if (this._runs) return this._runs;

        const probe = await storage.tryGet('allRuns', this.unifiedStoreName);
        if (probe === null) {
            console.warn('[DungeonTrackerStorage] Run history could not be read');
            return null;
        }
        this._index(Array.isArray(probe.value) ? probe.value : []);
        return this._runs;
    }

    /**
     * Take a list as the in-memory truth and rebuild the per-team index.
     * @param {Array<Object>} runs - Runs, newest first
     * @private
     */
    _index(runs) {
        this._runs = runs;
        this._byTeam = new Map();
        for (const run of runs) this._indexRun(run);
    }

    /**
     * @param {Object} run - A run now in the list
     * @private
     */
    _indexRun(run) {
        if (!run || typeof run.teamKey !== 'string') return;
        const list = this._byTeam.get(run.teamKey);
        if (list) list.push(run);
        else this._byTeam.set(run.teamKey, [run]);
    }

    /**
     * Write the in-memory list out.
     * @param {boolean} immediate - Skip the write debounce
     * @returns {Promise<boolean>|boolean} The write's outcome when immediate; true when queued
     * @private
     */
    _persist(immediate) {
        const write = storage.setJSON('allRuns', this._runs, this.unifiedStoreName, immediate);
        // A debounced write resolves when its timer fires; awaiting it would
        // stall a backfill loop for the debounce delay on every run
        return immediate ? write : true;
    }

    /**
     * Test-only: forget the in-memory list, so the next call reads storage again.
     * @returns {void}
     */
    _resetCache() {
        this._runs = null;
        this._byTeam = new Map();
    }

    /**
     * Get dungeon+tier key
     * @param {string} dungeonHrid - Dungeon action HRID
     * @param {number} tier - Difficulty tier (0-2)
     * @returns {string} Storage key
     */
    getDungeonKey(dungeonHrid, tier) {
        return `${dungeonHrid}::T${tier}`;
    }

    /**
     * Get dungeon info from game data
     * @param {string} dungeonHrid - Dungeon action HRID
     * @returns {Object|null} Dungeon info or null
     */
    getDungeonInfo(dungeonHrid) {
        const actionDetails = dataManager.getActionDetails(dungeonHrid);
        if (!actionDetails) {
            return null;
        }

        // Extract name from HRID (e.g., "/actions/combat/chimerical_den" -> "Chimerical Den")
        const namePart = dungeonHrid.split('/').pop();
        const name = namePart
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        // Get max waves from nested combatZoneInfo.dungeonInfo.maxWaves
        let maxWaves = actionDetails.combatZoneInfo?.dungeonInfo?.maxWaves || 0;

        // Fallback to hardcoded values if not found in game data
        if (maxWaves === 0 && DUNGEON_MAX_WAVES[dungeonHrid]) {
            maxWaves = DUNGEON_MAX_WAVES[dungeonHrid];
        }

        return {
            name: actionDetails.name || name,
            maxWaves: maxWaves,
        };
    }

    /**
     * Get statistics for a dungeon by name (for chat-based runs)
     * @param {string} dungeonName - Dungeon display name
     * @returns {Promise<Object>} Statistics
     */
    async getStatsByName(dungeonName) {
        const allRuns = await this.getAllRuns();
        const runs = allRuns.filter((r) => r.dungeonName === dungeonName);

        if (runs.length === 0) {
            return {
                totalRuns: 0,
                avgTime: 0,
                fastestTime: 0,
                slowestTime: 0,
                avgWaveTime: 0,
            };
        }

        // Use 'duration' field (chat-based) or 'totalTime' field (websocket-based)
        const durations = runs.map((r) => r.duration || r.totalTime || 0);
        const totalTime = durations.reduce((sum, d) => sum + d, 0);
        const avgTime = totalTime / runs.length;
        const fastestTime = Math.min(...durations);
        const slowestTime = Math.max(...durations);

        const avgWaveTime = runs.reduce((sum, run) => sum + (run.avgWaveTime || 0), 0) / runs.length;

        return {
            totalRuns: runs.length,
            avgTime,
            fastestTime,
            slowestTime,
            avgWaveTime,
        };
    }

    /**
     * Get team key from sorted player names
     * @param {Array<string>} playerNames - Array of player names
     * @returns {string} Team key (sorted, comma-separated)
     */
    getTeamKey(playerNames) {
        return playerNames.sort().join(',');
    }

    /**
     * Save a team-based run (from backfill)
     * @param {string} teamKey - Team key (sorted player names)
     * @param {Object} run - Run data
     * @param {string} run.timestamp - Run start timestamp (ISO string)
     * @param {number} run.duration - Run duration (ms)
     * @param {string} run.dungeonName - Dungeon name (from Phase 2)
     * @param {string|null} [run.dungeonHrid] - Dungeon action, where the recording route knew it
     * @param {number|null} [run.tier] - Difficulty tier, where the recording route knew it
     * @returns {Promise<boolean>} Success status
     */
    async saveTeamRun(teamKey, run) {
        const allRuns = await this._loadRuns();
        if (!allRuns) {
            console.warn('[DungeonTrackerStorage] Run not saved: the stored history could not be read first');
            return false;
        }

        // Parse incoming timestamp
        const newTimestamp = new Date(run.timestamp).getTime();

        // Check for duplicates (same time window, team, and duration). Only
        // this team's runs can match, so only they are looked at.
        const existing = (this._byTeam.get(teamKey) || []).find((r) => {
            const existingTimestamp = new Date(r.timestamp).getTime();
            const timeDiff = Math.abs(existingTimestamp - newTimestamp);
            const durationDiff = Math.abs(r.duration - run.duration);

            // Consider duplicate if:
            // - Within 10 seconds of each other (handles timestamp precision differences)
            // - Same team
            // - Duration within 2 seconds (handles minor timing differences)
            return timeDiff < 10000 && durationDiff < 2000;
        });
        const isDuplicate = Boolean(existing);

        // A chat backfill never sees a tier; the live tracker does. When the two
        // routes record the same run, the one that knew the tier fills it in
        if (existing && existing.tier == null && Number.isInteger(run.tier)) {
            existing.tier = run.tier;
            if (!existing.dungeonHrid && run.dungeonHrid) existing.dungeonHrid = run.dungeonHrid;
            await this._persist(false);
        }

        if (!isDuplicate) {
            // Create unified format run
            const team = teamKey.split(',').sort();
            // Who saw this run. Read here rather than at module load, since the
            // user switches characters without reloading the page.
            const recorder = currentCharacter();
            const unifiedRun = {
                recordedBy: recorder.id,
                recordedByName: recorder.name,
                timestamp: run.timestamp,
                dungeonName: run.dungeonName || 'Unknown',
                dungeonHrid: run.dungeonHrid || null,
                tier: Number.isInteger(run.tier) ? run.tier : null,
                team: team,
                teamKey: teamKey,
                duration: run.duration,
                validated: true,
                source: 'chat',
                waveTimes: null,
                avgWaveTime: null,
                keyCountsMap: run.keyCountsMap || null, // Include key counts if available
            };

            // Add to front of list (most recent first)
            allRuns.unshift(unifiedRun);
            this._indexRun(unifiedRun);

            // Memory is authoritative and every reader goes through it, so the
            // write takes the normal debounce — a backfill of dozens of runs
            // lands as one write
            await this._persist(false);

            return true;
        }

        return false;
    }

    /**
     * Get all runs (unfiltered)
     * @returns {Promise<Array>} All runs
     */
    async getAllRuns() {
        const runs = await this._loadRuns();
        // A copy: the list held here is what the next save appends to, and a
        // caller that sorted or spliced the live one would reorder the store
        return runs ? [...runs] : [];
    }

    /**
     * Remove the run(s) recorded at a timestamp.
     * @param {string} timestamp - The run's ISO timestamp, as stored
     * @returns {Promise<boolean>} Whether the write landed
     */
    async deleteRun(timestamp) {
        const allRuns = await this._loadRuns();
        if (!allRuns) return false;
        this._index(allRuns.filter((r) => r.timestamp !== timestamp));
        return this._persist(true);
    }

    /**
     * Forget every stored run.
     * @returns {Promise<boolean>} Whether the write landed
     */
    async clearAllRuns() {
        this._index([]);
        return this._persist(true);
    }

    /**
     * Every run, or only the ones this character recorded.
     *
     * @param {string} [filterCharacter] - 'mine' (default) or 'all'
     * @returns {Promise<Array>} Runs
     */
    async getRunsForCharacter(filterCharacter = 'mine') {
        return filterRunsForCharacter(await this.getAllRuns(), filterCharacter, currentCharacter());
    }

    /**
     * Remove runs whose duration is more than 3× the median for their dungeon+team group.
     * Only scrubs groups with at least 5 runs (not enough data below that to be confident).
     * @returns {Promise<number>} Number of runs removed
     */
    async scrubOutlierRuns() {
        const allRuns = await this.getAllRuns();
        if (allRuns.length === 0) return 0;

        // Group by dungeonName + teamKey
        const groups = new Map();
        for (let i = 0; i < allRuns.length; i++) {
            const run = allRuns[i];
            const key = `${run.dungeonName}||${run.teamKey}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ run, index: i });
        }

        const outlierIndices = new Set();

        for (const [groupKey, entries] of groups) {
            if (entries.length < 5) continue;

            const durations = entries
                .map((e) => e.run.duration || e.run.totalTime || 0)
                .filter((d) => d > 0)
                .sort((a, b) => a - b);

            if (durations.length < 5) continue;

            const mid = Math.floor(durations.length / 2);
            const median = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];

            const threshold = median * 3;

            for (const { run, index } of entries) {
                const duration = run.duration || run.totalTime || 0;
                if (duration > threshold) {
                    outlierIndices.add(index);
                    console.warn(
                        `[DungeonTrackerStorage] Scrubbing outlier run: ${groupKey} ` +
                            `duration=${Math.round(duration)}s median=${Math.round(median)}s threshold=${Math.round(threshold)}s`
                    );
                }
            }
        }

        if (outlierIndices.size === 0) return 0;

        const cleaned = allRuns.filter((_, i) => !outlierIndices.has(i));
        this._index(cleaned);
        await this._persist(true);
        console.log(`[DungeonTrackerStorage] Scrubbed ${outlierIndices.size} outlier run(s) from storage`);
        return outlierIndices.size;
    }

    /**
     * Get runs filtered by dungeon and/or team
     * @param {Object} filters - Filter options
     * @param {string} filters.dungeonName - Filter by dungeon name (optional)
     * @param {string} filters.teamKey - Filter by team key (optional)
     * @returns {Promise<Array>} Filtered runs
     */
    async getFilteredRuns(filters = {}) {
        const allRuns = await this.getAllRuns();

        let filtered = allRuns;

        if (filters.dungeonName && filters.dungeonName !== 'all') {
            filtered = filtered.filter((r) => r.dungeonName === filters.dungeonName);
        }

        if (filters.teamKey && filters.teamKey !== 'all') {
            filtered = filtered.filter((r) => r.teamKey === filters.teamKey);
        }

        return filtered;
    }

    /**
     * Get all teams with stored runs
     * @returns {Promise<Array>} Array of {teamKey, runCount, avgTime, bestTime, worstTime}
     */
    async getAllTeamStats() {
        const allRuns = await this.getAllRuns();

        // Group by teamKey
        const teamGroups = {};
        for (const run of allRuns) {
            if (!run.teamKey) continue; // Skip solo runs (no team)

            if (!teamGroups[run.teamKey]) {
                teamGroups[run.teamKey] = [];
            }
            teamGroups[run.teamKey].push(run);
        }

        // Calculate stats for each team
        const results = [];
        for (const [teamKey, runs] of Object.entries(teamGroups)) {
            const durations = runs.map((r) => r.duration);
            const avgTime = durations.reduce((a, b) => a + b, 0) / durations.length;
            const bestTime = Math.min(...durations);
            const worstTime = Math.max(...durations);

            results.push({
                teamKey,
                runCount: runs.length,
                avgTime,
                bestTime,
                worstTime,
            });
        }

        return results;
    }
}

const dungeonTrackerStorage = new DungeonTrackerStorage();

export default dungeonTrackerStorage;
