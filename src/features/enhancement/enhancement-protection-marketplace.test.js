/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    quotes: { '/items/mirror_of_protection': { price: 1000, source: 'book', estimated: false } },
    itemDetails: { name: 'Mirror of Protection' },
    menuCallback: null,
    unregister: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), getSettingValue: vi.fn((_key, fallback) => fallback) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: vi.fn(() => mocks.itemDetails) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _cls, cb) => {
            mocks.menuCallback = cb;
            return mocks.unregister;
        }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: vi.fn((hrid) => mocks.quotes[hrid] ?? { price: null, source: null, estimated: false }),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: vi.fn() }));

import config from '../../core/config.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { EnhancementProtectionMarketplace } from './enhancement-protection-marketplace.js';

// Class names match the game's shapes: the protection slot sits in the enhancing panel, and the
// menu is portalled to the document root (never inside the slot).
function makePanel(itemHrid) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_enhancingComponent__17bOx';
    if (itemHrid) panel.dataset.mwiItemHrid = itemHrid;
    const container = document.createElement('div');
    container.className = 'SkillActionDetail_protectionItemInputContainer__35ChM';
    const inner = document.createElement('div');
    container.appendChild(inner);
    panel.appendChild(container);
    document.body.appendChild(panel);
    return { panel, container, inner };
}

function openMenu() {
    const menu = document.createElement('div');
    menu.className = 'ItemSelector_menu__12sEM';
    document.body.appendChild(menu);
    mocks.menuCallback(menu);
    return menu;
}

describe('EnhancementProtectionMarketplace', () => {
    let feature;

    beforeEach(() => {
        vi.clearAllMocks();
        config.getSetting.mockReturnValue(true);
        mocks.quotes = { '/items/mirror_of_protection': { price: 1000, source: 'book', estimated: false } };
        mocks.itemDetails = { name: 'Mirror of Protection' };
        feature = new EnhancementProtectionMarketplace();
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
    });

    test('a click on the protection slot makes the next menu get a buy-cheapest button', () => {
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        const menu = openMenu();

        expect(getItemPriceInfo).toHaveBeenCalledWith('/items/mirror_of_protection', {
            mode: 'ask',
            side: 'buy',
            marketQuote: true,
        });
        const btn = menu.querySelector('button');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('Mirror of Protection');
        expect(menu.firstChild).toBe(btn);
    });

    test('a menu with no preceding protection click (the Enhance Item picker) gets nothing', () => {
        makePanel('/items/sinister_cape');
        feature.initialize();
        const menu = openMenu();
        expect(menu.querySelector('button')).toBeNull();
    });

    test('a click elsewhere after the protection click cancels it', () => {
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        document.body.click();
        expect(openMenu().querySelector('button')).toBeNull();
    });

    test('the button opens the marketplace on the cheapest option and sends the outside click', () => {
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        const menu = openMenu();
        const outside = vi.fn();
        document.body.addEventListener('mousedown', outside);

        menu.querySelector('button').click();

        expect(navigateToMarketplace).toHaveBeenCalledWith('/items/mirror_of_protection', 0);
        expect(outside).toHaveBeenCalledTimes(1);
    });

    test('no button when the enhancing item cannot be resolved', () => {
        const a = makePanel(null);
        feature.initialize();
        a.inner.click();
        expect(openMenu().querySelector('button')).toBeNull();
    });

    test('no button when nothing is priced', () => {
        mocks.quotes = {};
        const b = makePanel('/items/sinister_cape');
        feature.initialize();
        b.inner.click();
        expect(openMenu().querySelector('button')).toBeNull();
    });

    test('ranks by the lowest live ask and ignores options with no book ask', () => {
        mocks.itemDetails = { name: 'Protection Item', protectionItemHrids: ['/items/cheap_prot', '/items/est_prot'] };
        mocks.quotes = {
            '/items/mirror_of_protection': { price: 5000, source: 'book', estimated: false },
            '/items/cheap_prot': { price: 300, source: 'book', estimated: false },
            // Cheaper still, but a value-map estimate or a production-cost style figure, not an ask
            '/items/est_prot': { price: 10, source: 'value', estimated: true },
            '/items/sinister_cape': { price: 20, source: 'custom', estimated: false },
        };
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        openMenu().querySelector('button').click();
        expect(navigateToMarketplace).toHaveBeenCalledWith('/items/cheap_prot', 0);
    });

    test('no button when every option lacks a live ask', () => {
        mocks.quotes = { '/items/mirror_of_protection': { price: 900, source: 'value', estimated: true } };
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        expect(openMenu().querySelector('button')).toBeNull();
    });

    test('does not add a second button to a menu it already handled', () => {
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        const menu = openMenu();
        mocks.menuCallback(menu);
        expect(menu.querySelectorAll('button')).toHaveLength(1);
    });

    test('does nothing when the setting is off', () => {
        config.getSetting.mockReturnValue(false);
        feature.initialize();
        expect(feature.isInitialized).toBe(false);
    });

    test('disable() unregisters the observer and click listener and removes injected buttons', () => {
        const { inner } = makePanel('/items/sinister_cape');
        feature.initialize();
        inner.click();
        const menu = openMenu();
        feature.disable();

        expect(mocks.unregister).toHaveBeenCalled();
        expect(menu.querySelector('button')).toBeNull();
        inner.click();
        expect(feature.lastProtectionClick).toBeNull();
    });
});
