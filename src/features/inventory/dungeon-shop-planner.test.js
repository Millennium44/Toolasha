/** @vitest-environment happy-dom */
/**
 * Dungeon token spend planner — the panel's plan and the row click that arms
 * the game's shop dialog. The game's own buy flow is exercised through the real
 * `marketplace-autofill.js`; only the DOM observer that would hand it the modal
 * is driven by hand.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    settings: {},
    inventory: [],
    volumes: {},
    classHandlers: [],
    shopTab: null,
    filtered: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in state.settings ? state.settings[key] : fallback),
        getSettingValue: (key, fallback = null) => (key in state.settings ? state.settings[key] : fallback),
        setSetting: (key, value) => {
            state.settings[key] = value;
        },
        setSettingValue: (key, value) => {
            state.settings[key] = value;
        },
        isFeatureEnabled: () => true,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/pirate_token': { name: 'Pirate Token' },
                '/items/chimerical_token': { name: 'Chimerical Token' },
                '/items/sinister_token': { name: 'Sinister Token' },
                '/items/enchanted_token': { name: 'Enchanted Token' },
                '/items/pirate_essence': { name: 'Pirate Essence' },
                '/items/kraken_fang': { name: 'Kraken Fang' },
                '/items/marksman_brooch': { name: 'Marksman Brooch' },
            },
            shopItemDetailMap: {
                a: { itemHrid: '/items/pirate_essence', costs: [{ itemHrid: '/items/pirate_token', count: 1 }] },
                b: { itemHrid: '/items/marksman_brooch', costs: [{ itemHrid: '/items/pirate_token', count: 2000 }] },
                c: { itemHrid: '/items/kraken_fang', costs: [{ itemHrid: '/items/pirate_token', count: 3000 }] },
            },
        }),
        getInventory: () => state.inventory,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            const entry = { name, className, callback };
            state.classHandlers.push(entry);
            return () => {
                const index = state.classHandlers.indexOf(entry);
                if (index > -1) state.classHandlers.splice(index, 1);
            };
        },
        onReady: () => () => {},
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid) =>
        ({
            '/items/pirate_essence': { ask: 100, bid: 90 },
            '/items/marksman_brooch': { ask: 500_000, bid: 450_000 },
            '/items/kraken_fang': { ask: 1_000_000, bid: 950_000 },
        })[hrid] || null,
}));

vi.mock('../../utils/liquidity-cap.js', () => ({
    itemDailyVolume: async (itemHrid) => state.volumes[itemHrid] || { itemHrid, unitsPerDay: 0, known: false },
}));

vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.96,
    outputTaxRate: () => 0.04,
}));

vi.mock('../../utils/tester-shop-nav.js', () => ({
    openShopTab: async () => state.shopTab,
    setShopFilter: (name) => {
        state.filtered.push(name);
        return true;
    },
}));

vi.mock('../../utils/simple-panel.js', () => ({
    createPanel: ({ draw }) => {
        let body = null;
        const api = {
            show() {
                if (!body) {
                    body = document.createElement('div');
                    body.id = 'planner-body';
                    document.body.appendChild(body);
                }
                api.render();
            },
            render() {
                if (!body) return;
                body.replaceChildren();
                draw(body);
            },
            destroy() {
                body?.remove();
                body = null;
            },
        };
        return api;
    },
    panelNote: (text) => {
        const note = document.createElement('div');
        note.textContent = text;
        return note;
    },
}));

const { dungeonShopPlanner } = await import('./dungeon-shop-planner.js');

const body = () => document.getElementById('planner-body');
const rows = () => Array.from(document.querySelectorAll('.toolasha-dungeon-plan-row'));
const rowFor = (hrid) => rows().find((row) => row.dataset.itemHrid === hrid);
const qtyOf = (hrid) => rowFor(hrid).cells[1].textContent;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Open the panel on Pirate Tokens and let the volume lookups settle */
async function openPirate() {
    dungeonShopPlanner.open('/items/pirate_token');
    for (let i = 0; i < 5; i++) await flush();
}

/**
 * A dialog shaped like the Shop's buy dialog: item icon, Quantity box, a
 * "You Pay" line and a bare Buy button, no marketplace header.
 * @param {string} slug - Item sprite id
 * @returns {{modal: HTMLElement, input: HTMLInputElement, buy: HTMLButtonElement}}
 */
function shopDialog(slug) {
    const modal = document.createElement('div');
    modal.className = 'Modal_modalContainer__abc';
    modal.innerHTML = `
        <div class="ShopPanel_modal__x">
            <div class="Item_itemContainer__y"><svg><use href="/static/items_sprite.svg#${slug}"></use></svg></div>
            <div>Quantity</div>
            <input type="text" value="1">
            <div>You Pay: 2,000 Pirate Token</div>
            <button>Buy</button>
            <button>Cancel</button>
        </div>`;
    document.body.appendChild(modal);
    return {
        modal,
        input: modal.querySelector('input'),
        buy: Array.from(modal.querySelectorAll('button')).find((b) => b.textContent === 'Buy'),
    };
}

/** Hand a modal to every observer watching for buy modals, as the game's DOM would */
function announceModal(modal) {
    for (const entry of state.classHandlers.filter((h) => h.className === 'Modal_modalContainer')) {
        entry.callback(modal);
    }
}

beforeEach(() => {
    document.body.innerHTML = '';
    state.settings = {};
    state.inventory = [{ itemHrid: '/items/pirate_token', count: 7500, itemLocationHrid: '/item_locations/inventory' }];
    state.volumes = {
        '/items/pirate_essence': { unitsPerDay: 4000, known: true },
        '/items/marksman_brooch': { unitsPerDay: 4, known: true },
        '/items/kraken_fang': { unitsPerDay: 1.4, known: true },
    };
    state.shopTab = document.createElement('div');
    state.filtered = [];
    dungeonShopPlanner.initialize();
});

afterEach(() => {
    dungeonShopPlanner.cleanup();
    vi.useRealTimers();
});

describe('the plan', () => {
    test('caps each item by volume and spends the rest on the next best', async () => {
        await openPirate();
        // Fang 320/token after tax, cap floor(1.4×3×0.25)=1; Brooch 240, cap 3; Essence 96
        expect(qtyOf('/items/kraken_fang')).toBe('1');
        expect(qtyOf('/items/marksman_brooch')).toBe('2');
        expect(qtyOf('/items/pirate_essence')).toBe('500');
        expect(body().textContent).toContain('0 left over');
        expect(body().textContent).toContain('less 4% market tax');
        expect(body().textContent).not.toContain('could not be drawn');
    });

    test('changing the window and share re-caps the plan', async () => {
        await openPirate();
        const days = body().querySelector('.toolasha-dungeon-plan-days');
        days.value = '10';
        days.dispatchEvent(new Event('change'));
        expect(state.settings.dungeonShopPlanner_days).toBe(10);
        // Fang cap floor(1.4×10×0.25)=3 → 2 affordable at 7,500 tokens
        expect(qtyOf('/items/kraken_fang')).toBe('2');

        const share = body().querySelector('.toolasha-dungeon-plan-share');
        share.value = '5';
        share.dispatchEvent(new Event('change'));
        // floor(1.4×10×0.05)=0
        expect(qtyOf('/items/kraken_fang')).toBe('—');
    });

    test('volumes measured for one history source are dropped when the source changes mid-lookup', async () => {
        dungeonShopPlanner.syncVolumeSource();
        const pending = dungeonShopPlanner.measure('/items/pirate_token');
        // Switched while the first lookup is still out
        state.settings.market_historySource = 'mooket1';
        dungeonShopPlanner.syncVolumeSource();
        await pending;

        expect(dungeonShopPlanner.volumes.size).toBe(0);
        expect(dungeonShopPlanner.measuring.size).toBe(0);
    });

    test('switching the token mid-measure does not race a second overlapping loop', async () => {
        // Regression: measure() used to start a fresh loop on every call, so a
        // token switch while the previous token's items were still being
        // measured let two loops run at once — defeating the "one at a time"
        // guard against bursting the pooled-history host, since the two loops
        // each kept their own pace.
        const calls = [];
        let resolveFirst;
        const spy = vi.spyOn(dungeonShopPlanner, 'measureOnce').mockImplementation((tokenHrid) => {
            calls.push(tokenHrid);
            if (calls.length === 1) return new Promise((resolve) => (resolveFirst = resolve));
            return Promise.resolve();
        });

        const first = dungeonShopPlanner.measure('/items/pirate_token');
        const second = dungeonShopPlanner.measure('/items/chimerical_token');

        // The switch is only recorded — it must not start a second pass while
        // the pirate-token pass is still out.
        expect(calls).toEqual(['/items/pirate_token']);

        resolveFirst();
        await Promise.all([first, second]);

        // Once the one loop is free, it picks up the latest target itself
        expect(calls).toEqual(['/items/pirate_token', '/items/chimerical_token']);
        spy.mockRestore();
    });

    test('an item with no volume answer is asked again on the next open', async () => {
        const fang = state.volumes['/items/kraken_fang'];
        delete state.volumes['/items/kraken_fang'];
        await dungeonShopPlanner.measure('/items/pirate_token');
        expect(dungeonShopPlanner.volumes.has('/items/kraken_fang')).toBe(false);

        // The history host answers this time
        state.volumes['/items/kraken_fang'] = fang;
        await dungeonShopPlanner.measure('/items/pirate_token');
        expect(dungeonShopPlanner.volumes.get('/items/kraken_fang')?.known).toBe(true);
    });

    test('an unmeasured item is capped at 0 until it is included, then flagged', async () => {
        delete state.volumes['/items/kraken_fang'];
        await openPirate();
        expect(qtyOf('/items/kraken_fang')).toBe('—');
        expect(rowFor('/items/kraken_fang').cells[5].textContent).toBe('no volume data');

        const box = body().querySelector('.toolasha-dungeon-plan-unmeasured');
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(qtyOf('/items/kraken_fang')).toBe('2');
        expect(rowFor('/items/kraken_fang').cells[5].textContent).toBe('unmeasured, uncapped');
    });
});

describe('a plan row click', () => {
    test("opens the Dungeon tab, filters to the item and fills the shop dialog's quantity — never Buy", async () => {
        await openPirate();
        rowFor('/items/marksman_brooch').click();
        await flush();
        expect(state.filtered).toEqual(['Marksman Brooch']);
        expect(body().textContent).toContain('Press Buy yourself');

        const { modal, input, buy } = shopDialog('marksman_brooch');
        const clicked = vi.fn();
        buy.addEventListener('click', clicked);
        announceModal(modal);

        expect(input.value).toBe('2');
        expect(clicked).not.toHaveBeenCalled();
    });

    test('a dialog for another item is left alone', async () => {
        await openPirate();
        rowFor('/items/marksman_brooch').click();
        await flush();

        const { modal, input } = shopDialog('kraken_fang');
        announceModal(modal);
        expect(input.value).toBe('1');
    });

    test('a character switch during the shop wait does not arm the next character', async () => {
        await openPirate();
        rowFor('/items/marksman_brooch').click();
        // The feature is torn down and brought back before the shop wait resolves
        dungeonShopPlanner.cleanup();
        dungeonShopPlanner.initialize();
        await flush();

        expect(state.filtered).toEqual([]);
        const { modal, input } = shopDialog('marksman_brooch');
        announceModal(modal);
        expect(input.value).toBe('1');
    });

    test('when the shop cannot be reached the panel says what to type', async () => {
        state.shopTab = null;
        await openPirate();
        rowFor('/items/pirate_essence').click();
        await flush();
        expect(body().textContent).toContain('type 500 in the quantity box');
        expect(state.filtered).toEqual([]);
    });
});

describe('the Plan spend button', () => {
    test('cleanup removes the tab strip listener it added', () => {
        document.body.innerHTML = `
            <div class="ShopPanel_shopPanel__q">
                <div class="MuiTabs-root"><div class="MuiTabs-flexContainer" role="tablist">
                    <button role="tab" aria-selected="true">Dungeon</button>
                </div></div>
            </div>`;
        const strip = document.querySelector('[role="tablist"]');
        const removed = vi.spyOn(strip, 'removeEventListener');
        dungeonShopPlanner.scanShopTabs();

        dungeonShopPlanner.cleanup();

        expect(removed).toHaveBeenCalledWith('click', expect.any(Function));
        dungeonShopPlanner.initialize();
    });

    test("appears beside the Shop's tab strip only while Dungeon is selected", () => {
        document.body.innerHTML = `
            <div class="ShopPanel_shopPanel__q">
                <div class="MuiTabs-root"><div class="MuiTabs-flexContainer" role="tablist">
                    <button role="tab" aria-selected="false">Market</button>
                    <button role="tab" aria-selected="true">Dungeon</button>
                </div></div>
            </div>
            <div class="Combat_panel__z">
                <div class="MuiTabs-root"><div class="MuiTabs-flexContainer" role="tablist">
                    <button role="tab" aria-selected="true">Dungeon</button>
                </div></div>
            </div>`;
        dungeonShopPlanner.scanShopTabs();
        const buttons = document.querySelectorAll('.toolasha-dungeon-plan-spend');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].closest('.ShopPanel_shopPanel__q')).not.toBeNull();
        expect(buttons[0].style.display).toBe('');

        const [market, dungeon] = document.querySelectorAll('.ShopPanel_shopPanel__q [role="tab"]');
        market.setAttribute('aria-selected', 'true');
        dungeon.setAttribute('aria-selected', 'false');
        dungeonShopPlanner.scanShopTabs();
        expect(document.querySelectorAll('.toolasha-dungeon-plan-spend')).toHaveLength(1);
        expect(buttons[0].style.display).toBe('none');
    });
});
