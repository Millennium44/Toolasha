/** @vitest-environment happy-dom */
/**
 * Consumable tooltips — driven through the shared tooltip observer's
 * classification rather than probes of its own.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, COLOR_TOOLTIP_INFO: '#abc' },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/cheese': {
            name: 'Cheese',
            consumableDetail: { hitpointRestore: 100, cooldownDuration: 30e9 },
        },
        '/items/log': { name: 'Log' },
    };
    return {
        default: {
            getInitClientData: () => ({ itemDetailMap }),
            getItemDetails: (hrid) => itemDetailMap[hrid] || null,
        },
    };
});
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => ({ ask: 50, bid: 40 }) },
}));
vi.mock('../../utils/dom.js', () => ({
    default: {
        addStyles: vi.fn(),
        fixTooltipOverflow: vi.fn(),
        createStyledDiv: (_style, text, className) => {
            const div = document.createElement('div');
            div.className = className;
            div.textContent = text;
            return div;
        },
    },
}));

const { default: tooltipConsumables } = await import('./tooltip-consumables.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} itemName
 * @returns {HTMLElement}
 */
function itemTooltip(itemName) {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__x">
        <div class="ItemTooltipText_name__2JAHA"><span>${itemName}</span></div></div></div>`;
    document.body.appendChild(el);
    return el;
}

beforeEach(async () => {
    document.body.innerHTML = '';
    await tooltipConsumables.initialize();
});

afterEach(() => {
    tooltipConsumables.unregisterObserver?.();
    tooltipConsumables.unregisterObserver = null;
    tooltipConsumables.isInitialized = false;
    tooltipObserver.disable();
});

describe('consumable stats through the tooltip observer', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('TooltipConsumables')).toBe(true);
    });

    test('a consumable item tooltip gets its stats section', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.consumable-stats-injected')).not.toBeNull();
        expect(el.dataset.consumablesProcessedItem).toBe('Cheese');
    });

    test('a non-consumable item is left alone', async () => {
        const el = itemTooltip('Log');
        observerState.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.consumable-stats-injected')).toBeNull();
    });

    test('a tooltip without an item name is not an item tooltip', async () => {
        const el = document.createElement('div');
        el.className = 'MuiTooltip-popper';
        el.innerHTML = '<div>Just text</div>';
        document.body.appendChild(el);
        observerState.handler(el);
        await Promise.resolve();
        expect(el.dataset.consumablesProcessedItem).toBeUndefined();
    });

    test('handleTooltip classifies for itself when called without a classification', async () => {
        const el = itemTooltip('Cheese');
        await tooltipConsumables.handleTooltip(el);
        expect(el.querySelector('.consumable-stats-injected')).not.toBeNull();
    });

    test('extractItemHrid resolves the name through game data', () => {
        expect(tooltipConsumables.extractItemHrid(itemTooltip('Cheese'))).toBe('/items/cheese');
        expect(tooltipConsumables.extractItemHrid(itemTooltip('Nothing'))).toBeNull();
    });
});
