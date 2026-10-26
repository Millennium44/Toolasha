/** @vitest-environment happy-dom */
/**
 * Shop max-buy math: cost lines resolved from a buy dialog, the affordable maximum, and the
 * downward search against the Buy button's disabled state.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/coin': { name: 'Coin' },
                '/items/task_token': { name: 'Task Token' },
                '/items/cowbell': { name: 'Cowbell' },
            },
            communityBuffTypeDetailMap: {
                '/community_buff_types/experience': { buff: { typeHrid: '/buff_types/wisdom' }, cowbellCost: 20 },
                '/community_buff_types/gathering_quantity': {
                    buff: { typeHrid: '/buff_types/gathering' },
                    cowbellCost: 10,
                },
            },
        }),
    },
}));

import {
    resolveCostLines,
    computeMaxAffordable,
    findMaxValidQuantity,
    resolveCommunityBuffCostLines,
    normalizeCostLinesToUnit,
} from './shop-max-buy.js';

const INV = '/item_locations/inventory';

function icon(fragment) {
    return `<svg><use href="/static/media/items_sprite.abc.svg#${fragment}"></use></svg>`;
}

/** Input container followed by its cost row, as the game lays out a buy dialog */
function dialog(costHtml) {
    document.body.innerHTML = `<div><div id="c"></div><div id="cost">${costHtml}</div></div>`;
    return document.getElementById('c');
}

describe('computeMaxAffordable', () => {
    beforeEach(() => {
        state.inventory = [];
    });

    test('takes the minimum across multiple cost lines', () => {
        state.inventory = [
            { itemHrid: '/items/coin', itemLocationHrid: INV, count: 10000 },
            { itemHrid: '/items/task_token', itemLocationHrid: INV, count: 25 },
        ];
        const max = computeMaxAffordable([
            { itemHrid: '/items/coin', perUnitAmount: 1000 },
            { itemHrid: '/items/task_token', perUnitAmount: 5 },
        ]);
        expect(max).toBe(5);
    });

    test('sums stacks of the same item in inventory only', () => {
        state.inventory = [
            { itemHrid: '/items/coin', itemLocationHrid: INV, count: 600 },
            { itemHrid: '/items/coin', itemLocationHrid: INV, count: 500 },
            { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/equipment', count: 9999 },
        ];
        expect(computeMaxAffordable([{ itemHrid: '/items/coin', perUnitAmount: 100 }])).toBe(11);
    });

    test('returns null when none is owned', () => {
        expect(computeMaxAffordable([{ itemHrid: '/items/coin', perUnitAmount: 10 }])).toBeNull();
    });

    test('returns null when one unit is unaffordable on any line', () => {
        state.inventory = [
            { itemHrid: '/items/coin', itemLocationHrid: INV, count: 10000 },
            { itemHrid: '/items/task_token', itemLocationHrid: INV, count: 2 },
        ];
        const max = computeMaxAffordable([
            { itemHrid: '/items/coin', perUnitAmount: 10 },
            { itemHrid: '/items/task_token', perUnitAmount: 5 },
        ]);
        expect(max).toBeNull();
    });

    test('returns null with no cost lines or a zero per-unit amount', () => {
        expect(computeMaxAffordable([])).toBeNull();
        expect(computeMaxAffordable([{ itemHrid: '/items/coin', perUnitAmount: 0 }])).toBeNull();
    });
});

describe('resolveCostLines', () => {
    test('reads each currency by its icon sprite, one line per cost', () => {
        const c = dialog(
            `<div>You Pay</div><div><div>50 ${icon('task_token')}</div><div>1,200 ${icon('coin')}</div></div>`
        );
        expect(resolveCostLines(c)).toEqual([
            { itemHrid: '/items/task_token', perUnitAmount: 50 },
            { itemHrid: '/items/coin', perUnitAmount: 1200 },
        ]);
    });

    test('reads an icon that only carries xlink:href', () => {
        const c = dialog(`<div>7 <svg><use xlink:href="/m/items_sprite.x.svg#cowbell"></use></svg></div>`);
        expect(resolveCostLines(c)).toEqual([{ itemHrid: '/items/cowbell', perUnitAmount: 7 }]);
    });

    test('falls back to the item name when the row draws no icon', () => {
        const c = dialog('<div>5,000 Coin</div>');
        expect(resolveCostLines(c)).toEqual([{ itemHrid: '/items/coin', perUnitAmount: 5000 }]);
    });

    test('drops a cost line it cannot identify', () => {
        const c = dialog(`<div>10 Mystery</div><div>3 ${icon('cowbell')}</div>`);
        expect(resolveCostLines(c)).toEqual([{ itemHrid: '/items/cowbell', perUnitAmount: 3 }]);
    });

    test('returns nothing when there is no cost row', () => {
        document.body.innerHTML = '<div id="c"></div>';
        expect(resolveCostLines(document.getElementById('c'))).toEqual([]);
    });
});

describe('findMaxValidQuantity', () => {
    test('keeps the candidate when the dialog accepts it', async () => {
        const probe = vi.fn(async () => false);
        expect(await findMaxValidQuantity(40, probe)).toBe(40);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    test('searches down to a hidden purchase cap', async () => {
        const probe = vi.fn(async (q) => q > 17);
        expect(await findMaxValidQuantity(1000, probe)).toBe(17);
    });

    test('returns null when even one is rejected', async () => {
        expect(await findMaxValidQuantity(50, async () => true)).toBeNull();
    });

    test('stops when the oracle is lost at the first probe or mid-search', async () => {
        expect(await findMaxValidQuantity(50, async () => null)).toBeNull();
        const probe = vi.fn(async (q) => (q === 50 ? true : null));
        expect(await findMaxValidQuantity(50, probe)).toBeNull();
        expect(probe).toHaveBeenCalledTimes(2);
    });
});

describe('Community Buff dialogs', () => {
    // Mirrors the real dialog: buff icon block, then the input container, then the "You Pay" row.
    function buffDialog(iconName, { quantity = 10, total = 100 } = {}) {
        document.body.innerHTML = `
            <div class="CowbellStorePanel_modalContent__1JNWg">
                <div class="CommunityBuff_communityBuff__1BILG">
                    <svg aria-label="buff"><use href="/static/media/buffs_sprite.cd54d85e.svg#${iconName}"></use></svg>
                </div>
                <div class="CowbellStorePanel_inputContainer__3iH6M"><input type="number" value="${quantity}"></div>
                <div>You Pay: ${total} ${icon('cowbell')}</div>
            </div>`;
        return document.querySelector('[class*="inputContainer"]');
    }

    beforeEach(() => {
        state.inventory = [];
    });

    test('a 10-minute dialog takes the unit cost from game data, not the displayed total', () => {
        const container = buffDialog('gathering', { quantity: 10, total: 100 });
        // The displayed row alone reads as a 100-cowbell unit price, which is the bug
        expect(resolveCostLines(container)).toEqual([{ itemHrid: '/items/cowbell', perUnitAmount: 100 }]);

        const lines = resolveCommunityBuffCostLines(container);
        expect(lines).toEqual([{ itemHrid: '/items/cowbell', perUnitAmount: 10 }]);

        state.inventory = [{ itemHrid: '/items/cowbell', itemLocationHrid: INV, count: 1234 }];
        expect(computeMaxAffordable(lines)).toBe(Math.floor(1234 / 10));
    });

    test('each buff resolves its own cost by icon, whatever language the dialog text is in', () => {
        expect(resolveCommunityBuffCostLines(buffDialog('wisdom'))[0].perUnitAmount).toBe(20);
        expect(resolveCommunityBuffCostLines(buffDialog('gathering'))[0].perUnitAmount).toBe(10);
    });

    test('an unknown buff or a non-buff dialog resolves to null so the caller can divide instead', () => {
        expect(resolveCommunityBuffCostLines(buffDialog('mystery'))).toBeNull();
        document.body.innerHTML =
            '<div><div class="CowbellStorePanel_inputContainer__3iH6M"><input type="number"></div></div>';
        expect(resolveCommunityBuffCostLines(document.querySelector('[class*="inputContainer"]'))).toBeNull();
    });

    test('normalizeCostLinesToUnit divides a displayed total by the typed quantity', () => {
        expect(normalizeCostLinesToUnit([{ itemHrid: '/items/cowbell', perUnitAmount: 100 }], 10)).toEqual([
            { itemHrid: '/items/cowbell', perUnitAmount: 10 },
        ]);
    });

    test('normalizeCostLinesToUnit leaves lines alone for quantity 1, invalid, or uneven division', () => {
        const lines = [{ itemHrid: '/items/cowbell', perUnitAmount: 105 }];
        expect(normalizeCostLinesToUnit(lines, 1)).toBe(lines);
        expect(normalizeCostLinesToUnit(lines, NaN)).toBe(lines);
        expect(normalizeCostLinesToUnit(lines, 10)).toBe(lines);
    });
});
