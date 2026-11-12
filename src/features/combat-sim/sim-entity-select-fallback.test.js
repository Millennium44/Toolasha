/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
import { populateSimEntitySelect } from './sim-entity-select.js';

vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));
vi.mock('../../utils/performance-monitor.js', () => ({ default: { enabled: false } }));

const entries = [
    { hrid: '/monsters/shadow_archer', name: 'Shadow Archer' },
    { hrid: '/monsters/pyre_hunter', name: 'Pyre Hunter' },
    { hrid: '/monsters/frost_sniper', name: 'Pyre Hunter' },
    { hrid: '/monsters/fly', name: '<b>Fly</b>' },
];
let panel;
let select;

const button = () => panel.querySelector('button[role="combobox"]');
const popup = () => document.querySelector('[role="listbox"]');
const rows = () => [...document.querySelectorAll('[role="option"]')];
const key = (k) => button().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
    resetSpriteSheetCache();
    const native = document.createElement('div');
    native.innerHTML = '<svg><use xlink:href="/static/media/combat_monsters_sprite.test.svg#seed"></use></svg>';
    document.body.append(native);
    panel = document.createElement('section');
    panel.innerHTML = '<label for="m">Monster</label><select id="m" class="toolasha-select" style="flex:1"></select>';
    document.body.append(panel);
    select = panel.querySelector('select');
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
});
afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('toolasha-sim-entity-select-fallback-styles')?.remove();
    resetSpriteSheetCache();
    vi.unstubAllGlobals();
});

describe('fallback icon dropdown', () => {
    test('renders icons and escaped labels, select is hidden but still the source of truth', () => {
        populateSimEntitySelect(select, entries);
        expect(select.classList.contains('toolasha-sim-entity-select-hidden')).toBe(true);
        expect(button().querySelector('use')).not.toBeNull();
        expect(button().textContent).toContain('Shadow Archer');
        button().click();
        expect(popup().style.zIndex).toBe('1200');
        expect(rows()).toHaveLength(4);
        expect(rows()[0].querySelector('use')).not.toBeNull();
        expect(rows()[3].textContent).toBe('<b>Fly</b>');
        expect(rows()[3].querySelector('b')).toBeNull();
        expect(rows()[0].getAttribute('aria-selected')).toBe('true');
        expect(button().getAttribute('aria-expanded')).toBe('true');
    });

    test('clicking a row (duplicate names) selects by identity and fires change on the real select', () => {
        populateSimEntitySelect(select, entries);
        const changed = vi.fn();
        select.addEventListener('change', changed);
        button().click();
        rows()[2].click();
        expect(select.value).toBe('/monsters/frost_sniper');
        expect(changed).toHaveBeenCalledOnce();
        expect(popup()).toBeNull();
        expect(button().querySelector('use').getAttribute('href')).toContain('#frost_sniper');
    });

    test('programmatic value writes update the button', () => {
        populateSimEntitySelect(select, entries);
        select.value = '/monsters/fly';
        expect(button().textContent).toContain('<b>Fly</b>');
        select.selectedIndex = 1;
        expect(button().textContent).toContain('Pyre Hunter');
    });

    test('keyboard: open, navigate, Home/End, select, Escape, type-ahead', () => {
        populateSimEntitySelect(select, entries);
        const changed = vi.fn();
        select.addEventListener('change', changed);
        key('ArrowDown');
        expect(popup()).not.toBeNull();
        key('ArrowDown');
        key('End');
        expect(button().getAttribute('aria-activedescendant')).toBe(rows()[3].id);
        key('Home');
        expect(button().getAttribute('aria-activedescendant')).toBe(rows()[0].id);
        key('Escape');
        expect(popup()).toBeNull();
        expect(changed).not.toHaveBeenCalled();
        key('p');
        expect(popup()).not.toBeNull();
        expect(button().getAttribute('aria-activedescendant')).toBe(rows()[1].id);
        key('Enter');
        expect(select.value).toBe('/monsters/pyre_hunter');
        expect(changed).toHaveBeenCalledOnce();
        key(' ');
        key('ArrowUp');
        key(' ');
        expect(select.value).toBe('/monsters/shadow_archer');
    });

    test('disabled and hidden options are skipped; a disabled select cannot open', async () => {
        populateSimEntitySelect(select, entries);
        select.options[1].disabled = true;
        select.options[2].hidden = true;
        key('ArrowDown');
        expect(rows()).toHaveLength(3);
        expect(rows()[1].getAttribute('aria-disabled')).toBe('true');
        key('ArrowDown');
        expect(button().getAttribute('aria-activedescendant')).toBe(rows()[2].id);
        key('Escape');
        select.disabled = true;
        await wait();
        expect(button().disabled).toBe(true);
        button().click();
        expect(popup()).toBeNull();
    });

    test('outside click, scroll and resize close it; scrolling inside the popup does not', () => {
        populateSimEntitySelect(select, entries);
        button().click();
        popup().dispatchEvent(new Event('scroll'));
        expect(popup()).not.toBeNull();
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(popup()).toBeNull();
        button().click();
        window.dispatchEvent(new Event('resize'));
        expect(popup()).toBeNull();
        button().click();
        document.dispatchEvent(new Event('scroll'));
        expect(popup()).toBeNull();
    });

    test('repopulating reuses one button, reflects the new list and empty input', async () => {
        populateSimEntitySelect(select, entries);
        populateSimEntitySelect(select, entries.slice(1));
        await wait();
        expect(panel.querySelectorAll('button')).toHaveLength(1);
        button().click();
        expect(rows()).toHaveLength(3);
        populateSimEntitySelect(select, []);
        expect(popup()).toBeNull();
        expect(button().textContent).not.toContain('Pyre');
        button().click();
        expect(rows()).toHaveLength(0);
    });

    test('external option rewrite and display:none on the select are followed', async () => {
        populateSimEntitySelect(select, entries);
        select.innerHTML = '<option value="/monsters/fly">Only Fly</option>';
        await wait();
        expect(button().textContent).toContain('Only Fly');
        select.style.display = 'none';
        await wait();
        expect(button().style.display).toBe('none');
        select.style.display = '';
        await wait();
        expect(button().style.display).toBe('');
    });

    test('removing the select cleans up the button, popup and property shadows', async () => {
        populateSimEntitySelect(select, entries);
        button().click();
        select.remove();
        await wait();
        expect(panel.querySelector('button')).toBeNull();
        expect(popup()).toBeNull();
        expect(Object.hasOwn(select, 'value')).toBe(false);
    });

    test('rich browsers are unchanged and drop any earlier fallback', () => {
        populateSimEntitySelect(select, entries);
        CSS.supports.mockReturnValue(true);
        populateSimEntitySelect(select, entries);
        expect(panel.querySelector('button[role="combobox"]')).toBeNull();
        expect(select.classList.contains('toolasha-sim-entity-select-hidden')).toBe(false);
        expect(select.querySelector('selectedcontent')).not.toBeNull();
    });

    test('Space keyup is cancelled, open focuses the button, empty list does not open, label names and focuses', () => {
        populateSimEntitySelect(select, entries);
        const up = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
        button().dispatchEvent(up);
        expect(up.defaultPrevented).toBe(true);
        button().click();
        expect(document.activeElement).toBe(button());
        expect(button().getAttribute('aria-label')).toBe('Monster');
        button().blur();
        panel.querySelector('label').click();
        expect(document.activeElement).toBe(button());
        populateSimEntitySelect(select, []);
        button().click();
        expect(popup()).toBeNull();
    });
});
