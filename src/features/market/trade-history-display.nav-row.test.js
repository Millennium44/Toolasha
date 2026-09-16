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

const tradeHistoryDisplay = (await import('./trade-history-display.js')).default;

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
});
