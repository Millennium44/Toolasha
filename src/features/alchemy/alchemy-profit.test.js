/** @vitest-environment happy-dom */

/**
 * Tests for the Alchemy Profit Calculator
 *
 * alchemy-profit.js reads the alchemy panel and turns it into the numbers the
 * display layer prints. The panel is a handful of DOM nodes and is cheap to
 * build; the character (skills, equipment, house, buffs) and the market are
 * mocked. What is pinned here is the arithmetic the module owns: the success
 * rate / tea split, the efficiency stack, enhancement cost, and the
 * decomposition value formula.
 *
 * Expected values are hand-computed in comments so the fixture is auditable.
 *
 * Not covered (pure DOM scraping, no arithmetic): extractRequirements,
 * extractDrops, extractCatalyst, extractConsumables, extractItemData,
 * getStateFingerprint, extractTeaDuration's React-fiber walk.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const game = vi.hoisted(() => ({
    initClientData: null,
    skills: [],
    equipment: new Map(),
    houseRooms: new Map(),
    drinkSlots: [],
    currentActions: [],
    communityBuffLevels: {},
    achievementBuffs: {},
    /** buffTypeHrid → flat boost, the personal (seal) buffs */
    personalBuffs: {},
    /** actionTypeHrid → [{typeHrid, flatBoost}], the guild buffs */
    guildBuffs: {},
}));

const market = vi.hoisted(() => ({
    /** itemHrid → { ask, bid } */
    prices: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return { guildActionTypeBuffsMap: game.guildBuffs };
        },
        getInitClientData: () => game.initClientData,
        getSkills: () => game.skills,
        getEquipment: () => new Map(game.equipment),
        getHouseRooms: () => game.houseRooms,
        getActionDrinkSlots: () => game.drinkSlots,
        // A slotted tea is in stock unless a test says otherwise — the shared context drops
        // slots with nothing left in the bag, which is not what these tests are about
        getInventory: () => game.drinkSlots.map((slot) => ({ itemHrid: slot.itemHrid, count: 10 })),
        getCurrentActions: () => game.currentActions,
        getCommunityBuffLevel: (hrid) => game.communityBuffLevels[hrid] || 0,
        getAchievementBuffFlatBoost: (_type, buffHrid) => game.achievementBuffs[buffHrid] || 0,
        getPersonalBuffFlatBoost: (_type, buffHrid) => game.personalBuffs[buffHrid] || 0,
    },
}));

// The loadout store lives in storage and is never what an alchemy test is about; with no
// snapshot the shared context falls back to what the character is wearing, which is the fixture
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotForSkill: () => null, getSnapshotDrinksForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPrice: (hrid) => market.prices[hrid] ?? null,
        on: () => () => {},
    },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        getCachedValue: () => 0,
        calculateSingleContainer: () => 0,
    },
}));

const alchemyProfit = (await import('./alchemy-profit.js')).default;

const COIN = '/items/coin';
const ESSENCE = '/items/enhancing_essence';
const CHEESE = '/items/cheese';

/** Build the two DOM nodes the extractors read. */
function renderPanel({ successRate = '75.0%', notes = 'Requires Alchemy level 60' } = {}) {
    document.body.innerHTML = `
        <div class="SkillActionDetail_alchemyComponent__abc">
            <div class="SkillActionDetail_successRate__x">
                <span class="SkillActionDetail_value__y">${successRate}</span>
            </div>
            <div class="SkillActionDetail_notes__z">${notes}</div>
        </div>
    `;
}

beforeEach(() => {
    game.initClientData = {
        itemDetailMap: {
            '/items/alchemy_tea': {
                name: 'Alchemy Tea',
                consumableDetail: {
                    buffs: [{ typeHrid: '/buff_types/alchemy_success', ratioBoost: 0.05, flatBoost: 0 }],
                },
            },
            '/items/efficiency_tea': {
                name: 'Efficiency Tea',
                consumableDetail: {
                    buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1, ratioBoost: 0 }],
                },
            },
            '/items/alchemists_hat': {
                name: "Alchemist's Hat",
                equipmentType: '/equipment_types/head',
                equipmentDetail: {
                    type: '/equipment_types/head',
                    noncombatStats: { alchemySpeed: 0.2, alchemyEfficiency: 0.1 },
                },
            },
            '/items/necklace_of_efficiency': {
                name: 'Necklace of Efficiency',
                equipmentType: '/equipment_types/neck',
                equipmentDetail: {
                    type: '/equipment_types/neck',
                    noncombatStats: { skillingEfficiency: 0.04 },
                },
            },
            [CHEESE]: {
                name: 'Cheese',
                itemLevel: 10,
                enhancementCosts: [
                    { itemHrid: COIN, count: 1000 },
                    { itemHrid: '/items/mirror_of_protection', count: 2 },
                ],
                decompositionDetail: {
                    results: [{ itemHrid: '/items/milk', amount: 3 }],
                },
            },
        },
        // The efficiency helper reads the buff's strength and skill list out of game data
        communityBuffTypeDetailMap: {
            '/community_buff_types/production_efficiency': {
                buff: { flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
                usableInActionTypeMap: { '/action_types/alchemy': true },
            },
        },
        houseRoomDetailMap: {
            '/house_rooms/laboratory': {
                usableInActionTypeMap: { '/action_types/alchemy': true },
                actionBuffs: [
                    {
                        typeHrid: '/buff_types/efficiency',
                        usableInActionTypeMap: { '/action_types/alchemy': true },
                        flatBoost: 0.015,
                        flatBoostLevelBonus: 0.015,
                    },
                ],
            },
            '/house_rooms/dairy_barn': {
                usableInActionTypeMap: { '/action_types/milking': true },
                actionBuffs: [
                    {
                        typeHrid: '/buff_types/efficiency',
                        usableInActionTypeMap: { '/action_types/milking': true },
                        flatBoost: 0.015,
                        flatBoostLevelBonus: 0.015,
                    },
                ],
            },
        },
    };
    game.skills = [{ skillHrid: '/skills/alchemy', level: 70 }];
    game.equipment = new Map();
    game.houseRooms = new Map();
    game.drinkSlots = [];
    game.currentActions = [];
    game.communityBuffLevels = {};
    game.achievementBuffs = {};
    game.personalBuffs = {};
    game.guildBuffs = {};
    market.prices = {
        [CHEESE]: { ask: 1000, bid: 900 },
        '/items/milk': { ask: 120, bid: 100 },
        '/items/mirror_of_protection': { ask: 500, bid: 450 },
        [ESSENCE]: { ask: 200, bid: 180 },
    };
    renderPanel();
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('getCurrentActionHrid', () => {
    test('picks the alchemy action out of the queue', () => {
        game.currentActions = [{ actionHrid: '/actions/milking/cow' }, { actionHrid: '/actions/alchemy/coinify' }];

        expect(alchemyProfit.getCurrentActionHrid()).toBe('/actions/alchemy/coinify');
    });

    test('returns null when nothing is queued or nothing is alchemy', () => {
        game.currentActions = [];
        expect(alchemyProfit.getCurrentActionHrid()).toBeNull();

        game.currentActions = [{ actionHrid: '/actions/milking/cow' }];
        expect(alchemyProfit.getCurrentActionHrid()).toBeNull();
    });
});

describe('extractSuccessRate', () => {
    test('reads the panel percentage with no tea running', () => {
        renderPanel({ successRate: '75.0%' });

        const rate = alchemyProfit.extractSuccessRate();

        expect(rate.total).toBeCloseTo(0.75, 10);
        expect(rate.base).toBeCloseTo(0.75, 10);
        expect(rate.tea).toBe(0);
    });

    test('backs the tea ratio boost out of the displayed total', () => {
        // Alchemy Tea gives +5% of base, and the panel already includes it.
        // base = 0.7875 / 1.05 = 0.75
        game.drinkSlots = [{ itemHrid: '/items/alchemy_tea' }];
        renderPanel({ successRate: '78.75%' });

        const rate = alchemyProfit.extractSuccessRate();

        expect(rate.tea).toBeCloseTo(0.05, 10);
        expect(rate.total).toBeCloseTo(0.7875, 10);
        expect(rate.base).toBeCloseTo(0.75, 10);
    });

    test('scales the tea boost by drink concentration', () => {
        // Drink concentration 0.2 → tea boost 0.05 × 1.2 = 0.06
        // base = 0.795 / 1.06 = 0.75
        game.initClientData.itemDetailMap['/items/concentration_ring'] = {
            name: 'Ring of Concentration',
            equipmentDetail: { type: '/equipment_types/ring', noncombatStats: { drinkConcentration: 0.2 } },
        };
        game.equipment = new Map([
            ['/item_locations/ring', { itemHrid: '/items/concentration_ring', enhancementLevel: 0 }],
        ]);
        game.drinkSlots = [{ itemHrid: '/items/alchemy_tea' }];
        renderPanel({ successRate: '79.5%' });

        const rate = alchemyProfit.extractSuccessRate();

        expect(rate.tea).toBeCloseTo(0.06, 10);
        expect(rate.base).toBeCloseTo(0.75, 10);
    });

    test('returns null when the panel has no success rate to read', () => {
        document.body.innerHTML = '<div class="SkillActionDetail_alchemyComponent__abc"></div>';

        expect(alchemyProfit.extractSuccessRate()).toBeNull();
    });
});

describe('extractActionSpeed', () => {
    test('sums equipment speed with enhancement scaling', () => {
        // Alchemist's Hat +10, head slot (1x): 0.20 × (1 + 0.29 × 1) = 0.258
        game.equipment = new Map([
            ['/item_locations/head', { itemHrid: '/items/alchemists_hat', enhancementLevel: 10 }],
        ]);

        const speed = alchemyProfit.extractActionSpeed();

        expect(speed.equipment).toBeCloseTo(0.258, 10);
        expect(speed.total).toBeCloseTo(0.258, 10);
        expect(speed.tea).toBe(0);
    });

    test('is zero with no gear', () => {
        expect(alchemyProfit.extractActionSpeed()).toEqual({
            total: 0,
            equipment: 0,
            tea: 0,
            personal: 0,
            guild: 0,
        });
    });

    test('personal and guild speed buffs count, which the panel used to ignore entirely', () => {
        game.personalBuffs['/buff_types/action_speed'] = 0.05;
        game.guildBuffs = {
            '/action_types/alchemy': [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.03 }],
        };

        const speed = alchemyProfit.extractActionSpeed();

        expect(speed.personal).toBeCloseTo(0.05, 10);
        expect(speed.guild).toBeCloseTo(0.03, 10);
        expect(speed.total).toBeCloseTo(0.08, 10);
    });
});

describe('extractEfficiency', () => {
    test('stacks level, house, tea, equipment, community and achievement', () => {
        // Panel says "Requires Alchemy level 60", character is level 70 → 10% level efficiency
        // Laboratory level 8 house room → 8 × 1.5 = 12%
        // Efficiency Tea flatBoost 0.10 → parsed as 10%
        // Necklace of Efficiency +0, neck slot: 0.04 → 4%
        // Community buff level 11 → (0.14 + 10 × 0.003) × 100 = 17%
        // Achievement rank → 0.02 × 100 = 2%
        // total 10 + 12 + 10 + 4 + 17 + 2 = 55% → 0.55
        game.houseRooms = new Map([
            ['/house_rooms/laboratory', { houseRoomHrid: '/house_rooms/laboratory', level: 8 }],
            ['/house_rooms/dairy_barn', { houseRoomHrid: '/house_rooms/dairy_barn', level: 8 }],
        ]);
        game.drinkSlots = [{ itemHrid: '/items/efficiency_tea' }];
        game.equipment = new Map([
            ['/item_locations/neck', { itemHrid: '/items/necklace_of_efficiency', enhancementLevel: 0 }],
        ]);
        game.communityBuffLevels['/community_buff_types/production_efficiency'] = 11;
        game.achievementBuffs['/buff_types/efficiency'] = 0.02;

        const eff = alchemyProfit.extractEfficiency();

        expect(eff.level).toBe(10);
        expect(eff.house).toBeCloseTo(12, 10);
        expect(eff.tea).toBeCloseTo(10, 10);
        expect(eff.equipment).toBeCloseTo(4, 10);
        expect(eff.community).toBeCloseTo(17, 10);
        expect(eff.achievement).toBeCloseTo(2, 10);
        expect(eff.total).toBeCloseTo(0.55, 10);
    });

    test('ignores house rooms that are not usable for alchemy', () => {
        game.houseRooms = new Map([
            ['/house_rooms/dairy_barn', { houseRoomHrid: '/house_rooms/dairy_barn', level: 8 }],
        ]);

        expect(alchemyProfit.extractEfficiency().house).toBe(0);
    });

    test('level efficiency never goes negative below the requirement', () => {
        game.skills = [{ skillHrid: '/skills/alchemy', level: 20 }];
        renderPanel({ notes: 'Requires Alchemy level 60' });

        const eff = alchemyProfit.extractEfficiency();

        expect(eff.level).toBe(0);
        expect(eff.total).toBe(0);
    });

    test('an efficiency over 100% is reported as a multiplier above 1', () => {
        // level 200 vs requirement 60 → 140% on its own
        game.skills = [{ skillHrid: '/skills/alchemy', level: 200 }];

        expect(alchemyProfit.extractEfficiency().total).toBeCloseTo(1.4, 10);
    });

    test('personal and guild efficiency count, which the panel used to leave out', () => {
        // Both are real buffs the character has and the alchemy panel simply never read,
        // so every alchemy profit figure was quoted below what the character actually earns
        game.personalBuffs['/buff_types/efficiency'] = 0.06;
        game.guildBuffs = {
            '/action_types/alchemy': [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.04 }],
        };

        const eff = alchemyProfit.extractEfficiency();

        expect(eff.personal).toBeCloseTo(6, 10);
        expect(eff.guild).toBeCloseTo(4, 10);
        // Level 70 against a requirement of 60 is 10%, plus the two buffs
        expect(eff.total).toBeCloseTo(0.2, 10);
    });

    test('the community buff only applies where the game says it does', () => {
        game.communityBuffLevels['/community_buff_types/production_efficiency'] = 11;
        game.initClientData.communityBuffTypeDetailMap[
            '/community_buff_types/production_efficiency'
        ].usableInActionTypeMap = { '/action_types/cooking': true };

        expect(alchemyProfit.extractEfficiency().community).toBe(0);
    });
});

describe('extractRareFind / extractEssenceFind', () => {
    test('the achievement rare-find buff is counted', () => {
        game.achievementBuffs['/buff_types/rare_find'] = 0.02;

        const rare = alchemyProfit.extractRareFind();

        expect(rare.achievement).toBeCloseTo(2, 10);
        expect(rare.total).toBeCloseTo(0.02, 10);
    });

    test('equipment rare/essence find is read off equipmentDetail.noncombatStats', () => {
        game.initClientData.itemDetailMap['/items/lucky_charm'] = {
            name: 'Lucky Charm',
            equipmentDetail: {
                type: '/equipment_types/charm',
                noncombatStats: { skillingRareFind: 0.05, skillingEssenceFind: 0.03 },
            },
        };
        game.equipment = new Map([['/item_locations/charm', { itemHrid: '/items/lucky_charm', enhancementLevel: 0 }]]);

        expect(alchemyProfit.extractRareFind().equipment).toBeCloseTo(5, 10);
        expect(alchemyProfit.extractRareFind().total).toBeCloseTo(0.05, 10);
        expect(alchemyProfit.extractEssenceFind().equipment).toBeCloseTo(3, 10);
        expect(alchemyProfit.extractEssenceFind().total).toBeCloseTo(0.03, 10);
    });

    test('the alchemy-specific rare find stat counts too, scaled by enhancement and slot', () => {
        // charm slot is a 5× enhancement slot; +10 is a 29% enhancement bonus
        // alchemyRareFind 0.04 × (1 + 0.29 × 5) = 0.04 × 2.45 = 0.098 → 9.8%
        game.initClientData.itemDetailMap['/items/alchemists_charm'] = {
            name: "Alchemist's Charm",
            equipmentDetail: {
                type: '/equipment_types/charm',
                noncombatStats: { alchemyRareFind: 0.04 },
            },
        };
        game.equipment = new Map([
            ['/item_locations/charm', { itemHrid: '/items/alchemists_charm', enhancementLevel: 10 }],
        ]);

        expect(alchemyProfit.extractRareFind().equipment).toBeCloseTo(9.8, 10);
    });

    test('equipment and achievement rare find add up', () => {
        game.achievementBuffs['/buff_types/rare_find'] = 0.02;
        game.initClientData.itemDetailMap['/items/lucky_charm'] = {
            name: 'Lucky Charm',
            equipmentDetail: {
                type: '/equipment_types/charm',
                noncombatStats: { skillingRareFind: 0.05 },
            },
        };
        game.equipment = new Map([['/item_locations/charm', { itemHrid: '/items/lucky_charm', enhancementLevel: 0 }]]);

        const rare = alchemyProfit.extractRareFind();

        expect(rare.equipment).toBeCloseTo(5, 10);
        expect(rare.achievement).toBeCloseTo(2, 10);
        expect(rare.total).toBeCloseTo(0.07, 10);
    });

    test('falls back to zeroes when game data is missing', () => {
        game.initClientData = null;

        expect(alchemyProfit.extractRareFind()).toEqual({ total: 0, equipment: 0, achievement: 0 });
        expect(alchemyProfit.extractEssenceFind()).toEqual({ total: 0, equipment: 0 });
        expect(alchemyProfit.extractActionSpeed()).toEqual({
            total: 0,
            equipment: 0,
            tea: 0,
            personal: 0,
            guild: 0,
        });
    });
});

describe('calculateEnhancementCost', () => {
    test('a +0 item costs exactly its market price on the chosen side', () => {
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 0, 'ask')).toBe(1000);
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 0, 'bid')).toBe(900);
    });

    test('adds one full material set per enhancement level, coins at face value', () => {
        // base 1,000 + 3 levels × (1,000 coins + 2 mirrors @ 500 ask = 1,000) = 1,000 + 3 × 2,000
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 3, 'ask')).toBe(7000);
        // bid side: mirrors at 450 → per level 1,000 + 900 = 1,900; base 900 + 3 × 1,900
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 3, 'bid')).toBe(6600);
    });

    test('treats an unpriced material as free rather than NaN', () => {
        delete market.prices['/items/mirror_of_protection'];

        // base 1,000 + 2 levels × 1,000 coins
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 2, 'ask')).toBe(3000);
    });

    test('returns the base price for an item with no enhancement recipe', () => {
        game.initClientData.itemDetailMap['/items/milk'] = { name: 'Milk', itemLevel: 1 };

        expect(alchemyProfit.calculateEnhancementCost('/items/milk', 5, 'ask')).toBe(120);
    });

    test('returns zero for an unknown item or missing game data', () => {
        expect(alchemyProfit.calculateEnhancementCost('/items/unknown', 3, 'ask')).toBe(0);

        game.initClientData = null;
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 3, 'ask')).toBe(0);
    });
});

describe('calculateDecompositionValue', () => {
    test('a +0 item recovers nothing', () => {
        expect(alchemyProfit.calculateDecompositionValue(CHEESE, 0, 'ask')).toBe(0);
    });

    test('pins the decomposition results plus the enhancing essence formula', () => {
        // results: 3 milk @ 120 ask = 360, after market tax
        // essence: round(2 × (0.5 + 0.1 × 1.05^10) × 2^2)
        //        = round(2 × (0.5 + 0.16288946...) × 4) = round(5.3031...) = 5
        // 5 × 200 ask = 1,000, after market tax
        const value = alchemyProfit.calculateDecompositionValue(CHEESE, 2, 'ask');

        expect(value).toBeCloseTo(360 * (1 - MARKET_TAX) + 1000 * (1 - MARKET_TAX), 6);
    });

    test('essence recovered doubles with every enhancement level', () => {
        // At +3 the same formula gives round(2 × 0.66288946 × 8) = round(10.606...) = 11
        // essence 11 × 200 plus milk 3 × 120, each after market tax
        expect(alchemyProfit.calculateDecompositionValue(CHEESE, 3, 'ask')).toBeCloseTo(
            2200 * (1 - MARKET_TAX) + 360 * (1 - MARKET_TAX),
            6
        );
    });

    test('uses bid prices when asked for the instant-sell side', () => {
        // milk 3 × 100 = 300 and essence 5 × 180 = 900, each after market tax
        expect(alchemyProfit.calculateDecompositionValue(CHEESE, 2, 'bid')).toBeCloseTo(
            300 * (1 - MARKET_TAX) + 900 * (1 - MARKET_TAX),
            6
        );
    });

    test('skips unpriced essence instead of producing NaN', () => {
        delete market.prices[ESSENCE];

        expect(alchemyProfit.calculateDecompositionValue(CHEESE, 2, 'ask')).toBeCloseTo(360 * (1 - MARKET_TAX), 6);
    });

    test('returns zero for an unknown item or missing game data', () => {
        expect(alchemyProfit.calculateDecompositionValue('/items/unknown', 2, 'ask')).toBe(0);

        game.initClientData = null;
        expect(alchemyProfit.calculateDecompositionValue(CHEESE, 2, 'ask')).toBe(0);
    });
});
