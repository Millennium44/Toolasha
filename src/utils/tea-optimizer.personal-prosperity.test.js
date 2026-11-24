/**
 * The tea optimizer's gold figure reads the same Gourmet, Processing and Prosperity the action tile does: a Gourmet or
 * Processing scroll or seal (a personal buff) adds to the tea and talisman chance, and a Prosperity line pays untaxed
 * coins on Cheesesmithing, Crafting and Tailoring. Each was missing from calculateSkillPerformance's Gold/hr, so it read
 * lower than the tile for the same setup.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MARKET_TAX } from './profit-constants.js';
import { attachTalismanBonuses } from './talisman-bonuses.js';

const state = vi.hoisted(() => ({ gameData: null, skills: [], equipment: new Map(), personal: {} }));
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
        getPersonalBuffFlatBoost: (actionType, buffType) => state.personal[`${actionType}|${buffType}`] ?? 0,
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

const wearing = (noncombat = {}) => attachTalismanBonuses(new Map(), { noncombat, buffs: {}, combat: {} });

beforeEach(() => {
    state.personal = {};
    state.gameData = {
        itemDetailMap: {
            '/items/milk': { name: 'Milk' },
            '/items/cheese': { name: 'Cheese', sellPrice: 40 },
            '/items/wheat': { name: 'Wheat' },
            '/items/donut': { name: 'Donut' },
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
                baseTimeCost: 10e9,
                levelRequirement: { level: 1 },
                inputItems: [{ itemHrid: '/items/milk', count: 2 }],
                outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
            },
            '/actions/cooking/donut': {
                type: '/action_types/cooking',
                baseTimeCost: 10e9,
                levelRequirement: { level: 1 },
                inputItems: [{ itemHrid: '/items/wheat', count: 1 }],
                outputItems: [{ itemHrid: '/items/donut', count: 1 }],
            },
        },
    };
    state.skills = [
        { skillHrid: '/skills/milking', level: 1 },
        { skillHrid: '/skills/cheesesmithing', level: 1 },
        { skillHrid: '/skills/cooking', level: 1 },
    ];
    prices.byHrid = { '/items/milk': 100, '/items/cheese': 250, '/items/wheat': 10, '/items/donut': 100 };
});

describe('personal Gourmet and Processing in the optimizer gold figure', () => {
    test('a Gourmet scroll adds its chance to the extra output of cooking', () => {
        // 360 actions/hour, input 10, output 100: (100 x (1 + gourmet) x 0.96 revenue) - 10 input, per action
        const plain = calculateSkillPerformance('cooking', new Map(), [], 1).goldPerHour;
        state.personal['/action_types/cooking|/buff_types/gourmet'] = 0.1;
        const withScroll = calculateSkillPerformance('cooking', new Map(), [], 1).goldPerHour;

        expect(plain).toBeCloseTo(360 * (100 * (1 - MARKET_TAX) - 10), 6);
        expect(withScroll).toBeCloseTo(360 * (110 * (1 - MARKET_TAX) - 10), 6);
    });

    test('a Processing seal converts part of the milk to cheese on milking', () => {
        // 360 actions/hour x 2 milk. Processing 0.5: one cheese per 2 milk, so 360 x 2 x 0.5 / 2 = 180 cheeses/hour,
        // each worth 250 - 2 x 100 = 50 more than the milk it used
        state.personal['/action_types/milking|/buff_types/processing'] = 0.5;
        const gold = calculateSkillPerformance('milking', new Map(), [], 1).goldPerHour;

        expect(gold).toBeCloseTo((360 * 2 * 100 + 180 * 50) * (1 - MARKET_TAX), 6);
    });
});

describe('Prosperity in the optimizer gold figure', () => {
    test('pays untaxed coins at the output vendor value on cheesesmithing', () => {
        // 360 actions/hour x (250 revenue - 200 input), taxed on the sale; Prosperity 0.1 x vendor 40 x 1 output
        // x 360 = 1,440 coins an hour, no tax
        const plain = calculateSkillPerformance('cheesesmithing', wearing(), [], 1).goldPerHour;
        const withLine = calculateSkillPerformance('cheesesmithing', wearing({ prosperity: 0.1 }), [], 1).goldPerHour;

        expect(plain).toBeCloseTo(360 * (250 * (1 - MARKET_TAX) - 200), 6);
        expect(withLine - plain).toBeCloseTo(1440, 6);
    });

    test('is not paid on a skill the line does not cover', () => {
        const plain = calculateSkillPerformance('cooking', wearing(), [], 1).goldPerHour;
        const withLine = calculateSkillPerformance('cooking', wearing({ prosperity: 0.1 }), [], 1).goldPerHour;

        expect(withLine).toBeCloseTo(plain, 6);
    });
});
