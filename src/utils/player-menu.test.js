/** @vitest-environment happy-dom
 *
 * The per-player markers and their menu.
 *
 * What matters is that a click on a marker opens the menu without also doing
 * whatever the row it sits in does on click, that the listener survives the
 * boards' innerHTML redraws without piling up, and that a choice lands in the
 * override and colour stores and asks the board to redraw.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({ settings: { combatPlayerColors: true, combatClassOverride: true } }));

vi.mock('../core/config.js', () => ({
    default: { getSetting: (key) => opts.settings[key] ?? false, Z_POPUP: 9000 },
}));
vi.mock('../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => {} },
}));
// The weapon sprite needs game data; a text chip is what the menu falls back to
vi.mock('./class-weapon.js', () => ({ classTagIconHTML: () => '' }));

const { playerMarkersHTML, playerRowColor, wirePlayerMenu, openPlayerMenu, closePlayerMenu, PLAYER_ATTR, MENU_CLASS } =
    await import('./player-menu.js');
const { classOverrideFor, _resetClassOverrides } = await import('./class-override.js');
const { pickedColor, playerColor, PLAYER_PALETTE, _resetPlayerColors } = await import('./player-colors.js');
const { CLASS_BUCKETS } = await import('./class-inference.js');

const inferred = { ...CLASS_BUCKETS.melee, basis: 'casts', evidence: [] };
const renderTag = (verdict) => (verdict ? `<i data-tag="${verdict.key}">${verdict.short}</i>` : '');
const menu = () => document.querySelector(`.${MENU_CLASS}`);

beforeEach(() => {
    opts.settings = { combatPlayerColors: true, combatClassOverride: true };
    _resetClassOverrides();
    _resetPlayerColors();
    document.body.replaceChildren();
});

afterEach(() => {
    closePlayerMenu();
    document.body.replaceChildren();
});

describe('playerMarkersHTML', () => {
    test('with both on: a dot in the player colour, and the board’s own chip made clickable', () => {
        const html = playerMarkersHTML('Abe', inferred, renderTag);
        const host = document.createElement('div');
        host.innerHTML = html;
        const markers = host.querySelectorAll(`[${PLAYER_ATTR}]`);
        expect(markers).toHaveLength(2);
        expect(markers[0].style.background).toBeTruthy();
        expect(html).toContain(playerColor('Abe'));
        expect(host.querySelector('[data-tag="melee"]')).not.toBeNull();
    });

    test('with both off, the board’s chip is all there is', () => {
        opts.settings = {};
        expect(playerMarkersHTML('Abe', inferred, renderTag)).toBe(renderTag(inferred));
        expect(playerRowColor('Abe', '#123456')).toBe('#123456');
    });

    test('a name off the wire cannot break out of the attribute', () => {
        const html = playerMarkersHTML('"><img src=x onerror=alert(1)>', null, renderTag);
        const host = document.createElement('div');
        host.innerHTML = html;
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector(`[${PLAYER_ATTR}]`).getAttribute(PLAYER_ATTR)).toBe('"><img src=x onerror=alert(1)>');
    });

    test('a class set by hand replaces the inferred chip and says who set it', () => {
        openPlayerMenu(document.body, 'Abe');
        menu().querySelector('button[data-class="tank"]').click();
        const html = playerMarkersHTML('Abe', inferred, renderTag);
        expect(html).not.toContain('data-tag="melee"');
        expect(html).toContain('TANK');
        expect(html).toContain('set by you');
    });

    test('with overrides off, a stored override is not drawn', () => {
        openPlayerMenu(document.body, 'Abe');
        menu().querySelector('button[data-class="tank"]').click();
        opts.settings.combatClassOverride = false;
        expect(playerMarkersHTML('Abe', inferred, renderTag)).toContain('data-tag="melee"');
    });
});

describe('wirePlayerMenu', () => {
    function boardWithRow() {
        const board = document.createElement('div');
        board.innerHTML = `<div data-row>${playerMarkersHTML('Abe', inferred, renderTag)}</div>`;
        document.body.appendChild(board);
        return board;
    }

    test('a click on a marker opens the menu and does not reach the row', () => {
        const board = boardWithRow();
        const rowClicks = vi.fn();
        board.querySelector('[data-row]').addEventListener('click', rowClicks);
        wirePlayerMenu(board, () => {});

        board.querySelector(`[${PLAYER_ATTR}]`).click();
        expect(menu()).not.toBeNull();
        expect(menu().textContent).toContain('Abe');
        expect(rowClicks).not.toHaveBeenCalled();
    });

    test('wiring on every redraw keeps one listener, calling the latest redraw', () => {
        const board = boardWithRow();
        const first = vi.fn();
        const latest = vi.fn();
        wirePlayerMenu(board, first);
        board.innerHTML = `<div data-row>${playerMarkersHTML('Abe', inferred, renderTag)}</div>`;
        wirePlayerMenu(board, latest);

        board.querySelector(`[${PLAYER_ATTR}]`).click();
        expect(document.querySelectorAll(`.${MENU_CLASS}`)).toHaveLength(1);
        menu().querySelector('button[data-class="healer"]').click();
        expect(first).not.toHaveBeenCalled();
        expect(latest).toHaveBeenCalledTimes(1);
    });
});

describe('the menu', () => {
    test('a class choice is stored, redraws and closes; Automatic clears it', () => {
        const redraw = vi.fn();
        openPlayerMenu(document.body, 'Abe', redraw);
        menu().querySelector('button[data-class="ranged"]').click();
        expect(classOverrideFor('Abe')).toBe('ranged');
        expect(redraw).toHaveBeenCalledTimes(1);
        expect(menu()).toBeNull();

        openPlayerMenu(document.body, 'Abe', redraw);
        menu().querySelector('button[data-class=""]').click();
        expect(classOverrideFor('Abe')).toBeNull();
    });

    test('a swatch picks the colour; Automatic hands it back to the palette', () => {
        openPlayerMenu(document.body, 'Abe');
        menu().querySelector(`button[data-color="${PLAYER_PALETTE[3]}"]`).click();
        expect(pickedColor('Abe')).toBe(PLAYER_PALETTE[3]);

        openPlayerMenu(document.body, 'Abe');
        menu().querySelector('button[data-color=""]').click();
        expect(pickedColor('Abe')).toBeNull();
    });

    test('only the sections that are switched on are offered', () => {
        opts.settings.combatPlayerColors = false;
        openPlayerMenu(document.body, 'Abe');
        expect(menu().querySelector('[data-color]')).toBeNull();
        expect(menu().querySelector('[data-class]')).not.toBeNull();
    });

    test('a click outside or Escape closes it', () => {
        openPlayerMenu(document.body, 'Abe');
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(menu()).toBeNull();

        openPlayerMenu(document.body, 'Abe');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu()).toBeNull();
    });
});
