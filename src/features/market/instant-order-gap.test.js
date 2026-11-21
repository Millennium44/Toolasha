// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { market_instantOrderGap: true },
    listeners: {},
    modalItem: '/items/x',
}));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_WARNING: '#ffa500', getSetting: (key) => mocks.settings[key] },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            (mocks.listeners[event] ||= new Set()).add(handler);
        },
        off: (event, handler) => mocks.listeners[event]?.delete(handler),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    findQuantityInput: (modal) => modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input'),
    modalItemHrid: () => mocks.modalItem,
}));

const { default: instantOrderGap, countPriceSteps, measureGap, gapText } = await import('./instant-order-gap.js');

const deliver = (itemHrid, ask, bid, extra = {}) => {
    for (const handler of mocks.listeners.market_item_order_books_updated || []) {
        handler({
            marketItemOrderBooks: {
                itemHrid,
                orderBooks: { 0: { asks: [{ price: ask }], bids: [{ price: bid }] }, ...extra },
            },
        });
    }
};

const open = (title = 'Sell Now', { enhancement = null } = {}) => {
    document.body.innerHTML = `<div class="modal"><div class="MarketplacePanel_header__x">${title}</div>
        ${enhancement === null ? '' : `<div><span>Enhancement Level</span><input value="${enhancement}" /></div>`}
        <div class="MarketplacePanel_quantityInputs__x"><input value="" /></div></div>`;
    return document.querySelector('.modal');
};
const line = (modal) => modal.querySelector('.mwi-instant-order-gap');

describe('counting steps', () => {
    test('adjacent prices are one step, further apart is more, equal is none', () => {
        expect(countPriceSteps(1000, 1004)).toBe(1);
        expect(countPriceSteps(1000, 1012)).toBe(3);
        expect(countPriceSteps(1000, 1000)).toBe(0);
    });

    test('an enhanced item steps five times wider', () => {
        expect(countPriceSteps(50000, 51000, 3)).toBe(1);
        expect(countPriceSteps(50000, 51000, 0)).toBe(5);
    });

    test('a huge gap stops counting at the cap', () => {
        expect(countPriceSteps(1, 1e9)).toBe(999);
    });
});

describe('measureGap', () => {
    test('best ask against best bid, null when a side is empty or they cross', () => {
        expect(measureGap({ asks: [{ price: 1012 }], bids: [{ price: 1000 }] }, 0)).toEqual({
            ask: 1012,
            bid: 1000,
            steps: 3,
        });
        expect(measureGap({ asks: [], bids: [{ price: 1000 }] }, 0)).toBeNull();
        expect(measureGap({ asks: [{ price: 900 }], bids: [{ price: 1000 }] }, 0)).toBeNull();
        expect(measureGap(undefined, 0)).toBeNull();
    });
});

describe('gapText', () => {
    test('names the steps, the per-item cost, and the total once more than one is wanted', () => {
        expect(gapText('sell', { steps: 3, each: 12 }, 0)).toBe(
            'Sell Now pays 3 price steps below the best sell offer (12 less per item)'
        );
        expect(gapText('buy', { steps: 3, each: 12 }, 10)).toBe(
            'Buy Now costs 3 price steps above the best buy offer (12 more per item), 120 for 10'
        );
    });
});

describe('InstantOrderGap', () => {
    beforeEach(() => {
        mocks.settings.market_instantOrderGap = true;
        mocks.modalItem = '/items/x';
        mocks.listeners = {};
        instantOrderGap.initialize();
    });
    afterEach(() => {
        instantOrderGap.cleanup();
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    const show = (modal) => {
        instantOrderGap.handleModal(modal);
        instantOrderGap.refresh(modal);
    };

    test('says so when the two best offers are more than one step apart, in the right wording per side', () => {
        deliver('/items/x', 1012, 1000);
        let modal = open('Sell Now');
        show(modal);
        expect(line(modal).textContent).toContain('Sell Now pays 3 price steps');

        modal = open('Buy Now');
        show(modal);
        expect(line(modal).textContent).toContain('Buy Now costs 3 price steps');
    });

    test('the line wraps inside the dialog instead of widening it, and sits before the quantity row', () => {
        deliver('/items/x', 1012, 1000);
        const modal = open();
        show(modal);
        const { width, minWidth, whiteSpace } = line(modal).style;
        expect([width, minWidth, whiteSpace]).toEqual(['0px', '100%', 'normal']);
        expect(line(modal).nextElementSibling.className).toContain('MarketplacePanel_quantityInputs');
    });

    test('adds the total for the quantity typed, and follows it', () => {
        deliver('/items/x', 1012, 1000);
        const modal = open();
        show(modal);
        const input = modal.querySelector('[class*="quantityInputs"] input');
        input.value = '10';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(line(modal).textContent).toContain('120 for 10');
    });

    test('uses the book of the enhancement level the dialog is set to', () => {
        deliver('/items/x', 1004, 1000, { 5: { asks: [{ price: 51000 }], bids: [{ price: 50000 }] } });
        const modal = open('Sell Now', { enhancement: 0 });
        show(modal);
        expect(line(modal)).toBeNull();

        // +5: 50,000 to 51,000 is one step for an enhanced item, so still silent
        const enhanced = open('Sell Now', { enhancement: 5 });
        show(enhanced);
        expect(line(enhanced)).toBeNull();

        deliver('/items/x', 1004, 1000, { 5: { asks: [{ price: 53000 }], bids: [{ price: 50000 }] } });
        const wider = open('Sell Now', { enhancement: 5 });
        show(wider);
        expect(line(wider).textContent).toContain('3 price steps');
    });

    test('stays silent for adjacent prices, a listing dialog, another item, a missing or old book, or the setting off', () => {
        deliver('/items/x', 1004, 1000);
        let modal = open();
        show(modal);
        expect(line(modal)).toBeNull();

        deliver('/items/x', 1012, 1000);
        modal = open('Sell Listing');
        show(modal);
        expect(line(modal)).toBeNull();

        mocks.modalItem = '/items/other';
        modal = open();
        show(modal);
        expect(line(modal)).toBeNull();

        mocks.modalItem = '/items/x';
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 10 * 60 * 1000);
        modal = open();
        show(modal);
        expect(line(modal)).toBeNull();
        vi.useRealTimers();

        instantOrderGap.cleanup();
        mocks.settings.market_instantOrderGap = false;
        instantOrderGap.initialize();
        expect(instantOrderGap.isInitialized).toBe(false);
    });

    test('a book that arrives after the dialog opens draws the line, and a tighter one removes it', () => {
        const modal = open();
        show(modal);
        expect(line(modal)).toBeNull();

        deliver('/items/x', 1012, 1000);
        expect(line(modal)).not.toBeNull();

        deliver('/items/x', 1004, 1000);
        expect(line(modal)).toBeNull();
    });

    test('disable removes the line and every listener, and a re-enable starts clean', () => {
        deliver('/items/x', 1012, 1000);
        const modal = open();
        show(modal);
        expect(line(modal)).not.toBeNull();

        instantOrderGap.disable();
        expect(line(modal)).toBeNull();
        expect(mocks.listeners.market_item_order_books_updated.size).toBe(0);

        instantOrderGap.initialize();
        const fresh = open();
        show(fresh);
        // The old book was dropped with the feature; nothing is shown until a book arrives
        expect(line(fresh)).toBeNull();
    });
});
