/** @vitest-environment happy-dom */

/**
 * The skill page's sell-tax toggle button: opt-in (its own setting, off by default), flips
 * `profitCalc_excludeSellTax`, and shows the state with a warning marker while the tax is excluded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    listeners: {},
    displayGatheringProfit: vi.fn(async () => {}),
    displayProductionProfit: vi.fn(async () => {}),
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
        setSettingValue: (key, value) => {
            mocks.settings[key] = value;
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
    displayGatheringProfit: mocks.displayGatheringProfit,
    displayProductionProfit: mocks.displayProductionProfit,
}));

const { default: actionFilter } = await import('./action-filter.js');

const PANEL_CLASS = 'SkillActionDetail_regularComponent__3oCgr';

function buildSkillPage() {
    document.body.innerHTML = `
        <h1 class="GatheringProductionSkillPanel_title__3VihQ"><div>Cheesesmithing</div></h1>
        <div class="${PANEL_CLASS}"><div data-mwi-action-hrid="/actions/cheesesmithing/cheese_helmet"
             data-mwi-action-type="production">Profit: +100/hr</div></div>
    `;
    return document.querySelector('h1');
}

const sellTaxBtn = () => document.querySelector('#mwi-action-sell-tax-toggle');

describe('action filter: sell tax toggle button', () => {
    beforeEach(async () => {
        mocks.listeners = {};
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_production: true,
            profitCalc_pricingMode: 'hybrid',
            profitCalc_craftUpgradeItems: true,
        };
        mocks.displayProductionProfit.mockClear();
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('is not shown by default (its setting is off)', () => {
        actionFilter.injectFilterInput(buildSkillPage());

        expect(sellTaxBtn()).toBeNull();
    });

    it('is shown when its setting is on, reading Tax: On while the tax is deducted', () => {
        mocks.settings.actionPanel_showSellTaxToggle = true;
        actionFilter.injectFilterInput(buildSkillPage());

        expect(sellTaxBtn()).not.toBeNull();
        expect(sellTaxBtn().textContent).toBe('Tax: On');
    });

    it('clicking it flips profitCalc_excludeSellTax and marks the button while excluded', () => {
        mocks.settings.actionPanel_showSellTaxToggle = true;
        actionFilter.injectFilterInput(buildSkillPage());

        sellTaxBtn().click();

        expect(mocks.settings.profitCalc_excludeSellTax).toBe(true);
        expect(sellTaxBtn().textContent).toContain('⚠');
        expect(sellTaxBtn().textContent).toContain('Off');

        sellTaxBtn().click();

        expect(mocks.settings.profitCalc_excludeSellTax).toBe(false);
        expect(sellTaxBtn().textContent).toBe('Tax: On');
    });

    it('re-renders the profit sections when the setting changes', async () => {
        mocks.settings.actionPanel_showSellTaxToggle = true;
        actionFilter.injectFilterInput(buildSkillPage());

        sellTaxBtn().click();
        await vi.waitFor(() => expect(mocks.displayProductionProfit).toHaveBeenCalled());
    });
});
