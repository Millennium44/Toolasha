/** @vitest-environment happy-dom */
/**
 * Tests for Tooltip Observer
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null, unregisterCalled: false }));

vi.mock('./dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {
                observerState.unregisterCalled = true;
            };
        }),
    },
}));

const { default: tooltipObserver, classifyTooltip } = await import('./tooltip-observer.js');

/**
 * A popper as MUI renders it, with whatever content the test needs inside
 * @param {string} innerHTML
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function popper(innerHTML, className = 'MuiTooltip-popper') {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = `<div class="MuiTooltip-tooltip">${innerHTML}</div>`;
    return el;
}

const ITEM_TOOLTIP = `
    <div class="ItemTooltipText_itemTooltipText__abc">
        <div class="ItemTooltipText_name__2JAHA"><span>Griffin Bulwark +7</span></div>
        <div class="ItemTooltipText_description__x">A shield</div>
    </div>`;

const COLLECTION_TOOLTIP = `
    <div class="Collection_tooltipContent__1">
        <div class="Collection_name__2">Cheese</div>
        <div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>
    </div>`;

const ABILITY_TOOLTIP = `
    <div class="Ability_abilityTooltip__1">
        <div class="Ability_name__2">Berserk</div>
        <div>Level: 42</div>
    </div>`;

beforeEach(() => {
    tooltipObserver.disable();
    observerState.handler = null;
    observerState.unregisterCalled = false;
    document.body.innerHTML = '';
});

describe('classifyTooltip', () => {
    test('an item tooltip: name element, name text and enhancement level', () => {
        const el = popper(ITEM_TOOLTIP);
        const info = classifyTooltip(el);
        expect(info.isTooltipPopper).toBe(true);
        expect(info.kind).toBe('item');
        expect(info.isItemTooltip).toBe(true);
        expect(info.isCollectionTooltip).toBe(false);
        expect(info.nameEl).toBe(el.querySelector('div[class*="ItemTooltipText_name"]'));
        expect(info.itemName).toBe('Griffin Bulwark +7');
        expect(info.enhancementLevel).toBe(7);
        expect(info.abilityTooltip).toBeNull();
        expect(info.itemHrid).toBeNull();
    });

    test('an unenhanced item parses to level 0', () => {
        const el = popper('<div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>');
        expect(classifyTooltip(el).enhancementLevel).toBe(0);
    });

    test('a collection tooltip wins over the item markup inside it', () => {
        const el = popper(COLLECTION_TOOLTIP);
        const info = classifyTooltip(el);
        expect(info.kind).toBe('collection');
        expect(info.isCollectionTooltip).toBe(true);
        // Both flags, as the features that key on each need them
        expect(info.isItemTooltip).toBe(true);
        expect(info.collectionContent).toBe(el.querySelector('div[class*="Collection_tooltipContent"]'));
        expect(info.collectionNameEl.textContent).toBe('Cheese');
    });

    test('an ability tooltip is recognized only when it is neither item nor collection', () => {
        const info = classifyTooltip(popper(ABILITY_TOOLTIP));
        expect(info.kind).toBe('ability');
        expect(info.abilityTooltip).not.toBeNull();
        expect(info.nameEl).toBeNull();
    });

    test('anything else is "other"', () => {
        const info = classifyTooltip(popper('<div class="QueuedActions_queuedActionsTooltip__1">3 queued</div>'));
        expect(info.kind).toBe('other');
        expect(info.isTooltipPopper).toBe(true);
    });

    test('a popper that is not a MuiTooltip is not probed at all', () => {
        const el = popper(ITEM_TOOLTIP, 'MuiPopper-root');
        const spy = vi.spyOn(el, 'querySelector');
        const info = classifyTooltip(el);
        expect(info.isTooltipPopper).toBe(false);
        expect(info.kind).toBe('other');
        expect(info.nameEl).toBeNull();
        expect(spy).not.toHaveBeenCalled();
    });

    test('an item link names the item outright, ahead of a sprite reference', () => {
        const el = popper(
            '<a href="/items/cheese/x">Cheese</a><svg><use href="/static/media/items_sprite.abc.svg#milk"></use></svg>'
        );
        expect(classifyTooltip(el).itemHrid).toBe('/items/cheese');
    });

    test('a sprite reference names the item when there is no link', () => {
        const el = popper('<svg><use href="/static/media/items_sprite.abc.svg#milk"></use></svg>');
        expect(classifyTooltip(el).itemHrid).toBe('/items/milk');
    });
});

describe('subscribe / notify', () => {
    test('auto-initializes on first subscriber', () => {
        tooltipObserver.subscribe('A', () => {});
        expect(tooltipObserver.isInitialized).toBe(true);
        expect(observerState.handler).toBeTypeOf('function');
    });

    test('notifies subscribers with "opened" and the classification when a tooltip element appears', () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);

        observerState.handler(tooltip);

        expect(callback).toHaveBeenCalledTimes(1);
        const [element, eventType, info] = callback.mock.calls[0];
        expect(element).toBe(tooltip);
        expect(eventType).toBe('opened');
        expect(info.kind).toBe('item');
        expect(info.itemName).toBe('Griffin Bulwark +7');
    });

    test('classifies once per popper and hands every subscriber the same classification', () => {
        const a = vi.fn();
        const b = vi.fn();
        tooltipObserver.subscribe('A', a);
        tooltipObserver.subscribe('B', b);

        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);
        const spy = vi.spyOn(tooltip, 'querySelector');

        observerState.handler(tooltip);

        expect(a.mock.calls[0][2]).toBe(b.mock.calls[0][2]);
        // One name probe, one collection probe, one link probe, one sprite probe
        // — not one set per subscriber
        const nameProbes = spy.mock.calls.filter(([selector]) => selector.includes('ItemTooltipText_name'));
        expect(nameProbes).toHaveLength(1);
    });

    test('the same popper handed over twice is delivered once', () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);

        // The DOM observer can hand a popper over as the inserted node and
        // again as a descendant of an inserted container
        observerState.handler(tooltip);
        observerState.handler(tooltip);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(tooltipObserver.open.size).toBe(1);
    });

    test('a popper that left the document and came back is delivered again', async () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);
        observerState.handler(tooltip);

        tooltip.remove();
        await Promise.resolve();
        await Promise.resolve();
        expect(callback).toHaveBeenLastCalledWith(tooltip, 'closed', expect.objectContaining({ kind: 'item' }));

        document.body.appendChild(tooltip);
        observerState.handler(tooltip);

        expect(callback.mock.calls.filter(([, type]) => type === 'opened')).toHaveLength(2);
    });

    test('subscribers are notified in subscription order', () => {
        const order = [];
        tooltipObserver.subscribe('prices', () => order.push('prices'));
        tooltipObserver.subscribe('consumables', () => order.push('consumables'));
        tooltipObserver.subscribe('tokens', () => order.push('tokens'));

        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);
        observerState.handler(tooltip);

        expect(order).toEqual(['prices', 'consumables', 'tokens']);
    });

    test('re-subscribing under the same name keeps one entry, moved to the end', () => {
        const order = [];
        tooltipObserver.subscribe('A', () => order.push('A'));
        tooltipObserver.subscribe('B', () => order.push('B'));
        tooltipObserver.unsubscribe('A');
        tooltipObserver.subscribe('A', () => order.push('A2'));

        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);
        observerState.handler(tooltip);

        expect(order).toEqual(['B', 'A2']);
    });

    test('notifies subscribers with "closed" when the tooltip is removed from its parent', async () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        observerState.handler(tooltip);
        callback.mockClear();

        parent.removeChild(tooltip);
        // MutationObserver callbacks fire as a microtask
        await Promise.resolve();
        await Promise.resolve();

        expect(callback).toHaveBeenCalledWith(tooltip, 'closed', expect.anything());
    });

    test('a tooltip torn down with its ancestor is still reported closed, and the observer is let go', async () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const ancestor = document.createElement('div');
        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        ancestor.appendChild(parent);
        document.body.appendChild(ancestor);

        observerState.handler(tooltip);
        callback.mockClear();
        expect(tooltipObserver.removalObserver).not.toBeNull();

        ancestor.remove();
        await Promise.resolve();
        await Promise.resolve();

        expect(callback).toHaveBeenCalledWith(tooltip, 'closed', expect.anything());
        expect(tooltipObserver.open.size).toBe(0);
        expect(tooltipObserver.removalObserver).toBeNull();
    });

    test('two open tooltips share one observer', () => {
        tooltipObserver.subscribe('A', vi.fn());
        const first = document.createElement('div');
        const second = document.createElement('div');
        document.body.append(first, second);
        observerState.handler(first);
        const observer = tooltipObserver.removalObserver;
        observerState.handler(second);
        expect(tooltipObserver.removalObserver).toBe(observer);
        expect(tooltipObserver.open.size).toBe(2);
    });

    test('multiple subscribers are all notified', () => {
        const a = vi.fn();
        const b = vi.fn();
        tooltipObserver.subscribe('A', a);
        tooltipObserver.subscribe('B', b);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        observerState.handler(tooltip);

        expect(a).toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
    });

    test('a subscriber that throws does not prevent others from being notified', () => {
        tooltipObserver.subscribe('Throwing', () => {
            throw new Error('boom');
        });
        const ok = vi.fn();
        tooltipObserver.subscribe('OK', ok);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        expect(() => observerState.handler(tooltip)).not.toThrow();
        expect(ok).toHaveBeenCalled();
    });

    test('unsubscribe stops future notifications', () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);
        tooltipObserver.unsubscribe('A');

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);
        observerState.handler(tooltip);

        expect(callback).not.toHaveBeenCalled();
    });

    test('initialize() is idempotent — calling twice does not re-register the observer', () => {
        tooltipObserver.subscribe('A', () => {});
        const handlerAfterFirst = observerState.handler;
        tooltipObserver.initialize();
        expect(observerState.handler).toBe(handlerAfterFirst);
    });
});

describe('disable', () => {
    test('unregisters the underlying observer and clears subscribers', () => {
        tooltipObserver.subscribe('A', () => {});
        tooltipObserver.disable();

        expect(observerState.unregisterCalled).toBe(true);
        expect(tooltipObserver.isInitialized).toBe(false);
        expect(tooltipObserver.subscribers.size).toBe(0);
    });

    test('a popper open at disable is delivered again after a fresh start', () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);
        const tooltip = popper(ITEM_TOOLTIP);
        document.body.appendChild(tooltip);
        observerState.handler(tooltip);

        tooltipObserver.disable();
        tooltipObserver.subscribe('A', callback);
        observerState.handler(tooltip);

        expect(callback).toHaveBeenCalledTimes(2);
    });
});
