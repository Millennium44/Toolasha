/** @vitest-environment happy-dom */
/**
 * EXP/hr of a ranked skilling action when the profit calculator charged the upgrade item's chain time inside
 * actionsPerHour: the chain's actions are in the same hour, so the XP they teach counts (as in Craft & Enhance).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    profit: {},
    chain: [],
}));

const SKILL = '/skills/cheesesmithing';
const actions = {
    '/actions/cheesesmithing/top': {
        type: '/action_types/cheesesmithing',
        upgradeItemHrid: '/items/mid',
        experienceGain: { skillHrid: SKILL, value: 100 },
    },
    '/actions/cheesesmithing/mid': {
        type: '/action_types/cheesesmithing',
        experienceGain: { skillHrid: SKILL, value: 50 },
    },
    '/actions/crafting/low': {
        type: '/action_types/crafting',
        experienceGain: { skillHrid: '/skills/crafting', value: 999 },
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ actionDetailMap: actions }), getCurrentCharacterId: () => 'c1' },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    gatheringProfit: () => null,
    productionProfit: () => ({ calculateProductionProfit: async () => mocks.profit }),
}));
vi.mock('../../utils/experience-parser.js', () => ({
    // 2x for this skill: a figure that would be 1x if the multiplier were skipped
    calculateExperienceMultiplier: () => ({ totalMultiplier: 2 }),
}));
vi.mock('../../utils/enhancement-pricing.js', () => ({
    getProductionChainActions: () => mocks.chain,
}));

const { evaluateSkillingAction } = await import('./talisman-ranking-view.js');

const base = { profitPerHour: 10, actionsPerHour: 100, efficiencyMultiplier: 1.5 };

beforeEach(() => {
    mocks.chain = ['/actions/cheesesmithing/mid', '/actions/crafting/low'];
    mocks.profit = { ...base };
});

describe('EXP/hr with the upgrade chain', () => {
    test('chain not charged: only the recipe XP', async () => {
        const r = await evaluateSkillingAction('/actions/cheesesmithing/top', {});
        expect(r.xpPerHour).toBe(100 * 1.5 * 100 * 2);
    });

    test('chain charged: the same-skill chain actions add their XP, another skill adds none', async () => {
        mocks.profit = { ...base, upgradeChainCrafted: true };
        const r = await evaluateSkillingAction('/actions/cheesesmithing/top', {});
        expect(r.xpPerHour).toBe(100 * 1.5 * (100 * 2 + 50 * 2));
    });

    test('chain charged but empty: unchanged', async () => {
        mocks.profit = { ...base, upgradeChainCrafted: true };
        mocks.chain = [];
        const r = await evaluateSkillingAction('/actions/cheesesmithing/top', {});
        expect(r.xpPerHour).toBe(100 * 1.5 * 200);
    });
});
