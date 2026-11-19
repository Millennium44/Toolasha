/** @vitest-environment happy-dom
 *
 * With the real simulator list: the Shykai Test build has its own sidebar link, and opening it refreshes the
 * bridged snapshot the same way the main one does (the sim page imports from that snapshot).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ saveSimulatorSnapshot: null }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, COLOR_ACCENT: '#fff' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'self-1',
        saveSimulatorSnapshot: (...args) => state.saveSimulatorSnapshot(...args),
    },
}));

const externalLinks = (await import('./external-links.js')).default;

beforeEach(() => {
    document.body.innerHTML = '';
    state.saveSimulatorSnapshot = vi.fn(() => true);
});

describe('the Shykai Test build link', () => {
    test('appears beside the main Shykai link and opens the Test page after refreshing the snapshot', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        externalLinks.addLinks(container);

        const labels = [...container.querySelectorAll('.mwi-external-link')].map((link) => link.textContent);
        expect(labels.indexOf('Combat Sim (Test)')).toBe(labels.indexOf('Combat Sim') + 1);

        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
        [...container.querySelectorAll('.mwi-external-link')]
            .find((link) => link.textContent === 'Combat Sim (Test)')
            .click();

        expect(state.saveSimulatorSnapshot).toHaveBeenCalledTimes(1);
        expect(openSpy).toHaveBeenCalledWith(
            'https://shykai.github.io/MWICombatSimulatorTest/Test/',
            '_blank',
            'noopener'
        );
    });
});
