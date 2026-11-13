/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ click: vi.fn(() => 'dom') }));
vi.mock('./react-click.js', () => ({ clickThroughReact: mocks.click }));
vi.mock('./game-lookups.js', () => ({
    getIconHref: (el) => el.querySelector('use')?.getAttribute('href') ?? null,
}));

const { ensureCharacterPanelOpen, isCharacterPanelOpen } = await import('./character-panel.js');

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

    test('a menu icon is never guessed at', () => {
        document.body.innerHTML = header('<svg aria-label="header.menu"></svg>');
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(false);
        expect(mocks.click).not.toHaveBeenCalled();
    });
});
