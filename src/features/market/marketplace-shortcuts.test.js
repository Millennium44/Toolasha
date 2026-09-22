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

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (_name, callback) => {
            callback();
            return () => {};
        },
    },
}));
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

describe('Marketplace Action dropdown portal', () => {
    function actionMenu() {
        const menu = document.createElement('div');
        menu.className = 'Item_actionMenu__liveHash';
        menu.style.overflow = 'hidden';
        menu.innerHTML = '<button class="Button_button__liveHash">View Marketplace</button>';
        document.body.appendChild(menu);
        return menu;
    }

    test("renders the panel under its toggle in <body>, outside the game's clipped menu", () => {
        const menu = actionMenu();
        const dropdown = marketplaceShortcuts.buildDropdown(menu, '/items/cheese', 0);
        menu.appendChild(dropdown);
        const toggle = dropdown.querySelector('.mwi-marketplace-dropdown-toggle');
        vi.spyOn(toggle, 'getBoundingClientRect').mockReturnValue({ left: 80, bottom: 144, width: 220 });

        toggle.click();

        const panel = dropdown._dropdownPanel;
        expect(panel.parentElement).toBe(document.body);
        expect(menu.contains(panel)).toBe(false);
        expect(panel.style.position).toBe('fixed');
        expect(panel.style.top).toBe('148px');
        expect(panel.style.left).toBe('80px');
        expect(panel.style.width).toBe('220px');
        expect(panel.style.display).toBe('flex');
    });

    test('disable removes the portaled panel as well as its native-menu toggle', () => {
        const menu = actionMenu();
        const dropdown = marketplaceShortcuts.buildDropdown(menu, '/items/cheese', 0);
        menu.appendChild(dropdown);

        marketplaceShortcuts.disable();

        expect(document.querySelector('.mwi-marketplace-dropdown')).toBeNull();
        expect(document.querySelector('.mwi-marketplace-dropdown-panel')).toBeNull();
        marketplaceShortcuts.initialize();
    });

    test('opening a second item menu closes the first portaled panel', () => {
        const firstMenu = actionMenu();
        const first = marketplaceShortcuts.buildDropdown(firstMenu, '/items/cheese', 0);
        firstMenu.appendChild(first);
        const secondMenu = actionMenu();
        const second = marketplaceShortcuts.buildDropdown(secondMenu, '/items/milk', 0);
        secondMenu.appendChild(second);
        first.querySelector('.mwi-marketplace-dropdown-toggle').click();
        second.querySelector('.mwi-marketplace-dropdown-toggle').click();

        expect(first._dropdownPanel.style.display).toBe('none');
        expect(second._dropdownPanel.style.display).toBe('flex');
    });

    test('an outside click closes the open portal and it reopens in one click', () => {
        const menu = actionMenu();
        const dropdown = marketplaceShortcuts.buildDropdown(menu, '/items/cheese', 0);
        menu.appendChild(dropdown);
        const toggle = dropdown.querySelector('.mwi-marketplace-dropdown-toggle');
        toggle.click();
        expect(dropdown._dropdownPanel.style.display).toBe('flex');

        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(dropdown._dropdownPanel.style.display).toBe('none');

        toggle.click();
        expect(dropdown._dropdownPanel.style.display).toBe('flex');
    });

    test('Escape closes the portal and it reopens in one click', () => {
        const menu = actionMenu();
        const dropdown = marketplaceShortcuts.buildDropdown(menu, '/items/cheese', 0);
        menu.appendChild(dropdown);
        const toggle = dropdown.querySelector('.mwi-marketplace-dropdown-toggle');
        toggle.click();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(dropdown._dropdownPanel.style.display).toBe('none');
        toggle.click();
        expect(dropdown._dropdownPanel.style.display).toBe('flex');
    });

    test('watches the document only while a portaled panel is open', async () => {
        marketplaceShortcuts.closeAllDropdowns();
        const menu = actionMenu();
        const dropdown = marketplaceShortcuts.buildDropdown(menu, '/items/cheese', 0);
        menu.appendChild(dropdown);
        const toggle = dropdown.querySelector('.mwi-marketplace-dropdown-toggle');
        expect(marketplaceShortcuts.portalObserver).toBeNull();

        toggle.click();
        expect(marketplaceShortcuts.portalObserver).not.toBeNull();

        toggle.click();
        expect(marketplaceShortcuts.portalObserver).toBeNull();

        toggle.click();
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(marketplaceShortcuts.portalObserver).toBeNull();

        // The game removing an open panel's menu also ends the watch
        toggle.click();
        menu.remove();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(marketplaceShortcuts.portalObserver).toBeNull();
    });

    test("removing the game's item menu removes its portaled panel", async () => {
        const menu = actionMenu();
        const dropdown = marketplaceShortcuts.buildDropdown(menu, '/items/cheese', 0);
        menu.appendChild(dropdown);
        dropdown.querySelector('.mwi-marketplace-dropdown-toggle').click();

        menu.remove();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dropdown._dropdownPanel.isConnected).toBe(false);
    });
});

describe('teardown cancels delayed marketplace work', () => {
    test('a shortcut does not resume into a marketplace click after disable', async () => {
        vi.useFakeTimers();
        const click = vi.spyOn(marketplaceShortcuts, 'clickInstantActionButton').mockResolvedValue();
        try {
            const pending = marketplaceShortcuts.executeAction('buy', '/items/whatever', 0);

            marketplaceShortcuts.disable();
            await vi.advanceTimersByTimeAsync(300);
            await pending;

            expect(click).not.toHaveBeenCalled();
        } finally {
            click.mockRestore();
            marketplaceShortcuts.initialize();
            vi.useRealTimers();
        }
    });

    test('disable clears a captured quantity before another character can reuse it', () => {
        marketplaceShortcuts.pendingQuantity = 250;

        marketplaceShortcuts.disable();

        expect(marketplaceShortcuts.pendingQuantity).toBeNull();
        marketplaceShortcuts.initialize();
    });

    test('disable cancels queued modal injections', () => {
        vi.useFakeTimers();
        try {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="MarketplacePanel_header__x">Buy Listing</div>
                <div class="outer">
                    <div class="wrapper">
                        <div class="MarketplacePanel_quantityInputs__x"><input value="5" /></div>
                    </div>
                </div>`;
            document.body.appendChild(modal);

            marketplaceShortcuts.injectQuickInputButtons(modal);
            marketplaceShortcuts.disable();
            vi.advanceTimersByTime(150);

            expect(modal.querySelector('.mwi-mp-quick-input')).toBeNull();
        } finally {
            marketplaceShortcuts.initialize();
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

/*
 * `findQuantityInput` used to end in `return allInputs[0]`. In a Sell Now modal
 * whose price field has been woken into a real input, the first input IS the
 * price — so a modal whose labels the walk could not read handed the caller a
 * price. The one caller that matters is the Bulk Sell strip's Confirm guard,
 * which compares that number to the queued count before pressing the game's own
 * sell button: a fail-open shape on the one feature that sells for you.
 */
describe('findQuantityInput refuses rather than guessing positionally', () => {
    /**
     * A modal with two inputs and no readable labels — the shape the walk
     * cannot identify.
     * @returns {HTMLElement}
     */
    function unlabelledModal() {
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div><div><input value="45,000,000" /></div></div>
            <div><div><input value="7" /></div></div>
        `;
        return modal;
    }

    test('an unidentifiable quantity field is null, not the price', () => {
        const modal = unlabelledModal();
        const found = marketplaceShortcuts.findQuantityInput(modal);
        expect(found).toBeNull();
        // Specifically not the price, which is what the positional fallback gave
        expect(found?.value).not.toBe('45,000,000');
    });

    test("the game's own quantity row is still identification enough", () => {
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div class="MarketplacePanel_priceInputs__x"><input value="45,000,000" /></div>
            <div class="MarketplacePanel_quantityInputs__y"><input value="7" /></div>
        `;
        expect(marketplaceShortcuts.findQuantityInput(modal).value).toBe('7');
    });

    test('a labelled field is still found by walking outward to the label', () => {
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div>Price<div><input value="45,000,000" /></div></div>
            <div>Quantity<div><input value="7" /></div></div>
        `;
        expect(marketplaceShortcuts.findQuantityInput(modal).value).toBe('7');
    });

    test('a modal with a single input is identified, not guessed', () => {
        // The price control sleeps as a display div until it is clicked, so a
        // freshly opened sell modal really does carry the quantity field alone
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div class="MarketplacePanel_priceDisplay__z">45,000,000</div>
            <div><div><input value="7" /></div></div>
        `;
        expect(marketplaceShortcuts.findQuantityInput(modal).value).toBe('7');
    });
});
