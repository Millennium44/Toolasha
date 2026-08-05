/** @vitest-environment happy-dom */

/**
 * Catching a loadout as it goes past.
 *
 * The popup scrape is the part that has never been run against a live client, so
 * most of this file is about what it must *refuse*: a modal that is not a unit
 * popup, and a popup that the socket already covered. Reading a settings dialog
 * as a guild member would put a player who does not exist on the roster panel,
 * and it would be persisted.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    store: {},
    characterId: 'char-1',
    wsHandlers: {},
    observers: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getCurrentCharacterId: () => game.characterId,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, classNames, callback) => {
            for (const name of Array.isArray(classNames) ? classNames : [classNames]) {
                game.observers[name] = callback;
            }
            return () => {};
        },
    },
}));

const { guildLoadoutCapture, readUnitPopup, POPUP_SOCKET_WINDOW_MS } = await import('./guild-loadout-capture.js');
const { guildLoadoutsStorageKey } = await import('./guild-loadouts.js');

/**
 * Build a modal out of runs of text, as the game renders one.
 * @param {Array<string|string[]>} entries - Lines, or label/value pairs
 * @returns {HTMLElement} The modal
 */
function modal(entries) {
    const root = document.createElement('div');
    root.className = 'Modal_modalContent__abc';

    for (const entry of entries) {
        const line = document.createElement('div');
        for (const run of Array.isArray(entry) ? entry : [entry]) {
            const span = document.createElement('span');
            span.textContent = run;
            line.appendChild(span);
        }
        root.appendChild(line);
    }

    document.body.appendChild(root);
    return root;
}

describe('readUnitPopup', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('reads the header and the labelled numbers', () => {
        const popup = modal([
            ['Tib - Lv.150'],
            ['Armor', '62'],
            ['Magic Evasion', '1,240'],
            ['Rare Find', '12.0%'],
            ['HP Regen', '3.0%'],
        ]);

        const loadout = readUnitPopup(popup, 5);
        expect(loadout).toMatchObject({ name: 'Tib', level: 150, source: 'popup', at: 5 });
        expect(loadout.rows).toEqual([
            { label: 'Armor', value: '62' },
            { label: 'Magic Evasion', value: '1,240' },
            { label: 'Rare Find', value: '12.0%' },
            { label: 'HP Regen', value: '3.0%' },
        ]);
    });

    test('the name may sit in the run before the level', () => {
        const popup = modal([
            ['Moo'],
            ['Lv.99'],
            ['Armor', '1'],
            ['Parry', '2%'],
            ['Threat', '3%'],
            ['Tenacity', '4%'],
        ]);
        expect(readUnitPopup(popup).name).toBe('Moo');
    });

    test('a modal with a header and no stat sheet is not a unit popup', () => {
        expect(readUnitPopup(modal([['Tib - Lv.150'], ['Close'], ['Battle Info'], ['Stats']]))).toBeNull();
    });

    test('a modal with numbers and no header is not one either', () => {
        expect(
            readUnitPopup(
                modal([
                    ['Coins', '1,240'],
                    ['Fee', '2%'],
                    ['Total', '9'],
                    ['Net', '8'],
                ])
            )
        ).toBeNull();
    });

    test('nothing at all is null rather than a throw', () => {
        expect(readUnitPopup(null)).toBeNull();
        expect(readUnitPopup({})).toBeNull();
    });
});

describe('the capture', () => {
    beforeEach(async () => {
        game.store = {};
        game.characterId = 'char-1';
        game.clientData = {};
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.record = { players: {}, updatedAt: 0 };
        guildLoadoutCapture.lastSocketAt = 0;
        await guildLoadoutCapture.initialize();
    });

    afterEach(() => {
        guildLoadoutCapture.cleanup();
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    test('a fetched unit is remembered and written down', async () => {
        game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { id: 'char-9', name: 'Tib' },
                combatDetails: { combatLevel: 150, maxHitpoints: 4120, combatStats: { combatRareFind: 0.12 } },
                combatAbilities: [{ abilityHrid: '/abilities/fireball', level: 40 }],
            },
        });

        expect(guildLoadoutCapture.forPlayer('tib')).toMatchObject({ name: 'Tib', level: 150 });

        await vi.advanceTimersByTimeAsync(2000);
        expect(game.store[guildLoadoutsStorageKey('char-1')].players.tib.name).toBe('Tib');
    });

    test('the end-of-session message neither stores nor stands the scrape down', () => {
        game.wsHandlers.battle_unit_fetched({ unit: { character: { name: 'Tib' }, totalLootMap: {} } });
        expect(guildLoadoutCapture.seen()).toEqual([]);

        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Tib')?.source).toBe('popup');
    });

    test('a party assembling records everybody in it', () => {
        game.wsHandlers.new_battle({
            players: [
                { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
                { character: { name: 'Moo' }, combatDetails: { maxHitpoints: 3000, combatStats: {} } },
            ],
        });

        expect(
            guildLoadoutCapture
                .seen()
                .map((entry) => entry.name)
                .sort()
        ).toEqual(['Moo', 'Tib']);
    });

    test('the scrape stands down when the socket has just answered', () => {
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
        });
        expect(guildLoadoutCapture.forPlayer('Tib').source).toBe('battle_unit_fetched');

        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Tib').source).toBe('battle_unit_fetched');

        // Past the window it is the only source there is, so it takes over
        vi.advanceTimersByTime(POPUP_SOCKET_WINDOW_MS + 1000);
        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Tib').source).toBe('popup');
    });

    test('an alt does not inherit this character’s sightings', async () => {
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
        });
        await vi.advanceTimersByTimeAsync(2000);

        game.characterId = 'char-2';
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Moo' }, combatDetails: { maxHitpoints: 3000, combatStats: {} } },
        });
        await vi.advanceTimersByTimeAsync(2000);

        expect(guildLoadoutCapture.seen().map((entry) => entry.name)).toEqual(['Moo']);
        expect(game.store[guildLoadoutsStorageKey('char-1')].players.tib).toBeDefined();
        expect(game.store[guildLoadoutsStorageKey('char-2')].players.moo).toBeDefined();
    });

    test('a broken payload is logged rather than thrown', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => game.wsHandlers.battle_unit_fetched(null)).not.toThrow();
        expect(() => game.wsHandlers.new_battle(null)).not.toThrow();
        expect(() => game.observers.Modal_modalContent(null)).not.toThrow();
        errors.mockRestore();
    });
});

describe('two owners', () => {
    afterEach(() => {
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.cleanup();
    });

    test('one feature being switched off does not take the listeners from the other', async () => {
        game.wsHandlers = {};
        await guildLoadoutCapture.initialize();
        await guildLoadoutCapture.initialize();

        guildLoadoutCapture.cleanup();
        expect(typeof game.wsHandlers.battle_unit_fetched).toBe('function');

        guildLoadoutCapture.cleanup();
        expect(game.wsHandlers.battle_unit_fetched).toBeUndefined();
    });
});
