/** @vitest-environment happy-dom */
/**
 * A Loadouts-panel slot's tooltip names the item without "+N" when the loadout wears the highest level
 * owned; the observer reads the level off the hovered slot instead.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const game = vi.hoisted(() => ({ characterData: null, characterItems: [] }));

vi.mock('./dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('./data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        get characterItems() {
            return game.characterItems;
        },
        getItemDetails: () => undefined,
        getInitClientData: () => null,
    },
}));
vi.mock('../utils/market-data.js', () => ({ getItemPrices: () => null }));

const { default: tooltipObserver, classifyTooltip } = await import('./tooltip-observer.js');
const { applyLoadoutLevelToGameLines } = await import('../utils/loadout-tooltip-rewrite.js');

const GLOVES = '/items/enchanted_gloves';
const RING = '/items/ring_of_wisdom';

/** Wearable hash as the game sends it: character::location::item::level */
const wear = (location, itemHrid, level) => `31001::/item_locations/inventory::${itemHrid}::${level}`;

const loadout = (name, wearableMap, extra = {}) => ({
    id: 1,
    name,
    useExactEnhancement: false,
    wearableMap,
    foodItemHrids: [],
    drinkItemHrids: [],
    ...extra,
});

const sprite = (fragment) => `<svg><use href="/static/media/items_sprite.abc.svg#${fragment}"></use></svg>`;
const slotHtml = (fragment) => `<div class="Item_item__a">${sprite(fragment)}</div>`;

/** The Loadouts panel with a loadout name and some equipment slots; returns the slot icons */
function mountPanel(name, fragments, { withPanel = true } = {}) {
    const slots = fragments.map(slotHtml).join('');
    document.body.innerHTML = withPanel
        ? `<div class="LoadoutsPanel_loadoutsPanel__p">
               <div class="LoadoutsPanel_selectedLoadout__s">
                   <div class="LoadoutsPanel_metadata__m">Name<svg></svg>${name}<button>Edit</button></div>
                   <div class="LoadoutsPanel_equipment__e">${slots}</div>
               </div>
           </div>`
        : `<div class="Inventory_items__i">${slots}</div>`;
    return [...document.querySelectorAll('svg')].filter((svg) => svg.querySelector('use'));
}

const hover = (svg) => svg.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

/** The game's item tooltip for a slot: name element plus the item's sprite */
function tooltip(name, fragment = 'enchanted_gloves') {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__t">
        <div class="ItemTooltipText_name__n"><span>${name}</span></div>${sprite(fragment)}</div></div>`;
    return el;
}

beforeEach(() => {
    tooltipObserver.disable();
    tooltipObserver.initialize();
    document.body.innerHTML = '';
    game.characterItems = [{ itemHrid: GLOVES, enhancementLevel: 20, count: 1 }];
    game.characterData = {
        characterLoadoutMap: { 1: loadout('Boss Gear', { '/item_locations/hands': wear('hands', GLOVES, 0) }) },
    };
});

describe('level of a hovered Loadouts-panel slot', () => {
    test('use-highest on, +20 owned: the unsuffixed name reads as +20', () => {
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        const info = classifyTooltip(tooltip('Enchanted Gloves'));
        expect(info.enhancementLevel).toBe(20);
        expect(info.levelSource).toBe('loadout');
        expect(info.itemName).toBe('Enchanted Gloves');
    });

    test('a reused popper whose name Toolasha already set to +20 classifies from the game name, not its own', () => {
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        const el = tooltip('Enchanted Gloves');
        const first = classifyTooltip(el);
        applyLoadoutLevelToGameLines(el, first, GLOVES);
        expect(el.textContent).toContain('Enchanted Gloves +20');
        const again = classifyTooltip(el);
        expect(again.itemName).toBe('Enchanted Gloves');
        expect(again.levelSource).toBe('loadout');
    });

    test('a name that already carries +N wins', () => {
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        const info = classifyTooltip(tooltip('Enchanted Gloves +12'));
        expect(info.enhancementLevel).toBe(12);
        expect(info.levelSource).toBeUndefined();
    });

    test('use-highest off: the stored level, not the owned one', () => {
        game.characterData.characterLoadoutMap = {
            1: loadout(
                'Boss Gear',
                { '/item_locations/hands': wear('hands', GLOVES, 5) },
                { useExactEnhancement: true }
            ),
        };
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(5);
    });

    test('item not owned at the stored level: the stored level stands when nothing higher is owned', () => {
        game.characterItems = [];
        game.characterData.characterLoadoutMap = {
            1: loadout('Boss Gear', { '/item_locations/hands': wear('hands', GLOVES, 7) }),
        };
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(7);
    });

    test('outside the Loadouts panel (inventory) the level stays 0', () => {
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves'], { withPanel: false });
        hover(icon);
        const info = classifyTooltip(tooltip('Enchanted Gloves'));
        expect(info.enhancementLevel).toBe(0);
        expect(info.levelSource).toBeUndefined();
    });

    test('no hover at all keeps today behavior', () => {
        mountPanel('Boss Gear', ['enchanted_gloves']);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
    });

    test('loadout data missing keeps the level at 0', () => {
        game.characterData = null;
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
        game.characterData = {};
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
    });

    test('a panel naming a loadout that is not saved keeps the level at 0', () => {
        const [icon] = mountPanel('Someone Else', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
    });

    test('a slot that is not in the selected loadout keeps the level at 0', () => {
        game.characterData.characterLoadoutMap = { 1: loadout('Boss Gear', {}) };
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
    });

    test('with two slots, the hovered slot decides, matched by sprite', () => {
        game.characterItems = [
            { itemHrid: GLOVES, enhancementLevel: 20, count: 1 },
            { itemHrid: RING, enhancementLevel: 3, count: 1 },
        ];
        game.characterData.characterLoadoutMap = {
            1: loadout(
                'Boss Gear',
                { '/item_locations/hands': wear('hands', GLOVES, 0), '/item_locations/ring': wear('ring', RING, 0) },
                { useExactEnhancement: false }
            ),
        };
        const [glovesIcon, ringIcon] = mountPanel('Boss Gear', ['enchanted_gloves', 'ring_of_wisdom']);
        hover(ringIcon);
        expect(classifyTooltip(tooltip('Ring of Wisdom', 'ring_of_wisdom')).enhancementLevel).toBe(3);
        hover(glovesIcon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(20);
    });

    test('a tooltip for another item than the hovered slot is a stale hover and is not resolved', () => {
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Ring of Wisdom', 'ring_of_wisdom')).enhancementLevel).toBe(0);
    });

    test('same-named loadouts that disagree on the level are not guessed at', () => {
        game.characterData.characterLoadoutMap = {
            1: loadout(
                'Boss Gear',
                { '/item_locations/hands': wear('hands', GLOVES, 5) },
                { useExactEnhancement: true }
            ),
            2: loadout(
                'Boss Gear',
                { '/item_locations/hands': wear('hands', GLOVES, 9) },
                { useExactEnhancement: true }
            ),
        };
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
    });

    test('same-named loadouts that agree resolve', () => {
        game.characterData.characterLoadoutMap = {
            1: loadout(
                'Boss Gear',
                { '/item_locations/hands': wear('hands', GLOVES, 5) },
                { useExactEnhancement: true }
            ),
            2: loadout(
                'Boss Gear',
                { '/item_locations/hands': wear('hands', GLOVES, 5) },
                { useExactEnhancement: true }
            ),
        };
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(5);
    });

    test('disable() stops tracking the pointer', () => {
        const [icon] = mountPanel('Boss Gear', ['enchanted_gloves']);
        tooltipObserver.disable();
        hover(icon);
        expect(classifyTooltip(tooltip('Enchanted Gloves')).enhancementLevel).toBe(0);
    });
});
