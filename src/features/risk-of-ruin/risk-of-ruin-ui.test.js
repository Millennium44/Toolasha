/* @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { riskOfRuin: true, riskOfRuin_showLauncher: true },
    settingChangeHandlers: {},
    /**
     * Every `onSettingChange(key, callback)` call, in order. The listener is registered at
     * module load, and Vitest 5 clears mock call records before each test, so the
     * registration is kept here rather than read back from `onSettingChange.mock.calls`.
     */
    settingChangeRegistrations: [],
    /** `{ [panelKey]: boolean }` written by saveOpenState, read by reopenIfLeftOpen */
    openState: {},
    domObserverHandlers: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1000,
        getSetting: vi.fn((key) => mocks.settings[key]),
        getSettingValue: vi.fn((_key, fallback) => fallback),
        setSetting: vi.fn((key, value) => {
            mocks.settings[key] = value;
            mocks.settingChangeHandlers[key]?.(value);
        }),
        onSettingChange: vi.fn((key, callback) => {
            mocks.settingChangeRegistrations.push([key, callback]);
            mocks.settingChangeHandlers[key] = callback;
        }),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: vi.fn(() => ({ itemDetailMap: {} })),
        getItemDetails: vi.fn(() => null),
        getInventory: vi.fn(() => []),
        getCurrentCharacterId: vi.fn(() => 'char-A'),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _classes, callback) => {
            const handler = { callback };
            mocks.domObserverHandlers.push(handler);
            return () => {
                const index = mocks.domObserverHandlers.indexOf(handler);
                if (index > -1) mocks.domObserverHandlers.splice(index, 1);
            };
        }),
    },
}));

// Geometry and open state live in IndexedDB, which is never what these tests are
// about — but which panel was left open is, so that half is a real in-memory store.
vi.mock('../../utils/panel-geometry.js', () => ({
    clampPanelToViewport: vi.fn(() => null),
    restoreGeometry: vi.fn(async () => {}),
    saveGeometry: vi.fn(async () => {}),
    saveCollapsed: vi.fn(async () => {}),
    wasCollapsed: vi.fn(async () => false),
    savedSize: vi.fn(async () => null),
    saveOpenState: vi.fn(async (panelKey, open) => {
        mocks.openState[panelKey] = Boolean(open);
    }),
    wasOpen: vi.fn(async (panelKey) => Boolean(mocks.openState[panelKey])),
    reopenIfLeftOpen: vi.fn(async (panelKey, reopen) => {
        if (mocks.openState[panelKey]) reopen();
    }),
}));

// The transmute model is priced elsewhere; these tests only read what the panel says about it.
vi.mock('../../utils/risk-of-ruin-adapters/alchemy-adapter.js', () => ({
    buildAlchemyTransmuteModel: vi.fn(() => null),
}));

vi.mock('../../utils/risk-of-ruin-adapters/enhancement-adapter.js', () => ({
    buildEnhancementModel: vi.fn(() => null),
}));

// The worker pool is not what these tests are about. `sim.gate`, when set, holds a run open so a
// teardown can land while the simulation is still pending.
const sim = vi.hoisted(() => ({ gate: null }));
vi.mock('../../utils/risk-of-ruin-worker-manager.js', () => ({
    simulateRuinAsync: vi.fn(async () => {
        if (sim.gate) await sim.gate;
        return {
            ruinProbability: 0,
            ruinCount: 0,
            trials: 10,
            ruinStepCounts: [],
            meanStepsToRuin: null,
            undecidedCount: 0,
        };
    }),
}));

vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: vi.fn(() => ({
        enhancingLevel: 100,
        houseLevel: 0,
        toolBonus: 0,
        speedBonus: 0,
        teas: { blessed: false },
        guzzlingBonus: 1,
        blessedTeaBonus: 0.01,
    })),
}));

vi.mock('../../utils/protection-substitute-lookup.js', () => ({
    suggestProtectionSubstituteProxyPrice: vi.fn(() => null),
}));

const storedOverrides = vi.hoisted(() => ({ map: {} }));
vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPriceVersion: () => 0,
    setCustomPriceOverride: vi.fn(async () => {}),
    getCustomPriceOverridesAsync: vi.fn(async () => storedOverrides.map),
}));

const { PANEL_ID, LAUNCHER_ID, TAB_ID, PANEL_KEY } = vi.hoisted(() => ({
    PANEL_ID: 'mwi-risk-of-ruin-panel',
    LAUNCHER_ID: 'mwi-risk-of-ruin-launcher',
    TAB_ID: 'mwi-risk-of-ruin-tab',
    PANEL_KEY: 'riskOfRuin',
}));

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { buildAlchemyTransmuteModel } from '../../utils/risk-of-ruin-adapters/alchemy-adapter.js';
import { buildEnhancementModel } from '../../utils/risk-of-ruin-adapters/enhancement-adapter.js';
import { reopenIfLeftOpen, clampPanelToViewport } from '../../utils/panel-geometry.js';
import riskOfRuinUI from './risk-of-ruin-ui.js';
import { suggestProtectionSubstituteProxyPrice } from '../../utils/protection-substitute-lookup.js';
import { setCustomPriceOverride } from '../settings/custom-price-overrides.js';

/** A stand-in for the character column's tab strip, found by its Inventory tab */
function buildTabStrip() {
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    list.className = 'MuiTabs-flexContainer';
    for (const name of ['Inventory', 'Equipment']) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = name;
        list.appendChild(tab);
    }
    document.body.appendChild(list);
    return list;
}

const panel = () => document.getElementById(PANEL_ID);
const isOpen = () => panel()?.style.display === 'flex';

describe('RiskOfRuinUI feature toggle', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
    });

    test('registers a live setting listener for the riskOfRuin toggle at module load', () => {
        // setupSettingListener() runs once at module load (see the bottom of
        // risk-of-ruin-ui.js), before any test body executes, so by the time this test runs
        // the handler must already be registered - proving the toggle is wired up live, not
        // just read once at startup (which previously required a page refresh to take effect).
        expect(mocks.settingChangeRegistrations).toContainEqual(['riskOfRuin', expect.any(Function)]);
        expect(mocks.settingChangeHandlers.riskOfRuin).toBeTypeOf('function');
    });

    test('initialize() is a no-op when the riskOfRuin setting is disabled', () => {
        mocks.settings.riskOfRuin = false;
        riskOfRuinUI.initialize();

        expect(document.getElementById(PANEL_ID)).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
    });

    test('toggling the riskOfRuin setting off removes the panel and launcher with no refresh', () => {
        riskOfRuinUI.initialize();
        expect(document.getElementById(PANEL_ID)).not.toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();

        // Simulate the settings panel checkbox being unchecked.
        mocks.settingChangeHandlers.riskOfRuin(false);

        expect(document.getElementById(PANEL_ID)).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
    });

    test('toggling the riskOfRuin setting back on rebuilds the panel and launcher', () => {
        riskOfRuinUI.initialize();
        mocks.settingChangeHandlers.riskOfRuin(false);
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();

        // Simulate the checkbox being re-checked - this is the live listener's other branch,
        // not feature-registry's own startup pass, which never re-runs mid-session.
        mocks.settings.riskOfRuin = true;
        mocks.settingChangeHandlers.riskOfRuin(true);

        expect(document.getElementById(PANEL_ID)).not.toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();
    });
});

describe('RiskOfRuinUI close and reopen', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
    });

    test('the panel opens closed and its ✕ remembers that it was closed', () => {
        buildTabStrip();
        riskOfRuinUI.initialize();
        expect(isOpen()).toBe(false);

        document.getElementById(`${LAUNCHER_ID}-open`).click();
        expect(isOpen()).toBe(true);
        expect(mocks.openState[PANEL_KEY]).toBe(true);

        panel().querySelector('#mwi-ror-close').click();
        expect(isOpen()).toBe(false);
        expect(mocks.openState[PANEL_KEY]).toBe(false);
    });

    test('opening fits the panel to the window, since the registration clamp ran while it was hidden', () => {
        riskOfRuinUI.initialize();
        vi.mocked(clampPanelToViewport).mockClear();
        expect(isOpen()).toBe(false);

        document.getElementById(`${LAUNCHER_ID}-open`).click();
        expect(clampPanelToViewport).toHaveBeenCalledTimes(1);
        expect(clampPanelToViewport.mock.calls[0][0]).toBe(panel());
        // Fitted after it is visible, not before
        expect(panel().style.display).toBe('flex');

        // Closing does not fit a hidden panel
        panel().querySelector('#mwi-ror-close').click();
        expect(clampPanelToViewport).toHaveBeenCalledTimes(1);
    });

    test('a panel left open reopens on the next load, and a closed one stays closed', () => {
        // Left open
        mocks.openState[PANEL_KEY] = true;
        riskOfRuinUI.initialize();
        expect(reopenIfLeftOpen).toHaveBeenCalledWith(PANEL_KEY, expect.any(Function));
        expect(isOpen()).toBe(true);

        // ...and the restore itself must not be mistaken for the user opening it
        riskOfRuinUI.disable();
        mocks.openState[PANEL_KEY] = false;
        riskOfRuinUI.initialize();
        expect(isOpen()).toBe(false);
    });

    test('the panel carries a minimize control that folds its body away', () => {
        riskOfRuinUI.initialize();
        document.getElementById(`${LAUNCHER_ID}-open`).click();

        const minimize = panel().querySelector('.toolasha-minimize-btn');
        expect(minimize).not.toBeNull();

        minimize.click();
        expect(panel().dataset.minimized).toBe('true');
        minimize.click();
        expect(panel().dataset.minimized).toBe('false');
    });

    test("the launcher's ✕ hides it through the setting, and the tab still opens the panel", () => {
        buildTabStrip();
        riskOfRuinUI.initialize();
        expect(document.getElementById(TAB_ID)).not.toBeNull();

        document.getElementById(`${LAUNCHER_ID}-close`).click();
        expect(config.setSetting).toHaveBeenCalledWith('riskOfRuin_showLauncher', false);
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();

        // The tab beside Inventory is the way back in
        document.getElementById(TAB_ID).click();
        expect(isOpen()).toBe(true);
    });

    test('a launcher turned off in settings is never drawn, and turning it back on redraws it', () => {
        mocks.settings.riskOfRuin_showLauncher = false;
        riskOfRuinUI.initialize();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();

        config.setSetting('riskOfRuin_showLauncher', true);
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();
    });

    test('the tab switch is put back when the game rebuilds the tab strip', () => {
        buildTabStrip();
        riskOfRuinUI.initialize();
        expect(document.getElementById(TAB_ID)).not.toBeNull();

        // The column changed view: the old strip goes, a new one arrives
        document.body.innerHTML = '';
        buildTabStrip();
        expect(document.getElementById(TAB_ID)).toBeNull();
        for (const handler of mocks.domObserverHandlers) handler.callback();
        expect(document.getElementById(TAB_ID)).not.toBeNull();
    });

    test('closing and reopening leaks no observer, drag listener or timer', () => {
        buildTabStrip();
        const documentAdd = vi.spyOn(document, 'addEventListener');

        for (let round = 0; round < 3; round += 1) {
            riskOfRuinUI.initialize();
            document.getElementById(`${LAUNCHER_ID}-open`).click();
            panel().querySelector('#mwi-ror-close').click();
            riskOfRuinUI.disable();
        }

        // One tab-strip watcher per initialize, all of them unregistered again
        expect(mocks.domObserverHandlers).toHaveLength(0);
        // Nothing is left on the page for the next round to double up on
        expect(document.getElementById(PANEL_ID)).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
        expect(document.getElementById(TAB_ID)).toBeNull();
        // The drag is attached to the header, not to the document: a panel that
        // is only sitting still must not be holding document-level move handlers
        expect(documentAdd.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0);
        documentAdd.mockRestore();
    });
});

describe('RiskOfRuinUI tab against a twin from another module copy', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
    });

    test('a strip already carrying our tab id is adopted, never given a second tab', () => {
        // Two bundles once both carried this singleton, and each injected its
        // own tab: live installs showed "Risk of Ruin" twice. A tab with our id
        // that is not ours is adopted instead of twinned.
        const list = buildTabStrip();
        const twin = document.createElement('button');
        twin.setAttribute('role', 'tab');
        twin.id = TAB_ID;
        twin.textContent = '⧉ Risk of Ruin';
        list.appendChild(twin);

        riskOfRuinUI.initialize();

        expect(document.querySelectorAll(`#${TAB_ID}`)).toHaveLength(1);
        expect(document.getElementById(TAB_ID)).toBe(twin);
    });
});

describe('RiskOfRuinUI transmute that cannot be priced', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap: {} }));
        dataManager.getItemDetails.mockImplementation(() => null);
    });

    /** Serve one item detail map through both of the data manager's doors */
    function serveItems(itemDetailMap) {
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap }));
        dataManager.getItemDetails.mockImplementation((hrid) => itemDetailMap[hrid] ?? null);
    }

    test('a raw hrid for an item that cannot be transmuted asks for a transmutable item', async () => {
        serveItems({ '/items/milk': { name: 'Milk' } });
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'alchemy';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/milk';

        await riskOfRuinUI._compute();

        expect(root.querySelector('#mwi-ror-status').textContent).toBe('Enter a valid transmutable item name.');
    });

    test('a known item with an unpriced chosen catalyst is not called an invalid item', async () => {
        serveItems({
            '/items/cheese': {
                name: 'Cheese',
                alchemyDetail: {
                    bulkMultiplier: 1,
                    transmuteSuccessRate: 0.5,
                    transmuteDropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 1, maxCount: 1 }],
                },
            },
        });
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'alchemy';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/cheese';
        root.querySelector('#mwi-ror-catalyst').value = 'prime';

        await riskOfRuinUI._compute();

        const status = root.querySelector('#mwi-ror-status').textContent;
        expect(status).not.toBe('Enter a valid transmutable item name.');
        expect(status).toContain('selected catalyst');
    });

    test('an unknown item still asks for a valid name', async () => {
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'alchemy';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = 'Not An Item';

        await riskOfRuinUI._compute();

        expect(root.querySelector('#mwi-ror-status').textContent).toBe('Enter a valid transmutable item name.');
    });
});

describe('RiskOfRuinUI enhancement with incomplete input prices', () => {
    afterEach(() => {
        riskOfRuinUI.disable();
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap: {} }));
        dataManager.getItemDetails.mockImplementation(() => null);
    });

    test('explains the missing price and does not expose a partial depth-cap cost', async () => {
        dataManager.getInitClientData.mockImplementation(() => ({
            itemDetailMap: {
                '/items/kraken_chaps_refined': {
                    name: 'Kraken Chaps ★',
                    enhancementCosts: [
                        { itemHrid: '/items/pirate_essence', count: 14 },
                        { itemHrid: '/items/umbral_leather', count: 6 },
                        { itemHrid: '/items/coin', count: 4815 },
                    ],
                },
            },
        }));
        dataManager.getItemDetails.mockImplementation(
            (hrid) => dataManager.getInitClientData().itemDetailMap[hrid] ?? null
        );
        buildEnhancementModel.mockReturnValueOnce({ error: 'incomplete-prices' });
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'enhancement';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/kraken_chaps_refined';

        await riskOfRuinUI._compute();

        expect(root.querySelector('#mwi-ror-status').textContent).toContain('price');
        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
    });

    test('rejects protect-from +1 because the game disables that action setting', async () => {
        dataManager.getInitClientData.mockImplementation(() => ({
            itemDetailMap: {
                '/items/kraken_chaps_refined': {
                    name: 'Kraken Chaps ★',
                    enhancementCosts: [
                        { itemHrid: '/items/pirate_essence', count: 14 },
                        { itemHrid: '/items/umbral_leather', count: 6 },
                        { itemHrid: '/items/coin', count: 4815 },
                    ],
                },
            },
        }));
        dataManager.getItemDetails.mockImplementation(
            (hrid) => dataManager.getInitClientData().itemDetailMap[hrid] ?? null
        );
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'enhancement';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/kraken_chaps_refined';
        root.querySelector('#mwi-ror-protect-from').value = '1';
        buildEnhancementModel.mockClear();

        await riskOfRuinUI._compute();

        expect(root.querySelector('#mwi-ror-status').textContent).toContain('at least +2');
        expect(buildEnhancementModel).not.toHaveBeenCalled();
    });

    test('rejects captured Coin as non-enhanceable before building a model', async () => {
        dataManager.getInitClientData.mockImplementation(() => ({
            itemDetailMap: {
                '/items/coin': { name: 'Coin' },
                '/items/cheese_sword': {
                    name: 'Cheese Sword',
                    itemLevel: 1,
                    enhancementCosts: [
                        { itemHrid: '/items/cheese', count: 5 },
                        { itemHrid: '/items/coin', count: 12 },
                    ],
                    isTradable: true,
                },
            },
        }));
        dataManager.getItemDetails.mockImplementation(
            (hrid) => dataManager.getInitClientData().itemDetailMap[hrid] ?? null
        );
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'enhancement';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/coin';
        buildEnhancementModel.mockClear();

        await riskOfRuinUI._compute();

        expect(root.querySelector('#mwi-ror-status').textContent).toContain('valid enhanceable item');
        expect(buildEnhancementModel).not.toHaveBeenCalled();

        root.querySelector('#mwi-ror-item').value = '/items/cheese_sword';
        await riskOfRuinUI._compute();
        expect(buildEnhancementModel).toHaveBeenCalledWith(
            '/items/cheese_sword',
            expect.objectContaining({ itemLevel: 1 })
        );
    });
});

describe('depth-cap cost attribution', () => {
    test('chest mode splits the cost across priced drops by their share of expected value', () => {
        const items = riskOfRuinUI._chestDepthCapItems(
            [
                { itemHrid: '/items/a', dropRate: 0.5, avgCount: 2, expectedValue: 300, hasPriceData: true },
                { itemHrid: '/items/b', dropRate: 0.1, avgCount: 1, expectedValue: 100, hasPriceData: true },
                { itemHrid: '/items/c', dropRate: 0.2, avgCount: 1, expectedValue: 0, hasPriceData: false },
            ],
            1000
        );

        expect(items).toEqual([
            { itemHrid: '/items/a', enhancementLevel: 0, quantityPerAction: 1, costShare: 750 },
            { itemHrid: '/items/b', enhancementLevel: 0, quantityPerAction: 0.1, costShare: 250 },
        ]);
    });

    test('a single tracked chest drop is charged the whole cost', () => {
        const items = riskOfRuinUI._chestDepthCapItems(
            [{ itemHrid: '/items/a', dropRate: 1, avgCount: 1, expectedValue: 50, hasPriceData: true }],
            400
        );
        expect(items[0].costShare).toBe(400);
    });

    test('alchemy mode attributes cost by per-action EV across main branches and bonus drops', () => {
        const items = riskOfRuinUI._alchemyDepthCapItems(
            {
                successRate: 0.5,
                mainBranches: [
                    { itemHrid: '/items/x', dropRate: 1, count: 1, payout: 600, isSelfReturn: false },
                    { itemHrid: '/items/self', dropRate: 1, count: 1, payout: 600, isSelfReturn: true },
                ],
                bonusDrops: [{ itemHrid: '/items/ess', dropRate: 0.1, count: 2, payout: 1000 }],
            },
            800
        );

        // EV: x = 600*0.5 = 300, self-return = 300, ess = 1000*0.1 = 100. The self-return is not a
        // tracked item, but getting the input back offsets cost, so it stays in the denominator:
        // shares 300/700 and 100/700
        expect(items.map((i) => i.itemHrid)).toEqual(['/items/x', '/items/ess']);
        expect(items[0].quantityPerAction).toBe(0.5);
        expect(items[1].quantityPerAction).toBe(0.2);
        expect(items.map((i) => i.enhancementLevel)).toEqual([0, 0]);
        expect(items[0].costShare).toBeCloseTo((800 * 300) / 700, 6);
        expect(items[1].costShare).toBeCloseTo((800 * 100) / 700, 6);
    });
});

describe('protection-substitute proxy price', () => {
    afterEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    test('an unpriced drop that is not a substitute stays a dash', () => {
        suggestProtectionSubstituteProxyPrice.mockReturnValue(null);

        expect(riskOfRuinUI._protectionSubstituteCellHTML({ itemHrid: '/items/jade' })).toBe('—');
    });

    test('a substitute shows the suggested price, its source, and an Apply button carrying the price', () => {
        suggestProtectionSubstituteProxyPrice.mockReturnValue({
            price: 192000,
            viaItemHrid: '/items/mirror_of_protection',
        });

        const html = riskOfRuinUI._protectionSubstituteCellHTML({ itemHrid: '/items/chimerical_quiver' });

        expect(html).toContain('192,000');
        expect(html).toContain('mwi-ror-apply-substitute-price');
        expect(html).toContain('data-item-hrid="/items/chimerical_quiver"');
        expect(html).toContain('data-suggested-price="192000"');
    });

    test('rendering a suggestion never writes an override by itself', () => {
        suggestProtectionSubstituteProxyPrice.mockReturnValue({
            price: 192000,
            viaItemHrid: '/items/mirror_of_protection',
        });

        riskOfRuinUI._protectionSubstituteCellHTML({ itemHrid: '/items/chimerical_quiver' });

        expect(setCustomPriceOverride).not.toHaveBeenCalled();
    });

    test('one Apply click saves one sell-side override at level 0 and reruns the calculation', async () => {
        const runSpy = vi.spyOn(riskOfRuinUI, '_run').mockImplementation(() => {});
        document.body.innerHTML =
            '<button class="mwi-ror-apply-substitute-price" data-item-hrid="/items/chimerical_quiver" data-suggested-price="192000"></button>';
        const button = document.querySelector('.mwi-ror-apply-substitute-price');

        await riskOfRuinUI._handleApplySubstitutePriceClick({ target: button });

        expect(setCustomPriceOverride).toHaveBeenCalledTimes(1);
        expect(setCustomPriceOverride).toHaveBeenCalledWith('/items/chimerical_quiver', 0, null, 192000);
        expect(runSpy).toHaveBeenCalled();
        runSpy.mockRestore();
    });

    test('applying the suggested sell price keeps a buy-side override the player already set', async () => {
        const runSpy = vi.spyOn(riskOfRuinUI, '_run').mockImplementation(() => {});
        storedOverrides.map = { '/items/chimerical_quiver:0': { buy: 150000 } };
        document.body.innerHTML =
            '<button class="mwi-ror-apply-substitute-price" data-item-hrid="/items/chimerical_quiver" data-suggested-price="192000"></button>';

        await riskOfRuinUI._handleApplySubstitutePriceClick({
            target: document.querySelector('.mwi-ror-apply-substitute-price'),
        });

        expect(setCustomPriceOverride).toHaveBeenCalledWith('/items/chimerical_quiver', 0, 150000, 192000);
        storedOverrides.map = {};
        runSpy.mockRestore();
    });

    test('a click anywhere else, or on a button with a bad price, saves nothing', async () => {
        const runSpy = vi.spyOn(riskOfRuinUI, '_run').mockImplementation(() => {});
        document.body.innerHTML =
            '<div id="x"></div><button class="mwi-ror-apply-substitute-price" data-item-hrid="/items/q" data-suggested-price="abc"></button>';

        await riskOfRuinUI._handleApplySubstitutePriceClick({ target: document.querySelector('#x') });
        await riskOfRuinUI._handleApplySubstitutePriceClick({
            target: document.querySelector('.mwi-ror-apply-substitute-price'),
        });

        expect(setCustomPriceOverride).not.toHaveBeenCalled();
        expect(runSpy).not.toHaveBeenCalled();
        runSpy.mockRestore();
    });
});

describe('sell-depth context from a real enhancing run', () => {
    afterEach(() => {
        riskOfRuinUI.disable();
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap: {} }));
        dataManager.getItemDetails.mockImplementation(() => null);
    });

    /** Run a +0 to +target enhancement of a tradable cheese sword through the real producer */
    async function runEnhancement(targetLevel) {
        const itemDetailMap = {
            '/items/cheese_sword': {
                name: 'Cheese Sword',
                itemLevel: 1,
                isTradable: true,
                enhancementCosts: [{ itemHrid: '/items/coin', count: 12 }],
            },
        };
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap }));
        dataManager.getItemDetails.mockImplementation((hrid) => itemDetailMap[hrid] ?? null);
        buildEnhancementModel.mockReturnValueOnce({
            expectedTotalCost: 1000,
            maxSinglePossibleLoss: 100,
            perLevelOutcomeDistributions: [],
            costPerAttempt: 10,
            protectionCostOnFailure: 0,
        });
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'enhancement';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/cheese_sword';
        root.querySelector('#mwi-ror-target').value = String(targetLevel);
        await riskOfRuinUI._compute();
    }

    test('the output is the target-level variant, not the base item', async () => {
        await runEnhancement(10);

        expect(riskOfRuinUI.getDepthCapContext()).toEqual({
            characterId: 'char-A',
            costPerAction: 1000,
            items: [{ itemHrid: '/items/cheese_sword', enhancementLevel: 10, quantityPerAction: 1 }],
        });
    });
});

describe('sell-depth context ownership', () => {
    const repaint = vi.fn();

    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
        repaint.mockClear();
        globalThis.window.Toolasha = { Market: { marketDepthCap: { repaint } } };
        dataManager.getCurrentCharacterId.mockImplementation(() => 'char-A');
    });

    afterEach(() => {
        riskOfRuinUI.disable();
        sim.gate = null;
        delete globalThis.window.Toolasha;
        dataManager.getCurrentCharacterId.mockImplementation(() => 'char-A');
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap: {} }));
        dataManager.getItemDetails.mockImplementation(() => null);
    });

    /** Start a +0 to +10 cheese sword run under whoever is logged in; resolves when the run ends */
    function startRun() {
        const itemDetailMap = {
            '/items/cheese_sword': {
                name: 'Cheese Sword',
                itemLevel: 1,
                isTradable: true,
                enhancementCosts: [{ itemHrid: '/items/coin', count: 12 }],
            },
        };
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap }));
        dataManager.getItemDetails.mockImplementation((hrid) => itemDetailMap[hrid] ?? null);
        buildEnhancementModel.mockReturnValueOnce({
            expectedTotalCost: 1000,
            maxSinglePossibleLoss: 100,
            perLevelOutcomeDistributions: [],
            costPerAttempt: 10,
            protectionCostOnFailure: 0,
        });
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'enhancement';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/cheese_sword';
        root.querySelector('#mwi-ror-target').value = '10';
        return riskOfRuinUI._compute();
    }

    test('teardown withdraws the context and has the widget redraw', async () => {
        await startRun();
        expect(riskOfRuinUI.getDepthCapContext()).not.toBeNull();

        repaint.mockClear();
        riskOfRuinUI.disable();

        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
        expect(riskOfRuinUI.lastDepthCapContext).toBeNull();
        expect(repaint).toHaveBeenCalledTimes(1);
    });

    test('teardown redraws even when a run in flight already dropped the context', async () => {
        await startRun();
        // A new run nulls the context at its start but leaves the old figure drawn until it ends
        riskOfRuinUI.lastDepthCapContext = null;

        repaint.mockClear();
        riskOfRuinUI.disable();

        expect(repaint).toHaveBeenCalledTimes(1);
    });

    test('turning Risk of Ruin off in settings stops it supplying a context', async () => {
        await startRun();

        mocks.settingChangeHandlers.riskOfRuin(false);

        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
    });

    test('a run priced for character A is not offered to character B who never ran one', async () => {
        await startRun();
        expect(riskOfRuinUI.getDepthCapContext()).not.toBeNull();

        dataManager.getCurrentCharacterId.mockImplementation(() => 'char-B');
        // Even before teardown has run on the switch, B is never served A's costs
        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();

        riskOfRuinUI.disable();
        riskOfRuinUI.initialize();
        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
    });

    test('a calculation still simulating when the panel is torn down publishes nothing afterward', async () => {
        let release;
        sim.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = startRun();
        expect(riskOfRuinUI.getDepthCapContext()).not.toBeNull();

        riskOfRuinUI.disable();
        riskOfRuinUI.initialize();
        release();
        await pending;

        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
        expect(riskOfRuinUI.lastDepthCapContext).toBeNull();
    });

    test('recalculating with the marketplace open leaves the widget drawn from the new context', async () => {
        const seen = [];
        repaint.mockImplementation(() => seen.push(riskOfRuinUI.getDepthCapContext() !== null));
        await startRun();
        seen.length = 0;

        buildEnhancementModel.mockReturnValueOnce({
            expectedTotalCost: 2000,
            maxSinglePossibleLoss: 100,
            perLevelOutcomeDistributions: [],
            costPerAction: 10,
            protectionCostOnFailure: 0,
        });
        await riskOfRuinUI._compute();

        // The last redraw happens with the new context in place, so the figure is not left down
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)).toBe(true);
        expect(riskOfRuinUI.getDepthCapContext().costPerAction).toBe(2000);
        repaint.mockReset();
    });

    test('a run refused after an earlier one still redraws, taking the withdrawn figure down', async () => {
        await startRun();
        repaint.mockClear();
        panel().querySelector('#mwi-ror-item').value = 'Not An Item';

        await riskOfRuinUI._compute();

        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
        expect(repaint).toHaveBeenCalled();
    });

    test('a character change mid-run on a live panel does not leave "Calculating…" showing', async () => {
        let release;
        sim.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = startRun();
        panel().querySelector('#mwi-ror-status').textContent = 'Calculating…';
        dataManager.getCurrentCharacterId.mockImplementation(() => 'char-B');
        release();
        await pending;

        expect(panel().querySelector('#mwi-ror-status').textContent).toBe('');
        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
    });

    test('a simulation that rejects after the context was set leaves no figure', async () => {
        const seen = [];
        repaint.mockImplementation(() => seen.push(riskOfRuinUI.getDepthCapContext() !== null));
        sim.gate = Promise.reject(new Error('worker died'));
        sim.gate.catch(() => {});

        await expect(startRun()).rejects.toThrow('worker died');

        expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
        expect(seen.at(-1)).toBe(false);
        repaint.mockReset();
    });

    test('a rendering throw after publishing leaves no figure', async () => {
        const render = vi.spyOn(riskOfRuinUI, '_renderResults').mockImplementation(() => {
            throw new Error('render failed');
        });
        try {
            await expect(startRun()).rejects.toThrow('render failed');
            expect(riskOfRuinUI.getDepthCapContext()).toBeNull();
        } finally {
            render.mockRestore();
        }
    });

    test('an older run failing after a newer run published leaves the newer context', async () => {
        let fail;
        sim.gate = new Promise((_, reject) => {
            fail = reject;
        });
        sim.gate.catch(() => {});
        const older = startRun();
        older.catch(() => {});

        // A newer run starts and publishes while the older one is still simulating
        sim.gate = null;
        buildEnhancementModel.mockReturnValueOnce({
            expectedTotalCost: 3000,
            maxSinglePossibleLoss: 100,
            perLevelOutcomeDistributions: [],
            costPerAttempt: 10,
            protectionCostOnFailure: 0,
        });
        await riskOfRuinUI._compute();
        expect(riskOfRuinUI.getDepthCapContext().costPerAction).toBe(3000);

        fail(new Error('older failed'));
        await expect(older).rejects.toThrow('older failed');

        expect(riskOfRuinUI.getDepthCapContext().costPerAction).toBe(3000);
    });

    test('a new run for the same character is still served', async () => {
        await startRun();
        riskOfRuinUI.disable();
        await startRun();

        expect(riskOfRuinUI.getDepthCapContext().items[0].itemHrid).toBe('/items/cheese_sword');
    });
});

describe('transmute sell-depth cost includes the catalyst', () => {
    afterEach(() => {
        riskOfRuinUI.disable();
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap: {} }));
        dataManager.getItemDetails.mockImplementation(() => null);
    });

    async function runTransmute(model) {
        const itemDetailMap = {
            '/items/cheese': {
                name: 'Cheese',
                alchemyDetail: { transmuteDropTable: [{ itemHrid: '/items/moonstone', dropRate: 1 }] },
            },
        };
        dataManager.getInitClientData.mockImplementation(() => ({ itemDetailMap }));
        dataManager.getItemDetails.mockImplementation((hrid) => itemDetailMap[hrid] ?? null);
        buildAlchemyTransmuteModel.mockReturnValueOnce(model);
        riskOfRuinUI.initialize();
        const root = panel();
        root.querySelector('#mwi-ror-mode').value = 'alchemy';
        riskOfRuinUI._renderModeInputs();
        root.querySelector('#mwi-ror-item').value = '/items/cheese';
        await riskOfRuinUI._compute();
        return riskOfRuinUI.getDepthCapContext();
    }

    const breakdown = (extra = {}) => ({
        successRate: 0.5,
        mainBranches: [{ itemHrid: '/items/moonstone', dropRate: 1, count: 1, payout: 1000, isSelfReturn: false }],
        bonusDrops: [],
        ...extra,
    });

    test('a catalyst-assisted transmute is charged its expected spend, not just the unconditional cost', async () => {
        const context = await runTransmute({
            cost: 100,
            expectedCost: 600,
            maxSinglePossibleLoss: 1100,
            outcomeDistribution: [
                { prob: 0.5, net: -100 },
                { prob: 0.5, net: -100 - 1000 + 1000 },
            ],
            breakdown: breakdown(),
        });

        expect(context.costPerAction).toBe(600);
        expect(context.items).toEqual([
            { itemHrid: '/items/moonstone', enhancementLevel: 0, quantityPerAction: 0.5, costShare: 600 },
        ]);
    });

    test('multi-output cost shares sum to the expected spend and a self-return keeps its slice', async () => {
        const context = await runTransmute({
            cost: 100,
            expectedCost: 600,
            maxSinglePossibleLoss: 1100,
            outcomeDistribution: [{ prob: 1, net: -100 }],
            breakdown: breakdown({
                mainBranches: [
                    { itemHrid: '/items/moonstone', dropRate: 0.5, count: 1, payout: 1000, isSelfReturn: false },
                    { itemHrid: '/items/cheese', dropRate: 0.5, count: 1, payout: 1000, isSelfReturn: true },
                ],
                bonusDrops: [{ itemHrid: '/items/ess', dropRate: 0.25, count: 1, payout: 500 }],
            }),
        });

        // EV: moonstone 250, self-return 250 (not tracked), essence 125 -> 625 total
        expect(context.items.map((i) => i.itemHrid)).toEqual(['/items/moonstone', '/items/ess']);
        expect(context.items[0].costShare).toBeCloseTo((600 * 250) / 625, 6);
        expect(context.items[1].costShare).toBeCloseTo((600 * 125) / 625, 6);
    });
});
