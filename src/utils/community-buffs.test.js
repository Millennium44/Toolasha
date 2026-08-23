/**
 * Tests for the shared community buff helper.
 *
 * Four places used to work out a community buff's strength, two of them with the
 * coefficients typed in and a hand-written list of which skills the buff touched.
 * What matters here is that the answer comes from game data every time: change the
 * client's numbers or its skill list and the helper follows, without an edit.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ buffLevels: {}, buffDetails: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getCommunityBuffLevel: (hrid) => game.buffLevels[hrid] || 0,
        getInitClientData: () => ({ communityBuffTypeDetailMap: game.buffDetails }),
    },
}));

const { getCommunityBuffBonus, getCommunityProductionEfficiency, getCommunityGatheringQuantity } =
    await import('./community-buffs.js');

const PRODUCTION = '/community_buff_types/production_efficiency';
const GATHERING = '/community_buff_types/gathering_quantity';

beforeEach(() => {
    game.buffLevels = {};
    game.buffDetails = {
        [PRODUCTION]: {
            buff: { flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
            usableInActionTypeMap: { '/action_types/cooking': true, '/action_types/alchemy': true },
        },
        [GATHERING]: {
            buff: { flatBoost: 0.2, flatBoostLevelBonus: 0.005 },
            usableInActionTypeMap: { '/action_types/milking': true },
        },
    };
});

describe('getCommunityBuffBonus', () => {
    test('is flatBoost at level 1 and adds flatBoostLevelBonus per level after', () => {
        game.buffLevels[PRODUCTION] = 1;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking')).toBeCloseTo(0.14, 9);

        game.buffLevels[PRODUCTION] = 2;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking')).toBeCloseTo(0.143, 9);

        game.buffLevels[PRODUCTION] = 20;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking')).toBeCloseTo(0.197, 9);
    });

    test('an inactive buff is nothing, not its level-1 strength', () => {
        game.buffLevels[PRODUCTION] = 0;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking')).toBe(0);
    });

    test('a skill the buff does not list gets nothing from it', () => {
        game.buffLevels[PRODUCTION] = 5;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/milking')).toBe(0);
    });

    test('the skill list is the game data, so a new skill needs no edit here', () => {
        game.buffLevels[PRODUCTION] = 1;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/woodcutting')).toBe(0);

        game.buffDetails[PRODUCTION].usableInActionTypeMap['/action_types/woodcutting'] = true;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/woodcutting')).toBeCloseTo(0.14, 9);
    });

    test('rebalanced coefficients are followed rather than remembered', () => {
        game.buffLevels[PRODUCTION] = 3;
        game.buffDetails[PRODUCTION].buff = { flatBoost: 0.1, flatBoostLevelBonus: 0.01 };
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking')).toBeCloseTo(0.12, 9);
    });

    test('an unknown buff, or no game data at all, is 0 rather than a guess', () => {
        game.buffLevels['/community_buff_types/nonsense'] = 5;
        expect(getCommunityBuffBonus('/community_buff_types/nonsense', '/action_types/cooking')).toBe(0);

        game.buffLevels[PRODUCTION] = 5;
        game.buffDetails = {};
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking')).toBe(0);
    });

    test('a level can be supplied, for simulating a buff the character does not have', () => {
        game.buffLevels[PRODUCTION] = 0;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking', { level: 11 })).toBeCloseTo(0.17, 9);
    });

    test('asPercent scales by 100, for the efficiency stack', () => {
        game.buffLevels[PRODUCTION] = 1;
        expect(getCommunityBuffBonus(PRODUCTION, '/action_types/cooking', { asPercent: true })).toBeCloseTo(14, 9);
    });

    test('with no action type the buff is read without the skill check', () => {
        game.buffLevels[PRODUCTION] = 1;
        expect(getCommunityBuffBonus(PRODUCTION, null)).toBeCloseTo(0.14, 9);
    });
});

describe('the named wrappers', () => {
    test('production efficiency is a percentage, gathering quantity a fraction', () => {
        game.buffLevels[PRODUCTION] = 2;
        game.buffLevels[GATHERING] = 2;

        expect(getCommunityProductionEfficiency('/action_types/cooking')).toBeCloseTo(14.3, 9);
        expect(getCommunityGatheringQuantity('/action_types/milking')).toBeCloseTo(0.205, 9);
    });

    test('each checks its own skill list', () => {
        game.buffLevels[PRODUCTION] = 5;
        game.buffLevels[GATHERING] = 5;

        expect(getCommunityProductionEfficiency('/action_types/milking')).toBe(0);
        expect(getCommunityGatheringQuantity('/action_types/cooking')).toBe(0);
    });
});
