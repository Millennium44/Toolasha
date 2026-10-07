/** @vitest-environment happy-dom */

/**
 * Market Pricing Controls: the Buy/Sell dropdowns and Craft toggle beside the Marketplace title.
 * Writes go through the same helpers the skill-page dropdowns use, so these tests check the
 * settings written rather than any redraw.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const live = vi.hoisted(() => ({
    values: {},
    writes: [],
    listeners: [],
    loadedListeners: [],
    titleCallback: null,
    readyCallback: null,
    unregisterClass: vi.fn(),
    unregisterReady: vi.fn(),
    locked: false,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => live.values[key],
        getSettingValue: (key, fallback) => live.values[key] ?? fallback,
        setSetting: (key, value) => {
            live.values[key] = value;
            live.writes.push([key, value]);
        },
        setSettingValue: (key, value) => {
            live.values[key] = value;
            live.writes.push([key, value]);
        },
        onSettingChange: (key, callback) => {
            const entry = { key, callback };
            live.listeners.push(entry);
            return () => {
                live.listeners = live.listeners.filter((item) => item !== entry);
            };
        },
        onSettingsLoaded: (callback) => {
            live.loadedListeners.push(callback);
            return () => {
                live.loadedListeners = live.loadedListeners.filter((item) => item !== callback);
            };
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, cls, callback) => {
            live.titleCallback = callback;
            return live.unregisterClass;
        },
        onReady: (name, callback) => {
            live.readyCallback = callback;
            return live.unregisterReady;
        },
    },
}));
vi.mock('../settings/iron-cow-mode.js', () => ({
    IRON_COW_ENABLED_SETTING: 'ironCow_enabled',
    pricingRowsLocked: () => live.locked,
}));

const { default: controls } = await import('./market-pricing-controls.js');

/** A fresh Marketplace title, as the game draws it */
function mountTitle() {
    const title = document.createElement('h1');
    title.className = 'MarketplacePanel_title__yTWKE';
    title.textContent = 'Marketplace';
    document.body.appendChild(title);
    return title;
}

/** Fire every listener registered for a setting, as the config singleton would */
function fireChange(key) {
    for (const entry of live.listeners.filter((item) => item.key === key)) entry.callback();
}

const buyOf = (title) => title.querySelector('select[data-mwi-pricing-side="buy"]');
const sellOf = (title) => title.querySelector('select[data-mwi-pricing-side="sell"]');
const craftOf = (title) => title.querySelector('#mwi-market-craft-toggle');

beforeEach(() => {
    live.values = {
        market_showPricingControls: true,
        actionPanel_showPricingMode: true,
        actionPanel_showCraftToggle: true,
        profitCalc_pricingMode: 'hybrid',
        profitCalc_patientTickBuy: false,
        profitCalc_patientTickSell: false,
        profitCalc_pricingNaming: false,
        profitCalc_craftUpgradeItems: false,
    };
    live.writes = [];
    live.listeners = [];
    live.loadedListeners = [];
    live.locked = false;
    live.titleCallback = null;
    live.readyCallback = null;
    live.unregisterClass.mockClear();
    live.unregisterReady.mockClear();
});

afterEach(() => {
    controls.cleanup();
    document.body.innerHTML = '';
});

describe('injection', () => {
    test('puts Buy, Sell and Craft controls in the Marketplace title when the setting is on', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        expect(buyOf(title)).not.toBeNull();
        expect(sellOf(title)).not.toBeNull();
        expect(craftOf(title).textContent).toBe('Craft: Off');
        expect(buyOf(title).value).toBe('instant');
        expect(title.style.flexWrap).toBe('wrap');
    });

    test('catches up a title that was drawn before the observer attached', () => {
        controls.initialize();
        const title = mountTitle();
        live.readyCallback();
        expect(buyOf(title)).not.toBeNull();
    });

    test('does nothing at all when the setting is off', () => {
        live.values.market_showPricingControls = false;
        controls.initialize();
        mountTitle();
        expect(live.titleCallback).toBeNull();
        expect(document.querySelector('#mwi-market-pricing-controls')).toBeNull();
        expect(live.listeners).toHaveLength(0);
    });

    test('mounting twice into one title leaves one set of controls', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        live.titleCallback(title);
        expect(title.querySelectorAll('#mwi-market-pricing-controls')).toHaveLength(1);
    });

    test('the skill-page visibility settings still hide their control', () => {
        live.values.actionPanel_showPricingMode = false;
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        expect(buyOf(title).style.display).toBe('none');
        expect(sellOf(title).style.display).toBe('none');
        expect(craftOf(title).style.display).toBe('');

        live.values.actionPanel_showCraftToggle = false;
        fireChange('actionPanel_showCraftToggle');
        expect(title.querySelector('#mwi-market-pricing-controls').style.display).toBe('none');
    });
});

describe('writes', () => {
    test('choosing a buy side writes the same settings the skill-page dropdown does', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        const buy = buyOf(title);
        buy.value = 'patientTick';
        buy.dispatchEvent(new Event('change'));
        expect(live.writes).toEqual([
            ['profitCalc_pricingMode', 'optimistic'],
            ['profitCalc_patientTickBuy', true],
        ]);
    });

    test('choosing a sell side writes the mode and the sell tick', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        const sell = sellOf(title);
        sell.value = 'instant';
        sell.dispatchEvent(new Event('change'));
        expect(live.writes).toEqual([['profitCalc_pricingMode', 'conservative']]);
    });

    test('the Craft button flips profitCalc_craftUpgradeItems and relabels itself', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        craftOf(title).click();
        expect(live.writes).toEqual([['profitCalc_craftUpgradeItems', true]]);
        expect(craftOf(title).textContent).toBe('Craft: On');
    });
});

describe('Iron Cow', () => {
    test('locks the dropdowns and writes nothing while Iron Cow owns pricing', () => {
        live.locked = true;
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        expect(buyOf(title).disabled).toBe(true);
        expect(sellOf(title).disabled).toBe(true);
        const buy = buyOf(title);
        buy.value = 'patient';
        buy.dispatchEvent(new Event('change'));
        expect(live.writes).toEqual([]);
        expect(buy.title).toContain('Iron Cow');
    });

    test('unlocks when Iron Cow mode is turned off', () => {
        live.locked = true;
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        live.locked = false;
        fireChange('ironCow_enabled');
        expect(buyOf(title).disabled).toBe(false);
    });
});

describe('staying in sync', () => {
    test('a change made elsewhere updates the dropdowns and the Craft label', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        live.values.profitCalc_pricingMode = 'patientBuy';
        live.values.profitCalc_craftUpgradeItems = true;
        fireChange('profitCalc_pricingMode');
        expect(buyOf(title).value).toBe('patient');
        expect(sellOf(title).value).toBe('instant');
        fireChange('profitCalc_craftUpgradeItems');
        expect(craftOf(title).textContent).toBe('Craft: On');
    });

    test('settings finishing loading (a character switch) resyncs the controls', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        live.values.profitCalc_pricingMode = 'optimistic';
        live.values.profitCalc_craftUpgradeItems = true;
        for (const callback of live.loadedListeners) callback();
        expect(buyOf(title).value).toBe('patient');
        expect(craftOf(title).textContent).toBe('Craft: On');
    });
});

describe('cleanup', () => {
    test('removes the controls, restores the title and drops every listener', () => {
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        controls.cleanup();
        expect(title.querySelector('#mwi-market-pricing-controls')).toBeNull();
        expect(title.style.flexWrap).toBe('');
        expect(live.listeners).toHaveLength(0);
        expect(live.loadedListeners).toHaveLength(0);
        expect(live.unregisterClass).toHaveBeenCalled();
        expect(live.unregisterReady).toHaveBeenCalled();
    });

    test('can start again after cleanup', () => {
        controls.initialize();
        controls.cleanup();
        controls.initialize();
        const title = mountTitle();
        live.titleCallback(title);
        expect(buyOf(title)).not.toBeNull();
    });
});
