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
vi.mock('./scroll-chips.js', () => ({ shortScrollName: (hrid) => hrid.split('/').at(-1) }));
vi.mock('./tile-scrolls.js', () => ({
    TILE_SCROLLS_SETTING: 'skillTiles_simulatedScrolls',
    getChosenScrolls: (type) => new Set(mocks.chosen[type] ?? []),
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

describe('action filter: Scrolls button', () => {
    beforeEach(async () => {
        mocks.listeners = {};
        mocks.chosen = {};
        mocks.redraw = null;
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_gathering: true,
            profitCalc_pricingMode: 'hybrid',
            skillTiles_simulatedScrolls: true,
        };
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('is hidden while no scroll is chosen for the skill', () => {
        actionFilter.injectFilterInput(buildSkillPage());
        registerTile();
        expect(scrollsBtn()).not.toBeNull();
        expect(visible()).toBe(false);
    });

    it('is hidden before any tile has told the filter which skill this is', () => {
        mocks.chosen[MILKING] = ['/buff_types/efficiency'];
        actionFilter.injectFilterInput(buildSkillPage());
        expect(visible()).toBe(false);
    });

    it('appears once scrolls are chosen for the skill of the tiles, naming them on hover', () => {
        actionFilter.injectFilterInput(buildSkillPage());
        registerTile();
        mocks.chosen[MILKING] = ['/buff_types/efficiency', '/buff_types/gathering'];
        mocks.redraw();
        expect(visible()).toBe(true);
        expect(scrollsBtn().textContent).toContain('Scrolls: On');
        expect(scrollsBtn().title).toContain('efficiency, gathering');
        expect(scrollsBtn().title).toContain('not active in the game');
    });

    it('stays hidden when the chosen scrolls belong to another skill', () => {
        mocks.chosen['/action_types/brewing'] = ['/buff_types/efficiency'];
        actionFilter.injectFilterInput(buildSkillPage());
        registerTile(MILKING);
        expect(visible()).toBe(false);
    });

    it('is hidden again when the choice is cleared or the simulation switched off', () => {
        mocks.chosen[MILKING] = ['/buff_types/efficiency'];
        actionFilter.injectFilterInput(buildSkillPage());
        registerTile();
        expect(visible()).toBe(true);
        mocks.chosen[MILKING] = [];
        mocks.redraw();
        expect(visible()).toBe(false);
    });

    it('flips the tile setting and says so', () => {
        mocks.chosen[MILKING] = ['/buff_types/efficiency'];
        actionFilter.injectFilterInput(buildSkillPage());
        registerTile();

        scrollsBtn().click();
        expect(mocks.settings.skillTiles_simulatedScrolls).toBe(false);
        expect(scrollsBtn().textContent).toBe('Scrolls: Off');
        expect(scrollsBtn().title).toContain('real figures');

        scrollsBtn().click();
        expect(mocks.settings.skillTiles_simulatedScrolls).toBe(true);
        expect(scrollsBtn().textContent).toContain('Scrolls: On');
    });

    it('ignores a tile that was removed from the page', () => {
        mocks.chosen[MILKING] = ['/buff_types/efficiency'];
        actionFilter.injectFilterInput(buildSkillPage());
        const tile = registerTile();
        tile.remove();
        mocks.redraw();
        expect(visible()).toBe(false);
    });
});
