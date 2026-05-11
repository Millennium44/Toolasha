import Monster from './monster.js';
import { getGameData } from './game-data.js';

const LABYRINTH_TIMEOUT = 120 * 1e9; // 120 seconds in nanoseconds

/**
 * Labyrinth encounter manager.
 * Each encounter is a single monster at a given roomLevel.
 * Timeout (120s) or player death = loss; enemy killed = win.
 */
class Labyrinth {
    constructor(monsterHrid, roomLevel, crateHrids = []) {
        this.monsterHrid = monsterHrid;
        this.hrid = monsterHrid;
        this.roomLevel = roomLevel;
        this.buffs = [];
        this.attemptCount = 0;
        this.encounterStartTime = 0;

        // Resolve crate buffs from game data
        if (crateHrids.length > 0) {
            const gameData = getGameData();
            const crateMap = gameData.labyrinthCrateDetailMap;
            if (crateMap) {
                for (const hrid of crateHrids) {
                    if (crateMap[hrid]) {
                        this.buffs = this.buffs.concat(crateMap[hrid]);
                    }
                }
            }
        }
    }

    /**
     * Spawn a new monster for the next encounter.
     * @returns {Monster[]} Single-element array with the scaled monster
     */
    getMonster() {
        this.attemptCount++;
        return [new Monster(this.monsterHrid, 0, this.roomLevel)];
    }

    /**
     * Record when a new encounter begins.
     * @param {number} time - Current simulation time in nanoseconds
     */
    updateEncounterStartTime(time) {
        this.encounterStartTime = time;
    }

    /**
     * Check if the current encounter has exceeded the 120s timeout.
     * @param {number} currentTime - Current simulation time in nanoseconds
     * @returns {boolean}
     */
    checkTimeout(currentTime) {
        return currentTime - this.encounterStartTime > LABYRINTH_TIMEOUT;
    }
}

export default Labyrinth;
