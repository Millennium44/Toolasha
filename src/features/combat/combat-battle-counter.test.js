/**
 * @vitest-environment happy-dom
 *
 * The counter's state machine, exercised through the header it draws into.
 * The arithmetic here is "which variant, and what number" — a decision tree
 * that reads game messages and a header title, not a pure function, so it is
 * driven the way combat-level-panel.js is: build the DOM, feed events, read
 * the text back out.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    actions: [],
    actionDetails: {},
    wsHandlers: {},
    dmHandlers: {},
    domObserverCallback: null,
    throwOnUnregister: false,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, className, callback) => {
            game.domObserverCallback = callback;
            return () => {
                game.domObserverCallback = null;
                if (game.throwOnUnregister) throw new Error('boom');
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.actionDetails[hrid],
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));

const combatBattleCounter = (await import('./combat-battle-counter.js')).default;

/** Build the header shape the counter injects into. */
function buildHeader(actionName) {
    document.body.innerHTML = '';
    const currentAction = document.createElement('div');
    currentAction.className = 'Header_currentAction_x';
    const nameRow = document.createElement('div');
    nameRow.className = 'Header_actionName_x';
    nameRow.textContent = actionName;
    currentAction.appendChild(nameRow);
    document.body.appendChild(currentAction);
    return nameRow;
}

function counterText() {
    return document.getElementById('mwi-battle-counter')?.textContent ?? null;
}

describe('combat battle counter', () => {
    beforeEach(() => {
        game.setting = true;
        game.actions = [];
        game.actionDetails = {};
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.throwOnUnregister = false;
        combatBattleCounter.disable();
        buildHeader('Chimerical Den');
        combatBattleCounter.initialize();
    });

    test('disabled by setting, initialize wires nothing', () => {
        combatBattleCounter.disable();
        game.setting = false;
        combatBattleCounter.initialize();

        expect(game.wsHandlers.new_battle).toBeUndefined();
    });

    test('a plain zone battle shows "Battle #N"', () => {
        game.actions = [{ actionHrid: '/actions/combat/some_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/some_zone'] = { combatZoneInfo: { isDungeon: false } };

        game.wsHandlers.new_battle({ battleId: 7 });

        expect(counterText()).toBe('· Battle #7');
    });

    test('a dungeon battle shows wave and battle number', () => {
        game.actions = [{ actionHrid: '/actions/combat/dungeon_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/dungeon_zone'] = { combatZoneInfo: { isDungeon: true } };

        game.wsHandlers.new_battle({ battleId: 3, wave: 5 });

        expect(counterText()).toBe('· Wave 5 · Battle #3');
    });

    test('a labyrinth fight shows "Attempt #N" from the room entry count, never a battle number', () => {
        buildHeader('Labyrinth - Chimerical Beast');
        game.wsHandlers.new_battle({ battleId: 99 });

        game.wsHandlers.labyrinth_updated({
            labyrinth: {
                isActive: true,
                pathData: JSON.stringify([{ x: 0, y: 0 }]),
                roomData: [[{ roomType: '/labyrinth_room_types/combat', entryCount: 4 }]],
            },
        });

        expect(counterText()).toBe('· Attempt #4');
    });

    test('a labyrinth title with no attempt count yet shows nothing rather than a battle number', () => {
        buildHeader('Labyrinth - Chimerical Beast');
        game.wsHandlers.new_battle({ battleId: 99 });

        expect(counterText()).toBeNull();
    });

    test('leaving the active labyrinth room clears the attempt count', () => {
        buildHeader('Labyrinth - Chimerical Beast');
        game.wsHandlers.labyrinth_updated({
            labyrinth: {
                isActive: true,
                pathData: JSON.stringify([{ x: 0, y: 0 }]),
                roomData: [[{ roomType: '/labyrinth_room_types/combat', entryCount: 4 }]],
            },
        });
        expect(counterText()).toBe('· Attempt #4');

        game.wsHandlers.labyrinth_updated({
            labyrinth: {
                isActive: true,
                pathData: JSON.stringify([{ x: 0, y: 0 }]),
                roomData: [[{ roomType: '/labyrinth_room_types/treasure', entryCount: 0 }]],
            },
        });

        expect(counterText()).toBeNull();
    });

    test('the run ending clears the attempt count even mid-fight', () => {
        buildHeader('Labyrinth - Chimerical Beast');
        game.wsHandlers.labyrinth_updated({
            labyrinth: {
                isActive: true,
                pathData: JSON.stringify([{ x: 0, y: 0 }]),
                roomData: [[{ roomType: '/labyrinth_room_types/combat', entryCount: 2 }]],
            },
        });

        game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: false } });

        expect(counterText()).toBeNull();
    });

    test('malformed labyrinth JSON is ignored rather than throwing', () => {
        buildHeader('Labyrinth - Chimerical Beast');

        expect(() =>
            game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: true, pathData: '{not json', roomData: [] } })
        ).not.toThrow();
        expect(counterText()).toBeNull();
    });

    test('a skilling action in front of the queue shows no counter at all', () => {
        game.actions = [{ actionHrid: '/actions/foraging/something', isDone: false, ordinal: 0 }];
        game.wsHandlers.new_battle({ battleId: 5 });

        expect(counterText()).toBeNull();
    });

    test('combat ending via endCharacterActions removes the counter', () => {
        game.actions = [{ actionHrid: '/actions/combat/some_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/some_zone'] = { combatZoneInfo: { isDungeon: false } };
        game.wsHandlers.new_battle({ battleId: 7 });
        expect(counterText()).toBe('· Battle #7');

        game.dmHandlers.actions_updated({
            endCharacterActions: [{ isDone: true, actionHrid: '/actions/combat/some_zone' }],
        });

        expect(counterText()).toBeNull();
    });

    test('a fresh non-combat action starting up front re-evaluates and clears a stale counter', () => {
        game.actions = [{ actionHrid: '/actions/combat/some_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/some_zone'] = { combatZoneInfo: { isDungeon: false } };
        game.wsHandlers.new_battle({ battleId: 7 });
        expect(counterText()).toBe('· Battle #7');

        game.actions = [{ actionHrid: '/actions/alchemy/something', isDone: false, ordinal: 0, currentCount: 0 }];
        game.dmHandlers.actions_updated({
            endCharacterActions: [{ isDone: false, actionHrid: '/actions/alchemy/something', currentCount: 0 }],
        });

        expect(counterText()).toBeNull();
    });

    test('character switching clears state so the poll cannot re-paint the old chip', () => {
        combatBattleCounter.disable();
        vi.useFakeTimers();
        combatBattleCounter.initialize();
        game.actions = [{ actionHrid: '/actions/combat/some_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/some_zone'] = { combatZoneInfo: { isDungeon: false } };
        game.wsHandlers.new_battle({ battleId: 7 });
        expect(counterText()).toBe('· Battle #7');

        // The registry's disableAllFeatures runs later on the async lifecycle
        // chain — the immediate cleanup-phase event is the module's own (and
        // only prompt) chance to drop the departing character's numbers.
        expect(game.dmHandlers.character_switching).toBeTypeOf('function');
        game.dmHandlers.character_switching();
        expect(counterText()).toBeNull();

        // The arriving character's header is already up while their first
        // messages are still in flight — the re-inject poll must find nothing
        // to paint, not the previous character's battle number.
        game.actions = [];
        vi.advanceTimersByTime(5000);
        expect(counterText()).toBeNull();
        vi.useRealTimers();
    });

    test('character switching also clears a labyrinth attempt count', () => {
        buildHeader('Labyrinth - Chimerical Beast');
        game.wsHandlers.labyrinth_updated({
            labyrinth: {
                isActive: true,
                pathData: JSON.stringify([{ x: 0, y: 0 }]),
                roomData: [[{ roomType: '/labyrinth_room_types/combat', entryCount: 4 }]],
            },
        });
        expect(counterText()).toBe('· Attempt #4');

        game.dmHandlers.character_switching();

        expect(counterText()).toBeNull();
    });

    test('disable removes the counter element and resets state', () => {
        game.actions = [{ actionHrid: '/actions/combat/some_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/some_zone'] = { combatZoneInfo: { isDungeon: false } };
        game.wsHandlers.new_battle({ battleId: 7 });

        combatBattleCounter.disable();

        expect(counterText()).toBeNull();
        expect(game.wsHandlers.new_battle).toBeUndefined();
    });

    test('the DOM observer re-injects the counter into a header React replaced', () => {
        game.actions = [{ actionHrid: '/actions/combat/some_zone', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/some_zone'] = { combatZoneInfo: { isDungeon: false } };
        game.wsHandlers.new_battle({ battleId: 7 });

        buildHeader('Chimerical Den');
        expect(counterText()).toBeNull();

        game.domObserverCallback();

        expect(counterText()).toBe('· Battle #7');
    });
});

describe('the re-inject poll', () => {
    test('an in-place header rewrite gets the chip back within one poll tick', () => {
        combatBattleCounter.disable();
        vi.useFakeTimers();
        combatBattleCounter.initialize();
        game.wsHandlers['new_battle']({ battleId: 42 });
        expect(document.getElementById('mwi-battle-counter')?.textContent).toContain('#42');

        // React rewrites the row's children in place: no element replaced, so
        // the class observer never fires — only the poll can notice
        document.querySelector('[class*="Header_actionName"]').textContent = 'Golem Cave (T2)';
        expect(document.getElementById('mwi-battle-counter')).toBeNull();

        vi.advanceTimersByTime(1600);
        expect(document.getElementById('mwi-battle-counter')?.textContent).toContain('#42');
        vi.useRealTimers();
    });

    test('combat ending stays ended through the poll', () => {
        combatBattleCounter.disable();
        vi.useFakeTimers();
        combatBattleCounter.initialize();
        game.wsHandlers['new_battle']({ battleId: 42 });
        game.actions = [];
        game.dmHandlers['actions_updated']({
            endCharacterActions: [{ isDone: true, actionHrid: '/actions/combat/some_zone' }],
        });
        expect(document.getElementById('mwi-battle-counter')).toBeNull();

        vi.advanceTimersByTime(5000);
        expect(document.getElementById('mwi-battle-counter')).toBeNull();
        vi.useRealTimers();
    });

    test('disable() stops the poll', () => {
        combatBattleCounter.disable();
        vi.useFakeTimers();
        combatBattleCounter.initialize();
        game.wsHandlers['new_battle']({ battleId: 42 });
        combatBattleCounter.disable();
        document.querySelector('[class*="Header_actionName"]').textContent = 'Golem Cave (T2)';

        vi.advanceTimersByTime(5000);
        expect(document.getElementById('mwi-battle-counter')).toBeNull();
        vi.useRealTimers();
    });

    test('disable() stops the poll even when unregistering the observer throws', () => {
        // The teardown used to be one try block: if unregisterObserver() threw,
        // timers.clearAll() below it never ran, yet `finally` still marked the
        // feature disabled — so a later initialize() started a second poll on
        // top of one nothing had stopped.
        combatBattleCounter.disable();
        vi.useFakeTimers();
        combatBattleCounter.initialize();
        game.wsHandlers['new_battle']({ battleId: 42 });

        game.throwOnUnregister = true;
        combatBattleCounter.disable();
        game.throwOnUnregister = false;

        document.querySelector('[class*="Header_actionName"]').textContent = 'Golem Cave (T2)';
        vi.advanceTimersByTime(5000);
        expect(document.getElementById('mwi-battle-counter')).toBeNull();
        vi.useRealTimers();
    });
});
