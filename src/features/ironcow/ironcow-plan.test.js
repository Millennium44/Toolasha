/**
 * The plan tracker: what a character's own state says about each stage.
 *
 * The game is mocked, not the plan. Each test puts a character in front of it —
 * levels, what they are holding, what they have built — and asserts which
 * stages that character has finished. Nothing here touches a price: the plan is
 * about progress, and the money is `starfruit-loop.test.js`'s subject.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    skills: [],
    inventory: [],
    equipment: new Map(),
    rooms: {},
    actions: [],
    gameMode: 'ironcow',
}));

const loop = vi.hoisted(() => ({ items: null }));

// Owner id → units another plan has already claimed against that item, the
// way `inventory-reservations.js` would answer `effectiveInventory` for real.
// Not the real ledger — that module has its own tests — just enough of its
// contract (bag count, less everyone else's claim, floored at zero) for
// `readCharacterState` to be checked against it honestly.
const reservations = vi.hoisted(() => ({ claimed: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => game.skills,
        getInventory: () => game.inventory,
        getEquipment: () => game.equipment,
        getHouseRoomLevel: (hrid) => game.rooms[hrid] || 0,
        getCurrentActions: () => game.actions,
        getCurrentCharacterGameMode: () => game.gameMode,
    },
}));

vi.mock('./loop-items.js', () => ({ resolveLoopItems: () => loop.items }));

vi.mock('../../utils/inventory-reservations.js', () => ({
    effectiveInventory: (itemHrid) => {
        const raw = game.inventory
            .filter((item) => item?.itemHrid === itemHrid)
            .reduce((sum, item) => sum + (item.count || 0), 0);
        return Math.max(0, raw - (reservations.claimed[itemHrid] || 0));
    },
}));

const STARFRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';

const { deriveStages, readCharacterState, isIronCowMode, GATHERING_TARGET, CRAFTING_TARGET, ASSUMED_ALCHEMY_TARGET } =
    await import('./ironcow-plan.js');

const NECKLACE = '/items/necklace_of_efficiency';
const RING = '/items/ring_of_gathering';
const EARRINGS = '/items/earrings_of_gathering';
const GARDEN = '/house_rooms/garden';
const LABORATORY = '/house_rooms/laboratory';

/**
 * Put a character in front of the plan.
 * @param {Object} levels - Skill name → level
 */
function levelled(levels) {
    game.skills = Object.entries(levels).map(([name, level]) => ({ skillHrid: `/skills/${name}`, level }));
}

/**
 * One stage out of a derivation.
 * @param {Array<Object>} stages - From `deriveStages`
 * @param {string} id - Stage id
 * @returns {Object} The stage
 */
function stage(stages, id) {
    return stages.find((entry) => entry.id === id);
}

beforeEach(() => {
    game.skills = [];
    game.inventory = [];
    game.equipment = new Map();
    game.rooms = {};
    game.actions = [];
    game.gameMode = 'ironcow';
    reservations.claimed = {};
    // The real loop items, as game data would give them: Star Fruit is level 65,
    // the essence it decomposes into is level 40, so alchemy's target is 65.
    loop.items = { alchemyTarget: 65, essencePerDecompose: 2, starfruitHrid: STARFRUIT, essenceHrid: ESSENCE };
});

describe('readCharacterState', () => {
    test('reads levels, gold, queue length and game mode off the character', () => {
        levelled({ milking: 80, foraging: 74, alchemy: 61, crafting: 34 });
        game.inventory = [
            { itemHrid: '/items/coin', count: 12_500_000 },
            { itemHrid: NECKLACE, count: 1 },
        ];
        game.actions = [{ actionHrid: '/actions/alchemy/decompose' }, { actionHrid: '/actions/foraging/star_fruit' }];

        const state = readCharacterState();

        expect(state.levels).toMatchObject({ milking: 80, foraging: 74, alchemy: 61, crafting: 34 });
        expect(state.levels.woodcutting).toBe(0);
        expect(state.coins).toBe(12_500_000);
        expect(state.queueLength).toBe(2);
        expect(state.gameMode).toBe('ironcow');
        expect(state.alchemyTarget).toBe(65);
        expect(state.alchemyTargetAssumed).toBe(false);
        expect(state.held.has(NECKLACE)).toBe(true);
    });

    test('worn jewelry counts the same as jewelry in the bag', () => {
        game.equipment = new Map([['/item_locations/neck', { itemHrid: NECKLACE }]]);
        expect(readCharacterState().held.has(NECKLACE)).toBe(true);
    });

    test('a zero-count inventory row is not something you have', () => {
        game.inventory = [{ itemHrid: RING, count: 0 }];
        expect(readCharacterState().held.has(RING)).toBe(false);
    });

    test('falls back to an assumed alchemy target when game data has not loaded', () => {
        loop.items = null;
        const state = readCharacterState();
        expect(state.alchemyTarget).toBe(ASSUMED_ALCHEMY_TARGET);
        expect(state.alchemyTargetAssumed).toBe(true);
    });

    test('reads how much Star Fruit and foraging essence are on hand', () => {
        game.inventory = [
            { itemHrid: STARFRUIT, count: 1_240 },
            { itemHrid: ESSENCE, count: 3_600 },
        ];
        const state = readCharacterState();
        expect(state.starfruitHeld).toBe(1_240);
        expect(state.essenceHeld).toBe(3_600);
        expect(state.holdingsCredited).toBe(true);
    });

    test('nothing held reads as zero, not undefined', () => {
        game.inventory = [];
        const state = readCharacterState();
        expect(state.starfruitHeld).toBe(0);
        expect(state.essenceHeld).toBe(0);
    });

    test('credits nothing, and says so, when the loop items could not be resolved', () => {
        loop.items = null;
        game.inventory = [{ itemHrid: STARFRUIT, count: 1_240 }];
        const state = readCharacterState();
        expect(state.starfruitHeld).toBe(0);
        expect(state.essenceHeld).toBe(0);
        expect(state.holdingsCredited).toBe(false);
    });

    // Regression: readCharacterState used to read the bag directly
    // (`inventory.find(...).count`), so Star Fruit another plan had already
    // claimed through `inventory-reservations.js` (a goal, a crafting plan, the
    // sell queue) was credited to the Iron Bell walk a second time. That shrinks
    // the forage/decompose legs by stock that is not actually free, and the
    // queue runs dry before the batch the player agreed to is done.
    test('holdings another plan has already claimed are not credited twice', () => {
        game.inventory = [
            { itemHrid: STARFRUIT, count: 1_000 },
            { itemHrid: ESSENCE, count: 2_000 },
        ];
        reservations.claimed[STARFRUIT] = 700;
        reservations.claimed[ESSENCE] = 500;

        const state = readCharacterState();

        expect(state.starfruitHeld).toBe(300);
        expect(state.essenceHeld).toBe(1_500);
    });

    test('a claim larger than the stack never credits a negative amount', () => {
        game.inventory = [{ itemHrid: STARFRUIT, count: 100 }];
        reservations.claimed[STARFRUIT] = 500;

        expect(readCharacterState().starfruitHeld).toBe(0);
    });
});

describe('deriveStages', () => {
    test('a fresh character has finished nothing and the loop is out of reach', () => {
        const stages = deriveStages(readCharacterState());
        expect(stages.filter((entry) => entry.done)).toHaveLength(0);
        expect(stage(stages, 'loop').ready).toBe(false);
        expect(stage(stages, 'loop').blockedBy).toEqual([
            `Foraging 0/${GATHERING_TARGET}`,
            `Alchemy 0/${loop.items.alchemyTarget}`,
        ]);
    });

    test('stage 1 needs all three gathering skills, not just one', () => {
        levelled({ milking: 80, woodcutting: 80, cheesesmithing: 79 });
        let stages = deriveStages(readCharacterState());
        expect(stage(stages, 'tools').done).toBe(false);
        expect(stage(stages, 'tools').parts.map((part) => part.done)).toEqual([true, true, false]);

        levelled({ milking: 80, woodcutting: 80, cheesesmithing: 80 });
        stages = deriveStages(readCharacterState());
        expect(stage(stages, 'tools').done).toBe(true);
    });

    test('stage 2 is Foraging at the gathering target', () => {
        levelled({ foraging: GATHERING_TARGET });
        expect(stage(deriveStages(readCharacterState()), 'foraging').done).toBe(true);
    });

    test("stage 3's target is the loop's own item level, not a guess", () => {
        loop.items = { alchemyTarget: 82, essencePerDecompose: 2 };
        levelled({ alchemy: 81 });
        let stages = deriveStages(readCharacterState());
        expect(stage(stages, 'alchemy').title).toContain('82');
        expect(stage(stages, 'alchemy').done).toBe(false);

        levelled({ alchemy: 82 });
        stages = deriveStages(readCharacterState());
        expect(stage(stages, 'alchemy').done).toBe(true);
    });

    test('stage 4 is Crafting 34', () => {
        levelled({ crafting: CRAFTING_TARGET - 1 });
        expect(stage(deriveStages(readCharacterState()), 'crafting').done).toBe(false);
        levelled({ crafting: CRAFTING_TARGET });
        expect(stage(deriveStages(readCharacterState()), 'crafting').done).toBe(true);
    });

    test('stage 5 wants all three pieces, held or worn', () => {
        game.inventory = [
            { itemHrid: NECKLACE, count: 1 },
            { itemHrid: RING, count: 1 },
        ];
        let stages = deriveStages(readCharacterState());
        expect(stage(stages, 'jewelry').done).toBe(false);
        expect(stage(stages, 'jewelry').parts.map((part) => part.done)).toEqual([true, true, false]);

        game.equipment = new Map([['/item_locations/earrings', { itemHrid: EARRINGS }]]);
        stages = deriveStages(readCharacterState());
        expect(stage(stages, 'jewelry').done).toBe(true);
    });

    test('the house rooms are optional and derive from what is built', () => {
        game.rooms = { [GARDEN]: 3 };
        let stages = deriveStages(readCharacterState());
        expect(stage(stages, 'rooms').optional).toBe(true);
        expect(stage(stages, 'rooms').done).toBe(false);

        game.rooms = { [GARDEN]: 3, [LABORATORY]: 1 };
        stages = deriveStages(readCharacterState());
        expect(stage(stages, 'rooms').done).toBe(true);
    });

    test('the loop opens on Foraging and Alchemy, and jewelry does not gate it', () => {
        levelled({ foraging: GATHERING_TARGET, alchemy: 65 });
        const stages = deriveStages(readCharacterState());
        expect(stage(stages, 'loop').ready).toBe(true);
        expect(stage(stages, 'loop').blockedBy).toEqual([]);
        expect(stage(stages, 'jewelry').done).toBe(false);
    });

    test('the loop names only what it is still waiting on', () => {
        levelled({ foraging: GATHERING_TARGET, alchemy: 40 });
        expect(stage(deriveStages(readCharacterState()), 'loop').blockedBy).toEqual(['Alchemy 40/65']);
    });

    test('a manual tick can add a done, and can never take one away', () => {
        levelled({ crafting: CRAFTING_TARGET });
        const stages = deriveStages(readCharacterState(), { crafting: false, rooms: true });
        // The derivation said crafting was finished; an override cannot unsay it
        expect(stage(stages, 'crafting').done).toBe(true);
        // Nothing had been built, so the tick is what makes the optional stage done
        expect(stage(stages, 'rooms').done).toBe(true);
        expect(stage(stages, 'rooms').derived).toBe(false);
    });

    test('the loop stage is never tickable by hand', () => {
        const stages = deriveStages(readCharacterState(), { loop: true });
        expect(stage(stages, 'loop').done).toBe(false);
    });

    test('survives a state with nothing in it', () => {
        expect(() => deriveStages(null)).not.toThrow();
        expect(deriveStages({}).length).toBeGreaterThan(0);
    });
});

describe('isIronCowMode', () => {
    test('both spellings the game uses count', () => {
        expect(isIronCowMode('ironcow')).toBe(true);
        expect(isIronCowMode('legacy_ironcow')).toBe(true);
    });

    test('anything else does not', () => {
        expect(isIronCowMode('standard')).toBe(false);
        expect(isIronCowMode(null)).toBe(false);
        expect(isIronCowMode(undefined)).toBe(false);
    });
});
