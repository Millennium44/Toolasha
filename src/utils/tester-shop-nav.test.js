/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { findShopTab, openShopTab, setShopFilter } from './tester-shop-nav.js';

/** An "Item Filter" box inside a container with the given class */
function filterBox(containerClass) {
    const container = document.createElement('div');
    container.className = containerClass;
    const input = document.createElement('input');
    input.placeholder = 'Item Filter';
    container.appendChild(input);
    document.body.appendChild(container);
    // happy-dom lays nothing out; stand in for "on screen"
    Object.defineProperty(input, 'offsetParent', { get: () => container });
    return input;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('setShopFilter', () => {
    test('types into the Shop panel filter', () => {
        const shop = filterBox('ShopPanel_itemFilterContainer__1raSg');

        expect(setShopFilter('Chaotic Chain')).toBe(true);
        expect(shop.value).toBe('Chaotic Chain');
    });

    test('never falls back to the inventory filter when the Shop has none on screen', () => {
        // Measured on the test server: the Dungeon tab hides the Shop's filter
        const inventory = filterBox('Inventory_filterInput__3OXXy');

        expect(setShopFilter('Chaotic Chain')).toBe(false);
        expect(inventory.value).toBe('');
    });
});

describe('findShopTab', () => {
    /** A visible tab strip with a "Dungeon" tab inside a container with the given class */
    function strip(containerClass) {
        const container = document.createElement('div');
        container.className = containerClass;
        const list = document.createElement('div');
        list.className = 'MuiTabs-flexContainer';
        list.setAttribute('role', 'tablist');
        const tab = document.createElement('button');
        tab.textContent = 'Dungeon';
        list.appendChild(tab);
        container.appendChild(list);
        document.body.appendChild(container);
        Object.defineProperty(list, 'offsetParent', { get: () => container });
        return tab;
    }

    test("ignores another panel's Dungeon tab and finds the Shop's", () => {
        strip('CombatPanel_tabsComponentContainer__x');
        expect(findShopTab(/^\s*dungeons?\s*$/i)).toBeNull();

        const shopTab = strip('ShopPanel_shopPanel__1Wl3r');
        expect(findShopTab(/^\s*dungeons?\s*$/i)).toBe(shopTab);
    });
});

describe('openShopTab', () => {
    /** The navbar's Shop button, wired with a click spy */
    function navShopButton() {
        const nav = document.createElement('div');
        nav.className = 'NavigationBar_nav__3uuUl';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-label', 'navigationBar.shop');
        nav.appendChild(svg);
        document.body.appendChild(nav);
        nav.click = vi.fn(nav.click.bind(nav));
        return nav;
    }

    /** A visible Shop tab strip with one tab matching `text`, not yet attached */
    function buildTab(text) {
        const container = document.createElement('div');
        container.className = 'ShopPanel_shopPanel__1Wl3r';
        const list = document.createElement('div');
        list.className = 'MuiTabs-flexContainer';
        list.setAttribute('role', 'tablist');
        const tab = document.createElement('button');
        tab.textContent = text;
        tab.click = vi.fn(tab.click.bind(tab));
        list.appendChild(tab);
        container.appendChild(list);
        Object.defineProperty(list, 'offsetParent', { get: () => container });
        return { container, tab };
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('never clicks the nav when already cancelled', async () => {
        const nav = navShopButton();
        const promise = openShopTab(/^\s*dungeons?\s*$/i, () => true);

        expect(await promise).toBeNull();
        expect(nav.click).not.toHaveBeenCalled();
    });

    test('clicks the tab once it appears, when not cancelled', async () => {
        navShopButton();
        const { container, tab } = buildTab('Dungeon');

        const promise = openShopTab(/^\s*dungeons?\s*$/i);
        document.body.appendChild(container);
        await vi.advanceTimersByTimeAsync(250);

        expect(await promise).toBe(tab);
        expect(tab.click).toHaveBeenCalledTimes(1);
    });

    test('a plan row that goes stale while waiting for the tab must not click it for whoever is here now', async () => {
        // Regression: the quantity autofill already guarded a character switch
        // or the feature being disabled during this wait, but the tab click
        // itself did not — a stale click could still open the Dungeon tab for
        // a different character.
        navShopButton();
        const { container, tab } = buildTab('Dungeon');
        document.body.appendChild(container);

        let cancelled = false;
        const promise = openShopTab(/^\s*dungeons?\s*$/i, () => cancelled);

        // The character switches (or the feature is disabled) while the tab
        // strip is being waited on, before the tab has actually been clicked.
        cancelled = true;
        await vi.advanceTimersByTimeAsync(3500);

        expect(await promise).toBeNull();
        expect(tab.click).not.toHaveBeenCalled();
    });
});
