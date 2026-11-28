/** @vitest-environment happy-dom */

/**
 * Holding a labyrinth tile. On a phone a long press fires `contextmenu`: with a coarse pointer it shows the same
 * info preview a tap does (never the sim, whose button the preview carries); a fine pointer keeps right-click = sim.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Gear the mocked loadoutSnapshot reports; mutated in place (see setGear) so
 *  every holder of the mocked default export sees updates */
const gear = vi.hoisted(() => ({ snapshots: {}, ready: true, waiters: [], listeners: [] }));

/** Guild shrine data the mocked adapter and data manager report */
const shrines = vi.hoisted(() => ({ detailMap: {}, owned: {} }));
/** The labyrinth monster list the adapter reports; empty means "unreadable" to the fingerprint */
const labMonsters = vi.hoisted(() => ({ list: [] }));

/** Community buff levels the mocked data manager reports, by buff hrid */
const community = vi.hoisted(() => ({ levels: {} }));
const ownedTalismans = vi.hoisted(() => ({ list: [], slotted: [] }));

/** Backing store for the mocked storage module: `${storeName}:${key}` -> value */
const db = vi.hoisted(() => ({ map: new Map(), unavailable: false, hold: null }));

/** The mocked inventory the supply reader sees */
const bag = vi.hoisted(() => ({ items: null }));

/** What the mocked marketplace client knows */
const market = vi.hoisted(() => ({ loaded: false, prices: {} }));

/** The gear the mocked data manager reports as worn: slot hrid -> character item */
const worn = vi.hoisted(() => ({ map: new Map() }));

/** Callbacks registered through the mocked config.onSettingChange */
const settingWatchers = vi.hoisted(() => []);

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        setSetting: vi.fn(),
        // Records each watcher so a test can fire a setting change; returns its unsubscribe
        onSettingChange: vi.fn((key, cb) => {
            settingWatchers.push({ key, cb });
            return () => {
                const i = settingWatchers.findIndex((w) => w.cb === cb);
                if (i >= 0) settingWatchers.splice(i, 1);
            };
        }),
        getSettingValue: (key, fallback) => (settings.map.has(key) ? settings.map.get(key) : fallback),
        setSettingValue: (key, value) => settings.map.set(key, value),
        Z_NOTIFICATION: 10500,
        Z_FLOATING_PANEL: 10100,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(),
        register: vi.fn(),
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: vi.fn((name, callback) => {
            callback();
            return () => {};
        }),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        getCurrentCharacterId: vi.fn(() => 'me'),
        getCurrentCharacterGameMode: vi.fn(() => 'standard'),
        getSkills: vi.fn(() => []),
        getInitClientData: vi.fn(() => null),
        // The community buff levels the server is running, which the skilling
        // metrics and the combat experience award both read live
        getCommunityBuffLevel: (hrid) => community.levels[hrid] || 0,
        getCharacterTalismans: () => ownedTalismans.list,
        getSlottedTalismans: () => ownedTalismans.slotted,
        getCharacterGuildBuffLevel: (hrid) => shrines.owned[hrid] || 0,
        getInventory: () => bag.items,
        getEquipment: () => new Map(worn.map),
        characterData: null,
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildPlayerDTO: vi.fn(),
    buildGameDataPayload: vi.fn(),
    applyLoadoutSnapshotToDTO: vi.fn(),
    getLabyrinthMonsters: () => labMonsters.list,
    getCommunityBuffs: () => ({ mooPass: false, comExp: 0, comDrop: 0 }),
    getGuildBuffDetailMap: () => shrines.detailMap,
    applyGuildBuffLevel: (buffs, detail, level) => [
        ...buffs.filter((b) => b.typeHrid !== detail.buffs[0].typeHrid),
        { typeHrid: detail.buffs[0].typeHrid, flatBoost: detail.buffs[0].flatBoost * level, ratioBoost: 0 },
    ],
}));
/** Records worker-level cancellation, which is what a Cancel press has to reach */
// Wrapped, not replaced: the real panel still runs, the spy only records the call
const distributionSpy = vi.hoisted(() => ({ refresh: null }));
vi.mock('./labyrinth-room-distribution.js', async (importOriginal) => {
    const actual = await importOriginal();
    distributionSpy.refresh = vi.fn(actual.refreshRoomDistribution);
    return { ...actual, refreshRoomDistribution: distributionSpy.refresh };
});

const cancelSpy = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: vi.fn(),
    runBlindBuffProbe: vi.fn(),
    runPlayerStatProbe: vi.fn(),
    cancelSimulation: cancelSpy.fn,
}));
// The supply planner asks the market what a missing shroud would cost. Importing
// the real client drags in the socket connection state, which is a lot of
// machinery for a note that these suites never assert on.
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => market.loaded, getPrice: (hrid) => market.prices[hrid] || null },
}));
// snapshots/resolveEquipment back the persisted-combat-cache gear fingerprint below;
// the rest of this file never touches loadout-snapshot, so {} was enough before it
// Talismans exist on the test server only; a test flips this to prove the live-server answer
const server = vi.hoisted(() => ({ test: true }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => server.test,
}));
vi.mock('./loadout-snapshot.js', () => ({
    default: {
        snapshots: gear.snapshots,
        // The store's load state, which the DTO builder and the cold-start
        // cache seeding both gate on — `gear.ready` is flipped per test
        get snapshotsReady() {
            return gear.ready;
        },
        whenReady: () => (gear.ready ? Promise.resolve(true) : new Promise((resolve) => gear.waiters.push(resolve))),
        onUpdate: (fn) => gear.listeners.push(fn),
        offUpdate: (fn) => {
            gear.listeners = gear.listeners.filter((l) => l !== fn);
        },
        resolveEquipment: (snapshot) => snapshot?.equipment || [],
        // The loadout's own equipment Map, which carries the loadout's talisman bonuses; a test hands one over
        equipmentMapOf: (snapshot) => snapshot?.equipmentMap ?? new Map(),
    },
}));
// The persisted-combat-cache suite drives this store directly; every other
// suite in this file is pure math and never touches it
const dbGet = async (key, storeName = 'settings', defaultValue = null) => {
    const stored = db.map.get(`${storeName}:${key}`);
    return stored === undefined || stored === null ? defaultValue : stored;
};
const dbSet = async (key, value, storeName = 'settings') => {
    if (db.unavailable) return false;
    db.map.set(`${storeName}:${key}`, value);
    return true;
};
/** The probe the persisted-record discipline reads through: null when storage cannot be read */
const dbTryGet = async (key, storeName = 'settings') => {
    // A read left open, so a test can land a character switch inside one
    if (db.hold) await db.hold;
    if (db.unavailable) return null;
    const stored = db.map.get(`${storeName}:${key}`);
    return stored === undefined || stored === null
        ? { found: false, value: null }
        : { found: true, value: structuredClone(stored) };
};

vi.mock('../../core/storage.js', () => ({
    default: {
        get: dbGet,
        getJSON: dbGet,
        tryGet: dbTryGet,
        set: dbSet,
        setJSON: dbSet,
        delete: async (key, storeName = 'settings') => db.map.delete(`${storeName}:${key}`),
        getAllKeys: async () => [],
    },
}));

const { default: labyrinthClearRate } = await import('./labyrinth-clear-rate.js');

const PREVIEW_ID = 'mwi-labyrinth-preview';

describe('holding a tile (contextmenu on a bound badge)', () => {
    const skillResult = () => ({
        type: 'skilling',
        skillHrid: '/skills/milking',
        roomLevel: 10,
        clearChance: 0.9,
        expectedSeconds: 5,
    });
    const isShown = () => document.getElementById(PREVIEW_ID)?.style.display === 'block';
    const setPointer = (coarse) => {
        vi.stubGlobal('matchMedia', (query) => ({ matches: coarse && query === '(pointer: coarse)' }));
    };
    const addSimButton = () => {
        const simButton = document.createElement('button');
        simButton.className = 'toolasha-lab-sim-btn';
        document.body.appendChild(simButton);
        return simButton;
    };
    const hold = (target) => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
        target.dispatchEvent(event);
        return event;
    };
    let badge;
    let simOpened;
    let openSpy;

    beforeEach(() => {
        vi.spyOn(labyrinthClearRate, 'renderPreviewContent').mockImplementation((el) => {
            el.textContent = 'preview';
        });
        openSpy = vi.spyOn(labyrinthClearRate, 'openSimFromPreview');
        simOpened = vi.fn();
        document.addEventListener('mwi-labsim-open', simOpened);
        badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
    });

    afterEach(() => {
        document.removeEventListener('mwi-labsim-open', simOpened);
        labyrinthClearRate.hidePreview();
        document.getElementById(PREVIEW_ID)?.remove();
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('coarse pointer with the sim available shows the preview, not the sim, and stops the browser menu', () => {
        setPointer(true);
        addSimButton();
        const event = hold(badge);
        expect(isShown()).toBe(true);
        expect(openSpy).not.toHaveBeenCalled();
        expect(simOpened).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    test('coarse pointer without the sim still shows the preview', () => {
        setPointer(true);
        const event = hold(badge);
        expect(isShown()).toBe(true);
        expect(openSpy).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    test('the held preview survives the finger lifting and dismisses only on a later outside press', () => {
        setPointer(true);
        hold(badge);
        badge.dispatchEvent(new Event('touchend', { bubbles: true }));
        badge.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(isShown()).toBe(true);
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(isShown()).toBe(false);
    });

    test('fine pointer with the sim available still opens the sim on right-click', () => {
        setPointer(false);
        addSimButton();
        const event = hold(badge);
        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(simOpened).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    test('fine pointer without the sim does nothing and leaves the browser menu alone', () => {
        setPointer(false);
        const event = hold(badge);
        expect(openSpy).not.toHaveBeenCalled();
        expect(isShown()).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });
});
