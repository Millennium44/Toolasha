/** @vitest-environment happy-dom */
/**
 * The market filter's dropdowns against the state it filters by, across the marketplace being closed and
 * reopened (the game rebuilds the filter row each time) and the feature being turned off.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const game = vi.hoisted(() => ({ settings: { marketFilter: true }, items: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => game.settings[key] },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ itemDetailMap: game.items }) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onReady: () => () => {} },
}));

const { default: marketFilter } = await import('./market-filter.js');

/** Equipment shaped like the game's itemDetailMap entries */
const gear = (itemLevel, type, skill) => ({
    itemLevel,
    equipmentDetail: {
        type: `/equipment_types/${type}`,
        levelRequirements: [{ skillHrid: `/skills/${skill}`, level: itemLevel }],
    },
});

/** The marketplace's filter row and item grid; `xlink` draws the icon with the legacy attribute only */
function openMarketplace(slugs, { xlink = [] } = {}) {
    document.body.textContent = '';
    const panel = document.createElement('div');
    const filters = document.createElement('div');
    filters.className = 'MarketplacePanel_itemFilterContainer__a';
    const grid = document.createElement('div');
    grid.className = 'MarketplacePanel_marketItems__b';
    for (const slug of slugs) {
        const tile = document.createElement('div');
        tile.className = 'Item_itemContainer__c';
        const attr = xlink.includes(slug) ? 'xlink:href' : 'href';
        tile.innerHTML = `<div class="Item_item__d"><svg><use ${attr}="/static/media/items_sprite.svg#${slug}"></use></svg></div>`;
        tile.dataset.slug = slug;
        grid.appendChild(tile);
    }
    panel.append(filters, grid);
    document.body.appendChild(panel);
    marketFilter.injectFilterUI(filters);
    return grid;
}

const shown = (grid) =>
    Array.from(grid.children)
        .filter((tile) => tile.style.display !== 'none')
        .map((tile) => tile.dataset.slug);

function choose(id, value) {
    const select = document.getElementById(id);
    select.value = String(value);
    select.dispatchEvent(new Event('change'));
}

beforeEach(() => {
    game.items = {
        '/items/cheese': { itemLevel: 1 },
        '/items/wooden_sword': gear(1, 'main_hand', 'melee'),
        '/items/iron_sword': gear(20, 'main_hand', 'melee'),
        '/items/holy_sword': gear(70, 'main_hand', 'melee'),
        '/items/holy_bow': gear(70, 'two_hand', 'ranged'),
    };
    marketFilter.initialize();
});

afterEach(() => {
    marketFilter.disable();
    document.body.textContent = '';
});

describe('market filter', () => {
    test('a reopened marketplace shows the filter that is still being applied', () => {
        openMarketplace(['cheese', 'wooden_sword', 'iron_sword', 'holy_sword', 'holy_bow']);
        choose('toolasha-level-min', 20);
        choose('toolasha-class-filter', 'melee');
        choose('toolasha-slot-filter', 'main_hand');

        // Closed and opened again: the game draws a fresh filter row
        const grid = openMarketplace(['cheese', 'wooden_sword', 'iron_sword', 'holy_sword', 'holy_bow']);
        expect(shown(grid)).toEqual(['iron_sword', 'holy_sword']);
        expect(document.getElementById('toolasha-level-min').value).toBe('20');
        expect(document.getElementById('toolasha-level-max').value).toBe('1000');
        expect(document.getElementById('toolasha-class-filter').value).toBe('melee');
        expect(document.getElementById('toolasha-slot-filter').value).toBe('main_hand');
    });

    test('an item whose icon carries only xlink:href is filtered like the rest', () => {
        const grid = openMarketplace(['wooden_sword', 'holy_sword', 'holy_bow'], { xlink: ['wooden_sword'] });
        choose('toolasha-level-min', 50);
        expect(shown(grid)).toEqual(['holy_sword', 'holy_bow']);
    });

    test('turning it off shows what it hid, leaves other hidden tiles alone, and starts again from the defaults', () => {
        const grid = openMarketplace(['cheese', 'wooden_sword', 'iron_sword', 'holy_sword']);
        // Hidden by something else before the filter ran
        const other = document.createElement('div');
        other.className = 'Item_itemContainer__c';
        other.style.display = 'none';
        other.dataset.slug = 'other';
        choose('toolasha-level-min', 50);
        grid.appendChild(other);
        expect(shown(grid)).toEqual(['holy_sword']);

        marketFilter.disable();
        expect(shown(grid)).toEqual(['cheese', 'wooden_sword', 'iron_sword', 'holy_sword']);
        expect(other.style.display).toBe('none');

        marketFilter.initialize();
        const reopened = openMarketplace(['cheese', 'wooden_sword', 'iron_sword', 'holy_sword']);
        expect(shown(reopened)).toEqual(['cheese', 'wooden_sword', 'iron_sword', 'holy_sword']);
        expect(document.getElementById('toolasha-level-min').value).toBe('1');
    });
});
