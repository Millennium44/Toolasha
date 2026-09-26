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
    fetchLoadout,
    isFetchingLoadout,
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
    container.className = 'SharableProfile_modalContainer__6Q2JL';
    // The shape measured on the test server (2026-09-26)
    container.innerHTML = `<div class="SharableProfile_modal__2OmCQ">
        <div class="SharableProfile_modalContent__284HM">
            <div class="SharableProfile_header__3QyU6">${name}'s Loadout</div>
            <div>Equipment</div>
        </div>
        <div class="SharableProfile_closeButton__3QHya">×</div>
    </div>`;
    container
        .querySelector('[class*="SharableProfile_closeButton"]')
        .addEventListener('click', () => container.remove());
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

describe('fetchLoadout', () => {
    const players = { 7: 'Ally', 8: 'Buddy', 9: 'Chum' };

    test('sends exactly one request, matches its reply, and closes the modal', async () => {
        game.core = makeCore({ players });

        const run = fetchLoadout({ characterID: 7, characterName: 'Ally' }, VIEW_LOADOUT_CONTEXT.Party);
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        expect(game.core.handleViewLoadout).toHaveBeenLastCalledWith(7, 'party', '');

        await vi.advanceTimersByTimeAsync(1000);
        const result = await run;

        expect(result.status).toBe('done');
        expect(result.entry).toMatchObject({ characterId: '7', name: 'Ally', context: 'party', requested: true });
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        expect(findLoadoutModals()).toEqual([]);
        expect(getLoadout(7, VIEW_LOADOUT_CONTEXT.Party)?.requested).toBe(true);
    });

    test('a player who never answers comes back as no_reply after the timeout', async () => {
        game.core = makeCore({ players, silent: [8] });

        const run = fetchLoadout({ characterID: 8 }, 'party', '', { timeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(4999);
        expect(isFetchingLoadout()).toBe(true);
        await vi.advanceTimersByTimeAsync(10);
        const result = await run;

        expect(result).toEqual({ status: 'no_reply', entry: null });
        expect(isFetchingLoadout()).toBe(false);
    });

    test("another player's reply arriving mid-request is captured under its own character, not the one asked for", async () => {
        game.core = makeCore({ players, latencyMs: 300 });

        const run = fetchLoadout({ characterID: 7, characterName: 'Ally' }, 'guild_trial', 'trial');
        await vi.advanceTimersByTimeAsync(50);
        deliver(reply(9, 'Chum'));
        await vi.advanceTimersByTimeAsync(2000);
        const result = await run;

        expect(result.entry.name).toBe('Ally');
        expect(getLoadout(9)).toMatchObject({ requested: false, context: null });
        expect(getLoadout(7, 'guild_trial')).toMatchObject({ kind: 'trial', requested: true });
    });

    test('a second call while one is in flight is refused and requests nothing', async () => {
        game.core = makeCore({ players });

        const first = fetchLoadout({ characterID: 7 });
        const second = await fetchLoadout({ characterID: 8 });

        expect(second).toEqual({ status: 'busy', entry: null });
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect((await first).status).toBe('done');
        // Only once the first has finished does a new click get its own request
        const third = fetchLoadout({ characterID: 8 });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await third).entry.name).toBe('Buddy');
        expect(game.core.handleViewLoadout).toHaveBeenCalledTimes(2);
    });

    test('a character switch while waiting answers character_switched and stores nothing', async () => {
        game.core = makeCore({ players });

        const run = fetchLoadout({ characterID: 7 });
        await vi.advanceTimersByTimeAsync(50);
        game.charId = 200;
        await vi.advanceTimersByTimeAsync(5000);
        const result = await run;

        expect(result.status).toBe('character_switched');
        expect(getLoadouts()).toEqual([]);
    });

    test('a member with no id requests nothing', async () => {
        game.core = makeCore({ players });
        expect((await fetchLoadout({ characterName: 'Ally' })).status).toBe('invalid');
        expect(game.core.handleViewLoadout).not.toHaveBeenCalled();
    });
});

describe('a game build without View Loadout', () => {
    test('is not available, and a fetch requests nothing', async () => {
        game.core = { handleViewProfile: vi.fn() };

        expect(isViewLoadoutAvailable()).toBe(false);
        const result = await fetchLoadout({ characterID: 7 });
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
        // The profile modal shares the loadout modal's container class
        const profile = document.createElement('div');
        profile.className = 'SharableProfile_modalContainer__6Q2JL';
        profile.innerHTML = '<div class="SharableProfile_header__3QyU6">Ally</div><div>Total Level: 2412</div>';
        document.body.appendChild(profile);

        const modals = findLoadoutModals();
        expect(modals).toHaveLength(1);
        expect(modals[0].name).toBe('Ally');
    });
});
