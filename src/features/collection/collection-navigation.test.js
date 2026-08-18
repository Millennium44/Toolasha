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

describe('collection panel observer watches the class the game actually uses', () => {
    beforeEach(() => {
        registrations.length = 0;
        document.body.innerHTML = '';
    });

    afterEach(() => {
        shell.disable();
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
