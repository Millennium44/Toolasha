/** @vitest-environment happy-dom */

/**
 * The skill page toolbar's "+1 tick" toggle button, next to the Mode button.
 * One click flips profitCalc_patientTick without opening Settings — see
 * config.js's getPricingModeDisplayLabel for what the tick itself does.
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

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#22c55e',
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        setSetting: (key, value) => {
            mocks.settings[key] = value;
            for (const cb of mocks.changeListeners[key] || []) cb(value);
        },
        setSettingValue: (key, value) => {
            mocks.settings[key] = value;
            for (const cb of mocks.changeListeners[key] || []) cb(value);
        },
        // A faithful-enough stand-in for the real labels: the display label
        // carries the "(+1 tick)" suffix the plain label never does, so a test
        // can tell which one a caller used without touching the real config.
        getPricingModeLabel: () => 'LABEL',
        getPricingModeDisplayLabel: () =>
            mocks.settings.profitCalc_patientTick && mocks.settings.profitCalc_pricingMode !== 'conservative'
                ? 'LABEL (+1 tick)'
                : 'LABEL',
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
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn(() => () => {}) },
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
    displayGatheringProfit: mocks.displayGatheringProfit,
    displayProductionProfit: mocks.displayProductionProfit,
}));

const { default: actionFilter } = await import('./action-filter.js');

/** Build a bare skill page title bar the toolbar attaches to */
function buildSkillPage() {
    document.body.innerHTML = `
        <div id="page">
            <h1 class="GatheringProductionSkillPanel_title__3VihQ"><div>Cheesesmithing</div></h1>
        </div>
    `;
    return document.querySelector('h1');
}

const tickBtn = () => document.querySelector('#mwi-action-tick-toggle');
const modeBtn = () => document.querySelector('#mwi-action-profit-mode');

describe('action filter: "+1 tick" toggle button', () => {
    beforeEach(async () => {
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_gathering: true,
            actionPanel_showProfitPerHour_production: true,
            profitCalc_pricingMode: 'hybrid',
            profitCalc_patientTick: false,
            profitCalc_craftUpgradeItems: true,
        };
        mocks.changeListeners = {};
        mocks.loadedListeners = [];
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
        document.body.innerHTML = '';
    });

    it('renders next to the Mode button, off by default', () => {
        actionFilter.injectFilterInput(buildSkillPage());

        expect(tickBtn()).not.toBeNull();
        expect(tickBtn().textContent).toBe('+1 tick');
        expect(tickBtn().previousElementSibling.id).toBe('mwi-action-profit-mode');
        expect(tickBtn().style.color).not.toBe('#22c55e');
    });

    it('clicking flips the setting and restyles to the accent color', () => {
        actionFilter.injectFilterInput(buildSkillPage());

        tickBtn().click();

        expect(mocks.settings.profitCalc_patientTick).toBe(true);
        expect(tickBtn().style.borderColor).toBe('#22c55e'); // #22c55e
        expect(tickBtn().style.color).toBe('#22c55e');

        tickBtn().click();
        expect(mocks.settings.profitCalc_patientTick).toBe(false);
        expect(tickBtn().style.color).not.toBe('#22c55e');
    });

    it('the Mode button label no longer carries the "(+1 tick)" suffix', () => {
        mocks.settings.profitCalc_patientTick = true;
        actionFilter.injectFilterInput(buildSkillPage());

        // getPricingModeDisplayLabel (mocked above) would add the suffix; the
        // Mode button must be using getPricingModeLabel instead.
        expect(modeBtn().textContent).toBe('Mode: LABEL');
        expect(modeBtn().textContent).not.toContain('+1 tick');
    });

    it('is dimmed and explains itself under Conservative mode, but stays clickable', () => {
        mocks.settings.profitCalc_pricingMode = 'conservative';
        actionFilter.injectFilterInput(buildSkillPage());

        expect(tickBtn().style.opacity).toBe('0.5');
        expect(tickBtn().title).toMatch(/no effect/i);
        expect(tickBtn().disabled).toBeFalsy();

        // Still clickable: the setting still flips even though it currently does nothing
        tickBtn().click();
        expect(mocks.settings.profitCalc_patientTick).toBe(true);
    });

    it('an external setting change (e.g. from the Settings panel) updates the button', () => {
        actionFilter.injectFilterInput(buildSkillPage());
        expect(tickBtn().style.color).not.toBe('#22c55e');

        // Not a click on the button — a write from elsewhere, like the Settings checkbox
        mocks.settings.profitCalc_patientTick = true;
        for (const cb of mocks.changeListeners.profitCalc_patientTick) cb(true);

        expect(tickBtn().style.color).toBe('#22c55e');
    });

    it('a mode change back to Conservative dims the tick button even though the setting itself did not move', () => {
        actionFilter.injectFilterInput(buildSkillPage());
        tickBtn().click();
        expect(tickBtn().style.opacity).toBe('1');

        mocks.settings.profitCalc_pricingMode = 'conservative';
        for (const cb of mocks.changeListeners.profitCalc_pricingMode) cb('conservative');

        expect(tickBtn().style.opacity).toBe('0.5');
    });

    it('is torn down on cleanup, and its listeners do not accumulate across character switches', async () => {
        actionFilter.injectFilterInput(buildSkillPage());
        expect(tickBtn()).not.toBeNull();

        actionFilter.cleanup();
        expect(tickBtn()).toBeNull();

        for (let i = 0; i < 3; i++) {
            await actionFilter.initialize();
            actionFilter.cleanup();
        }

        expect(mocks.changeListeners.profitCalc_patientTick).toHaveLength(0);
    });

    it('shares the Mode button visibility gate', () => {
        mocks.settings.actionPanel_showPricingMode = false;
        actionFilter.injectFilterInput(buildSkillPage());

        expect(tickBtn().style.display).toBe('none');
        expect(modeBtn().style.display).toBe('none');
    });
});
