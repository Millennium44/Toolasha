/** @vitest-environment happy-dom
 *
 * Remembering where a panel was, and whether it was anywhere.
 *
 * The two halves are stored apart on purpose. Where a panel sits is the same
 * answer on every character — you dragged it there once. Which panels were left
 * open is not: the market character's eight open panels reopening on top of the
 * iron cow is the leak this split exists to close.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ settings: {}, networthHistory: {} }));

const mockDataManager = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
    getCurrentCharacterId: () => mockDataManager.characterId,
    getCurrentCharacterGameMode: () => mockDataManager.gameMode,
    on: () => {},
    off: () => {},
}));

vi.mock('../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
        set: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        getJSON: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
        setJSON: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        delete: async (key, name = 'settings') => {
            delete store[name][key];
            return true;
        },
        getAllKeys: async (name = 'settings') => Object.keys(store[name] || {}),
    },
}));

const {
    saveGeometry,
    saveOpenState,
    wasOpen,
    allGeometry,
    reopenIfLeftOpen,
    clearPosition,
    restoreGeometry,
    _resetCaches,
} = await import('./panel-geometry.js');
const { _resetAdoptionCache } = await import('./character-key.js');

beforeEach(() => {
    store.settings = {};
    store.networthHistory = {};
    mockDataManager.characterId = 'market123';
    mockDataManager.gameMode = 'standard';
    _resetCaches();
    _resetAdoptionCache();
});

describe('whether a panel was open', () => {
    test('nothing stored means it was not', () => {
        return expect(wasOpen('dps')).resolves.toBe(false);
    });

    test('a round trip in both directions', async () => {
        await saveOpenState('dps', true);
        await expect(wasOpen('dps')).resolves.toBe(true);

        await saveOpenState('dps', false);
        await expect(wasOpen('dps')).resolves.toBe(false);
    });

    test('panels do not read each other’s state', async () => {
        await saveOpenState('dps', true);

        await expect(wasOpen('partyLoot')).resolves.toBe(false);
    });
});

describe('forgetting where a panel was but not how big', () => {
    test('the position goes and the size stays', () => {
        // The Treasure popup places itself beside the chest dialog and is only
        // pinned by being moved. Unpinning has to drop the position; dropping
        // the size with it would be a second change nobody asked for.
        return (async () => {
            await saveGeometry('popup', { left: 400, top: 90, width: 320, height: 500 });
            await clearPosition('popup');

            const all = await allGeometry();
            expect(all.popup).toEqual({ width: 320, height: 500 });
        })();
    });

    test('and the open flag survives it', async () => {
        await saveOpenState('popup', true);
        await saveGeometry('popup', { left: 10, top: 10 });
        await clearPosition('popup');

        await expect(wasOpen('popup')).resolves.toBe(true);
    });

    test('a panel with nothing stored is not a problem', () => {
        return expect(clearPosition('never-seen')).resolves.toBeUndefined();
    });
});

describe('reopening at start-up', () => {
    test('a panel left open is reopened', async () => {
        await saveOpenState('dps', true);

        const reopen = vi.fn();
        await reopenIfLeftOpen('dps', reopen);

        expect(reopen).toHaveBeenCalled();
    });

    test('a panel left closed is not', async () => {
        const reopen = vi.fn();
        await reopenIfLeftOpen('neverOpened', reopen);

        expect(reopen).not.toHaveBeenCalled();
    });

    test('it waits for the character before asking', async () => {
        // Panels ask at module scope, long before the websocket says who logged
        // in. Asking then reads the wrong character's key, which comes back
        // empty and looks exactly like "nothing was left open".
        store.settings.panelOpenState_market123 = { dps: true };
        mockDataManager.characterId = null;
        let announce = null;
        mockDataManager.on = (event, handler) => {
            if (event === 'character_initialized') announce = handler;
        };

        const reopen = vi.fn();
        const pending = reopenIfLeftOpen('dps', reopen);
        await Promise.resolve();
        expect(reopen).not.toHaveBeenCalled();

        mockDataManager.characterId = 'market123';
        announce();
        await pending;

        expect(reopen).toHaveBeenCalled();
        mockDataManager.on = () => {};
    });

    test('a panel that throws on reopening does not take the others with it', async () => {
        // These are all fired off at module scope, one after another
        await saveOpenState('dps', true);

        await expect(
            reopenIfLeftOpen('dps', () => {
                throw new Error('no body yet');
            })
        ).resolves.toBeUndefined();
    });
});

describe('the two halves, stored apart', () => {
    test('the geometry is shared and the open flag is not', async () => {
        await saveGeometry('dps', { left: 120, top: 80, width: 400, height: 300 });
        await saveOpenState('dps', true);

        expect(store.settings.panelGeometry.dps).toEqual({ left: 120, top: 80, width: 400, height: 300 });
        expect(store.settings.panelOpenState_market123).toEqual({ dps: true });
    });

    test('a panel dragged on one character is in the same place on the other', async () => {
        await saveGeometry('dps', { left: 120, top: 80, width: 400, height: 300 });

        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';
        document.body.innerHTML = '<div id="panel"></div>';
        await restoreGeometry(document.getElementById('panel'), 'dps');

        expect(document.getElementById('panel').style.left).toBe('120px');
    });
});

describe('open flags left in the old shared record', () => {
    const legacyRecord = () => ({
        dps: { left: 120, top: 80, width: 400, height: 300, open: true },
        partyLoot: { left: 10, top: 10, width: 200, height: 200, open: false },
    });

    test('the main character adopts them', async () => {
        store.settings.panelGeometry = legacyRecord();

        await expect(wasOpen('dps')).resolves.toBe(true);
        await expect(wasOpen('partyLoot')).resolves.toBe(false);
        expect(store.settings.panelOpenState_market123).toEqual({ dps: true, partyLoot: false });
        expect(store.settings.panelOpenState).toBeUndefined();
    });

    test('and the geometry stays behind, shared and intact', async () => {
        store.settings.panelGeometry = legacyRecord();

        await wasOpen('dps');

        expect(store.settings.panelGeometry.dps).toEqual({ left: 120, top: 80, width: 400, height: 300 });
        expect(store.settings.panelGeometry.dps.open).toBeUndefined();
    });

    test('the iron cow starts with everything closed', async () => {
        store.settings.panelGeometry = legacyRecord();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';

        await expect(wasOpen('dps')).resolves.toBe(false);
        expect(store.settings.panelOpenState_iron456).toBeUndefined();
    });

    test('and leaves them for the main character to claim later', async () => {
        store.settings.panelGeometry = legacyRecord();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';
        await wasOpen('dps');

        mockDataManager.characterId = 'market123';
        mockDataManager.gameMode = 'standard';
        await expect(wasOpen('dps')).resolves.toBe(true);
        expect(store.settings.panelOpenState_market123).toEqual({ dps: true, partyLoot: false });
    });

    test('what the iron cow opens is its own', async () => {
        store.settings.panelGeometry = legacyRecord();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';

        await saveOpenState('partyLoot', true);

        expect(store.settings.panelOpenState_iron456).toEqual({ partyLoot: true });
        mockDataManager.characterId = 'market123';
        mockDataManager.gameMode = 'standard';
        await expect(wasOpen('partyLoot')).resolves.toBe(false);
    });
});
