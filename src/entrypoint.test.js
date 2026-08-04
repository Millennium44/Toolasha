/** @vitest-environment happy-dom */

/**
 * The health checks, tested against faked anchors.
 *
 * They live on the registration entries rather than in a module, which is right
 * — a check is about how a feature is wired into the page, not about the
 * feature's own logic — but it means the only way to reach one is to boot the
 * entrypoint and take the registry it hands over. That is what this does: every
 * library is a stub, `replaceFeatures` is the seam, and the predicates come out
 * the other side as ordinary functions to run against a DOM built by hand.
 *
 * What is worth asserting is not that a present marker reads as healthy — it is
 * the two ways a health pass turns into noise. A panel that is not open must
 * read as "cannot tell", and a readout the player switched off must read as
 * healthy, because "N features failed to start" is a claim that stops being
 * believed the first time it is wrong.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';

/** Settings the fake config answers with; mutated per test */
const settings = {};

/** The registry entries the entrypoint hands to `replaceFeatures` */
let registered = [];

/** A library stand-in: every property is a callable that returns another one */
function makeStub() {
    return new Proxy(function stub() {}, {
        get: (target, prop) => {
            // Nothing here is a promise, and pretending otherwise breaks `await`
            if (prop === 'then') return undefined;
            return makeStub();
        },
        apply: () => makeStub(),
    });
}

beforeAll(async () => {
    window.Toolasha = {
        Core: {
            storage: { initialize: async () => {}, flushAll: () => {}, diagnostics: () => ({}) },
            config: {
                Z_FLOATING_PANEL: 1100,
                getSetting: (key) => settings[key],
                getSettingValue: (key, fallback) => (key in settings ? settings[key] : fallback),
                isFeatureEnabled: () => true,
                initialize: async () => {},
                loadSettings: async () => {},
                applyColorSettings: () => {},
                getFeaturesByCategory: () => [],
                setFeatureEnabled: () => {},
                toggleFeature: () => {},
                getFeatureInfo: () => {},
            },
            webSocketHook: { install: () => {}, captureClientDataFromLocalStorage: () => {} },
            domObserver: { start: () => {} },
            dataManager: { initialize: () => {}, on: () => {}, getIsCharacterSwitching: () => false },
            featureRegistry: {
                replaceFeatures: (features) => {
                    registered = features;
                },
                setupCharacterSwitchHandler: () => {},
                checkFeatureHealth: () => [],
                retryFailedFeatures: async () => [],
                initializeFeatures: async () => [],
            },
            performanceMonitor: { mark: () => {} },
        },
        Utils: {
            dom: { setupScrollTooltipDismissal: () => {} },
            toast: { showToast: () => null },
        },
        Market: makeStub(),
        Actions: makeStub(),
        Combat: makeStub(),
        UI: makeStub(),
    };

    await import('./entrypoint.js');
});

/**
 * The health check registered under a feature key.
 * @param {string} key - Feature key
 * @returns {Function} Its health check
 */
function checkFor(key) {
    const entry = registered.find((feature) => feature.key === key);
    expect(entry, `no feature registered under ${key}`).toBeTruthy();
    expect(typeof entry.healthCheck, `${key} has no health check`).toBe('function');
    return entry.healthCheck;
}

beforeEach(() => {
    document.body.innerHTML = '';
    for (const key of Object.keys(settings)) delete settings[key];
});

describe('the registry the entrypoint builds', () => {
    test('carries health checks through, which is the whole point', () => {
        const withChecks = registered.filter((feature) => typeof feature.healthCheck === 'function');
        expect(withChecks.length).toBeGreaterThanOrEqual(12);
    });
});

describe('net worth health check', () => {
    const check = () => checkFor('networth')();

    test('says nothing when the header is not drawn', () => {
        expect(check()).toBeNull();
    });

    test('fails when the header is there and the readout is not', () => {
        document.body.innerHTML = '<div class="Header_totalLevel__1Ku1r">Total 1500</div>';
        expect(check()).toBe(false);
    });

    test('passes once the readout is beside it', () => {
        document.body.innerHTML =
            '<div class="Header_totalLevel__1Ku1r">Total 1500</div><div class="mwi-networth-header">12M</div>';
        expect(check()).toBe(true);
    });
});

describe('task icons health check', () => {
    const check = () => checkFor('taskIcons')();

    const taskList = (attrs = '') =>
        `<div class="TasksPanel_taskList__2xy1"><div class="RandomTask_randomTask__pzB4z" ${attrs}></div></div>`;

    test('says nothing while the Tasks panel is closed', () => {
        expect(check()).toBeNull();
    });

    test('fails on an unprocessed task card', () => {
        document.body.innerHTML = taskList();
        expect(check()).toBe(false);
    });

    test('passes once a card has been stamped', () => {
        document.body.innerHTML = taskList('data-mwi-task-processed="Kill - Jerry"');
        expect(check()).toBe(true);
    });

    test('an empty task list is not a failure — there is nothing to mark', () => {
        document.body.innerHTML = '<div class="TasksPanel_taskList__2xy1"></div>';
        expect(check()).toBeNull();
    });
});

describe('overlay tab button health check', () => {
    const check = () => checkFor('overlayTabButton')();

    const tabStrip = (extra = '') =>
        `<div role="tablist"><button role="tab">Inventory</button>${extra}</div>` +
        '<div role="tablist"><button role="tab">Something else</button></div>';

    beforeEach(() => {
        settings.overlayPanel = true;
    });

    test('a switched-off overlay is healthy, not broken', () => {
        settings.overlayPanel = false;
        document.body.innerHTML = tabStrip();
        expect(check()).toBe(true);
    });

    test('says nothing when no tab strip holds an Inventory tab', () => {
        document.body.innerHTML = '<div role="tablist"><button role="tab">Abilities</button></div>';
        expect(check()).toBeNull();
    });

    test('fails when the strip is drawn and the button is missing', () => {
        document.body.innerHTML = tabStrip();
        expect(check()).toBe(false);
    });

    test('passes once the button is in the strip', () => {
        document.body.innerHTML = tabStrip('<button id="toolasha-overlay-tab">⧉ Overlay</button>');
        expect(check()).toBe(true);
    });
});

describe('item count display health check', () => {
    const check = () => checkFor('itemCountDisplay')();

    const marketTiles = (extra = '') =>
        `<div class="MarketplacePanel_marketItems__1lLm4"><div><svg><use href="#iron_bar"></use></svg>${extra}</div></div>`;

    test('a switched-off count is healthy', () => {
        settings.market_visibleItemCount = false;
        document.body.innerHTML = marketTiles();
        expect(check()).toBe(true);
    });

    test('fails when the tiles are drawn and no count is on them', () => {
        settings.market_visibleItemCount = true;
        document.body.innerHTML = marketTiles();
        expect(check()).toBe(false);
    });

    test('passes once a count is drawn', () => {
        settings.market_visibleItemCount = true;
        document.body.innerHTML = marketTiles('<div class="mwi-item-count">12</div>');
        expect(check()).toBe(true);
    });
});

describe('inventory badge prices health check', () => {
    const check = () => checkFor('inventoryBadgePrices')();

    const inventory = (dataset, extra = '') =>
        `<div class="Inventory_items__6SXv0"><div class="Item_itemContainer__x7kH1" ${dataset}>${extra}</div></div>`;

    beforeEach(() => {
        settings.invBadgePrices = true;
    });

    test('says nothing when nothing in view is worth anything', () => {
        document.body.innerHTML = inventory('data-ask-price="0"');
        expect(check()).toBeNull();
    });

    test('fails when a priced item carries no badge', () => {
        document.body.innerHTML = inventory('data-ask-price="1200"');
        expect(check()).toBe(false);
    });

    test('passes once the badge is on it', () => {
        document.body.innerHTML = inventory('data-ask-price="1200"', '<div class="mwi-badge-price-ask">1.2K</div>');
        expect(check()).toBe(true);
    });
});
