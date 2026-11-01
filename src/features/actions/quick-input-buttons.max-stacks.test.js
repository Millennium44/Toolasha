/**
 * The Max button counts only what a craft can spend: +0 copies in the bag.
 *
 * The character item list carries equipped gear alongside the inventory, and an enhanced copy of
 * an item is never drawn as a production input or as the +0 upgrade. Counting either filled Max
 * with crafts the game refuses to queue.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

const game = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => null,
        getItemDetails: () => null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
        getEquipment: () => new Map(),
        getPersonalBuffFlatBoost: () => 0,
        isTaskAction: () => false,
        isBuffBeingSimulated: () => false,
        getCommunityBuffLevel: () => 0,
        characterData: {},
        on: () => () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async () => false), set: vi.fn() },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
    },
}));

vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => new Set() },
}));

const quickInputButtons = (await import('./quick-input-buttons.js')).default;

const CHEESE_SWORD = '/items/cheese_sword';
const VERDANT_CHEESE = '/items/verdant_cheese';
const CHARM = '/items/foraging_charm';
const CHARM_MATS = '/items/charm_mats';

function row(itemHrid, count, enhancementLevel = 0, itemLocationHrid = '/item_locations/inventory') {
    return { itemHrid, count, enhancementLevel, itemLocationHrid };
}

const VERDANT_SWORD = {
    hrid: '/actions/cheesesmithing/verdant_sword',
    type: '/action_types/cheesesmithing',
    inputItems: [{ itemHrid: VERDANT_CHEESE, count: 10 }],
    upgradeItemHrid: CHEESE_SWORD,
};

const ADVANCED_CHARM = {
    hrid: '/actions/crafting/advanced_foraging_charm',
    type: '/action_types/crafting',
    inputItems: [
        { itemHrid: CHARM, count: 1 },
        { itemHrid: CHARM_MATS, count: 5 },
    ],
    upgradeItemHrid: CHARM,
};

describe('Max for production', () => {
    beforeEach(() => {
        game.inventory = [];
    });

    test('an equipped upgrade item is not in the bag', () => {
        game.inventory = [row(VERDANT_CHEESE, 1000), row(CHEESE_SWORD, 1, 0, '/item_locations/main_hand')];
        expect(quickInputButtons.calculateMaxValue(null, VERDANT_SWORD, { itemDetailMap: {} })).toBe(0);
    });

    test('enhanced or equipped copies of an input buy no crafts', () => {
        game.inventory = [
            row(CHARM, 2, 0),
            row(CHARM, 4, 3),
            row(CHARM, 1, 0, '/item_locations/charm'),
            row(CHARM_MATS, 1000),
        ];
        // Two +0 charms in the bag, two per craft (one input, one upgrade)
        expect(quickInputButtons.calculateMaxValue(null, ADVANCED_CHARM, { itemDetailMap: {} })).toBe(1);
    });
});

describe('Max follows the upgrade stack the slot shows', () => {
    /** An action panel whose upgrade slot shows `itemTail` at `badge` ('+7', or '' for +0); no tail = empty */
    function panelWithSlot(itemTail, badge = '') {
        const panel = document.createElement('div');
        const icon = itemTail
            ? `<div class="Item_item__x"><svg><use href="/static/media/items_sprite.abc.svg#${itemTail}"></use></svg>${
                  badge ? `<div class="Item_enhancementLevel__y">${badge}</div>` : ''
              }<div class="Item_count__z">3</div></div>`
            : '<div class="SkillActionDetail_warning__w">No upgrade item selected</div>';
        panel.innerHTML = `<div class="SkillActionDetail_upgradeItemSelectorInput__q">${icon}</div>`;
        return panel;
    }

    beforeEach(() => {
        game.inventory = [row(VERDANT_CHEESE, 1000), row(CHEESE_SWORD, 2, 0), row(CHEESE_SWORD, 3, 7)];
    });

    test('a +0 selection counts the +0 stack', () => {
        const panel = panelWithSlot('cheese_sword');
        expect(quickInputButtons.calculateMaxValue(panel, VERDANT_SWORD, { itemDetailMap: {} })).toBe(2);
    });

    test('a +7 selection counts the +7 stack, not the +0 one', () => {
        const panel = panelWithSlot('cheese_sword', '+7');
        expect(quickInputButtons.calculateMaxValue(panel, VERDANT_SWORD, { itemDetailMap: {} })).toBe(3);
    });

    test('a +7 selection with no +7 copy in the bag affords nothing even with +0 copies held', () => {
        game.inventory = [row(VERDANT_CHEESE, 1000), row(CHEESE_SWORD, 2, 0)];
        const panel = panelWithSlot('cheese_sword', '+7');
        expect(quickInputButtons.calculateMaxValue(panel, VERDANT_SWORD, { itemDetailMap: {} })).toBe(0);
    });

    test('an empty slot is 0 even with stock, as in the game', () => {
        expect(quickInputButtons.calculateMaxValue(panelWithSlot(null), VERDANT_SWORD, { itemDetailMap: {} })).toBe(0);
    });

    test('an enhanced selection of the item that is also an input leaves the +0 copies to the input', () => {
        game.inventory = [row(CHARM, 4, 0), row(CHARM, 5, 3), row(CHARM_MATS, 1000)];
        // +3 slot: five upgrade copies; the four +0 charms feed the one-per-craft input
        const panel = panelWithSlot('foraging_charm', '+3');
        expect(quickInputButtons.calculateMaxValue(panel, ADVANCED_CHARM, { itemDetailMap: {} })).toBe(4);
    });
});
