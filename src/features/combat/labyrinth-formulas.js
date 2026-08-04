/**
 * Labyrinth Formulas
 *
 * The game's own labyrinth arithmetic, in one place and free of state: the
 * room timings a skilling or enhancing attempt is measured against, the
 * upgrade steps, the grid size of a floor, what each kind of room pays, and
 * the throughput a room works out to once the walk to it is paid for.
 */

/**
 * Walking to a room, in seconds.
 *
 * A room costs the walk to it plus the time spent in it, and retries happen
 * where you already stand, so this is paid once per room however many attempts
 * it takes. Both the forecast (`roomXpPerHour` below) and the measurement
 * (`floorSummary` in labyrinth-room-logs.js) charge it, which is the only reason
 * the two experience-per-hour figures can be read side by side — they were one
 * second per room apart for a while, which is small per room and not small over
 * a floor of fast rooms.
 */
export const ROOM_TRAVEL_SECONDS = 1;

/** A labyrinth room runs for two minutes, however many attempts fit inside it */
export const ROOM_DURATION = 120;
export const BASE_SKILLING_TIME = 10;
export const BASE_ENHANCING_TIME = 8;
export const UPGRADE_STEP = 0.01;
export const UPGRADE_SUCCESS_STEP = 0.005;
export const UPGRADE_MAX_LEVEL = 12;

/**
 * How far either side of the character's own level the skip-threshold searches
 * look. Room level is `effectiveLevel + skip - 1`, so this is the whole range
 * of rooms a character could be sent to. Shared with the Lab Sim "Find Max"
 * search so the two answer the same question over the same window — Find Max
 * used to search a fixed 20–300, which stopped short for a high-level character
 * and wasted probes below the floor for a low-level one.
 */
export const SKIP_THRESHOLD_RANGE = 300;

/**
 * Clamp a labyrinth skilling/enhancing success rate to the game's bounds:
 * SkillingSuccessRate = MAX(5%, 0.80 * (1 + LevelBonus + Buffs)), capped at 100%
 * @param {number} v - Raw success rate
 * @returns {number}
 */
export function clampSuccessChance(v) {
    return Math.min(1, Math.max(0.05, v));
}

/**
 * The side length of a floor's square room grid: GridSize = MIN(3 + Floor, 8).
 *
 * Only a fallback — the live grid's own width is authoritative and is used
 * whenever `roomData` has rows. This is for the moment before the first floor
 * payload lands, so nothing has to guess.
 *
 * @param {number} floor - Labyrinth floor number
 * @returns {number} Rooms per side, 0 below floor 1
 */
export function labyrinthGridSize(floor) {
    const f = Math.max(0, Math.floor(Number(floor) || 0));
    if (f < 1) return 0;
    return Math.min(3 + f, 8);
}

/**
 * What a labyrinth room pays out, per the game's own drop tables.
 *
 * Three kinds of room pay, and they pay on entirely different schedules:
 *
 * - A **challenge** room (combat, skilling or enhancing) rolls one token at
 *   MIN(Floor×5%, 50%) and one Purdora's Box at MIN(Floor×1%, 10%). The box
 *   follows the room: a combat room drops the Combat box, everything else the
 *   Skilling box.
 * - A **treasure** room always pays MIN(Floor, 10) tokens, and rolls one box
 *   of *each* type at MIN(Floor×5%, 50%).
 * - The **floor exit** always pays 5×Floor tokens; from floor 4 it always
 *   pays both box types, averaging (Floor−3)/2 each; from floor 6 it always
 *   pays a Refinement Chest, averaging (Floor−4)/2.
 *
 * Returned as expected quantities so a caller can add them up or weight them
 * without caring which of the above was a chance and which was a count.
 *
 * @param {number} floor - Labyrinth floor number
 * @param {string} kind - 'combat' | 'skilling' | 'enhancing' | 'treasure' | 'exit'
 * @returns {{tokens: number, skillingBoxes: number, combatBoxes: number, refinementChests: number}}
 */
export function labyrinthRoomRewards(floor, kind) {
    const f = Math.max(0, Math.floor(Number(floor) || 0));
    const rewards = { tokens: 0, skillingBoxes: 0, combatBoxes: 0, refinementChests: 0 };
    if (f < 1) return rewards;

    if (kind === 'treasure') {
        rewards.tokens = Math.min(f, 10);
        const boxChance = Math.min(f * 0.05, 0.5);
        rewards.skillingBoxes = boxChance;
        rewards.combatBoxes = boxChance;
        return rewards;
    }

    if (kind === 'exit') {
        rewards.tokens = 5 * f;
        if (f >= 4) {
            const boxes = (f - 3) / 2;
            rewards.skillingBoxes = boxes;
            rewards.combatBoxes = boxes;
        }
        if (f >= 6) rewards.refinementChests = (f - 4) / 2;
        return rewards;
    }

    rewards.tokens = Math.min(f * 0.05, 0.5);
    const boxChance = Math.min(f * 0.01, 0.1);
    if (kind === 'combat') rewards.combatBoxes = boxChance;
    else rewards.skillingBoxes = boxChance;
    return rewards;
}

/**
 * A room's experience per hour, once the walk to it is paid for.
 *
 * Charged once per room rather than once per attempt: back-to-back retries
 * happen where you are already standing, so failing a room five times still
 * only involves walking to it once. `expectedSeconds` covers the attempts
 * themselves, which is why the two are separate terms.
 *
 * Shared by fights and skilling rooms so their figures can be read side by
 * side. They were computed differently for a while, and two numbers in one
 * panel measuring different things is worse than either convention.
 *
 * @param {number} xpPerRoom - What clearing the room awards
 * @param {number} expectedSeconds - Expected time in the room to get one clear
 * @param {number} clearChance - 0..1
 * @returns {number} Experience per hour, 0 when the room is never cleared
 */
export function roomXpPerHour(xpPerRoom, expectedSeconds, clearChance) {
    if (!(xpPerRoom > 0) || !(clearChance > 0)) return 0;
    if (!Number.isFinite(expectedSeconds) || expectedSeconds <= 0) return 0;
    return (xpPerRoom * 3600) / (expectedSeconds + ROOM_TRAVEL_SECONDS);
}
