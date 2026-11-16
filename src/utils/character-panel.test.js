/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ click: vi.fn(() => 'dom') }));
vi.mock('./react-click.js', () => ({ clickThroughReact: mocks.click }));
vi.mock('./game-lookups.js', () => ({
    getIconHref: (el) => el.querySelector('use')?.getAttribute('href') ?? null,
}));

const { ensureCharacterPanelOpen, isCharacterPanelOpen, findVisibleOwnTab, findCharacterTabList } =
    await import('./character-panel.js');

const visible = (on) => {
    Element.prototype.getClientRects = () => (on ? [{}] : []);
};
const header = (inner) => `<div class="Header_header__a"><button id="b">${inner}</button></div>`;

describe('character panel', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.click.mockClear();
    });

    test('open and visible, found by Toolasha tab with no label text: nothing is pressed', () => {
        document.body.innerHTML =
            '<div role="tablist"><button role="tab" class="toolasha-skilling-opt-tab">x</button></div>';
        visible(true);
        expect(isCharacterPanelOpen()).toBe(true);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    test('open in another locale before our tab is injected: found inside the game panel, not pressed', () => {
        document.body.innerHTML =
            '<div class="GamePage_characterManagementPanel__z"><div role="tablist"><button role="tab">Cangku</button></div></div>';
        visible(true);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    test('closed: presses the toggle found by its sprite label, react handler first', () => {
        document.body.innerHTML = header('<svg aria-label="header.chest"></svg>');
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).toHaveBeenCalledWith(document.getElementById('b'), { reactFirst: true });
    });

    test('closed: matches the sprite href fragment only, not the rest of the URL', () => {
        document.body.innerHTML = header('<svg><use href="/static/chest_sheet.svg#chest"></use></svg>');
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(true);
        document.body.innerHTML = header('<svg><use href="/static/inventory.svg#gear"></use></svg>');
        mocks.click.mockClear();
        expect(ensureCharacterPanelOpen()).toBe(false);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    // Phone, seen live: the header holds only Flee / Claim Reward; the panel opens from the left navigation,
    // whose plural container wraps every link and so also holds the loot icon (it must never be pressed)
    const link = (cls, icon, id = '') =>
        `<div class="${cls}" ${id ? `id="${id}"` : ''}><svg><use href="/static/media/misc_sprite.d3f05174.svg#${icon}"></use></svg><span>My Stuff</span></div>`;
    const phone = (first, second = link('NavigationBar_navigationLink__3eAHA', 'marketplace', 'market')) =>
        `<div class="Header_header__a"><button id="flee">Flee</button><button>Claim Reward</button></div>
         <div class="NavigationBar_navigationLinks__1XSSb" id="container">${first}${second}</div>`;
    const MY_STUFF = 'NavigationBar_navigationLink__3eAHA NavigationBar_characterManagement__27qu3';

    test('phone, no header toggle: presses the link found by its class, never the container around it', () => {
        document.body.innerHTML = phone(link(MY_STUFF, 'loot', 'nav'));
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).toHaveBeenCalledTimes(1);
        expect(mocks.click).toHaveBeenCalledWith(document.getElementById('nav'), { reactFirst: true });
    });

    test('phone: the class match wins over an earlier link that only has the loot sprite', () => {
        document.body.innerHTML = phone(
            link('NavigationBar_navigationLink__a', 'loot', 'decoy'),
            link(MY_STUFF, 'x', 'nav')
        );
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).toHaveBeenCalledWith(document.getElementById('nav'), { reactFirst: true });
    });

    test('phone: a link is found by its own loot sprite when its class has no name; others never are', () => {
        document.body.innerHTML = phone(link('NavigationBar_navigationLink__a', 'loot', 'nav'));
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).toHaveBeenCalledWith(document.getElementById('nav'), { reactFirst: true });
        document.body.innerHTML = phone(link('NavigationBar_navigationLink__a', 'combat'));
        mocks.click.mockClear();
        expect(ensureCharacterPanelOpen()).toBe(false);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    test('desktop, panel already open with a navigation link present: nothing is pressed', () => {
        document.body.innerHTML =
            phone(link(MY_STUFF, 'loot')) +
            '<div role="tablist"><button role="tab" class="toolasha-skilling-opt-tab">x</button></div>';
        visible(true);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    test('two copies of the panel: the one on screen counts, whichever comes first', () => {
        document.body.innerHTML = `<div data-hide="1"><div role="tablist" id="side"><button role="tab" class="toolasha-skilling-opt-tab">x</button></div></div>
            <div role="tablist" id="main"><button role="tab" class="toolasha-skilling-opt-tab" id="mainTab">x</button></div>`;
        Element.prototype.getClientRects = function () {
            return this.closest('[data-hide]') ? [] : [{}];
        };
        expect(findVisibleOwnTab()).toBe(document.getElementById('mainTab'));
        expect(findCharacterTabList().id).toBe('main');
        expect(isCharacterPanelOpen()).toBe(true);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    test('a menu icon is never guessed at', () => {
        document.body.innerHTML = header('<svg aria-label="header.menu"></svg>');
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(false);
        expect(mocks.click).not.toHaveBeenCalled();
    });
});
