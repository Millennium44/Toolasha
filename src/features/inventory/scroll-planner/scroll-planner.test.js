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
    clientData: null,
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
        getInitClientData: () => mocks.clientData || { itemDetailMap: ITEM_DETAIL_MAP },
        getItemDetails: (hrid) => (mocks.clientData?.itemDetailMap || ITEM_DETAIL_MAP)[hrid] || null,
    },
}));

import { ScrollPlanner } from './scroll-planner.js';
import { resetSpriteSheetCache } from '../../../utils/overlay-format.js';
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

/**
 * Inventory tiles whose click opens that item's menu, as the game does. `ignoredClicks` clicks
 * are swallowed first, like a click landing while an old menu closes or a dialog covers the tile.
 */
function buildInventory(itemHrids, { ignoredClicks = 0 } = {}) {
    const inventory = document.createElement('div');
    inventory.className = 'Inventory_items__x';
    const clicks = [];
    for (const hrid of itemHrids) {
        const tile = document.createElement('div');
        tile.className = 'Item_itemContainer__x';
        tile.innerHTML = `<div class="Item_item__x Item_clickable__x"><svg aria-label="?"><use xlink:href="${SPRITE}#${hrid.split('/').pop()}"></use></svg></div>`;
        tile.getClientRects = () => [{}];
        tile.querySelector('[class*="Item_item"]').addEventListener('click', () => {
            clicks.push(hrid);
            if (clicks.length <= ignoredClicks) return;
            document.querySelectorAll('[class*="Item_actionMenu"]').forEach((menu) => menu.remove());
            buildMenu(ITEM_DETAIL_MAP[hrid].name, hrid);
        });
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
        mocks.clientData = null;
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
        await vi.advanceTimersByTimeAsync(1500);
        expect(clicks).toEqual([DAMAGE, GATHERING]);
    });

    test('a first attempt that opens nothing is retried, and retries stop once the menu is open', async () => {
        const clicks = buildInventory([DAMAGE], { ignoredClicks: 1 });
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });

        await vi.advanceTimersByTimeAsync(200);
        expect(clicks).toEqual([DAMAGE]);
        expect(document.querySelector('[class*="Item_actionMenu"]')).toBeNull();

        await vi.advanceTimersByTimeAsync(400);
        expect(clicks).toEqual([DAMAGE, DAMAGE]);
        expect(document.querySelector('[class*="Item_actionMenu"]')).not.toBeNull();

        // The third attempt finds the menu open and does not click (which could close it again)
        await vi.advanceTimersByTimeAsync(2000);
        expect(clicks).toEqual([DAMAGE, DAMAGE]);
    });

    test('a menu already open for the scroll that stays open is filled in, not clicked', async () => {
        const clicks = buildInventory([DAMAGE]);
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(clicks).toEqual([]);
        expect(menu.querySelector('input').value).toBe('3');
        expect(menu.querySelector('button').style.outline).toContain('solid');
    });

    test('the menu Start was pressed from closing after the first look is reopened', async () => {
        const clicks = buildInventory([DAMAGE]);
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        await vi.advanceTimersByTimeAsync(200);
        expect(clicks).toEqual([]);

        menu.remove();
        await vi.advanceTimersByTimeAsync(400);
        expect(clicks).toEqual([DAMAGE]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(clicks).toEqual([DAMAGE]);
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

    test('scrolls gained mid-run do not raise the quantity filled into Open', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3 });
        // 5 owned, plan 3; then 4 more drop
        mocks.characterItems = [inv(DAMAGE, 9), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        planner.handleActionMenu(menu);
        expect(menu.querySelector('input').value).toBe('3');
        expect(bar().textContent).toContain('Scroll Of Damage ×3');

        // Partial opens still count down, and are saved
        mocks.characterItems = [inv(DAMAGE, 8), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        await vi.advanceTimersByTimeAsync(0);
        expect(bar().textContent).toContain('Scroll Of Damage ×2');
        expect(mocks.store.get('scrollPlanner_run_char-1').steps[0]).toMatchObject({ remaining: 2, lastOwned: 8 });
    });

    test('scrolls gained after a step is done do not bring it back', async () => {
        await planner.initialize();
        await planner.startRun({ [DAMAGE]: 3, [GATHERING]: 2 });
        mocks.characterItems = [inv(DAMAGE, 2), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        expect(bar().textContent).toContain('Scroll 2 of 2');

        mocks.characterItems = [inv(DAMAGE, 12), inv(GATHERING, 8)];
        mocks.listeners.items_updated();
        expect(bar().textContent).toContain('Scroll 2 of 2: Scroll Of Gathering ×2');
        const menu = buildMenu('Scroll Of Damage', DAMAGE);
        planner.handleActionMenu(menu);
        expect(menu.querySelector('input').value).toBe('1');
    });

    test('a resume after a gain keeps the planned quantity', async () => {
        const steps = [{ itemHrid: DAMAGE, quantity: 3, planned: 3, remaining: 2, lastOwned: 4, done: false }];
        mocks.store.set('scrollPlanner_run_char-1', { startedAt: Date.now(), steps, shortfalls: [] });
        mocks.characterItems = [inv(DAMAGE, 10)];
        await planner.initialize();
        expect(bar().textContent).toContain('Scroll Of Damage ×2');
    });

    test('an old targetCount record resumed after a gain keeps the planned quantity', async () => {
        const steps = [{ itemHrid: DAMAGE, quantity: 3, planned: 3, targetCount: 2, skipped: false }];
        mocks.store.set('scrollPlanner_run_char-1', { startedAt: Date.now(), steps });
        mocks.characterItems = [inv(DAMAGE, 9)];
        await planner.initialize();
        expect(bar().textContent).toContain('Scroll Of Damage ×3');
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

    describe('quick fill', () => {
        const modal = () => document.querySelector('.toolasha-scroll-planner-modal');
        const row = (hrid) => modal().querySelector(`.toolasha-scroll-planner-row[data-item-hrid="${hrid}"]`);
        const nameOf = (hrid) => row(hrid).querySelector('.toolasha-scroll-planner-name');
        const qtyOf = (hrid) => row(hrid).querySelector('input').value;
        const total = () => modal().textContent.match(/Total: (\d+)/)[1];
        const setN = (value) => {
            const input = modal().querySelector('.toolasha-scroll-planner-quickfill input');
            input.value = value;
            input.dispatchEvent(new Event('input'));
        };
        const type = (hrid, value) => {
            const input = row(hrid).querySelector('input');
            input.value = value;
            input.dispatchEvent(new Event('input'));
        };

        beforeEach(async () => {
            await planner.initialize();
            planner.openModal();
        });

        test('clicking names sets them to N, and again clears them; Total follows', () => {
            setN('30');
            nameOf(DAMAGE).click();
            nameOf(GATHERING).click();
            expect([qtyOf(DAMAGE), qtyOf(GATHERING)]).toEqual(['30', '30']);
            expect(total()).toBe('60');
            expect(nameOf(DAMAGE).getAttribute('aria-pressed')).toBe('true');
            expect(planner.draft).toEqual({ [DAMAGE]: 30, [GATHERING]: 30 });

            nameOf(DAMAGE).click();
            expect(qtyOf(DAMAGE)).toBe('');
            expect(nameOf(DAMAGE).getAttribute('aria-pressed')).toBe('false');
            expect(total()).toBe('30');
        });

        test('changing N moves the selected rows, but not one edited by hand', () => {
            setN('30');
            nameOf(DAMAGE).click();
            nameOf(GATHERING).click();
            type(GATHERING, '7');
            expect(nameOf(GATHERING).getAttribute('aria-pressed')).toBe('false');

            setN('10');
            expect([qtyOf(DAMAGE), qtyOf(GATHERING), qtyOf(WISDOM)]).toEqual(['10', '7', '']);
            expect(total()).toBe('17');
        });

        test('All on a selected row counts as a hand edit', () => {
            setN('30');
            nameOf(DAMAGE).click();
            [...row(DAMAGE).querySelectorAll('button')].find((b) => b.textContent === 'All').click();
            setN('10');
            expect(qtyOf(DAMAGE)).toBe('5');
        });

        test('with N empty, clicking a name does nothing', () => {
            type(DAMAGE, '4');
            nameOf(DAMAGE).click();
            nameOf(GATHERING).click();
            expect([qtyOf(DAMAGE), qtyOf(GATHERING)]).toEqual(['4', '']);
            expect(total()).toBe('4');

            setN('0');
            nameOf(GATHERING).click();
            expect(qtyOf(GATHERING)).toBe('');
        });

        test('the names are buttons, so the keyboard reaches them', () => {
            expect(nameOf(DAMAGE).tagName).toBe('BUTTON');
            expect(nameOf(DAMAGE).type).toBe('button');
            expect(nameOf(DAMAGE).style.cursor).toBe('pointer');
        });

        test('a quick-filled plan starts like a typed one, over-owned clamped with the note', async () => {
            setN('6');
            nameOf(DAMAGE).click();
            await [...modal().querySelectorAll('button')].find((b) => b.textContent === 'Start').click();
            await vi.advanceTimersByTimeAsync(0);
            expect(bar().textContent).toContain('Scroll Of Damage ×5');
            expect(bar().textContent).toContain('Scroll Of Damage (6 → 5)');
        });
    });

    describe('skill icons, from the game data', () => {
        // The skills each scroll's buff is usable in, as measured on the test server (2026-10-29)
        const SKILL_ORDER = [
            'milking',
            'foraging',
            'woodcutting',
            'cheesesmithing',
            'crafting',
            'tailoring',
            'cooking',
            'brewing',
            'alchemy',
            'enhancing',
            'combat',
        ];
        const NON_COMBAT_GATHER_PRODUCE = [
            'alchemy',
            'brewing',
            'cheesesmithing',
            'cooking',
            'crafting',
            'foraging',
            'milking',
            'tailoring',
            'woodcutting',
        ];
        const BUFFS = {
            action_speed: [...NON_COMBAT_GATHER_PRODUCE, 'enhancing'],
            attack_speed: ['combat'],
            cast_speed: ['combat'],
            combat_drop: ['combat'],
            critical_rate: ['combat'],
            damage: ['combat'],
            efficiency: NON_COMBAT_GATHER_PRODUCE,
            gathering: ['foraging', 'milking', 'woodcutting'],
            processing: ['foraging', 'milking', 'woodcutting'],
            gourmet: ['brewing', 'cooking'],
            rare_find: SKILL_ORDER,
            wisdom: SKILL_ORDER,
        };
        const seal = (buff) => `/items/seal_of_${buff}`;

        function gameData({ withBuffs = true } = {}) {
            const itemDetailMap = {};
            Object.keys(BUFFS).forEach((buff, index) => {
                const words = buff.split('_').map((w) => w[0].toUpperCase() + w.slice(1));
                itemDetailMap[seal(buff)] = {
                    hrid: seal(buff),
                    name: `Scroll Of ${words.join(' ')}`,
                    categoryHrid: '/item_categories/scroll',
                    isOpenable: true,
                    sortIndex: index,
                    scrollDetail: { personalBuffTypeHrid: `/personal_buff_types/${buff}` },
                };
            });
            const personalBuffTypeDetailMap = {};
            for (const [buff, skills] of Object.entries(BUFFS)) {
                personalBuffTypeDetailMap[`/personal_buff_types/${buff}`] = {
                    usableInActionTypeMap: Object.fromEntries(skills.map((k) => [`/action_types/${k}`, true])),
                };
            }
            const actionTypeDetailMap = Object.fromEntries(
                SKILL_ORDER.map((k, i) => [
                    `/action_types/${k}`,
                    { hrid: `/action_types/${k}`, name: k[0].toUpperCase() + k.slice(1), sortIndex: i + 1 },
                ])
            );
            return withBuffs
                ? { itemDetailMap, personalBuffTypeDetailMap, actionTypeDetailMap }
                : { itemDetailMap, actionTypeDetailMap };
        }

        const modal = () => document.querySelector('.toolasha-scroll-planner-modal');
        const skillButton = (skill) =>
            modal().querySelector(`.toolasha-scroll-planner-skill[data-action-type="/action_types/${skill}"]`);
        const row = (buff) => modal().querySelector(`.toolasha-scroll-planner-row[data-item-hrid="${seal(buff)}"]`);
        const selected = () =>
            Object.keys(BUFFS).filter(
                (buff) =>
                    row(buff).querySelector('.toolasha-scroll-planner-name').getAttribute('aria-pressed') === 'true'
            );
        const setN = (value) => {
            const input = modal().querySelector('.toolasha-scroll-planner-quickfill input');
            input.value = value;
            input.dispatchEvent(new Event('input'));
        };

        beforeEach(async () => {
            mocks.clientData = gameData();
            mocks.characterItems = Object.keys(BUFFS).map((buff) => inv(seal(buff), 50));
            await planner.initialize();
            planner.openModal();
        });

        test('one icon per skill any scroll covers, in the game order, named in the tooltip', () => {
            const buttons = [...modal().querySelectorAll('.toolasha-scroll-planner-skill')];
            expect(buttons.map((b) => b.dataset.actionType)).toEqual(SKILL_ORDER.map((k) => `/action_types/${k}`));
            expect(skillButton('milking').title).toBe('Milking');
        });

        test('Combat selects the five combat scrolls plus wisdom and rare find, at N', () => {
            setN('30');
            skillButton('combat').click();
            expect(selected().sort()).toEqual(
                ['attack_speed', 'cast_speed', 'combat_drop', 'critical_rate', 'damage', 'rare_find', 'wisdom'].sort()
            );
            expect(row('damage').querySelector('input').value).toBe('30');
            expect(modal().textContent).toContain('Total: 210');
            expect(skillButton('combat').getAttribute('aria-pressed')).toBe('true');
        });

        test('Milking selects gathering, processing, efficiency, action speed, wisdom and rare find', () => {
            setN('30');
            skillButton('milking').click();
            expect(selected().sort()).toEqual(
                ['action_speed', 'efficiency', 'gathering', 'processing', 'rare_find', 'wisdom'].sort()
            );
        });

        test('a skill pressed again deselects its scrolls; one short of all selects the missing ones', () => {
            setN('30');
            row('gourmet').querySelector('.toolasha-scroll-planner-name').click();
            skillButton('milking').click();
            skillButton('milking').click();
            // Gourmet was picked by name and Milking does not cover it: it stays
            expect(selected()).toEqual(['gourmet']);
            expect(row('wisdom').querySelector('input').value).toBe('');

            // Select Milking, drop one of its scrolls by name, press Milking: only that one comes back
            skillButton('milking').click();
            row('wisdom').querySelector('.toolasha-scroll-planner-name').click();
            expect(skillButton('milking').getAttribute('aria-pressed')).toBe('false');
            skillButton('milking').click();
            expect(selected().sort()).toEqual(
                ['action_speed', 'efficiency', 'gathering', 'gourmet', 'processing', 'rare_find', 'wisdom'].sort()
            );
        });

        test('with N empty a skill press says what is missing and selects nothing', () => {
            skillButton('combat').click();
            expect(selected()).toEqual([]);
            expect(modal().querySelector('.toolasha-scroll-planner-skill-hint').textContent).toContain(
                'Open N of each'
            );
            setN('5');
            skillButton('combat').click();
            expect(modal().querySelector('.toolasha-scroll-planner-skill-hint').textContent).toBe('');
        });

        test('rows show their skills: a word label for the broad scrolls, icons for the rest', () => {
            const cell = (buff) => row(buff).querySelector('.toolasha-scroll-planner-row-skills');
            expect(cell('wisdom').textContent).toBe('All skills');
            expect(cell('rare_find').textContent).toBe('All skills');
            expect(cell('action_speed').textContent).toBe('All non-combat');
            expect(cell('efficiency').textContent).toBe('All non-combat except Enhancing');
            expect(cell('gathering').textContent).toBe('');
            expect(cell('gathering').children).toHaveLength(3);
            expect(cell('gathering').title).toBe('Milking, Foraging, Woodcutting');
            expect(cell('damage').children).toHaveLength(1);
        });

        test('Combat is drawn from the misc sheet, every other skill from the skills sheet', () => {
            // The sheets as the game's own nav has drawn them
            const nav = document.createElement('div');
            nav.innerHTML =
                '<svg><use href="/static/media/misc_sprite.1a2b.svg#combat"></use></svg>' +
                '<svg><use href="/static/media/skills_sprite.3c4d.svg#milking"></use></svg>';
            document.body.appendChild(nav);
            resetSpriteSheetCache();
            planner.closeModal();
            planner.openModal();
            try {
                const href = (el) => el.querySelector('use')?.getAttribute('href');
                expect(href(skillButton('combat'))).toBe('/static/media/misc_sprite.1a2b.svg#combat');
                expect(href(skillButton('milking'))).toBe('/static/media/skills_sprite.3c4d.svg#milking');
                const damageIcon = row('damage').querySelector('.toolasha-scroll-planner-row-skills');
                expect(href(damageIcon)).toBe('/static/media/misc_sprite.1a2b.svg#combat');
            } finally {
                resetSpriteSheetCache();
            }
        });

        test('without the buff data there are no icons and the rest still works', () => {
            planner.closeModal();
            mocks.clientData = gameData({ withBuffs: false });
            planner.openModal();
            expect(modal().querySelector('.toolasha-scroll-planner-skill')).toBeNull();
            expect(modal().querySelector('.toolasha-scroll-planner-row-skills')).toBeNull();
            setN('4');
            row('damage').querySelector('.toolasha-scroll-planner-name').click();
            expect(modal().textContent).toContain('Total: 4');
        });
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
