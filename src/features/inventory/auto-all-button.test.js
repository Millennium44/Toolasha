/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    callback: null,
    settings: {
        autoAllButton: true,
        autoAllButton_excludeSeals: false,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => state.settings[key] },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/chest': { name: 'Chest', isOpenable: true },
            },
        }),
    },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: {
        subscribe: vi.fn((_name, callback) => {
            state.callback = callback;
        }),
        unsubscribe: vi.fn(() => {
            state.callback = null;
        }),
    },
}));

const { default: autoAllButton } = await import('./auto-all-button.js');

function openableContainer() {
    const container = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'Item_name';
    name.textContent = 'Chest';
    const all = document.createElement('button');
    all.textContent = 'All';
    container.append(name, all);
    document.body.appendChild(container);
    return { container, all };
}

beforeEach(() => {
    vi.useFakeTimers();
    state.settings.autoAllButton = true;
    autoAllButton.initialize();
});

afterEach(() => {
    autoAllButton.cleanup();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe('delayed All-button click', () => {
    test('clicks All after the container has rendered', () => {
        const { container, all } = openableContainer();
        const click = vi.spyOn(all, 'click');

        state.callback(container, 'opened');
        vi.advanceTimersByTime(50);

        expect(click).toHaveBeenCalledOnce();
    });

    test('does not click after the feature is disabled', () => {
        const { container, all } = openableContainer();
        const click = vi.spyOn(all, 'click');

        state.callback(container, 'opened');
        autoAllButton.cleanup();
        vi.advanceTimersByTime(50);

        expect(click).not.toHaveBeenCalled();
    });

    test('does not click a menu that closes before the render delay expires', () => {
        const { container, all } = openableContainer();
        const click = vi.spyOn(all, 'click');

        state.callback(container, 'opened');
        state.callback(container, 'closed');
        vi.advanceTimersByTime(50);

        expect(click).not.toHaveBeenCalled();
    });

    test('does not click a detached menu before its closed event is delivered', () => {
        const { container, all } = openableContainer();
        const click = vi.spyOn(all, 'click');

        state.callback(container, 'opened');
        container.remove();
        vi.advanceTimersByTime(50);

        expect(click).not.toHaveBeenCalled();
    });

    test('clicks once per opening when the game reuses a menu node', () => {
        const { container, all } = openableContainer();
        const click = vi.spyOn(all, 'click');

        state.callback(container, 'opened');
        state.callback(container, 'opened');
        vi.advanceTimersByTime(50);
        expect(click).toHaveBeenCalledOnce();

        state.callback(container, 'closed');
        state.callback(container, 'opened');
        state.callback(container, 'opened');
        vi.advanceTimersByTime(50);

        expect(click).toHaveBeenCalledTimes(2);
    });

    test('a reopened menu gets its own full render delay', () => {
        const { container, all } = openableContainer();
        const click = vi.spyOn(all, 'click');

        state.callback(container, 'opened');
        vi.advanceTimersByTime(25);
        state.callback(container, 'closed');
        state.callback(container, 'opened');
        vi.advanceTimersByTime(25);
        expect(click).not.toHaveBeenCalled();

        vi.advanceTimersByTime(25);
        expect(click).toHaveBeenCalledOnce();
    });

    test('closing one menu leaves another menu pending', () => {
        const first = openableContainer();
        const second = openableContainer();
        const firstClick = vi.spyOn(first.all, 'click');
        const secondClick = vi.spyOn(second.all, 'click');

        state.callback(first.container, 'opened');
        state.callback(second.container, 'opened');
        state.callback(first.container, 'closed');
        vi.advanceTimersByTime(50);

        expect(firstClick).not.toHaveBeenCalled();
        expect(secondClick).toHaveBeenCalledOnce();
    });
});
