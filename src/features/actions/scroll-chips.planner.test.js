/** @vitest-environment happy-dom */

/**
 * Scroll chips: the owned count, the Plan control, and what the chip says about itself.
 * A chip and the planner name the same item (/items/seal_of_*), a chip press only toggles the
 * simulation, and Plan only opens the planner's window.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    simulateScrollEffects: true,
    scrollPlanner: true,
    characterItems: null,
    planner: null,
    itemsListeners: [],
    settingListeners: [],
    saved: {},
    personalBuffTypeDetailMap: {
        '/personal_buff_types/efficiency': {
            usableInActionTypeMap: { '/action_types/brewing': true },
            buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
        },
        '/personal_buff_types/gourmet': {
            usableInActionTypeMap: { '/action_types/brewing': true },
            buff: { typeHrid: '/buff_types/gourmet', flatBoost: 0.1 },
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        getSetting: (key) => (key in game ? game[key] : false),
        onSettingChange: (key, callback) => {
            game.settingListeners.push([key, callback]);
            return () => {
                game.settingListeners = game.settingListeners.filter(([, c]) => c !== callback);
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getInitClientData: () => ({ personalBuffTypeDetailMap: game.personalBuffTypeDetailMap }),
        get characterItems() {
            return game.characterItems;
        },
        on: (event, listener) => {
            if (event === 'items_updated') game.itemsListeners.push(listener);
        },
        off: (event, listener) => {
            game.itemsListeners = game.itemsListeners.filter((l) => l !== listener);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, store, fallback) => game.saved[key] ?? fallback,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
    scrollSimulator: () => null,
    scrollPlannerInstance: () => game.planner,
}));

const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const { buildScrollChips, scrollItemHrid } = await import('./scroll-chips.js');

const BREWING = '/action_types/brewing';
const GOURMET = '/buff_types/gourmet';
const EFF = '/buff_types/efficiency';
const GOURMET_ITEM = '/items/seal_of_gourmet';

const stack = (itemHrid, count, extra = {}) => ({
    itemHrid,
    count,
    enhancementLevel: 0,
    itemLocationHrid: '/item_locations/inventory',
    ...extra,
});
const chip = (row, buff) => row.querySelector(`button[data-buff="${buff}"]`);
const ownedText = (row, buff) => chip(row, buff).querySelector('.mwi-scroll-chip-owned').textContent;
const planButton = (row, itemHrid = GOURMET_ITEM) => row.querySelector(`button[data-plan="${itemHrid}"]`);
const fakePlanner = (overrides = {}) => ({
    isRunning: () => true,
    openWithSelection: vi.fn(() => true),
    ...overrides,
});
const built = [];
const build = (onChange = () => {}) => {
    const chips = buildScrollChips({ actionTypeHrid: BREWING, onChange });
    built.push(chips);
    return chips;
};

afterEach(() => {
    // Rows are module-level watchers: dispose every one so no test inherits another's listener
    built.splice(0).forEach((chips) => {
        chips.dispose();
        chips.element.remove();
    });
});

beforeEach(async () => {
    game.simulateScrollEffects = true;
    game.scrollPlanner = true;
    game.characterItems = [stack(GOURMET_ITEM, 6)];
    game.planner = fakePlanner();
    game.itemsListeners = [];
    game.settingListeners = [];
    game.saved = {};
    scrollSimulator.scrollsByLoadout = {};
    scrollSimulator.initialized = false;
    scrollSimulator.switchHandler = null;
    scrollSimulator.owner = null;
    await scrollSimulator.initialize();
});

describe('scroll chips: owned counts', () => {
    test('a chip is the item the planner lists: /items/seal_of_*', () => {
        expect(scrollItemHrid(GOURMET)).toBe(GOURMET_ITEM);
        expect(scrollItemHrid('/buff_types/nonsense')).toBeNull();
        expect(chip(build().element, GOURMET).closest('[data-item]').dataset.item).toBe(GOURMET_ITEM);
    });

    test('counts by item hrid: stacks add up; enhanced and non-inventory copies do not count', () => {
        game.characterItems = [
            stack(GOURMET_ITEM, 3),
            stack(GOURMET_ITEM, 4),
            stack(GOURMET_ITEM, 9, { enhancementLevel: 2 }),
            stack(GOURMET_ITEM, 5, { itemLocationHrid: '/item_locations/equipment' }),
            stack('/items/some_other_thing', 50),
        ];
        const { element } = build();

        expect(ownedText(element, GOURMET)).toBe('×7');
        expect(ownedText(element, EFF)).toBe('×0');
    });

    test('an inventory that is not loaded shows no count, which is not the same as zero', () => {
        game.characterItems = null;
        const { element } = build();

        expect(ownedText(element, GOURMET)).toBe('');
        expect(chip(element, GOURMET).title).toContain('not loaded');
        // Not loaded is not "none owned": Plan stays available, and the planner says it is not loaded
        expect(planButton(element).disabled).toBe(false);
    });

    test('an empty inventory shows zero', () => {
        game.characterItems = [];
        expect(ownedText(build().element, GOURMET)).toBe('×0');
    });

    test('follows items_updated while the row is on the page, and stops when it is disposed', () => {
        game.characterItems = [stack(GOURMET_ITEM, 1)];
        const { element, dispose } = build();
        document.body.appendChild(element);
        expect(game.itemsListeners).toHaveLength(1);
        expect(ownedText(element, GOURMET)).toBe('×1');

        game.characterItems = [stack(GOURMET_ITEM, 12)];
        game.itemsListeners.forEach((listener) => listener());
        expect(ownedText(element, GOURMET)).toBe('×12');

        dispose();
        expect(game.itemsListeners).toHaveLength(0);
        element.remove();
    });

    test('goes from not loaded to loaded on the next items_updated', () => {
        game.characterItems = null;
        const { element } = build();
        document.body.appendChild(element);
        expect(ownedText(element, GOURMET)).toBe('');

        game.characterItems = [stack(GOURMET_ITEM, 2)];
        game.itemsListeners.forEach((listener) => listener());

        expect(ownedText(element, GOURMET)).toBe('×2');
        element.remove();
    });

    test('rows share one listener, and rows the game removed release it on the next update', () => {
        const rows = Array.from({ length: 4 }, () => build());
        rows.forEach((r) => document.body.appendChild(r.element));
        expect(game.itemsListeners).toHaveLength(1);

        // The game drops the panel without telling anyone: nothing was disposed
        rows.forEach((r) => r.element.remove());
        game.itemsListeners.forEach((listener) => listener());

        expect(game.itemsListeners).toHaveLength(0);
    });

    test('a character swap leaves nothing stale: the count is read from the inventory at each paint', () => {
        game.characterItems = [stack(GOURMET_ITEM, 8)];
        const { element } = build();
        document.body.appendChild(element);

        // Another character's inventory arrives
        game.characterItems = [stack(GOURMET_ITEM, 1)];
        game.itemsListeners.forEach((listener) => listener());

        expect(ownedText(element, GOURMET)).toBe('×1');
        element.remove();
    });
});

describe('scroll chips: wording', () => {
    test('the hover says the figures are simulated and the scroll is not activated', () => {
        const title = chip(build().element, GOURMET).title;

        expect(title).toMatch(/only changes Toolasha's figures/);
        expect(title).toMatch(/not activated/);
        expect(title).toMatch(/Duration and Outputs do not change/);
    });

    test('nothing depends on the hover: the row says so in text, and an on chip is dashed, not solid', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, [GOURMET]);
        const { element } = build();

        expect(element.textContent).toContain('not active');
        expect(chip(element, GOURMET).style.borderStyle).toBe('dashed');
        expect(chip(element, EFF).style.borderStyle).toBe('solid');
    });

    test('the row wraps and every control has a touch-sized height, each chip kept with its Plan', () => {
        const { element } = build();

        expect(element.style.flexWrap).toBe('wrap');
        for (const button of element.querySelectorAll('button')) {
            expect(button.style.minHeight).toBe('28px');
        }
        const group = chip(element, GOURMET).closest('[data-item]');
        expect(group.style.whiteSpace).toBe('nowrap');
        expect(group.contains(planButton(element))).toBe(true);
    });
});

describe('scroll chips: Plan', () => {
    test('opens the planner with that scroll selected, and does not toggle the simulation', async () => {
        const onChange = vi.fn();
        const { element } = build(onChange);
        document.body.appendChild(element);

        planButton(element).click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(game.planner.openWithSelection).toHaveBeenCalledTimes(1);
        expect(game.planner.openWithSelection).toHaveBeenCalledWith([GOURMET_ITEM]);
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set());
        expect(game.saved.scroll_simulation_char1).toBeUndefined();
        expect(onChange).not.toHaveBeenCalled();
        expect(chip(element, GOURMET).dataset.on).toBe('false');
        element.remove();
    });

    test('a chip press still only toggles the simulation: the planner is not opened', async () => {
        const onChange = vi.fn();
        const { element } = build(onChange);

        chip(element, GOURMET).click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

        expect(game.planner.openWithSelection).not.toHaveBeenCalled();
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set([GOURMET]));
    });

    test('Plan is a separate button, never nested in the chip', () => {
        const { element } = build();

        expect(chip(element, GOURMET).querySelector('button')).toBeNull();
        expect(planButton(element).closest('button[data-buff]')).toBeNull();
    });

    test('no planner (module absent, setting off, or not running): Plan is hidden, the chip works', () => {
        const cases = [
            () => {
                game.scrollPlanner = true;
                game.planner = null;
            },
            () => {
                game.planner = fakePlanner();
                game.scrollPlanner = false;
            },
            () => {
                game.scrollPlanner = true;
                game.planner = fakePlanner({ isRunning: () => false });
            },
        ];
        for (const setup of cases) {
            setup();
            const { element } = build();
            expect(planButton(element).style.display).toBe('none');
            expect(chip(element, GOURMET)).toBeTruthy();
        }
    });

    test('a scroll that is not owned has Plan disabled, and the planner is not opened', () => {
        game.characterItems = [];
        const { element } = build();

        expect(planButton(element).disabled).toBe(true);
        expect(planButton(element).title).toMatch(/none of this scroll/);
        planButton(element).click();
        expect(game.planner.openWithSelection).not.toHaveBeenCalled();
    });

    test('Plan turns on when the scroll arrives', () => {
        game.characterItems = [];
        const { element } = build();
        document.body.appendChild(element);
        expect(planButton(element).disabled).toBe(true);

        game.characterItems = [stack(GOURMET_ITEM, 1)];
        game.itemsListeners.forEach((listener) => listener());

        expect(planButton(element).disabled).toBe(false);
        element.remove();
    });

    test('Plan follows the planner setting: it appears when the planner is switched on and goes when it is off', () => {
        vi.useFakeTimers();
        game.scrollPlanner = false;
        game.planner = fakePlanner({ isRunning: () => false });
        const { element } = build();
        document.body.appendChild(element);
        expect(planButton(element).style.display).toBe('none');
        expect(game.settingListeners.map(([key]) => key)).toEqual(['scrollPlanner']);

        // The setting flips first; the planner module starts a moment later
        game.scrollPlanner = true;
        game.settingListeners.forEach(([, callback]) => callback(true));
        expect(planButton(element).style.display).toBe('none');
        game.planner = fakePlanner();
        vi.advanceTimersByTime(400);
        expect(planButton(element).style.display).toBe('inline-flex');

        game.scrollPlanner = false;
        game.settingListeners.forEach(([, callback]) => callback(false));
        expect(planButton(element).style.display).toBe('none');
        vi.useRealTimers();
    });

    test('the setting listener goes with the last row', () => {
        const { element, dispose } = build();
        document.body.appendChild(element);
        expect(game.settingListeners).toHaveLength(1);

        dispose();

        expect(game.settingListeners).toHaveLength(0);
    });

    test('a planner that went away since the draw: pressing Plan hides it instead of failing', () => {
        const { element } = build();
        game.planner = fakePlanner({ isRunning: () => false });

        planButton(element).click();

        expect(planButton(element).style.display).toBe('none');
    });

    test('a planner with no row for the scroll (returns false) does not throw', () => {
        game.planner = fakePlanner({ openWithSelection: vi.fn(() => false) });
        const { element } = build();

        expect(() => planButton(element).click()).not.toThrow();
        expect(game.planner.openWithSelection).toHaveBeenCalledTimes(1);
    });

    test('a planner that throws is reported and the row keeps working', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.planner = fakePlanner({
            openWithSelection: vi.fn(() => {
                throw new Error('boom');
            }),
        });
        const { element } = build();

        planButton(element).click();

        expect(error).toHaveBeenCalled();
        expect(chip(element, GOURMET)).toBeTruthy();
        error.mockRestore();
    });
});
