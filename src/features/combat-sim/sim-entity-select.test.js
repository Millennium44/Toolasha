/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import domObserver from '../../core/dom-observer.js';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
import { populateSimEntitySelect } from './sim-entity-select.js';
import { watchSimIconRefresh } from './sim-icon-refresh.js';

vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));
vi.mock('../../utils/performance-monitor.js', () => ({ default: { enabled: false } }));

const entries = [
    { hrid: '/monsters/shadow_archer', name: 'Shadow Archer' },
    { hrid: '/monsters/pyre_hunter', name: '同名怪物' },
    { hrid: '/monsters/frost_sniper', name: '同名怪物' },
    { hrid: '/unknown/unsupported', name: '<img src=x> & "Unknown"' },
];
let panel;
let select;
let stop;

function source() {
    const native = document.createElement('div');
    native.innerHTML = '<svg><use xlink:href="/static/media/combat_monsters_sprite.test.svg#seed"></use></svg>';
    document.body.append(native);
    return native;
}

beforeEach(() => {
    resetSpriteSheetCache();
    panel = document.createElement('section');
    panel.innerHTML = '<label for="monster">Monster</label><select id="monster" class="toolasha-select"></select>';
    document.body.append(panel);
    select = panel.querySelector('select');
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});
afterEach(() => {
    stop?.();
    stop = null;
    domObserver.stop();
    document.body.replaceChildren();
    document.getElementById('toolasha-sim-entity-select-styles')?.remove();
    resetSpriteSheetCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('native simulator entity dropdown artwork', () => {
    test('rich choices preserve translated names, duplicate names and explicit identities', () => {
        source();
        populateSimEntitySelect(select, entries);
        expect(select.options).toHaveLength(4);
        expect([...select.options].map((option) => option.value)).toEqual(entries.map((entry) => entry.hrid));
        expect([...select.options].map((option) => option.textContent)).toEqual(entries.map((entry) => entry.name));
        expect([...select.options].map((option) => option.querySelector('use')?.getAttribute('href'))).toEqual([
            '/static/media/combat_monsters_sprite.test.svg#shadow_archer',
            '/static/media/combat_monsters_sprite.test.svg#pyre_hunter',
            '/static/media/combat_monsters_sprite.test.svg#frost_sniper',
            undefined,
        ]);
        expect(select.querySelector('img')).toBeNull();
        expect(select.querySelectorAll('option svg[aria-hidden="true"][focusable="false"]')).toHaveLength(3);
        expect(select.labels[0].textContent).toBe('Monster');
        expect(select.getAttribute('role')).toBeNull();
        expect(select.querySelector('button').type).toBe('button');
        expect(select.querySelector('button selectedcontent')).not.toBeNull();
    });

    test('preserves the same native control, change listeners, value API, focus and disabled state on repopulation', () => {
        const changed = vi.fn();
        select.addEventListener('change', changed);
        select.focus();
        populateSimEntitySelect(select, entries);
        expect(document.activeElement).toBe(select);
        select.value = entries[2].hrid;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(changed).toHaveBeenCalledOnce();
        expect(select.selectedOptions[0].value).toBe(entries[2].hrid);
        select.disabled = true;
        populateSimEntitySelect(select, entries.slice(1));
        expect(select.disabled).toBe(true);
        expect(panel.querySelector('select')).toBe(select);
        expect(select.querySelectorAll('button')).toHaveLength(1);
        expect(document.querySelectorAll('#toolasha-sim-entity-select-styles')).toHaveLength(1);
        expect(changed).toHaveBeenCalledOnce();
        select.value = entries[2].hrid;
        expect(select.selectedIndex).toBe(1);
        populateSimEntitySelect(select, []);
        expect(select.options).toHaveLength(0);
        expect(select.value).toBe('');
    });

    test('unsupported browsers retain plain native choices, safe labels and selection', () => {
        CSS.supports.mockReturnValue(false);
        populateSimEntitySelect(select, entries);
        expect(select.classList.contains('toolasha-sim-entity-select')).toBe(false);
        expect(select.children).toHaveLength(4);
        expect(select.querySelector('button, svg, span, img')).toBeNull();
        expect([...select.options].map((option) => option.textContent)).toEqual(entries.map((entry) => entry.name));
        select.value = entries[2].hrid;
        expect(select.selectedIndex).toBe(2);
        expect(document.getElementById('toolasha-sim-entity-select-styles')).toBeNull();
    });

    test('missing sprites keep names readable and hydrate without replacing the selection or stealing focus', async () => {
        populateSimEntitySelect(select, entries);
        select.value = entries[2].hrid;
        select.focus();
        const option = select.selectedOptions[0];
        expect(select.querySelectorAll('option [data-sim-icon-pending]')).toHaveLength(3);
        expect(option.textContent).toBe('同名怪物');
        stop = watchSimIconRefresh(panel);
        domObserver.dispatch(source());
        await Promise.resolve();
        await Promise.resolve();
        expect(select.selectedOptions[0]).toBe(option);
        expect(select.value).toBe(entries[2].hrid);
        expect(document.activeElement).toBe(select);
        expect(select.querySelectorAll('option [data-sim-icon-pending]')).toHaveLength(0);
        expect(option.querySelector('use').getAttribute('href')).toContain('#frost_sniper');
    });
});
