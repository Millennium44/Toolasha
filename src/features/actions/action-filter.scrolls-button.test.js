/** @vitest-environment happy-dom */

/**
 * The skill page's "Scrolls" button: shown only while there are scrolls chosen for the skill the tiles belong
 * to (the skill comes from the tiles' resolved action, not the page's text), flips the tile setting, and says on
 * hover what it does and which scrolls are chosen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    listeners: {},
    chosen: {},
    offered: {},
    owned: {},
    picked: [],
    redraw: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#abc',
        COLOR_WARNING: '#ffa500',
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        setSetting: (key, value) => {
            mocks.settings[key] = value;
            for (const fn of mocks.listeners[key] ?? []) fn(value);
        },
        getPricingModeLabel: (mode) => mode,
        getPricingModeDisplayLabel: (mode) => mode,
        onSettingChange: vi.fn((key, fn) => {
            (mocks.listeners[key] ??= []).push(fn);
            return () => {};
        }),
        onSettingsLoaded: vi.fn(() => () => {}),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../api/marketplace.js', () => ({ default: { fetch: vi.fn(async () => true) } }));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        onSortModeChange: vi.fn(() => () => {}),
        getSortMode: () => 'default',
        setSortMode: vi.fn(),
        sortPanelsByProfit: vi.fn(),
    },
}));
vi.mock('./profit-display.js', () => ({
    displayGatheringProfit: vi.fn(async () => {}),
    displayProductionProfit: vi.fn(async () => {}),
}));
vi.mock('../../utils/formatters.js', () => ({ formatWithSeparator: (n) => String(n) }));
vi.mock('./tile-scrolls.js', () => ({
    TILE_SCROLLS_SETTING: 'skillTiles_simulatedScrolls',
    listPickerScrolls: (type) =>
        (mocks.offered[type] ?? []).map((buff) => ({
            buff,
            name: buff.split('/').at(-1),
            itemHrid: null,
            owned: mocks.owned[buff] ?? null,
            checked: (mocks.chosen[type] ?? []).includes(buff),
        })),
    setPickerScroll: async (type, buff, on) => {
        const now = new Set(mocks.chosen[type] ?? []);
        if (on) now.add(buff);
        else now.delete(buff);
        mocks.chosen[type] = [...now];
        mocks.picked.push([type, buff, on]);
        mocks.redraw?.();
        return true;
    },
    onTileScrollsChanged: (cb) => {
        mocks.redraw = cb;
        return () => {
            mocks.redraw = null;
        };
    },
}));

const { default: actionFilter } = await import('./action-filter.js');

const PANEL_CLASS = 'SkillActionDetail_regularComponent__3oCgr';
const MILKING = '/action_types/milking';

function buildSkillPage() {
    document.body.innerHTML = `
        <h1 class="GatheringProductionSkillPanel_title__3VihQ"><div>Milking</div></h1>
        <div class="${PANEL_CLASS}"></div>
    `;
    return document.querySelector('h1');
}

function registerTile(type = MILKING) {
    const tile = document.createElement('div');
    document.body.appendChild(tile);
    actionFilter.registerPanel(tile, 'Cow', type);
    return tile;
}

const scrollsBtn = () => document.querySelector('#mwi-action-scrolls-toggle');
const visible = () => scrollsBtn() && scrollsBtn().style.display !== 'none';

const EFF = '/buff_types/efficiency';
const GATH = '/buff_types/gathering';
const menu = () => document.querySelector('#mwi-action-scrolls-menu');
const box = (key) => menu()?.querySelector(`input[data-key="${key}"]`);

describe('action filter: Scrolls picker', () => {
    beforeEach(async () => {
        mocks.listeners = {};
        mocks.chosen = {};
        mocks.offered = { [MILKING]: [EFF, GATH], '/action_types/brewing': ['/buff_types/gourmet'] };
        mocks.owned = { [EFF]: 79 };
        mocks.picked = [];
        mocks.redraw = null;
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_gathering: true,
            profitCalc_pricingMode: 'hybrid',
            simulateScrollEffects: true,
            skillTiles_simulatedScrolls: true,
        };
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    const setup = () => {
        actionFilter.injectFilterInput(buildSkillPage());
        registerTile();
    };

    it('is visible with zero scrolls chosen, labeled with the state', () => {
        setup();
        expect(visible()).toBe(true);
        expect(scrollsBtn().textContent).toBe('📜 Scrolls: On ▾');
        mocks.settings.skillTiles_simulatedScrolls = false;
        mocks.redraw();
        expect(scrollsBtn().textContent).toBe('Scrolls: Off ▾');
    });

    it('is hidden while the simulation is off or before the skill is known', () => {
        actionFilter.injectFilterInput(buildSkillPage());
        expect(visible()).toBe(false);
        registerTile();
        mocks.settings.simulateScrollEffects = false;
        mocks.redraw();
        expect(visible()).toBe(false);
    });

    it('opens a menu listing the switch and the skill scrolls with owned counts', () => {
        setup();
        scrollsBtn().click();
        expect(menu()).not.toBeNull();
        expect(box('use').checked).toBe(true);
        expect(menu().textContent).toContain('Use on tiles');
        expect(menu().textContent).toContain('efficiency ×79');
        expect(menu().textContent).toContain('gathering');
        expect(menu().textContent).not.toContain('gourmet');
        expect(scrollsBtn().getAttribute('aria-expanded')).toBe('true');
    });

    it('ticking a scroll goes through the simulator call and the menu follows', () => {
        setup();
        scrollsBtn().click();
        box(EFF).checked = true;
        box(EFF).dispatchEvent(new Event('change'));
        expect(mocks.picked).toEqual([[MILKING, EFF, true]]);
        expect(box(EFF).checked).toBe(true);
        expect(scrollsBtn().title).toContain('efficiency');
    });

    it('Use on tiles flips the setting', () => {
        setup();
        scrollsBtn().click();
        box('use').checked = false;
        box('use').dispatchEvent(new Event('change'));
        expect(mocks.settings.skillTiles_simulatedScrolls).toBe(false);
    });

    it('closes on a second click, an outside click and Escape', () => {
        setup();
        scrollsBtn().click();
        scrollsBtn().click();
        expect(menu()).toBeNull();
        scrollsBtn().click();
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(menu()).toBeNull();
        scrollsBtn().click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu()).toBeNull();
        expect(scrollsBtn().getAttribute('aria-expanded')).toBe('false');
    });

    it('stays open for a click inside it', () => {
        setup();
        scrollsBtn().click();
        menu().dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(menu()).not.toBeNull();
    });

    it('is removed with the filter (disable)', () => {
        setup();
        scrollsBtn().click();
        actionFilter.cleanup();
        expect(menu()).toBeNull();
        expect(scrollsBtn()).toBeNull();
    });
});
