/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { onClassMock, unregisterMock, gameMock, lookups } = vi.hoisted(() => ({
    unregisterMock: vi.fn(),
    onClassMock: vi.fn(),
    gameMock: { handleGoToNavTarget: vi.fn() },
    lookups: { names: {} },
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: onClassMock } }));
vi.mock('../../utils/item-navigation.js', () => ({ getGameObject: vi.fn(() => gameMock) }));
vi.mock('../../utils/game-lookups.js', () => ({
    getIconHref: (container) => container.querySelector('use')?.getAttribute('href') || null,
    getItemHridFromIconHref: (href) => (href ? `/items/${href.split('#')[1]}` : null),
    getItemHridFromName: (name) => lookups.names[name] || null,
}));

import tokenShopShortcuts, { getShopDestination } from './token-shop-shortcuts.js';
import { getGameObject } from '../../utils/item-navigation.js';

function buildMenu(slug, { name = 'Some Item', withNative = true } = {}) {
    const menu = document.createElement('div');
    menu.className = 'Item_actionMenu__x';
    menu.innerHTML = `
        <svg><use href="/static/items_sprite.svg#${slug}"></use></svg>
        <div class="Item_name__y">${name}</div>
        ${withNative ? '<button class="Button_native">Link to Chat</button>' : ''}`;
    document.body.appendChild(menu);
    return menu;
}

function buildTabs(containerClass, count, selected = 0) {
    const container = document.createElement('div');
    container.className = containerClass;
    container.innerHTML = Array.from(
        { length: count },
        (_, i) => `<button role="tab" aria-selected="${i === selected}">tab ${i}</button>`
    ).join('');
    document.body.appendChild(container);
    return [...container.querySelectorAll('button')];
}

let observer;

beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    gameMock.handleGoToNavTarget.mockClear();
    getGameObject.mockImplementation(() => gameMock);
    lookups.names = {};
    unregisterMock.mockClear();
    onClassMock.mockReset();
    onClassMock.mockImplementation((_name, _class, callback) => {
        observer = callback;
        return unregisterMock;
    });
    tokenShopShortcuts.initialize();
});

afterEach(() => {
    tokenShopShortcuts.cleanup();
    vi.useRealTimers();
});

describe('getShopDestination', () => {
    test.each([
        ['/items/chimerical_token', 'shop', 1],
        ['/items/sinister_token', 'shop', 1],
        ['/items/enchanted_token', 'shop', 1],
        ['/items/pirate_token', 'shop', 1],
        ['/items/labyrinth_token', 'labyrinth', 3],
        ['/items/task_token', 'tasks', 1],
        ['/items/guild_token', 'guild', 4],
        ['/items/blue_guild_credit', 'guild', 4],
        ['/items/white_guild_credit', 'guild', 4],
    ])('%s opens %s tab index %i', (hrid, navTarget, tabIndex) => {
        const destination = getShopDestination(hrid);
        expect(destination.navTarget).toBe(navTarget);
        expect(destination.tabIndex).toBe(tabIndex);
    });

    test('every guild credit colour is covered, and ordinary items are not', () => {
        for (const color of ['blue', 'brown', 'gold', 'green', 'purple', 'red', 'silver', 'white']) {
            expect(getShopDestination(`/items/${color}_guild_credit`).navTarget).toBe('guild');
        }
        expect(getShopDestination('/items/cheese')).toBeNull();
        expect(getShopDestination('/items/cowbell')).toBeNull();
    });
});

describe('the injected button', () => {
    test('a token menu gets one button, above the native ones, with the shop label', () => {
        const menu = buildMenu('labyrinth_token');
        observer(menu);
        observer(menu); // a second pass adds nothing
        const buttons = [...menu.querySelectorAll('button')];
        expect(buttons.map((b) => b.textContent)).toEqual(['View Labyrinth Shop', 'Link to Chat']);
        expect(buttons[0].className).toContain('Button_native');
        expect(menu.querySelectorAll('.mwi-token-shop-button')).toHaveLength(1);
    });

    test('a menu with no native button still gets the button', () => {
        const menu = buildMenu('task_token', { withNative: false });
        observer(menu);
        expect(menu.querySelector('.mwi-token-shop-button').textContent).toBe('View Task Shop');
    });

    test('an ordinary item or a menu with no name gets nothing', () => {
        const plain = buildMenu('cheese');
        observer(plain);
        expect(plain.querySelector('.mwi-token-shop-button')).toBeNull();

        const nameless = buildMenu('guild_token');
        nameless.querySelector('[class*="Item_name"]').remove();
        observer(nameless);
        expect(nameless.querySelector('.mwi-token-shop-button')).toBeNull();
    });

    test('the translated name is the fallback when the icon names nothing', () => {
        lookups.names['Gemme de donjon'] = '/items/pirate_token';
        const menu = buildMenu('unknown');
        // Break the icon so the sprite lookup fails but the name resolves
        menu.querySelector('use').removeAttribute('href');
        menu.querySelector('[class*="Item_name"]').textContent = 'Gemme de donjon';
        observer(menu);
        expect(menu.querySelector('.mwi-token-shop-button').textContent).toBe('View Dungeon Shop');
    });
});

describe('pressing the button', () => {
    test('navigates, then selects the tab once it mounts', () => {
        const menu = buildMenu('guild_token');
        observer(menu);
        menu.querySelector('.mwi-token-shop-button').click();
        expect(gameMock.handleGoToNavTarget).toHaveBeenCalledWith('guild');

        vi.advanceTimersByTime(200); // page not mounted yet
        const tabs = buildTabs('GuildPanel_tabsComponentContainer__z', 6);
        const click = vi.spyOn(tabs[4], 'click');
        vi.advanceTimersByTime(100);
        expect(click).toHaveBeenCalledTimes(1);
    });

    test('an already-selected tab is not clicked again', () => {
        const tabs = buildTabs('ShopPanel_tabsComponentContainer__z', 4, 1);
        const click = vi.spyOn(tabs[1], 'click');
        const menu = buildMenu('chimerical_token');
        observer(menu);
        menu.querySelector('.mwi-token-shop-button').click();
        vi.advanceTimersByTime(100);
        expect(click).not.toHaveBeenCalled();
    });

    test('a tab bar with too few tabs leaves the shop at its default tab and stops polling', () => {
        const tabs = buildTabs('LabyrinthPanel_tabsComponentContainer__z', 2);
        const clicks = tabs.map((tab) => vi.spyOn(tab, 'click'));
        const menu = buildMenu('labyrinth_token');
        observer(menu);
        menu.querySelector('.mwi-token-shop-button').click();
        vi.advanceTimersByTime(60_000);
        clicks.forEach((c) => expect(c).not.toHaveBeenCalled());
        expect(vi.getTimerCount()).toBe(0);
    });

    test('with game navigation unavailable nothing throws and nothing polls', () => {
        getGameObject.mockImplementation(() => null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const menu = buildMenu('task_token');
        observer(menu);
        expect(() => menu.querySelector('.mwi-token-shop-button').click()).not.toThrow();
        expect(warn).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        warn.mockRestore();
    });

    test('a second press supersedes the first poll', () => {
        const menu = buildMenu('task_token');
        observer(menu);
        const button = menu.querySelector('.mwi-token-shop-button');
        button.click();
        button.click();
        expect(vi.getTimerCount()).toBe(1);
    });
});

describe('cleanup', () => {
    test('unregisters the observer, removes buttons and stops a pending poll', () => {
        const menu = buildMenu('guild_token');
        observer(menu);
        menu.querySelector('.mwi-token-shop-button').click();
        expect(vi.getTimerCount()).toBe(1);

        tokenShopShortcuts.cleanup();
        expect(unregisterMock).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.mwi-token-shop-button')).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a menu the stale observer delivers after disable gets nothing, and re-enable works', () => {
        tokenShopShortcuts.cleanup();
        const menu = buildMenu('guild_token');
        observer(menu);
        expect(menu.querySelector('.mwi-token-shop-button')).toBeNull();

        tokenShopShortcuts.initialize();
        observer(menu);
        expect(menu.querySelector('.mwi-token-shop-button')).not.toBeNull();
    });
});
