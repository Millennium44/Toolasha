/** @vitest-environment happy-dom */

/**
 * ActionFilter kept filterValue as a page-agnostic singleton, only cleared when a new
 * filterable-skill title bar appeared. Combat Zones has no title bar, so a non-empty filter left
 * over from a skill page like Milking silently hid every zone tile, since both share the same
 * generic action-tile CSS class. registerPanel() now detects that the previously tracked title
 * has been removed from the DOM and clears the stale filter before applying it to the new tile.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    titleCallback: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#abc',
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        setSetting: (key, value) => {
            mocks.settings[key] = value;
        },
        setSettingValue: (key, value) => {
            mocks.settings[key] = value;
        },
        getPricingModeLabel: (mode) => mode,
        onSettingChange: vi.fn(() => () => {}),
        onSettingsLoaded: vi.fn(() => () => {}),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _cls, cb) => {
            mocks.titleCallback = cb;
            return () => {};
        }),
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { fetch: vi.fn(async () => true) },
}));

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

const { default: actionFilter } = await import('./action-filter.js');

/**
 * Build a skill page title bar, mirroring what a filterable skill like Milking renders.
 * @returns {HTMLElement} The title element the toolbar attaches to
 */
function makeTitle() {
    const title = document.createElement('h1');
    title.className = 'GatheringProductionSkillPanel_title__3VihQ';
    const nameDiv = document.createElement('div');
    nameDiv.textContent = 'Milking';
    title.appendChild(nameDiv);
    document.body.appendChild(title);
    return title;
}

/**
 * Build a generic action tile, matching what Combat Zones renders (no title bar of its own,
 * same generic tile class as gathering/production actions).
 * @param {string} name - Tile name (e.g. a zone name)
 * @returns {HTMLElement} The tile element
 */
function makeTile(name) {
    const tile = document.createElement('div');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'name';
    nameDiv.textContent = name;
    tile.appendChild(nameDiv);
    document.body.appendChild(tile);
    return tile;
}

describe('ActionFilter stale filterValue must not leak into non-filterable pages (e.g. Combat Zones)', () => {
    beforeEach(async () => {
        document.body.innerHTML = '';
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
        };
        mocks.titleCallback = null;
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
    });

    it('a tile registering after the filtered title bar is removed from the DOM is not hidden by the stale filter', () => {
        const title = makeTitle();
        mocks.titleCallback(title);
        actionFilter.filterValue = 'milk';

        // Simulate navigating away from the filterable skill page (e.g. to Combat Zones): the
        // title bar's React node is unmounted, but no new filterable title appears to replace it.
        title.remove();

        const zoneTile = makeTile('Aqua Planet');
        actionFilter.registerPanel(zoneTile, 'Aqua Planet');

        expect(actionFilter.filterValue).toBe('');
        expect(zoneTile.dataset.mwiFilterHidden).not.toBe('true');
        expect(zoneTile.style.display).not.toBe('none');
    });

    it('multiple tiles registering after navigating away all stay visible, not just the first', () => {
        const title = makeTitle();
        mocks.titleCallback(title);
        actionFilter.filterValue = 'milk';
        title.remove();

        const tileA = makeTile('Smelly Planet');
        const tileB = makeTile('Aqua Planet');
        actionFilter.registerPanel(tileA, 'Smelly Planet');
        actionFilter.registerPanel(tileB, 'Aqua Planet');

        expect(tileA.style.display).not.toBe('none');
        expect(tileB.style.display).not.toBe('none');
    });

    it('a live filter on the same page still applies normally (no regression to in-page filtering)', () => {
        const title = makeTitle();
        mocks.titleCallback(title);
        actionFilter.filterValue = 'milk';

        // Title stays connected — this is a normal filter on the current page, not a navigation.
        const tile = makeTile('Aqua Planet');
        actionFilter.registerPanel(tile, 'Aqua Planet');

        expect(tile.dataset.mwiFilterHidden).toBe('true');
        expect(tile.style.display).toBe('none');
    });
});
