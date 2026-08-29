/**
 * @vitest-environment happy-dom
 *
 * Driven the way combat-battle-counter.test.js is: build the header DOM, feed
 * websocket/data-manager events, read the injected span back out. The pure
 * arithmetic (battles-to-boss, rolling average, formatting) is already
 * covered in utils/boss-eta.test.js — this file is about wiring: which
 * events reset the tracker, which guards suppress the chip, and that the
 * average survives across battles within one zone.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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

const combatBossEta = (await import('./combat-boss-eta.js')).default;

/** Build the header shape the module injects into. */
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

function etaText() {
    return document.getElementById('mwi-boss-eta')?.textContent ?? null;
}

const BOSS_ZONE = '/actions/combat/boss_zone';
const bossZoneDetail = { combatZoneInfo: { isDungeon: false, fightInfo: { battlesPerBoss: 10, bossSpawns: [{}] } } };

describe('combat boss eta', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        game.setting = true;
        game.actions = [];
        game.actionDetails = {};
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.throwOnUnregister = false;
        combatBossEta.disable();
        buildHeader('Planet Of The Eyes');
        combatBossEta.initialize();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('disabled by setting, initialize wires nothing', () => {
        combatBossEta.disable();
        game.setting = false;
        combatBossEta.initialize();

        expect(game.wsHandlers.new_battle).toBeUndefined();
    });

    test('shows the battle count alone before an average exists', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;

        game.wsHandlers.new_battle({ battleId: 323 });

        expect(etaText()).toBe('· 7 to boss');
    });

    test('the boss-now edge shows "boss now" rather than a battle number', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;

        game.wsHandlers.new_battle({ battleId: 330 });

        expect(etaText()).toBe('· boss now');
    });

    test('a rolling average appears once a battle gap has been observed', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;

        game.wsHandlers.new_battle({ battleId: 321 });
        vi.setSystemTime(10_000);
        game.wsHandlers.new_battle({ battleId: 322 });

        // battlesRemaining = 8, one 10s sample so far => (8+1)*10s = 90s
        expect(etaText()).toBe('· 8 to boss · ~1m 30s left');
    });

    test('a zone with no boss spawns shows nothing', () => {
        game.actions = [{ actionHrid: '/actions/combat/plain_zone', isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails['/actions/combat/plain_zone'] = {
            combatZoneInfo: { isDungeon: false, fightInfo: { battlesPerBoss: 10, bossSpawns: [] } },
        };

        game.wsHandlers.new_battle({ battleId: 5 });

        expect(etaText()).toBeNull();
    });

    test('a dungeon shows nothing even if the field carries battlesPerBoss', () => {
        game.actions = [{ actionHrid: '/actions/combat/a_dungeon', isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails['/actions/combat/a_dungeon'] = {
            combatZoneInfo: { isDungeon: true, fightInfo: { battlesPerBoss: 5, bossSpawns: [{}] } },
        };

        game.wsHandlers.new_battle({ battleId: 5, wave: 5 });

        expect(etaText()).toBeNull();
    });

    test('a labyrinth fight never shows a boss chip', () => {
        buildHeader('Labyrinth - Chimerical Beast');
        game.wsHandlers.new_battle({ battleId: 330 });

        expect(etaText()).toBeNull();
    });

    test('a skilling action queued up front shows nothing', () => {
        game.actions = [{ actionHrid: '/actions/foraging/something', isDone: false, ordinal: 0 }];
        game.wsHandlers.new_battle({ battleId: 5 });

        expect(etaText()).toBeNull();
    });

    test('changing zones resets the rolling average', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 321 });
        vi.setSystemTime(10_000);
        game.wsHandlers.new_battle({ battleId: 322 });
        expect(etaText()).toContain('~');

        const OTHER_ZONE = '/actions/combat/other_boss_zone';
        game.actions = [{ actionHrid: OTHER_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[OTHER_ZONE] = bossZoneDetail;
        vi.setSystemTime(20_000);
        game.wsHandlers.new_battle({ battleId: 1 });

        // First battle of the new zone: no gap sample yet, so no time estimate
        expect(etaText()).toBe('· 9 to boss');
    });

    test('the same zone at a different tier also resets the average', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 321 });
        vi.setSystemTime(10_000);
        game.wsHandlers.new_battle({ battleId: 322 });
        expect(etaText()).toContain('~');

        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 1 }];
        vi.setSystemTime(20_000);
        game.wsHandlers.new_battle({ battleId: 323 });

        expect(etaText()).toBe('· 7 to boss');
    });

    test('character switching clears tracking and removes the chip', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 323 });
        expect(etaText()).toBe('· 7 to boss');

        game.dmHandlers.character_switching();

        expect(etaText()).toBeNull();
    });

    test('combat ending removes the chip', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 323 });
        expect(etaText()).toBe('· 7 to boss');

        game.dmHandlers.actions_updated({
            endCharacterActions: [{ isDone: true, actionHrid: BOSS_ZONE }],
        });

        expect(etaText()).toBeNull();
    });

    test('falls back to parsing the battle counter span when new_battle carries no battleId', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;

        const counterSpan = document.createElement('span');
        counterSpan.id = 'mwi-battle-counter';
        counterSpan.textContent = '· Battle #323';
        document.body.appendChild(counterSpan);

        game.wsHandlers.new_battle({});

        expect(etaText()).toBe('· 7 to boss');
    });

    test('disable removes the chip and resets state', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 323 });

        combatBossEta.disable();

        expect(etaText()).toBeNull();
        expect(game.wsHandlers.new_battle).toBeUndefined();
    });

    test('the DOM observer re-injects the chip into a header React replaced', () => {
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 323 });

        buildHeader('Planet Of The Eyes');
        expect(etaText()).toBeNull();

        game.domObserverCallback();

        expect(etaText()).toBe('· 7 to boss');
    });

    test('disable() stops the re-inject poll even when unregistering the observer throws', () => {
        // The teardown used to be one try block: if unregisterObserver() threw,
        // timers.clearAll() below it never ran, yet `finally` still marked the
        // feature disabled — so a later initialize() started a second poll on
        // top of one nothing had stopped.
        game.actions = [{ actionHrid: BOSS_ZONE, isDone: false, ordinal: 0, difficultyTier: 0 }];
        game.actionDetails[BOSS_ZONE] = bossZoneDetail;
        game.wsHandlers.new_battle({ battleId: 323 });
        expect(etaText()).toBe('· 7 to boss');

        game.throwOnUnregister = true;
        combatBossEta.disable();
        game.throwOnUnregister = false;

        buildHeader('Golem Cave (T2)');
        vi.advanceTimersByTime(5000);

        expect(etaText()).toBeNull();
    });
});
