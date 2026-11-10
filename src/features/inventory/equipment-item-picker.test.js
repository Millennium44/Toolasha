/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
import { createEquipmentItemPicker } from './equipment-item-picker.js';

const items = [
    { itemHrid: '/items/cheese_sword', name: 'Cheese Sword' },
    { itemHrid: '/items/holy_sword', name: 'Holy Sword' },
    { itemHrid: '/items/infernal_sword', name: 'Holy Sword' },
    { itemHrid: '/items/wooden_shield', name: 'Shield <img onerror="bad()">' },
];
const key = (node, value) =>
    node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
const make = (overrides = {}) => {
    const onChange = vi.fn();
    const onSearch = vi.fn();
    const element = createEquipmentItemPicker({
        slot: 'main_hand',
        label: 'Main Hand equipment',
        items,
        value: '',
        query: '',
        onChange,
        onSearch,
        ...overrides,
    });
    document.body.appendChild(element);
    return {
        element,
        onChange,
        onSearch,
        search: element.querySelector('input'),
        list: element.querySelector('[role="listbox"]'),
    };
};
beforeEach(() => {
    document.body.replaceChildren();
    resetSpriteSheetCache();
});

describe('Equipment Watch searchable item list', () => {
    test('game artwork uses stable HRIDs, keeps duplicate names separate, and leaves plain text safe', () => {
        document.body.innerHTML = '<svg><use xlink:href="/static/items_sprite.123.svg#cheese_sword"></use></svg>';
        const { element, onChange } = make();
        const rows = element.querySelectorAll('[role="option"]');
        expect(rows).toHaveLength(5);
        expect(rows[0].querySelector('svg')).toBeNull();
        expect(rows[2].textContent).toBe('Holy Sword');
        expect(rows[3].textContent).toBe('Holy Sword');
        expect(rows[3].querySelector('use').getAttribute('href')).toBe('/static/items_sprite.123.svg#infernal_sword');
        expect(rows[3].querySelector('svg').getAttribute('aria-hidden')).toBe('true');
        expect(rows[3].querySelector('svg').getAttribute('focusable')).toBe('false');
        rows[3].querySelector('use').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(onChange).toHaveBeenCalledWith('/items/infernal_sword');
        expect(element.querySelector('img')).toBeNull();
        expect(rows[4].textContent).toBe('Shield <img onerror="bad()">');
    });

    test('names and selection remain usable before native sprites arrive and redraw resolves them', () => {
        const { element, onChange } = make();
        const row = element.querySelector('[data-item-hrid="/items/holy_sword"]');
        expect(row.querySelector('svg')).toBeNull();
        expect(row.textContent).toBe('Holy Sword');
        row.click();
        expect(onChange).toHaveBeenCalledWith('/items/holy_sword');
        document.body.insertAdjacentHTML(
            'beforeend',
            '<svg><use href="/items_sprite.late.svg#cheese_sword"></use></svg>'
        );
        const rebuilt = make({ value: '/items/holy_sword' });
        expect(rebuilt.element.querySelector('[aria-selected="true"] use').getAttribute('href')).toBe(
            '/items_sprite.late.svg#holy_sword'
        );
    });

    test('case-insensitive search preserves order, duplicate choices and the selected value', () => {
        const { element, search, onSearch, onChange } = make({ value: '/items/holy_sword' });
        search.value = ' HoLy ';
        search.dispatchEvent(new Event('input'));
        expect(onSearch).toHaveBeenCalledWith(' HoLy ');
        expect(onChange).not.toHaveBeenCalled();
        const rows = element.querySelectorAll('[role="option"]');
        expect([...rows].map((row) => row.dataset.itemHrid)).toEqual(['/items/holy_sword', '/items/infernal_sword']);
        expect(rows[0].getAttribute('aria-selected')).toBe('true');
        expect(element.querySelector('[role="status"]').textContent).toBe('2 matching items');
    });

    test('empty results remove the active descendant without selecting or erasing anything', () => {
        const { element, list, search, onChange } = make({ value: '/items/holy_sword' });
        search.value = 'no match';
        search.dispatchEvent(new Event('input'));
        expect(list.children).toHaveLength(0);
        expect(list.hasAttribute('aria-activedescendant')).toBe(false);
        expect(element.textContent).toContain('No matching equipment');
        for (const value of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'PageDown', 'PageUp'])
            key(list, value);
        expect(onChange).not.toHaveBeenCalled();
        search.value = '';
        search.dispatchEvent(new Event('input'));
        expect(list.querySelector('[aria-selected="true"]').dataset.itemHrid).toBe('/items/holy_sword');
    });

    test('arrow, boundary, page, and activation keys choose the explicit HRID and clearing still works', () => {
        const { list, onChange } = make({ value: '/items/holy_sword' });
        key(list, 'ArrowDown');
        expect(onChange).toHaveBeenLastCalledWith('/items/infernal_sword');
        key(list, 'ArrowUp');
        key(list, 'ArrowUp');
        expect(onChange).toHaveBeenLastCalledWith('/items/cheese_sword');
        key(list, 'End');
        expect(onChange).toHaveBeenLastCalledWith('/items/wooden_shield');
        key(list, 'Home');
        expect(onChange).toHaveBeenLastCalledWith('');
        key(list, 'PageDown');
        expect(onChange).toHaveBeenLastCalledWith('/items/wooden_shield');
        key(list, 'PageUp');
        expect(onChange).toHaveBeenLastCalledWith('');
        key(list, 'Enter');
        key(list, ' ');
        expect(onChange).toHaveBeenLastCalledWith('');
    });

    test('typing starts search, down enters results, Escape returns to search, and game shortcuts do not fire', () => {
        const { list, search, onChange } = make();
        const shortcut = vi.fn();
        document.addEventListener('keydown', shortcut);
        list.focus();
        key(list, 'h');
        expect(document.activeElement).toBe(search);
        expect(search.value).toBe('h');
        key(search, 'ArrowDown');
        expect(document.activeElement).toBe(list);
        expect(onChange).toHaveBeenLastCalledWith('/items/cheese_sword');
        key(list, 'Escape');
        expect(document.activeElement).toBe(search);
        expect(shortcut).not.toHaveBeenCalled();
        document.removeEventListener('keydown', shortcut);
    });

    test.each([
        ['search', { isComposing: true }],
        ['list', { isComposing: true }],
        ['search', { keyCode: 229 }],
        ['list', { keyCode: 229 }],
    ])('IME composition in %s keeps candidate keys with the input method (%j)', (control, composition) => {
        const { search, list, onChange, onSearch } = make({ value: '/items/holy_sword', query: 'sword' });
        const target = control === 'search' ? search : list;
        target.focus();
        const active = list.getAttribute('aria-activedescendant');
        const shortcut = vi.fn();
        document.addEventListener('keydown', shortcut);
        try {
            for (const value of [
                'ArrowDown',
                'ArrowUp',
                'Home',
                'End',
                'PageDown',
                'PageUp',
                'Enter',
                ' ',
                'Escape',
                'h',
            ]) {
                const event = new KeyboardEvent('keydown', {
                    key: value,
                    bubbles: true,
                    cancelable: true,
                    ...composition,
                });
                target.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(false);
                expect(document.activeElement).toBe(target);
                expect(list.getAttribute('aria-activedescendant')).toBe(active);
            }
            expect(onChange).not.toHaveBeenCalled();
            expect(onSearch).not.toHaveBeenCalled();
            expect(search.value).toBe('sword');
            expect(shortcut).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('keydown', shortcut);
        }
    });

    test('search and list have accessible names and the active option is owned by the list', () => {
        const { element, search, list } = make({ value: '/items/holy_sword' });
        expect(search.getAttribute('aria-label')).toBe('Search Main Hand equipment');
        expect(search.getAttribute('aria-controls')).toBe(list.id);
        expect(list.getAttribute('aria-label')).toBe('Main Hand equipment');
        expect(element.querySelector(`#${list.getAttribute('aria-describedby')}`)).not.toBeNull();
        const active = document.getElementById(list.getAttribute('aria-activedescendant'));
        expect(list.contains(active)).toBe(true);
        expect(active.getAttribute('aria-selected')).toBe('true');
    });

    test('an empty equipment slot still has an explicit clear choice and readable empty state', () => {
        const { element, list } = make({ items: [] });
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(1);
        expect(list.querySelector('[aria-selected="true"]').dataset.itemHrid).toBe('');
        expect(element.textContent).toContain('No matching equipment');
    });
});
