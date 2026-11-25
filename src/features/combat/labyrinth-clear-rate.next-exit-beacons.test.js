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

/** Whether a labyrinth action is the one running; the descent step reads it */
const activity = vi.hoisted(() => ({ running: false }));
vi.mock('./labyrinth-activity.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isLabyrinthFightActive: () => activity.running,
}));

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

    test('a hidden shroud room next on the route does not stand in for the exit plan', () => {
        // Room 2 is hidden and planned as a shroud: the beacon step alone would offer a one-beacon plan for it
        labyrinthClearRate.storeShroudStepPlan(SIDE, [2], [1, 2, 3, 7]);
        expect(labyrinthClearRate.getStepper().describe('beacon').forShroud).toBe(2);
        // No plan drawn: Next still works the exit plan out first
        expect(labyrinthClearRate.describeNextStep()).toMatchObject({ kind: 'plan-beacons', stage: 'exit-beacons' });
        // A drawn plan that does not cover the room: the made-up beacon is the shroud branch's, never this
        // stage's, because its plan is dropped once the room is revealed and no re-run could follow it
        labyrinthClearRate._beaconPlanCells = { fills: [], centers: [{ idx: 4, label: 'B1', watch: [7] }] };
        expect(labyrinthClearRate.exitBeaconStep()).toBeNull();
        const next = labyrinthClearRate.describeNextStep();
        expect(next).toMatchObject({ kind: 'beacon', forShroud: 2 });
        expect(next.stage).toBeUndefined();
        // A drawn beacon that does cover it is the drawn plan's own, and stays in the stage
        drawPlan();
        expect(labyrinthClearRate.describeNextStep()).toMatchObject({ kind: 'beacon', stage: 'exit-beacons', idx: 6 });
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

        test.each([
            ['running', () => (labyrinthClearRate.tileCalcRunning = true)],
            ['scheduled (Auto-calc after the reveal, Auto-path off)', () => (labyrinthClearRate.autoTileTimer = 1)],
        ])('with a room calculation %s the re-run waits behind it instead of being dropped', (_name, busy) => {
            busy();
            afterLastBeacon();
            // Not started alongside the room calculation, but queued as a pressed Path would be
            expect(runPath).not.toHaveBeenCalled();
            expect(labyrinthClearRate._pathQueued).toBe(true);
            expect(labyrinthClearRate._pathQueuedAuto).toBe(false);
            expect(labyrinthClearRate._exitStage).toBeNull();
            labyrinthClearRate._pathQueued = false;
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

describe('Next offers the descent once the exit is cleared', () => {
    let lab;
    let advance;
    let tileClick;
    let tileEl;

    const SHOWN = { roomType: '/labyrinth_room_types/combat', recommendedLevel: 95 };
    const CLEARED = { ...SHOWN, isCleared: true };
    // What the game holds for the exit: null until revealed, then the descend type, then blanked once entered
    const EXIT_REVEALED = { roomType: '/labyrinth_room_types/descend', recommendedLevel: 95 };
    const EXIT_CLEARED = { roomType: '', recommendedLevel: 0, isCleared: true };

    /**
     * Mount a floor of the game's grid size (4x4 on floor 1, 8x8 from floor 5) with the exit in the bottom-right
     * cell. Cells in `cleared` are cleared, every other cell is shown; the exit takes `exit`.
     */
    const mount = ({
        floor = 1,
        exit = EXIT_CLEARED,
        cleared = [],
        tile = true,
        remaining = 0,
        pathData = '[]',
    } = {}) => {
        const size = floor >= 5 ? 8 : 3 + floor;
        const roomData = Array.from({ length: size }, (_, y) =>
            Array.from({ length: size }, (_, x) => (cleared.includes(y * size + x) ? CLEARED : SHOWN))
        );
        roomData[size - 1][size - 1] = exit;
        lab = {
            isActive: true,
            currentFloor: floor,
            roomData,
            pathData,
            beaconCount: 4,
            shroudCount: 2,
            totalTreasureRooms: 4,
            remainingTreasureRooms: remaining,
        };
        advance = vi.fn();
        tileClick = vi.fn();
        const panel = {
            handleRoomClick() {},
            state: { supplyMode: null },
            props: {
                characterLabyrinth: lab,
                updateLabyrinthPathHandler: vi.fn(),
                advanceLabyrinthFloorHandler: advance,
            },
        };
        let rootEl = document.getElementById('root');
        if (!rootEl) {
            rootEl = document.createElement('div');
            rootEl.id = 'root';
            document.body.appendChild(rootEl);
        }
        rootEl.textContent = '';
        tileEl = null;
        let tileFiber = null;
        if (tile) {
            tileEl = document.createElement('div');
            tileEl.className = 'LabyrinthPanel_nextFloorLabel__3wBRi';
            tileEl.textContent = 'Next Floor';
            rootEl.appendChild(tileEl);
            tileFiber = { stateNode: tileEl, memoizedProps: { onClick: tileClick }, child: null, sibling: null };
        }
        rootEl._reactRootContainer = {
            current: { stateNode: null, sibling: null, child: { stateNode: panel, child: null, sibling: tileFiber } },
        };
        resetPanelCache();
        labyrinthClearRate.currentFloor = floor;
        labyrinthClearRate.roomData = roomData;
        return { panel, size };
    };

    /** A drawn route over flat indexes (walking order); the exit is its last room */
    const plan = (size, route, exit = size * size - 1) => labyrinthClearRate.storeShroudStepPlan(size, [], route, exit);

    // 4x4 floor: rooms 0 (entrance), 1, 2, 3, 7, 11 cleared; the exit is 15
    const DONE_4X4 = [0, 1, 2, 3, 7, 11];

    beforeEach(() => {
        activity.running = false;
        labyrinthClearRate._shroudStepPlan = null;
        labyrinthClearRate._beaconPlanCells = null;
        labyrinthClearRate._beaconStepPlan = null;
        labyrinthClearRate._revealBeaconPlan = null;
        labyrinthClearRate._exitBeaconsTried = null;
    });
    afterEach(() => {
        vi.restoreAllMocks();
        dataManager.getCurrentCharacterId.mockReturnValue('me');
        labyrinthClearRate._stepper?.dispose();
        labyrinthClearRate._stepper = null;
        labyrinthClearRate._shroudStepPlan = null;
        document.body.textContent = '';
    });

    test('exit not revealed (null): no descent, the route reads as before', () => {
        mount({ exit: null, tile: false, cleared: [0] });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).not.toBe('descend');
        expect(next.label).toBe('Next ▸ queue 2,1');
    });

    test('exit revealed but not cleared: no descent', () => {
        mount({ exit: EXIT_REVEALED, tile: false, cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).not.toBe('descend');
        expect(next.label).toBe('Next ▸ queue 4,4');
    });

    test('4x4 floor, exit cleared, route done, 0 treasure rooms left: descent, no forfeit warning', () => {
        mount({ cleared: DONE_4X4, remaining: 0 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next).toMatchObject({ kind: 'descend', action: 'descend', label: 'Next ▸ next floor', x: 3, y: 3 });
        expect(next.reason).toContain('No treasure rooms are left');
        expect(next.reason).not.toContain('forfeited');
        // Fits the fixed 126 px button as "No beacons planned" (18 characters) does
        expect(next.label.length).toBeLessThanOrEqual(18);
    });

    test('8x8 floor 5: the exit is bottom-right (7,7); 3 treasure rooms left are named as forfeited', () => {
        mount({ floor: 5, cleared: [0, 1, 9, 18], remaining: 3 });
        plan(8, [1, 9, 18, 63]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next).toMatchObject({ kind: 'descend', action: 'descend', x: 7, y: 7 });
        expect(next.reason).toContain('3 treasure rooms are still unvisited and forfeited');
    });

    test('one treasure room left reads in the singular', () => {
        mount({ cleared: DONE_4X4, remaining: 1 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        expect(labyrinthClearRate.describeNextStep().reason).toContain('1 treasure room is still unvisited');
    });

    test('a count the game did not send says nothing about treasure', () => {
        mount({ cleared: DONE_4X4 });
        delete lab.remainingTreasureRooms;
        plan(4, [1, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next.action).toBe('descend');
        expect(next.reason).not.toMatch(/treasure/);
    });

    test('exit cleared with chest detours still on the route: Next keeps queueing them and the hover names the tile', () => {
        mount({ cleared: DONE_4X4, remaining: 3 });
        // Chest rooms 5 and 9 sit on the route before the exit and are not cleared
        plan(4, [1, 5, 9, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next).toMatchObject({ kind: 'route', action: 'path', label: 'Next ▸ queue 2,2' });
        expect(next.reason).toContain('orange Next Floor tile descends early');
    });

    test('no hover note while the exit is not cleared', () => {
        mount({ exit: EXIT_REVEALED, tile: false, cleared: [0] });
        plan(4, [1, 2, 3, 7, 11, 15]);
        expect(labyrinthClearRate.describeNextStep().reason).not.toContain('Next Floor tile');
    });

    test('exit cleared but the tile is not on screen (game automation): no descent, Route done as before', () => {
        mount({ cleared: DONE_4X4, tile: false });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).toBeNull();
        expect(next.label).toBe('Route done');
    });

    test('no plan, exit cleared, 0 treasure rooms left: descent', () => {
        mount({ cleared: DONE_4X4, remaining: 0 });
        expect(labyrinthClearRate.describeNextStep()).toMatchObject({ kind: 'descend', action: 'descend' });
    });

    test('no plan, exit cleared, 3 treasure rooms left: Path first, the hover names the count and the tile', () => {
        mount({ cleared: DONE_4X4, remaining: 3 });
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).toBeNull();
        expect(next.label).toBe('Next ▸');
        expect(next.reason).toContain('Press Path first');
        expect(next.reason).toContain('3 treasure rooms are still unvisited');
        expect(next.reason).toContain('orange Next Floor tile descends early');
    });

    test('no plan, exit cleared, count missing: Path first', () => {
        mount({ cleared: DONE_4X4 });
        delete lab.remainingTreasureRooms;
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).toBeNull();
        expect(next.reason).toContain('Press Path first');
        expect(next.reason).toContain('orange Next Floor tile descends early');
    });

    test('stale plan, exit cleared: descent only with 0 treasure rooms left', () => {
        mount({ cleared: DONE_4X4, remaining: 2 });
        plan(5, [1, 2, 24], 24);
        labyrinthClearRate._shroudStepPlan.floor = 2;
        expect(labyrinthClearRate.describeNextStep().kind).toBeNull();
        lab.remainingTreasureRooms = 0;
        expect(labyrinthClearRate.describeNextStep().kind).toBe('descend');
    });

    test('done plan with chests the plan could not reach: descent, hover says how many are forfeited', () => {
        mount({ cleared: DONE_4X4, remaining: 3 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).toBe('descend');
        expect(next.reason).toContain('3 treasure rooms are still unvisited and forfeited');
    });

    test('a plan from another floor with the exit cleared here: descent', () => {
        mount({ cleared: DONE_4X4 });
        plan(5, [1, 2, 24], 24);
        labyrinthClearRate._shroudStepPlan.floor = 2;
        expect(labyrinthClearRate.describeNextStep().kind).toBe('descend');
    });

    test('rooms still queued in the game path: no descent ("Route queued" stays)', () => {
        mount({ cleared: DONE_4X4, pathData: '[{"x":1,"y":1}]' });
        plan(4, [1, 5, 2, 3, 7, 11, 15]);
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).toBeNull();
        expect(next.label).toBe('Route queued');
    });

    test('rooms queued with no plan: no descent', () => {
        mount({ cleared: DONE_4X4, pathData: '[{"x":1,"y":1}]' });
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('descend');
    });

    test('a labyrinth action still running: no descent', () => {
        mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        activity.running = true;
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('descend');
    });

    test('a supply armed with nothing to pick: no descent', () => {
        const { panel } = mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        panel.state.supplyMode = 'shroud';
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('descend');
    });

    test('not in a labyrinth run (isActive false): no descent', () => {
        mount({ cleared: DONE_4X4 });
        lab.isActive = false;
        plan(4, [1, 2, 3, 7, 11, 15]);
        expect(labyrinthClearRate.describeNextStep().kind).not.toBe('descend');
    });

    test('pressing opens the game dialog through its own handler and never descends or answers it', async () => {
        mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        tileClick.mockImplementation(() => {
            const dialog = document.createElement('div');
            dialog.className = 'DialogModal_buttonContainer__x1';
            document.body.appendChild(dialog);
        });
        await labyrinthClearRate.pressNextStep();
        expect(tileClick).toHaveBeenCalledTimes(1);
        expect(advance).not.toHaveBeenCalled();
    });

    test('a second press while the dialog is open does nothing', async () => {
        mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const dialog = document.createElement('div');
        dialog.className = 'DialogModal_buttonContainer__x1';
        document.body.appendChild(dialog);
        expect(labyrinthClearRate.describeNextStep()).toMatchObject({
            kind: 'descend',
            action: 'none',
            label: 'Next ▸ next floor',
        });
        await labyrinthClearRate.pressNextStep();
        expect(tileClick).not.toHaveBeenCalled();
    });

    test('the tile gone at press time: nothing pressed', async () => {
        mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const pending = labyrinthClearRate.pressNextStep();
        tileEl.remove();
        await pending;
        expect(tileClick).not.toHaveBeenCalled();
    });

    test('the character switching after the press started: nothing pressed', async () => {
        mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        const pending = labyrinthClearRate.pressNextStep();
        dataManager.getCurrentCharacterId.mockReturnValue('other');
        await pending;
        expect(tileClick).not.toHaveBeenCalled();
    });

    test('after the descent (same panel, new floor): the old plan reads stale and no descent is offered', () => {
        mount({ cleared: DONE_4X4 });
        plan(4, [1, 2, 3, 7, 11, 15]);
        expect(labyrinthClearRate.describeNextStep().kind).toBe('descend');
        // Floor 2 is 5x5, the new exit reads null and the game has removed the tile
        mount({ floor: 2, exit: null, tile: false });
        const next = labyrinthClearRate.describeNextStep();
        expect(next.kind).not.toBe('descend');
        expect(next.code).toBe('stale');
    });

    describe('the descent dialog going away', () => {
        const addDialog = () => {
            const dialog = document.createElement('div');
            dialog.className = 'DialogModal_buttonContainer__x1';
            document.body.appendChild(dialog);
            return dialog;
        };
        /** A toolbar Next button, and a press that opens the game's dialog */
        const pressOpening = async () => {
            const btn = document.createElement('button');
            btn.className = 'mwi-labyrinth-step-next';
            document.body.appendChild(btn);
            let dialog = null;
            tileClick.mockImplementation(() => {
                dialog = addDialog();
            });
            await labyrinthClearRate.pressNextStep();
            return { btn, dialog };
        };
        const settle = async () => {
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        };

        beforeEach(() => {
            mount({ cleared: DONE_4X4, remaining: 2 });
            plan(4, [1, 2, 3, 7, 11, 15]);
        });

        test('closed with No or a backdrop click: label, title and action return to the descent offer', async () => {
            const { btn, dialog } = await pressOpening();
            expect(btn.dataset.stepAction).toBe('none');
            expect(btn.title).toContain('Answer the game');
            dialog.remove();
            await settle();
            expect(btn.textContent).toBe('Next ▸ next floor');
            expect(btn.dataset.stepAction).toBe('descend');
            expect(btn.title).toContain('2 treasure rooms');
            expect(labyrinthClearRate.getStepper().hasDialogWatch()).toBe(false);
        });

        test('closed with Yes and the floor changing: no stale descent is left', async () => {
            const { btn, dialog } = await pressOpening();
            mount({ floor: 2, exit: null, tile: false });
            dialog.remove();
            await settle();
            expect(btn.dataset.stepAction).not.toBe('descend');
            expect(btn.textContent).not.toBe('Next ▸ next floor');
            expect(labyrinthClearRate.getStepper().hasDialogWatch()).toBe(false);
        });

        test('the watcher is disposed with the stepper (setting off)', async () => {
            await pressOpening();
            const stepper = labyrinthClearRate.getStepper();
            expect(stepper.hasDialogWatch()).toBe(true);
            labyrinthClearRate.disposeStepper();
            expect(stepper.hasDialogWatch()).toBe(false);
        });

        test('the watcher is dropped when the character switches', async () => {
            await pressOpening();
            const stepper = labyrinthClearRate.getStepper();
            dataManager.getCurrentCharacterId.mockReturnValue('other');
            document.body.appendChild(document.createElement('span'));
            await settle();
            expect(stepper.hasDialogWatch()).toBe(false);
        });

        test('another game dialog (not ours): inert, a press does nothing, the offer returns when it closes', async () => {
            const dialog = addDialog();
            const next = labyrinthClearRate.describeNextStep();
            expect(next).toMatchObject({ kind: 'descend', action: 'none' });
            expect(next.reason).toContain('Another game dialog');
            await labyrinthClearRate.pressNextStep();
            expect(tileClick).not.toHaveBeenCalled();
            dialog.remove();
            expect(labyrinthClearRate.describeNextStep().action).toBe('descend');
        });
        test('a dialog already open before the press is not taken as ours: nothing new opened', async () => {
            const btn = document.createElement('button');
            btn.className = 'mwi-labyrinth-step-next';
            document.body.appendChild(btn);
            const foreign = addDialog();
            tileClick.mockImplementation(() => {});
            const stepper = labyrinthClearRate.getStepper();
            const pending = stepper.pressDescent(() => ({ action: 'descend', floor: 1, reason: '' }));
            await pending;
            expect(tileClick).toHaveBeenCalledTimes(1);
            // Not ours: the press reports it did not open, and the foreign dialog is only watched as foreign
            expect(stepper.isDescentDialogOpen()).toBe(false);
            foreign.remove();
        }, 5000);

        test('a foreign dialog closing redraws the inert text, with one observer and none left after', async () => {
            const btn = document.createElement('button');
            btn.className = 'mwi-labyrinth-step-next';
            document.body.appendChild(btn);
            const foreign = addDialog();
            labyrinthClearRate.refreshStepButtons();
            expect(btn.title).toContain('Another game dialog');
            const stepper = labyrinthClearRate.getStepper();
            expect(stepper.hasDialogWatch()).toBe(true);
            expect(stepper.isDescentDialogOpen()).toBe(false);
            foreign.remove();
            await settle();
            expect(btn.dataset.stepAction).toBe('descend');
            expect(stepper.hasDialogWatch()).toBe(false);
        });
    });
});
