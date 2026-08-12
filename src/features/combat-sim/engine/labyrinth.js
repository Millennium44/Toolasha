import Monster from './monster.js';
import { getGameData } from './game-data.js';

const LABYRINTH_TIMEOUT = 120 * 1e9; // 120 seconds in nanoseconds

/**
 * Labyrinth encounter manager.
 * Each encounter is a single monster at a given roomLevel.
 * Timeout (120s) or player death = loss; enemy killed = win.
 */
class Labyrinth {
    constructor(monsterHrid, roomLevel, crateHrids = [], liveState = null, fullAbilities = false) {
        this.monsterHrid = monsterHrid;
        this.hrid = monsterHrid;
        this.roomLevel = roomLevel;
        // Whether the monster is built with its full ability kit rather than only
        // the abilities available at difficultyTier 0 (see Monster)
        this.fullAbilities = fullAbilities === true;
        this.buffs = [];
        this.attemptCount = 0;
        this.encounterStartTime = 0;
        /**
         * A fight already under way, replayed from where it stands: health
         * fractions for both sides and how much of the timer is gone. Set only
         * for a conditional estimate — normally an encounter starts clean.
         */
        this.liveState = liveState;

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
        return [new Monster(this.monsterHrid, 0, this.roomLevel, this.fullAbilities)];
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
