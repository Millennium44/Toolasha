/** @vitest-environment happy-dom */
/**
 * Tests for Action Panel Display Helper
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const game = vi.hoisted(() => ({ handlers: {}, details: {} }));
vi.mock('../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.handlers[event] === handler) delete game.handlers[event];
        },
        getActionDetails: (hrid) => game.details[hrid] ?? null,
    },
}));

/** The class handlers the dispatcher registers, driven by hand */
const observer = vi.hoisted(() => ({ handlers: [] }));
vi.mock('../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((name, classNames, callback) => {
            const handler = { name, classNames, callback };
            observer.handlers.push(handler);
            return () => {
                const index = observer.handlers.indexOf(handler);
                if (index > -1) observer.handlers.splice(index, 1);
            };
        }),
    },
}));

/** Name → hrid, and how often the lookup ran — the cost the dispatcher exists to share */
const lookups = vi.hoisted(() => ({ byName: {}, calls: 0 }));
vi.mock('./game-lookups.js', () => ({
    getActionHridFromName: vi.fn((name) => {
        lookups.calls += 1;
        return lookups.byName[name] ?? null;
    }),
}));

const {
    findActionInput,
    attachInputListeners,
    performInitialUpdate,
    refreshActionPanels,
    onActionPanelsRefresh,
    onDetailPanel,
    onActionTile,
    resolveDetailPanel,
    resolveActionTile,
} = await import('./action-panel-helper.js');

beforeEach(() => {
    document.body.innerHTML = '';
    game.handlers = {};
    game.details = {};
    lookups.byName = {};
    lookups.calls = 0;
    vi.useRealTimers();
});

/** A detail panel (or tile) whose title element carries `className` */
function buildTitled(className, title) {
    const panel = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = className;
    nameEl.textContent = title;
    panel.appendChild(nameEl);
    document.body.appendChild(panel);
    return { panel, nameEl };
}

/** The handler registered for a class, to drive it the way the observer would */
function handlerFor(className) {
    return observer.handlers.find((h) => h.classNames === className);
}

describe('onDetailPanel', () => {
    const SWORD = '/actions/cheesesmithing/cheesy_sword';

    test('resolves a panel once and hands the same context to every subscriber, in subscription order', () => {
        lookups.byName = { 'Cheesy Sword': SWORD };
        game.details = { [SWORD]: { name: 'Cheesy Sword', type: '/action_types/cheesesmithing' } };
        const order = [];
        const contexts = [];
        const subscribe = (label) =>
            onDetailPanel((context) => {
                order.push(label);
                contexts.push(context);
            });
        const offA = subscribe('a');
        const offB = subscribe('b');
        const offC = subscribe('c');

        // One class handler serves all three
        expect(observer.handlers).toHaveLength(1);
        const handler = handlerFor('SkillActionDetail_skillActionDetail');
        expect(handler).toBeDefined();

        const { panel, nameEl } = buildTitled('SkillActionDetail_name__x', 'Cheesy Sword');
        handler.callback(panel);

        expect(order).toEqual(['a', 'b', 'c']);
        expect(lookups.calls).toBe(1);
        expect(contexts[0]).toBe(contexts[1]);
        expect(contexts[0]).toEqual({
            panel,
            nameElement: nameEl,
            actionName: 'Cheesy Sword',
            actionHrid: SWORD,
            actionDetails: game.details[SWORD],
        });

        offA();
        offB();
        offC();
    });

    test('a panel seen again with the same title is not looked up again; a new title is', () => {
        lookups.byName = { 'Cheesy Sword': SWORD, 'Cheese Gauntlets': '/actions/cheesesmithing/cheese_gauntlets' };
        const seen = [];
        const off = onDetailPanel((context) => seen.push(context.actionHrid));
        const handler = handlerFor('SkillActionDetail_skillActionDetail');
        const { panel, nameEl } = buildTitled('SkillActionDetail_name__x', 'Cheesy Sword');

        handler.callback(panel);
        handler.callback(panel);
        expect(lookups.calls).toBe(1);
        // Input handlers resolving the panel later share the cache
        expect(resolveDetailPanel(panel).actionHrid).toBe(SWORD);
        expect(lookups.calls).toBe(1);

        // React reused the panel for another action
        nameEl.textContent = 'Cheese Gauntlets';
        handler.callback(panel);
        expect(lookups.calls).toBe(2);
        expect(seen).toEqual([SWORD, SWORD, '/actions/cheesesmithing/cheese_gauntlets']);
        off();
    });

    test('a miss is not remembered, so game data arriving later is picked up', () => {
        const off = onDetailPanel(() => {});
        const handler = handlerFor('SkillActionDetail_skillActionDetail');
        const { panel } = buildTitled('SkillActionDetail_name__x', 'Cheesy Sword');

        handler.callback(panel);
        expect(resolveDetailPanel(panel).actionHrid).toBeNull();
        lookups.byName = { 'Cheesy Sword': SWORD };
        expect(resolveDetailPanel(panel).actionHrid).toBe(SWORD);
        expect(lookups.calls).toBe(3);
        off();
    });

    test('a panel without a title still reaches subscribers, unresolved', () => {
        const seen = [];
        const off = onDetailPanel((context) => seen.push(context));
        const panel = document.createElement('div');
        handlerFor('SkillActionDetail_skillActionDetail').callback(panel);
        expect(seen).toEqual([{ panel, nameElement: null, actionName: '', actionHrid: null, actionDetails: null }]);
        expect(lookups.calls).toBe(0);
        off();
    });

    test('unsubscribing drops only that subscriber; the last one out removes the class handler', () => {
        const first = vi.fn();
        const second = vi.fn();
        const offFirst = onDetailPanel(first);
        const offSecond = onDetailPanel(second);
        const handler = handlerFor('SkillActionDetail_skillActionDetail');
        const { panel } = buildTitled('SkillActionDetail_name__x', 'Cheesy Sword');

        offFirst();
        // Idempotent: a second call does not disturb the remaining subscriber
        offFirst();
        handler.callback(panel);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        expect(observer.handlers).toHaveLength(1);

        offSecond();
        expect(observer.handlers).toHaveLength(0);

        // A fresh subscription registers afresh
        const offAgain = onDetailPanel(() => {});
        expect(observer.handlers).toHaveLength(1);
        offAgain();
        expect(observer.handlers).toHaveLength(0);
    });

    test('a subscriber that throws does not stop the ones after it', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const after = vi.fn();
        const offThrower = onDetailPanel(() => {
            throw new Error('boom');
        });
        const offAfter = onDetailPanel(after);
        const { panel } = buildTitled('SkillActionDetail_name__x', 'Cheesy Sword');

        handlerFor('SkillActionDetail_skillActionDetail').callback(panel);
        expect(after).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);

        offThrower();
        offAfter();
        errorSpy.mockRestore();
    });

    test('a subscriber unsubscribing mid-dispatch does not skip the next one', () => {
        const later = vi.fn();
        let offSelf = null;
        offSelf = onDetailPanel(() => offSelf());
        const offLater = onDetailPanel(later);
        const { panel } = buildTitled('SkillActionDetail_name__x', 'Cheesy Sword');

        handlerFor('SkillActionDetail_skillActionDetail').callback(panel);
        expect(later).toHaveBeenCalledTimes(1);
        offLater();
    });
});

describe('onActionTile', () => {
    const COW = '/actions/milking/cow';

    test('watches the tile class and reads the tile title by its own text only', () => {
        lookups.byName = { Cow: COW };
        game.details = { [COW]: { name: 'Cow', type: '/action_types/milking' } };
        const seen = [];
        const off = onActionTile((context) => seen.push(context));
        const handler = handlerFor('SkillAction_skillAction');
        expect(handler).toBeDefined();

        const { panel, nameEl } = buildTitled('SkillAction_name__x', 'Cow');
        // A span a feature injected into the title must not poison the lookup
        const badge = document.createElement('span');
        badge.textContent = ' (12 in inventory)';
        nameEl.appendChild(badge);

        handler.callback(panel);
        expect(seen).toEqual([
            { panel, nameElement: nameEl, actionName: 'Cow', actionHrid: COW, actionDetails: game.details[COW] },
        ]);
        expect(resolveActionTile(panel).actionHrid).toBe(COW);
        expect(lookups.calls).toBe(1);
        off();
    });

    test('tiles and detail panels are dispatched separately', () => {
        const tile = vi.fn();
        const detail = vi.fn();
        const offTile = onActionTile(tile);
        const offDetail = onDetailPanel(detail);
        expect(observer.handlers).toHaveLength(2);

        const { panel } = buildTitled('SkillAction_name__x', 'Cow');
        handlerFor('SkillAction_skillAction').callback(panel);
        expect(tile).toHaveBeenCalledTimes(1);
        expect(detail).not.toHaveBeenCalled();

        offTile();
        offDetail();
        expect(observer.handlers).toHaveLength(0);
    });
});

function buildPanel() {
    const panel = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'maxActionCountInput_wrapper';
    const input = document.createElement('input');
    container.appendChild(input);
    panel.appendChild(container);
    document.body.appendChild(panel);
    return { panel, input };
}

describe('refreshActionPanels', () => {
    test('re-runs the callback for every mounted panel with its current input value', () => {
        const a = buildPanel();
        a.panel.className = 'SkillActionDetail_skillActionDetail__x';
        a.input.value = '12';
        const b = buildPanel();
        b.panel.className = 'SkillActionDetail_skillActionDetail__x';
        b.input.value = '7';
        // A panel with no input is skipped rather than called with undefined
        const bare = document.createElement('div');
        bare.className = 'SkillActionDetail_skillActionDetail__x';
        document.body.appendChild(bare);

        const calls = [];
        refreshActionPanels((panel, value) => calls.push([panel, value]));
        expect(calls).toEqual([
            [a.panel, '12'],
            [b.panel, '7'],
        ]);
    });
});

describe('onActionPanelsRefresh', () => {
    test('one subscription and one scan serve every callback, debounced over a burst', () => {
        vi.useFakeTimers();
        const a = buildPanel();
        a.panel.className = 'SkillActionDetail_skillActionDetail__x';
        a.input.value = '3';

        const first = vi.fn();
        const second = vi.fn();
        const offFirst = onActionPanelsRefresh(first);
        const offSecond = onActionPanelsRefresh(second);
        expect(game.handlers.actions_updated).toBeTypeOf('function');

        const querySpy = vi.spyOn(document, 'querySelectorAll');
        game.handlers.actions_updated();
        game.handlers.actions_updated();
        game.handlers.actions_updated();
        expect(first).not.toHaveBeenCalled();

        vi.advanceTimersByTime(200);
        expect(first).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledWith(a.panel, '3');
        expect(second).toHaveBeenCalledTimes(1);
        expect(querySpy).toHaveBeenCalledTimes(1);
        querySpy.mockRestore();

        // The subscription outlives the first unsubscribe and ends with the last
        offFirst();
        expect(game.handlers.actions_updated).toBeTypeOf('function');
        offSecond();
        expect(game.handlers.actions_updated).toBeUndefined();
    });

    test('a callback that throws does not stop the others', () => {
        vi.useFakeTimers();
        const a = buildPanel();
        a.panel.className = 'SkillActionDetail_skillActionDetail__x';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const after = vi.fn();
        const offThrower = onActionPanelsRefresh(() => {
            throw new Error('boom');
        });
        const offAfter = onActionPanelsRefresh(after);

        game.handlers.actions_updated();
        vi.advanceTimersByTime(200);
        expect(after).toHaveBeenCalledTimes(1);

        offThrower();
        offAfter();
        errorSpy.mockRestore();
    });
});

describe('findActionInput', () => {
    test('finds the input nested inside the maxActionCountInput container', () => {
        const { panel, input } = buildPanel();
        expect(findActionInput(panel)).toBe(input);
    });

    test('returns null when the container is missing', () => {
        const panel = document.createElement('div');
        expect(findActionInput(panel)).toBeNull();
    });

    test('returns null when the container has no input inside', () => {
        const panel = document.createElement('div');
        const container = document.createElement('div');
        container.className = 'maxActionCountInput_x';
        panel.appendChild(container);
        expect(findActionInput(panel)).toBeNull();
    });
});

describe('attachInputListeners', () => {
    test('fires the callback on keyup and input events with the current value', () => {
        const { panel, input } = buildPanel();
        input.value = '5';
        const updateCallback = vi.fn();
        attachInputListeners(panel, input, updateCallback);

        input.dispatchEvent(new Event('keyup'));
        expect(updateCallback).toHaveBeenCalledWith('5');

        input.value = '10';
        input.dispatchEvent(new Event('input'));
        expect(updateCallback).toHaveBeenCalledWith('10');
    });

    test('panel clicks fire the callback after the configured delay, skipping clicks on the input itself', () => {
        vi.useFakeTimers();
        const { panel, input } = buildPanel();
        input.value = '3';
        const updateCallback = vi.fn();
        attachInputListeners(panel, input, updateCallback, { clickDelay: 50 });

        // Click on the input itself: should be skipped
        input.dispatchEvent(new Event('click', { bubbles: true }));
        vi.advanceTimersByTime(100);
        expect(updateCallback).not.toHaveBeenCalled();

        // Click elsewhere in the panel: should fire after delay
        panel.dispatchEvent(new Event('click', { bubbles: true }));
        expect(updateCallback).not.toHaveBeenCalled(); // not yet
        vi.advanceTimersByTime(50);
        expect(updateCallback).toHaveBeenCalledWith('3');

        vi.useRealTimers();
    });

    test('the returned cleanup function removes all listeners', () => {
        const { panel, input } = buildPanel();
        const updateCallback = vi.fn();
        const cleanup = attachInputListeners(panel, input, updateCallback);

        cleanup();
        input.dispatchEvent(new Event('keyup'));
        expect(updateCallback).not.toHaveBeenCalled();
    });
});

describe('performInitialUpdate', () => {
    test('calls the callback and returns true when the input already has a value', () => {
        const input = document.createElement('input');
        input.value = '99';
        const updateCallback = vi.fn();

        expect(performInitialUpdate(input, updateCallback)).toBe(true);
        expect(updateCallback).toHaveBeenCalledWith('99');
    });

    test('does nothing and returns false for an empty input', () => {
        const input = document.createElement('input');
        const updateCallback = vi.fn();

        expect(performInitialUpdate(input, updateCallback)).toBe(false);
        expect(updateCallback).not.toHaveBeenCalled();
    });
});
