/**
 * Invigoration (talisman Special line) in the tea optimizer. The line is a chance p to double the active drinks'
 * effects on a cooking or brewing action, so a tea combination is scored as two whole outcomes weighted (1 - p) and p,
 * not as drinks averaged first: level efficiency clamps at 0 and a doubled Action Level drink can stop an action from
 * starting, neither of which an averaged drink can see.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { attachTalismanBonuses } from './talisman-bonuses.js';

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

const { calculateSkillPerformance, findOptimalTeas } = await import('./tea-optimizer.js');

const TEA = '/items/efficiency_tea'; // a tea the optimizer offers for cooking; the test gives it several buffs
const wearing = (invigoration) =>
    attachTalismanBonuses(new Map(), { noncombat: invigoration ? { invigoration } : {}, buffs: {}, combat: {} });

/** A tea with several buffs, every flat boost scaled by `m` (m = 2 is what the doubled outcome reads) */
const tea = (m) => ({
    name: 'Test Tea',
    consumableDetail: {
        buffs: [
            { typeHrid: '/buff_types/efficiency', flatBoost: 0.1 * m },
            { typeHrid: '/buff_types/gourmet', flatBoost: 0.1 * m },
            { typeHrid: '/buff_types/action_level', flatBoost: 1 * m },
        ],
    },
});

const setup = (teaDetail, type = 'cooking') => {
    state.gameData = {
        itemDetailMap: { [TEA]: teaDetail, '/items/flour': {}, '/items/bread': {} },
        actionDetailMap: {
            [`/actions/${type}/bread`]: {
                type: `/action_types/${type}`,
                name: 'Bread',
                baseTimeCost: 10e9,
                levelRequirement: { level: 50 },
                experienceGain: { value: 10, skillHrid: `/skills/${type}` },
                inputItems: [{ itemHrid: '/items/flour', count: 2 }],
                outputItems: [{ itemHrid: '/items/bread', count: 1 }],
            },
        },
    };
    state.skills = [{ skillHrid: `/skills/${type}`, level: 56 }];
};

const perform = (teaDetail, equipment, skill = 'cooking') => {
    setup(teaDetail, skill);
    return calculateSkillPerformance(skill, equipment, [TEA], 56);
};

beforeEach(() => {
    prices.byHrid = { '/items/flour': 10, '/items/bread': 100, [TEA]: 5 };
    state.equipment = new Map();
});

describe('calculateSkillPerformance with Invigoration', () => {
    test('absent: nothing changes', () => {
        const plain = perform(tea(1), new Map());
        const none = perform(tea(1), wearing(0));
        expect(none.xpPerHour).toBeCloseTo(plain.xpPerHour, 9);
        expect(none.goldPerHour).toBeCloseTo(plain.goldPerHour, 9);
    });

    test.each([
        ['G1', 0.03],
        ['G6', 0.12],
    ])('%s: a tea with several buffs is (1 - p) of the tea as it is plus p of the tea twice as strong', (_n, p) => {
        // skill 56, requirement 50: Action Level +1 normal, +2 doubled, both start
        const normal = perform(tea(1), new Map());
        const doubled = perform(tea(2), new Map());
        const mixed = perform(tea(1), wearing(p));
        expect(mixed.xpPerHour).toBeCloseTo((1 - p) * normal.xpPerHour + p * doubled.xpPerHour, 9);
        // the tea's own cost per hour is the same in both outcomes, so it comes off once
        expect(mixed.goldPerHour).toBeCloseTo((1 - p) * normal.goldPerHour + p * doubled.goldPerHour, 9);
        expect(mixed.teaCostPerHour).toBeCloseTo(normal.teaCostPerHour, 9);
        expect(mixed.xpPerHour).toBeGreaterThan(normal.xpPerHour);
    });

    test('a doubled Action Level drink that stops the action from starting scores 0 for that outcome only', () => {
        // skill 56, requirement 50: Action Level +5 starts (55), +10 does not (60)
        const levelTea = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_level', flatBoost: 5 }] },
        };
        const normal = perform(levelTea, new Map());
        const mixed = perform(levelTea, wearing(0.12));
        expect(normal.xpPerHour).toBeGreaterThan(0);
        // not blocked as a whole (averaging would read +5.6 and start it): 88% of the normal figure, doubled is 0
        expect(mixed.blockedActionCount).toBe(0);
        expect(mixed.xpPerHour).toBeCloseTo(0.88 * normal.xpPerHour, 9);
    });

    test('an action with no drinks reads the same with or without Invigoration', () => {
        setup(tea(1));
        const plain = calculateSkillPerformance('cooking', new Map(), [], 56);
        const withLine = calculateSkillPerformance('cooking', wearing(0.12), [], 56);
        expect(withLine.xpPerHour).toBeCloseTo(plain.xpPerHour, 9);
        expect(withLine.goldPerHour).toBeCloseTo(plain.goldPerHour, 9);
    });

    test('a skill Invigoration does not touch (woodcutting) is unchanged by the line', () => {
        const plain = perform(tea(1), new Map(), 'woodcutting');
        const withLine = perform(tea(1), wearing(0.12), 'woodcutting');
        expect(withLine.xpPerHour).toBeCloseTo(plain.xpPerHour, 9);
    });
});

describe('findOptimalTeas with Invigoration', () => {
    test('the search scores a combination the way the performance read does', () => {
        setup(tea(1));
        const equipment = wearing(0.12);
        state.equipment = equipment;
        const found = findOptimalTeas('cooking', 'xp', null, null, { pinned: new Set([TEA]), banned: new Set() });
        const read = calculateSkillPerformance('cooking', equipment, [TEA], 56);
        expect(found.optimal.teas.map((t) => t.hrid)).toContain(TEA);
        expect(found.optimal.avgScore).toBeCloseTo(read.xpPerHour, 9);
    });
});
