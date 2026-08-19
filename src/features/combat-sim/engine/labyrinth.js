import Monster from './monster.js';
import { getGameData } from './game-data.js';

const LABYRINTH_TIMEOUT = 120 * 1e9; // 120 seconds in nanoseconds

/**
 * Labyrinth encounter manager.
 * Each encounter is a single monster at a given roomLevel.
 * Timeout (120s) or player death = loss; enemy killed = win.
 */
class Labyrinth {
    constructor(monsterHrid, roomLevel, crateHrids = [], liveState = null, fullAbilities = true, options = {}) {
        this.monsterHrid = monsterHrid;
        this.hrid = monsterHrid;
        this.roomLevel = roomLevel;
        /**
         * An isolated fight against ONE zone monster, outside the labyrinth:
         * the monster is built at its zone tier, the player keeps their food,
         * drinks and zone buffs, and no crate or labyrinth buff applies. Used by
         * the monster stat check when it is opened on a regular zone's unit —
         * it used to run the lab's loadout, lab token buffs and no consumables
         * against a zone monster and then report the player "built differently".
         */
        this.zoneFight = options.zoneFight === true;
        this.difficultyTier = Number(options.difficultyTier) || 0;
        // Whether the monster is built with its full ability kit rather than only
        // the abilities available at difficultyTier 0 (see Monster). Defaults ON:
        // the tier-0 subset over-predicts clears, so only an explicit false —
        // a deliberate diagnostic — builds the stripped monster.
        this.fullAbilities = fullAbilities !== false;
        this.buffs = [];
        this.attemptCount = 0;
        // Attempts that actually finished — win, death or timeout. attemptCount
        // rises when a monster spawns, so at any instant the two differ by the
        // one fight still in progress (or by nothing, when the run stopped on
        // the resolving blow itself). Clear rates divide by this, never by
        // attemptCount: subtracting a blanket 1 from attemptCount scored 100.4%
        // when a capped run's last event was the kill.
        this.resolvedCount = 0;
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
        return [new Monster(this.monsterHrid, this.difficultyTier, this.roomLevel, this.fullAbilities)];
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
