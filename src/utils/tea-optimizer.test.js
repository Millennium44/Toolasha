/**
 * Tests for Tea Optimizer Utility
 *
 * Scoped to the pure, self-contained pieces (getRelevantTeas, getTeaBuffDescription).
 * findOptimalTeas/scoreEquipmentSetup/calculateSkillPerformance compose a dozen other
 * calculators (efficiency, experience, equipment, bonus-revenue, alchemy profit) behind
 * private helpers and are exercised end-to-end by their own feature/UI tests instead of
 * being re-mocked wholesale here.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null }));
const prices = vi.hoisted(() => ({ byHrid: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
    },
}));

// actionHasUnpricedMaterials only needs getItemPrice's null-vs-number distinction; the real
// module reaches through config/marketAPI/custom-price-overrides, which this file otherwise
// avoids wiring up (see file docblock).
vi.mock('./market-data.js', () => ({
    getItemPrice: (itemHrid) => (itemHrid in prices.byHrid ? prices.byHrid[itemHrid] : null),
}));

const { getRelevantTeas, getTeaBuffDescription, actionHasUnpricedMaterials } = await import('./tea-optimizer.js');

const knownItems = [
    '/items/milking_tea',
    '/items/super_milking_tea',
    '/items/ultra_milking_tea',
    '/items/efficiency_tea',
    '/items/artisan_tea',
    '/items/wisdom_tea',
    '/items/gathering_tea',
    '/items/processing_tea',
    '/items/gourmet_tea',
    '/items/catalytic_tea',
];

beforeEach(() => {
    state.gameData = { itemDetailMap: Object.fromEntries(knownItems.map((hrid) => [hrid, {}])) };
    prices.byHrid = {};
});

describe('getRelevantTeas', () => {
    test('returns empty arrays without game data', () => {
        state.gameData = null;
        expect(getRelevantTeas('milking', 'xp')).toEqual({ skillTeas: [], generalTeas: [] });
    });

    test('gathering skill + gold goal includes gathering and processing teas', () => {
        const { skillTeas, generalTeas } = getRelevantTeas('milking', 'gold');
        expect(skillTeas).toEqual(['/items/milking_tea', '/items/super_milking_tea', '/items/ultra_milking_tea']);
        expect(generalTeas).toContain('/items/gathering_tea');
        expect(generalTeas).toContain('/items/processing_tea');
        expect(generalTeas).toContain('/items/artisan_tea'); // non-alchemy always includes artisan
        expect(generalTeas).not.toContain('/items/catalytic_tea'); // alchemy-only
    });

    test('alchemy skill swaps artisan tea for catalytic tea', () => {
        const { generalTeas } = getRelevantTeas('alchemy', 'gold');
        expect(generalTeas).toContain('/items/catalytic_tea');
        expect(generalTeas).not.toContain('/items/artisan_tea');
    });

    test('cooking/brewing + gold goal includes gourmet tea, gathering skills do not', () => {
        state.gameData.itemDetailMap['/items/cooking_tea'] = {};
        state.gameData.itemDetailMap['/items/super_cooking_tea'] = {};
        state.gameData.itemDetailMap['/items/ultra_cooking_tea'] = {};
        const cooking = getRelevantTeas('cooking', 'gold');
        expect(cooking.generalTeas).toContain('/items/gourmet_tea');

        const milking = getRelevantTeas('milking', 'gold');
        expect(milking.generalTeas).not.toContain('/items/gourmet_tea');
    });

    test('xp goal for cooking/brewing also shows gourmet tea', () => {
        const { generalTeas } = getRelevantTeas('brewing', 'xp');
        expect(generalTeas).toContain('/items/gourmet_tea');
    });

    test('filters out teas that do not exist in game data', () => {
        state.gameData = { itemDetailMap: {} };
        const { skillTeas, generalTeas } = getRelevantTeas('milking', 'gold');
        expect(skillTeas).toEqual([]);
        expect(generalTeas).toEqual([]);
    });

    test('wisdom tea is always included regardless of goal', () => {
        expect(getRelevantTeas('milking', 'xp').generalTeas).toContain('/items/wisdom_tea');
        expect(getRelevantTeas('milking', 'gold').generalTeas).toContain('/items/wisdom_tea');
    });
});

describe('getTeaBuffDescription', () => {
    test('returns empty string without game data or unknown tea', () => {
        state.gameData = null;
        expect(getTeaBuffDescription('/items/efficiency_tea')).toBe('');

        state.gameData = { itemDetailMap: {} };
        expect(getTeaBuffDescription('/items/unknown')).toBe('');
    });

    test('formats an efficiency buff as a percentage with no DC bonus shown at 0 concentration', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/efficiency_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
                },
            },
        };
        expect(getTeaBuffDescription('/items/efficiency_tea', 0)).toBe('+10% eff');
    });

    test('includes the drink-concentration bonus in parentheses when present', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/efficiency_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
                },
            },
        };
        const description = getTeaBuffDescription('/items/efficiency_tea', 0.12);
        expect(description).toContain('+11.2% eff');
        // dcBonus >= 1 is rounded to a whole percent by formatBuffWithDC
        expect(description).toContain('(+1%)');
    });

    test('formats a skill-level buff without a percent sign', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/ultra_milking_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/milking_level', flatBoost: 8 }] },
                },
            },
        };
        expect(getTeaBuffDescription('/items/ultra_milking_tea', 0)).toBe('+8 milking');
    });

    test('joins multiple buffs with a comma', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/multi_tea': {
                    consumableDetail: {
                        buffs: [
                            { typeHrid: '/buff_types/efficiency', flatBoost: 0.1 },
                            { typeHrid: '/buff_types/wisdom', flatBoost: 0.12 },
                        ],
                    },
                },
            },
        };
        const description = getTeaBuffDescription('/items/multi_tea', 0);
        expect(description).toBe('+10% eff, +12% XP');
    });
});

describe('actionHasUnpricedMaterials', () => {
    // calculateGatheringGoldPerHour / calculateProductionGoldPerHour treat a missing price as
    // 0 (revenue for an unpriced output, cost for an unpriced input) — the same convention the
    // live action tile uses. actionHasUnpricedMaterials is the parity piece the tile has that
    // the optimizer didn't: a signal that a gold/hour number rests on treating something as
    // free/worthless rather than on an actual quote.
    const gameData = { actionDetailMap: {} };

    test('a gathering action with every drop priced is not flagged', () => {
        prices.byHrid = { '/items/log': 10, '/items/bark': 5 };
        const action = {
            dropTable: [{ itemHrid: '/items/log' }, { itemHrid: '/items/bark' }],
        };
        expect(actionHasUnpricedMaterials(action, true, gameData)).toBe(false);
    });

    test('a gathering action with one unpriced drop is flagged', () => {
        prices.byHrid = { '/items/log': 10 }; // bark left unpriced -> getItemPrice returns null
        const action = {
            dropTable: [{ itemHrid: '/items/log' }, { itemHrid: '/items/bark' }],
        };
        expect(actionHasUnpricedMaterials(action, true, gameData)).toBe(true);
    });

    test('a production action with an unpriced input is flagged even though the output is priced', () => {
        prices.byHrid = { '/items/cheese': 100 }; // milk left unpriced
        const action = {
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });

    test('a production action with an unpriced output is flagged even though inputs are priced', () => {
        prices.byHrid = { '/items/milk': 2 }; // cheese left unpriced
        const action = {
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });

    test('coins never count as unpriced, on either side', () => {
        prices.byHrid = { '/items/widget': 50 };
        const action = {
            inputItems: [{ itemHrid: '/items/coin', count: 10 }],
            outputItems: [{ itemHrid: '/items/widget', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(false);
    });

    test('an unpriced upgrade item is flagged', () => {
        prices.byHrid = { '/items/milk': 2, '/items/cheese': 100 };
        const action = {
            upgradeItemHrid: '/items/rare_starter_culture', // unpriced
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });

    test('a gathering drop that feeds an unpriced processing conversion is flagged', () => {
        prices.byHrid = { '/items/raw_hide': 5 }; // tanned_leather (the conversion output) left unpriced
        gameData.actionDetailMap = {
            '/actions/tailoring/tan_hide': {
                type: '/action_types/tailoring',
                inputItems: [{ itemHrid: '/items/raw_hide', count: 1 }],
                outputItems: [{ itemHrid: '/items/tanned_leather', count: 1 }],
            },
        };
        const action = { dropTable: [{ itemHrid: '/items/raw_hide' }] };
        expect(actionHasUnpricedMaterials(action, true, gameData)).toBe(true);
        gameData.actionDetailMap = {};
    });
});
