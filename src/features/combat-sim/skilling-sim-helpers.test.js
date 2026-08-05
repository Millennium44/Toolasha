/**
 * What the editor's state means to a labyrinth skilling room.
 *
 * Two things are worth pinning down here. The first is that the community buffs
 * reach the room *at all*: the Experience buff has been on the DTO since the
 * adapter was written and was dropped on the floor on the way in, so every
 * XP-per-room figure the skilling tab printed — including the baseline the
 * Experience token and the Scholar shrine are ranked against — was computed as
 * though the server's most permanently-running buff were switched off.
 *
 * The second is which buffs are worth *simulating*. A candidate that cannot move
 * the room being run is a room evaluation spent proving +0.00% and a row that
 * reads as a considered verdict rather than a question nobody asked.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ initData: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initData,
    },
}));

const {
    buildCommunityBuffsForSkill,
    generateSkillingCommunityBuffCandidates,
    buildEquipmentBuffsForSkill,
    MAX_COMMUNITY_BUFF_LEVEL,
} = await import('./skilling-sim-helpers.js');

/** Every buff running, so a test only has to say which one it is asking about. */
const ALL_BUFFS = { productionEfficiency: 5, enhancingSpeed: 5, gatheringQuantity: 3, experience: 7 };

const typesFor = (levels, actionTypeHrid) => buildCommunityBuffsForSkill(levels, actionTypeHrid).map((b) => b.typeHrid);
const keysFor = (levels, actionTypes) =>
    generateSkillingCommunityBuffCandidates(levels, actionTypes).map((c) => c.buffKey);
const candidateFor = (levels, actionTypes, buffKey) =>
    generateSkillingCommunityBuffCandidates(levels, actionTypes).find((c) => c.buffKey === buffKey);

beforeEach(() => {
    game.initData = null;
});

describe('the community buffs a room is actually run under', () => {
    test('production efficiency reaches a production room', () => {
        expect(typesFor(ALL_BUFFS, '/action_types/cooking')).toContain('/buff_types/efficiency');
    });

    test('and not a gathering one', () => {
        expect(typesFor(ALL_BUFFS, '/action_types/milking')).not.toContain('/buff_types/efficiency');
    });

    test('gathering quantity reaches a gathering room, where it is the double-progress chance', () => {
        expect(typesFor(ALL_BUFFS, '/action_types/foraging')).toContain('/buff_types/gathering');
        expect(typesFor(ALL_BUFFS, '/action_types/cooking')).not.toContain('/buff_types/gathering');
    });

    test('enhancing speed reaches the enhancing room alone', () => {
        expect(typesFor(ALL_BUFFS, '/action_types/enhancing')).toContain('/buff_types/action_speed');
        expect(typesFor(ALL_BUFFS, '/action_types/brewing')).not.toContain('/buff_types/action_speed');
    });

    test('the Experience buff reaches every room, which it never used to reach any of', () => {
        // The bug this file exists for: the level was read off the character,
        // carried on the DTO, and then never turned into a `/buff_types/wisdom`
        // — so the tab's XP baseline was the one with the buff switched off
        for (const actionType of ['/action_types/cooking', '/action_types/milking', '/action_types/enhancing']) {
            expect(typesFor(ALL_BUFFS, actionType)).toContain('/buff_types/wisdom');
        }
    });

    test('a buff that is not running contributes nothing', () => {
        expect(
            buildCommunityBuffsForSkill({ productionEfficiency: 0, experience: 0 }, '/action_types/cooking')
        ).toEqual([]);
        expect(buildCommunityBuffsForSkill(null, '/action_types/cooking')).toEqual([]);
    });

    test('a level is worth its base plus one step per level past the first', () => {
        const [buff] = buildCommunityBuffsForSkill({ productionEfficiency: 5 }, '/action_types/cooking');

        expect(buff.flatBoost).toBeCloseTo(0.14 + 4 * 0.003, 10);
    });

    test('and the game data wins over the constants when it has loaded', () => {
        game.initData = {
            communityBuffTypeDetailMap: {
                '/community_buff_types/production_efficiency': {
                    name: 'Production Efficiency',
                    buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.5, flatBoostLevelBonus: 0.1 },
                    usableInActionTypeMap: { '/action_types/cooking': true },
                },
            },
        };

        const [buff] = buildCommunityBuffsForSkill({ productionEfficiency: 3 }, '/action_types/cooking');

        expect(buff.flatBoost).toBeCloseTo(0.5 + 2 * 0.1, 10);
    });

    test('including its own answer to which skills a buff is for', () => {
        // `usableInActionTypeMap` is the game's list rather than one kept here,
        // so a rebalance that moves a buff does not leave this a patch behind
        game.initData = {
            communityBuffTypeDetailMap: {
                '/community_buff_types/production_efficiency': {
                    buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
                    usableInActionTypeMap: { '/action_types/milking': true },
                },
            },
        };

        expect(typesFor({ productionEfficiency: 5 }, '/action_types/milking')).toContain('/buff_types/efficiency');
        expect(typesFor({ productionEfficiency: 5 }, '/action_types/cooking')).not.toContain('/buff_types/efficiency');
    });
});

describe('which community buffs are worth a simulation', () => {
    test('a Cooking run is not offered the gathering buff', () => {
        // It is the double-progress chance of a Foraging room and nothing at all
        // in a Cooking one, so the row could only ever come back +0.00%
        expect(keysFor(ALL_BUFFS, ['/action_types/cooking'])).not.toContain('gatheringQuantity');
    });

    test('a Foraging run is', () => {
        expect(keysFor(ALL_BUFFS, ['/action_types/foraging'])).toContain('gatheringQuantity');
    });

    test('production efficiency goes to the production skills only', () => {
        expect(keysFor(ALL_BUFFS, ['/action_types/cooking'])).toContain('productionEfficiency');
        expect(keysFor(ALL_BUFFS, ['/action_types/woodcutting'])).not.toContain('productionEfficiency');
    });

    test('enhancing speed goes to the enhancing room, and efficiency does not', () => {
        // An enhancing room clears on success rate and speed;
        // `computeEnhancingClearWithParams` never reads the efficiency term
        const keys = keysFor(ALL_BUFFS, ['/action_types/enhancing']);

        expect(keys).toContain('enhancingSpeed');
        expect(keys).not.toContain('productionEfficiency');
    });

    test('the Experience buff is offered wherever a room pays XP, which is everywhere', () => {
        expect(keysFor(ALL_BUFFS, ['/action_types/cooking'])).toContain('experience');
        expect(keysFor(ALL_BUFFS, ['/action_types/enhancing'])).toContain('experience');
    });

    test('a run over every skill pools what any of them can feel', () => {
        const keys = keysFor(ALL_BUFFS, ['/action_types/cooking', '/action_types/foraging', '/action_types/enhancing']);

        expect(keys).toEqual(
            expect.arrayContaining(['productionEfficiency', 'enhancingSpeed', 'gatheringQuantity', 'experience'])
        );
    });

    test('a run over nothing offers nothing', () => {
        expect(generateSkillingCommunityBuffCandidates(ALL_BUFFS, [])).toEqual([]);
    });
});

describe('the level a community buff is offered at', () => {
    test('the cap is twenty, which is what the game calls max', () => {
        expect(MAX_COMMUNITY_BUFF_LEVEL).toBe(20);
    });

    test('a buff at the cap has no next level to donate for, so it gets no row', () => {
        const keys = keysFor({ ...ALL_BUFFS, experience: 20 }, ['/action_types/cooking']);

        expect(keys).not.toContain('experience');
        expect(keys).toContain('productionEfficiency');
    });

    test('one below the cap still does', () => {
        expect(keysFor({ experience: 19 }, ['/action_types/cooking'])).toContain('experience');
    });

    test('a buff nobody is running is offered from nothing to its first level', () => {
        const candidate = candidateFor({ experience: 0 }, ['/action_types/enhancing'], 'experience');

        expect(candidate.currentLevel).toBe(0);
        expect(candidate.upgradeLevel).toBe(1);
        expect(candidate.description).toContain('Lv0 → Lv1');
    });
});

describe('what a community buff row carries', () => {
    test('a wisdom level changes what a room pays, not how often it clears', () => {
        const candidate = candidateFor({ experience: 4 }, ['/action_types/cooking'], 'experience');

        expect(candidate.metric).toBe('xpPerRoom');
    });

    test('every other one is read on the clear rate', () => {
        const candidate = candidateFor({ productionEfficiency: 4 }, ['/action_types/cooking'], 'productionEfficiency');

        expect(candidate.metric).toBe('clearRate');
    });

    test('the cowbell rate is the game’s own, and unknown rather than free without it', () => {
        // Cowbells per minute of uptime — the only price a community buff has.
        // The level itself is the whole server's donated minutes, which is why
        // the row carries no gold cost to be ranked on
        expect(candidateFor({ experience: 1 }, ['/action_types/cooking'], 'experience').cowbellCost).toBe(null);

        game.initData = {
            communityBuffTypeDetailMap: {
                '/community_buff_types/experience': {
                    name: 'Experience',
                    buff: { typeHrid: '/buff_types/wisdom', flatBoost: 0.2, flatBoostLevelBonus: 0.005 },
                    cowbellCost: 20,
                },
            },
        };

        expect(candidateFor({ experience: 1 }, ['/action_types/cooking'], 'experience').cowbellCost).toBe(20);
    });

    test('a candidate says what it is, so the panel can put it in its own table', () => {
        const candidate = candidateFor({ experience: 1 }, ['/action_types/cooking'], 'experience');

        expect(candidate.type).toBe('community_buff');
        expect(candidate.buffHrid).toBe('/community_buff_types/experience');
    });
});

describe('the equipment side, which the community buffs sit beside', () => {
    const ITEMS = {
        '/items/pot': {
            equipmentDetail: { type: '/equipment_types/cooking_tool', noncombatStats: { cookingSpeed: 0.2 } },
        },
        '/items/chisel': {
            equipmentDetail: { type: '/equipment_types/crafting_tool', noncombatStats: { craftingSpeed: 0.2 } },
        },
    };

    test('a kit reaches the room as a speed and an efficiency, and nothing else', () => {
        const buffs = buildEquipmentBuffsForSkill(
            { '/equipment_types/cooking_tool': { hrid: '/items/pot', enhancementLevel: 0 } },
            '/action_types/cooking',
            ITEMS
        );

        expect(buffs.map((b) => b.typeHrid)).toEqual(['/buff_types/action_speed']);
    });

    test('so another skill’s tool contributes exactly nothing — which is why it is not simmed', () => {
        const buffs = buildEquipmentBuffsForSkill(
            { '/equipment_types/crafting_tool': { hrid: '/items/chisel', enhancementLevel: 5 } },
            '/action_types/cooking',
            ITEMS
        );

        expect(buffs).toEqual([]);
    });
});

/**
 * Several community buff levels at once.
 *
 * "Gathering Quantity Lv3 → Lv8" is one row and one clear-rate evaluation
 * instead of five, which is the question a player with a donation plan is
 * actually asking. It changes nothing about the cost, because a community buff
 * has no per-level cost to change.
 */
describe('a community buff target level in the skilling tab', () => {
    const GATHERING = ['/action_types/foraging'];

    test('the row spans from where the buff is to where it was asked for', () => {
        const [candidate] = generateSkillingCommunityBuffCandidates({ gatheringQuantity: 3 }, GATHERING, 8).filter(
            (c) => c.buffKey === 'gatheringQuantity'
        );

        expect(candidate).toMatchObject({ currentLevel: 3, upgradeLevel: 8, levelsBought: 5 });
        expect(candidate.description).toContain('Lv3 → Lv8');
    });

    test('a target at or below where it already is falls back to one level up', () => {
        const [candidate] = generateSkillingCommunityBuffCandidates({ gatheringQuantity: 9 }, GATHERING, 4).filter(
            (c) => c.buffKey === 'gatheringQuantity'
        );

        expect(candidate.upgradeLevel).toBe(10);
    });

    test('and the ceiling holds, whatever was typed', () => {
        const [candidate] = generateSkillingCommunityBuffCandidates({ gatheringQuantity: 3 }, GATHERING, 99).filter(
            (c) => c.buffKey === 'gatheringQuantity'
        );

        expect(candidate.upgradeLevel).toBe(MAX_COMMUNITY_BUFF_LEVEL);
    });

    test('no target at all is the one-level-up it has always been', () => {
        const [candidate] = generateSkillingCommunityBuffCandidates({ gatheringQuantity: 3 }, GATHERING).filter(
            (c) => c.buffKey === 'gatheringQuantity'
        );

        expect(candidate.upgradeLevel).toBe(4);
    });
});
