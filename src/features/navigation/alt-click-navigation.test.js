/** @vitest-environment happy-dom */
/**
 * Alt+Click navigation — the hovered-item tracking it does through the shared
 * tooltip observer. The click handling itself is not exercised here.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../utils/item-navigation.js', () => ({ navigateToItem: vi.fn() }));

const { default: altClickNavigation } = await import('./alt-click-navigation.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} innerHTML
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function popper(innerHTML, className = 'MuiTooltip-popper') {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = innerHTML;
    document.body.appendChild(el);
    return el;
}

beforeEach(() => {
    document.body.innerHTML = '';
    altClickNavigation.initialize();
});

afterEach(() => {
    altClickNavigation.disable();
    tooltipObserver.disable();
});

describe('hovered item tracking through the tooltip observer', () => {
    test('subscribes to the shared observer rather than registering a class handler', () => {
        expect(tooltipObserver.subscribers.has('AltClickNav')).toBe(true);
    });

    test('an item link in the tooltip names the item', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        expect(altClickNavigation.currentItemHrid).toBe('/items/cheese');
    });

    test('a sprite reference names the item when there is no link', () => {
        observerState.handler(popper('<svg><use href="/static/media/items_sprite.abc.svg#milk"></use></svg>'));
        expect(altClickNavigation.currentItemHrid).toBe('/items/milk');
    });

    test('the name falls back to a slug of the item name', () => {
        observerState.handler(popper('<div class="ItemTooltipText_name__2JAHA"><span>Griffin Bulwark</span></div>'));
        expect(altClickNavigation.currentItemHrid).toBe('/items/griffin_bulwark');
    });

    test('a tooltip with no item resets the tracked item', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        observerState.handler(popper('<div>Just text</div>'));
        expect(altClickNavigation.currentItemHrid).toBeNull();
    });

    test('a popper that is not a tooltip is ignored', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        observerState.handler(popper('<div>Menu</div>', 'MuiPopper-root'));
        expect(altClickNavigation.currentItemHrid).toBe('/items/cheese');
    });

    test('disable unsubscribes', () => {
        altClickNavigation.disable();
        expect(tooltipObserver.subscribers.has('AltClickNav')).toBe(false);
    });
});
