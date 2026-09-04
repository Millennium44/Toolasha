/** @vitest-environment happy-dom
 *
 * Five handlers used to reach the shared observer through `register()` rather
 * than `onClass()`, which means no class filter at all: `_dispatch` runs an
 * unfiltered handler for *every* element inserted anywhere on the page, so a
 * marketplace tab search and a loadout re-annotate were running through the
 * whole of combat. Each now carries a class list.
 *
 * These tests hold the class lists themselves to account: the risk of a filter
 * is not that it is too wide but that it is too narrow, so every case below
 * pairs "still fires for the markup the feature must handle" with "no longer
 * fires for markup it never cared about". The class lists are imported from
 * the features rather than restated here, so a list that drifts fails here.
 */
import { describe, test, expect, afterEach } from 'vitest';
import domObserver from './dom-observer.js';
import { TAB_WATCH_CLASSES } from '../features/market/mooket/index.js';
import { ZONE_INDEX_CLASSES } from '../features/combat/zone-indices.js';
import { ITEM_ICON_CLASSES } from '../features/ui/equipment-level-display.js';
import { POPUP_TAB_CLASSES } from '../features/combat/party-profile-button.js';
import { LOADOUT_WATCH_CLASSES } from '../features/combat/loadout-enhancement-display.js';
import { BADGE_CLASSES } from '../features/market/marketplace-badge-filter.js';

afterEach(() => {
    domObserver.stop();
    domObserver.handlers = [];
    document.body.innerHTML = '';
});

/**
 * Build an element from an HTML fragment, hand it to the shared observer
 * exactly as a childList mutation would, and report how many times a handler
 * watching `classes` was run for it.
 * @param {string[]} classes - The watched class list
 * @param {string} html - The inserted subtree
 * @returns {number} How many times the handler ran
 */
function runsFor(classes, html) {
    let hits = 0;
    const unregister = domObserver.onClass('UnderTest', classes, () => {
        hits += 1;
    });
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const node = holder.firstElementChild;
    document.body.appendChild(node);
    domObserver.dispatch(node, {});
    unregister();
    return hits;
}

/** Markup the observer sees constantly during combat and none of these features want. */
const COMBAT_NOISE = [
    '<div class="CombatUnit_splatContainer__2dMC1"><span class="CombatUnit_damage__2SmS0">1234</span></div>',
    '<div class="Chat_chatMessage__2ITpU"><span class="Chat_chatIcon__1Iyfg"></span>hello</div>',
    '<div class="BattlePanel_monsterInfo__3AL8N"><div class="BattlePanel_bar__1yzHi"></div></div>',
];

describe('MarketHistoryTab', () => {
    test('fires for the marketplace tab strip it puts its tab into', () => {
        expect(
            runsFor(
                TAB_WATCH_CLASSES,
                '<div class="MuiTabs-flexContainer css-k008qs" role="tablist"><button>Market Listings</button></div>'
            )
        ).toBe(1);
    });

    test('fires when the marketplace panel arrives with the strip inside it', () => {
        expect(
            runsFor(
                TAB_WATCH_CLASSES,
                '<div class="MarketplacePanel_marketplacePanel__1eAsx">' +
                    '<div class="MuiTabs-root"><div class="MuiTabs-flexContainer" role="tablist"></div></div>' +
                    '</div>'
            )
        ).toBeGreaterThan(0);
    });

    test('no longer fires for combat DOM', () => {
        for (const html of COMBAT_NOISE) expect(runsFor(TAB_WATCH_CLASSES, html)).toBe(0);
    });
});

describe('ZoneIndices', () => {
    test('fires for a task card name, which addTaskIndices annotates', () => {
        expect(runsFor(ZONE_INDEX_CLASSES, '<div class="RandomTask_name__3Ka-o">Defeat - Jerry</div>')).toBe(1);
    });

    test('fires for the combat panel tab container addMapIndices numbers', () => {
        expect(
            runsFor(
                ZONE_INDEX_CLASSES,
                '<div class="CombatPanel_tabsComponentContainer__GsQlg">' +
                    '<div class="MuiTabs-root MuiTabs-vertical"></div></div>'
            )
        ).toBeGreaterThan(0);
    });

    test('fires for a single zone tab button inserted into an existing strip', () => {
        expect(
            runsFor(
                ZONE_INDEX_CLASSES,
                '<button class="MuiButtonBase-root MuiTab-root"><span class="MuiBadge-root"></span></button>'
            )
        ).toBe(1);
    });

    test('no longer fires for combat DOM', () => {
        for (const html of COMBAT_NOISE) expect(runsFor(ZONE_INDEX_CLASSES, html)).toBe(0);
    });
});

describe('EquipmentLevelDisplay', () => {
    test('fires for an item icon, the only thing addItemLevels touches', () => {
        expect(
            runsFor(
                ITEM_ICON_CLASSES,
                '<div class="Item_itemContainer__x7kH1">' +
                    '<div class="Item_item__2De2O Item_clickable__3viV6"><svg><use href="#items_sprite_sword"></use></svg></div>' +
                    '</div>'
            )
        ).toBeGreaterThan(0);
    });

    test('fires for a bare item div remounted on its own', () => {
        expect(runsFor(ITEM_ICON_CLASSES, '<div class="Item_item__2De2O Item_clickable__3viV6"></div>')).toBe(1);
    });

    test('no longer fires for combat DOM', () => {
        for (const html of COMBAT_NOISE) expect(runsFor(ITEM_ICON_CLASSES, html)).toBe(0);
    });
});

describe('PartyProfileButton', () => {
    test('fires for the battle-unit popup tab row it injects into', () => {
        expect(
            runsFor(
                POPUP_TAB_CLASSES,
                '<div class="MuiTabs-flexContainer" role="tablist">' +
                    '<button>Battle Info</button><button>Stats</button></div>'
            )
        ).toBe(1);
    });

    test('no longer fires for combat DOM', () => {
        for (const html of COMBAT_NOISE) expect(runsFor(POPUP_TAB_CLASSES, html)).toBe(0);
    });
});

describe('LoadoutEnhancementDisplay', () => {
    test('fires for the selected loadout it annotates', () => {
        expect(
            runsFor(
                LOADOUT_WATCH_CLASSES,
                '<div class="LoadoutsPanel_selectedLoadout__1t7Ck">' +
                    '<div class="LoadoutsPanel_equipment__2s0Cn"></div></div>'
            )
        ).toBeGreaterThan(0);
    });

    test('fires for a single equipment slot remounted inside an open loadout', () => {
        expect(runsFor(LOADOUT_WATCH_CLASSES, '<div class="Item_item__2De2O"></div>')).toBe(1);
    });

    test('no longer fires for combat DOM', () => {
        for (const html of COMBAT_NOISE) expect(runsFor(LOADOUT_WATCH_CLASSES, html)).toBe(0);
    });
});

describe('MarketplaceBadge', () => {
    test('fires for the nav badge it rewrites', () => {
        expect(runsFor(BADGE_CLASSES, '<div class="NavigationBar_badge__1Kdva">7</div>')).toBe(1);
    });

    test('fires when the whole nav item is rebuilt around the badge', () => {
        expect(
            runsFor(
                BADGE_CLASSES,
                '<div class="NavigationBar_navigationLink__3Q4hh"><div class="NavigationBar_badge__1Kdva">7</div></div>'
            )
        ).toBe(1);
    });

    test('no longer fires for combat DOM', () => {
        for (const html of COMBAT_NOISE) expect(runsFor(BADGE_CLASSES, html)).toBe(0);
    });
});

/**
 * Hand `classes` an inserted container the way a childList mutation would, with
 * the handler registered debounced — which is how all six of these actually
 * register — and report how many times the callback ran once the debounce fired.
 * @param {string[]} classes - The watched class list
 * @param {string} html - The inserted subtree
 * @returns {Promise<number>} How many times the handler ran
 */
async function debouncedRunsFor(classes, html) {
    let hits = 0;
    const unregister = domObserver.onClass(
        'UnderTest',
        classes,
        () => {
            hits += 1;
        },
        { debounce: true, debounceDelay: 5 }
    );
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const node = holder.firstElementChild;
    document.body.appendChild(node);
    domObserver.dispatch(node, {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    unregister();
    return hits;
}

describe('a debounced class handler is collapsed to one call per burst', () => {
    /** An inventory-shaped container: `count` tiles, each with two `Item_item` matches. */
    const tiles = (count) =>
        '<div class="Inventory_items__6SXv0">' +
        '<div class="Item_itemContainer__x7kH1"><div class="Item_item__2De2O Item_clickable__3viV6"></div></div>'.repeat(
            count
        ) +
        '</div>';

    test('EquipmentLevelDisplay runs once for a panel of item tiles, not once per tile', async () => {
        // Every tile carries `Item_itemContainer__` *and* `Item_item__`, both of
        // which the one watched substring matches, so the fan-out was two calls
        // per tile — and `addItemLevels` re-queries the whole document each time.
        // Registered through `register()` this was one call for the container.
        expect(await debouncedRunsFor(ITEM_ICON_CLASSES, tiles(50))).toBe(1);
    });

    test('LoadoutEnhancementDisplay runs once for a loadout panel of equipment slots', async () => {
        const loadout =
            '<div class="LoadoutsPanel_panel__9aQ2z">' +
            '<div class="LoadoutsPanel_selectedLoadout__1t7Ck">' +
            '<div class="LoadoutsPanel_equipment__2s0Cn">' +
            '<div class="Item_itemContainer__x7kH1"><div class="Item_item__2De2O"></div></div>'.repeat(10) +
            '</div></div></div>';
        // Two watched classes here, and `annotateLoadout` clears and re-injects
        // every overlay in the panel on each run.
        expect(await debouncedRunsFor(LOADOUT_WATCH_CLASSES, loadout)).toBe(1);
    });

    test('ZoneIndices runs once for a combat panel full of zone tabs', async () => {
        const panel =
            '<div class="MainPanel_subPanelContainer__1i-H9">' +
            '<div class="CombatPanel_tabsComponentContainer__GsQlg"><div class="MuiTabs-root MuiTabs-vertical">' +
            '<button class="MuiButtonBase-root MuiTab-root"><span class="MuiBadge-root"></span></button>'.repeat(12) +
            '</div></div></div>';
        expect(await debouncedRunsFor(ZONE_INDEX_CLASSES, panel)).toBe(1);
    });

    test('MarketHistoryTab runs once for a marketplace panel, not once per watched class', async () => {
        expect(
            await debouncedRunsFor(
                TAB_WATCH_CLASSES,
                '<div class="MainPanel_panel__1Zbdt">' +
                    '<div class="MarketplacePanel_marketplacePanel__1eAsx">' +
                    '<div class="MuiTabs-root"><div class="MuiTabs-flexContainer" role="tablist">' +
                    '<button class="MuiTab-root">Market Listings</button></div></div>' +
                    '</div></div>'
            )
        ).toBe(1);
    });

    test('PartyProfileButton runs once for a popup carrying both watched classes', async () => {
        expect(
            await debouncedRunsFor(
                POPUP_TAB_CLASSES,
                '<div class="Modal_modalContainer__3B9iF"><div class="MuiTabs-root">' +
                    '<div class="MuiTabs-flexContainer" role="tablist">' +
                    '<button>Battle Info</button><button>Stats</button></div></div></div>'
            )
        ).toBe(1);
    });

    test('an undebounced handler still gets every match, one call each', async () => {
        // The collapse is a property of the debounce, not of `onClass`: features
        // that ask for a call per matching element still get one.
        expect(runsFor(ITEM_ICON_CLASSES, tiles(3))).toBe(6);
    });
});

describe('every audited handler carries a usable class list', () => {
    test('none of the six is left with an empty or malformed filter', () => {
        const lists = [
            TAB_WATCH_CLASSES,
            ZONE_INDEX_CLASSES,
            ITEM_ICON_CLASSES,
            POPUP_TAB_CLASSES,
            LOADOUT_WATCH_CLASSES,
            BADGE_CLASSES,
        ];
        for (const list of lists) {
            expect(Array.isArray(list)).toBe(true);
            expect(list.length).toBeGreaterThan(0);
            for (const cls of list) expect(typeof cls === 'string' && cls.length > 0).toBe(true);
        }
    });
});
