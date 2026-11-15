/** @vitest-environment happy-dom
 *
 * The Buy-all walk's Buy button: the primary slot alternates Next and Buy, the Bulk Sell Assistant's
 * Next/Confirm in reverse. Buy presses the game's own confirm for a press of the player's, only while
 * the open form is a buy form for exactly the item and quantity the step queued, and only once per step.
 *
 * Modal fixtures follow the Bulk Sell tests: the game's header, a quantity row, an icon, a confirm
 * button with no `Button_buy` class (the label is all it has), and a close button.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));
const game = vi.hoisted(() => ({ items: {}, prices: {}, mode: 'standard' }));
const settings = vi.hoisted(() => ({ values: {}, listeners: {} }));
const bus = vi.hoisted(() => ({ characterId: 'char1', handlers: {} }));
const notices = vi.hoisted(() => ({ handlers: [] }));

vi.mock('../../utils/background-work.js', () => ({ runInBackground: async (_name, work) => work() }));
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings.values[key] ?? true,
        getSettingValue: (key, fallback) =>
            settings.values[key] ?? (String(key).startsWith('market_') ? fallback : 'compact'),
        setSetting: () => {},
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, _name, fallback = null) => store.data[key] ?? fallback,
        set: async (key, value) => {
            store.data[key] = value;
            return true;
        },
        delete: async () => true,
        getAllKeys: async () => Object.keys(store.data),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] || null,
        getActionDetails: () => null,
        getInventory: () => [],
        getEquipment: () => new Map(),
        getInitClientData: () => null,
        getCurrentActions: () => [],
        characterData: null,
        getSkills: () => [],
        getCurrentCharacterId: () => bus.characterId,
        getCurrentCharacterGameMode: () => game.mode,
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: () => {},
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {} }),
}));
vi.mock('../../utils/order-book.js', () => ({ estimateFillSeconds: () => null }));
vi.mock('./consumables-shopping-list.js', () => ({ openShoppingList: () => {} }));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({ default: { getLatestData: () => null } }));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: () => ({}),
}));
vi.mock('../../utils/server-notices.js', () => ({
    SALE_REFUSAL_KEYS: ['errorNotification.orderNotFulfilled', 'errorNotification.requestSpamProtection'],
    onServerNotice: (handler) => {
        notices.handlers.push(handler);
        return () => {
            notices.handlers = notices.handlers.filter((h) => h !== handler);
        };
    },
}));

const { consumablesPanel } = await import('./consumables-panel.js');
const { _resetCaches } = await import('../../utils/panel-geometry.js');
const { default: dataManager } = await import('../../core/data-manager.js');

const PEACH = '/items/peach_gummy';
const STAR = '/items/star_fruit_gummy';
const shortfall = [
    { itemHrid: PEACH, count: 5 },
    { itemHrid: STAR, count: 3 },
];

let gameClicks = 0;
let closeClicks = 0;
let shortcuts;

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const widget = () => document.getElementById('toolasha-lab-buy-next');
const mainEl = () => document.querySelector('.toolasha-lab-buy-next-main');
const mainLabel = () => mainEl()?.textContent || '';
const inlineBtn = () => document.querySelector('.toolasha-consumables-inline-next');
const toasts = () => document.body.textContent;

/** A buy modal as the game draws it */
const openModal = ({
    item = 'peach_gummy',
    qty = 5,
    header = 'Buy Now',
    label = 'Buy Now',
    disabled = false,
    enhancement = null,
} = {}) => {
    const modal = document.createElement('div');
    modal.className = 'Modal_modalContainer__abc';
    modal.innerHTML =
        `<div class="MarketplacePanel_header__x">${header}</div>` +
        `<div><svg><use href="/static/media/items.svg#${item}"></use></svg></div>` +
        (enhancement === null
            ? ''
            : `<div><div>Enhancement Level</div><div><input value="${enhancement}"></div></div>`) +
        `<div class="MarketplacePanel_quantityInputs__y"><input value="${qty}"></div>` +
        `<button class="Button_button__1Fe9z"${disabled ? ' disabled' : ''}>${label}</button>` +
        '<button class="Modal_closeButton__z">x</button>';
    modal.querySelector('.Button_button__1Fe9z').addEventListener('click', () => gameClicks++);
    modal.querySelector('.Modal_closeButton__z').addEventListener('click', () => {
        closeClicks++;
        modal.remove();
    });
    document.body.appendChild(modal);
    return modal;
};
const confirmButton = () => document.querySelector('.Modal_modalContainer__abc .Button_button__1Fe9z');

/** Start the walk from the inline row, then let the form open and be seen */
const startWalk = async ({ queue = shortfall, modal = {} } = {}) => {
    consumablesPanel.show();
    await tick();
    consumablesPanel._registerBuyQueue('Combat', queue);
    consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
    inlineBtn().click();
    await tick(400);
    if (modal) openModal(modal);
    // The form is seen, then the Buy button is held off for its arm delay
    await tick(200);
    await tick(600);
};

beforeEach(async () => {
    vi.useFakeTimers();
    store.data = {};
    settings.values = {};
    game.mode = 'standard';
    game.items = { [PEACH]: { name: 'Peach Gummy' }, [STAR]: { name: 'Star Fruit Gummy' } };
    game.prices = { [PEACH]: { ask: 100, bid: 99 }, [STAR]: { bid: 50 } };
    gameClicks = 0;
    closeClicks = 0;
    notices.handlers = [];
    bus.characterId = 'char1';
    shortcuts = {
        clickInstantActionButton: vi.fn(() => Promise.resolve()),
        clickListingButton: vi.fn(() => Promise.resolve()),
    };
    window.Toolasha = { Market: { marketplaceShortcuts: shortcuts } };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    consumablesPanel._tab = null;
    consumablesPanel._buyQueues = [];
    consumablesPanel._dropBuyWalk();
    consumablesPanel._buyWidgetHidden = false;
    consumablesPanel._buySettingsOpen = false;
    consumablesPanel.hide({ remember: false });
    _resetCaches();
});

afterEach(() => {
    consumablesPanel._dropBuyWalk();
    consumablesPanel.hide({ remember: false });
    document.body.innerHTML = '';
    delete window.Toolasha;
    vi.useRealTimers();
});

describe('the walk button alternates Next and Buy', () => {
    test('opening, then Buy, then one confirm press, then Next when the form closes', async () => {
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        // The form is being opened: nothing to press yet
        expect(mainLabel()).toBe('Opening Peach Gummy…');
        expect(mainEl().disabled).toBe(true);
        await tick(400);
        expect(shortcuts.clickInstantActionButton).toHaveBeenCalledWith('Buy', 3000, expect.any(Function));
        // Opened by the shortcut but the modal is not in the DOM yet: still no Buy
        expect(mainLabel()).toBe('Opening Peach Gummy…');

        openModal();
        await tick(200);
        expect(mainLabel()).toBe('Buy Peach Gummy ×5');
        // Armed only after a moment: an impatient second Next press must not buy
        expect(mainEl().disabled).toBe(true);
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        await tick(520);
        expect(mainEl().disabled).toBe(false);
        expect(gameClicks).toBe(0);

        mainEl().click();
        // Pressed after the click handler returned, once
        expect(gameClicks).toBe(0);
        await tick();
        expect(gameClicks).toBe(1);
        expect(mainEl().disabled).toBe(true);
        expect(mainLabel()).toBe('Sent…');

        // The modal closing is the one thing that advances the walk
        document.querySelector('.Modal_modalContainer__abc').remove();
        await tick(200);
        expect(consumablesPanel._buyStep).toBe(null);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
        expect(mainEl().disabled).toBe(false);
        expect(gameClicks).toBe(1);
    });

    test('a patient order words itself as posting an order and opens New Buy Listing', async () => {
        await startWalk({
            queue: [shortfall[1], shortfall[0]],
            modal: { item: 'star_fruit_gummy', qty: 3, header: 'Buy Listing', label: 'Post Buy Order' },
        });
        expect(shortcuts.clickListingButton).toHaveBeenCalledWith(
            '+ New Buy Listing',
            'Button_buy',
            3000,
            expect.any(Function)
        );
        expect(mainLabel()).toBe('Post buy order Star Fruit Gummy ×3');
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(1);
        expect(mainLabel()).toBe('Order sent…');
    });
});

describe('Buy never buys without the player, or the wrong thing', () => {
    test('a double press is one confirm', async () => {
        await startWalk();
        mainEl().click();
        mainEl().click();
        await tick();
        mainEl().click();
        await tick(200);
        expect(gameClicks).toBe(1);
    });

    test('the player pressing the game confirm first leaves nothing for ours to press', async () => {
        await startWalk();
        confirmButton().click();
        expect(gameClicks).toBe(1);
        expect(mainLabel()).toBe('Sent…');
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(1);
    });

    test('a quantity the player edited is refused with the numbers, then pressed once corrected', async () => {
        await startWalk();
        const input = document.querySelector('.MarketplacePanel_quantityInputs__y input');
        input.value = '9';
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        expect(toasts()).toContain('the modal says 9, not the queued 5');
        expect(mainLabel()).toBe('Buy Peach Gummy ×5');
        expect(mainEl().title).toContain('Can’t confirm: the modal says 9, not the queued 5');
        input.value = '5';
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(1);
    });

    test('a form for another item is never pressed, and the walk says the form did not open', async () => {
        await startWalk({ modal: { item: 'star_fruit_gummy' } });
        expect(mainLabel()).toBe('Opening Peach Gummy…');
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        await tick(9000);
        expect(gameClicks).toBe(0);
        expect(toasts()).toContain('The buy form for Peach Gummy did not open.');
        expect(consumablesPanel._buyStep).toBe(null);
    });

    test('a sell form of the same item is not a buy form', async () => {
        await startWalk({ modal: { header: 'Sell Now', label: 'Post Sell Order' } });
        expect(mainLabel()).toBe('Opening Peach Gummy…');
        await tick(9000);
        expect(gameClicks).toBe(0);
    });

    test('an enhanced form is not this step', async () => {
        await startWalk({ modal: { enhancement: 3 } });
        expect(mainLabel()).toBe('Opening Peach Gummy…');
        expect(gameClicks).toBe(0);
    });

    test('a disabled game confirm is not pressed and the reason is given', async () => {
        await startWalk({ modal: { disabled: true } });
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        expect(toasts()).toContain('the game’s confirm is disabled');
        expect(mainLabel()).toBe('Buy Peach Gummy ×5');
    });

    test('a form with no confirm button found is not pressed', async () => {
        await startWalk({ modal: { label: 'Zzz' } });
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        expect(toasts()).toContain('confirm button was not found');
    });

    test('a refusal from the server ends the Buy state, never re-arms it, and says to check', async () => {
        await startWalk();
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(1);
        for (const handler of notices.handlers) handler({ level: 'error', key: 'errorNotification.orderNotFulfilled' });
        expect(toasts()).toContain('Check My Listings and your inventory');
        expect(consumablesPanel._buyStep).toBe(null);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
        await tick(1000);
        expect(gameClicks).toBe(1);
    });

    test('Enter inside the matching form counts as the purchase, so ours presses nothing', async () => {
        await startWalk();
        const input = document.querySelector('.MarketplacePanel_quantityInputs__y input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(mainLabel()).toBe('Sent…');
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
    });

    test('the setting turned off after the step began refuses the press', async () => {
        await startWalk();
        settings.values.market_consumableBuyOpenRecommended = false;
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        expect(toasts()).toContain('setting is off');
    });

    test('a cancelled walk, its failed open does not toast', async () => {
        shortcuts.clickInstantActionButton = vi.fn(() => Promise.reject(new Error('Timeout waiting')));
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        document.querySelector('.toolasha-lab-buy-next-close').click();
        await tick(500);
        expect(toasts()).not.toContain('Could not open');
    });

    test('the live New Buy Listing modal: exactly its Post Buy Listing confirm is pressed, once', async () => {
        consumablesPanel._startBuyAll([shortfall[1], shortfall[0]]);
        await tick(400);
        const modal = document.createElement('div');
        modal.className = 'Modal_modalContainer__live';
        modal.innerHTML =
            '<div class="MarketplacePanel_header__x">Buy Listing</div>' +
            '<div><svg><use href="/static/media/items.svg#star_fruit_gummy"></use></svg></div>' +
            '<div class="MarketplacePanel_label__a">Tradable range: 98 – 122</div>' +
            '<div class="MarketplacePanel_priceDisplay__b">110</div>' +
            '<div class="MarketplacePanel_quantityInputs__y"><div>Quantity (You Can Afford: 116B</div><input value="3">' +
            ['÷2', 'Min', '-', '+', 'Max', '×2']
                .map((t) => '<button class="Button_button__1 Button_fullWidth__2 Button_small__3">' + t + '</button>')
                .join('') +
            ['10', '100', '1,000'].map((t) => '<button class="mwi-quick-input-btn">' + t + '</button>').join('') +
            '</div>' +
            '<button class="Button_button__1 Button_success__4">Post Buy Listing</button>' +
            '<button class="Modal_closeButton__z">x</button>';
        const presses = [];
        for (const btn of modal.querySelectorAll('button'))
            btn.addEventListener('click', () => presses.push(btn.textContent));
        document.body.appendChild(modal);
        await tick(800);
        expect(mainLabel()).toBe('Post buy order Star Fruit Gummy ×3');
        mainEl().click();
        mainEl().click();
        await tick();
        expect(presses).toEqual(['Post Buy Listing']);
    });

    test('Iron Cow characters get the old walk, with no Buy', async () => {
        game.mode = '/game_modes/ironcow';
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        await tick(400);
        openModal();
        await tick(400);
        expect(consumablesPanel._buyStep).toBe(null);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
        expect(gameClicks).toBe(0);
    });

    test('with the recommended form switched off the walk offers Next, never Buy', async () => {
        settings.values.market_consumableBuyOpenRecommended = false;
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        await tick(400);
        openModal();
        await tick(400);
        expect(shortcuts.clickInstantActionButton).not.toHaveBeenCalled();
        expect(consumablesPanel._buyStep).toBe(null);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
    });
});

describe('every other way a step ends', () => {
    test('closing the form without buying counts the item as done and says so', async () => {
        await startWalk();
        document.querySelector('.Modal_modalContainer__abc').remove();
        await tick(200);
        expect(gameClicks).toBe(0);
        expect(toasts()).toContain('Peach Gummy was closed without buying.');
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
    });

    test('an empty book with no Buy Now falls back to a buy listing form', async () => {
        shortcuts.clickInstantActionButton = vi.fn(() => Promise.reject(new Error('Timeout waiting')));
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        await tick(400);
        expect(shortcuts.clickListingButton).toHaveBeenCalledWith(
            '+ New Buy Listing',
            'Button_buy',
            3000,
            expect.any(Function)
        );
        expect(toasts()).not.toContain('Could not open');
        expect(gameClicks).toBe(0);
    });

    test('a form that never opens leaves Next, not a Buy with nothing behind it', async () => {
        shortcuts.clickInstantActionButton = vi.fn(() => Promise.reject(new Error('Timeout waiting')));
        shortcuts.clickListingButton = vi.fn(() => Promise.reject(new Error('Timeout waiting')));
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        await tick(400);
        expect(toasts()).toContain('Could not open Buy Now or a buy listing for Peach Gummy');
        expect(consumablesPanel._buyStep).toBe(null);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
        expect(mainEl().disabled).toBe(false);
    });

    test('Skip closes the form and goes back to Next without pressing anything', async () => {
        await startWalk();
        document.querySelector('.toolasha-lab-buy-next-skip').click();
        expect(closeClicks).toBe(1);
        expect(gameClicks).toBe(0);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
    });

    test('after Buy is sent, Skip still moves on (a press that never landed cannot strand the walk)', async () => {
        await startWalk();
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(1);
        expect(consumablesPanel._buyStep?.phase).toBe('sent');
        const skip = document.querySelector('.toolasha-lab-buy-next-skip');
        expect(skip.style.display).toBe('');
        skip.click();
        expect(consumablesPanel._buyStep).toBe(null);
        expect(closeClicks).toBe(0);
        expect(gameClicks).toBe(1);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
        expect(consumablesPanel._buyNote).toContain('check My Listings');
    });

    test('a search still polling for its button stops once the step is skipped', async () => {
        let cancelled = null;
        shortcuts.clickInstantActionButton = vi.fn((_text, _timeout, isCancelled) => {
            cancelled = isCancelled;
            return new Promise(() => {});
        });
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        await tick(400);
        expect(cancelled()).toBe(false);
        document.querySelector('.toolasha-lab-buy-next-close').click();
        expect(cancelled()).toBe(true);
    });

    test('a search still polling for its button stops when the character changes', async () => {
        let cancelled = null;
        shortcuts.clickInstantActionButton = vi.fn((_text, _timeout, isCancelled) => {
            cancelled = isCancelled;
            return new Promise(() => {});
        });
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        await tick(400);
        expect(cancelled()).toBe(false);
        bus.characterId = 'char2';
        expect(cancelled()).toBe(true);
    });

    test('cancelling mid-step stops the walk and nothing is pressed afterwards', async () => {
        await startWalk();
        document.querySelector('.toolasha-lab-buy-next-close').click();
        expect(widget()).toBe(null);
        expect(consumablesPanel._buyStep).toBe(null);
        expect(consumablesPanel._buyQueue).toEqual([]);
        await tick(1000);
        expect(gameClicks).toBe(0);
    });

    test('a cancel before the form has opened never opens it', async () => {
        consumablesPanel.show();
        await tick();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        inlineBtn().click();
        document.querySelector('.toolasha-lab-buy-next-close').click();
        await tick(400);
        expect(shortcuts.clickInstantActionButton).not.toHaveBeenCalled();
    });

    test('the panel shown mid-step carries the same Buy inline, and hiding it brings the widget back', async () => {
        await startWalk();
        expect(mainLabel()).toBe('Buy Peach Gummy ×5');
        consumablesPanel.show();
        await tick();
        expect(widget()).toBe(null);
        expect(inlineBtn().textContent).toBe('Buy Peach Gummy ×5');
        expect(document.querySelector('.toolasha-consumables-inline-skip')).not.toBe(null);
        inlineBtn().click();
        await tick();
        expect(gameClicks).toBe(1);
        expect(inlineBtn().disabled).toBe(true);
        consumablesPanel.hide({ remember: false });
        expect(mainLabel()).toBe('Sent…');
        document.querySelector('.Modal_modalContainer__abc').remove();
        await tick(200);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
    });

    test('the last item: its form closing ends the walk and removes the control', async () => {
        consumablesPanel._startBuyAll([shortfall[0]]);
        await tick(400);
        openModal();
        await tick(200);
        await tick(600);
        expect(mainLabel()).toBe('Buy Peach Gummy ×5');
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(1);
        document.querySelector('.Modal_modalContainer__abc').remove();
        await tick(200);
        expect(widget()).toBe(null);
        expect(consumablesPanel._buyStep).toBe(null);
        expect(consumablesPanel._buyQueue).toEqual([]);
    });

    test('a character switch mid-walk drops the walk and presses nothing', async () => {
        await startWalk();
        bus.characterId = 'char2';
        dataManager.emit('character_switched');
        await tick();
        expect(consumablesPanel._buyStep).toBe(null);
        expect(consumablesPanel._buyQueue).toEqual([]);
        expect(widget()).toBe(null);
        await tick(1000);
        expect(gameClicks).toBe(0);
    });

    test('a different character with no switch event yet is still not pressed for', async () => {
        await startWalk();
        bus.characterId = 'char2';
        mainEl().click();
        await tick();
        expect(gameClicks).toBe(0);
        expect(consumablesPanel._buyStep).toBe(null);
    });
});
