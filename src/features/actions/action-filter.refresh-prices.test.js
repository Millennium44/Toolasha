/** @vitest-environment happy-dom */

/**
 * The skill page toolbar's "Refresh Prices" button. Profit/hr on the action
 * tiles is computed from a 15-minute price cache; this button is the only way
 * to force the whole page's numbers to re-derive from a fresh pull.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    fetch: vi.fn(async () => true),
    displayGatheringProfit: vi.fn(async () => {}),
    displayProductionProfit: vi.fn(async () => {}),
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
    default: { onClass: vi.fn(() => () => {}) },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { fetch: mocks.fetch },
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
    displayGatheringProfit: mocks.displayGatheringProfit,
    displayProductionProfit: mocks.displayProductionProfit,
}));

const { default: actionFilter } = await import('./action-filter.js');

const PANEL_CLASS = 'SkillActionDetail_regularComponent__3oCgr';

/**
 * Build a skill page title bar with a couple of production tiles under it,
 * mirroring what Cheesesmithing/Tailoring actually render.
 * @returns {HTMLElement} The title element the toolbar attaches to
 */
function buildSkillPage() {
    document.body.innerHTML = `
        <div id="page">
            <h1 class="GatheringProductionSkillPanel_title__3VihQ"><div>Cheesesmithing</div></h1>
            <div id="panels">
                <div class="${PANEL_CLASS}">
                    <div data-mwi-action-hrid="/actions/cheesesmithing/cheese_helmet"
                         data-mwi-action-type="production">Profit: +100/hr</div>
                </div>
                <div class="${PANEL_CLASS}">
                    <div data-mwi-action-hrid="/actions/cheesesmithing/cheese_boots"
                         data-mwi-action-type="production">Profit: +200/hr</div>
                </div>
            </div>
        </div>
    `;
    return document.querySelector('h1');
}

/** @returns {HTMLElement|null} The refresh button in the toolbar */
function refreshBtn() {
    return document.querySelector('#mwi-action-price-refresh');
}

describe('action filter: Refresh Prices button', () => {
    beforeEach(() => {
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_gathering: true,
            actionPanel_showProfitPerHour_production: true,
            profitCalc_pricingMode: 'hybrid',
            profitCalc_craftUpgradeItems: true,
        };
        mocks.fetch.mockReset();
        mocks.fetch.mockResolvedValue(true);
        mocks.displayGatheringProfit.mockClear();
        mocks.displayProductionProfit.mockClear();
    });

    afterEach(() => {
        actionFilter.clearFilter();
        actionFilter.currentTitleElement = null;
        actionFilter.panels.clear();
        actionFilter._priceRefreshInFlight = false;
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('renders in the toolbar alongside the existing controls', () => {
        actionFilter.injectFilterInput(buildSkillPage());

        const btn = refreshBtn();
        expect(btn).not.toBeNull();
        expect(btn.textContent).toBe('Refresh Prices');
        expect(btn.style.display).not.toBe('none');
        // Sits in the same title bar as Filter/Sort/Mode/Craft, after the craft toggle
        expect(btn.parentElement).toBe(document.querySelector('h1'));
        expect(btn.previousElementSibling.id).toBe('mwi-action-craft-toggle');
    });

    it('is hidden when neither profit/hr display is enabled', () => {
        mocks.settings.actionPanel_showProfitPerHour_gathering = false;
        mocks.settings.actionPanel_showProfitPerHour_production = false;

        actionFilter.injectFilterInput(buildSkillPage());

        expect(refreshBtn().style.display).toBe('none');
    });

    it('forces a fresh market pull rather than using the cache', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        refreshBtn().click();
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());

        expect(mocks.fetch).toHaveBeenCalledWith(true);
    });

    it('re-renders every profit section on the page after the fetch', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        await actionFilter.refreshPrices();

        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(2);
        const hrids = mocks.displayProductionProfit.mock.calls.map((call) => call[1]);
        expect(hrids).toEqual(['/actions/cheesesmithing/cheese_helmet', '/actions/cheesesmithing/cheese_boots']);
        // Prices are pulled before anything re-renders
        expect(mocks.fetch.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.displayProductionProfit.mock.invocationCallOrder[0]
        );
    });

    it('shows a loading state during the fetch and clears it on success', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        let release;
        mocks.fetch.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );

        const pending = actionFilter.refreshPrices();
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());

        expect(refreshBtn().disabled).toBe(true);
        expect(refreshBtn().textContent).toBe('Refreshing...');

        release(true);
        await pending;

        expect(refreshBtn().disabled).toBe(false);
        expect(refreshBtn().textContent).toBe('Refresh Prices');
        expect(refreshBtn().style.opacity).toBe('1');
    });

    it('clears the loading state when the fetch fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        actionFilter.injectFilterInput(buildSkillPage());
        mocks.fetch.mockRejectedValue(new Error('network down'));

        const ok = await actionFilter.refreshPrices();

        expect(ok).toBe(false);
        expect(refreshBtn().disabled).toBe(false);
        expect(refreshBtn().textContent).toBe('Refresh Failed');
        expect(actionFilter._priceRefreshInFlight).toBe(false);
        expect(mocks.displayProductionProfit).not.toHaveBeenCalled();
    });

    it('recovers to the normal label on a later successful refresh', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        actionFilter.injectFilterInput(buildSkillPage());

        mocks.fetch.mockRejectedValueOnce(new Error('network down'));
        await actionFilter.refreshPrices();
        expect(refreshBtn().textContent).toBe('Refresh Failed');

        mocks.fetch.mockResolvedValue(true);
        await actionFilter.refreshPrices();

        expect(refreshBtn().textContent).toBe('Refresh Prices');
    });

    it('does not double-fire when clicked again while a fetch is in flight', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        let release;
        mocks.fetch.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );

        const first = actionFilter.refreshPrices();
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());

        const second = await actionFilter.refreshPrices();
        refreshBtn().click();

        expect(second).toBe(false);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        release(true);
        await first;

        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('survives the page being torn down mid-fetch', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        let release;
        mocks.fetch.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );

        const pending = actionFilter.refreshPrices();
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());

        actionFilter.clearFilter();
        release(true);

        await expect(pending).resolves.toBe(true);
        expect(refreshBtn()).toBeNull();
        expect(actionFilter._priceRefreshInFlight).toBe(false);
    });

    it('is removed from the DOM when the toolbar is torn down', () => {
        actionFilter.injectFilterInput(buildSkillPage());
        expect(refreshBtn()).not.toBeNull();

        actionFilter.clearFilter();

        expect(refreshBtn()).toBeNull();
        expect(actionFilter.refreshButton).toBeNull();
    });
});
