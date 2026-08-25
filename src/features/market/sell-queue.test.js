/** @vitest-environment happy-dom */
/**
 * Sell Queue — the hovered-item tracking it does through the shared tooltip
 * observer, and the Shift+RightClick that reads it. Tab injection and
 * marketplace navigation are not exercised here.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));
const dataManagerMock = vi.hoisted(() => ({
    getInitClientData: () => ({
        itemDetailMap: { '/items/cheese': { name: 'Cheese', isTradable: true } },
    }),
    // Nothing in the bag: addToQueue returns before touching the marketplace
    getInventory: () => [],
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    createMaterialTab: vi.fn(),
    removeMaterialTabs: vi.fn(),
    setupMarketplaceCleanupObserver: vi.fn(() => () => {}),
    navigateToMarketplace: vi.fn(),
    visibleTabsContainer: () => null,
}));

const { default: sellQueue, navigationBlocked } = await import('./sell-queue.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} innerHTML
 * @returns {HTMLElement}
 */
function popper(innerHTML) {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = innerHTML;
    document.body.appendChild(el);
    return el;
}

/**
 * Shift+RightClick an inventory slot; whether it was taken says whether an
 * item was being tracked
 * @returns {boolean} The event's defaultPrevented
 */
function shiftRightClickInventory() {
    const inventory = document.createElement('div');
    inventory.className = 'Inventory_items__1';
    const slot = document.createElement('div');
    inventory.appendChild(slot);
    document.body.appendChild(inventory);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
    slot.dispatchEvent(event);
    return event.defaultPrevented;
}

beforeEach(() => {
    document.body.innerHTML = '';
    sellQueue.initialize();
});

afterEach(() => {
    sellQueue.cleanup();
    tooltipObserver.disable();
});

describe('hovered item tracking through the tooltip observer', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('SellQueue-Tooltip')).toBe(true);
    });

    test('an item named by its link is queued on Shift+RightClick', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        expect(shiftRightClickInventory()).toBe(true);
    });

    test('an item named by its sprite is queued on Shift+RightClick', () => {
        observerState.handler(popper('<svg><use href="/static/media/items_sprite.abc.svg#cheese"></use></svg>'));
        expect(shiftRightClickInventory()).toBe(true);
    });

    test('an item named only in the tooltip text is slugged to its hrid', () => {
        observerState.handler(popper('<div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>'));
        expect(shiftRightClickInventory()).toBe(true);
    });

    test('a tooltip without an item clears the tracked one', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        observerState.handler(popper('<div>Just text</div>'));
        expect(shiftRightClickInventory()).toBe(false);
    });

    test('cleanup unsubscribes', () => {
        sellQueue.cleanup();
        expect(tooltipObserver.subscribers.has('SellQueue-Tooltip')).toBe(false);
    });
});

describe('the auto-advance waits for the player', () => {
    /**
     * A document stub: the queue's gate only asks two things of it.
     * @param {Object} over - What this document has open / focused
     * @returns {Document} Enough of one
     */
    const doc = ({ modal = false, activeElement = null } = {}) => ({
        querySelector: (selector) => (modal && selector.includes('Modal_modalContainer') ? {} : null),
        activeElement,
    });

    test('an open modal blocks it', () => {
        // The advance is driven by a websocket message, so it can land in the
        // middle of the player pricing something else entirely
        expect(navigationBlocked(doc({ modal: true }))).toBe(true);
    });

    test('a focused text or number field blocks it', () => {
        expect(navigationBlocked(doc({ activeElement: { tagName: 'INPUT', getAttribute: () => 'number' } }))).toBe(
            true
        );
        expect(navigationBlocked(doc({ activeElement: { tagName: 'INPUT', getAttribute: () => null } }))).toBe(true);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'TEXTAREA', getAttribute: () => null } }))).toBe(true);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'DIV', isContentEditable: true } }))).toBe(true);
    });

    test('an ordinary page is not blocked', () => {
        expect(navigationBlocked(doc())).toBe(false);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'BODY', getAttribute: () => null } }))).toBe(false);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'BUTTON', getAttribute: () => null } }))).toBe(false);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'INPUT', getAttribute: () => 'checkbox' } }))).toBe(
            false
        );
    });
});
