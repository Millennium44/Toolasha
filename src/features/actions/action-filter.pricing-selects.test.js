/** @vitest-environment happy-dom */

/**
 * The skill page toolbar's Buy and Sell pricing dropdowns, which replaced the
 * "Mode:" cycling button and the "+1 tick" toggle. What each choice writes is
 * pinned in utils/pricing-side-select.test.js; this suite is about the toolbar:
 * where the dropdowns sit, that a choice re-renders the profit sections once,
 * and that the dropdowns follow changes made anywhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A small live config: values, change listeners and settings-loaded listeners */
const mocks = vi.hoisted(() => ({
    settings: {},
    changeListeners: {},
    loadedListeners: [],
    displayGatheringProfit: vi.fn(async () => {}),
    displayProductionProfit: vi.fn(async () => {}),
}));

vi.mock('../../core/config.js', () => {
    const write = (key, value) => {
        mocks.settings[key] = value;
        for (const cb of mocks.changeListeners[key] || []) cb(value);
    };
    return {
        default: {
            COLOR_ACCENT: '#22c55e',
            getSetting: (key) => mocks.settings[key],
            getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
            setSetting: write,
            setSettingValue: write,
            onSettingChange: (key, cb) => {
                (mocks.changeListeners[key] ??= []).push(cb);
                return () => {
                    mocks.changeListeners[key] = (mocks.changeListeners[key] || []).filter((c) => c !== cb);
                };
            },
            onSettingsLoaded: (cb) => {
                mocks.loadedListeners.push(cb);
                return () => {
                    mocks.loadedListeners = mocks.loadedListeners.filter((c) => c !== cb);
                };
            },
        },
    };
});

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn(() => () => {}) },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { fetch: vi.fn(async () => true) },
}));

vi.mock('../../utils/market-values.js', () => ({
    nextPriceUp: (price) => price + 1,
    nextPriceDown: (price) => price - 1,
    clampToBand: (price) => price,
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

const PRICING_KEYS = [
    'profitCalc_pricingMode',
    'profitCalc_pricingNaming',
    'profitCalc_patientTickBuy',
    'profitCalc_patientTickSell',
];
const AUTO_FILL_KEYS = ['fillMarketOrderPrice', 'market_autoFillBuyStrategy', 'market_autoFillSellStrategy'];
const IRON_COW_KEY = 'profitCalc_ironCowValuation';

/** Build a skill page title bar with one production tile carrying a profit section */
function buildSkillPage() {
    document.body.innerHTML = `
        <div id="page">
            <h1 class="GatheringProductionSkillPanel_title__3VihQ"><div>Cheesesmithing</div></h1>
            <div class="SkillActionDetail_regularComponent__3oCgr">
                <div data-mwi-action-hrid="/actions/cheesesmithing/cheese" data-mwi-action-type="production"></div>
            </div>
        </div>
    `;
    return document.querySelector('h1');
}

const buySelect = () => document.querySelector('#mwi-action-pricing-buy');
const sellSelect = () => document.querySelector('#mwi-action-pricing-sell');
const selectedText = (select) => select.options[select.selectedIndex].textContent;

/** Let the async change handler finish its awaited refresh */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function choose(select, choice) {
    select.value = choice;
    select.dispatchEvent(new Event('change'));
    await settle();
}

/** A write made somewhere else (the Settings panel, the Best Items header) */
function writeElsewhere(key, value) {
    mocks.settings[key] = value;
    for (const cb of mocks.changeListeners[key] || []) cb(value);
}

describe('action filter: Buy / Sell pricing dropdowns', () => {
    beforeEach(async () => {
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_gathering: true,
            actionPanel_showProfitPerHour_production: true,
            profitCalc_pricingMode: 'hybrid',
            profitCalc_pricingNaming: false,
            profitCalc_patientTickBuy: false,
            profitCalc_patientTickSell: false,
            profitCalc_craftUpgradeItems: true,
        };
        mocks.changeListeners = {};
        mocks.loadedListeners = [];
        mocks.displayProductionProfit.mockClear();
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
        document.body.innerHTML = '';
    });

    it('replaces the Mode and +1 tick buttons with two dropdowns, styled like the buttons beside them', () => {
        actionFilter.injectFilterInput(buildSkillPage());

        expect(document.querySelector('#mwi-action-profit-mode')).toBeNull();
        expect(document.querySelector('#mwi-action-tick-toggle')).toBeNull();

        expect(buySelect().tagName).toBe('SELECT');
        expect(sellSelect().tagName).toBe('SELECT');
        expect(buySelect().previousElementSibling.id).toBe('mwi-action-sort-toggle');
        expect(sellSelect().previousElementSibling).toBe(buySelect());
        expect(sellSelect().nextElementSibling.id).toBe('mwi-action-craft-toggle');

        const sort = document.querySelector('#mwi-action-sort-toggle');
        for (const select of [buySelect(), sellSelect()]) {
            expect(select.style.fontSize).toBe(sort.style.fontSize);
            expect(select.style.borderRadius).toBe(sort.style.borderRadius);
            expect(select.style.padding).toBe(sort.style.padding);
            expect(select.style.backgroundColor).not.toBe('transparent');
        }

        // hybrid: instant buys, patient sells
        expect(buySelect().value).toBe('instant');
        expect(sellSelect().value).toBe('patient');
        expect(selectedText(buySelect())).toBe('Buy: Ask');
        expect(selectedText(sellSelect())).toBe('Sell: Ask');
    });

    it('a choice writes the mode and tick, and re-renders the profit sections once', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        // Instant → Patient +1 writes both the mode and the tick, each with listeners
        await choose(buySelect(), 'patientTick');

        expect(mocks.settings.profitCalc_pricingMode).toBe('optimistic');
        expect(mocks.settings.profitCalc_patientTickBuy).toBe(true);
        expect(mocks.settings.profitCalc_patientTickSell).toBe(false);
        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(1);
        expect(buySelect().value).toBe('patientTick');
        expect(selectedText(buySelect())).toBe('Buy: Bid +1');
    });

    it('every Buy × Sell combination lands on the right settings', async () => {
        actionFilter.injectFilterInput(buildSkillPage());
        const MODE_FOR = {
            instant: { instant: 'conservative', patient: 'hybrid', patientTick: 'hybrid' },
            patient: { instant: 'patientBuy', patient: 'optimistic', patientTick: 'optimistic' },
            patientTick: { instant: 'patientBuy', patient: 'optimistic', patientTick: 'optimistic' },
        };

        for (const buy of ['instant', 'patient', 'patientTick']) {
            for (const sell of ['instant', 'patient', 'patientTick']) {
                await choose(buySelect(), buy);
                await choose(sellSelect(), sell);

                expect(mocks.settings.profitCalc_pricingMode).toBe(MODE_FOR[buy][sell]);
                expect(mocks.settings.profitCalc_patientTickBuy).toBe(buy === 'patientTick');
                expect(mocks.settings.profitCalc_patientTickSell).toBe(sell === 'patientTick');
                expect(buySelect().value).toBe(buy);
                expect(sellSelect().value).toBe(sell);
            }
        }
    });

    it('follows changes made elsewhere: a mode change or a tick change from Settings each re-render the sections once', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        // A pricing-mode change made from the Settings panel or the alchemy Best
        // Items header used to only relabel the dropdowns, leaving the open
        // profit sections showing the old mode's numbers until the page was
        // navigated away and back.
        writeElsewhere('profitCalc_pricingMode', 'patientBuy');
        await settle();
        expect(buySelect().value).toBe('patient');
        expect(sellSelect().value).toBe('instant');
        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(1);

        writeElsewhere('profitCalc_patientTickBuy', true);
        await settle();
        expect(buySelect().value).toBe('patientTick');
        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(2);
    });

    it('the Iron Cow valuation option changing from outside re-renders the sections, with nothing for the dropdowns to resync', async () => {
        actionFilter.injectFilterInput(buildSkillPage());
        const buyBefore = buySelect().value;
        const sellBefore = sellSelect().value;

        writeElsewhere(IRON_COW_KEY, 'vendor');
        await settle();

        // No dropdown shows this choice — the mode/side selects are unchanged —
        // but the profit sections still have to re-price
        expect(buySelect().value).toBe(buyBefore);
        expect(sellSelect().value).toBe(sellBefore);
        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(1);
    });

    it('a naming change retexts both dropdowns and re-renders the sections (the mode label they draw depends on it)', async () => {
        actionFilter.injectFilterInput(buildSkillPage());

        writeElsewhere('profitCalc_pricingNaming', true);
        await settle();

        expect(selectedText(buySelect())).toBe('Buy: Instant');
        expect(selectedText(sellSelect())).toBe('Sell: Patient');
        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(1);
    });

    it('a burst of pricing-setting changes in one synchronous turn re-renders the sections once, not once per key', async () => {
        // Mirrors a settings import or a reset to defaults: several of the keys
        // that feed the profit sections change back to back, synchronously,
        // before anything has a chance to await.
        actionFilter.injectFilterInput(buildSkillPage());

        writeElsewhere('profitCalc_pricingMode', 'patientBuy');
        writeElsewhere('profitCalc_patientTickBuy', true);
        writeElsewhere('profitCalc_patientTickSell', true);
        writeElsewhere('profitCalc_pricingNaming', true);
        // Nothing has run yet — the refresh is queued for the next microtask
        expect(mocks.displayProductionProfit).not.toHaveBeenCalled();

        await settle();
        expect(mocks.displayProductionProfit).toHaveBeenCalledTimes(1);
    });

    it('a character switch (settings loaded, no per-key callbacks) resyncs both dropdowns', () => {
        actionFilter.injectFilterInput(buildSkillPage());

        mocks.settings.profitCalc_pricingMode = 'optimistic';
        mocks.settings.profitCalc_patientTickSell = true;
        for (const cb of mocks.loadedListeners) cb();

        expect(buySelect().value).toBe('patient');
        expect(sellSelect().value).toBe('patientTick');
    });

    it('an auto-fill strategy change updates the tooltips live, without re-rendering or writing a setting', () => {
        mocks.settings.profitCalc_pricingMode = 'optimistic';
        actionFilter.injectFilterInput(buildSkillPage());
        expect(buySelect().title).not.toMatch(/auto-fill/);

        writeElsewhere('market_autoFillBuyStrategy', 'outbid');
        expect(buySelect().title).toMatch(/outbids by 1, but profit assumes the plain bid/);

        writeElsewhere('market_autoFillSellStrategy', 'undercut');
        expect(sellSelect().title).toMatch(/undercuts by 1, but profit assumes the plain ask/);

        writeElsewhere('fillMarketOrderPrice', false);
        expect(buySelect().title).not.toMatch(/auto-fill/);
        expect(sellSelect().title).not.toMatch(/auto-fill/);

        expect(mocks.displayProductionProfit).not.toHaveBeenCalled();
        expect(mocks.settings.profitCalc_patientTickBuy).toBe(false);
        expect(mocks.settings.profitCalc_pricingMode).toBe('optimistic');
    });

    it('is torn down on cleanup, and its listeners never stack across re-initialization', async () => {
        actionFilter.injectFilterInput(buildSkillPage());
        actionFilter.cleanup();
        expect(buySelect()).toBeNull();
        expect(sellSelect()).toBeNull();

        for (let i = 0; i < 3; i++) {
            await actionFilter.initialize();
            actionFilter.cleanup();
        }
        for (const key of [...PRICING_KEYS, ...AUTO_FILL_KEYS, IRON_COW_KEY]) {
            expect(mocks.changeListeners[key] || []).toHaveLength(0);
        }
        expect(mocks.loadedListeners).toHaveLength(0);

        await actionFilter.initialize();
        // One listener per key: it both resyncs the dropdowns and queues the
        // coalesced refresh, so mode/naming/tick keys and auto-fill keys alike
        // carry exactly one. The Iron Cow key has only the refresh, but still
        // exactly one listener.
        for (const key of [...PRICING_KEYS, ...AUTO_FILL_KEYS, IRON_COW_KEY]) {
            expect(mocks.changeListeners[key]).toHaveLength(1);
        }
    });

    it('both hide under the pricing mode visibility gate', () => {
        mocks.settings.actionPanel_showPricingMode = false;
        actionFilter.injectFilterInput(buildSkillPage());

        expect(buySelect().style.display).toBe('none');
        expect(sellSelect().style.display).toBe('none');
    });
});
