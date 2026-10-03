/** @vitest-environment happy-dom */

/**
 * The Item Dictionary's View Action button works out which item and which action it is looking at.
 * The game translates every name it draws, so the English-name lookup misses on a non-English
 * client; the item popup's icon sprite and the action modal's component props do not change with
 * the language. These tests drive the two entry points that used to read names only.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const lookups = vi.hoisted(() => ({
    itemsByName: {},
    itemsByIcon: {},
    actionsByName: {},
    fiberAction: null,
    materialCalls: [],
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../../utils/item-navigation.js', () => ({
    navigateToItem: vi.fn(),
    findActionForItem: vi.fn(() => null),
}));
vi.mock('../../utils/react-input.js', () => ({ setReactInputValue: vi.fn() }));
vi.mock('../../utils/material-calculator.js', () => ({
    calculateMaterialRequirements: (actionHrid, numActions) => {
        lookups.materialCalls.push({ actionHrid, numActions });
        return [{ itemHrid: '/items/milk', missing: 3 }];
    },
}));
vi.mock('../../utils/game-lookups.js', () => ({
    getItemHridFromName: (name) => lookups.itemsByName[name] ?? null,
    getActionHridFromName: (name) => (name === 'Cheese' ? '/actions/cheesesmithing/cheese' : null),
    getActionHridFromFiber: () => lookups.fiberAction,
    getItemHridFromIconHref: (href) => (href ? (lookups.itemsByIcon[href] ?? null) : null),
    getIconHref: (el) => el.querySelector('svg use')?.getAttribute('href') ?? null,
}));

const { default: viewActionButton } = await import('./view-action-button.js');
const { findActionForItem } = await import('../../utils/item-navigation.js');

const MILK_ICON = '/static/media/items_sprite.0a1b2c.svg#milk';

beforeEach(() => {
    document.body.innerHTML = '';
    lookups.itemsByName = {};
    lookups.itemsByIcon = {};
    lookups.fiberAction = null;
    lookups.materialCalls = [];
    vi.clearAllMocks();
});

describe('the item popup', () => {
    /** An item action menu as the game draws it: the item's icon, then its (translated) name */
    const popup = (name, icon) => {
        const menu = document.createElement('div');
        menu.className = 'Item_actionMenu__x';
        menu.innerHTML =
            (icon ? `<svg><use href="${icon}"></use></svg>` : '') + `<div class="Item_name__y">${name}</div>`;
        document.body.appendChild(menu);
        return menu;
    };

    test('a translated item name is resolved by its icon', () => {
        lookups.itemsByIcon = { [MILK_ICON]: '/items/milk' };

        viewActionButton.injectPopupButton(popup('牛奶', MILK_ICON));

        expect(findActionForItem).toHaveBeenCalledWith('/items/milk');
    });

    test('an icon-less English popup still resolves by its name', () => {
        lookups.itemsByName = { Milk: '/items/milk' };

        viewActionButton.injectPopupButton(popup('Milk', null));

        expect(findActionForItem).toHaveBeenCalledWith('/items/milk');
    });

    test('a translated popup with no icon cannot be resolved', () => {
        viewActionButton.injectPopupButton(popup('牛奶', null));

        expect(findActionForItem).not.toHaveBeenCalled();
    });
});

describe('the action modal behind the missing count', () => {
    const modal = (title) => {
        const nameEl = document.createElement('div');
        nameEl.className = 'SkillActionDetail_name__x';
        nameEl.textContent = title;
        const count = document.createElement('div');
        count.className = 'maxActionCountInput__y';
        count.innerHTML = '<input value="10" />';
        document.body.append(nameEl, count);
    };

    test('a translated modal title is resolved by the modal props', () => {
        lookups.fiberAction = '/actions/cheesesmithing/cheese';
        modal('奶酪');

        expect(viewActionButton._calcMissingFromGameData('/items/milk')).toBe(3);
        expect(lookups.materialCalls).toEqual([{ actionHrid: '/actions/cheesesmithing/cheese', numActions: 10 }]);
    });

    test('an English title still resolves when the props name nothing', () => {
        modal('Cheese');

        expect(viewActionButton._calcMissingFromGameData('/items/milk')).toBe(3);
    });

    test('a translated title the props cannot name resolves to nothing', () => {
        modal('奶酪');

        expect(viewActionButton._calcMissingFromGameData('/items/milk')).toBeNull();
        expect(lookups.materialCalls).toEqual([]);
    });
});
