/**
 * The buff state version moves when the running action, or the loadout id it carries, changes.
 *
 * While an action runs, resolveActionContext answers for its type with the loadout that action was started with
 * (0, No Loadout, is the worn kit). A restart with No Loadout over the same gear changes that answer while nothing
 * worn moves, so every memo keyed on the version has to hear of it from here. Only a changed pair bumps: each
 * `action_completed` continuation would otherwise re-price networth and the badges.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { buildCharacterAction } from '../__fixtures__/wire/character-actions.js';

const handlers = vi.hoisted(() => new Map());

vi.mock('./websocket.js', () => ({
    default: {
        on: vi.fn((event, handler) => handlers.set(event, handler)),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
        saveCombatSimSnapshot: vi.fn(() => true),
    },
}));
vi.mock('./storage.js', () => ({
    default: {
        getJSON: async (_key, _store, fallback) => fallback,
        setJSON: async () => true,
        get: async (_key, _store, fallback = null) => fallback,
        set: async () => true,
        flushAll: async () => {},
    },
}));

let dataManager;

const ENHANCE = '/actions/enhancing/enhance';

function actionsUpdated(...actions) {
    handlers.get('actions_updated')({ type: 'actions_updated', endCharacterActions: actions });
}

beforeEach(async () => {
    ({ default: dataManager } = await import('./data-manager.js'));
    dataManager.characterActions = [];
    dataManager._runningLoadoutSignature = null;
});

describe('the running loadout and the buff state version', () => {
    test('a new running action, then a restart of it under another loadout id, each move the version', () => {
        const v0 = dataManager.getBuffStateVersion();
        actionsUpdated(buildCharacterAction({ id: 1, actionHrid: ENHANCE, characterLoadoutID: 39837 }));
        const v1 = dataManager.getBuffStateVersion();
        expect(v1).toBeGreaterThan(v0);

        // The player restarts the same enhance with No Loadout: same gear on, other figures
        actionsUpdated(
            buildCharacterAction({ id: 1, actionHrid: ENHANCE, isDone: true }),
            buildCharacterAction({ id: 2, actionHrid: ENHANCE, characterLoadoutID: 0, ordinal: 2 })
        );
        expect(dataManager.getBuffStateVersion()).toBeGreaterThan(v1);
    });

    test('a continuation of the same running action leaves the version alone', () => {
        actionsUpdated(buildCharacterAction({ id: 1, actionHrid: ENHANCE, characterLoadoutID: 0 }));
        const before = dataManager.getBuffStateVersion();

        handlers.get('action_completed')({
            type: 'action_completed',
            endCharacterAction: buildCharacterAction({
                id: 1,
                actionHrid: ENHANCE,
                characterLoadoutID: 0,
                currentCount: 1,
            }),
        });
        actionsUpdated(buildCharacterAction({ id: 1, actionHrid: ENHANCE, characterLoadoutID: 0, currentCount: 2 }));

        expect(dataManager.getBuffStateVersion()).toBe(before);
    });

    test('the queue moving on to another action of the same skill under the same loadout leaves it alone', () => {
        const saved = dataManager.initClientData;
        dataManager.initClientData = {
            actionDetailMap: {
                '/actions/foraging/farmland': { hrid: '/actions/foraging/farmland', type: '/action_types/foraging' },
                '/actions/foraging/shimmering_lake': {
                    hrid: '/actions/foraging/shimmering_lake',
                    type: '/action_types/foraging',
                },
            },
        };
        try {
            actionsUpdated(
                buildCharacterAction({ id: 1, actionHrid: '/actions/foraging/farmland', characterLoadoutID: 39838 })
            );
            const before = dataManager.getBuffStateVersion();
            actionsUpdated(
                buildCharacterAction({ id: 1, actionHrid: '/actions/foraging/farmland', isDone: true }),
                buildCharacterAction({
                    id: 2,
                    actionHrid: '/actions/foraging/shimmering_lake',
                    characterLoadoutID: 39838,
                    ordinal: 2,
                })
            );
            expect(dataManager.getBuffStateVersion()).toBe(before);
        } finally {
            dataManager.initClientData = saved;
        }
    });

    test('a queued action behind the running one does not move the version', () => {
        actionsUpdated(buildCharacterAction({ id: 1, actionHrid: ENHANCE, characterLoadoutID: 0, ordinal: 1 }));
        const before = dataManager.getBuffStateVersion();

        actionsUpdated(
            buildCharacterAction({ id: 2, actionHrid: '/actions/foraging/farmland', characterLoadoutID: 0, ordinal: 2 })
        );

        expect(dataManager.getBuffStateVersion()).toBe(before);
    });

    test('the version has moved by the time actions_updated listeners run', async () => {
        const before = dataManager.getBuffStateVersion();
        let seen = null;
        const listener = () => {
            seen = dataManager.getBuffStateVersion();
        };
        dataManager.on('actions_updated', listener);
        try {
            actionsUpdated(buildCharacterAction({ id: 1, actionHrid: ENHANCE, characterLoadoutID: 0 }));
            // Listeners other than character_switching are delivered on a later task
            await vi.waitFor(() => expect(seen).not.toBeNull());
        } finally {
            dataManager.off('actions_updated', listener);
        }
        expect(seen).toBeGreaterThan(before);
    });
});
