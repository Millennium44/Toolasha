/** @vitest-environment happy-dom */
/**
 * Currency token tooltips — driven through the shared tooltip observer's
 * classification rather than probes of its own.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));

vi.mock('../../core/config.js', () => ({
    default: { isFeatureEnabled: () => true, getSetting: () => true, COLOR_TOOLTIP_INFO: '#abc' },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/cowbell': { name: 'Cowbell' },
                '/items/bag_of_10_cowbells': { name: 'Bag Of 10 Cowbells' },
                '/items/log': { name: 'Log' },
            },
        }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid) => (hrid === '/items/bag_of_10_cowbells' ? { ask: 1000, bid: 900 } : null),
}));
vi.mock('../market/expected-value-calculator.js', () => ({ default: { calculateExpectedValue: () => null } }));
vi.mock('../../utils/dom.js', () => ({
    default: {
        fixTooltipOverflow: vi.fn(),
        createStyledDiv: (_style, text, className) => {
            const div = document.createElement('div');
            div.className = className;
            div.textContent = text;
            return div;
        },
    },
}));

const { default: feature } = await import('./dungeon-token-tooltips.js');
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

/**
 * @param {string} itemName
 * @returns {HTMLElement}
 */
function collectionTooltip(itemName) {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="Collection_tooltipContent__x">
        <div class="Collection_name__y">${itemName}</div></div></div>`;
    document.body.appendChild(el);
    return el;
}

beforeEach(async () => {
    document.body.innerHTML = '';
    await feature.initialize();
});

afterEach(() => {
    feature.cleanup();
    tooltipObserver.disable();
});

describe('token values through the tooltip observer', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('DungeonTokenTooltips')).toBe(true);
    });

    test('a cowbell item tooltip gets its value line', async () => {
        const el = itemTooltip('Cowbell');
        observerState.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.dungeon-token-shop-injected')).not.toBeNull();
        expect(el.dataset.dungeonProcessed).toBe('true');
    });

    test('a cowbell collection tooltip gets its value line in the collection content', async () => {
        const el = collectionTooltip('Cowbell');
        observerState.handler(el);
        await Promise.resolve();
        expect(el.querySelector('[class*="Collection_tooltipContent"] .dungeon-token-shop-injected')).not.toBeNull();
    });

    test('a non-token item is left alone, but marked processed', async () => {
        const el = itemTooltip('Log');
        observerState.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.dungeon-token-shop-injected')).toBeNull();
        expect(el.dataset.dungeonProcessed).toBe('true');
    });

    test('a popper that is not a tooltip is not touched', async () => {
        const el = document.createElement('div');
        el.className = 'MuiPopper-root';
        el.innerHTML = '<div class="ItemTooltipText_name__2JAHA"><span>Cowbell</span></div>';
        document.body.appendChild(el);
        observerState.handler(el);
        await Promise.resolve();
        expect(el.dataset.dungeonProcessed).toBeUndefined();
    });

    test('cleanup unsubscribes', () => {
        feature.cleanup();
        expect(tooltipObserver.subscribers.has('DungeonTokenTooltips')).toBe(false);
    });
});
