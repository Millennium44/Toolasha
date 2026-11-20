/**
 * Abundance (talisman Special line: a chance to triple the resources a gathering action gathers) in the tea optimizer's
 * gathering gold figure. It reads the line the way gathering-profit does: the gathered amount is x (1 + 2 x chance), and
 * Processing works out its whole conversions on the normal stack (weight 1 - chance) and the tripled stack (chance).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MARKET_TAX } from './profit-constants.js';
import { attachTalismanBonuses } from './talisman-bonuses.js';
import { expectedProcessedItems } from './gathering-processing.js';

const state = vi.hoisted(() => ({ gameData: null, skills: [], equipment: new Map() }));
const prices = vi.hoisted(() => ({ byHrid: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getSkills: () => state.skills,
        getEquipment: () => state.equipment,
        getHouseRooms: () => new Map(),
        getCurrentActions: () => [],
        getCommunityBuffLevel: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
        characterData: {},
    },
}));
vi.mock('./experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalWisdom: 0, breakdown: { consumableWisdom: 0 }, charmExperience: 0 }),
}));
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid) => prices.byHrid[hrid] ?? null,
    getItemPriceInfo: (hrid) => ({ price: prices.byHrid[hrid] ?? null, source: 'book', estimated: false }),
}));

const { calculateSkillPerformance } = await import('./tea-optimizer.js');

const wearing = (abundance) =>
    attachTalismanBonuses(new Map(), { noncombat: abundance ? { abundance } : {}, buffs: {}, combat: {} });

beforeEach(() => {
    state.gameData = {
        itemDetailMap: {
            '/items/milk': { name: 'Milk' },
            '/items/cheese': { name: 'Cheese' },
            '/items/processing_tea': {
                consumableDetail: { buffs: [{ typeHrid: '/buff_types/processing', flatBoost: 0.5 }] },
            },
        },
        actionDetailMap: {
            '/actions/milking/cow': {
                type: '/action_types/milking',
                baseTimeCost: 10e9,
                levelRequirement: { level: 1 },
                dropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 2, maxCount: 2 }],
            },
            '/actions/cheesesmithing/cheese': {
                type: '/action_types/cheesesmithing',
                inputItems: [{ itemHrid: '/items/milk', count: 2 }],
                outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
            },
        },
    };
    state.skills = [{ skillHrid: '/skills/milking', level: 1 }];
    prices.byHrid = { '/items/milk': 100, '/items/cheese': 250, '/items/processing_tea': 0 };
});

describe('tea optimizer gathering gold with Abundance', () => {
    test.each([
        ['G1', 0.03],
        ['G6', 0.12],
    ])('%s without Processing: the gathered amount is x (1 + 2 x chance)', (_n, a) => {
        const plain = calculateSkillPerformance('milking', wearing(0), [], 1).goldPerHour;
        const withLine = calculateSkillPerformance('milking', wearing(a), [], 1).goldPerHour;
        expect(plain).toBeCloseTo(360 * 2 * 100 * (1 - MARKET_TAX), 6);
        expect(withLine).toBeCloseTo(plain * (1 + 2 * a), 6);
    });

    test.each([
        ['G1', 0.03],
        ['G6', 0.12],
    ])('%s with Processing: whole conversions on the normal and the tripled stack, weighted', (_n, a) => {
        const drop = { dropRate: 1, minCount: 2, maxCount: 2 };
        const stack = (1 - a) * expectedProcessedItems(drop, 2, 0, 1) + a * expectedProcessedItems(drop, 2, 2, 1);
        const raw = 360 * 2 * (1 + 2 * a) * 100;
        const processed = 360 * 0.5 * stack * (250 - 2 * 100);
        const result = calculateSkillPerformance('milking', wearing(a), ['/items/processing_tea'], 1);
        expect(result.goldPerHour).toBeCloseTo((raw + processed) * (1 - MARKET_TAX), 6);
    });

    test('absent: Processing reads as before', () => {
        const result = calculateSkillPerformance('milking', wearing(0), ['/items/processing_tea'], 1);
        expect(result.goldPerHour).toBeCloseTo((360 * 2 * 100 + 360 * 0.5 * 1 * 50) * (1 - MARKET_TAX), 6);
    });
});
