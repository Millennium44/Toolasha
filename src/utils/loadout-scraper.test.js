/** @vitest-environment happy-dom */
/**
 * Tests for Loadout Scraper Utilities
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ inventory: [], clientData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => state.clientData,
    },
}));

const {
    itemHridFromUseHref,
    abilityHridFromUseHref,
    buildEnhancementLevelMap,
    getItemLocationHrid,
    scrapeEquipment,
    scrapeAbilities,
    scrapeConsumables,
} = await import('./loadout-scraper.js');

describe('itemHridFromUseHref', () => {
    test('extracts the item HRID from a sprite href', () => {
        expect(itemHridFromUseHref('items_sprite.9c39e2ec.svg#griffin_bulwark_refined')).toBe(
            '/items/griffin_bulwark_refined'
        );
    });

    test('returns null for a non-item sprite or missing fragment', () => {
        expect(itemHridFromUseHref('abilities_sprite.fdd1b4de.svg#invincible')).toBeNull();
        expect(itemHridFromUseHref('items_sprite.9c39e2ec.svg')).toBeNull();
        expect(itemHridFromUseHref('')).toBeNull();
        expect(itemHridFromUseHref(null)).toBeNull();
    });
});

describe('abilityHridFromUseHref', () => {
    test('extracts the ability HRID from a sprite href', () => {
        expect(abilityHridFromUseHref('abilities_sprite.fdd1b4de.svg#invincible')).toBe('/abilities/invincible');
    });

    test('returns null for a non-ability sprite', () => {
        expect(abilityHridFromUseHref('items_sprite.9c39e2ec.svg#plank')).toBeNull();
    });
});

describe('buildEnhancementLevelMap', () => {
    test('returns an empty map with no inventory', () => {
        state.inventory = null;
        expect(buildEnhancementLevelMap().size).toBe(0);
    });

    test('tracks the highest enhancement level per item HRID', () => {
        state.inventory = [
            { itemHrid: '/items/sword', enhancementLevel: 3, count: 1 },
            { itemHrid: '/items/sword', enhancementLevel: 7, count: 1 },
            { itemHrid: '/items/shield', enhancementLevel: 2, count: 1 },
        ];
        const map = buildEnhancementLevelMap();
        expect(map.get('/items/sword')).toBe(7);
        expect(map.get('/items/shield')).toBe(2);
    });

    test('skips items with zero count', () => {
        state.inventory = [{ itemHrid: '/items/sword', enhancementLevel: 5, count: 0 }];
        expect(buildEnhancementLevelMap().has('/items/sword')).toBe(false);
    });
});

describe('getItemLocationHrid', () => {
    beforeEach(() => {
        state.clientData = {
            itemDetailMap: {
                '/items/sword': { equipmentDetail: { type: '/equipment_types/main_hand' } },
                '/items/no_equip_detail': {},
            },
        };
    });

    test('maps equipment type to item location', () => {
        expect(getItemLocationHrid('/items/sword')).toBe('/item_locations/main_hand');
    });

    test('returns null without client data', () => {
        state.clientData = null;
        expect(getItemLocationHrid('/items/sword')).toBeNull();
    });

    test('returns null for an item with no equipment detail', () => {
        expect(getItemLocationHrid('/items/no_equip_detail')).toBeNull();
    });

    test('returns null for an unknown item', () => {
        expect(getItemLocationHrid('/items/unknown')).toBeNull();
    });
});

function makeUse(href) {
    const svgns = 'http://www.w3.org/2000/svg';
    const use = document.createElementNS(svgns, 'use');
    use.setAttribute('href', href);
    return use;
}

describe('scrapeEquipment', () => {
    beforeEach(() => {
        state.inventory = [];
        state.clientData = {
            itemDetailMap: {
                '/items/sword': { equipmentDetail: { type: '/equipment_types/main_hand' } },
            },
        };
    });

    test('returns empty array when the equipment container is missing', () => {
        const el = document.createElement('div');
        expect(scrapeEquipment(el)).toEqual([]);
    });

    test('scrapes equipped items with resolved location and enhancement level', () => {
        state.inventory = [{ itemHrid: '/items/sword', enhancementLevel: 4, count: 1 }];
        const container = document.createElement('div');
        const equipDiv = document.createElement('div');
        equipDiv.className = 'LoadoutsPanel_equipment__abc';
        equipDiv.appendChild(makeUse('items_sprite.hash.svg#sword'));
        container.appendChild(equipDiv);

        const result = scrapeEquipment(container);
        expect(result).toEqual([
            { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/sword', enhancementLevel: 4 },
        ]);
    });

    test('skips use elements that do not resolve to a known equipment slot', () => {
        const container = document.createElement('div');
        const equipDiv = document.createElement('div');
        equipDiv.className = 'LoadoutsPanel_equipment__abc';
        equipDiv.appendChild(makeUse('items_sprite.hash.svg#unknown_item'));
        container.appendChild(equipDiv);

        expect(scrapeEquipment(container)).toEqual([]);
    });
});

describe('scrapeAbilities', () => {
    test('returns 5 empty slots when the abilities container is missing', () => {
        const el = document.createElement('div');
        const slots = scrapeAbilities(el, null);
        expect(slots).toHaveLength(5);
        expect(slots.every((s) => s.abilityHrid === '')).toBe(true);
    });

    test('places the special ability in slot 0 and normal abilities after', () => {
        const clientData = {
            abilityDetailMap: {
                '/abilities/invincible': { isSpecialAbility: true },
                '/abilities/fireball': { isSpecialAbility: false },
            },
        };
        const container = document.createElement('div');
        const abilitiesDiv = document.createElement('div');
        abilitiesDiv.className = 'LoadoutsPanel_abilities__x';

        const specialContainer = document.createElement('div');
        specialContainer.className = 'Ability_ability__1';
        specialContainer.appendChild(makeUse('abilities_sprite.hash.svg#invincible'));
        const specialLevel = document.createElement('div');
        specialLevel.className = 'Ability_level__1';
        specialLevel.textContent = 'Lv.10';
        specialContainer.appendChild(specialLevel);

        const normalContainer = document.createElement('div');
        normalContainer.className = 'Ability_ability__2';
        normalContainer.appendChild(makeUse('abilities_sprite.hash.svg#fireball'));
        const normalLevel = document.createElement('div');
        normalLevel.className = 'Ability_level__2';
        normalLevel.textContent = 'Lv.59';
        normalContainer.appendChild(normalLevel);

        abilitiesDiv.appendChild(specialContainer);
        abilitiesDiv.appendChild(normalContainer);
        container.appendChild(abilitiesDiv);

        const slots = scrapeAbilities(container, clientData);
        expect(slots[0]).toEqual({ abilityHrid: '/abilities/invincible', level: 10 });
        expect(slots[1]).toEqual({ abilityHrid: '/abilities/fireball', level: 59 });
        expect(slots[2].abilityHrid).toBe('');
    });

    test('defaults to level 1 when no level element is present', () => {
        const container = document.createElement('div');
        const abilitiesDiv = document.createElement('div');
        abilitiesDiv.className = 'LoadoutsPanel_abilities__x';
        const abilityContainer = document.createElement('div');
        abilityContainer.className = 'Ability_ability__1';
        abilityContainer.appendChild(makeUse('abilities_sprite.hash.svg#fireball'));
        abilitiesDiv.appendChild(abilityContainer);
        container.appendChild(abilitiesDiv);

        const slots = scrapeAbilities(container, null);
        expect(slots[1]).toEqual({ abilityHrid: '/abilities/fireball', level: 1 });
    });
});

describe('scrapeConsumables', () => {
    test('returns empty 3-slot food/drink arrays when container is missing', () => {
        const el = document.createElement('div');
        const result = scrapeConsumables(el, null);
        expect(result.food).toHaveLength(3);
        expect(result.drinks).toHaveLength(3);
        expect(result.food.every((f) => f.itemHrid === '')).toBe(true);
    });

    test('separates drinks from food based on HRID pattern', () => {
        const container = document.createElement('div');
        const consumablesDiv = document.createElement('div');
        consumablesDiv.className = 'LoadoutsPanel_consumables__x';
        consumablesDiv.appendChild(makeUse('items_sprite.hash.svg#coffee'));
        consumablesDiv.appendChild(makeUse('items_sprite.hash.svg#cheese_wheel'));
        container.appendChild(consumablesDiv);

        const result = scrapeConsumables(container, null);
        expect(result.drinks[0]).toEqual({ itemHrid: '/items/coffee' });
        expect(result.food[0]).toEqual({ itemHrid: '/items/cheese_wheel' });
    });

    test('classifies drinks using itemDetailMap type when the name has no drink hint', () => {
        const clientData = { itemDetailMap: { '/items/mystery_brew': { type: 'drink' } } };
        const container = document.createElement('div');
        const consumablesDiv = document.createElement('div');
        consumablesDiv.className = 'LoadoutsPanel_consumables__x';
        consumablesDiv.appendChild(makeUse('items_sprite.hash.svg#mystery_brew'));
        container.appendChild(consumablesDiv);

        const result = scrapeConsumables(container, clientData);
        expect(result.drinks[0]).toEqual({ itemHrid: '/items/mystery_brew' });
    });
});
