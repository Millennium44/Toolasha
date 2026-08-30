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
        expect(el.dataset.dungeonProcessedItem).toBe('Cowbell');
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
        expect(el.dataset.dungeonProcessedItem).toBe('Log');
    });

    test('a popper that is not a tooltip is not touched', async () => {
        const el = document.createElement('div');
        el.className = 'MuiPopper-root';
        el.innerHTML = '<div class="ItemTooltipText_name__2JAHA"><span>Cowbell</span></div>';
        document.body.appendChild(el);
        observerState.handler(el);
        await Promise.resolve();
        expect(el.dataset.dungeonProcessedItem).toBeUndefined();
    });

    test('cleanup unsubscribes', () => {
        feature.cleanup();
        expect(tooltipObserver.subscribers.has('DungeonTokenTooltips')).toBe(false);
    });

    // tooltip-observer.js redelivers a popper as freshly "opened" once it has been seen to
    // leave and return to the document (its `open`/`delivered` bookkeeping is cleared on a
    // genuine disconnect — see tooltip-observer.test.js's "notifies subscribers with 'closed'"
    // cases). That is exactly what happens when the game closes one item's tooltip and reopens
    // a new one for the next item hovered, reusing the same popper element instead of building
    // a new one — the fix in commit 6dc52988 ("clear stale tooltip injections when item
    // changes") exists in tooltip-prices.js for this precise reason, keying its "already
    // processed" guard on the item name so a hover of a different item is reprocessed and
    // stale content cleared. This module's guard was `dataset.dungeonProcessed === 'true'`
    // with no item identity in it at all, so once any item had been processed on a given
    // popper element, every later item reusing that element was silently ignored — whatever
    // was injected for the first item stayed on screen under the new item's name.
    test('a reused tooltip element is reprocessed when the game swaps in a different item', async () => {
        const el = itemTooltip('Cowbell');
        observerState.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.dungeon-token-shop-injected')).not.toBeNull();

        // The tooltip closes (removed from the document) and tooltip-observer's removal
        // watcher settles it — flushing its MutationObserver microtask, per
        // tooltip-observer.test.js — before the game reuses the same element for the next item.
        el.remove();
        await Promise.resolve();
        await Promise.resolve();

        const nameEl = el.querySelector('.ItemTooltipText_name__2JAHA span');
        nameEl.textContent = 'Log';
        document.body.appendChild(el);
        observerState.handler(el);
        await Promise.resolve();

        // The stale Cowbell value line must not still be showing under the Log tooltip
        expect(el.querySelector('.dungeon-token-shop-injected')).toBeNull();
    });
});
