/** @vitest-environment happy-dom */
/**
 * The takeover push, against the shape the game produces (recorded live on the test server, opening the character
 * in a second tab): no node is added. One existing element gains the `GamePage_connectionMessage` class, a second
 * or two after the trigger and not measured from the close, and the socket closes with no new one opening.
 *
 * The real dom-observer, connection-state and sync-manager run here, on a real DOM. Worst failure first: a takeover
 * that does not push, or one taken for a switch. A switch taken for a takeover only costs a push.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    settings: { sync_enabled: true, sync_token: 'ghp_real', sync_scope: 'everything', sync_onSwitch: true },
    listeners: {},
    reloading: false,
    switching: false,
    characterId: 32030,
    socketHandlers: {},
    closedByUs: new Set(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => state.settings[key] ?? fallback,
        onSettingChange: (key, callback) => {
            (state.listeners[key] ||= []).push(callback);
        },
        offSettingChange: (key, callback) => {
            state.listeners[key] = (state.listeners[key] || []).filter((listener) => listener !== callback);
        },
        isSettingsReloading: () => state.reloading,
        areSharedSettingsKnown: () => true,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        getIsCharacterSwitching: () => state.switching,
    },
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: () => {},
        off: () => {},
        onSocketEvent: (name, handler) => {
            (state.socketHandlers[name] ||= []).push(handler);
        },
        offSocketEvent: () => {},
        wasClosedByToolasha: (socket) => state.closedByUs.has(socket),
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback = null) => fallback, set: async () => true },
}));
vi.mock('./sync-payload.js', () => ({}));
vi.mock('../../utils/toast.js', () => ({ showToast: () => null }));

const { default: domObserver } = await import('../../core/dom-observer.js');
const { default: connectionState } = await import('../../core/connection-state.js');
const { default: syncManager } = await import('./sync-manager.js');

const SETTLE = 1500;
const GAME_URL = (id) => `https://test.milkywayidle.com/game?characterId=${id}`;

const socket = { name: 'the game socket' };
const emitSocket = (name, event, from = socket) => {
    for (const handler of state.socketHandlers[name] || []) handler(event, from);
};
const socketCloses = (event = { code: 1005, wasClean: true }, from = socket) => emitSocket('close', event, from);
const socketOpens = (from = { name: 'a new socket' }) => emitSocket('open', {}, from);

let page;
let push;

/** Let the page's mutation observer run, and the clock move */
async function advance(ms) {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    state.settings = { sync_enabled: true, sync_token: 'ghp_real', sync_scope: 'everything', sync_onSwitch: true };
    state.listeners = {};
    state.reloading = false;
    state.switching = false;
    state.characterId = 32030;
    state.closedByUs = new Set();

    window.happyDOM.setURL(GAME_URL(32030));
    document.body.innerHTML = '';
    // On the page from the start, with the game's hashed class names
    page = document.createElement('div');
    page.className = 'GamePage_gamePage__abc12';
    document.body.appendChild(page);
    domObserver.start();

    emitSocket('open', {});
    connectionState.setConnected('init_character_data');

    syncManager.cleanup();
    syncManager.handoffPushed = false;
    syncManager.busy = false;
    push = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });
    await syncManager.initialize();
});

afterEach(() => {
    syncManager.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** The game's banner: the class arrives on the element already there */
const bannerOn = () => page.classList.add('GamePage_connectionMessage__xyz34');
const bannerOff = () => page.classList.remove('GamePage_connectionMessage__xyz34');

describe('a real takeover', () => {
    test('pushes though no node was added, with the class arriving after the first look', async () => {
        socketCloses();
        await advance(SETTLE);
        expect(push).not.toHaveBeenCalled();

        await advance(100);
        bannerOn();
        await advance(SETTLE);

        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith({ silent: true, unattended: true });

        await advance(10 * SETTLE);
        expect(push).toHaveBeenCalledTimes(1);
    });

    test('pushes with the class already on when the socket closes', async () => {
        bannerOn();
        socketCloses();
        await advance(SETTLE);
        expect(push).toHaveBeenCalledTimes(1);
    });

    test('any close code will do: it is the banner and the signs of a switch that decide', async () => {
        socketCloses({ code: 1006, wasClean: false });
        bannerOn();
        await advance(SETTLE);
        expect(push).toHaveBeenCalledTimes(1);
    });

    test('waits a bounded time for a banner that never comes, then stops looking', async () => {
        socketCloses();
        await advance(30 * SETTLE);

        expect(push).not.toHaveBeenCalled();
        expect(syncManager.handoffTimer).toBeNull();
    });

    test('the setting turned off before it decides stops it', async () => {
        socketCloses();
        bannerOn();
        state.settings.sync_onSwitch = false;
        await advance(SETTLE);
        expect(push).not.toHaveBeenCalled();
    });
});

describe('a hop between characters', () => {
    test('its close, the select page, the reconnect and the new page start no push', async () => {
        // The socket goes with the game page, and the route moves
        socketCloses();
        window.happyDOM.setURL('https://test.milkywayidle.com/characterSelect');
        page.remove();
        await advance(3 * SETTLE);

        // The next character's page mounts, its banner up until its socket is
        window.happyDOM.setURL(GAME_URL(32031));
        page = document.createElement('div');
        page.className = 'GamePage_gamePage__abc12 GamePage_connectionMessage__xyz34';
        document.body.appendChild(page);
        await advance(SETTLE);
        expect(push).not.toHaveBeenCalled();

        socketOpens();
        await advance(SETTLE);
        state.characterId = 32031;
        connectionState.setConnected('init_character_data');
        bannerOff();
        await advance(5 * SETTLE);

        expect(push).not.toHaveBeenCalled();
        expect(syncManager.handoffTimer).toBeNull();
    });

    test('the game closing the socket before the route moves is still a hop', async () => {
        socketCloses();
        bannerOn();
        await advance(SETTLE - 1);
        window.happyDOM.setURL('https://test.milkywayidle.com/characterSelect');
        await advance(2 * SETTLE);
        expect(push).not.toHaveBeenCalled();
    });

    test('a player who stays on the select page past the looks still starts no push on the way back', async () => {
        socketCloses();
        window.happyDOM.setURL('https://test.milkywayidle.com/characterSelect');
        page.remove();
        await advance(40 * SETTLE);
        expect(syncManager.handoffTimer).toBeNull();

        window.happyDOM.setURL(GAME_URL(32031));
        page = document.createElement('div');
        page.className = 'GamePage_connectionMessage__xyz34';
        document.body.appendChild(page);
        await advance(2 * SETTLE);

        expect(push).not.toHaveBeenCalled();
    });

    test('a disconnect during a switch holds, and a takeover still there afterwards pushes', async () => {
        state.switching = true;
        state.reloading = true;
        socketCloses();
        bannerOn();
        await advance(3 * SETTLE);
        expect(push).not.toHaveBeenCalled();

        state.switching = false;
        state.reloading = false;
        await advance(SETTLE);
        expect(push).toHaveBeenCalledTimes(1);
    });
});

describe('other closes', () => {
    test('a network drop with no banner, and the connection back, pushes nothing', async () => {
        socketCloses({ code: 1006, wasClean: false });
        await advance(SETTLE);
        socketOpens();
        connectionState.setConnected('init_character_data');
        await advance(5 * SETTLE);

        expect(push).not.toHaveBeenCalled();
        expect(syncManager.handoffTimer).toBeNull();
    });

    test('a reconnect under way with the banner up pushes nothing', async () => {
        socketCloses({ code: 1006, wasClean: false });
        bannerOn();
        socketOpens();
        await advance(SETTLE);
        connectionState.setConnected('init_character_data');
        bannerOff();
        await advance(5 * SETTLE);
        expect(push).not.toHaveBeenCalled();
    });

    test("this script's own recovery close is not a takeover", async () => {
        state.closedByUs.add(socket);
        socketCloses();
        bannerOn();
        await advance(3 * SETTLE);
        expect(push).not.toHaveBeenCalled();
    });
});

describe('the listener', () => {
    test('is gone after cleanup', async () => {
        syncManager.cleanup();
        socketCloses();
        bannerOn();
        await advance(3 * SETTLE);
        expect(push).not.toHaveBeenCalled();
    });

    test('a restart leaves one listener, so a takeover pushes once and starts one chain', async () => {
        const restart = state.listeners.sync_enabled[0];
        restart();
        restart();
        const schedule = vi.spyOn(syncManager.timers, 'scheduleTimeout');

        socketCloses();
        expect(schedule).toHaveBeenCalledTimes(1);
        bannerOn();
        await advance(SETTLE);
        expect(push).toHaveBeenCalledTimes(1);
    });

    test('a restart after a takeover push leaves the next takeover able to push', async () => {
        const restart = state.listeners.sync_onSwitch[0];
        socketCloses();
        bannerOn();
        await advance(SETTLE);
        expect(push).toHaveBeenCalledTimes(1);

        // The restart clears the timers, the 30 s rearm among them
        restart();
        bannerOff();
        await advance(31 * 1000);
        emitSocket('open', {});
        connectionState.setConnected('init_character_data');

        socketCloses();
        bannerOn();
        await advance(SETTLE);
        expect(push).toHaveBeenCalledTimes(2);
    });

    test('with the setting off, no listener at all', async () => {
        syncManager.cleanup();
        state.settings.sync_onSwitch = false;
        await syncManager.initialize();

        socketCloses();
        bannerOn();
        await advance(3 * SETTLE);
        expect(syncManager.handoffTimer).toBeNull();
        expect(push).not.toHaveBeenCalled();
    });
});
