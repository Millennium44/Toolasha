/**
 * The Iron Cow money plan, as a checklist that ticks itself.
 *
 * ## The plan, verbatim
 *
 * This is the standard route an iron cow takes to farming gold for cowbells,
 * pinned here so the panel and the tests are arguing about the same thing:
 *
 *  1. Milking, Woodcutting and Cheesesmithing to 80 — craft your own tools on
 *     the way, and the beginner achievement pays +2% gathering.
 *  2. Foraging to 80, which is what opens Star Fruit.
 *  3. Level Alchemy on whatever junk gives the most experience.
 *  4. Crafting to 34, out of the resources you kept.
 *  5. Craft the Necklace of Efficiency, the Ring of Gathering and the Earrings
 *     of Gathering.
 *     Optional: the Garden and Laboratory house rooms; enhance tools and jewelry.
 *  6. Then the endless loop: forage Star Fruit → decompose the fruit itself (not
 *     the asteroid belt) → coinify the foraging essence → repeat. It needs three
 *     action-queue slots and about sixteen hours of offline time, and alchemy
 *     costs gold, so keep a few million buffered.
 *
 * ## Why the stages derive rather than get ticked
 *
 * A checklist you tick by hand is a checklist that is wrong the moment you play
 * on another device. Every stage here that the character's own state can answer
 * — skill levels, jewelry held or worn, house rooms built — answers itself, and
 * the stored overrides only exist for the one stage nothing can measure ("level
 * alchemy" has no number in the plan; it gets one here, see `alchemyTarget`).
 * A derived `done` always wins over a stored tick, so a manual tick can never
 * make the panel lie about a level you have not got.
 */

import dataManager from '../../core/data-manager.js';
import { resolveLoopItems } from './loop-items.js';

/** Where stages 1 and 2 stop */
export const GATHERING_TARGET = 80;

/** Where stage 4 stops — enough Crafting for the three pieces of jewelry */
export const CRAFTING_TARGET = 34;

/**
 * Alchemy's target when game data cannot say.
 *
 * The real target is the higher of the two item levels the loop touches (see
 * `resolveLoopItems`); this is only what the plan falls back to before init
 * data has arrived, and it is labelled as an assumption on screen.
 */
export const ASSUMED_ALCHEMY_TARGET = 65;

const SKILL_HRIDS = {
    milking: '/skills/milking',
    woodcutting: '/skills/woodcutting',
    cheesesmithing: '/skills/cheesesmithing',
    foraging: '/skills/foraging',
    alchemy: '/skills/alchemy',
    crafting: '/skills/crafting',
};

/**
 * The three pieces stage 5 crafts.
 *
 * Spellings the game has plausibly used are listed together; a piece counts as
 * had when any of them is held or worn.
 */
export const JEWELRY = [
    { label: 'Necklace of Efficiency', candidates: ['/items/necklace_of_efficiency'] },
    { label: 'Ring of Gathering', candidates: ['/items/ring_of_gathering'] },
    {
        label: 'Earrings of Gathering',
        candidates: ['/items/earrings_of_gathering', '/items/earring_of_gathering'],
    },
];

/** The two optional rooms, both of which pay the loop directly */
export const HOUSE_ROOMS = [
    { label: 'Garden', hrid: '/house_rooms/garden', why: 'foraging efficiency' },
    { label: 'Laboratory', hrid: '/house_rooms/laboratory', why: 'alchemy efficiency' },
];

/** Game modes that are an iron cow, however the game spells it */
const IRONCOW_MODE = /ironcow/i;

/**
 * Whether a game mode string is an iron cow.
 * @param {string|null|undefined} gameMode - `character.gameMode`
 * @returns {boolean} True for `ironcow` and `legacy_ironcow`
 */
export function isIronCowMode(gameMode) {
    return typeof gameMode === 'string' && IRONCOW_MODE.test(gameMode);
}

/**
 * Everything the plan reads off the character, in one snapshot.
 *
 * Taken as a snapshot rather than read stage by stage so the tests can hand the
 * derivation a fixture character instead of a mocked game, and so a render
 * cannot show two stages disagreeing about the same skill.
 *
 * @returns {Object} `{levels, held, rooms, coins, queueLength, gameMode, alchemyTarget, alchemyTargetAssumed}`
 */
export function readCharacterState() {
    const skills = dataManager.getSkills() || [];
    const levels = {};
    for (const [name, hrid] of Object.entries(SKILL_HRIDS)) {
        levels[name] = skills.find((skill) => skill.skillHrid === hrid)?.level || 0;
    }

    const inventory = dataManager.getInventory() || [];

    // Held or worn are the same thing to this plan: a crafted necklace counts
    // whether or not it happens to be in the slot right now.
    const held = new Set();
    for (const item of inventory) {
        if ((item?.count || 0) > 0 && item.itemHrid) held.add(item.itemHrid);
    }
    for (const item of dataManager.getEquipment()?.values() || []) {
        if (item?.itemHrid) held.add(item.itemHrid);
    }

    const rooms = {};
    for (const room of HOUSE_ROOMS) {
        rooms[room.hrid] = dataManager.getHouseRoomLevel?.(room.hrid) || 0;
    }

    const coinEntry = inventory.find((item) => item?.itemHrid === '/items/coin');
    const loopItems = resolveLoopItems();

    return {
        levels,
        held,
        rooms,
        coins: coinEntry?.count || 0,
        queueLength: (dataManager.getCurrentActions?.() || []).length,
        gameMode: dataManager.getCurrentCharacterGameMode?.() || null,
        alchemyTarget: loopItems?.alchemyTarget ?? ASSUMED_ALCHEMY_TARGET,
        alchemyTargetAssumed: !loopItems,
    };
}

/**
 * How far a levelling stage has got.
 * @param {Object} levels - Skill name → level
 * @param {Array<string>} names - Which skills the stage covers
 * @param {number} target - The level it wants
 * @returns {{done: boolean, parts: Array<{label: string, level: number, done: boolean}>}}
 */
function levelStage(levels, names, target) {
    const parts = names.map((name) => ({
        label: `${name[0].toUpperCase()}${name.slice(1)}`,
        level: levels[name] || 0,
        target,
        done: (levels[name] || 0) >= target,
    }));
    return { done: parts.every((part) => part.done), parts };
}

/**
 * The plan, with each stage answered against a character.
 *
 * Every stage carries a `done` it derived itself and a `detail` line saying what
 * it looked at, so a stage that is not ticked says why without needing a second
 * click. `overrides` can only ever tick a stage that has nothing to measure —
 * see the module doc.
 *
 * @param {Object} state - From `readCharacterState`
 * @param {Object} [overrides] - Stage id → true, for stages nothing can measure
 * @returns {Array<Object>} Stages in plan order
 */
export function deriveStages(state, overrides = {}) {
    const levels = state?.levels || {};
    const held = state?.held || new Set();
    const rooms = state?.rooms || {};
    const alchemyTarget = state?.alchemyTarget ?? ASSUMED_ALCHEMY_TARGET;

    const tools = levelStage(levels, ['milking', 'woodcutting', 'cheesesmithing'], GATHERING_TARGET);
    const foraging = levelStage(levels, ['foraging'], GATHERING_TARGET);
    const crafting = levelStage(levels, ['crafting'], CRAFTING_TARGET);

    const alchemyLevel = levels.alchemy || 0;
    const alchemyDone = alchemyLevel >= alchemyTarget;

    const jewelry = JEWELRY.map((piece) => ({
        label: piece.label,
        done: piece.candidates.some((hrid) => held.has(hrid)),
    }));

    const houseRooms = HOUSE_ROOMS.map((room) => ({
        label: room.label,
        why: room.why,
        level: rooms[room.hrid] || 0,
        done: (rooms[room.hrid] || 0) > 0,
    }));

    const stages = [
        {
            id: 'tools',
            number: 1,
            title: `Milking, Woodcutting, Cheesesmithing to ${GATHERING_TARGET}`,
            detail: 'Craft your own tools on the way. The beginner achievement pays +2% gathering.',
            done: tools.done,
            parts: tools.parts,
        },
        {
            id: 'foraging',
            number: 2,
            title: `Foraging to ${GATHERING_TARGET}`,
            detail: 'What opens Star Fruit, and with it the loop.',
            done: foraging.done,
            parts: foraging.parts,
        },
        {
            id: 'alchemy',
            number: 3,
            title: `Alchemy to ${alchemyTarget}`,
            detail: state?.alchemyTargetAssumed
                ? `Level it on whatever junk gives the most experience. ${alchemyTarget} is assumed — ` +
                  'game data has not loaded, so the loop items could not be read.'
                : 'Level it on whatever junk gives the most experience. Below this level alchemy takes an ' +
                  "under-level penalty on the loop's own items.",
            done: alchemyDone,
            parts: [{ label: 'Alchemy', level: alchemyLevel, target: alchemyTarget, done: alchemyDone }],
        },
        {
            id: 'crafting',
            number: 4,
            title: `Crafting to ${CRAFTING_TARGET}`,
            detail: 'Out of the resources you kept. Enough for the three pieces below.',
            done: crafting.done,
            parts: crafting.parts,
        },
        {
            id: 'jewelry',
            number: 5,
            title: 'Craft the gathering jewelry',
            detail: 'Held or worn both count.',
            done: jewelry.every((piece) => piece.done),
            parts: jewelry,
        },
        {
            id: 'rooms',
            number: 5,
            optional: true,
            title: 'Optional: Garden and Laboratory',
            detail: 'Both pay the loop directly. Enhancing tools and jewelry is the other optional.',
            done: houseRooms.every((room) => room.done),
            parts: houseRooms,
        },
    ];

    // The loop wants Star Fruit and an alchemist who is not being penalised for
    // it. The jewelry and the rooms make it pay better; they do not gate it.
    const ready = foraging.done && alchemyDone;
    stages.push({
        id: 'loop',
        number: 6,
        title: 'The endless loop',
        detail: 'Forage Star Fruit → decompose the fruit → coinify the essence → repeat.',
        done: false,
        ready,
        blockedBy: ready
            ? []
            : [
                  ...(foraging.done ? [] : [`Foraging ${levels.foraging || 0}/${GATHERING_TARGET}`]),
                  ...(alchemyDone ? [] : [`Alchemy ${alchemyLevel}/${alchemyTarget}`]),
              ],
        parts: [],
    });

    return stages.map((stage) => ({
        ...stage,
        // A stored tick can add a done, never remove one the state derived.
        done: stage.done || (stage.id !== 'loop' && overrides?.[stage.id] === true),
        derived: stage.done,
    }));
}
