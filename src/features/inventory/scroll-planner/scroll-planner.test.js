/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const ITEM_DETAIL_MAP = {
    '/items/seal_of_damage': {
        hrid: '/items/seal_of_damage',
        name: 'Scroll Of Damage',
        categoryHrid: '/item_categories/scroll',
        isOpenable: true,
        sortIndex: 1,
    },
    '/items/seal_of_gathering': {
        hrid: '/items/seal_of_gathering',
        name: 'Scroll Of Gathering',
        categoryHrid: '/item_categories/scroll',
        isOpenable: true,
        sortIndex: 2,
    },
    '/items/seal_of_wisdom': {
        hrid: '/items/seal_of_wisdom',
        name: 'Scroll Of Wisdom',
        categoryHrid: '/item_categories/scroll',
        isOpenable: true,
        sortIndex: 3,
    },
    '/items/cheese': { hrid: '/items/cheese', name: 'Cheese', categoryHrid: '/item_categories/food', sortIndex: 9 },
};

const mocks = vi.hoisted(() => ({
    settings: { scrollPlanner: true },
    onClass: vi.fn(),
    unregister: vi.fn(),
    listeners: {},
    store: new Map(),
    writes: [],
    characterId: 'char-1',
    characterItems: [],
    saveGate: null,
}));

vi.mock('../../../core/config.js', () => ({ default: { getSetting: (key) => mocks.settings[key] } }));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: mocks.onClass } }));
vi.mock('../../../core/storage.js', () => ({
    default: {
        getJSON: vi.fn(async (key, _store, fallback) => (mocks.store.has(key) ? mocks.store.get(key) : fallback)),
        setJSON: vi.fn(async (key, value) => {
            if (mocks.saveGate) await mocks.saveGate;
            mocks.writes.push(['set', key, mocks.characterId]);
            mocks.store.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        }),
        delete: vi.fn(async (key) => {
            mocks.writes.push(['delete', key, mocks.characterId]);
            mocks.store.delete(key);
            return true;
        }),
    },
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        on: (event, fn) => {
            mocks.listeners[event] = fn;
        },
        off: (event, fn) => {
            if (mocks.listeners[event] === fn) delete mocks.listeners[event];
        },
        get characterItems() {
            return mocks.characterItems;
        },
        getCurrentCharacterId: () => mocks.characterId,
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP }),
        getItemDetails: (hrid) => ITEM_DETAIL_MAP[hrid] || null,
    },
}));

import { ScrollPlanner } from './scroll-planner.js';
import { isScrollRunActive } from './scroll-planner-state.js';

const SPRITE = '/static/media/items_sprite.6d12eb9d.svg';
const DAMAGE = '/items/seal_of_damage';
const GATHERING = '/items/seal_of_gathering';
const WISDOM = '/items/seal_of_wisdom';

const inv = (itemHrid, count, extra = {}) => ({
    itemHrid,
    count,
    itemLocationHrid: '/item_locations/inventory',
    enhancementLevel: 0,
    ...extra,
});

/** An item action menu as the game draws it: icon, translated name, quantity field, buttons */
function buildMenu(name, itemHrid) {
    const menu = document.createElement('div');
    menu.className = 'Item_actionMenu__x';
    const icon = itemHrid ? `<svg><use href="${SPRITE}#${itemHrid.split('/').pop()}"></use></svg>` : '';
    menu.innerHTML = `
        <div>${icon}<span class="Item_name__x">${name}</span></div>
        <div class="Item_amountInputContainer__x"><div><input type="number" value="1"></div></div>
        <button class="Button_button__x">Open 1</button>
        <button class="Button_button__x">View Marketplace</button>
    `;
    document.body.appendChild(menu);
    // Mimic the game's label following the quantity field
    const input = menu.querySelector('input');
    input.addEventListener('input', () => {
        menu.querySelector('button').textContent = `Open ${input.value}`;
    });
    return menu;
}

function buildInventory(itemHrids) {
    const inventory = document.createElement('div');
    inventory.className = 'Inventory_items__x';
    const clicks = [];
    for (const hrid of itemHrids) {
        const tile = document.createElement('div');
        tile.className = 'Item_itemContainer__x';
        tile.innerHTML = `<div class="Item_item__x Item_clickable__x"><svg aria-label="?"><use xlink:href="${SPRITE}#${hrid.split('/').pop()}"></use></svg></div>`;
        tile.getClientRects = () => [{}];
        tile.querySelector('[class*="Item_item"]').addEventListener('click', () => clicks.push(hrid));
        inventory.appendChild(tile);
    }
    document.body.appendChild(inventory);
    return clicks;
}

const bar = () => document.querySelector('.toolasha-scroll-planner-bar');

describe('ScrollPlanner', () => {
    let planner;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        mocks.settings.scrollPlanner = true;
        mocks.onClass.mockReset();
        mocks.onClass.mockReturnValue(mocks.unregister);
        mocks.unregister.mockReset();
        mocks.listeners = {};
        mocks.store = new Map();
        mocks.writes = [];
        mocks.saveGate = null;
        mocks.characterId = 'char-1';
        mocks.characterItems = [inv(DAMAGE, 5), inv(GATHERING, 8)];
        planner = new ScrollPlanner();
    });

    afterEach(() => {
        planner.cleanup();
        vi.useRealTimers();
    });

    test('does nothing when the setting is off', async () => {
        mocks.settings.scrollPlanner = false;
        await planner.initialize();
        expect(mocks.onClass).not.toHaveBeenCalled();
        expect(mocks.listeners.items_updated).toBeUndefined();
    });

    test('adds a Plan scrolls button to a scroll menu only, once', async () => {
        await planner.initialize();
        const scrollMenu = buildMenu('Scroll Of Damage', DAMAGE);
        const otherMenu = buildMenu('Cheese', '/items/cheese');
        planner.handleActionMenu(scrollMenu);
        planner.handleActionMenu(otherMenu);
        expect(scrollMenu.querySelector('.toolasha-scroll-planner-btn')).not.toBeNull();
        expect(otherMenu.querySelector('.toolasha-scroll-planner-btn')).toBeNull();

        planner.handleActionMenu(scrollMenu);
        expect(scrollMenu.querySelectorAll('.toolasha-scroll-planner-btn')).toHaveLength(1);
    });

    test('a translated menu is resolved by its icon sprite', async () => {
        await planner.initialize();
        const menu = buildMenu('伤害卷轴', DAMAGE);
        planner.handleActionMenu(menu);
        expect(menu.querySelector('.toolasha-scroll-planner-btn')).not.toBeNull();
    });

    test('an icon-less English menu still resolves by its name', async () => {
        await planner.initialize();
        const menu = buildMenu('Scroll Of Damage', null);
        planner.handleActionMenu(menu);
        expect(menu.querySelector('.toolasha-scroll-planner-btn')).not.toBeNull();
    });

    test('rejects an empty plan', async () => {
        await planner.initialize();
        const result = await planner.startRun({});
        expect(result.error).toMatch(/at least one scroll/);
        expect(isScrollRunActive()).toBe(false);
    });

    test('refuses to start while the inventory is not loaded, rather than reading it as none owned', async () => {
        await planner.initialize();
        mocks.characterItems = null;
        const result = await planner.startRun({ [DAMAGE]: 3 });
        expect(result.error).toMatch(/not loaded/);
        expect(isScrollRunActive()).toBe(false);
    });

    test('refuses a plan of scrolls the character does not own', async () => {
        await planner.initialize();
        const result = await planner.startRun({ [WISDOM]: 3 });
        expect(result.error).toMatch(/do not own/);
        expect(isScrollRunActive()).toBe(false);
        // The plan is still remembered, so it can be loaded on a character that has them
        expect(mocks.store.get('scrollPlanner_lastPlan')).toEqual({ [WISDOM]: 3 });
    });

    test('starts a run, saves the plan and the run, fills the quantity and highlights Open without pressing it', async () => {
        await planner.initialize();
        const result = await planner.startRun({ [DAMAGE]: 3, [GATHERING]: 2 });
        expect(result.error).toBeNull();
        expect(isScrollRunActive()).toBe(true);
        expect(mocks.store.get('scrollPlanner_lastPlan')).toEqual({ [DAMAGE]: 3, [GATHERING]: 2 });
        expect(mocks.store.get('scrollPlanner_run_char-1').steps).toHaveLength(2);

        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        const open = menu.querySelector('button');
        const pressed = vi.fn();
        open.addEventListener('click', pressed);
        planner.handleActionMenu(menu);
        expect(menu.querySelector('input').value).toBe('3');
        expect(open.style.outline).toContain('solid');
        vi.advanceTimersByTime(300);
        expect(bar().textContent).toContain('Quantity is filled in');
        expect(bar().textContent).not.toContain('Could not fill');
        expect(pressed).not.toHaveBeenCalled();
    });

    test('says so when the quantity did not take', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        // A game build whose label does not follow the field
        const input = menu.querySelector('input');
        const clone = input.cloneNode();
        input.replaceWith(clone);
        planner.handleActionMenu(menu);
        vi.advanceTimersByTime(300);
        expect(bar().textContent).toContain('Could not fill in the quantity. Set it to 3');
    });

    test('does not touch a menu that is not the current step', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        const menu = buildMenu('Scroll Of Gathering', GATHERING);
        planner.handleActionMenu(menu);
        expect(menu.querySelector('input').value).toBe('1');
        expect(menu.querySelector('button').style.outline).toBe('');
    });

    test('opens the current scroll menu by its icon, once per step', async () => {
        const clicks = buildInventory([GATHERING, DAMAGE]);
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3, [GATHERING]: 2 });
        await vi.advanceTimersByTimeAsync(300);
        expect(clicks).toEqual([DAMAGE]);

        // A partial open stays on the same step and does not reopen the menu
        mocks.characterItems = [inv(DAMAGE, 4), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        await vi.advanceTimersByTimeAsync(300);
        expect(clicks).toEqual([DAMAGE]);
        expect(bar().textContent).toContain('Scroll 1 of 2: Scroll Of Damage ×2');

        mocks.characterItems = [inv(DAMAGE, 2), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        await vi.advanceTimersByTimeAsync(300);
        expect(clicks).toEqual([DAMAGE, GATHERING]);
    });

    test('counts every stack of a scroll, and advances to the end of the run', async () => {
        // Three stacks of one scroll (two in inventory, one elsewhere) and an over-planned step
        mocks.characterItems = [
            inv(DAMAGE, 2),
            inv(DAMAGE, 3),
            inv(DAMAGE, 7, { itemLocationHrid: '/item_locations/equipment' }),
            inv(GATHERING, 8),
        ];
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 9, [GATHERING]: 2 });
        expect(bar().textContent).toContain('Scroll 1 of 2: Scroll Of Damage ×5');
        expect(bar().textContent).toContain('Scroll Of Damage (9 → 5)');

        mocks.characterItems = [inv(DAMAGE, 7, { itemLocationHrid: '/item_locations/equipment' }), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        expect(bar().textContent).toContain('Scroll 2 of 2');

        mocks.characterItems = [inv(GATHERING, 6)];
        mocks.listeners.items_updated();
        await vi.runAllTimersAsync();
        expect(isScrollRunActive()).toBe(false);
        expect(bar().textContent).toContain('All planned scrolls opened.');
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(false);
    });

    test('an inventory that is not loaded does not finish (and delete) the run', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        mocks.characterItems = null;
        mocks.listeners.items_updated();
        await vi.runAllTimersAsync();
        expect(isScrollRunActive()).toBe(true);
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(true);
        expect(bar().textContent).not.toContain('All planned scrolls opened.');
    });

    test('skips the current step', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3, [GATHERING]: 2 });
        await planner.skipCurrentStep();
        expect(bar().textContent).toContain('Scroll 2 of 2');
        expect(mocks.store.get('scrollPlanner_run_char-1').steps[0].skipped).toBe(true);

        await planner.skipCurrentStep();
        await vi.runAllTimersAsync();
        expect(isScrollRunActive()).toBe(false);
        expect(bar().textContent).toContain('Skipped: Scroll Of Damage, Scroll Of Gathering');
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(false);
    });

    test('stop clears the run, the bar, the highlight and the Auto All suppression', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        planner.handleActionMenu(menu);
        await planner.stopRun();
        expect(isScrollRunActive()).toBe(false);
        expect(bar()).toBeNull();
        expect(menu.querySelector('button').style.outline).toBe('');
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(false);
    });

    test('a stop while the run is still being saved does not leave the record behind', async () => {
        await planner.initialize();
        let release;
        mocks.saveGate = new Promise((resolve) => {
            release = resolve;
        });
        const starting = planner.startRun({ [DAMAGE]: 3 });
        // Let startRun reach the run save (past the plan save, which shares the gate)
        release();
        mocks.saveGate = new Promise((resolve) => {
            release = resolve;
        });
        await vi.advanceTimersByTimeAsync(0);
        await planner.stopRun();
        release();
        await starting;
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(false);
    });

    test('resumes a fresh saved run (with its shortfalls) and drops a stale one', async () => {
        const steps = [{ itemHrid: DAMAGE, quantity: 3, planned: 4, targetCount: 2, skipped: false }];
        const shortfalls = [{ itemHrid: DAMAGE, planned: 4, owned: 3 }];
        mocks.store.set('scrollPlanner_run_char-1', { startedAt: Date.now(), steps, shortfalls });
        await planner.initialize();
        expect(isScrollRunActive()).toBe(true);
        expect(bar().textContent).toContain('Scroll Of Damage (4 → 3)');
        planner.cleanup();
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(true);

        mocks.store.set('scrollPlanner_run_char-1', { startedAt: Date.now() - 13 * 3600 * 1000, steps });
        await planner.initialize();
        expect(isScrollRunActive()).toBe(false);
        expect(mocks.store.has('scrollPlanner_run_char-1')).toBe(false);
    });

    test('a character switch during the resume read does not resume onto the new character', async () => {
        const steps = [{ itemHrid: DAMAGE, quantity: 3, planned: 3, targetCount: 2, skipped: false }];
        mocks.store.set('scrollPlanner_run_char-1', { startedAt: Date.now(), steps });
        const init = planner.initialize();
        mocks.characterId = 'char-2';
        await init;
        expect(isScrollRunActive()).toBe(false);
        expect(bar()).toBeNull();
    });

    test('a character switch while the plan saves writes no run under either character', async () => {
        await planner.initialize();
        let release;
        mocks.saveGate = new Promise((resolve) => {
            release = resolve;
        });
        const starting = planner.startRun({ [DAMAGE]: 3 });
        planner.cleanup();
        mocks.characterId = 'char-2';
        release();
        await starting;
        expect(isScrollRunActive()).toBe(false);
        expect(mocks.writes.filter(([, key]) => key.startsWith('scrollPlanner_run'))).toEqual([]);
        expect(bar()).toBeNull();
    });

    test('cleanup removes every node, listener and timer, and initialize works again', async () => {
        const clicks = buildInventory([DAMAGE]);
        await planner.initialize();
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        planner.handleActionMenu(menu);
        await planner.startRun({ [DAMAGE]: 3 });
        planner.handleActionMenu(menu);
        planner.openModal();

        planner.cleanup();
        await vi.advanceTimersByTimeAsync(500);
        expect(clicks).toEqual([]);
        expect(mocks.unregister).toHaveBeenCalled();
        expect(mocks.listeners.items_updated).toBeUndefined();
        expect(document.querySelector('.toolasha-scroll-planner-btn')).toBeNull();
        expect(document.querySelector('.toolasha-scroll-planner-modal')).toBeNull();
        expect(bar()).toBeNull();
        expect(menu.querySelector('button').style.outline).toBe('');
        expect(isScrollRunActive()).toBe(false);

        // The saved run survives the teardown and comes back on the next start
        await planner.initialize();
        expect(isScrollRunActive()).toBe(true);
        expect(mocks.listeners.items_updated).toBeTypeOf('function');
    });

    test('the modal tells "not loaded" apart from "none owned"', async () => {
        await planner.initialize();
        mocks.characterItems = null;
        planner.openModal();
        expect(document.querySelector('.toolasha-scroll-planner-modal').textContent).toContain('not loaded');
        expect(document.querySelectorAll('.toolasha-scroll-planner-row')).toHaveLength(0);

        mocks.characterItems = [];
        planner.openModal();
        const rows = document.querySelectorAll('.toolasha-scroll-planner-row');
        expect(rows).toHaveLength(3);
        expect(rows[0].textContent).toContain('Owned: 0');
    });

    test('loads the last plan into the modal, dropping items that are not scrolls', async () => {
        await planner.initialize();
        mocks.store.set('scrollPlanner_lastPlan', { [DAMAGE]: 4, '/items/nope': 9, [GATHERING]: 'x' });
        planner.openModal();
        await planner.loadLastIntoDraft();
        expect(planner.draft).toEqual({ [DAMAGE]: 4 });
        const row = document.querySelector(`.toolasha-scroll-planner-row[data-item-hrid="${DAMAGE}"]`);
        expect(row.querySelector('input').value).toBe('4');
    });

    test('says when there is no last plan', async () => {
        await planner.initialize();
        planner.openModal();
        await planner.loadLastIntoDraft();
        expect(document.querySelector('.toolasha-scroll-planner-modal').textContent).toContain(
            'No previous plan saved yet.'
        );
    });
});
