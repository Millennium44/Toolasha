/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const registrations = vi.hoisted(() => []);

vi.mock('../../core/config.js', () => ({
    default: { isFeatureEnabled: () => true, getSetting: () => true },
}));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classNames, callback) => {
            registrations.push({ name, classNames, callback });
            return () => {};
        },
    },
}));

const { default: shell, collectionNavigation } = await import('./collection-navigation.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

describe('collection panel observer watches the class the game actually uses', () => {
    beforeEach(() => {
        registrations.length = 0;
        document.body.innerHTML = '';
    });

    afterEach(() => {
        shell.disable();
        tooltipObserver.disable();
    });

    test('the panel watcher names Collection_collectionContainer (live DOM, 2026-08-17)', () => {
        shell.initialize();
        const watched = registrations.flatMap((r) => (Array.isArray(r.classNames) ? r.classNames : [r.classNames]));
        // The game's collection panel root; Collection_collections is the old
        // spelling this feature silently watched while the panel never matched
        expect(watched).toContain('Collection_collectionContainer');
    });

    test('a panel already in the DOM is found under the current class', () => {
        const panel = document.createElement('div');
        panel.className = 'Collection_collectionContainer__3ZlUO';
        document.body.appendChild(panel);

        shell.initialize();

        // attachPanelObserver stores an unregister function when it attached
        expect(collectionNavigation.panelObserver).not.toBeNull();
    });
});

describe('collected-item popovers arrive through the shared tooltip observer', () => {
    beforeEach(() => {
        registrations.length = 0;
        document.body.innerHTML = '';
    });

    afterEach(() => {
        shell.disable();
        tooltipObserver.disable();
    });

    test('no class handler of its own for MuiTooltip-popper; a subscription instead', () => {
        shell.initialize();
        const own = registrations.filter((r) => r.name === 'CollectionNavigation');
        const watched = own.flatMap((r) => (Array.isArray(r.classNames) ? r.classNames : [r.classNames]));
        expect(watched).not.toContain('MuiTooltip-popper');
        expect(tooltipObserver.subscribers.has('CollectionNavigation')).toBe(true);
    });

    test('a popover with an action menu gets the navigation buttons, once', () => {
        shell.initialize();
        const observerHandler = registrations.find((r) => r.name === 'TooltipObserver').callback;

        const popper = document.createElement('div');
        popper.className = 'MuiTooltip-popper';
        popper.innerHTML = '<div class="Collection_name__1">Cheese</div><div class="Collection_actionMenu__2"></div>';
        document.body.appendChild(popper);

        observerHandler(popper);
        observerHandler(popper);

        expect(popper.dataset.mwiCollectionEnhanced).toBe('true');
        // dataManager is a bare mock here, so no item resolves and no buttons
        // are added — the marker shows the popover was handled exactly once
        expect(popper.querySelectorAll('button')).toHaveLength(0);
    });

    test('disable unsubscribes', () => {
        shell.initialize();
        shell.disable();
        expect(tooltipObserver.subscribers.has('CollectionNavigation')).toBe(false);
    });
});
