/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ click: vi.fn(() => 'dom') }));
vi.mock('./react-click.js', () => ({ clickThroughReact: mocks.click }));
vi.mock('./game-lookups.js', () => ({ getIconHref: () => null }));

const { ensureCharacterPanelOpen, isCharacterPanelOpen } = await import('./character-panel.js');

const visible = (on) => {
    Element.prototype.getClientRects = () => (on ? [{}] : []);
};

describe('character panel', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.click.mockClear();
    });

    test('open and visible: nothing is pressed', () => {
        document.body.innerHTML = '<div role="tablist"><button role="tab">Loadouts</button></div>';
        visible(true);
        expect(isCharacterPanelOpen()).toBe(true);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).not.toHaveBeenCalled();
    });

    test('closed: presses the header icon found by its sprite label', () => {
        document.body.innerHTML =
            '<div class="Header_header__a"><button id="b"><svg aria-label="header.chest"></svg></button></div>';
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(true);
        expect(mocks.click).toHaveBeenCalledWith(document.getElementById('b'));
    });

    test('closed and no icon found: reports failure without pressing anything', () => {
        document.body.innerHTML = '<div class="Header_header__a"><button><svg aria-label="x"></svg></button></div>';
        visible(false);
        expect(ensureCharacterPanelOpen()).toBe(false);
        expect(mocks.click).not.toHaveBeenCalled();
    });
});
