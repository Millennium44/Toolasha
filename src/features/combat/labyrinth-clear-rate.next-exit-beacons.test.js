/** @vitest-environment happy-dom */

/**
 * Next places the Beacons plan's "now" beacons before it queues rooms, while the drawn route still crosses
 * rooms that are not revealed; Path re-runs once they are in.
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
const { default: dataManager } = await import('../../core/data-manager.js');
const { resetPanelCache } = await import('./labyrinth-path-stepper.js');

const SIDE = 4; // floor 1 is a 4 x 4 grid
const shown = (over = {}) => ({ roomType: '/labyrinth_room_types/combat', ...over });

describe('Next places the exit beacons before it queues rooms', () => {
    let lab;
    let gamePanel;
    let press;
    let runBeacons;
    let runPath;

    const mountPanel = () => {
        let rootEl = document.getElementById('root');
        if (!rootEl) {
            rootEl = document.createElement('div');
            rootEl.id = 'root';
            document.body.appendChild(rootEl);
        }
        gamePanel = { handleRoomClick() {}, state: { supplyMode: null }, props: { characterLabyrinth: lab } };
        rootEl._reactRootContainer = {
            current: { stateNode: null, sibling: null, child: { stateNode: gamePanel, child: null, sibling: null } },
        };
        resetPanelCache();
    };

    /** Hidden route rooms (2, 3 in the top row, then 6, 7) behind a cleared entrance and room 1 */
    const freshFloor = () => {
        lab = {
            currentFloor: 1,
            beaconCount: 4,
            shroudCount: 2,
            pathData: '[]',
            roomData: [
                [shown({ isCleared: true }), shown({ isCleared: true }), null, null],
                [shown(), shown(), null, null],
                [shown(), shown(), shown(), shown()],
                [shown(), shown(), shown(), shown()],
            ],
        };
        mountPanel();
        labyrinthClearRate.roomData = lab.roomData;
        labyrinthClearRate.currentFloor = 1;
        labyrinthClearRate._beaconPlanCells = null;
        labyrinthClearRate._beaconStepPlan = null;
        labyrinthClearRate._revealBeaconPlan = null;
        labyrinthClearRate._exitBeaconsTried = null;
        labyrinthClearRate._exitStage = null;
        labyrinthClearRate.pathCalcRunning = false;
        labyrinthClearRate.tileCalcRunning = false;
        labyrinthClearRate.autoPathTimer = null;
        labyrinthClearRate.autoTileTimer = null;
        labyrinthClearRate._pathQueued = false;
        labyrinthClearRate._pathRunId = 0;
        // Route 1 -> 2 -> 3 -> 7; nothing needs a shroud
        labyrinthClearRate.storeShroudStepPlan(SIDE, [], [1, 2, 3, 7]);
    };

    /** Three beacons for now and one staged for later, in the shape runBeaconCalculation draws */
    const drawPlan = () => {
        labyrinthClearRate._beaconPlanCells = {
            fills: [],
            centers: [
                { idx: 6, label: 'B1', watch: [2, 3] },
                { idx: 5, label: 'B2', watch: [6] },
                { idx: 4, label: 'B3', watch: [7] },
                { idx: 9, label: 'B4', later: true, watch: [11] },
            ],
        };
    };

    /** The real stepper's reading with a press that behaves like the game: arm, then place */
    const fakePress = () => {
        const stepper = labyrinthClearRate.getStepper();
        press = vi.fn(async (kind) => {
            const step = stepper.describe(kind);
            if (step.action === 'use') gamePanel.state.supplyMode = kind;
            else if (step.action === 'room') {
                gamePanel.state.supplyMode = null;
                labyrinthClearRate.currentBeaconStepPlan().placed.add(step.idx);
            }
        });
        stepper.press = press;
    };

    const reveal = (...idxs) => {
        for (const idx of idxs) lab.roomData[Math.floor(idx / SIDE)][idx % SIDE] = shown();
    };

    /** Two presses of Next: arm the next beacon, then pick its room */
    const place = async () => {
        await labyrinthClearRate.pressNextStep();
        await labyrinthClearRate.pressNextStep();
    };

    beforeEach(() => {
        freshFloor();
        fakePress();
        runBeacons = vi.spyOn(labyrinthClearRate, 'runBeaconCalculation').mockImplementation(() => {});
        runPath = vi.spyOn(labyrinthClearRate, 'runPathCalculation').mockImplementation(async () => {});
        vi.spyOn(labyrinthClearRate, 'getSupplyCounts').mockReturnValue({ known: true, beacon: 4 });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        dataManager.getCurrentCharacterId.mockReturnValue('me');
        labyrinthClearRate._stepper?.dispose();
        labyrinthClearRate._stepper = null;
        labyrinthClearRate._shroudStepPlan = null;
        labyrinthClearRate._beaconPlanCells = null;
        document.getElementById('root')?.remove();
    });

    test('a route with no hidden room skips the stage: Next queues as before', () => {
        drawPlan();
        reveal(2, 3, 6, 7);
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('beacon');
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('plan-beacons');
    });

    test('the exit room is not a hidden room: the game sends no data for it (live, floor 17: roomData[7][7] null)', () => {
        drawPlan();
        reveal(2, 3, 6, 7);
        // The exit is the far corner and stays null in roomData until reached
        lab.roomData[3][3] = null;
        labyrinthClearRate.storeShroudStepPlan(SIDE, [], [1, 2, 3, 7, 11, 15], 15);
        expect(labyrinthClearRate.routeCrossesHiddenRooms()).toBe(false);
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        // A hidden room that is not the exit still counts
        lab.roomData[2][3] = null;
        expect(labyrinthClearRate.routeCrossesHiddenRooms()).toBe(true);
    });

    test('a drawn plan: Next offers its first beacon for now, ahead of the route, and says why', () => {
        drawPlan();
        const next = labyrinthClearRate.describeNextStep();
        expect(next).toMatchObject({ kind: 'beacon', action: 'use', stage: 'exit-beacons', idx: 6 });
        expect(next.label).toBe('Next ▸ beacon 3,2');
        expect(next.reason).toContain('light the way to the exit');
    });

    test('arm, then pick: the second press shows the pick of the same beacon on the same plan object', async () => {
        drawPlan();
        const plan = labyrinthClearRate.currentBeaconStepPlan();
        await labyrinthClearRate.pressNextStep();
        expect(press).toHaveBeenLastCalledWith('beacon');
        expect(gamePanel.state.supplyMode).toBe('beacon');
        expect(labyrinthClearRate.describeNextStep()).toMatchObject({
            kind: 'beacon',
            action: 'room',
            idx: 6,
            label: 'Next ▸ pick 3,2',
        });
        expect(labyrinthClearRate.currentBeaconStepPlan()).toBe(plan);
    });

    test('a staged plan with only later beacons left falls through to the route', () => {
        labyrinthClearRate._beaconPlanCells = {
            fills: [],
            centers: [{ idx: 9, label: 'B1', later: true, watch: [11] }],
        };
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('beacon');
    });

    test('an exhausted plan, and a bag with none left, fall through', () => {
        labyrinthClearRate._beaconStepPlan = {
            source: null,
            floor: 1,
            characterId: 'me',
            cols: SIDE,
            targets: [],
            later: [],
            planned: 0,
            placed: new Set(),
            exhausted: 'not-needed',
        };
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        labyrinthClearRate._beaconStepPlan = null;
        drawPlan();
        lab.beaconCount = 0;
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
    });

    test('no plan drawn, beacons held: Next offers to plan; the press plans, then arms the first beacon', async () => {
        runBeacons.mockImplementation(() => drawPlan());
        const next = labyrinthClearRate.describeNextStep();
        expect(next).toMatchObject({ kind: 'plan-beacons', action: 'plan', label: 'Next ▸ beacons' });
        // Nothing to light before a plan exists
        expect(Number.isInteger(next.x)).toBe(false);
        await labyrinthClearRate.pressNextStep();
        expect(runBeacons).toHaveBeenCalledTimes(1);
        expect(press).toHaveBeenCalledTimes(1);
        expect(press).toHaveBeenCalledWith('beacon');
        expect(gamePanel.state.supplyMode).toBe('beacon');
        expect(labyrinthClearRate._exitBeaconsTried).toEqual({ floor: 1, characterId: 'me', run: null });
    });

    test("no plan drawn and none held (supplies known): exactly today's behavior", () => {
        labyrinthClearRate.getSupplyCounts.mockReturnValue({ known: true, beacon: 0 });
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('plan-beacons');
        // Unknown supplies still plan
        labyrinthClearRate.getSupplyCounts.mockReturnValue({ known: false, beacon: 0 });
        expect(labyrinthClearRate.exitBeaconStep()?.kind).toBe('plan-beacons');
    });

    test('a self-plan that draws nothing (not needed, infeasible, failed) falls through and is tried once', async () => {
        await labyrinthClearRate.pressNextStep();
        expect(press).not.toHaveBeenCalled();
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('plan-beacons');
        await labyrinthClearRate.pressNextStep();
        expect(runBeacons).toHaveBeenCalledTimes(1);
    });

    test('the tried record is for one floor and one character; clearing the map or the setting drops it', () => {
        labyrinthClearRate._exitBeaconsTried = { floor: 1, characterId: 'me' };
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        labyrinthClearRate._exitBeaconsTried = { floor: 2, characterId: 'me' };
        expect(labyrinthClearRate.exitBeaconStep()?.kind).toBe('plan-beacons');
        labyrinthClearRate._exitBeaconsTried = { floor: 1, characterId: 'someone else' };
        expect(labyrinthClearRate.exitBeaconStep()?.kind).toBe('plan-beacons');
        // A new run on the same floor number (escape, then enter again) is not the run that was tried
        lab.startedAt = '2026-11-25T03:00:00Z';
        labyrinthClearRate._exitBeaconsTried = { floor: 1, characterId: 'me', run: '2026-11-25T03:00:00Z' };
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        lab.startedAt = '2026-11-25T04:00:00Z';
        expect(labyrinthClearRate.exitBeaconStep()?.kind).toBe('plan-beacons');
        delete lab.startedAt;
        labyrinthClearRate._exitBeaconsTried = { floor: 1, characterId: 'me' };
        labyrinthClearRate._exitStage = { floor: 1, characterId: 'me', pathRun: 0 };
        labyrinthClearRate.clearRecommendations();
        expect(labyrinthClearRate._exitBeaconsTried).toBeNull();
        expect(labyrinthClearRate._exitStage).toBeNull();
        labyrinthClearRate._exitBeaconsTried = { floor: 1, characterId: 'me' };
        labyrinthClearRate._exitStage = { floor: 1, characterId: 'me', pathRun: 0 };
        labyrinthClearRate.disposeStepper();
        expect(labyrinthClearRate._exitBeaconsTried).toBeNull();
        expect(labyrinthClearRate._exitStage).toBeNull();
    });

    test('a supply already armed is never armed over', () => {
        drawPlan();
        gamePanel.state.supplyMode = 'shroud';
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
    });

    describe('Path runs again once the last beacon for now is in', () => {
        test('exactly once, after the last now-beacon, never after an earlier one', async () => {
            drawPlan();
            await place();
            reveal(2, 3);
            expect(runPath).not.toHaveBeenCalled();
            await place();
            reveal(6);
            expect(runPath).not.toHaveBeenCalled();
            await place();
            expect(runPath).toHaveBeenCalledTimes(1);
            expect(labyrinthClearRate._exitStage).toBeNull();
            reveal(7);
            // No second run from a stray press with nothing left
            await labyrinthClearRate.pressNextStep();
            expect(runPath).toHaveBeenCalledTimes(1);
        });

        const afterLastBeacon = (over = {}) => {
            drawPlan();
            const plan = labyrinthClearRate.currentBeaconStepPlan();
            [6, 5, 4].forEach((i) => plan.placed.add(i));
            reveal(2, 3, 6, 7);
            labyrinthClearRate._exitStage = { floor: 1, characterId: 'me', pathRun: 0, ...over };
            labyrinthClearRate.repathAfterExitBeacon({
                stepper: labyrinthClearRate.getStepper(),
                floor: 1,
                characterId: 'me',
                plan,
                idx: 4,
            });
        };

        test('with everything quiet it runs', () => {
            afterLastBeacon();
            expect(runPath).toHaveBeenCalledTimes(1);
        });

        test('not while a supply is armed', () => {
            gamePanel.state.supplyMode = 'beacon';
            afterLastBeacon();
            expect(runPath).not.toHaveBeenCalled();
        });

        test.each([
            ['a path run in flight', () => (labyrinthClearRate.pathCalcRunning = true)],
            ['a room calculation running', () => (labyrinthClearRate.tileCalcRunning = true)],
            ['an Auto-path timer pending', () => (labyrinthClearRate.autoPathTimer = 1)],
            ['a path already waiting', () => (labyrinthClearRate._pathQueued = true)],
            ['a path run started since the stage armed', () => (labyrinthClearRate._pathRunId = 5)],
        ])('not with %s', (name, busy) => {
            busy();
            afterLastBeacon();
            expect(runPath).not.toHaveBeenCalled();
            // The wait toggle of a second Path press is never reached
            expect(labyrinthClearRate._pathQueued).toBe(name === 'a path already waiting');
        });

        test('a beacon the Beacon button placed (no stage flag) never triggers it', () => {
            afterLastBeacon();
            runPath.mockClear();
            labyrinthClearRate._exitStage = null;
            const plan = labyrinthClearRate.currentBeaconStepPlan();
            labyrinthClearRate.repathAfterExitBeacon({
                stepper: labyrinthClearRate.getStepper(),
                floor: 1,
                characterId: 'me',
                plan,
                idx: 4,
            });
            expect(runPath).not.toHaveBeenCalled();
        });

        test('a pick the game refused keeps the stage and does not re-path', async () => {
            drawPlan();
            press.mockImplementation(async (kind) => {
                const step = labyrinthClearRate.getStepper().describe(kind);
                gamePanel.state.supplyMode = step.action === 'use' ? kind : null;
            });
            await place();
            expect(runPath).not.toHaveBeenCalled();
            expect(labyrinthClearRate._exitStage).not.toBeNull();
        });

        test('cancelled with the game X: the label returns to the stage', async () => {
            drawPlan();
            await labyrinthClearRate.pressNextStep();
            expect(labyrinthClearRate.describeNextStep().label).toBe('Next ▸ pick 3,2');
            gamePanel.state.supplyMode = null;
            expect(labyrinthClearRate.describeNextStep()).toMatchObject({
                kind: 'beacon',
                stage: 'exit-beacons',
                label: 'Next ▸ beacon 3,2',
            });
        });

        test('a floor change between the presses drops the flag and re-paths nothing', async () => {
            drawPlan();
            await labyrinthClearRate.pressNextStep();
            expect(labyrinthClearRate._exitStage).not.toBeNull();
            const plan = labyrinthClearRate.currentBeaconStepPlan();
            [6, 5, 4].forEach((i) => plan.placed.add(i));
            labyrinthClearRate.currentFloor = 2;
            labyrinthClearRate.repathAfterExitBeacon({
                stepper: labyrinthClearRate.getStepper(),
                floor: 1,
                characterId: 'me',
                plan,
                idx: 4,
            });
            expect(labyrinthClearRate._exitStage).toBeNull();
            expect(runPath).not.toHaveBeenCalled();
        });

        test('a character change between the presses drops the flag and re-paths nothing', () => {
            drawPlan();
            labyrinthClearRate._exitStage = { floor: 1, characterId: 'me', pathRun: 0 };
            dataManager.getCurrentCharacterId.mockReturnValue('other');
            const plan = labyrinthClearRate.currentBeaconStepPlan();
            labyrinthClearRate.repathAfterExitBeacon({
                stepper: labyrinthClearRate.getStepper(),
                floor: 1,
                characterId: 'me',
                plan,
                idx: 4,
            });
            expect(labyrinthClearRate._exitStage).toBeNull();
            expect(runPath).not.toHaveBeenCalled();
        });

        test('the setting turned off between the presses re-paths nothing', () => {
            drawPlan();
            const stepper = labyrinthClearRate.getStepper();
            const plan = labyrinthClearRate.currentBeaconStepPlan();
            [6, 5, 4].forEach((i) => plan.placed.add(i));
            labyrinthClearRate._exitStage = { floor: 1, characterId: 'me', pathRun: 0 };
            labyrinthClearRate.disposeStepper();
            labyrinthClearRate.repathAfterExitBeacon({ stepper, floor: 1, characterId: 'me', plan, idx: 4 });
            expect(runPath).not.toHaveBeenCalled();
        });
    });
});
