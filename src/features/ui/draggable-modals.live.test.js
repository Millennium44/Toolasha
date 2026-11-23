/** @vitest-environment happy-dom
 *
 * Draggable modals switched on while a modal is already open (the settings modal the
 * player just ticked it in): the class observer only reports modals that open later, so
 * initialize() has to make the open one draggable itself.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

let draggableModals;

beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    ({ draggableModals } = await import('./draggable-modals.js'));
});

describe('draggable modals started with a modal already open', () => {
    test('the open modal gets a drag bar on initialize', async () => {
        const modalBox = document.createElement('div');
        const contentEl = document.createElement('div');
        contentEl.className = 'Modal_modalContent__abc';
        contentEl.innerHTML = '<h2>Settings</h2>';
        modalBox.appendChild(contentEl);
        document.body.appendChild(modalBox);
        modalBox.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, right: 300, bottom: 200, height: 200 });

        await draggableModals.initialize();

        expect(modalBox.dataset.mwiDraggable).toBe('1');
        expect(document.querySelector('.mwi-drag-bar')).not.toBeNull();
    });
});
