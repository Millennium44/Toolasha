/** @vitest-environment happy-dom */
/**
 * Tests for the drink timer's update plumbing.
 *
 * The arithmetic lives in drink-calculator and has its own tests; what this
 * pins is how the panel reacts to inventory churn: a burst of updates is one
 * redraw, the redraw goes to the containers the DOM observer handed over (not
 * a fresh document scan), and a container that has left the page is forgotten.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const game = vi.hoisted(() => ({
    listeners: new Map(),
    currentActions: [],
    actions: {},
}));

const observer = vi.hoisted(() => ({
    /** class substring → callback, as registered by initialize() */
    handlers: new Map(),
}));

const calc = vi.hoisted(() => ({
    calls: 0,
    drinks: [{ itemHrid: '/items/wisdom_tea', name: 'Wisdom Tea', totalSeconds: 10 * 3600 }],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => fallback,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, fn) => game.listeners.set(event, fn),
        off: (event) => game.listeners.delete(event),
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actions[hrid] ?? null,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            observer.handlers.set(className, callback);
            return () => observer.handlers.delete(className);
        },
    },
}));

vi.mock('../notifications/notification-service.js', () => ({
    default: { notify: () => {} },
}));

vi.mock('../../utils/drink-calculator.js', () => ({
    calculateDrinkRemainingSeconds: () => {
        calc.calls++;
        return calc.drinks;
    },
    calculateQueueTimeSeconds: () => 0,
}));

const { default: drinkTimer } = await import('./drink-timer.js');

const WOODCUTTING = '/action_types/woodcutting';

/**
 * A consumables container holding a slots element the fiber walk can resolve
 * to an action type: #root's fiber is made to *be* the slots element's fiber.
 * @param {string} actionTypeHrid
 * @returns {HTMLElement}
 */
function mountContainer(actionTypeHrid = WOODCUTTING) {
    const container = document.createElement('div');
    container.className = 'GatheringProductionSkillPanel_consumablesContainer__abc';
    const slots = document.createElement('div');
    slots.className = 'ActionTypeConsumableSlots_actionTypeConsumableSlots__xyz';
    container.appendChild(slots);
    document.body.appendChild(container);
    document.getElementById('root')._reactRootContainer = {
        current: { stateNode: slots, return: { memoizedProps: { actionTypeHrid } } },
    };
    return container;
}

beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
    game.listeners.clear();
    game.currentActions = [];
    game.actions = {};
    observer.handlers.clear();
    calc.calls = 0;
});

afterEach(() => {
    drinkTimer.cleanup();
    vi.useRealTimers();
});

describe('drink timer updates', () => {
    test('draws a container the observer hands over', () => {
        drinkTimer.initialize();
        const container = mountContainer();

        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);

        expect(container.querySelector('.mwi-drink-timer')?.textContent).toContain('Wisdom Tea: 10h');
        expect(calc.calls).toBe(1);
    });

    test('a burst of inventory updates is one redraw, after the debounce', () => {
        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);
        calc.calls = 0;

        const onItems = game.listeners.get('items_updated');
        onItems();
        onItems();
        game.listeners.get('consumables_updated')();
        expect(calc.calls).toBe(0); // nothing yet — the burst is still arriving

        vi.advanceTimersByTime(299);
        expect(calc.calls).toBe(0);
        vi.advanceTimersByTime(1);
        expect(calc.calls).toBe(1);
        expect(container.querySelectorAll('.mwi-drink-timer')).toHaveLength(1);
    });

    test('a container that has left the document is dropped, not redrawn', () => {
        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);
        calc.calls = 0;

        container.remove();
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);

        expect(calc.calls).toBe(0);
        // And it stays forgotten: a later update does not revisit it either
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(calc.calls).toBe(0);
    });

    test('containers already on screen at start-up are picked up once', () => {
        const container = mountContainer();

        drinkTimer.initialize();

        expect(container.querySelector('.mwi-drink-timer')).not.toBeNull();
        expect(calc.calls).toBe(1);
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(calc.calls).toBe(2);
    });

    test('cleanup cancels a pending redraw and removes the rows', () => {
        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);
        game.listeners.get('items_updated')();
        calc.calls = 0;

        drinkTimer.cleanup();
        vi.advanceTimersByTime(1000);

        expect(calc.calls).toBe(0);
        expect(container.querySelector('.mwi-drink-timer')).toBeNull();
        expect(game.listeners.size).toBe(0);
    });
});
