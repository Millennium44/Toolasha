/**
 * @vitest-environment happy-dom
 *
 * Auto-click-max clicks the *quantity* Max/All, never the price row's Max.
 *
 * The 8/13/2026 marketplace layout put a "Max" button on the price row (jump to
 * the top of the tradable range) ahead of the quantity row's "All"/"Max". A
 * blind first-match search clicked price-Max — slamming the price to the ceiling
 * and leaving the quantity at one. These tests pin the modal to that real layout
 * and assert the right button is the one that gets clicked.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: (_k, d) => d } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

const autoClickMax = (await import('./auto-click-max.js')).default;

/**
 * A Sell modal in the 8/13 layout: a price row whose own Max sits before the
 * quantity row. `quantityLabel` is "All" on a Sell Now, "Max" on a Sell Listing.
 *
 * @param {string} quantityLabel - The quantity button's text
 * @returns {{modal: HTMLElement, clicks: string[]}}
 */
function sellModal(quantityLabel) {
    const modal = document.createElement('div');
    modal.className = 'Modal_modalContainer__3B80m';
    modal.innerHTML = `
        <div class="MarketplacePanel_header__yahJo">Sell Now</div>
        <div class="MarketplacePanel_inputContainer__3xmB2">
            <div class="MarketplacePanel_priceInputs__3iWxy">
                <div class="MarketplacePanel_buttonContainer__vJQud"><button>Min</button></div>
                <div class="MarketplacePanel_buttonContainer__vJQud"><button>-</button></div>
                <div class="MarketplacePanel_input__3h1Yt"><div class="MarketplacePanel_priceDisplay__2xVax">994,000</div></div>
                <div class="MarketplacePanel_buttonContainer__vJQud"><button>+</button></div>
                <div class="MarketplacePanel_buttonContainer__vJQud"><button data-role="price-max">Max</button></div>
            </div>
        </div>
        <div class="MarketplacePanel_inputContainer__3xmB2">
            <div class="MarketplacePanel_quantityInputs__1C3xk">
                <div class="MarketplacePanel_buttonContainer__vJQud"><button>÷2</button></div>
                <div class="MarketplacePanel_buttonContainer__vJQud"><button>1</button></div>
                <div class="MarketplacePanel_input__3h1Yt"><input type="text" value="1"></div>
                <div class="MarketplacePanel_buttonContainer__vJQud"><button data-role="qty-max">${quantityLabel}</button></div>
                <div class="MarketplacePanel_buttonContainer__vJQud"><button>×2</button></div>
            </div>
        </div>`;

    const clicks = [];
    for (const btn of modal.querySelectorAll('button')) {
        btn.addEventListener('click', () => clicks.push(btn.dataset.role || btn.textContent.trim()));
    }
    return { modal, clicks };
}

beforeEach(() => {
    autoClickMax.isActive = true;
    autoClickMax.processedModals = new WeakSet();
});

describe('auto-click-max targets the quantity, not the price', () => {
    test('a Sell Now clicks quantity All, never price Max', () => {
        const { modal, clicks } = sellModal('All');
        autoClickMax.findAndClickMaxButton(modal);
        expect(clicks).toEqual(['qty-max']);
        expect(clicks).not.toContain('price-max');
    });

    test('a Sell Listing clicks the quantity Max, not the price Max', () => {
        // Both rows carry a "Max"; the quantity one must win
        const { modal, clicks } = sellModal('Max');
        autoClickMax.findAndClickMaxButton(modal);
        expect(clicks).toEqual(['qty-max']);
    });

    test('a disabled quantity button is left alone', () => {
        const { modal, clicks } = sellModal('All');
        modal.querySelector('[data-role="qty-max"]').disabled = true;
        autoClickMax.findAndClickMaxButton(modal);
        expect(clicks).toEqual([]);
    });
});

describe('the one-shot is spent on work done, not on a modal being seen', () => {
    test('a fire before the quantity row exists does not burn the one chance', () => {
        // The observer can fire on a modal React has committed the shell of but
        // not the controls. Marking it processed then meant the later fire that
        // would have worked was refused, and the quantity stayed at one.
        const { modal, clicks } = sellModal('All');
        const quantityRow = modal.querySelector('[class*="MarketplacePanel_quantityInputs"]');
        quantityRow.remove();

        autoClickMax.handleOrderModal(modal);
        expect(clicks).toEqual([]);
        expect(autoClickMax.processedModals.has(modal)).toBe(false);

        // React finishes committing, the observer fires again
        modal.appendChild(quantityRow);
        autoClickMax.handleOrderModal(modal);
        expect(clicks).toEqual(['qty-max']);
    });

    test('and once it has worked it does not work twice', () => {
        const { modal, clicks } = sellModal('All');

        autoClickMax.handleOrderModal(modal);
        autoClickMax.handleOrderModal(modal);

        expect(clicks).toEqual(['qty-max']);
    });
});
