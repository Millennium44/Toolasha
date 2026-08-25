/** @vitest-environment happy-dom */

/**
 * Which attribute the catalyst's icon is read from.
 *
 * Item icons in this game carry their sprite id on `xlink:href`; only some also
 * carry a plain `href`. `alchemy-profit.js` has always read this exact node with
 * both and a comment saying why. The profit calculator read `href` alone, so on
 * the xlink-only shape the catalyst in the slot was invisible — and a catalyst
 * is worth 15% or 25% of the success rate the whole forecast is built on.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    alchemyTeaBonus: 0,
    drinkSlots: [],
    drinkConcentration: 0,
    equipmentSpeed: 0,
    initClientData: { itemDetailMap: {}, actionDetailMap: {} },
    actionStats: {},
    skills: [],
    itemPrice: 0,
    itemPrices: {},
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: (k, f) => f } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initClientData,
        getItemDetails: (hrid) => mocks.initClientData?.itemDetailMap?.[hrid] ?? null,
        getSkills: () => mocks.skills,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => mocks.drinkSlots,
        characterData: {},
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => mocks.drinkConcentration }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: (hrid) => mocks.itemPrices[hrid] ?? mocks.itemPrice }));
vi.mock('../../utils/buff-parser.js', () => ({ getAlchemySuccessBonus: () => mocks.alchemyTeaBonus }));
vi.mock('../../utils/equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => mocks.equipmentSpeed,
    debugEquipmentSpeedBonuses: () => [],
    parseEssenceFindBonus: () => 0,
    parseRareFindBonus: () => 0,
}));
vi.mock('../../utils/action-calculator.js', () => ({ calculateActionStats: () => mocks.actionStats }));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseRareFind: () => 0 }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null, on: () => () => {} } }));
vi.mock('./expected-value-calculator.js', () => ({ default: { getCachedValue: () => null, isInitialized: false } }));

const { default: alchemyProfitCalculator } = await import('./alchemy-profit-calculator.js');

/**
 * Put a catalyst slot on the page carrying the given attributes.
 * @param {Object} attributes - Attribute name → value for the `use` element
 */
function renderCatalystSlot(attributes) {
    document.body.innerHTML = `
        <div class="SkillActionDetail_catalystItemInputContainer">
            <div class="Item_itemContainer"><svg><use></use></svg></div>
        </div>`;
    const use = document.querySelector('svg use');
    for (const [name, value] of Object.entries(attributes)) use.setAttribute(name, value);
}

/**
 * The combo search's inputs, with profit driven purely by the success rate so
 * the winner is whichever combo raises it most.
 * @returns {Object} Params for _liveSetupCombo
 */
function baseParams() {
    return {
        actionType: 'coinify',
        baseSuccessRate: 0.5,
        actionsPerHour: 100,
        efficiencyDecimal: 0,
        actionTime: 10,
        alchemyBonusRevenue: 0,
        computeNetProfit: (successRate) => successRate * 1000,
        computeTeaCost: () => 0,
    };
}

beforeEach(() => {
    mocks.alchemyTeaBonus = 0;
    mocks.itemPrice = 0;
    mocks.itemPrices = {};
    document.body.innerHTML = '';
});

describe('reading the catalyst out of the slot', () => {
    test('an icon that carries only xlink:href is still seen', () => {
        renderCatalystSlot({ 'xlink:href': '/static/media/items_sprite.svg#prime_catalyst' });

        const best = alchemyProfitCalculator._liveSetupCombo(baseParams());

        expect(best.catalystHrid).toBe('/items/prime_catalyst');
        expect(best.catalystBonus).toBeCloseTo(0.25, 10);
    });

    test('a plain href is still read, as it always was', () => {
        renderCatalystSlot({ href: '/static/media/items_sprite.svg#catalyst_of_coinification' });

        const best = alchemyProfitCalculator._liveSetupCombo(baseParams());

        expect(best.catalystHrid).toBe('/items/catalyst_of_coinification');
        expect(best.catalystBonus).toBeCloseTo(0.15, 10);
    });

    test('an empty slot is still an empty slot', () => {
        renderCatalystSlot({});

        const best = alchemyProfitCalculator._liveSetupCombo(baseParams());

        expect(best.catalystHrid).toBe(null);
        expect(best.catalystBonus).toBe(0);
    });
});
