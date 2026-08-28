/**
 * @vitest-environment happy-dom
 *
 * The 8/13/2026 update made marketplace quantity/price fields typable text
 * inputs instead of number inputs, which means their displayed value can carry
 * a thousands separator (e.g. "45,000,000"). A few spots in this file read
 * those fields with raw `parseInt`, which stops at the first comma — silently
 * truncating a value to a tiny fraction of what was typed or displayed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { characterItems: [] } }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));

const settingsMock = vi.hoisted(() => ({ market_quickInputButtons: true, market_multiplierButtons: true }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settingsMock[key] ?? false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => {},
    },
}));

const { default: marketplaceShortcuts } = await import('./marketplace-shortcuts.js');

beforeEach(() => {
    document.body.innerHTML = '';
    marketplaceShortcuts.addMode = false;
    marketplaceShortcuts.pendingQuantity = null;
});

describe('executeAction reads the submenu quantity as a comma-formatted number', () => {
    test('a thousands-separated amount is not truncated at the comma', async () => {
        vi.useFakeTimers();
        try {
            document.body.innerHTML = `<div class="Item_amountInputContainer"><input value="12,000" /></div>`;

            // executeAction goes on to navigate + poll the marketplace DOM for a
            // listing button that never appears here; only the quantity capture
            // (synchronous, before any of that) matters for this regression.
            const p = marketplaceShortcuts.executeAction('sell-listing', '/items/whatever', 0);
            expect(marketplaceShortcuts.pendingQuantity).toBe(12000);

            const settled = p.catch(() => {});
            await vi.runAllTimersAsync();
            await settled;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('quick-input preset buttons read the quantity field as a comma-formatted number', () => {
    test('accumulating a preset onto a comma-formatted quantity adds to the real value', () => {
        vi.useFakeTimers();
        try {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="MarketplacePanel_header__x">Buy Listing</div>
                <div class="outer">
                    <div class="wrapper">
                        <div class="MarketplacePanel_quantityInputs__x"><input value="5,000" /></div>
                    </div>
                </div>`;
            document.body.appendChild(modal);

            marketplaceShortcuts.addMode = true;
            marketplaceShortcuts.injectQuickInputButtons(modal);
            vi.advanceTimersByTime(150);

            const quantityInput = modal.querySelector('input');
            const presetButton = Array.from(modal.querySelectorAll('.mwi-quick-input-btn')).find(
                (btn) => btn.textContent === '1,000'
            );
            expect(presetButton).toBeTruthy();
            presetButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

            // Without the fix: parseInt("5,000") === 5, so this would read "1,005"
            expect(quantityInput.value).toBe('6000');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the ÷2 / ×2 multiplier buttons read price and quantity as comma-formatted numbers', () => {
    const priceModal = () => {
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div class="MarketplacePanel_header__x">Sell Listing</div>
            <div class="MarketplacePanel_priceInputs__x">
                <input value="45,000,000" />
                <div class="MarketplacePanel_buttonContainer__a"><button class="btn">1</button></div>
                <div class="MarketplacePanel_buttonContainer__b"><button class="btn">Max</button></div>
            </div>`;
        document.body.appendChild(modal);
        return modal;
    };

    test('÷2 halves a large comma-formatted price instead of collapsing it to near-zero', () => {
        vi.useFakeTimers();
        try {
            const modal = priceModal();
            marketplaceShortcuts.injectMultiplierButtons(modal);
            vi.advanceTimersByTime(100);

            const divideBtn = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent === '÷2');
            expect(divideBtn).toBeTruthy();
            divideBtn.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

            const input = modal.querySelector('input');
            // Without the fix: parseInt("45,000,000") === 45, floor(45/2) === 22
            expect(input.value).toBe('22500000');
        } finally {
            vi.useRealTimers();
        }
    });

    test('×2 doubles a large comma-formatted price instead of doubling a truncated one', () => {
        vi.useFakeTimers();
        try {
            const modal = priceModal();
            marketplaceShortcuts.injectMultiplierButtons(modal);
            vi.advanceTimersByTime(100);

            const multiplyBtn = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent === '×2');
            expect(multiplyBtn).toBeTruthy();
            multiplyBtn.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

            const input = modal.querySelector('input');
            // Without the fix: parseInt("45,000,000") === 45, 45 * 2 === 90
            expect(input.value).toBe('90000000');
        } finally {
            vi.useRealTimers();
        }
    });
});
