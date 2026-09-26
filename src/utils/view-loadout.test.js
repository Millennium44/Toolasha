/** @vitest-environment happy-dom
 *
 * The game's View Loadout, from Toolasha's side: every `loadout_shared` is
 * remembered, and a user-clicked fetch walks a list of players one at a time
 * through the game's own `handleViewLoadout`, closing the modal each opens.
 *
 * Fixtures follow the reply as measured on the test server: no top-level
 * character id or context, gear keyed `/item_locations/<slot>`, rows carrying
 * `characterID`, the name on `sharableCharacter`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    charId: 100,
    /** The game core the fiber walk finds, or null for a build without it */
    core: null,
    /** messageType → handlers, as webSocketHook.on registered them */
    handlers: new Map(),
}));

vi.mock('../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => game.charId },
}));
vi.mock('../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            if (!game.handlers.has(type)) game.handlers.set(type, []);
            game.handlers.get(type).push(handler);
        },
        off: (type, handler) => {
            const list = game.handlers.get(type) || [];
            const index = list.indexOf(handler);
            if (index > -1) list.splice(index, 1);
        },
    },
}));
vi.mock('./profile-command.js', () => ({ getGameCore: () => game.core }));

const viewLoadout = await import('./view-loadout.js');
const {
    fetchLoadouts,
    getLoadout,
    getLoadouts,
    isViewLoadoutAvailable,
    startLoadoutCapture,
    findLoadoutModals,
    onLoadoutCaptured,
    VIEW_LOADOUT_CONTEXT,
    _resetViewLoadout,
} = viewLoadout;

/** Deliver a message as the websocket hook would */
function deliver(message) {
    for (const handler of game.handlers.get(message.type) || []) handler(message);
}

/**
 * A `loadout_shared` reply.
 * @param {number} id - The player's character id, as the rows carry it
 * @param {string} name
 * @param {{hasLoadout?: boolean}} [options]
 */
function reply(id, name, { hasLoadout = true } = {}) {
    return {
        type: 'loadout_shared',
        loadout: {
            sharableCharacter: { name, gameMode: 'standard', isOnline: true, actionType: '/action_types/combat' },
            hasLoadout,
            actionTypeHrid: '/action_types/combat',
            wearableItemMap: hasLoadout
                ? {
                      '/item_locations/main_hand': {
                          itemLocationHrid: '/item_locations/main_hand',
                          itemHrid: '/items/rippling_trident',
                          enhancementLevel: 7,
                          count: 1,
                          characterID: id,
                      },
                  }
                : {},
            missingItemLocationHridMap: {},
            equippedAbilities: hasLoadout
                ? [{ abilityHrid: '/abilities/aqua_arrow', level: 40, experience: 0, slotNumber: 1, characterID: id }]
                : [],
            combatConsumables: hasLoadout
                ? [{ itemHrid: '/items/spaceberry_cake', itemLocationHrid: '', count: 50 }]
                : [],
            abilityCombatTriggersMap: {},
            consumableCombatTriggersMap: {},
        },
    };
}

/** Put a game loadout modal on the page; its close button removes it */
function openModal(name) {
    const container = document.createElement('div');
    container.className = 'Modal_modalContainer__abc';
    container.innerHTML = `<div class="Modal_modalContent__def">
        <div class="LoadoutModal_header__x"><div class="LoadoutModal_title__y">${name}'s Loadout</div></div>
        <div>Equipment</div>
        <button class="Modal_closeButton__ghi">×</button>
    </div>`;
    container.querySelector('button').addEventListener('click', () => container.remove());
    document.body.appendChild(container);
    return container;
}

/**
 * A game core whose View Loadout answers after `latencyMs` and opens a modal,
 * the way the game does. `silent` ids never answer.
 */
function makeCore({ players, latencyMs = 100, silent = [] }) {
    const core = {
        handleViewProfile: () => {},
        handleViewLoadout: vi.fn((characterId) => {
            if (silent.includes(characterId)) return;
            setTimeout(() => {
                const name = players[characterId];
                deliver(reply(characterId, name));
                setTimeout(() => openModal(name), 20);
            }, latencyMs);
        }),
    };
    return core;
}

beforeEach(() => {
    vi.useFakeTimers();
    _resetViewLoadout();
    game.handlers.clear();
    game.charId = 100;
    game.core = null;
    document.body.innerHTML = '';
    startLoadoutCapture();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('passive capture', () => {
    test('a reply nobody here asked for is still remembered, by character and by name', () => {
        deliver(reply(7, 'Ally'));

        const byId = getLoadout(7);
        expect(byId).toMatchObject({ characterId: '7', name: 'Ally', context: null, requested: false });
        expect(byId.loadout.wearableItemMap['/item_locations/main_hand'].enhancementLevel).toBe(7);
        expect(getLoadout('ally')?.characterId).toBe('7');
        // Unknown context: not a party loadout
        expect(getLoadout(7, VIEW_LOADOUT_CONTEXT.Party)).toBeNull();
    });

    test('a player with no loadout set is remembered as such, under their name', () => {
        deliver(reply(8, 'Empty', { hasLoadout: false }));

        const entry = getLoadout('Empty');
        expect(entry).toMatchObject({ characterId: null, hasLoadout: false });
    });

    test('a capture made on another character is not answered on this one', () => {
        deliver(reply(7, 'Ally'));
        game.charId = 200;

        expect(getLoadout(7)).toBeNull();
        expect(getLoadouts()).toEqual([]);
    });

    test('capture listeners hear each one', () => {
        const heard = [];
        onLoadoutCaptured((entry) => heard.push(entry.name));
        deliver(reply(7, 'Ally'));
        expect(heard).toEqual(['Ally']);
    });
});

describe('fetchLoadouts', () => {
    const players = { 7: 'Ally', 8: 'Buddy', 9: 'Chum' };

    test('asks one member at a time, matches each reply, and closes each modal', async () => {
        game.core = makeCore({ players });

        const run = fetchLoadouts(
            [
                { characterID: 7, characterName: 'Ally' },
                { characterID: 8, characterName: 'Buddy' },
            ],
            VIEW_LOADOUT_CONTEXT.Party
        );

        // Only the first request goes out until its reply lands
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        expect(game.core.handleViewLoadout).toHaveBeenLastCalledWith(7, 'party', '');
        await vi.advanceTimersByTimeAsync(99);
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        const result = await run;

        expect(result.status).toBe('done');
        expect(result.missed).toEqual([]);
        expect(result.loadouts.map((entry) => [entry.characterId, entry.name, entry.context])).toEqual([
            ['7', 'Ally', 'party'],
            ['8', 'Buddy', 'party'],
        ]);
        expect(game.core.handleViewLoadout.mock.calls.map((call) => call[0])).toEqual([7, 8]);
        expect(findLoadoutModals()).toEqual([]);
        expect(getLoadout(8, VIEW_LOADOUT_CONTEXT.Party)?.requested).toBe(true);
    });

    test('a member who never answers is skipped after the timeout, and the run goes on', async () => {
        game.core = makeCore({ players, silent: [8] });

        const run = fetchLoadouts([{ characterID: 8 }, { characterID: 9 }], 'party', '', { timeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(4999);
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3000);
        const result = await run;

        expect(result.missed).toEqual([{ characterId: '8', name: null }]);
        expect(result.loadouts.map((entry) => entry.name)).toEqual(['Chum']);
    });

    test("another player's reply arriving mid-request is captured under its own character, not the one asked for", async () => {
        game.core = makeCore({ players, latencyMs: 300 });

        const run = fetchLoadouts([{ characterID: 7, characterName: 'Ally' }], 'guild_trial', 'trial');
        await vi.advanceTimersByTimeAsync(50);
        deliver(reply(9, 'Chum'));
        await vi.advanceTimersByTimeAsync(2000);
        const result = await run;

        expect(result.loadouts.map((entry) => entry.name)).toEqual(['Ally']);
        expect(getLoadout(9)).toMatchObject({ requested: false, context: null });
        expect(getLoadout(7, 'guild_trial')).toMatchObject({ kind: 'trial', requested: true });
    });

    test('a second run while one is going is refused and requests nothing', async () => {
        game.core = makeCore({ players });

        const first = fetchLoadouts([{ characterID: 7 }]);
        const second = await fetchLoadouts([{ characterID: 8 }]);

        expect(second.status).toBe('busy');
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect((await first).status).toBe('done');
    });

    test('a character switch stops the run before the next request', async () => {
        game.core = makeCore({ players });

        const run = fetchLoadouts([{ characterID: 7 }, { characterID: 8 }, { characterID: 9 }]);
        await vi.advanceTimersByTimeAsync(50);
        game.charId = 200;
        await vi.advanceTimersByTimeAsync(5000);
        const result = await run;

        expect(result.status).toBe('character_switched');
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        expect(result.missed.map((member) => member.characterId)).toEqual(['7', '8', '9']);
    });
});

describe('a game build without View Loadout', () => {
    test('is not available, and a fetch requests nothing', async () => {
        game.core = { handleViewProfile: vi.fn() };

        expect(isViewLoadoutAvailable()).toBe(false);
        const result = await fetchLoadouts([{ characterID: 7 }]);
        expect(result.status).toBe('unavailable');
        expect(game.core.handleViewProfile).not.toHaveBeenCalled();
    });
});

describe('findLoadoutModals', () => {
    test("finds the game's loadout modal by its title and ignores other modals", () => {
        openModal('Ally');
        const other = document.createElement('div');
        other.className = 'Modal_modalContainer__abc';
        other.innerHTML = '<div>Ally</div><div>Choose a loadout to equip</div>';
        document.body.appendChild(other);

        const modals = findLoadoutModals();
        expect(modals).toHaveLength(1);
        expect(modals[0].name).toBe('Ally');
    });
});
