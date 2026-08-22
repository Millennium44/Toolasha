/** @vitest-environment happy-dom
 *
 * Right-clicking an ability icon opens its book in the Item Dictionary. The
 * icon is known by its sprite — the game draws every ability off
 * `abilities_sprite` with the slug as the fragment — so the test is about
 * reading that, and about leaving every other right-click alone.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ opened: [], items: {} }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => state.items[hrid] || null,
        getInitClientData: () => ({ abilityDetailMap: {} }),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { register: () => () => {} } }));
vi.mock('../../utils/item-navigation.js', () => ({
    openItemDictionary: (hrid) => {
        state.opened.push(hrid);
        return true;
    },
}));

const feature = (await import('./ability-dictionary-button.js')).default;

/** An ability icon as the game draws it */
function icon(slug, sprite = 'abilities_sprite') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/static/media/${sprite}.abc123.svg#${slug}`);
    svg.appendChild(use);
    document.body.appendChild(svg);
    return svg;
}

beforeEach(() => {
    document.body.innerHTML = '';
    state.opened = [];
    state.items = { '/items/insanity': { abilityBookDetail: {} } };
    feature.initialize();
});

afterEach(() => {
    feature.cleanup?.();
});

describe('right-click on an ability icon', () => {
    test('opens the ability’s book in the dictionary and eats the menu', () => {
        const svg = icon('insanity');
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        svg.querySelector('use').dispatchEvent(event);

        expect(state.opened).toEqual(['/items/insanity']);
        expect(event.defaultPrevented).toBe(true);
    });

    test('a click on the level label laid over the icon still finds the ability', () => {
        // As the game lays it out: container > [svg, level label]; the label is on top
        const container = document.createElement('div');
        container.className = 'Ability_iconContainer__x';
        const svg = icon('insanity');
        container.appendChild(svg);
        const label = document.createElement('div');
        label.className = 'Ability_level__x';
        label.textContent = 'Lv.100';
        container.appendChild(label);
        document.body.appendChild(container);

        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        label.dispatchEvent(event);
        expect(state.opened).toEqual(['/items/insanity']);
    });

    test('a row holding several abilities is not guessed at', () => {
        const row = document.createElement('div');
        row.appendChild(icon('insanity'));
        row.appendChild(icon('precision'));
        document.body.appendChild(row);
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        expect(state.opened).toEqual([]);
        expect(event.defaultPrevented).toBe(false);
    });

    test('an item icon, or an ability with no book, is left to the game', () => {
        const item = icon('cheese', 'items_sprite');
        const e1 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        item.dispatchEvent(e1);
        expect(e1.defaultPrevented).toBe(false);

        const unknown = icon('no_such_ability');
        const e2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        unknown.dispatchEvent(e2);
        expect(e2.defaultPrevented).toBe(false);
        expect(state.opened).toEqual([]);
    });
});
