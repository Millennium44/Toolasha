/**
 * @vitest-environment happy-dom
 *
 * Trade History Display — the "Last: Buy … | Sell …" chip appended to the marketplace's own nav
 * row (`MarketplacePanel_marketNavButtonContainer`).
 *
 * That row also holds the game's own buttons and may carry another script's bar; the chip must
 * hold its own size rather than get squeezed into wrapping when the row is crowded.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { NAV_ROW_WRAP_STYLE_ID, OUR_NAV_ROW_ITEMS } from '../../utils/market-nav-row.js';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: () => 'instant',
        onSettingChange: () => () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {} },
}));

vi.mock('./trade-history.js', () => ({
    default: { getHistory: () => null },
}));

const { default: tradeHistoryDisplay, tradePriceTitle } = await import('./trade-history-display.js');

/** Draw the marketplace nav row the way the game does. */
function drawNavRow() {
    document.body.innerHTML = `
        <div class="MarketplacePanel_marketNavButtonContainer__d">
            <button>Refresh</button>
        </div>
    `;
}

describe('Last: buy/sell chip', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('cannot shrink or wrap in the shared nav row', () => {
        drawNavRow();
        tradeHistoryDisplay.currentOrderBookData = {
            orderBooks: [{ asks: [{ price: 100 }], bids: [{ price: 90 }] }],
        };

        tradeHistoryDisplay.updateDisplay(null, { buy: 90, sell: 100 });

        const chip = document.querySelector('.mwi-trade-history');
        expect(chip).not.toBeNull();
        expect(chip.style.flexShrink).toBe('0');
        expect(chip.style.whiteSpace).toBe('nowrap');
    });

    // On a phone-width marketplace our nowrap items overran the row and squeezed the game's own
    // buttons until their labels were cut off (measured in Firefox, Chromium and WebKit); the row
    // wraps instead. happy-dom does no layout, so this pins the declaration.
    test('lets the row wrap rather than squeeze the game buttons, and stops on disable', () => {
        drawNavRow();
        tradeHistoryDisplay.currentOrderBookData = {
            orderBooks: [{ asks: [{ price: 100 }], bids: [{ price: 90 }] }],
        };

        tradeHistoryDisplay.updateDisplay(null, { buy: 90, sell: 100 });

        // happy-dom cannot parse a relative `:has(> …)`; evaluate the installed rule the way a
        // browser would: the row wraps while it has a direct child that is one of ours.
        const rowWraps = (row) =>
            Boolean(document.getElementById(NAV_ROW_WRAP_STYLE_ID)) &&
            [...row.children].some((child) => OUR_NAV_ROW_ITEMS.some((sel) => child.matches(sel)));
        const row = document.querySelector('.mwi-trade-history').parentElement;
        expect(rowWraps(row)).toBe(true);
        // Nothing written onto the game's own row, so disable has nothing to undo
        expect(row.style.flexWrap).toBe('');

        tradeHistoryDisplay.disable();
        expect(rowWraps(row)).toBe(false);
        expect(row.style.flexWrap).toBe('');
    });

    test('the tooltip says how old each recorded price is', () => {
        const now = 1_800_000_000_000;
        expect(tradePriceTitle('buy', now - 5 * 60_000, now)).toBe('Your last buy price — recorded 5m ago');
        expect(tradePriceTitle('sell', null, now)).toBe('Your last sell price');
    });
});
